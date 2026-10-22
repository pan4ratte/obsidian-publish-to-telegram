// Syncs the manual test notes between the repository (`test-notes/`) and a vault folder.
//
//   npm run test-notes -- push [vault-folder] [--force]   repository → vault
//   npm run test-notes -- pull [vault-folder]             vault → repository
//
// The vault folder defaults to "Publish to Telegram" in the vault this plugin is installed in
// (three levels up from the repository: <vault>/.obsidian/plugins/<plugin>).
//
// Publishing writes post links into the notes (`tg_posts`, `tg_comments`, `\split` commands).
// Those links are per-user state, so they never reach the repository: `pull` strips them, and
// `push` treats a vault note that differs only in its links as up to date, keeping the links.
//
// `push` copies what the vault is missing and leaves alone what it has; a vault file that differs
// from the repository is only overwritten with --force, so unsaved test edits aren't lost.
// `pull` only takes files under top-level folders the repository already has, so private notes
// kept next to the tests in the vault stay out. Neither command deletes anything.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = path.join(repoRoot, "test-notes");

const args = process.argv.slice(2);
const force = args.includes("--force");
const [command, folderArg] = args.filter(a => !a.startsWith("--"));

function defaultVaultFolder() {
    const vault = path.resolve(repoRoot, "../../..");
    return fs.existsSync(path.join(vault, ".obsidian")) ? path.join(vault, "Publish to Telegram") : null;
}

const vaultDir = folderArg ? path.resolve(folderArg) : defaultVaultFolder();
if (!["push", "pull"].includes(command) || !vaultDir) {
    console.error("Usage: npm run test-notes -- push|pull [vault-folder] [--force]");
    if (["push", "pull"].includes(command)) console.error("The plugin isn't installed in a vault, so pass the vault folder explicitly.");
    process.exit(1);
}

// Every file under `dir`, as forward-slash paths relative to it.
function listFiles(dir, prefix = "") {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        return entry.isDirectory() ? listFiles(path.join(dir, entry.name), rel) : [rel];
    });
}

// A note without its published links, with LF line endings.
function stripLinks(text) {
    let out = text.replace(/\r\n/g, "\n");
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(out);
    if (fm) {
        const lines = [];
        let inLinks = false;
        for (const line of fm[1].split("\n")) {
            if (/^\S/.test(line)) inLinks = /^(tg_posts|tg_comments):/.test(line);
            else if (inLinks && /^\s+-/.test(line)) continue;
            lines.push(line);
        }
        out = `---\n${lines.join("\n")}\n---\n` + out.slice(fm[0].length);
    }
    return out
        .replace(/^([ \t]*)%%[ \t]*\\split\b.*?%%[ \t]*$/gm, "$1%% \\split %%")
        .replace(/^([ \t]*)<!--[ \t]*\\split\b.*?-->[ \t]*$/gm, "$1<!-- \\split -->");
}

const isNote = rel => rel.endsWith(".md");
const read = file => fs.readFileSync(file);

// Whether the vault file is the repository file, ignoring links and line endings for notes.
function same(repoFile, vaultFile, rel) {
    return isNote(rel)
        ? stripLinks(read(vaultFile).toString("utf8")) === stripLinks(read(repoFile).toString("utf8"))
        : read(vaultFile).equals(read(repoFile));
}

function copy(from, to, rel, strip) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (isNote(rel)) {
        const text = read(from).toString("utf8").replace(/\r\n/g, "\n");
        fs.writeFileSync(to, strip ? stripLinks(text) : text);
    } else {
        fs.copyFileSync(from, to);
    }
}

const report = { copied: [], updated: [], unchanged: 0, differs: [], skipped: new Set(), missing: [] };

if (command === "push") {
    for (const rel of listFiles(repoDir)) {
        const from = path.join(repoDir, rel), to = path.join(vaultDir, rel);
        if (!fs.existsSync(to)) { copy(from, to, rel, false); report.copied.push(rel); }
        else if (same(from, to, rel)) report.unchanged++;
        else if (force) { copy(from, to, rel, false); report.updated.push(rel); }
        else report.differs.push(rel);
    }
} else {
    const tracked = new Set(fs.existsSync(repoDir) ? fs.readdirSync(repoDir) : []);
    const vaultFiles = listFiles(vaultDir);
    for (const rel of vaultFiles) {
        const top = rel.split("/")[0];
        if (!tracked.has(top)) { report.skipped.add(top); continue; }
        const from = path.join(vaultDir, rel), to = path.join(repoDir, rel);
        if (!fs.existsSync(to)) { copy(from, to, rel, true); report.copied.push(rel); }
        else if (same(to, from, rel)) report.unchanged++;
        else { copy(from, to, rel, true); report.updated.push(rel); }
    }
    const inVault = new Set(vaultFiles);
    report.missing = listFiles(repoDir).filter(rel => !inVault.has(rel));
}

const where = command === "push" ? vaultDir : repoDir;
console.log(`${command === "push" ? "Repository → vault" : "Vault → repository"}: ${where}`);
for (const rel of report.copied) console.log(`  + ${rel}`);
for (const rel of report.updated) console.log(`  ~ ${rel}`);
console.log(`${report.copied.length} added, ${report.updated.length} updated, ${report.unchanged} unchanged.`);
if (report.differs.length) {
    console.log(`\nThese differ in the vault and were left alone (pull them, or push with --force to overwrite):`);
    for (const rel of report.differs) console.log(`  ! ${rel}`);
}
if (report.skipped.size) console.log(`\nNot in the repository, skipped: ${[...report.skipped].join(", ")}`);
if (report.missing.length) {
    console.log(`\nIn the repository but not in the vault (delete them from test-notes/ if that's intended):`);
    for (const rel of report.missing) console.log(`  - ${rel}`);
}
