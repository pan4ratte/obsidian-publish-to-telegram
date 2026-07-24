// emoji-search.ts
// Parsing and searching of the bundled emoji set (emoji-data.ts). Kept free of Obsidian
// imports so the matching rules can be unit-tested; the picker UI in emoji.ts adds the
// localized section titles on top.
import { EMOJI_SECTION_DATA } from "./emoji-data";
import { CustomEmojiSet } from "./types";

export { customEmojiRef, parseCustomEmojiRef } from "./markdown";

export interface EmojiEntry {
    emoji: string;
    name: string;      // English name, e.g. "smiling face with smiling eyes"
    keywords: string;  // Russian keywords (CLDR), space separated
    words: string[];   // name + keywords split into words, the unit search matches against
}

export interface EmojiSection {
    key: string;       // people | nature | food | activity | travel | objects | symbols
    icon: string;      // tab glyph
    entries: EmojiEntry[];
}

// Queries shorter than this match on whole-word prefixes only; from this length on, a
// query and a word that share this many leading characters count as a match. That's what
// makes "smile" find "smiling face" and "путеш" find "путешествие" without a stemmer.
const STEM_PREFIX = 4;

let sectionsCache: EmojiSection[] | null = null;
let flatCache: EmojiEntry[] = [];

export function emojiSections(): EmojiSection[] {
    if (!sectionsCache) {
        sectionsCache = EMOJI_SECTION_DATA.map(section => ({
            key: section.key,
            icon: section.icon,
            entries: section.entries.split("\n").map(line => {
                const [emoji, name, keywords = ""] = line.split("|");
                return { emoji, name, keywords, words: `${name} ${keywords}`.split(" ").filter(Boolean) };
            }),
        }));
        flatCache = sectionsCache.flatMap(section => section.entries);
    }
    return sectionsCache;
}

// How well a single word answers a query token. Lower is better; null means no match.
function wordScore(word: string, token: string): number | null {
    if (word === token) return 0;
    if (word.startsWith(token)) return 1;
    // Shared stem: "smile"/"smiling", "сердце"/"сердечко". Needs both sides to be long
    // enough, so short tokens stay strict prefix matches.
    if (token.length >= STEM_PREFIX && word.length >= STEM_PREFIX) {
        let common = 0;
        while (common < token.length && common < word.length && token[common] === word[common]) common++;
        if (common >= STEM_PREFIX) return 2;
    }
    return null;
}

// How well a set of words answers the whole query: every token has to match something,
// and the scores add up. null when the entry isn't a match at all.
function matchWords(words: string[], tokens: string[]): number | null {
    let total = 0;
    for (const token of tokens) {
        let best: number | null = null;
        for (const word of words) {
            const score = wordScore(word, token);
            if (score !== null && (best === null || score < best)) best = score;
        }
        // Last resort: the token sits inside a word ("ippo" in "hippopotamus").
        if (best === null && words.some(word => word.includes(token))) best = 3;
        if (best === null) return null;
        total += best;
    }
    return total;
}

function queryTokens(query: string): string[] {
    return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

// Emoji matching every word of the query, best matches first: exact word hits, then word
// prefixes, then shared stems, then anything containing the query. Matching runs over the
// English names and the Russian keywords alike, so either language finds the same emoji.
export function searchEmoji(query: string, limit = 180): EmojiEntry[] {
    emojiSections();
    const tokens = queryTokens(query);
    if (tokens.length === 0) return [];

    const scored: Array<{ entry: EmojiEntry; score: number }> = [];
    for (const entry of flatCache) {
        const score = matchWords(entry.words, tokens);
        if (score !== null) scored.push({ entry, score });
    }

    // Stable by construction: equal scores keep the dataset's (Telegram's) own order.
    return scored
        .sort((a, b) => a.score - b.score)
        .slice(0, limit)
        .map(hit => hit.entry);
}

export interface CustomEmojiHit {
    id: string;
    alt: string;
    title: string;  // the pack the emoji belongs to
}

// Standard emoji by glyph, so a custom emoji can borrow the search terms of the emoji it
// falls back to: a custom 👍 is findable by "thumbs up" / "палец вверх" like the real one.
let glyphIndex: Map<string, EmojiEntry> | null = null;

// Custom emoji matching the query, by their pack name or through their fallback emoji.
export function searchCustomEmoji(sets: CustomEmojiSet[], query: string, limit = 60): CustomEmojiHit[] {
    if (sets.length === 0) return [];
    const tokens = queryTokens(query);
    if (tokens.length === 0) return [];

    if (!glyphIndex) {
        emojiSections();
        glyphIndex = new Map(flatCache.map(entry => [entry.emoji, entry]));
    }

    const hits: CustomEmojiHit[] = [];
    for (const set of sets) {
        const titleMatches = matchWords(set.title.toLowerCase().split(/\s+/).filter(Boolean), tokens) !== null;
        for (const entry of set.entries) {
            const fallback = glyphIndex.get(entry.alt);
            if (!titleMatches && (!fallback || matchWords(fallback.words, tokens) === null)) continue;
            hits.push({ id: entry.id, alt: entry.alt, title: set.title });
            if (hits.length >= limit) return hits;
        }
    }
    return hits;
}
