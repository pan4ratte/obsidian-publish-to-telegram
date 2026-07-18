// Shared error-handling helpers.

// These use the `window.`-prefixed timers Obsidian's lint rules require for popout
// window compatibility; tests/util.test.ts shims `window` to exercise them under Node.

// Rejects with `Timed out` if `promise` hasn't settled within `ms`. The underlying
// work keeps running — this only bounds how long the caller waits on it.
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error("Timed out")), ms);
        promise.then(resolve, reject).finally(() => window.clearTimeout(timer));
    });
}

// Retries an async operation up to `attempts` times, pausing `delayMs` between tries.
// Rethrows the last error when every attempt fails.
export async function retry<T>(op: () => Promise<T>, attempts: number, delayMs: number): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
        try {
            return await op();
        } catch (err) {
            lastErr = err;
            if (i < attempts - 1) await new Promise(r => window.setTimeout(r, delayMs));
        }
    }
    throw lastErr;
}

// Safely extracts a message from an unknown caught value.
export function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

// Extracts a Telegram/GramJS error code (RPCError.errorMessage), falling back to
// the standard message — mirrors the old `err.errorMessage ?? err.message ?? ""`.
export function errCode(err: unknown): string {
    if (err && typeof err === "object") {
        const e = err as { errorMessage?: unknown; message?: unknown };
        if (typeof e.errorMessage === "string") return e.errorMessage;
        if (typeof e.message === "string") return e.message;
    }
    return "";
}
