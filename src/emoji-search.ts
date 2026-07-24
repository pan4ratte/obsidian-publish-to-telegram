// emoji-search.ts
// Parsing and searching of the bundled emoji set (emoji-data.ts). Kept free of Obsidian
// imports so the matching rules can be unit-tested; the picker UI in emoji.ts adds the
// localized section titles on top.
import { EMOJI_SECTION_DATA } from "./emoji-data";

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

// Emoji matching every word of the query, best matches first: exact word hits, then word
// prefixes, then shared stems, then anything containing the query. Matching runs over the
// English names and the Russian keywords alike, so either language finds the same emoji.
export function searchEmoji(query: string, limit = 180): EmojiEntry[] {
    emojiSections();
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return [];

    const scored: Array<{ entry: EmojiEntry; score: number }> = [];
    for (const entry of flatCache) {
        let total = 0;
        let matched = true;
        for (const token of tokens) {
            let best: number | null = null;
            for (const word of entry.words) {
                const score = wordScore(word, token);
                if (score !== null && (best === null || score < best)) best = score;
            }
            // Last resort: the token sits inside a word ("ippo" in "hippopotamus").
            if (best === null && entry.words.some(word => word.includes(token))) best = 3;
            if (best === null) { matched = false; break; }
            total += best;
        }
        if (matched) scored.push({ entry, score: total });
    }

    // Stable by construction: equal scores keep the dataset's (Telegram's) own order.
    return scored
        .sort((a, b) => a.score - b.score)
        .slice(0, limit)
        .map(hit => hit.entry);
}
