import { moment } from "obsidian";
import en from "./en";
import ru from "./ru";
import userGuideEn from "../USER_GUIDE.md";
import userGuideRu from "../USER_GUIDE_RU.md";
import changelogEn from "../CHANGELOG.md";
import changelogRu from "../CHANGELOG_RU.md";

const localeMap: { [key: string]: typeof en } = {
    en,
    ru,
};

const lang = moment.locale();
export const t = localeMap[lang] || localeMap.en;

const userGuideContents: { [key: string]: string } = {
    ru: userGuideRu,
};

export function getUserGuideContent(): string {
    return userGuideContents[lang] ?? userGuideEn;
}

const changelogContents: { [key: string]: string } = {
    ru: changelogRu,
};

export function getChangelogContent(): string {
    return changelogContents[lang] ?? changelogEn;
}
