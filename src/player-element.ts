/**
 * Registration entry point for `<avbridge-player>`.
 *
 * Import `"avbridge/player"` to register the element. This also registers
 * `<avbridge-video>` (which `<avbridge-player>` wraps internally).
 *
 * Separate from `"avbridge/element"` so consumers who only need the bare
 * `<avbridge-video>` primitive don't pay for the controls CSS/JS.
 */

import { AvbridgePlayerElement } from "./element/avbridge-player.js";

export { AvbridgePlayerElement } from "./element/avbridge-player.js";
export type { AvbridgeVideoElement } from "./element/avbridge-video.js";

if (!customElements.get("avbridge-player")) {
  customElements.define("avbridge-player", AvbridgePlayerElement);
}
