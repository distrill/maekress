import { test } from "node:test";
import { strict as assert } from "node:assert";
import { chatBox, glance, history, historyEntries, toolGlance } from "./transcript.ts";

const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

test("boxes fit the captured stdout width with aligned corners and sides", () => {
  for (const columns of [20, 40, 80]) {
    for (const [role, text, label] of [
      ["user", "hey", undefined],
      ["assistant", "Hey! What are you working on?", "OpenAI Codex"],
      ["assistant", "hello\nworld\nverylongwordwithoutspaces", "Codex"],
    ] as const) {
      const box = chatBox(role, text, columns, label);
      assert.equal(box, plain(box), "captured stdout must not contain ANSI escape codes");
      const lines = box.trimEnd().split("\n").slice(1);
      const left = lines[0]!.indexOf("╭");
      const right = lines[0]!.indexOf("╮");
      assert.ok(right < columns);
      assert.ok(lines[0]!.includes("─"));
      for (const line of lines) {
        assert.ok([...line].length <= columns, line);
        assert.equal([...line].length, right + 1, line);
        assert.ok("╭│╰".includes(line[left]!));
        assert.ok("╮│╯".includes(line[right]!));
      }
    }
  }
});

test("tool details stay in one sanitized line, including failures", () => {
  const call = { id: "1", name: "edit_file", arguments: JSON.stringify({ path: "a.ts", content: "a\nb\nc" }) };
  assert.match(plain(toolGlance(call, "ok")), /edit_file: a.ts · 3 lines/);
  assert.match(plain(toolGlance(call, "Tool error: oops")), /failed/);
  assert.equal(plain(glance("hello\n\x1b[31mworld")), "  · hello world\n");
  const longCommand = { id: "2", name: "run_command", arguments: JSON.stringify({ command: "rg 'class TextareaRenderable|class BoxRenderable|footerHeight' node_modules/@opentui/core/chunk-node-54dhb2fr.js" }) };
  for (const columns of [20, 40, 80, 120]) {
    for (const summary of [toolGlance(longCommand, "ok", columns), glance("Approval required · Run potentially risky command: " + JSON.parse(longCommand.arguments).command, columns)]) {
      assert.equal(summary, plain(summary), "captured stdout must not contain ANSI escape codes");
      assert.equal(summary.split("\n").length, 2, "summary must be one line");
      assert.ok([...summary.trimEnd()].length < columns, summary);
    }
  }
});


test("resume reconstructs chat and tool glances without tool output", () => {
  const call = { id: "1", name: "read_file", arguments: '{"path":"secret.ts"}' };
  const transcript = plain(history([
    { role: "system", content: "prompt" }, { role: "user", content: "hi" },
    { role: "assistant", content: "checking", toolCalls: [call] },
    { role: "tool", toolCallId: "1", content: "lots of output" },
  ]));
  assert.match(transcript, /hi/);
  assert.match(transcript, /checking/);
  assert.match(transcript, /read_file: secret.ts/);
  assert.doesNotMatch(transcript, /lots of output|prompt/);
  const entries = historyEntries([
    { role: "user", content: "hi" },
    { role: "assistant", content: "checking", toolCalls: [call] },
    { role: "tool", toolCallId: "1", content: "lots of output" },
  ]);
  assert.deepEqual(entries.map((entry) => entry.role), ["user", "assistant", "tool"]);
  assert.equal(entries.map((entry) => entry.text).join(""), history([
    { role: "user", content: "hi" },
    { role: "assistant", content: "checking", toolCalls: [call] },
    { role: "tool", toolCallId: "1", content: "lots of output" },
  ]));
});
