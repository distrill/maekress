import { take, width } from "./text-width.ts";

const bannerLines = [
  "                        _",
  "                       | |",
  "   _ __ ___   __ _  ___| | ___ __ ___  ___ ___",
  "  | '_ ` _ \\ / _` |/ _ \\ |/ / '__/ _ \\/ __/ __|",
  "  | | | | | | (_| |  __/   <| | |  __/\\__ \\__ \\",
  "  |_| |_| |_|\\__,_|\\___|_|\\_\\_|  \\___||___/___/",
] as const;

export function maekressBanner(columns: number): string {
  // Captured scrollback is split at the terminal width before rendering. Leave
  // one column of slack so the rounded full-width greeting never wraps.
  const boxWidth = Math.max(4, columns - 1);
  const inner = Math.max(0, boxWidth - 4);
  const top = `╭${"─".repeat(Math.max(0, boxWidth - 2))}╮`;
  const bottom = `╰${"─".repeat(Math.max(0, boxWidth - 2))}╯`;
  // The ASCII art has a two-column built-in left margin. Center its visible
  // bounds rather than its whitespace-padded lines.
  const artLeftEdge = Math.min(...bannerLines.map((line) => width(line) - width(line.trimStart())));
  const artRightEdge = Math.max(...bannerLines.map((line) => width(line.trimEnd())));
  const artWidth = artRightEdge - artLeftEdge;
  const artLeft = Math.max(0, Math.floor((inner - Math.min(inner, artWidth)) / 2) - artLeftEdge);
  const rows = ["", ...bannerLines, ""].map((line) => {
    const content = take(line, Math.max(0, inner - artLeft))[0];
    const right = Math.max(0, inner - artLeft - width(content));
    return `│ ${" ".repeat(artLeft)}${content}${" ".repeat(right)} │`;
  });
  return [top, ...rows, bottom].join("\n");
}
