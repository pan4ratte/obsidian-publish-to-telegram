// telegram.ts
import { App, TFile, requestUrl } from "obsidian";
import { TelegramClient, Api, helpers } from "telegram";
import { LogLevel } from "telegram/extensions/Logger";
import { StringSession } from "telegram/sessions";
import { CustomFile, _fileToMedia } from "telegram/client/uploads";
import { _parseMessageText } from "telegram/client/messageParse";
import { getInputMedia } from "telegram/Utils";
import { TelegramChannel, TelegramSettings, TelegramSecrets, PendingScheduledLink } from "./types";
import { errMessage } from "./util";
import { mdToTelegramHtml } from "./markdown";

// ─── Internal result & media types ────────────────────────────────────────────

interface SendResult {
    link: string;
    messageId: number;
    commentLinks?: string[];
    scheduled?: ScheduledSendInfo;
}

// Captured at scheduling time so the published post can later be matched back to
// this note. `scheduledDate` (== published message .date) and `text` (plain body)
// are the correlation keys; `scheduledMsgId` lets us check the scheduled queue.
export interface ScheduledSendInfo {
    chatId: string;
    topicId?: number;
    scheduledMsgId: number;
    scheduledDate: number;
    text: string;
}

interface MediaFile {
    name: string;
    extension: string;
    getBlob: () => Promise<Blob>;
}

// ─── Media type helpers ───────────────────────────────────────────────────────

const VIDEO_EXTS = new Set(["mp4", "mov", "avi", "mkv", "webm"]);

// ─── Frontmatter extraction ───────────────────────────────────────────────────

function extractFrontmatter(content: string): { frontmatter: string; body: string } {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    const body = match ? content.slice(match[0].length) : content;
    if (!match) return { frontmatter: "", body };
    return { frontmatter: match[1], body };
}

// ─── Split helpers ────────────────────────────────────────────────────────────

function splitBodyByMarkers(body: string): string[] {
    const marker = /^[ \t]*(?:%%\s*\\split\s*%%|<!--\s*\\split\s*-->)[ \t]*$/gm;
    return body.split(marker).map(p => p.trim()).filter(p => p.length > 0);
}

// ─── Attachment collection (shared) ───────────────────────────────────────────

const SUPPORTED_MEDIA_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "pdf", ...VIDEO_EXTS]);

function collectMediaFiles(app: App, body: string, sourceFile: TFile): { attachments: MediaFile[]; mdEmbeds: TFile[] } {
    const wikilinkRegex = /!\[\[([^\]|#]+?)(?:[|#][^\]]*)?\]\]/g;
    const mdLinkRegex = /!\[[^\]]*\]\(([^)]+)\)/g;
    const reverseMdLinkRegex = /!\(([^)]+)\)\[[^\]]*\]/g;

    const seen = new Set<string>();
    const attachments: MediaFile[] = [];
    const mdEmbeds: TFile[] = [];

    const processLinkpath = (rawPath: string) => {
        let cleanPath = rawPath.split(/\s+"/)[0].split(/[?#]/)[0].trim();

        if (/^https?:\/\//i.test(cleanPath)) {
            if (!seen.has(cleanPath)) {
                seen.add(cleanPath);
                const ext = cleanPath.split('.').pop()?.toLowerCase() || "";
                if (SUPPORTED_MEDIA_EXTS.has(ext)) {
                    attachments.push({
                        name: cleanPath.split('/').pop() || `media.${ext}`,
                        extension: ext,
                        getBlob: async () => {
                            const response = await requestUrl({ url: cleanPath });
                            return new Blob([response.arrayBuffer]);
                        }
                    });
                }
            }
            return;
        }

        try { cleanPath = decodeURIComponent(cleanPath); } catch { /* keep raw path if not URI-encoded */ }

        const resolved = app.metadataCache.getFirstLinkpathDest(cleanPath, sourceFile.path);
        if (resolved instanceof TFile && !seen.has(resolved.path)) {
            seen.add(resolved.path);
            if (SUPPORTED_MEDIA_EXTS.has(resolved.extension)) {
                attachments.push({
                    name: resolved.name,
                    extension: resolved.extension,
                    getBlob: async () => new Blob([await app.vault.readBinary(resolved)])
                });
            } else if (resolved.extension === "md") {
                mdEmbeds.push(resolved);
            }
        }
    };

    let m: RegExpExecArray | null;
    while ((m = wikilinkRegex.exec(body)) !== null) processLinkpath(m[1]);
    while ((m = mdLinkRegex.exec(body)) !== null) processLinkpath(m[1]);
    while ((m = reverseMdLinkRegex.exec(body)) !== null) processLinkpath(m[1]);

    return { attachments, mdEmbeds };
}

