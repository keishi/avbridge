# `<avbridge-video>` — Web Component Spec

This document is the contract for the reference web component shipped as the
`avbridge/element` subpath export. It exists to:

1. **Validate the public API** by being a real consumer of `createPlayer()`.
2. **Drive lifecycle correctness** in the core via adversarial integration tests.
3. **Provide an `HTMLMediaElement`-compatible primitive** that consumers can
   wrap with their own UI.

It is **not** a player UI framework. The element ships zero controls. For
YouTube-style chrome (seek bar, play/pause, settings menu, fullscreen,
auto-hiding controls with consumer toolbar slots), use `<avbridge-player>`
at the `avbridge/player-element` subpath — it wraps this element. This
document covers only `<avbridge-video>`.

---

## Design principles

1. **Match `<video>` where it makes sense.** People should be able to guess the API.
2. **Use properties for rich objects** — `File`, `Blob`, diagnostics objects, track lists, player handles.
3. **Keep the mandatory surface tiny.** A drop-in user should need almost nothing.
4. **Power-user features behind methods/properties, not attributes.** Attributes are for declarative HTML usage; advanced control belongs in JS.
5. **No half-alive state, ever.** See "Lifecycle invariants" below.

---

## Element name

```html
<avbridge-video></avbridge-video>
```

Importing `avbridge/element` registers `<avbridge-video>`. The
chrome-bearing `<avbridge-player>` is registered separately via
`avbridge/player-element`.

---

## API surface

### Attributes

- `src` — URL string source
- `autoplay` — boolean
- `muted` — boolean
- `loop` — boolean
- `preload` — `"none" | "metadata" | "auto"`
- `poster` — URL string (passed through to the inner `<video>`)
- `playsinline` — boolean (passed through to the inner `<video>`)
- `crossorigin` — `"anonymous" | "use-credentials"` (passed through)
- `disableremoteplayback` — boolean (passed through)
- `diagnostics` — boolean; opt-in for verbose `[avbridge:*]` logging and a diagnostics payload on events
- `preferstrategy` — `"auto" | "native" | "remux" | "hybrid" | "fallback"` (preference, not a command)
- `fit` — `"contain" | "cover" | "fill"` (maps to `object-fit` on the inner `<video>` and the fallback canvas; fires a `fitchange` event; default `"contain"`)
- `no-orientation-lock` — boolean; opt out of the default behavior of locking `screen.orientation` to match the video's intrinsic aspect on fullscreen entry

### Properties

- `src: string | null`
- `source: MediaInput | null` — `File | Blob | URL | ArrayBuffer | Uint8Array`
- `autoplay: boolean`
- `muted: boolean`
- `loop: boolean`
- `preload: "none" | "metadata" | "auto"`
- `diagnostics: boolean`
- `fit: "contain" | "cover" | "fill"`
- `noOrientationLock: boolean`
- `subtitles: Array<{ url; language?; format? }> | null` — external subtitle list applied on next bootstrap
- `currentTime: number` — read **and** write (writes seek)
- `readonly duration: number`
- `readonly paused: boolean`
- `readonly ended: boolean`
- `readonly readyState: number`
- `preferredStrategy: "auto" | "native" | "remux" | "hybrid" | "fallback"`
- `readonly strategy: StrategyName | null`
- `readonly strategyClass: StrategyClass | null`
- `readonly player: UnifiedPlayer | null` — escape hatch for advanced users
- `readonly audioTracks: AudioTrackInfo[]`
- `readonly subtitleTracks: SubtitleTrackInfo[]`

#### `HTMLMediaElement` parity surface

- `poster: string`
- `volume: number`
- `playbackRate: number`
- `readonly videoWidth: number`
- `readonly videoHeight: number`
- `readonly played: TimeRanges`
- `readonly seekable: TimeRanges`
- `readonly buffered: TimeRanges`
- `crossOrigin: string | null`
- `disableRemotePlayback: boolean`
- `readonly videoElement: HTMLVideoElement` — escape hatch returning the
  underlying shadow `<video>`. Use for browser-native APIs the wrapper
  doesn't expose (`requestPictureInPicture`, native `audioTracks`,
  `captureStream`, library integrations needing a real `HTMLVideoElement`).
  **Caveat:** when the active strategy is `"fallback"` or `"hybrid"`, frames
  render to a canvas overlay rather than into this `<video>`, so APIs that
  depend on the actual pixels won't show the playing content in those modes.

### Methods

