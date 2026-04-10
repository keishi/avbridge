import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  platform: "browser",
  splitting: false,
  treeshake: true,
  // Keep optional heavy deps external so consumers only pay for them if they
  // actually use the fallback strategy.
  external: [
    "@libav.js/variant-webcodecs",
    "@libav.js/types",
    "libavjs-webcodecs-bridge",
  ],
});
