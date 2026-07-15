import { Buffer } from "buffer";

// The `buffer` browser polyfill (feross/buffer) doesn't implement the Node "base64url"
// encoding, but mtcute's @fuman/utils base64 codec prefers `Buffer` when it's defined and
// uses base64url for string sessions (exportSession/importSession) — so without this the
// account login fails with "Unknown encoding: base64url" right after the password step.
// Add base64url by delegating to base64 with URL-safe substitutions. Other encodings and
// call signatures pass straight through to the original implementation.
if (!Buffer.__base64urlPatched) {
    const origFrom = Buffer.from.bind(Buffer);
    Buffer.from = function (value, encoding, length) {
        if (encoding === "base64url" && typeof value === "string") {
            const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
            return origFrom(b64, "base64");
        }
        return origFrom(value, encoding, length);
    };

    const origToString = Buffer.prototype.toString;
    Buffer.prototype.toString = function (encoding, start, end) {
        if (encoding === "base64url") {
            return origToString.call(this, "base64", start, end)
                .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
        }
        return origToString.call(this, encoding, start, end);
    };

    Buffer.__base64urlPatched = true;
}

export { Buffer };
