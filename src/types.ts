export interface TelegramChannel {
    id: string;
    name: string;
    chatId: string;
    isDefault: boolean;
    postStartMarker?: string;
    postEndMarker?: string;
}

export interface TelegramSettings {
    channels: TelegramChannel[];
    savePostLinks: boolean;
    treatMdEmbedsAsComments: boolean;
    postStartMarker: string;
    postEndMarker: string;
}

export const DEFAULT_SETTINGS: TelegramSettings = {
    channels: [],
    savePostLinks: false,
    treatMdEmbedsAsComments: false,
    postStartMarker: ":::post-start-here",
    postEndMarker: ":::post-end-here",
}
