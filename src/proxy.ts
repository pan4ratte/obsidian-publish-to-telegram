// proxy.ts
// Routing the plugin's Telegram traffic through a proxy. Account connections (mtcute) and Bot
// API requests each take their own proxy, set by the plugin with setProxies() whenever settings
// are saved; with none set, both go direct exactly as before.
//
// Proxies need raw TCP sockets, which only the desktop app has (Node's net/tls, loaded at run
// time). Obsidian mobile keeps its WebSocket / fetch paths and ignores the setting — there, a
// system-wide VPN is the way through. VPN protocols (VLESS, Shadowsocks, …) are reached via
// their clients' local SOCKS5/HTTP port. See "Deferred ideas" in CONTRIBUTING.md for both.
import { Platform } from "obsidian";
import {
    BaseMtProxyTransport,
    IntermediatePacketCodec,
    ObfuscatedPacketCodec,
    WebSocketTransport,
    type TelegramTransport,
    type ITelegramConnection,
} from "@mtcute/web";
import {
    ConnectionClosedError,
    performHttpProxyHandshake,
    performSocksHandshake,
    type ITcpConnection,
    type TcpEndpoint,
} from "@fuman/net";
import type { ProxyType } from "./types";
import { t } from "../lang/helpers";

// A proxy with its secret resolved from SecretStorage: everything needed to connect.
export interface ProxyConfig {
    type: ProxyType;
    host: string;
    port: number;
    username?: string;
    secret?: string;   // MTProxy secret (mtproto) or the login's password (others)
}

const CONNECT_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 60_000;

let accountProxy: ProxyConfig | null = null;
let botProxy: ProxyConfig | null = null;

export function setProxies(account: ProxyConfig | null, bot: ProxyConfig | null): void {
    accountProxy = account;
    // Only a generic tunnel can carry HTTPS; an MTProxy reaching here would be a settings bug.
    botProxy = bot && bot.type !== "mtproto" ? bot : null;
}

// Proxies need sockets, and sockets need the desktop app.
export function proxiesSupported(): boolean {
    return Platform.isDesktopApp;
}

// ─── Node sockets ─────────────────────────────────────────────────────────────

type NodeSocket = import("net").Socket;

interface NodeNet {
    net: typeof import("net");
    tls: typeof import("tls");
    http: typeof import("http");
}

let nodeNet: Promise<NodeNet> | null = null;

// Node's networking modules, loaded on first use. They exist only in the desktop app, so the
// bundle leaves them external (esbuild.config.mjs) and nothing touches them on mobile.
function loadNodeNet(): Promise<NodeNet> {
    if (!Platform.isDesktop) throw new Error(t.PROXY_DESKTOP_ONLY);
    nodeNet ??= Promise.all([import("net"), import("tls"), import("http")])
        .then(([net, tls, http]) => ({ net, tls, http }));
    return nodeNet;
}

// A Node socket as the pull-based connection mtcute and @fuman/net read from and write to.
class SocketConnection implements ITcpConnection {
    private chunks: Uint8Array[] = [];
    private error: Error | null = null;
    private wake: (() => void) | null = null;

    private readonly onData = (chunk: Uint8Array) => { this.chunks.push(chunk); this.notify(); };
    private readonly onClose = () => this.fail(new ConnectionClosedError());
    private readonly onError = (err: Error) => this.fail(err);

    constructor(private readonly socket: NodeSocket, private readonly remote: TcpEndpoint) {
        socket.on("data", this.onData);
        socket.on("end", this.onClose);
        socket.on("close", this.onClose);
        socket.on("error", this.onError);
    }

    get localAddress(): TcpEndpoint | null {
        const { localAddress, localPort } = this.socket;
        return localAddress && localPort ? { address: localAddress, port: localPort } : null;
    }

    get remoteAddress(): TcpEndpoint { return this.remote; }

    async read(into: Uint8Array): Promise<number> {
        while (this.chunks.length === 0) {
            if (this.error) throw this.error;
            await new Promise<void>(resolve => { this.wake = resolve; });
        }
        const chunk = this.chunks[0];
        const size = Math.min(chunk.length, into.length);
        into.set(chunk.subarray(0, size));
        if (size === chunk.length) this.chunks.shift();
        else this.chunks[0] = chunk.subarray(size);
        return size;
    }