// Wraps an embedded .md TFile as a document MediaFile, so it can be uploaded as a
// file attachment when md embeds are not being sent as comments.
function mdEmbedToMedia(app: App, file: TFile): MediaFile {
    return {
        name: file.name,
        extension: file.extension,
        getBlob: async () => new Blob([await app.vault.readBinary(file)]),
    };
}

// ─── Post link helpers ────────────────────────────────────────────────────────

function buildPostLinkFromChatId(chatId: string, messageId: number, topicId?: number): string {
    const withTopic = topicId && topicId !== 1;
    if (chatId.startsWith("@")) {
        if (withTopic) return `https://t.me/${chatId.slice(1)}/${topicId}/${messageId}`;
        return `https://t.me/${chatId.slice(1)}/${messageId}`;
    }
    const channelId = chatId.replace(/^-100/, "");
    if (withTopic) return `https://t.me/c/${channelId}/${topicId}/${messageId}`;
    return `https://t.me/c/${channelId}/${messageId}`;
}

export function parseLinkComponents(link: string): { chatId: string; messageId: number } | null {
    const privateMatch = link.match(/t\.me\/c\/(\d+)\/(\d+)\/?$/);
    if (privateMatch) return { chatId: `-100${privateMatch[1]}`, messageId: parseInt(privateMatch[2], 10) };
    const publicMatch = link.match(/t\.me\/([^/]+)\/(\d+)\/?$/);
    if (publicMatch) return { chatId: `@${publicMatch[1]}`, messageId: parseInt(publicMatch[2], 10) };
    return null;
}

function resolveChatId(value: string): string {
    const trimmed = value.trim();
    if (trimmed.startsWith("@") || /^-?\d+$/.test(trimmed)) return trimmed;
    return `@${trimmed}`;
}

// ─── Account (GramJS) sending ─────────────────────────────────────────────────

// Telegram Desktop api credentials (public, used as fallback for initConnection with existing session)
export const DEFAULT_TG_API_ID = 2040;
export const DEFAULT_TG_API_HASH = "b18441a1ff607e10a989891a5462e627";

// Plugin-specific credentials for new session creation (QR and phone auth).
// Register your own app at https://my.telegram.org → API Development Tools.
// Using Telegram Desktop's credentials (above) for new auth is blocked server-side.
export const AUTH_API_ID = 2040;
export const AUTH_API_HASH = "b18441a1ff607e10a989891a5462e627";

export async function createClient(session: string, apiId?: number, apiHash?: string): Promise<TelegramClient> {
    const isLocalAuth = !!apiId;
    const client = new TelegramClient(
        new StringSession(session),
        apiId || DEFAULT_TG_API_ID,
        apiHash || DEFAULT_TG_API_HASH,
        { connectionRetries: 5, timeout: 60, ...(isLocalAuth && { useWSS: true }) }
    );
    client.setLogLevel(LogLevel.NONE);
    // This plugin is request-only (no addEventHandler / incoming updates), so
    // GramJS's update loop serves no purpose — its sole job here is keepalive
    // pings, and a failed ping throws an uncaught "TIMEOUT" that surfaces to the
    // user. Pre-setting _loopStarted stops connect() from ever launching it.
    (client as unknown as { _loopStarted: boolean })._loopStarted = true;
    await client.connect();
    return client;
}


export async function checkIsForum(client: TelegramClient, entity: string | number): Promise<boolean> {
    try {
        const full = await client.invoke(new Api.channels.GetFullChannel({ channel: entity }));
        return !!(full.chats[0] as Api.Channel)?.forum;
    } catch {
        return false;
    }
}

// `_getResponseMessage` is a private GramJS method that resolves the sent
// message(s) from a raw MTProto result. Typed wrapper around the private access.
function getResponseMessage(
    client: TelegramClient,
    req: unknown,
    result: unknown,
    peer: unknown,
): Api.TypeMessage | Map<number, Api.Message> | (Api.Message | undefined)[] | undefined {
    return (client as unknown as {
        _getResponseMessage(req: unknown, result: unknown, inputChat: unknown):
            Api.TypeMessage | Map<number, Api.Message> | (Api.Message | undefined)[] | undefined;
    })._getResponseMessage(req, result, peer);
}

// ─── Dialog listing ───────────────────────────────────────────────────────────

export interface DialogData {
    id: string;       // "@username" for public, "-100XXXX" for channels, numeric string for others
    title: string;
    topicId?: number; // set for forum topics; 1 = General (also set on the parent group entry)
}

