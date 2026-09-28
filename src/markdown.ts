// Minimal streaming markdown renderer for transcript boxes. Produces styled
// spans per line (no ANSI codes; captured-stdout scrollback counts escapes as
// characters). Enough structure for model answers: headings, bold/italic/
// strikethrough/inline code, fenced code blocks, quotes, lists, and links.
import { RGBA, createTextAttributes, StyledText, type TextChunk } from "@opentui/core";
import { width, take } from "./text-width.ts";

export type MarkdownLine = TextChunk[];

const attributes = {
  bold: createTextAttributes({ bold: true }),
  dim: createTextAttributes({ dim: true }),
  italic: createTextAttributes({ italic: true }),
  strike: createTextAttributes({ strikethrough: true }),
};

const hex = (color: string) => RGBA.fromHex(color);
const palette = {
  heading: hex("#89B4FA"),
  code: hex("#A6E3A1"),
  quote: hex("#F9E2AF"),
  link: hex("#89DCEB"),
  plain: hex("#E5E9F0"),
};

const chunk = (text: string, fg = palette.plain, attrs = 0): TextChunk =>
  ({ __isChunk: true, text, fg, attributes: attrs });

type Span = { text: string; fg?: TextChunk["fg"]; attributes?: number };

function inlineSpans(text: string, baseFg: TextChunk["fg"] = palette.plain, baseAttrs = 0): Span[] {
  // Tokenize inline markers left to right; unmatched markers stay literal.
  const pattern = /(`+)([^`]+)\1|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\n]+)\*|_([^_\n]+)_|~~([^~]+)~~|\[([^\]]+)\]\(([^)\s]+)\)|<([^>\s]+)>/g;
  const spans: Span[] = [];
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > cursor) spans.push({ text: text.slice(cursor, match.index), fg: baseFg, attributes: baseAttrs });
    const [raw] = match;
    if (match[2] !== undefined) {
      spans.push({ text: match[2], fg: palette.code });
    } else if (match[3] !== undefined || match[4] !== undefined) {
      spans.push({ text: match[3] ?? match[4]!, fg: baseFg, attributes: baseAttrs | attributes.bold });
    } else if (match[5] !== undefined || match[6] !== undefined) {
      spans.push({ text: match[5] ?? match[6]!, fg: baseFg, attributes: baseAttrs | attributes.italic });
    } else if (match[7] !== undefined) {
      spans.push({ text: match[7], fg: baseFg, attributes: baseAttrs | attributes.strike });
    } else if (match[8] !== undefined && match[9] !== undefined) {
      spans.push({ text: match[8], fg: palette.link, attributes: baseAttrs | attributes.underline ?? 0 });
      spans.push({ text: ` (${match[9]})`, fg: baseFg, attributes: baseAttrs | attributes.dim });
    } else if (match[10] !== undefined) {
      spans.push({ text: match[10], fg: palette.link, attributes: baseAttrs | attributes.underline ?? 0 });
    } else {
      spans.push({ text: raw, fg: baseFg, attributes: baseAttrs });
    }
    cursor = match.index + raw.length;
  }
  if (cursor < text.length) spans.push({ text: text.slice(cursor), fg: baseFg, attributes: baseAttrs });
  return spans.length ? spans : [{ text, fg: baseFg, attributes: baseAttrs }];
}

function line(text: string, baseFg?: TextChunk["fg"], baseAttrs = 0): MarkdownLine {
  if (!text) return [];
  return inlineSpans(text, baseFg, baseAttrs).map((span) => chunk(span.text, span.fg, span.attributes ?? 0));
}

// Render markdown into styled lines. Streaming-safe: unfinished fences render
// as code, so partial output never flashes raw markers for completed lines.
export function markdownLines(markdown: string): MarkdownLine[] {
  const result: MarkdownLine[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let inFence = false;
  let fenceMarker = "";
  for (const raw of lines) {
    const fence = raw.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      const marker = fence[1]![0]!.repeat(3);
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
        const info = raw.slice(fence[1]!.length).trim();
        result.push([chunk(info ? `┃ ${info}` : "┃", palette.code)]);
        continue;
      }
      if (fence[1]![0] === fenceMarker[0] && fence[1]!.length >= fenceMarker.length) {
        inFence = false;
        fenceMarker = "";
        result.push([chunk("┃", palette.code)]);
        continue;
      }
    }
    if (inFence) {
      result.push([chunk(`│ ${raw}`, palette.code)]);
      continue;
    }
    const heading = raw.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1]!.length;
      result.push(line(heading[2]!, palette.heading, level <= 2 ? attributes.bold : 0));
      if (level <= 2) result.push([chunk("─".repeat(24), palette.heading, attributes.dim)]);
      continue;
    }
    const quote = raw.match(/^>\s?(.*)$/);
    if (quote) {
      result.push(line(`▌ ${quote[1]!}`, palette.quote));
      continue;
    }
    const bullet = raw.match(/^(\s*)[-*+]\s+(.*)$/);
    if (bullet) {
      const indent = " ".repeat(Math.floor(bullet[1]!.length / 2) * 2);
      result.push([chunk(`${indent}• `), ...line(bullet[2]!)]);
      continue;
    }
    const ordered = raw.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (ordered) {
      const indent = " ".repeat(Math.floor(ordered[1]!.length / 2) * 2);
      result.push([chunk(`${indent}${ordered[2]}. `, palette.plain, attributes.dim), ...line(ordered[3]!)]);
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(raw)) {
      result.push([chunk("─".repeat(24), palette.plain, attributes.dim)]);
      continue;
    }
    result.push(line(raw));
  }
  return result;
}

