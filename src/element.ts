/**
 * Subpath entry: `import "avbridge/element"` registers the
 * `<avbridge-video>` custom element.
 *
 * This is a separate entry point from the core (`avbridge`) so that consumers
 * who only want the engine don't pay for the element code, and consumers who
 * want both pay for the element code exactly once.
 *
 * The registration is guarded so re-importing this module (e.g. via HMR or
 * multiple bundles) does not throw a "name already defined" error.
 *
 * Only `<avbridge-video>` (the bare HTMLMediaElement-compatible primitive)
 * is registered here. The chrome-bearing `<avbridge-player>` lives at the
 * `avbridge/player-element` subpath.
 */

import { AvbridgeVideoElement } from "./element/avbridge-video.js";

export { AvbridgeVideoElement };

if (typeof customElements !== "undefined" && !customElements.get("avbridge-video")) {
  customElements.define("avbridge-video", AvbridgeVideoElement);
}