export async function getUserDialogs(client: TelegramClient): Promise<DialogData[]> {
    try {
        const results: DialogData[] = [];
        for await (const dialog of client.iterDialogs({ limit: 300, folder: 0 })) {
            if (!dialog.title) continue;
            const entity = dialog.entity;
            if (!entity) continue;

            // Narrow the entity union once; only channels/chats expose the fields we use.
            const channel = entity instanceof Api.Channel ? entity : null;
            const chat = entity instanceof Api.Chat ? entity : null;
            const username = entity instanceof Api.User || entity instanceof Api.Channel
                ? entity.username
                : undefined;

            // Skip entities where the user cannot post messages
            if (channel) {
                if (channel.broadcast) {
                    // Broadcast channel: only creators/admins with postMessages right can post
                    if (!channel.creator && !channel.adminRights?.postMessages) continue;
                } else {
                    // Supergroup: skip if non-admins are banned from sending messages
                    if (!channel.creator && !channel.adminRights && channel.defaultBannedRights?.sendMessages) continue;
                }
            }

            let id: string;
            if (username) {
                id = `@${username}`;
            } else if (channel) {
                id = `-100${channel.id.toString()}`;
            } else if (chat) {
                id = `-${chat.id.toString()}`;
            } else {
                id = "id" in entity ? entity.id.toString() : "";
            }
            if (!id) continue;
            const title = username ? `${dialog.title} (@${username})` : dialog.title;

            const isForum = !!(channel && channel.forum && channel.accessHash);
            results.push({ id, title, topicId: isForum ? 1 : undefined });

            // Fetch topics for forum supergroups and append them as individual entries
            if (isForum && channel) {
                try {
                    const inputChannel = new Api.InputChannel({
                        channelId: channel.id,
                        accessHash: channel.accessHash!,
                    });
                    const topicsResult = await client.invoke(new Api.channels.GetForumTopics({
                        channel: inputChannel,
                        offsetDate: 0,
                        offsetId: 0,
                        offsetTopic: 0,
                        limit: 100,
                    }));
                    for (const topic of topicsResult.topics) {
                        if (!(topic instanceof Api.ForumTopic)) continue;
                        if (topic.id === 1) continue; // skip General — covered by the group entry
                        results.push({ id, title: `${title}: ${topic.title}`, topicId: topic.id });
                    }
                } catch {
                    // topic fetch failed — group entry without topics is still usable
                }
            }
        }
        return results;
    } catch {
        return [];
    }
}

