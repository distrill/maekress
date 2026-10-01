import { test } from "node:test";
import { strict as assert } from "node:assert";
import { historyEntries, subagentGlance } from "./transcript.ts";

const delegate = { id: "delegate-1", name: "delegate", arguments: JSON.stringify({ task: "Inspect the provider adapters." }) };

test("subagent results are distinct transcript entries with direct inspect output", () => {
  assert.match(subagentGlance(delegate, 80, 1200, "003"), /\[003\] ↳ subagent · Inspect the provider adapters\. · report ready · 1s/);
  const inspectRecords = new Map();
  const entries = historyEntries([
    { role: "assistant" as const, content: "", toolCalls: [delegate] },
    { role: "tool" as const, toolCallId: "delegate-1", name: "delegate", content: "Found two adapters.\n\nRecommend shared retry handling." },
  ], 80, undefined, inspectRecords);
  assert.deepEqual(entries.map((entry) => entry.role), ["subagent"]);
  assert.match(entries[0]!.text, /↳ subagent.*Found two adapters\./);
  const record = [...inspectRecords.values()][0]!;
  assert.match(record.title, /^subagent · Inspect the provider adapters/);
  assert.equal(record.content, "Found two adapters.\n\nRecommend shared retry handling.");
});