    write(bytes: Uint8Array): Promise<void> {
        if (this.error) return Promise.reject(this.error);
        return new Promise((resolve, reject) => {
            this.socket.write(bytes, err => { if (err) reject(err); else resolve(); });
        });
    }

    close(): void {
        this.fail(new ConnectionClosedError());
        this.socket.destroy();
    }

    setNoDelay(noDelay: boolean): void { this.socket.setNoDelay(noDelay); }
    setKeepAlive(keepAlive: boolean): void { this.socket.setKeepAlive(keepAlive); }

    // Hands the bare socket back once a proxy handshake is done, so TLS can take it over.
    // Anything already read past the handshake goes back into the socket first.
    detach(): NodeSocket {
        const { socket } = this;
        socket.off("data", this.onData);
        socket.off("end", this.onClose);
        socket.off("close", this.onClose);
        socket.off("error", this.onError);
        // The TLS layer on top reports failures; this keeps a late error on the bare socket
        // from going unhandled.
        socket.on("error", () => {});
        for (const chunk of this.chunks.reverse()) socket.unshift(chunk);
        this.chunks = [];
        return socket;
    }

    private fail(err: Error): void {
        if (!this.error) this.error = err;
        this.notify();
    }

    private notify(): void {
        const wake = this.wake;
        this.wake = null;
        wake?.();
    }
}

// Opens a TCP connection (TLS when `servername` is given) with a deadline and abort support.
async function connectSocket(endpoint: TcpEndpoint, servername: string | null, signal?: AbortSignal): Promise<SocketConnection> {
    const { net, tls } = await loadNodeNet();
    return new Promise((resolve, reject) => {
        signal?.throwIfAborted();
        const socket: NodeSocket = servername
            ? tls.connect({ host: endpoint.address, port: endpoint.port, servername })
            : net.connect({ host: endpoint.address, port: endpoint.port });
        const readyEvent = servername ? "secureConnect" : "connect";
        const cleanup = () => {
            window.clearTimeout(timer);
            socket.off(readyEvent, onReady);
            socket.off("error", onFail);
            signal?.removeEventListener("abort", onAbort);
        };
        const onFail = (err: unknown) => {
            cleanup();
            socket.destroy();
            reject(err instanceof Error ? err : new Error(String(err)));
        };
        const onAbort = () => onFail(signal?.reason);
        const onReady = () => {
            cleanup();
            resolve(new SocketConnection(socket, endpoint));
        };
        const timer = window.setTimeout(
            () => onFail(new Error(t.PROXY_ERR_TIMEOUT.replace("{host}", `${endpoint.address}:${endpoint.port}`))),
            CONNECT_TIMEOUT_MS,
        );
        socket.once(readyEvent, onReady);
        socket.once("error", onFail);
        signal?.addEventListener("abort", onAbort);
    });
}

// A connection to `destination` through a SOCKS5 or HTTP(S) proxy.
async function openTunnel(proxy: ProxyConfig, destination: TcpEndpoint, signal?: AbortSignal): Promise<SocketConnection> {
    const conn = await connectSocket(
        { address: proxy.host, port: proxy.port },
        proxy.type === "https" ? proxy.host : null,
        signal,
    );
    const onAbort = () => conn.close();
    signal?.addEventListener("abort", onAbort);
    try {
        const settings = {
            host: proxy.host,
            port: proxy.port,
            user: proxy.username || undefined,
            password: proxy.secret || undefined,
        };
        if (proxy.type === "socks5") {
            await performSocksHandshake(conn, conn, { ...settings, version: 5 }, destination);
        } else {
            await performHttpProxyHandshake(conn, conn, settings, destination);
        }
        signal?.throwIfAborted();
    } catch (err) {
        conn.close();
        throw err;
    } finally {
        signal?.removeEventListener("abort", onAbort);
    }
    return conn;
}