async function sendCommentViaAccount(
    client: TelegramClient,
    channelEntity: string | number,
    channelChatId: string,
    channelMessageId: number,
    text: string,
    silent: boolean,
): Promise<string | null> {
    // Determine whether the channel has a linked discussion group, and resolve the
    // correct sendAs peer so the comment is attributed to the right identity.
    //
    // Rule: private channels (no public username) cannot post as themselves in a
    // discussion group, so we use InputPeerSelf to post as the user's account
    // instead of leaving sendAs undefined (which would let Telegram silently pick
    // whatever channel the user last used in that group).
    //
    // For public channels we go through GetSendAs and match by channel ID to get
    // the server-authoritative InputPeer (required — Telegram rejects a self-built
    // one with SEND_AS_PEER_INVALID).
    let hasDiscussion = false;
    let sendAsPeer: Api.TypeInputPeer | undefined;
    let linkedGroupChatId: string | undefined;
    try {
        const full = await client.invoke(new Api.channels.GetFullChannel({ channel: channelEntity }));
        const fullChat = full.fullChat as Api.ChannelFull;
        const linkedChatId = fullChat.linkedChatId;
        hasDiscussion = !!linkedChatId;

        if (hasDiscussion && linkedChatId) {
            linkedGroupChatId = `-100${linkedChatId.toString()}`;
            const groupChat = full.chats.find(c => c.id.eq(linkedChatId)) as Api.Channel | undefined;
            const sourceChannel = full.chats.find(c => !c.id.eq(linkedChatId)) as Api.Channel | undefined;
            const isPrivate = !sourceChannel?.username;

            if (groupChat?.accessHash) {
                try {
                    const groupInputPeer = new Api.InputPeerChannel({
                        channelId: groupChat.id,
                        accessHash: groupChat.accessHash,
                    });
                    const sendAsResult = await client.invoke(
                        new Api.channels.GetSendAs({ peer: groupInputPeer })
                    );

                    if (isPrivate) {
                        // Private channel: post as the user's personal account.
                        // Prefer the InputPeer from the GetSendAs list (server-authoritative
                        // access hash). If the personal account is not in that list (it only
                        // appears when the account is a direct group member/admin), fall back
                        // to resolving it from the GramJS entity cache via getMe().
                        const userPeer = sendAsResult.peers.find(p => p.peer instanceof Api.PeerUser);
                        if (userPeer && userPeer.peer instanceof Api.PeerUser) {
                            const userId = userPeer.peer.userId;
                            const matchingUser = sendAsResult.users.find(u => u.id.eq(userId)) as Api.User | undefined;
                            if (matchingUser) {
                                sendAsPeer = new Api.InputPeerUser({
                                    userId: matchingUser.id,
                                    accessHash: matchingUser.accessHash!,
                                });
                            }
                        }
                        if (!sendAsPeer) {
                            const me = await client.getMe() as Api.User | null;
                            if (me) {
                                const meInputPeer = await client.getInputEntity(me);
                                if (meInputPeer instanceof Api.InputPeerUser) sendAsPeer = meInputPeer;
                            }
                        }
                    } else {
                        // Public channel: post as the channel itself.
                        const channelInputPeer = await client.getInputEntity(channelEntity);
                        const channelId = channelInputPeer instanceof Api.InputPeerChannel
                            ? channelInputPeer.channelId : null;
                        if (channelId) {
                            const matchingPeer = sendAsResult.peers.find(p =>
                                p.peer instanceof Api.PeerChannel && p.peer.channelId.eq(channelId)
                            );
                            if (matchingPeer && matchingPeer.peer instanceof Api.PeerChannel) {
                                const peerId = matchingPeer.peer.channelId;
                                const matchingChat = sendAsResult.chats.find(c => c.id.eq(peerId)) as Api.Channel | undefined;
                                if (matchingChat?.accessHash) {
                                    sendAsPeer = new Api.InputPeerChannel({
                                        channelId: matchingChat.id,
                                        accessHash: matchingChat.accessHash,
                                    });
                                }
                            }
                        }
                    }
                } catch { /* GetSendAs unavailable — comment will post as user default */ }
            }
        }
    } catch { /* not a channel or no access */ }

    if (hasDiscussion) {
        // Find the discussion-group thread head for this channel post (may need retries if not yet forwarded)
        const MAX_ATTEMPTS = 5;
        const DELAY_MS = 1500;
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            if (attempt > 0) await new Promise(r => window.setTimeout(r, DELAY_MS));

            // Only the discovery call is retried — a missing/not-yet-forwarded message is expected.
            // Errors from the actual send must not be swallowed here so they surface to the caller.
            let threadHead: Api.TypeMessage | undefined;
            try {
                const discussion = await client.invoke(
                    new Api.messages.GetDiscussionMessage({ peer: channelEntity, msgId: channelMessageId })
                );
                if (!discussion.messages.length) continue;
                // Messages are returned newest-first; the last element is the thread-opening forwarded post
                threadHead = discussion.messages[discussion.messages.length - 1];
            } catch { continue; /* not ready yet — retry */ }

            // Use raw MTProto so sendAs (InputPeer) reaches the wire unambiguously;
            // the high-level sendMessage wrapper does not reliably propagate it.
            const [message, entities] = await _parseMessageText(client, text, "html");
            const peer = await client.getInputEntity(threadHead.peerId);
            const req = new Api.messages.SendMessage({
                peer,
                message,
                entities,
                replyTo: new Api.InputReplyToMessage({ replyToMsgId: threadHead.id }),
                silent,
                sendAs: sendAsPeer,
            });
            const apiResult = await client.invoke(req);
            const m = getResponseMessage(client, req, apiResult, peer);
            const sent = Array.isArray(m) ? m[0] : m;
            const sentMsgId = (sent as Api.Message | undefined)?.id;
            if (sentMsgId && linkedGroupChatId) return buildPostLinkFromChatId(linkedGroupChatId, sentMsgId);
            return null;
        }
        return null;
    } else {
        // No discussion group: reply directly in the channel
        const sent = await client.sendMessage(channelEntity, {
            message: text,
            parseMode: "html",
            replyTo: channelMessageId,
            silent,
        });
        return buildPostLinkFromChatId(channelChatId, sent.id);
    }
}


