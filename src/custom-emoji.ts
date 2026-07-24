// custom-emoji.ts
// Custom emoji (Telegram Premium): the packs installed on the account and their preview
// images, feeding the picker's custom-emoji sections.
//
// A picked custom emoji goes into the note as `[fallback](tg://emoji?id=…)`; the publishing
// paths turn that into a <tg-emoji emoji-id="…"> entity (see markdown.ts). Sending one
// needs Premium on the publishing account — browsing and inserting do not.
import { Long, TelegramClient, Thumbnail, type FileDownloadLocation, type Sticker } from "@mtcute/web";
import { createClient } from "./telegram";
import { CustomEmojiSet, TelegramSecrets } from "./types";
import { errMessage, retry } from "./util";
import { imageMimeType, PreviewStore, type CustomEmojiPreview } from "./emoji-cache";

// Re-exported so the picker and the plugin keep one import for everything emoji-preview.
export { PreviewStore, type CustomEmojiPreview } from "./emoji-cache";

// Installed packs rarely change; the cached list is refreshed in the background once a day.
export const CUSTOM_EMOJI_TTL = 24 * 60 * 60 * 1000;
// How long the preview connection may sit unused before it's closed.
const IDLE_CLOSE_MS = 15_000;

// Reads the custom emoji packs installed on the account (messages.getEmojiStickers) and the
// emoji in each one. Only the document id and its fallback emoji are kept — enough to
// insert the emoji and to render a tile — so the result is small enough to cache in the
// plugin data and show instantly next time.
export async function loadCustomEmojiSets(secrets: TelegramSecrets): Promise<CustomEmojiSet[]> {
    const client = await createClient(secrets.telegramSession, secrets.telegramApiId, secrets.telegramApiHash);
    try {
        const installed = await client.call({ _: "messages.getEmojiStickers", hash: Long.ZERO });
        if (installed._ !== "messages.allStickers") return [];

        const sets: CustomEmojiSet[] = [];
        for (const set of installed.sets) {
            const full = await client.call({
                _: "messages.getStickerSet",
                stickerset: { _: "inputStickerSetID", id: set.id, accessHash: set.accessHash },
                hash: 0,
            });
            if (full._ !== "messages.stickerSet") continue;

            const entries: CustomEmojiSet["entries"] = [];
            for (const doc of full.documents) {
                if (doc._ !== "document") continue;
                for (const attr of doc.attributes) {
                    // The alt is the standard emoji Telegram shows to clients that can't
                    // render the custom one — exactly what the fallback text must be.
                    if (attr._ !== "documentAttributeCustomEmoji") continue;
                    entries.push({ id: doc.id.toString(), alt: attr.alt });
                    break;
                }
            }
            if (entries.length === 0) continue;
            // Packs can nominate one of their emoji as the icon; the rest show their first.
            const iconId = set.thumbDocumentId?.toString() ?? entries[0].id;
            sets.push({ id: set.id.toString(), title: set.title, iconId, entries });
        }
        return sets;
    } finally {
        await client.destroy();
    }
}

