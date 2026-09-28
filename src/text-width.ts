// Display-width measurement and truncation shared by transcript and markdown
// rendering (scrollback rows are split by character count but rendered by cells).
export function width(text: string): number {
  let count = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (/\p{Mark}/u.test(char) || code === 0x200d || code === 0xfe0f) continue;
    count += code >= 0x1100 && (code <= 0x115f || code >= 0x2329 && code <= 0x232a || code >= 0x2e80 && code <= 0xa4cf || code >= 0xac00 && code <= 0xd7a3 || code >= 0xf900 && code <= 0xfaff || code >= 0xfe10 && code <= 0xfe19 || code >= 0xfe30 && code <= 0xfe6f || code >= 0xff00 && code <= 0xff60 || code >= 0xffe0 && code <= 0xffe6 || code >= 0x1f300 && code <= 0x1faff) ? 2 : 1;
  }
  return count;
}

export function take(text: string, max: number): [string, string] {
  let used = 0;
  let index = 0;
  for (const char of text) {
    const size = width(char);
    if (used + size > max) break;
    used += size;
    index += char.length;
  }
  return [text.slice(0, index), text.slice(index)];
}
