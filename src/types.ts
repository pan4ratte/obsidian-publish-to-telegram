export interface ChatTarget {
    id: string;
    title?: string;
    topicId?: number;
}

export interface TelegramChannel {
    id: string;
    name: string;
    type: "bot" | "user";
    botToken?: string;     // type === "bot" only; in-memory, loaded from SecretStorage, never written to data.json
    chatTargets: ChatTarget[];
    chatId: string;        // legacy field — kept for telegram.ts compat; synced to chatTargets[0].id
    chatTitle?: string;    // legacy field — synced to chatTargets[0].title
    isDefault: boolean;
    topicId?: number;
}

export interface PendingScheduledLink {
    notePath: string;
    noteTitle: string;
    chatId: string;         // resolved peer (@username or -100…), used for matching + link building
    topicId?: number;
    scheduledMsgId: number; // id in the scheduled queue
    scheduledDate: number;  // unix seconds; equals published message .date
    text: string;           // plain-text body for matching ("" for media-only posts)
    createdAt: number;
}

export interface TelegramSettings {
    channels: TelegramChannel[];
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
    savePostLinks: false,
    treatMdEmbedsAsComments: false,
    telegramDisplayName: "",
    pendingScheduledLinks: [],
}
