import { defineConfig } from "tsup";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = (p: string): string =>
  resolve(fileURLToPath(new URL(".", import.meta.url)), p);

const NODE_FS_STUB = here("src/stubs/node-fs-promises.ts");

export default defineConfig([
  // 1. Bundler-friendly entries.
  //
  //    These keep mediabunny + libav as bare specifiers so downstream
  //    bundlers (Vite, webpack, Rollup, esbuild) can tree-shake, share
  //    dependencies, and resolve them through the normal node_modules
  //    chain. This is the path ~90% of consumers use.
  {
    entry: {
      index: "src/index.ts",
      element: "src/element.ts",
    },
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "es2022",
    platform: "browser",
    // splitting: true preserves dynamic imports as separate chunks, which
    // lets consumers' bundlers tree-shake the libav-loader / fallback /
    // hybrid paths when they only use remux/transcode/probe. With
    // splitting: false, dynamic imports get inlined and the lazy-load
    // boundary is lost.
    splitting: true,
    treeshake: true,
    // Keep optional heavy deps external so consumers only pay for them if
    // they actually use the fallback strategy.
    external: [
      "@libav.js/variant-webcodecs",
      "@libav.js/types",
      "libavjs-webcodecs-bridge",
    ],
  },

  // 2. Pre-bundled browser entry: `dist/element-browser.js`.
  //
  //    Single-file output intended for direct `<script type="module">`
  //    consumption without a bundler. Every bare-specifier dependency is
  //    either inlined (mediabunny, libavjs-webcodecs-bridge) or handled
  //    via a runtime URL (the libav.js variants under vendor/libav/,
  //    lazy-loaded via `import(variantUrl)` against `import.meta.url`).
  //    mediabunny's Node-branch `node:fs/promises` import is aliased to a
  //    stub that throws loudly if ever reached.
  //
  //    Net effect: this single file has zero remaining bare specifiers at
  //    runtime and is safe to load via `<script type="module" src="...">`
  //    without a bundler or an import map.
  //
  //    The classic `dist/element.js` and `dist/index.js` entries above are
  //    not affected; this is additive.
  {
    entry: {
      "element-browser": "src/element.ts",
    },
    format: ["esm"],
    dts: false, // types come from the classic `dist/element.d.ts` above
    sourcemap: true,
    clean: false, // don't wipe the first build's output
    target: "es2022",
    platform: "browser",
    splitting: false, // single-file output
    treeshake: true,
    // Inline every bare-specifier dep so the browser doesn't have to
    // resolve any module specifier at runtime. libavjs-webcodecs-bridge
    // is a small ESM helper with no Node-specific code, so inlining it
    // is cheap.
    noExternal: ["mediabunny", "libavjs-webcodecs-bridge"],
    external: [
      // The actual libav.js WASM variants — these are lazy-loaded at
      // runtime via a URL-based dynamic import (not a bare specifier),
      // so they stay external and the loader resolves them through
      // `new URL("../vendor/libav/...", import.meta.url)`.
      "@libav.js/variant-webcodecs",
      "@libav.js/types",
    ],
    esbuildOptions(options) {
      // Alias node:fs/promises → our stub so mediabunny's ./node.js import
      // resolves to a safe no-op in the browser. This is the one thing
      // package.json's `browser` field would have done for a bundler, but
      // since import maps can't read that field, we bake it in here.
      options.alias = {
        ...(options.alias ?? {}),
        "node:fs/promises": NODE_FS_STUB,
      };
    },
  },
]);
