// proxy-link.ts
// Reading proxies out of what people paste: Telegram's own share links, proxy URLs, and the
// bare "ip:port:login:password" lines proxy sellers hand out. No Obsidian or Node imports, so
// it runs under the tests as-is.
import type { ProxyType } from "./types";

// What a pasted string says about a proxy. `type` is only set when the string names it (a
// scheme or a Telegram link); a bare address leaves the type to whoever is filling the form.
export interface ParsedProxy {
    type?: ProxyType;
    host: string;
    port?: number;
    username?: string;
    secret?: string;   // MTProxy secret, or the login's password
}

const TELEGRAM_LINK = /^(?:tg:\/\/|(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/)(proxy|socks)\?(.*)$/i;
const SCHEME_URL = /^(socks5h?|socks|https?):\/\//i;

function parsePort(value: string | null | undefined): number | undefined {
    if (!value || !/^\d{1,5}$/.test(value)) return undefined;
    const port = Number(value);
    return port >= 1 && port <= 65535 ? port : undefined;
}

function decode(value: string): string {
    try { return decodeURIComponent(value); } catch { return value; }
}

// Parses one proxy out of `input`, or returns null when it doesn't look like one.
export function parseProxyLink(input: string): ParsedProxy | null {
    const text = input.trim();
    if (!text) return null;

    const tg = TELEGRAM_LINK.exec(text);
    if (tg) {
        const query = new URLSearchParams(tg[2]);
        const host = query.get("server")?.trim();
        const port = parsePort(query.get("port"));
        if (!host || !port) return null;
        if (tg[1].toLowerCase() === "proxy") {
            const secret = query.get("secret")?.trim();
            if (!secret) return null;
            return { type: "mtproto", host, port, secret };
        }
        return {
            type: "socks5", host, port,
            username: query.get("user") || undefined,
            secret: query.get("pass") || undefined,
        };
    }

    const scheme = SCHEME_URL.exec(text);
    if (scheme) {
        let url: URL;
        try { url = new URL(text); } catch { return null; }
        const name = scheme[1].toLowerCase();
        const type: ProxyType = name === "http" ? "http" : name === "https" ? "https" : "socks5";
        const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
        if (!host) return null;
        // WHATWG URL drops a port equal to the scheme's default, so fall back to that.
        const port = parsePort(url.port) ?? defaultProxyPort(type);
        return {
            type, host, port,
            username: url.username ? decode(url.username) : undefined,
            secret: url.password ? decode(url.password) : undefined,
        };
    }

    // login:password@host:port
    let m = /^([^:@\s]+):([^@\s]*)@([^:@\s]+):(\d+)$/.exec(text);
    if (m) {
        const port = parsePort(m[4]);
        return port ? { host: m[3], port, username: m[1], secret: m[2] || undefined } : null;
    }
    // host:port:login:password — the format most proxy sellers use
    m = /^([^:@\s]+):(\d+):([^:\s]+):(\S+)$/.exec(text);
    if (m) {
        const port = parsePort(m[2]);
        return port ? { host: m[1], port, username: m[3], secret: m[4] } : null;
    }
    // host:port
    m = /^([^:@\s]+):(\d+)$/.exec(text);
    if (m) {
        const port = parsePort(m[2]);
        return port ? { host: m[1], port } : null;
    }
    return null;
}

export function defaultProxyPort(type: ProxyType): number {
    switch (type) {
        case "socks5": return 1080;
        case "http": return 80;
        case "https": return 443;
        case "mtproto": return 443;
    }
}

// An MTProxy can only carry MTProto — the Bot API is HTTPS, so bots need a generic tunnel.
export function proxyCarriesBots(type: ProxyType): boolean {
    return type !== "mtproto";
}

function secretBytes(secret: string): number[] | null {
    const s = secret.trim();
    if (/^[0-9a-f]+$/i.test(s)) {
        if (s.length % 2 !== 0) return null;
        const out: number[] = [];
        for (let i = 0; i < s.length; i += 2) out.push(parseInt(s.slice(i, i + 2), 16));
        return out;
    }
    if (!/^[A-Za-z0-9+/_-]+=*$/.test(s)) return null;
    try {
        const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
        const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
        return Array.from(bin, c => c.charCodeAt(0));
    } catch {
        return null;
    }
}

// Whether `secret` is an MTProxy secret mtcute can use: a plain 16-byte one, "dd" (random
// padding) or "ee" (fake TLS, followed by the domain it disguises itself as). Hex or base64.
export function isValidMtProxySecret(secret: string): boolean {
    const bytes = secretBytes(secret);
    if (!bytes) return false;
    if (bytes.length === 16) return true;
    if (bytes.length === 17) return bytes[0] === 0xdd;
    return bytes.length >= 18 && bytes.length <= 17 + 182 && bytes[0] === 0xee;
}
