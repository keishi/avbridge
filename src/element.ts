/**
 * Subpath entry: `import "avbridge/element"` registers the
 * `<avbridge-player>` custom element.
 *
 * This is a separate entry point from the core (`avbridge`) so that consumers
 * who only want the engine don't pay for the element code, and consumers who
 * want both pay for the element code exactly once.
 *
 * The registration is guarded so re-importing this module (e.g. via HMR or
 * multiple bundles) does not throw a "name already defined" error.
 */

import { AvbridgePlayerElement } from "./element/avbridge-player.js";

export { AvbridgePlayerElement };

if (typeof customElements !== "undefined" && !customElements.get("avbridge-player")) {
  customElements.define("avbridge-player", AvbridgePlayerElement);
}
