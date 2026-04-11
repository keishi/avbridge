import { defineConfig } from "tsup";

export default defineConfig({
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
  // splitting: true preserves dynamic imports as separate chunks, which lets
  // consumers' bundlers tree-shake the libav-loader / fallback / hybrid paths
  // when they only use remux/transcode/probe. With splitting: false, dynamic
  // imports get inlined and the lazy-load boundary is lost.
  splitting: true,
  treeshake: true,
  // Keep optional heavy deps external so consumers only pay for them if they
  // actually use the fallback strategy.
  external: [
    "@libav.js/variant-webcodecs",
    "@libav.js/types",
    "libavjs-webcodecs-bridge",
  ],
});
