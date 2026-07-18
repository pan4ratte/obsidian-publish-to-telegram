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

export interface PendingScheduledLink {
    notePath: string;
    noteTitle: string;
    accountId?: string;     // account that scheduled the post; used to resolve its link later
    chatId: string;         // resolved peer (@username or -100…), used for matching + link building
    topicId?: number;
    scheduledMsgId: number; // id in the scheduled queue
    scheduledDate: number;  // unix seconds; equals published message .date
    text: string;           // plain-text body for matching ("" for media-only posts)
    createdAt: number;
}

export interface TelegramSettings {
    channels: TelegramChannel[];
    botTokens: BotToken[];
    accounts: TelegramAccount[];
    savePostLinks: boolean;
    treatMdEmbedsAsComments: boolean;
    telegramDisplayName: string;
    dismissedChangelogVersion?: string;
    pendingScheduledLinks: PendingScheduledLink[];
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
    telegramDisplayName: "",
    pendingScheduledLinks: [],
}