// Sends one or more files with proper invertMedia support via raw MTProto API.
// GramJS's high-level sendMessage/sendFile/sendAlbum do not forward invertMedia,
// so we must build and invoke SendMedia / SendMultiMedia directly.
async function sendMediaRaw(
    client: TelegramClient,
    entity: string | number,
    files: CustomFile[],
    text: string,
    forceDocument: boolean,
    silent: boolean,
    invertMedia: boolean,
    scheduleDate?: number,
    topicId?: number,
): Promise<Api.Message> {
    const peer = await client.getInputEntity(entity);
    const [caption, msgEntities] = await _parseMessageText(client, text, "html");
    const replyTo = topicId
        ? new Api.InputReplyToMessage({ replyToMsgId: topicId, topMsgId: topicId })
        : undefined;

    if (files.length === 1) {
        const ext0 = files[0].name.split('.').pop()?.toLowerCase() ?? "";
        const { media } = await _fileToMedia(client, {
            file: files[0],
            forceDocument,
            workers: 1,
            supportsStreaming: VIDEO_EXTS.has(ext0),
        });
        if (!media) throw new Error("Failed to prepare media for sending");

        const req = new Api.messages.SendMedia({
            peer,
            media,
            message: caption,
            entities: msgEntities,
            silent,
            invertMedia,
            scheduleDate,
            replyTo,
        });
        const apiResult = await client.invoke(req);
        const msg = getResponseMessage(client, req, apiResult, peer);
        const m = Array.isArray(msg) ? msg[0] : msg;
        return m as Api.Message;
    }

    // Album: photos/documents must be pre-uploaded before SendMultiMedia
    const albumItems: Api.InputSingleMedia[] = [];
    for (let i = 0; i < files.length; i++) {
        const ext = files[i].name.split('.').pop()?.toLowerCase() ?? "";
        let { media } = await _fileToMedia(client, {
            file: files[i],
            forceDocument,
            workers: 1,
            supportsStreaming: VIDEO_EXTS.has(ext),
        });
        if (!media) continue;

        if (media instanceof Api.InputMediaUploadedPhoto) {
            const r = await client.invoke(new Api.messages.UploadMedia({ peer, media }));
            if (r instanceof Api.MessageMediaPhoto && r.photo) media = getInputMedia(r.photo);
        } else if (media instanceof Api.InputMediaUploadedDocument) {
            const r = await client.invoke(new Api.messages.UploadMedia({ peer, media }));
            if (r instanceof Api.MessageMediaDocument && r.document) media = getInputMedia(r.document);
        }

        albumItems.push(new Api.InputSingleMedia({
            media: media,
            message: i === 0 ? caption : "",
            entities: i === 0 ? msgEntities : [],
        }));
    }

    const req = new Api.messages.SendMultiMedia({
        peer,
        multiMedia: albumItems,
        silent,
        invertMedia,
        scheduleDate,
        replyTo,
    });
    const apiResult = await client.invoke(req);
    const randomIds = albumItems.map(m => m.randomId);
    const msgs = getResponseMessage(client, randomIds, apiResult, peer);
    const first = Array.isArray(msgs) ? msgs[0] : msgs;
    return first as Api.Message;
}

