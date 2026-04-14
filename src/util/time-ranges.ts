/**
 * Synthesize a `TimeRanges`-shaped object for the HTMLMediaElement contract
 * on canvas strategies (hybrid/fallback). The real `TimeRanges` interface
 * is browser-only and not constructable; this object duck-types it.
 *
 * `ranges` is an array of `[start, end]` pairs in seconds, in ascending
 * order. The returned object exposes `length`, `start(i)`, `end(i)` —
 * the full surface consumers actually use.
 *
 * NOTE: Plain objects and real TimeRanges aren't `instanceof`-comparable,
 * but consumer code virtually never checks that. The methods + length
 * property are what matters.
 */
export function makeTimeRanges(ranges: Array<[number, number]>): TimeRanges {
  const frozen = ranges.slice();
  const impl = {
    get length(): number {
      return frozen.length;
    },
    start(index: number): number {
      if (index < 0 || index >= frozen.length) {
        throw new DOMException(
          `TimeRanges.start: index ${index} out of range (length=${frozen.length})`,
          "IndexSizeError",
        );
      }
      return frozen[index][0];
    },
    end(index: number): number {
      if (index < 0 || index >= frozen.length) {
        throw new DOMException(
          `TimeRanges.end: index ${index} out of range (length=${frozen.length})`,
          "IndexSizeError",
        );
      }
      return frozen[index][1];
    },
  };
  return impl as TimeRanges;
}
