import { defineConfig, type Plugin } from "vite";
import { resolve, join, normalize } from "node:path";
import { createReadStream, statSync } from "node:fs";
import { extname } from "node:path";

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

/**
 * Serve the repository's `vendor/libav/` tree at a stable `/libav/*` URL.
 *
 * We used to copy the binaries into `demo/public/libav/` via `copy-libav.mjs`
 * and rely on Vite's public-dir handling. That worked for `<img>` / `<video>`
 * tags but recent Vite versions refuse to let source code `import()` files
 * out of `public/` (to keep the dev/prod semantics of the public folder
 * consistent), which broke the libav loader's dynamic import.
 *
 * This middleware sidesteps that restriction: it streams files directly out
 * of `vendor/libav/` as regular HTTP responses before Vite's module pipeline
 * sees them, so the dynamic `import()` in the libav loader just works. The
 * vendor directory already holds both variants (webcodecs is vendored there
 * by `scripts/copy-libav.mjs` at build time; avbridge is the custom build
 * from `scripts/build-libav.sh`), so there's no separate mirror step.
 */
function serveVendorLibav(): Plugin {
  const vendorRoot = resolve(__dirname, "vendor/libav");
  const mimeByExt: Record<string, string> = {
    ".mjs": "text/javascript; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".wasm": "application/wasm",
    ".map": "application/json; charset=utf-8",
    ".d.ts": "text/plain; charset=utf-8",
  };
  function handle(req: { url?: string }, res: {
    setHeader: (k: string, v: string) => void;
    statusCode: number;
    end: (msg?: string) => void;
  }, next: () => void): void {
    const url = req.url ?? "";
    if (!url.startsWith("/libav/")) { next(); return; }
    // Strip query string and map to filesystem.
    const clean = url.split("?", 1)[0].split("#", 1)[0];
    const rel = clean.slice("/libav/".length);
    // Normalize and reject any path that tries to escape vendorRoot.
    const filePath = normalize(join(vendorRoot, rel));
    if (!filePath.startsWith(vendorRoot)) {
      res.statusCode = 403;
      res.end("forbidden");
      return;
    }
    let st;
    try { st = statSync(filePath); } catch {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    if (!st.isFile()) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    const ext = extname(filePath);
    const mime = mimeByExt[ext] ?? "application/octet-stream";
    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Length", String(st.size));
    // CORP so these files are legal under our require-corp COEP.
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    createReadStream(filePath).pipe(res as unknown as NodeJS.WritableStream);
  }
  return {
    name: "avbridge:serve-vendor-libav",
    configureServer(server) {
      server.middlewares.use(handle);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handle);
    },
  };
}

export default defineConfig(({ command }) => ({
  root: "demo",
  // Use relative paths so the build works at any base URL — GitHub Pages
  // (/avbridge/), local preview (/), or any other hosting.
  base: command === "build" ? "./" : "/",
  plugins: [crossOriginIsolation(), serveVendorLibav()],
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
  // is served from `vendor/libav/<variant>/` by the `serveVendorLibav` plugin
  // above (same URL layout as before — `/libav/<variant>/…` — but bypassing
  // Vite's public-dir restriction on dynamic imports).
  optimizeDeps: {
    exclude: [
      "@libav.js/variant-webcodecs",
      "libavjs-webcodecs-bridge",
    ],
  },
}));
