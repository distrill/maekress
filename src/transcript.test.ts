import { test } from "node:test";
import { strict as assert } from "node:assert";
import { chatBox, elapsed, glance, history, historyEntries, subagentGlance, toolGlance, ToolGlanceBatch } from "./transcript.ts";

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
  const longCommand = { id: "2", name: "cmd", arguments: JSON.stringify({ command: "rg 'class TextareaRenderable|class BoxRenderable|footerHeight' node_modules/@opentui/core/chunk-node-54dhb2fr.js" }) };
  assert.match(toolGlance(longCommand, "ok"), /^  · cmd: rg /);
  const delegate = { id: "3", name: "delegate", arguments: JSON.stringify({ task: "Inspect provider adapters." }) };
  assert.match(toolGlance(delegate, "ok"), /↳ subagent · Inspect provider adapters/);
  for (const columns of [20, 40, 80, 120]) {
    for (const summary of [toolGlance(longCommand, "ok", columns), glance("Approval required · Run potentially risky command: " + JSON.parse(longCommand.arguments).command, columns)]) {
      assert.equal(summary, plain(summary), "captured stdout must not contain ANSI escape codes");
      assert.equal(summary.split("\n").length, 2, "summary must be one line");
      assert.ok([...summary.trimEnd()].length < columns, summary);
    }
  }
});


test("tool durations sum across grouped calls and reset on flush", () => {
  const call = (id: string) => ({ id, name: "cmd", arguments: '{"command":"pwd"}' });
  const batch = new ToolGlanceBatch();
  batch.add(call("1"), "ok", 80, 1200);
  assert.match(batch.preview()!, /cmd: pwd · 1s/);
  batch.add(call("2"), "ok", 80, 2100);
  assert.match(batch.flush()!, /cmd: pwd ×2 · 3s/);
  batch.add(call("3"), "ok", 80, 61000);
  assert.match(batch.flush()!, /cmd: pwd · 1m01s/);
  assert.equal(elapsed(0), "0s");
});

test("cmd name appears in batches and restored history", () => {
  const command = (id: string) => ({ id, name: "cmd", arguments: '{"command":"pwd"}' });
  const batch = new ToolGlanceBatch();
  batch.add(command("1"), "ok");
  batch.add(command("2"), "ok");
  assert.equal(batch.label, "cmd: pwd");
  assert.equal(batch.flush(), "  · cmd: pwd ×2\n");
  assert.match(history([
    { role: "assistant", content: "", toolCalls: [command("1")] },
    { role: "tool", toolCallId: "1", content: "ok" },
  ]), /  · cmd: pwd\n/);
});

test("tool batches group consecutive matching targets and count failures", () => {
  const batch = new ToolGlanceBatch();
  const edit = (id: string, path: string) => ({ id, name: "edit_file", arguments: JSON.stringify({ path }) });
  assert.equal(batch.add(edit("1", "a.ts"), "ok"), undefined);
  assert.equal(batch.add(edit("2", "a.ts"), "Tool error: stale"), undefined);
  assert.equal(batch.count, 2);
  assert.equal(batch.label, "edit_file: a.ts");
  assert.equal(batch.preview(), "  · edit_file: a.ts ×2 (1 failed)\n");
  assert.equal(batch.add(edit("3", "b.ts"), "ok"), "  · edit_file: a.ts ×2 (1 failed)\n");
  assert.equal(batch.preview(), "  · edit_file: b.ts\n");
  assert.equal(batch.flush(), "  · edit_file: b.ts\n");
  assert.equal(batch.preview(), undefined);
  assert.equal(batch.flush(), undefined);
});

test("resume folds consecutive calls across model rounds but separates assistant text", () => {
  const call = (id: string, path: string) => ({ id, name: "edit_file", arguments: JSON.stringify({ path }) });
  const entries = historyEntries([
    { role: "user", content: "change files" },
    { role: "assistant", content: "", toolCalls: [call("1", "a.ts")] },
    { role: "tool", toolCallId: "1", content: "ok" },
    { role: "assistant", content: "", toolCalls: [call("2", "a.ts")] },
    { role: "tool", toolCallId: "2", content: "Tool error: stale" },
    { role: "assistant", content: "thinking" },
    { role: "assistant", content: "", toolCalls: [call("3", "a.ts")] },
    { role: "tool", toolCallId: "3", content: "ok" },
  ]);
  assert.deepEqual(entries.map(({ role }) => role), ["user", "tool", "assistant", "tool"]);
  assert.match(entries[1]!.text, /edit_file: a.ts ×2 \(1 failed\)/);
  assert.match(entries[3]!.text, /edit_file: a.ts/);
  assert.doesNotMatch(entries[3]!.text, /×/);
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
