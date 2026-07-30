import esbuild from "esbuild";

const prod = process.argv[2] === "production";

const nodeStubPlugin = {
    name: "node-stubs",
    setup(build) {
        // Node built-ins that mtcute references but the browser build never reaches.
        // There is deliberately no `crypto` alias: nothing in the tree imports node
        // crypto (mtcute ships its own wasm crypto and uses WebCrypto), so the
        // crypto-browserify shim was dropped — which also removes `elliptic` and its
        // advisory GHSA-848j-6mx2-7j84 from the dependency tree. Re-adding a crypto
        // shim would pull elliptic back in via browserify-sign / create-ecdh; stub
        // those two out if that ever becomes necessary.
        const stubModules = ["net", "tls", "fs", "dns", "child_process", "node-localstorage"];
        build.onResolve({ filter: new RegExp(`^(node:)?(${stubModules.join("|")})$`) }, (args) => ({
            path: args.path,
            namespace: "node-stub",
        }));
        build.onLoad({ filter: /.*/, namespace: "node-stub" }, () => ({
            contents: "module.exports = {};",
            loader: "js",
        }));
    },
};

const context = await esbuild.context({
    entryPoints: ["main.ts"],
    bundle: true,
    // Obsidian provides these at runtime. CodeMirror in particular MUST stay external:
    // bundling a second copy would give the editor extension its own state/view classes,
    // which the running editor doesn't recognise.
    external: [
        "obsidian", "electron",
        "@codemirror/state", "@codemirror/view", "@codemirror/language",
        "@codemirror/commands", "@codemirror/search", "@codemirror/autocomplete",
        "@lezer/common", "@lezer/highlight", "@lezer/lr",
    ],
    format: "cjs",
    platform: "browser",
    // mtcute's crypto wasm is embedded via the ".wasm" binary loader (below). Without an
    // explicit target esbuild emits `Uint8Array.fromBase64` to decode it, which Obsidian's
    // Chromium (older than 133) lacks; pinning a Chromium target makes esbuild emit its own
    // base64 decoder instead. It also downlevels mtcute's modern syntax for the renderer.
    target: ["chrome110"],
    // Emit non-ASCII literally instead of as \uXXXX escapes. The bundled emoji set and the
    // localized strings are mostly non-ASCII, and escaping them triples their size.
    charset: "utf8",
    outfile: "main.js",
    minify: prod,
    define: {
        global: "globalThis",
        "process.env.NODE_ENV": prod ? '"production"' : '"development"',
    },
    alias: {
        path: "path-browserify",
        os: "os-browserify/browser",
        stream: "stream-browserify",
        constants: "constants-browserify",
        assert: "assert",
        util: "./shims/util.js",
        vm: "vm-browserify",
    },
    inject: ["./shims/buffer.js", "./shims/process.js"],
    // ".wasm" as "binary" inlines mtcute's AES-IGE/sha wasm into the bundle as bytes, so it
    // never has to be fetched at runtime (Obsidian's file:// origin blocks that).
    loader: { ".md": "text", ".wasm": "binary" },
    plugins: [nodeStubPlugin],
});

if (prod) {
    await context.rebuild();
    await context.dispose();
} else {
    await context.watch();
}