// ─── Account connections (mtcute) ─────────────────────────────────────────────

// mtcute over a SOCKS5 / HTTP(S) tunnel to the data centre's own address. Obfuscated framing,
// as the WebSocket transport uses, so the stream doesn't read as MTProto on the wire.
class TunnelTransport implements TelegramTransport {
    constructor(private readonly proxy: ProxyConfig) {}

    connect(dc: Parameters<TelegramTransport["connect"]>[0], signal: AbortSignal): Promise<ITelegramConnection> {
        return openTunnel(this.proxy, { address: dc.ipAddress, port: dc.port }, signal);
    }

    packetCodec() {
        return new ObfuscatedPacketCodec(new IntermediatePacketCodec());
    }
}

// mtcute's own MTProxy transport (plain, "dd" and fake-TLS "ee" secrets); it only needs a
// TCP connection to the proxy.
class MtProxyTransport extends BaseMtProxyTransport {
    _connectTcp(endpoint: TcpEndpoint, signal: AbortSignal): Promise<ITcpConnection> {
        return connectSocket(endpoint, null, signal);
    }
}

export function transportForProxy(proxy: ProxyConfig): TelegramTransport {
    if (proxy.type === "mtproto") {
        if (!proxy.secret) throw new Error(t.PROXY_ERR_NO_SECRET);
        return new MtProxyTransport({ host: proxy.host, port: proxy.port, secret: proxy.secret });
    }
    return new TunnelTransport(proxy);
}

// The transport a new account client should use: through the account proxy on desktop,
// WebSocket otherwise.
export function accountTransport(): TelegramTransport {
    if (!accountProxy || !proxiesSupported()) return new WebSocketTransport();
    return transportForProxy(accountProxy);
}

// ─── Bot API requests ─────────────────────────────────────────────────────────

// The proxy Bot API requests should go through, or null to use Obsidian's own HTTP stack.
export function activeBotProxy(): ProxyConfig | null {
    return botProxy && proxiesSupported() ? botProxy : null;
}

export interface ProxiedResponse {
    status: number;
    text: string;
}

// An HTTPS request through `proxy`: a tunnel to the host, TLS over it, then plain HTTP/1.1.
export async function proxiedHttpsRequest(
    proxy: ProxyConfig,
    url: string,
    init: { method: string; headers?: Record<string, string>; body?: Uint8Array },
): Promise<ProxiedResponse> {
    const { tls, http } = await loadNodeNet();
    const target = new URL(url);
    const port = Number(target.port) || 443;
    const tunnel = await openTunnel(proxy, { address: target.hostname, port });
    const bare = tunnel.detach();

    const secure = await new Promise<import("tls").TLSSocket>((resolve, reject) => {
        const socket = tls.connect({ socket: bare, servername: target.hostname, ALPNProtocols: ["http/1.1"] });
        const onError = (err: Error) => { socket.destroy(); reject(err); };
        socket.once("secureConnect", () => { socket.off("error", onError); resolve(socket); });
        socket.once("error", onError);
    });

    try {
        return await new Promise<ProxiedResponse>((resolve, reject) => {
            const body = init.body ?? new Uint8Array(0);
            const req = http.request({
                host: target.hostname,
                port,
                path: `${target.pathname}${target.search}`,
                method: init.method,
                headers: {
                    ...init.headers,
                    "Host": target.hostname,
                    "Content-Length": String(body.length),
                    "Connection": "close",
                },
                createConnection: () => secure,
                timeout: REQUEST_TIMEOUT_MS,
            }, res => {
                const chunks: Uint8Array[] = [];
                res.on("data", (chunk: Uint8Array) => chunks.push(chunk));
                res.on("error", reject);
                res.on("end", () => {
                    const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
                    let offset = 0;
                    for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
                    resolve({ status: res.statusCode ?? 0, text: new TextDecoder().decode(all) });
                });
            });
            req.on("error", reject);
            req.on("timeout", () => req.destroy(new Error(t.PROXY_ERR_TIMEOUT.replace("{host}", target.hostname))));
            req.end(body);
        });
    } finally {
        secure.destroy();
    }
}