- `play(): Promise<void>`
- `pause(): void`
- `load(): Promise<void>` — explicit (re-)bootstrap if `src`/`source` is set
- `destroy(): Promise<void>` — full teardown; element becomes unusable
- `setAudioTrack(id: number): Promise<void>`
- `setSubtitleTrack(id: number | null): Promise<void>`
- `addSubtitle(subtitle: { url; language?; format? }): Promise<void>` — attach a sidecar subtitle track mid-playback
- `canPlayType(mimeType: string): "" | "maybe" | "probably"` — passes through
  to the inner `<video>`. Note that this answers about the *browser's* native
  support, not avbridge's full capabilities — avbridge can play many formats
  this method returns `""` for.
- `getDiagnostics(): DiagnosticsSnapshot | null`

### Events (DOM `CustomEvent`)

- `ready` — `{ diagnostics }` — fired once per successful bootstrap
- `error` — `{ error, diagnostics }` — bootstrap or runtime error
- `strategychange` — `{ strategy, strategyClass, reason, from?, currentTime?, diagnostics }` — fires on initial classification and any runtime escalation
- `trackschange` — `{ audioTracks, subtitleTracks }`
- `timeupdate` — `{ currentTime }` — dispatched by the player layer so canvas strategies emit it too
- `progress` — `{ buffered }`
- `ended` — `{}`
- `loadstart` — `{}` — fired when bootstrap begins
- `destroy` — `{}` — fired when the element is destroyed
- `fitchange` — `{ fit }` — fires when the `fit` attribute/property changes

#### Forwarded `HTMLMediaElement` events (added in 1.1)

The element forwards every standard `HTMLMediaElement` event from the inner
`<video>` to the wrapper, so consumers can `el.addEventListener(name, …)`
exactly like they would on a real `<video>`:

`loadstart`, `loadedmetadata`, `loadeddata`, `canplay`, `canplaythrough`,
`play`, `playing`, `pause`, `seeking`, `seeked`, `volumechange`, `ratechange`,
`durationchange`, `waiting`, `stalled`, `emptied`, `resize`, `error`.

`progress` is dispatched by the wrapper itself with a `{ buffered }` detail.
`timeupdate` is dispatched by the player layer (so it works for canvas-rendered
fallback playback too, where the inner `<video>` never fires its own
`timeupdate`).

### Event ordering invariant

```text
loadstart → strategychange → ready
```

Never:
- `ready` before `strategychange`
- `strategychange` after `ready` (within the same bootstrap; subsequent escalations fire new `strategychange` events)

---

## Source semantics

- **`src`** is for URL-like string sources. Settable via attribute or property.
- **`source`** is for `File | Blob | URL | ArrayBuffer | Uint8Array`. Property only.
- **Setting one clears the other.** Only one active source at a time.
- **Same value reassignment is a no-op.** `el.src = "a"; el.src = "a"` does NOT recreate the player. (Compare normalized values for strings; identity for rich objects.)
- **Null/empty transitions** destroy the player and return the element to idle state.

---

## `<track>` children for sidecar subtitles

The element supports declarative `<track>` children mirroring native `<video>`:

```html
<avbridge-video src="/movie.mkv" controls>
  <track kind="subtitles" srclang="en" label="English" src="/subs/movie-en.vtt" default>
</avbridge-video>
```

Tracks are picked up at bootstrap. Tracks added/removed dynamically via DOM
mutation are also applied. The JS `addTextTrack()` API exists for cases where
declarative children aren't viable (e.g. file inputs).

---

## Shadow DOM and styling

- The element uses Shadow DOM for style isolation.
- Customization is via `::part()` selectors only — no theming API, no CSS variables explosion.

### Exposed parts

- `video` — the underlying shadow-DOM `<video>` element
- `stage` — the positioned `<div>` wrapping `video`. The fallback
  strategy's canvas overlay attaches here, so styling the stage
  (background, border-radius, aspect-ratio) works across all
  strategies. **Don't remove the wrapper** — removing it breaks
  canvas attachment; see `CLAUDE.md`.

Control parts (`play-button`, `seek-bar`, `settings-button`,
`fullscreen-button`, etc.) live on `<avbridge-player>`, not on this
element.

---

## Lifecycle invariants (NON-NEGOTIABLE)

These are the hard rules. Every test in the lifecycle suite verifies one of these.

### 1. No half-alive state