export function markdownToStyledText(markdown: string): StyledText {
  const lines = markdownLines(markdown);
  const chunks: TextChunk[] = [];
  lines.forEach((line, index) => {
    if (index > 0) chunks.push(chunk("\n"));
    if (line.length) chunks.push(...line);
    else if (index > 0 && index < lines.length - 1) chunks.push(chunk(" "));
  });
  return new StyledText(chunks.length ? chunks : [chunk("")]);
}

// Word-wrap styled chunks, preserving each chunk's color/attributes across rows.
function wrapStyled(line: MarkdownLine, max: number): MarkdownLine[] {
  if (max < 1) return [line];
  const rows: MarkdownLine[] = [];
  let current: MarkdownLine = [];
  let used = 0;
  const breakRow = () => {
    rows.push(current);
    current = [];
    used = 0;
  };
  for (const source of line) {
    if (!source.text) continue;
    let rest = source.text;
    while (rest) {
      if (used && width(rest) <= max - used) {
        current.push({ ...source, text: rest });
        used += width(rest);
        break;
      }
      if (used && width(rest) > max - used) {
        const [head] = take(rest, Math.max(1, max - used));
        const breakAt = head.lastIndexOf(" ");
        if (breakAt > 0) {
          current.push({ ...source, text: head.slice(0, breakAt) });
          rest = rest.slice(breakAt + 1);
          breakRow();
          continue;
        }
        breakRow();
        continue;
      }
      // Row start: word-wrap the source against the full width.
      if (width(rest) <= max) {
        current.push({ ...source, text: rest });
        used += width(rest);
        break;
      }
      const [head] = take(rest, max);
      const breakAt = head.lastIndexOf(" ");
      if (breakAt > 0 && width(head) - width(head.slice(0, breakAt)) < max / 2) {
        current.push({ ...source, text: head.slice(0, breakAt) });
        rest = rest.slice(breakAt + 1);
      } else {
        current.push({ ...source, text: head });
        rest = rest.slice(head.length);
      }
      breakRow();
    }
  }
  if (current.length || !rows.length) rows.push(current.length ? current : [{ ...line[0] ?? chunk(""), text: "" }]);
  return rows;
}

function rowWidth(row: MarkdownLine): number {
  return row.reduce((sum, span) => sum + width(span.text), 0);
}

const borderChunk = (text: string, color?: string): TextChunk => chunk(text, color ? RGBA.fromHex(color) : undefined);

export type MarkdownBox = { boxWidth: number; rows: MarkdownLine[] };

// chatBox-compatible bordered box whose content is styled markdown. Each row is
// exactly boxWidth display cells wide so the right border stays aligned.
export function markdownBox(markdown: string, columns = 80, label = "Agent", borderColor?: string): MarkdownBox {
  const available = Math.max(4, columns - 1);
  const boxWidth = Math.min(available, Math.max(4, columns - 8));
  const inner = Math.max(1, boxWidth - 4);
  const heading = `─ ${label.replace(/\s+/g, " ").trim()} `;
  const rows: MarkdownLine[] = [
    [borderChunk(`╭${heading}${"─".repeat(Math.max(0, boxWidth - 2 - width(heading)))}╮`, borderColor)],
  ];
  for (const line of markdownLines(markdown)) {
    for (const row of wrapStyled(line, inner)) {
      const padding = " ".repeat(Math.max(0, inner - rowWidth(row)));
      rows.push([borderChunk("│ ", borderColor), ...(row.length ? row : [chunk("")]), chunk(padding), borderChunk(" │", borderColor)]);
    }
  }
  rows.push([borderChunk(`╰${"─".repeat(boxWidth - 2)}╯`, borderColor)]);
  return { boxWidth, rows };
}
