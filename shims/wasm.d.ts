// esbuild's ".wasm": "binary" loader turns a `*.wasm` import into a Uint8Array of the
// file's bytes, inlined into the bundle. Used to embed mtcute's crypto wasm (AES-IGE/sha)
// so it never has to be fetched at runtime (Obsidian's file:// origin blocks that).
declare module "*.wasm" {
    const bytes: Uint8Array<ArrayBuffer>;
    export default bytes;
}
