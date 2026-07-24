// emoji-cache.ts
// On-disk cache for custom emoji previews, kept in the plugin's own folder. Downloading a
// pack costs a cold cross-data-centre connection, so a preview is fetched once and reused
// in later sessions; entries expire after a while so removed packs, re-uploaded artwork and
// emoji the user no longer has don't linger forever.
//
// Free of Telegram/Obsidian runtime imports (only the DataAdapter type), so the expiry
// rules can be unit-tested against a stub adapter.
import type { DataAdapter } from "obsidian";

// What a tile can render. Video previews are looping WEBM (Chromium plays them natively),
// so animated packs animate in the bar the way they do in Telegram. `placeholder` marks the
// vector outline shown until (or instead of) the real artwork — never worth caching.
export interface CustomEmojiPreview {
    url: string;
    kind: "image" | "video";
    placeholder?: boolean;
}

// How long a downloaded preview stays usable. Artwork is stable, so this is about keeping
// the folder honest rather than freshness: a month of not being opened is enough to drop it.
export const PREVIEW_TTL = 30 * 24 * 60 * 60 * 1000;

// Blob type for a downloaded preview, from its magic bytes: previews come back as WEBP,
// sometimes PNG or JPEG, and an <img> needs the right type on the blob.
export function imageMimeType(bytes: Uint8Array): string {
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
    return "image/webp";
}

const extensionFor = (kind: "image" | "video"): string => (kind === "video" ? "webm" : "webp");

export class PreviewStore {
    private readonly adapter: DataAdapter;
    private readonly dir: string;
    private readonly ttl: number;
    // Names present in the folder, listed once — turns every lookup into a set check.
    private index: Promise<Set<string>> | null = null;

    constructor(adapter: DataAdapter, dir: string, ttl: number = PREVIEW_TTL) {
        this.adapter = adapter;
        this.dir = dir;
        this.ttl = ttl;
    }

    private names(): Promise<Set<string>> {
        if (!this.index) {
            this.index = (async () => {
                try {
                    if (!(await this.adapter.exists(this.dir))) return new Set<string>();
                    const listing = await this.adapter.list(this.dir);
                    return new Set(listing.files.map(path => path.slice(path.lastIndexOf("/") + 1)));
                } catch {
                    return new Set<string>();
                }
            })();
        }
        return this.index;
    }

    // The cached preview for this emoji, or null when it isn't cached or has expired.
    // Age comes from the file's own mtime, so there's no index to keep in step.
    async read(id: string): Promise<CustomEmojiPreview | null> {
        const names = await this.names();
        const kind = names.has(`${id}.webm`) ? "video" : names.has(`${id}.webp`) ? "image" : null;
        if (!kind) return null;

        const path = `${this.dir}/${id}.${extensionFor(kind)}`;
        try {
            const stat = await this.adapter.stat(path);
            // Expired entries are left on disk for prune() to clear in one sweep.
            if (!stat || Date.now() - stat.mtime > this.ttl) return null;
            const bytes = await this.adapter.readBinary(path);
            if (bytes.byteLength === 0) return null;
            const type = kind === "video" ? "video/webm" : imageMimeType(new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength)));
            return { url: URL.createObjectURL(new Blob([bytes], { type })), kind };
        } catch {
            return null;   // removed underneath us, or unreadable
        }
    }

    // Stores a freshly downloaded preview, which also resets its expiry (the write updates
    // the file's mtime), so emoji in active use are never dropped.
    async write(id: string, bytes: Uint8Array, kind: "image" | "video"): Promise<void> {
        try {
            if (!(await this.adapter.exists(this.dir))) await this.adapter.mkdir(this.dir);
            const name = `${id}.${extensionFor(kind)}`;
            const buffer = new ArrayBuffer(bytes.byteLength);
            new Uint8Array(buffer).set(bytes);
            await this.adapter.writeBinary(`${this.dir}/${name}`, buffer);
            (await this.names()).add(name);
        } catch {
            // A cache that can't be written just means downloading again next time.
        }
    }

    // Deletes every expired preview. Runs once per session in the background — the whole
    // point is that the folder can't grow without bound, not that it's cleared promptly.
    // Returns how many files were removed (for the tests; callers can ignore it).
    async prune(): Promise<number> {
        let removed = 0;
        try {
            const names = await this.names();
            const now = Date.now();
            for (const name of [...names]) {
                const path = `${this.dir}/${name}`;
                const stat = await this.adapter.stat(path);
                if (stat && now - stat.mtime <= this.ttl) continue;
                await this.adapter.remove(path);
                names.delete(name);
                removed++;
            }
        } catch {
            // Nothing to clean, or the folder is gone — either way there's no cache to fix.
        }
        return removed;
    }
}
