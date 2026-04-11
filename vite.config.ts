import { defineConfig, type Plugin } from "vite";
import { resolve } from "node:path";

/**
 * Cross-origin isolation plugin.
 *
 * libav.js's threaded variant requires `SharedArrayBuffer`, which the browser
 * only exposes when the page is **cross-origin isolated**. That requires the
 * document (and any subresources that aren't same-origin) to be served with:
 *
 *   Cross-Origin-Opener-Policy:   same-origin
 *   Cross-Origin-Embedder-Policy: require-corp
 *
 * Vite's `server.headers` config is supposed to apply these, but in practice
 * the HMR/connect middleware that serves index.html sometimes runs before
 * the headers are added — so the document loads without COOP/COEP and
 * `globalThis.crossOriginIsolated` is `false`.
 *
 * This plugin installs an explicit middleware (early in the chain via
 * `configureServer` returning a function) that sets the headers on every
 * response, including the HTML document. We also set
 * `Cross-Origin-Resource-Policy: same-origin` so other same-origin assets
 * (the libav variant binaries) are CORP-compliant under `require-corp`.
 */
function crossOriginIsolation(): Plugin {
  const apply = (_req: { url?: string }, res: { setHeader: (k: string, v: string) => void }) => {
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  };
  return {
    name: "avbridge:cross-origin-isolation",
    // 1. Tell Vite about the headers via its own server.headers config —
    //    this is the supported route and works in most setups.
    config() {
      return {
        server: {
          headers: {
            "Cross-Origin-Opener-Policy": "same-origin",
            "Cross-Origin-Embedder-Policy": "require-corp",
            "Cross-Origin-Resource-Policy": "same-origin",
          },
        },
        preview: {
          headers: {
            "Cross-Origin-Opener-Policy": "same-origin",
            "Cross-Origin-Embedder-Policy": "require-corp",
            "Cross-Origin-Resource-Policy": "same-origin",
          },
        },
      };
    },
    // 2. Belt: a synchronous middleware that runs BEFORE Vite's internal
    //    middlewares.
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        apply(req, res);
        next();
      });
      // 3. Suspenders: also a post-internal middleware (the
      //    return-a-function form). One of these two should win regardless
      //    of how Vite's HTML middleware writes the response.
      return () => {
        server.middlewares.use((req, res, next) => {
          apply(req, res);
          next();
        });
      };
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        apply(req, res);
        next();
      });
      return () => {
        server.middlewares.use((req, res, next) => {
          apply(req, res);
          next();
        });
      };
    },
  };
}

export default defineConfig({
  root: "demo",
  plugins: [crossOriginIsolation()],
  resolve: {
    alias: {
      avbridge: resolve(__dirname, "src/index.ts"),
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "demo/index.html"),
        convert: resolve(__dirname, "demo/convert.html"),
        elementTest: resolve(__dirname, "demo/element-test.html"),
      },
    },
  },
  server: {
    fs: {
      allow: [resolve(__dirname)],
    },
  },
  // The libav variant + bridge are loaded via dynamic import from a wrapper
  // module so they're code-split into their own chunk. We exclude them from
  // dep optimization because the variant uses `import.meta.url` to find its
  // sibling .wasm files; pre-bundling breaks that. The variant binary itself
  // is served from `demo/public/libav/<variant>/` (copied there by
  // `scripts/copy-libav.mjs` via the `predemo` script), and the loader points
  // libav at that URL via an explicit `base` option.
  optimizeDeps: {
    exclude: [
      "@libav.js/variant-webcodecs",
      "libavjs-webcodecs-bridge",
    ],
  },
});
