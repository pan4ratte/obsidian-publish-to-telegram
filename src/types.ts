export interface ChatTarget {
    id: string;
    title?: string;
    topicId?: number;
}

export interface BotToken {
    id: string;
    name: string;          // user-provided label; token value lives in SecretStorage under `bot-token-${id}`
}

export interface TelegramAccount {
    id: string;
    displayName: string;   // resolved from getMe() at login; shown in the account dropdown / modal
    apiId: number;         // 0 when using bundled credentials
    apiHash: string;       // "" when using bundled credentials
    userId?: number;       // Telegram user id from getMe(); identifies the account for duplicate-login checks
    // session string lives in SecretStorage under `account-session-${id}`, never in data.json
}

// How a preset posts: via a user account (mtcute / User API) or via a bot (Bot API),
// each with a plain and a Rich Message variant. A single preset can carry both an account
// and a bot and switch between methods. The "-rich" variants send Rich Messages (Telegram
// rich text): "account-rich" from the user account (requires Telegram Premium),
// "bot-rich" from the bot (and its comments as Rich Messages too).
export type PostMethod = "account" | "account-rich" | "bot" | "bot-rich";

export interface TelegramChannel {
    id: string;
    name: string;
    defaultMethod: PostMethod;  // primary method; used when publishing without an explicit override
    useSecondaryMethods?: boolean; // when set, the preset also configures the non-primary method
    accountId?: string;    // references a TelegramAccount to post from (account method)
    botTokenId?: string;   // references a BotToken in settings.botTokens (bot methods)
    botToken?: string;     // in-memory token value resolved from botTokenId, never written to data.json
    chatTargets: ChatTarget[];
    chatId: string;        // legacy field — kept for telegram.ts compat; synced to chatTargets[0].id
    chatTitle?: string;    // legacy field — synced to chatTargets[0].title
    isDefault: boolean;
    topicId?: number;
}

// Per-part publish options chosen in the advanced modal's split layout, index-aligned to
// parseSplitPosts order. When provided to a send path, unselected parts are skipped and each
// sent part uses its own silent/attachments/schedule values instead of the publish-wide ones.
export interface SplitPartOptions {
    selected: boolean;
    silent: boolean;
    attachUnderText: boolean;
    scheduleDate?: Date;            // account methods only; bot methods can't schedule
    sendWhenOnline?: boolean;       // account methods only: deliver when the recipient comes online (wins over scheduleDate)
    linkPreviewUrl?: string;        // URL whose link preview the post should render (classic text-only posts)
    linkPreviewAboveText?: boolean; // render the link preview above the post text
    linkPreviewDisabled?: boolean;  // suppress the link preview entirely (wins over the two above)
}

export interface PendingScheduledLink {
    notePath: string;
    noteTitle: string;
    accountId?: string;     // account that scheduled the post; used to resolve its link later
    chatId: string;         // resolved peer (@username or -100…), used for matching + link building
    topicId?: number;
    scheduledMsgId: number; // id in the scheduled queue
    scheduledDate: number;  // unix seconds; equals published message .date
    text: string;           // plain-text body for matching ("" for media-only posts)
    partIndex?: number;     // index of this post's split part; used to write the resolved link into its split marker
    createdAt: number;
}

// A custom emoji pack installed on the account (Telegram Premium emoji), as the picker
// needs it: the document id to insert and the standard emoji it falls back to.
export interface CustomEmojiSet {
    id: string;
    title: string;
    iconId?: string;   // custom emoji used as the pack's icon (its own thumb, else its first emoji)
    entries: Array<{ id: string; alt: string }>;
}

export interface TelegramSettings {
    channels: TelegramChannel[];
    botTokens: BotToken[];
    accounts: TelegramAccount[];
    savePostLinks: boolean;
    treatMdEmbedsAsComments: boolean;
    alwaysSilent: boolean;            // publish with a soundless notification by default (overridable per publish)
    telegramDisplayName: string;
    dismissedChangelogVersion?: string;
    pendingScheduledLinks: PendingScheduledLink[];
    recentEmoji: string[];            // most recently picked emoji, newest first (emoji picker)
    customEmojiSets?: CustomEmojiSet[];   // custom emoji packs installed on the account, cached for the picker
    customEmojiFetchedAt?: number;        // unix ms of that cache; drives the background refresh
}

export interface TelegramSecrets {
    telegramSession: string;
    telegramApiId: number;
    telegramApiHash: string;
}

export const DEFAULT_SETTINGS: TelegramSettings = {
    channels: [],
    botTokens: [],
    accounts: [],
    savePostLinks: false,
    treatMdEmbedsAsComments: false,
    alwaysSilent: false,
    telegramDisplayName: "",
    pendingScheduledLinks: [],
    recentEmoji: [],
}