async function sendPartViaAccount(
    app: App,
    body: string,
    channel: TelegramChannel,
    secrets: TelegramSecrets,
    silent: boolean,
    attachUnderText: boolean,
    sourceFile: TFile,
    treatMdEmbedsAsComments: boolean,
    scheduleDate?: Date,
    onProgress?: () => void,
): Promise<SendResult | null> {
    const text = mdToTelegramHtml(body);
    const { attachments, mdEmbeds } = collectMediaFiles(app, body, sourceFile);
    const scheduleDateUnix = scheduleDate ? Math.floor(scheduleDate.getTime() / 1000) : undefined;

    const client = await createClient(secrets.telegramSession, secrets.telegramApiId, secrets.telegramApiHash);
    try {
        const entity = /^-?\d+$/.test(channel.chatId) ? parseInt(channel.chatId) : channel.chatId;
        const topicId = channel.topicId;

        const photoAndVideoFiles = attachments.filter(f =>
            ["jpg", "jpeg", "png", "webp"].includes(f.extension) || VIDEO_EXTS.has(f.extension)
        );
        const gifFiles = attachments.filter(f => f.extension === "gif");
        // PDFs always upload as documents; embedded .md files join them as document
        // attachments unless they're being sent as comments instead.
        const pdfFiles = attachments.filter(f => f.extension === "pdf");
        const mdDocFiles = treatMdEmbedsAsComments ? [] : mdEmbeds.map(f => mdEmbedToMedia(app, f));
        const docFiles  = [...pdfFiles, ...mdDocFiles];

        let result: SendResult | null = null;
        let captionConsumed = false;
        // First message produced for this part — used to build the scheduled task.
        let firstMsg: Api.Message | undefined;

        // ── Photos and videos: grouped into one album ─────────────────────────────
        if (photoAndVideoFiles.length > 0) {
            const customFiles = await Promise.all(photoAndVideoFiles.map(async f => {
                const blob = await f.getBlob();
                const data = Buffer.from(await blob.arrayBuffer());
                return new CustomFile(f.name, data.length, "", data);
            }));
            const msg = await sendMediaRaw(client, entity, customFiles, text, false, silent, attachUnderText, scheduleDateUnix, topicId);
            result = { link: buildPostLinkFromChatId(channel.chatId, msg.id, topicId), messageId: msg.id };
            if (!firstMsg) firstMsg = msg;
            captionConsumed = true;
        }

        // ── GIFs: each sent individually (must NOT be mixed with videos) ──────────
        for (const gif of gifFiles) {
            const blob = await gif.getBlob();
            const data = Buffer.from(await blob.arrayBuffer());
            const customFile = new CustomFile(gif.name, data.length, "", data);
            const caption = captionConsumed ? "" : text;
            const msg = await sendMediaRaw(client, entity, [customFile], caption, false, silent,
                !captionConsumed && attachUnderText, scheduleDateUnix, topicId);
            if (!result) result = { link: buildPostLinkFromChatId(channel.chatId, msg.id, topicId), messageId: msg.id };
            if (!firstMsg) firstMsg = msg;
            captionConsumed = true;
        }

        // ── Documents (PDFs + uncommented .md embeds): grouped as documents ───────
        if (docFiles.length > 0) {
            const customFiles = await Promise.all(docFiles.map(async f => {
                const blob = await f.getBlob();
                const data = Buffer.from(await blob.arrayBuffer());
                return new CustomFile(f.name, data.length, "", data);
            }));
            const caption = captionConsumed ? "" : text;
            const msg = await sendMediaRaw(client, entity, customFiles, caption, true, silent,
                !captionConsumed && attachUnderText, scheduleDateUnix, topicId);
            if (!result) result = { link: buildPostLinkFromChatId(channel.chatId, msg.id, topicId), messageId: msg.id };
            if (!firstMsg) firstMsg = msg;
            captionConsumed = true;
        }

        if (!captionConsumed && text.length > 0) {
            let msg: Api.Message;
            if (topicId) {
                const peer = await client.getInputEntity(entity);
                const [message, entities] = await _parseMessageText(client, text, "html");
                const req = new Api.messages.SendMessage({
                    peer,
                    message,
                    entities,
                    silent,
                    scheduleDate: scheduleDateUnix,
                    replyTo: new Api.InputReplyToMessage({ replyToMsgId: topicId, topMsgId: topicId }),
                });
                const apiResult = await client.invoke(req);
                const m = getResponseMessage(client, req, apiResult, peer);
                msg = (Array.isArray(m) ? m[0] : m) as Api.Message;
            } else {
                msg = await client.sendMessage(entity, {
                    message: text,
                    parseMode: "html",
                    silent,
                    schedule: scheduleDateUnix,
                });
            }
            result = { link: buildPostLinkFromChatId(channel.chatId, msg.id, topicId), messageId: msg.id };
            if (!firstMsg) firstMsg = msg;
        }

        // For scheduled posts the link built above points at the scheduled-queue id,
        // not the eventual published id. Record what we need to resolve it later.
        if (scheduleDate && result && firstMsg) {
            result.scheduled = {
                chatId: channel.chatId,
                topicId,
                scheduledMsgId: firstMsg.id,
                scheduledDate: firstMsg.date,
                text: firstMsg.message ?? "",
            };
        }

        if (treatMdEmbedsAsComments && result && mdEmbeds.length > 0 && !scheduleDate) {
            onProgress?.();
            const commentLinks: string[] = [];
            for (const mdFile of mdEmbeds) {
                const mdContent = await app.vault.read(mdFile);
                const { body: mdBody } = extractFrontmatter(mdContent);
                const formattedMdContent = mdToTelegramHtml(mdBody);
                if (!formattedMdContent.length) continue;
                const commentLink = await sendCommentViaAccount(client, entity, channel.chatId, result.messageId, formattedMdContent, silent);
                if (commentLink) commentLinks.push(commentLink);
            }
            if (commentLinks.length > 0) result = { ...result, commentLinks };
        }

        return result;
    } finally {
        await client.destroy();
    }
}

// ─── Public entry point ───────────────────────────────────────────────────────

