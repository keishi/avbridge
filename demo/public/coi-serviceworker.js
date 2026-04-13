/*! coi-service-worker v0.1.7 - Guido Zuidhof, licensed under MIT */
// This service worker adds Cross-Origin-Opener-Policy and
// Cross-Origin-Embedder-Policy headers to enable SharedArrayBuffer on
// hosting platforms (like GitHub Pages) that don't allow custom headers.
// Source: https://github.com/nickvdh/coi-serviceworker
let coepCredentialless = false;
if (typeof window === "undefined") {
  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
  self.addEventListener("message", (ev) => {
    if (ev.data && ev.data.type === "deregister") {
      self.registration.unregister().then(() => self.clients.matchAll()).then((clients) => {
        for (const client of clients) {
          client.navigate(client.url);
        }
      });
    }
  });
  self.addEventListener("fetch", function (e) {
    if (e.request.cache === "only-if-cached" && e.request.mode !== "same-origin") return;
    e.respondWith(
      fetch(e.request).then((response) => {
        if (response.status === 0) return response;
        const headers = new Headers(response.headers);
        headers.set("Cross-Origin-Embedder-Policy", coepCredentialless ? "credentialless" : "require-corp");
        headers.set("Cross-Origin-Opener-Policy", "same-origin");
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }).catch((e) => console.error(e))
    );
  });
} else {
  (() => {
    const reloadedBySelf = window.sessionStorage.getItem("coiReloadedBySelf");
    window.sessionStorage.removeItem("coiReloadedBySelf");
    const coepDegrading = reloadedBySelf === "coepdegrade";
    if (window.crossOriginIsolated !== false || reloadedBySelf) return;
    if (!window.isSecureContext) {
      console.log("COOP/COEP Service Worker: not a secure context, cannot register");
      return;
    }
    navigator.serviceWorker
      .register(new URL("coi-serviceworker.js", window.location.href).href)
      .then(
        (registration) => {
          if (registration.active && !navigator.serviceWorker.controller) {
            window.sessionStorage.setItem("coiReloadedBySelf", coepDegrading ? "coepdegrade" : "");
            window.location.reload();
          } else if (registration.installing) {
            registration.installing.addEventListener("statechange", () => {
              if (registration.active && !navigator.serviceWorker.controller) {
                window.sessionStorage.setItem("coiReloadedBySelf", coepDegrading ? "coepdegrade" : "");
                window.location.reload();
              }
            });
          }
        },
        (err) => console.error("COOP/COEP Service Worker failed to register:", err)
      );
  })();
}
