/**
 * Browser stub for `node:fs/promises`.
 *
 * mediabunny's ESM entry transitively imports `node:fs/promises` from its
 * Node-compat `node.js` file (used by `FilePathSource` / `FilePathTarget`).
 * Its `package.json` has a `browser` field that tells bundlers to stub this
 * out at build time — but import maps in the browser can't read
 * `package.json`, so for the pre-bundled `dist/element-browser.js` entry we
 * have tsup/esbuild alias `node:fs/promises` → this file at bundle time.
 *
 * Any caller that reaches this code is trying to use a Node-only feature in
 * the browser and will fail loudly with a clear message instead of hanging
 * or throwing an opaque `undefined is not a function` somewhere deep in
 * mediabunny.
 */
function notAvailable(): never {
  throw new Error(
    "node:fs/promises is not available in the browser. " +
    "The file-path APIs (FilePathSource / FilePathTarget) only work in Node.js.",
  );
}

export const open = notAvailable;
export const readFile = notAvailable;
export const writeFile = notAvailable;
export const stat = notAvailable;
export const mkdir = notAvailable;
export const rm = notAvailable;
export const unlink = notAvailable;