export async function sendNoteToTelegram(
    app: App,
    file: TFile,
    tg_channel: TelegramChannel,
    settings: TelegramSettings,
    secrets: TelegramSecrets,
    silent: boolean,
    attachUnderText: boolean,
    treatMdEmbedsAsComments: boolean,
    updateLink?: string,
    scheduleDate?: Date,
    onProgress?: () => void,
): Promise<{ links: string[]; commentLinks: string[]; errors: Error[]; scheduled: ScheduledSendInfo[] }> {
    const channel = { ...tg_channel, chatId: resolveChatId(tg_channel.chatId) };
    const content = await app.vault.read(file);
    const { body } = extractFrontmatter(content);

    // ── Update Existing Post ──────────────────────────────────────────────────────

    if (updateLink && updateLink !== "none") {
        const formattedContent = mdToTelegramHtml(body);
        const msgIdMatch = updateLink.match(/\/(\d+)\/?$/);
        const messageId = msgIdMatch ? parseInt(msgIdMatch[1], 10) : null;

        if (messageId) {
            const client = await createClient(secrets.telegramSession, secrets.telegramApiId, secrets.telegramApiHash);
            try {
                const entity = /^-?\d+$/.test(channel.chatId) ? parseInt(channel.chatId) : channel.chatId;

                try {
                    await client.editMessage(entity, {
                        message: messageId,
                        text: formattedContent,
                        parseMode: "html",
                    });
                } catch (err) {
                    if (errMessage(err).includes("MESSAGE_NOT_MODIFIED")) {
                        return { links: [updateLink], commentLinks: [], errors: [new Error("MESSAGE_NOT_MODIFIED")], scheduled: [] };
                    }
                    throw err;
                }
            } finally {
                await client.destroy();
            }
            return { links: [updateLink], commentLinks: [], errors: [], scheduled: [] };
        }
    }

    // ── Split body and send each part ─────────────────────────────────────────

    const parts = splitBodyByMarkers(body);
    const effectiveParts = parts.length > 0 ? parts : [body];

    const links: string[] = [];
    const commentLinks: string[] = [];
    const errors: Error[] = [];
    const scheduled: ScheduledSendInfo[] = [];

    for (const part of effectiveParts) {
        try {
            const result = await sendPartViaAccount(app, part, channel, secrets, silent, attachUnderText, file, treatMdEmbedsAsComments, scheduleDate, onProgress);
            if (result) {
                links.push(result.link);
                if (result.commentLinks?.length) commentLinks.push(...result.commentLinks);
                if (result.scheduled) scheduled.push(result.scheduled);
            }
        } catch (err) {
            errors.push(err instanceof Error ? err : new Error(String(err)));
        }
    }

    return { links, commentLinks, errors, scheduled };
}

// Edits pre-written comments in-place using the provided stored comment links
// (caller is responsible for filtering/ordering them). Does NOT touch the post.
export async function editNoteCommentsOnly(
    app: App,
    file: TFile,
    secrets: TelegramSecrets,
    commentLinks: string[],
    silent: boolean,
    embedOffset = 0,
): Promise<{ errors: Error[] }> {
    const content = await app.vault.read(file);
    const { body } = extractFrontmatter(content);
    const { mdEmbeds } = collectMediaFiles(app, body, file);

    const storedLinks = commentLinks;
    if (storedLinks.length === 0 || mdEmbeds.length === 0) return { errors: [] };

    const client = await createClient(secrets.telegramSession, secrets.telegramApiId, secrets.telegramApiHash);
    try {
        let anyChanged = false;
        const limit = Math.min(mdEmbeds.length - embedOffset, storedLinks.length);
        for (let i = 0; i < limit; i++) {
            const mdContent = await app.vault.read(mdEmbeds[i + embedOffset]);
            const { body: mdBody } = extractFrontmatter(mdContent);
            const formattedContent = mdToTelegramHtml(mdBody);
            if (!formattedContent.length) continue;

            const parsed = parseLinkComponents(storedLinks[i]);
            if (!parsed) continue;

            const peer: string | number = /^-?\d+$/.test(parsed.chatId) ? parseInt(parsed.chatId) : parsed.chatId;
            try {
                await client.editMessage(peer, {
                    message: parsed.messageId,
                    text: formattedContent,
                    parseMode: "html",
                });
                anyChanged = true;
            } catch (err) {
                if (!errMessage(err).includes("MESSAGE_NOT_MODIFIED")) throw err;
            }
        }
        if (!anyChanged) return { errors: [new Error("MESSAGE_NOT_MODIFIED")] };
        return { errors: [] };
    } finally {
        await client.destroy();
    }
}

// ─── Scheduled post link resolution ───────────────────────────────────────────

