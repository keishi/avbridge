/** Light validation for incoming VTT — we do not parse cues, just confirm header. */
export function isVtt(text: string): boolean {
  const trimmed = text.replace(/^\ufeff/, "").trimStart();
  return trimmed.startsWith("WEBVTT");
}