- `connectedCallback` is atomic: either no player exists OR a fully bootstrapped player exists.
- If `createPlayer()` throws, the element stays in "no player" state and dispatches an `error` event.
- `disconnectedCallback` always destroys the player, even mid-bootstrap.
- `src`/`source` reassignment always goes through full destroy → recreate, never an in-place patch.

### 2. Bootstrap token pattern

The element maintains a monotonically increasing `_bootstrapId`. Every async
bootstrap captures the ID at start; if the ID has changed by the time the
async work resolves, the result is discarded and any partial player is
destroyed.

```ts
private async _bootstrap(source: MediaInput) {
  const id = ++this._bootstrapId;
  await this._teardown();
  let player: UnifiedPlayer;
  try {
    player = await createPlayer({ source, target: this._videoEl });
  } catch (err) {
    if (id !== this._bootstrapId) return; // stale, ignore
    this._dispatchError(err);
    return;
  }
  if (id !== this._bootstrapId || !this.isConnected) {
    await player.destroy();
    return;
  }
  this._player = player;
  // ... wire events
}
```

This single pattern handles:
- Disconnect during bootstrap (#1 in the edge case list below)
- Rapid `src` reassignment (#3)
- Bootstrap race A-after-B (#4)
- Destroy during bootstrap (#5)

### 3. DOM move = full teardown + recreate

When the element is moved between parents (or between documents), it gets
`disconnectedCallback` immediately followed by `connectedCallback`. The
component treats this as a full lifecycle: tear down the player on disconnect,
re-bootstrap on reconnect. Simpler and more predictable than trying to
preserve state across moves.

### 4. Double-registration guard

The element entry MUST guard against double registration:

```ts
if (!customElements.get("avbridge-video")) {
  customElements.define("avbridge-video", AvbridgeVideoElement);
}
```

### 5. Strict entry isolation

`import { createPlayer } from "avbridge"` MUST NOT pull element code.
The element lives behind a separate entry point (`avbridge/element`) and is
never imported by the root entry. The bundle audit verifies this.

---

## Edge case list (lifecycle acceptance tests)

### Category 1: Async lifecycle races

| # | Case | Priority | Invariant |
|---|---|---|---|
| 1 | Disconnect during bootstrap | **P0** | Player discarded and destroyed on stale resolve |
| 2 | Reconnect after disconnect during bootstrap | P1 | Only the latest connection owns the player |
| 3 | Rapid src reassignment in same tick | **P0** | Final value wins, exactly one player created |
| 4 | src reassignment during bootstrap | **P0** | Older bootstrap discarded even if it resolves later |
| 5 | destroy() during bootstrap | P1 | Cancels all pending work permanently |

### Category 2: Connection state edge cases

| # | Case | Priority | Invariant |
|---|---|---|---|
| 6 | Setting source before connection | P1 | No bootstrap until connected |
| 7 | Multiple connect/disconnect cycles | P1 | Each cycle = exactly one clean player |
| 8 | Move within DOM | **P0** | Full teardown + recreate |
| 9 | Move across documents | P1 | Full teardown + recreate |

### Category 3: Source semantics

| # | Case | Priority | Invariant |
|---|---|---|---|
| 10 | src ↔ source mutual exclusion | P1 | Setting one clears the other |
| 11 | Same value reassignment | P1 | No-op, no recreate |
| 12 | Null/empty transitions | P1 | Player destroyed, element idle |

### Category 4: Playback control races

| # | Case | Priority | Invariant |
|---|---|---|---|
| 13 | play() before ready | **P0** | Resolves once ready, not rejected |
| 14 | seek before ready | P1 | Deferred and applied after bootstrap |
| 15 | play/pause spam | P1 | Final state consistent |

### Category 5: Event correctness

| # | Case | Priority | Invariant |
|---|---|---|---|
| 16 | No duplicate events | P1 | Exactly one `ready`/`strategychange` per lifecycle |
| 17 | Event ordering | P1 | `loadstart → strategychange → ready` |
| 18 | Error isolation | P1 | Element remains usable after error |

### Category 6: `<track>` handling

| # | Case | Priority | Invariant |
|---|---|---|---|
| 19 | Tracks present before load | P1 | Picked up during bootstrap |
| 20 | Tracks added after load | P1 | Dynamically applied |
| 21 | Track removal | P1 | Active tracks update |

### Category 7: Memory / cleanup

| # | Case | Priority | Invariant |
|---|---|---|---|
| 22 | No leaks on repeated use | P1 | Memory stabilizes |
| 23 | destroy() idempotency | P1 | Safe to call repeatedly |

### Category 8: Dev environment

| # | Case | Priority | Invariant |
|---|---|---|---|
| 24 | HMR / class redefinition | P1 | Existing instances function or fail gracefully |
| 25 | Double registration guard | P1 | Mandatory |

### Acceptance bar

**P0 must pass.** P1 should pass but is not release-blocking. The five P0 cases are the ones that catch ~80% of real bugs:

1. Disconnect during bootstrap (#1)
2. Rapid src reassignment (#3)
3. Bootstrap race (#4)
4. DOM move (#8)
5. play() before ready (#13)

---

## Layered API surface

### Mandatory (the only thing 95% of users will touch)

- `src` / `source`
- `play()` / `pause()` / `load()`
- `currentTime` / `duration`
- `autoplay` / `muted` / `loop`
- `fit`
- `ready` / `error` / `strategychange` / `timeupdate` events

### Power-user (clearly secondary)

- `preferredStrategy`
- `player` (escape hatch) / `videoElement` (escape hatch)
- `audioTracks` / `subtitleTracks`
- `setAudioTrack()` / `setSubtitleTrack()` / `addSubtitle()`
- `getDiagnostics()` / `diagnostics` attribute
- `noOrientationLock`

---

## TypeScript surface

```ts
import type {
  MediaInput,
  StrategyName,
  StrategyClass,
  UnifiedPlayer,
  AudioTrackInfo,
  SubtitleTrackInfo,
  DiagnosticsSnapshot,
} from "avbridge";

export interface AvbridgeVideoElement extends HTMLElement {
  src: string | null;
  source: MediaInput | null;
  autoplay: boolean;
  muted: boolean;
  loop: boolean;
  preload: "none" | "metadata" | "auto";
  diagnostics: boolean;
  fit: "contain" | "cover" | "fill";
  noOrientationLock: boolean;

  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  readonly ended: boolean;
  readonly readyState: number;
  readonly buffered: TimeRanges;
  readonly played: TimeRanges;
  readonly seekable: TimeRanges;
  readonly videoWidth: number;
  readonly videoHeight: number;

  preferredStrategy: "auto" | "native" | "remux" | "hybrid" | "fallback";

  readonly strategy: StrategyName | null;
  readonly strategyClass: StrategyClass | null;

  readonly player: UnifiedPlayer | null;
  readonly videoElement: HTMLVideoElement;
  readonly audioTracks: AudioTrackInfo[];
  readonly subtitleTracks: SubtitleTrackInfo[];
  subtitles:
    | Array<{ url: string; language?: string; format?: "vtt" | "srt" }>
    | null;

  load(): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  destroy(): Promise<void>;

  setAudioTrack(id: number): Promise<void>;
  setSubtitleTrack(id: number | null): Promise<void>;
  addSubtitle(subtitle: {
    url: string;
    language?: string;
    format?: "vtt" | "srt";
  }): Promise<void>;

  getDiagnostics(): DiagnosticsSnapshot | null;
  canPlayType(mimeType: string): CanPlayTypeResult;
}

declare global {
  interface HTMLElementTagNameMap {
    "avbridge-video": AvbridgeVideoElement;
  }
}
```

---

## Usage examples

### URL source, declarative

```html
<avbridge-video src="/media/movie.mkv"></avbridge-video>
```

### File input, imperative

```ts
const el = document.querySelector("avbridge-video")!;
el.source = file;
await el.play();
```

### Diagnostics opt-in

```html
<avbridge-video src="/movie.avi" diagnostics></avbridge-video>
```

### Sidecar subtitles

```html
<avbridge-video src="/movie.mkv">
  <track kind="subtitles" srclang="en" label="English" src="/subs/movie-en.vtt" default>
</avbridge-video>
```

### Strategy preference (power user)

```ts
el.preferredStrategy = "remux";
el.addEventListener("strategychange", (e) => {
  console.log(e.detail.strategy, e.detail.reason);
});
```

### Escape hatch

```ts
const el = document.querySelector("avbridge-video")!;
const player = el.player; // UnifiedPlayer | null
if (player) {
  await player.setStrategy("fallback");
}
```

---

## Out of scope

- Hard `setStrategy()` on the element (use `el.player.setStrategy()` instead)
- Theming API beyond `::part()`
- Plugin system on the element layer (use `createPlayer({ plugins: [...] })`)
- Skinning / templating (use `<avbridge-player>` or build your own chrome over `<avbridge-video>`)
- Streaming (HLS/DASH) — same scope as the engine