// The emoji's silhouette, built from the vector-outline thumbnail Telegram ships *inside*
// the API response — no file download, so it works even when the data centre holding the
// artwork can't be reached. Telegram's own clients use it as the loading placeholder.
function outlinePreview(sticker: Sticker): CustomEmojiPreview | null {
    const outline = sticker.getThumbnail(Thumbnail.THUMB_OUTLINE);
    if (!outline) return null;
    try {
        // Path thumbnails are drawn in a 512×512 viewport (core.telegram.org/api/files).
        // An <img> renders the SVG in isolation, so the fill can't inherit the theme's
        // colour — a neutral grey is the one that reads on both light and dark.
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">`
            + `<path d="${outline.path}" fill="#808080"/></svg>`;
        return { url: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`, kind: "image", placeholder: true };
    } catch {
        return null;   // not a path thumbnail after all
    }
}

// Runs `fn` over the items with at most `limit` in flight. A screenful of tiles is ~40
// emoji, and firing that many downloads at a cold cross-DC pool is what makes it stall.
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) await fn(items[next++]);
    });
    await Promise.all(workers);
}

// Downloads custom emoji previews on demand (the picker asks for the tiles that scroll into
// view). Custom emoji come in three shapes and Telegram doesn't attach the same previews to
// all of them, so each one is tried in turn: a static thumbnail first (cheapest), then the
// document itself for static WEBP packs, then the WEBM itself for video packs. Lottie (TGS)
// packs carry nothing renderable here, and those tiles keep their fallback emoji.
//
// One connection serves the whole picker session and is closed with the panel; the object
// URLs are kept for the Obsidian session, since the same emoji tends to be picked again.
export class CustomEmojiThumbnails {
    private static previews = new Map<string, CustomEmojiPreview>();

    // Notified whenever previews for these ids become available, so everything showing them
    // (picker tiles, editor decorations) fills in as they arrive.
    private readonly listeners = new Set<(ids: string[]) => void>();

    private readonly secrets: TelegramSecrets | null;
    private readonly store: PreviewStore | null;
    private client: Promise<TelegramClient> | null = null;
    // Downloads are bursty (a screenful at a time) and Telegram drops an idle connection
    // without warning, which the ping loop then reports as timeouts. Closing it ourselves
    // shortly after the last download keeps the console clean and frees the socket.
    private idleTimer: number | null = null;
    // One promise per emoji id while its batch is in flight, so a tile that scrolls in and
    // out again doesn't queue a second download.
    private pending = new Map<string, Promise<void>>();
    private disposed = false;

    // `secrets` is null when no account is authorized: previews then come from the on-disk
    // cache only, and nothing is downloaded.
    constructor(secrets: TelegramSecrets | null, store: PreviewStore | null = null) {
        this.secrets = secrets;
        this.store = store;
    }

    // Registers a listener; the returned function removes it again.
    subscribe(listener: (ids: string[]) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private onUpdate(ids: string[]): void {
        for (const listener of this.listeners) listener(ids);
    }

    // The preview already downloaded for this emoji, if any.
    static cached(id: string): CustomEmojiPreview | null {
        return CustomEmojiThumbnails.previews.get(id) ?? null;
    }

    // Frees every preview held for the session. Called when the plugin unloads.
    static releaseAll(): void {
        for (const preview of CustomEmojiThumbnails.previews.values()) {
            // Outlines are inline data URLs; only downloaded blobs hold memory to free.
            if (preview.url.startsWith("blob:")) URL.revokeObjectURL(preview.url);
        }
        CustomEmojiThumbnails.previews.clear();
    }

    // Resolves once every requested id has been tried; read the results with cached().
    // Ids that only hold a placeholder are tried again, in case the artwork is reachable now.
    async load(ids: string[]): Promise<void> {
        if (this.disposed) return;
        const missing = ids.filter(id =>
            (CustomEmojiThumbnails.previews.get(id)?.placeholder ?? true) && !this.pending.has(id));

        // Anything downloaded in an earlier session is on disk — no connection needed.
        const wanted: string[] = [];
        if (this.store) {
            const restored: string[] = [];
            await mapLimit(missing, 8, async id => {
                const stored = await this.store?.read(id);
                if (stored) {
                    CustomEmojiThumbnails.previews.set(id, stored);
                    restored.push(id);
                } else wanted.push(id);
            });
            if (restored.length > 0) this.onUpdate(restored);
        } else wanted.push(...missing);

        // Downloading needs an authorized account; without one the on-disk cache is all
        // there is, and the rest keep their fallback emoji.
        if (wanted.length > 0 && this.secrets) {
            const batch = this.fetchBatch(wanted);
            for (const id of wanted) this.pending.set(id, batch);
        }
        await Promise.all(ids.map(id => this.pending.get(id) ?? Promise.resolve()));
    }

    private async fetchBatch(ids: string[]): Promise<void> {
        try {
            const client = await this.getClient();
            const stickers = await client.getCustomEmojis(ids.map(id => Long.fromString(id)));
            const found = stickers.filter((sticker): sticker is Sticker => sticker !== null);

            // The silhouettes come free with the response, so tiles stop showing the wrong
            // vanilla glyph immediately — before a single byte is downloaded.
            const outlined: string[] = [];
            for (const sticker of found) {
                const id = sticker.customEmojiId.toString();
                if (CustomEmojiThumbnails.previews.has(id)) continue;
                const outline = outlinePreview(sticker);
                if (!outline) continue;
                CustomEmojiThumbnails.previews.set(id, outline);
                outlined.push(id);
            }
            if (outlined.length > 0) this.onUpdate(outlined);

            const skipped: string[] = [];
            const reasons: string[] = [];
            await mapLimit(found, 4, async sticker => {
                const id = sticker.customEmojiId.toString();
                const preview = await this.downloadPreview(client, sticker, reasons);
                if (preview) {
                    CustomEmojiThumbnails.previews.set(id, preview);
                    this.onUpdate([id]);
                    return;
                }
                // Reported together at the end: one line beats a few hundred.
                skipped.push(`${sticker.mimeType}/[${sticker.thumbnails.map(thumb => thumb.type).join(",") || "no thumbs"}]`);
            });
            if (skipped.length > 0) {
                console.warn(
                    `Publish to Telegram: no preview for ${skipped.length} custom emoji`
                    + ` (${[...new Set(skipped)].join(" ")}) — ${[...new Set(reasons)].join("; ") || "nothing downloadable"}`,
                );
            }
        } catch (err) {
            // Offline, or the account lost access to the pack — tiles keep their fallback
            // emoji, and the ids are dropped from `pending` so a later scroll can retry.
            console.error("Publish to Telegram: custom emoji previews failed:", errMessage(err));
        } finally {
            for (const id of ids) this.pending.delete(id);
            this.scheduleIdleClose();
        }
    }

    // Drops the connection a short while after the last download, so it never sits idle
    // long enough for Telegram to drop it (and for the ping loop to complain). The next
    // batch simply opens a new one.
    private scheduleIdleClose(): void {
        if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
        this.idleTimer = window.setTimeout(() => {
            this.idleTimer = null;
            if (this.pending.size === 0) this.closeClient();
        }, IDLE_CLOSE_MS);
    }

    private closeClient(): void {
        const client = this.client;
        this.client = null;
        if (client) void client.then(c => c.destroy()).catch(() => { /* already gone */ });
    }

    // Tries every form this custom emoji could be rendered in, cheapest first, and returns
    // the first one that downloads. Telegram attaches different thumbnails depending on how
    // the pack was made, so none of these can be assumed to exist.
    private async downloadPreview(client: TelegramClient, sticker: Sticker, reasons: string[]): Promise<CustomEmojiPreview | null> {
        const staticThumb = sticker.getThumbnail(Thumbnail.THUMB_100x100_BOX)
            ?? sticker.getThumbnail(Thumbnail.THUMB_320x320_BOX)
            // Any remaining still image, including the stripped preview mtcute expands
            // locally. Outlines (SVG silhouettes) and video previews are not usable here.
            ?? sticker.thumbnails.find(thumb => !thumb.isVideo && thumb.type !== Thumbnail.THUMB_OUTLINE)
            ?? null;

        const candidates: Array<{ source: FileDownloadLocation; kind: "image" | "video" }> = [];
        if (staticThumb) candidates.push({ source: staticThumb, kind: "image" });
        // The document itself: a WEBP is an image already, and a WEBM plays in a <video>.
        if (sticker.mimeType === "image/webp") candidates.push({ source: sticker, kind: "image" });
        else if (sticker.mimeType === "video/webm") candidates.push({ source: sticker, kind: "video" });

        for (const candidate of candidates) {
            try {
                // Previews live wherever Telegram stored them, often on a data centre this
                // session hasn't talked to yet; that first connection can lose the race, so
                // a failed download gets one more go before the next candidate.
                const bytes = await retry(() => client.downloadAsBuffer(candidate.source), 2, 400);
                if (bytes.byteLength === 0) continue;
                // Copied into a buffer of its own: the download can hand back a view into a
                // larger (possibly shared) buffer, which a Blob must not take as-is.
                const owned = new Uint8Array(bytes.byteLength);
                owned.set(bytes);
                const type = candidate.kind === "video" ? "video/webm" : imageMimeType(bytes);
                // Kept on disk so the next session renders this pack without a connection.
                void this.store?.write(sticker.customEmojiId.toString(), owned, candidate.kind);
                return { url: URL.createObjectURL(new Blob([owned.buffer], { type })), kind: candidate.kind };
            } catch (err) {
                // This form isn't downloadable (expired reference, unreachable data centre,
                // unsupported thumbnail) — record why and fall through to the next one.
                reasons.push(errMessage(err));
            }
        }
        return null;
    }

    private getClient(): Promise<TelegramClient> {
        if (!this.client) {
            const secrets = this.secrets;
            if (!secrets) return Promise.reject(new Error("No authorized account"));
            this.client = createClient(secrets.telegramSession, secrets.telegramApiId, secrets.telegramApiHash);
        }
        return this.client;
    }

    // Closes the connection (the downloaded previews stay cached, and are reused when the
    // bar is opened again). Downloads already in flight are allowed to finish first:
    // destroying the client under them aborts their connection mid-handshake and throws
    // away work that the session cache would otherwise keep.
    dispose(): void {
        this.disposed = true;
        if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
        this.idleTimer = null;
        const client = this.client;
        const inFlight = [...this.pending.values()];
        this.client = null;
        this.pending.clear();
        if (!client) return;
        void Promise.allSettled(inFlight)
            .then(() => client)
            .then(c => c.destroy())
            .catch(() => { /* already gone */ });
    }
}
