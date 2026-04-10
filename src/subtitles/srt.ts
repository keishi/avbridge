/**
 * SRT → WebVTT converter.
 *
 * SRT cues:
 *
 *     1
 *     00:00:20,000 --> 00:00:24,400
 *     Subtitle text, possibly multiple lines.
 *
 * WebVTT cues:
 *
 *     WEBVTT
 *
 *     00:00:20.000 --> 00:00:24.400
 *     Subtitle text, possibly multiple lines.
 *
 * The differences in v1 are:
 *  - leading `WEBVTT` magic line
 *  - `,` → `.` for milliseconds
 *  - cue index lines are stripped (WebVTT allows them but SRT-style ints can
 *    confuse some parsers; we drop them)
 *  - BOM is stripped
 */
export function srtToVtt(srt: string): string {
  // Strip BOM
  if (srt.charCodeAt(0) === 0xfeff) srt = srt.slice(1);
  // Normalize line endings
  const normalized = srt.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();

  const blocks = normalized.split(/\n{2,}/);
  const out: string[] = ["WEBVTT", ""];

  for (const block of blocks) {
    const lines = block.split("\n");
    // Drop the leading numeric index, if present.
    if (lines.length > 0 && /^\d+$/.test(lines[0].trim())) {
      lines.shift();
    }
    if (lines.length === 0) continue;

    const timing = lines.shift()!;
    const vttTiming = convertTiming(timing);
    if (!vttTiming) continue; // skip malformed cue

    out.push(vttTiming);
    for (const l of lines) out.push(l);
    out.push("");
  }

  return out.join("\n");
}

function convertTiming(line: string): string | null {
  // SRT: HH:MM:SS,mmm --> HH:MM:SS,mmm  (optional cue settings after)
  const m = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})(.*)$/.exec(
    line.trim(),
  );
  if (!m) return null;
  const fmt = (h: string, mm: string, s: string, ms: string) =>
    `${h.padStart(2, "0")}:${mm}:${s}.${ms.padEnd(3, "0").slice(0, 3)}`;
  return `${fmt(m[1], m[2], m[3], m[4])} --> ${fmt(m[5], m[6], m[7], m[8])}${m[9] ?? ""}`;
}
