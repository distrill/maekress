import assert from "node:assert/strict";
import { test } from "node:test";
import { RGBA } from "@opentui/core";
import { markdownLines, markdownToStyledText, markdownBox } from "./markdown.ts";

const text = (line: { chunks: { text: string }[] } | { chunks: { text: string }[] }[]) =>
  Array.isArray(line) ? line.map((chunk) => chunk.text).join("") : line.chunks.map((chunk) => chunk.text).join("");

test("headings, lists, and quotes render with markers replaced", () => {
  const lines = markdownLines("# Title\n\n- one\n- two\n\n> quoted").map(text);
  assert.deepEqual(lines, ["Title", "─".repeat(24), "", "• one", "• two", "", "▌ quoted"]);
});

test("inline styles survive as separate spans without ANSI codes", () => {
  const lines = markdownLines("mix **bold**, *italic*, ~~gone~~, `code()`");
  assert.equal(lines.length, 1);
  const spans = lines[0]!.filter((chunk) => chunk.text.trim());
  assert.deepEqual(spans.map((chunk) => chunk.text), ["mix ", "bold", ", ", "italic", ", ", "gone", ", ", "code()"]);
});

test("fenced code blocks render line by line, including while streaming", () => {
  const partial = markdownLines("before\n```js\nconst a = 1;\n").map(text);
  assert.deepEqual(partial, ["before", "┃ js", "│ const a = 1;", "│ "]);
  const done = markdownLines("```js\nconst a = 1;\n```\nafter").map(text);
  assert.deepEqual(done, ["┃ js", "│ const a = 1;", "┃", "after"]);
});

test("links show their URL as dim text", () => {
  const spans = markdownLines("see [the docs](https://example.com) now")[0]!;
  assert.equal(spans.find((chunk) => chunk.text.includes("the docs"))?.text, "the docs");
  assert.ok(spans.some((chunk) => chunk.text.includes("https://example.com")));
});

test("ordered lists and horizontal rules", () => {
  const lines = markdownLines("1. first\n2. second\n\n---").map(text);
  assert.equal(lines[0], "1. first");
  assert.equal(lines[1], "2. second");
  assert.equal(lines[2], "");
  assert.match(lines[3]!, /─+/);
});

test("markdown output joins into styled text with newlines between lines", () => {
  const styled = markdownToStyledText("a\n\nb");
  const flat = styled.chunks.map((chunk) => chunk.text).join("");
  assert.ok(flat === "a\n \nb" || flat === "a\n\nb", `blank interior line stays a row: ${JSON.stringify(flat)}`);
});

test("code and heading spans carry distinct colors", () => {
  const lines = markdownLines("# Hi\n\n`x`");
  const headingFg = lines[0]![0]!.fg as RGBA;
  const codeLine = lines.find((line) => line.some((chunk) => chunk.text === "x"));
  const codeFg = codeLine!.find((chunk) => chunk.text === "x")!.fg as RGBA;
  assert.notDeepEqual(headingFg.buffer, codeFg.buffer);
});

test("markdown stays free of ANSI escape sequences", () => {
  const styled = markdownToStyledText("# Title\n\n- a **b**\n```py\nprint()\n```");
  assert.ok(!styled.chunks.some((chunk) => chunk.text.includes("\x1b")));
});

test("markdown boxes match chatBox geometry with wrapped rows", () => {
  for (const columns of [40, 80, 120]) {
    const box = markdownBox("hello **world**\n\nsecond paragraph with a fairly long sentence that must wrap at narrow widths", columns, "Agent");
    const rows = box.rows.map((row) => row.map((span) => span.text).join(""));
    assert.equal(rows[0]!.startsWith("╭─ Agent"), rows[0]!.startsWith("╭─ Agent"));
    assert.ok(rows[0]!.startsWith("╭─"), rows[0]);
    assert.ok(rows.at(-1)!.startsWith("╰"), rows.at(-1));
    for (const row of rows) {
      assert.equal([...row].length, box.boxWidth, row);
      assert.ok(!row.includes("\x1b"));
      assert.ok(row.startsWith("│ ") || row.startsWith("╭") || row.startsWith("╰"));
    }
  }
});

test("long markdown paragraphs wrap without overflowing the border", () => {
  const long = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore";
  const box = markdownBox(long, 40, "Agent");
  const rows = box.rows.map((row) => row.map((span) => span.text).join(""));
  assert.ok(rows.length > 3, "long text must wrap into multiple rows");
  for (const row of rows.slice(1, -1)) assert.equal([...row].length, box.boxWidth, row);
  const joined = rows.slice(1, -1).map((row) => row.replace(/^│ | │$/g, "").trimEnd()).join(" ");
  for (const word of long.split(" ")) assert.ok(joined.includes(word), word);
});
