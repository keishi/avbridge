/**
 * Tiny strongly-typed event emitter. We avoid pulling in eventemitter3 / mitt
 * because we only need a handful of methods and want zero deps.
 *
 * Supports "sticky" events via {@link TypedEmitter.emitSticky}: the last value
 * for that event is remembered, and any future `on()` subscriber receives it
 * immediately. This is the right pattern for one-shot state-snapshot events
 * like "strategy chosen" or "player ready" — callers that subscribe after the
 * event has already fired still need to react to it.
 */

export type Listener<T> = (payload: T) => void;

export class TypedEmitter<EventMap> {
  private listeners: { [K in keyof EventMap]?: Set<Listener<EventMap[K]>> } = {};
  private sticky: { [K in keyof EventMap]?: EventMap[K] } = {};

  on<K extends keyof EventMap>(event: K, fn: Listener<EventMap[K]>): () => void {
    let set = this.listeners[event];
    if (!set) {
      set = new Set();
      this.listeners[event] = set;
    }
    set.add(fn);

    // Replay any sticky value that's already been emitted for this event.
    if (Object.prototype.hasOwnProperty.call(this.sticky, event)) {
      try {
        fn(this.sticky[event] as EventMap[K]);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[avbridge] listener threw replaying sticky value:", err);
      }
    }

    return () => this.off(event, fn);
  }

  off<K extends keyof EventMap>(event: K, fn: Listener<EventMap[K]>): void {
    this.listeners[event]?.delete(fn);
  }

  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    const set = this.listeners[event];
    if (!set) return;
    // Snapshot so listeners can unsubscribe themselves.
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        // Don't let one bad listener break the others.
        // eslint-disable-next-line no-console
        console.error("[avbridge] listener threw:", err);
      }
    }
  }

  /**
   * Like {@link emit} but also remembers the value so future subscribers
   * receive it on `on()`. Use for one-shot state-snapshot events.
   */
  emitSticky<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    this.sticky[event] = payload;
    this.emit(event, payload);
  }

  removeAll(): void {
    this.listeners = {};
    this.sticky = {};
  }
}
