// custom-emoji.ts
// Custom emoji (Telegram Premium): the packs installed on the account and their preview
// images, feeding the picker's custom-emoji sections.
//
// A picked custom emoji goes into the note as `[fallback](tg://emoji?id=…)`; the publishing
// paths turn that into a <tg-emoji emoji-id="…"> entity (see markdown.ts). Sending one
// needs Premium on the publishing account — browsing and inserting do not.
import { Long, TelegramClient, Thumbnail } from "@mtcute/web";
import { createClient } from "./telegram";
import { CustomEmojiSet, TelegramSecrets } from "./types";

// Installed packs rarely change; the cached list is refreshed in the background once a day.
export const CUSTOM_EMOJI_TTL = 24 * 60 * 60 * 1000;

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
            if (entries.length > 0) sets.push({ id: set.id.toString(), title: set.title, entries });
        }
        return sets;
    } finally {
        await client.destroy();
    }
}

// Blob type for a downloaded preview, from its magic bytes: custom emoji previews come
// back as WEBP, sometimes PNG or JPEG, and an <img> needs the right type on the blob.
function imageMimeType(bytes: Uint8Array): string {
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
    return "image/webp";
}

// Downloads custom emoji previews on demand (the picker asks for the tiles that scroll into
// view). Previews are the static 100×100 thumbnail every custom emoji carries — animated
// packs (lottie / webm) included — so a tile costs a few KB instead of a full animation.
//
// One connection serves the whole picker session and is closed with the panel; the object
// URLs are kept for the Obsidian session, since the same emoji tends to be picked again.
export class CustomEmojiThumbnails {
    private static urls = new Map<string, string>();

    private readonly secrets: TelegramSecrets;
    private client: Promise<TelegramClient> | null = null;
    // One promise per emoji id while its batch is in flight, so a tile that scrolls in and
    // out again doesn't queue a second download.
    private pending = new Map<string, Promise<void>>();
    private disposed = false;

    constructor(secrets: TelegramSecrets) {
        this.secrets = secrets;
    }

    // The preview already downloaded for this emoji, if any.
    static cached(id: string): string | null {
        return CustomEmojiThumbnails.urls.get(id) ?? null;
    }

    // Frees every preview held for the session. Called when the plugin unloads.
    static releaseAll(): void {
        for (const url of CustomEmojiThumbnails.urls.values()) URL.revokeObjectURL(url);
        CustomEmojiThumbnails.urls.clear();
    }

    // Resolves once every requested id has been tried; read the results with cached().
    async load(ids: string[]): Promise<void> {
        const wanted = ids.filter(id => !CustomEmojiThumbnails.urls.has(id) && !this.pending.has(id));
        if (wanted.length > 0) {
            const batch = this.fetchBatch(wanted);
            for (const id of wanted) this.pending.set(id, batch);
        }
        await Promise.all(ids.map(id => this.pending.get(id) ?? Promise.resolve()));
    }

    private async fetchBatch(ids: string[]): Promise<void> {
        try {
            const client = await this.getClient();
            const stickers = await client.getCustomEmojis(ids.map(id => Long.fromString(id)));
            await Promise.all(stickers.map(async sticker => {
                if (!sticker || this.disposed) return;
                // Static packs can be downloaded whole (they're WEBP images already); for
                // animated ones the boxed thumbnail is the only renderable form.
                const source = sticker.getThumbnail(Thumbnail.THUMB_100x100_BOX)
                    ?? (sticker.sourceType === "static" ? sticker : null);
                if (!source) return;
                const bytes = await client.downloadAsBuffer(source);
                // Copied into a buffer of its own: the download can hand back a view into a
                // larger (possibly shared) buffer, which a Blob must not take as-is.
                const owned = new Uint8Array(bytes.byteLength);
                owned.set(bytes);
                const url = URL.createObjectURL(new Blob([owned.buffer], { type: imageMimeType(bytes) }));
                CustomEmojiThumbnails.urls.set(sticker.customEmojiId.toString(), url);
            }));
        } catch {
            // Offline, or the account lost access to the pack — tiles keep their fallback
            // emoji, and the ids are dropped from `pending` so a later scroll can retry.
        } finally {
            for (const id of ids) this.pending.delete(id);
        }
    }

    private getClient(): Promise<TelegramClient> {
        if (!this.client) {
            this.client = createClient(this.secrets.telegramSession, this.secrets.telegramApiId, this.secrets.telegramApiHash);
        }
        return this.client;
    }

    // Closes the connection (the downloaded previews stay cached).
    dispose(): void {
        this.disposed = true;
        const client = this.client;
        this.client = null;
        this.pending.clear();
        if (client) void client.then(c => c.destroy()).catch(() => { /* already gone */ });
    }
}
