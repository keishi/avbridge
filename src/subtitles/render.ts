/**
 * Custom subtitle overlay for the fallback strategy. We don't have a `<video>`
 * with text tracks here, so we render cues into a positioned div ourselves.
 *
 * v1 only handles plain-text WebVTT cues with `HH:MM:SS.mmm` timing. Cue
 * settings, voice tags, and styling are ignored.
 */

interface Cue {
  start: number;
  end: number;
  text: string;
}

export class SubtitleOverlay {
  private el: HTMLDivElement;
  private cues: Cue[] = [];

  constructor(parent: HTMLElement) {
    this.el = document.createElement("div");
    this.el.style.cssText =
      "position:absolute;left:0;right:0;bottom:8%;text-align:center;color:white;text-shadow:0 0 4px black;font-family:sans-serif;font-size:1.4em;pointer-events:none;";
    parent.appendChild(this.el);
  }

  loadVtt(text: string): void {
    this.cues = parseVtt(text);
  }

  update(currentTime: number): void {
    const active = this.cues.find((c) => currentTime >= c.start && currentTime <= c.end);
    this.el.textContent = active?.text ?? "";
  }

  destroy(): void {
    this.el.remove();
    this.cues = [];
  }
}

function parseVtt(text: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = text.replace(/\r\n/g, "\n").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n").filter(Boolean);
    if (lines.length === 0 || lines[0] === "WEBVTT") continue;
    const timingIdx = lines.findIndex((l) => l.includes("-->"));
    if (timingIdx < 0) continue;
    const m = /(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})\.(\d{3})/.exec(
      lines[timingIdx],
    );
    if (!m) continue;
    const t = (h: string, mm: string, s: string, ms: string) =>
      Number(h) * 3600 + Number(mm) * 60 + Number(s) + Number(ms) / 1000;
    cues.push({
      start: t(m[1], m[2], m[3], m[4]),
      end: t(m[5], m[6], m[7], m[8]),
      text: lines.slice(timingIdx + 1).join("\n"),
    });
  }
  return cues;
}