export interface ScheduledResolution {
    task: PendingScheduledLink;
    status: "resolved" | "pending" | "unresolved";
    link?: string;
    // When "pending": the actual send time currently set in Telegram's queue,
    // if it differs from task.scheduledDate (e.g. message was rescheduled).
    updatedScheduledDate?: number;
}

// Resolves published links for previously scheduled posts. For each task:
//   • still in the scheduled queue            → "pending"  (not sent yet)
//   • published message found (date + text)   → "resolved" (with link)
//   • gone from queue but not found in history → "unresolved" (cancelled/deleted)
// Tasks are grouped by peer so a single client connection serves the whole batch.
export async function resolveScheduledLinks(
    secrets: TelegramSecrets,
    tasks: PendingScheduledLink[],
): Promise<ScheduledResolution[]> {
    const resolutions: ScheduledResolution[] = [];
    if (tasks.length === 0) return resolutions;

    const byChat = new Map<string, PendingScheduledLink[]>();
    for (const task of tasks) {
        const group = byChat.get(task.chatId) ?? [];
        group.push(task);
        byChat.set(task.chatId, group);
    }

    const client = await createClient(secrets.telegramSession, secrets.telegramApiId, secrets.telegramApiHash);
    try {
        for (const [chatId, group] of byChat) {
            const entity = /^-?\d+$/.test(chatId) ? parseInt(chatId) : chatId;
            try {
                // Messages still sitting in the scheduled queue: id → current send date.
                // GramJS's high-level getMessages({ scheduled: true }) silently ignores the
                // flag and returns regular history. Use raw GetScheduledHistory instead.
                const scheduledQueue = new Map<number, number>();
                try {
                    const peer = await client.getInputEntity(entity);
                    const sched = await client.invoke(new Api.messages.GetScheduledHistory({
                        peer,
                        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- helpers re-export loses precise BigInteger return type
                    hash: helpers.returnBigInt(0),
                    }));
                    const schedMsgs = "messages" in sched ? sched.messages : [];
                    console.debug("[TG-sched] scheduled queue for", chatId, "→", schedMsgs.map((m: Api.TypeMessage) => ({ id: m.id, date: (m as Api.Message).date })));
                    for (const m of schedMsgs) {
                        if (m instanceof Api.Message) scheduledQueue.set(m.id, m.date);
                    }
                } catch (e) {
                    console.debug("[TG-sched] scheduled queue fetch failed for", chatId, e);
                }

                for (const task of group) {
                    console.debug("[TG-sched] resolving task", { scheduledMsgId: task.scheduledMsgId, scheduledDate: task.scheduledDate, text: task.text.slice(0, 60) });
                    if (scheduledQueue.has(task.scheduledMsgId)) {
                        const queuedDate = scheduledQueue.get(task.scheduledMsgId)!;
                        const updatedScheduledDate = queuedDate !== task.scheduledDate ? queuedDate : undefined;
                        if (updatedScheduledDate) {
                            console.debug("[TG-sched] → still in queue (send time updated to", updatedScheduledDate, ")");
                        } else {
                            console.debug("[TG-sched] → still in queue");
                        }
                        resolutions.push({ task, status: "pending", updatedScheduledDate });
                        continue;
                    }
                    // Left the queue → find the published message by send-time + text.
                    // Telegram publishes scheduled messages up to a few seconds after the
                    // exact scheduled time, so the published .date may differ by 1-2 s.
                    const DATE_SLACK = 10;
                    const published = await client.getMessages(entity, { limit: 50, offsetDate: task.scheduledDate + DATE_SLACK + 1 });
                    console.debug("[TG-sched] history window for offsetDate", task.scheduledDate + DATE_SLACK + 1, "→", published.map(m => ({ id: m.id, date: m.date, text: m.message?.slice(0, 40) })));
                    const match = published.find(m =>
                        Math.abs(m.date - task.scheduledDate) <= DATE_SLACK &&
                        (task.text ? m.message === task.text : !!m.media)
                    );
                    if (match) {
                        console.debug("[TG-sched] → resolved, id", match.id);
                        resolutions.push({ task, status: "resolved", link: buildPostLinkFromChatId(task.chatId, match.id, task.topicId) });
                    } else {
                        console.debug("[TG-sched] → unresolved, no date/text match in window");
                        resolutions.push({ task, status: "unresolved" });
                    }
                }
            } catch {
                // Transient peer-level failure — keep these for the next tick.
                for (const task of group) resolutions.push({ task, status: "pending" });
            }
        }
    } finally {
        await client.destroy();
    }
    return resolutions;
}
