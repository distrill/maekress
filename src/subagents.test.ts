import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { configureSubagents, subagentTool } from "./subagents.ts";
import type { ModelProvider, ProviderRequest } from "./providers/types.ts";

test("delegate gives a subagent only its handoff and read-only tools", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "maekress-subagent-"));
  await writeFile(path.join(root, "note.txt"), "hello\n");
  const requests: Array<{ tools: ProviderRequest["tools"]; messages: ProviderRequest["messages"] }> = [];
  const provider: ModelProvider = {
    id: "openrouter", label: "Test", defaultModel: "test",
    isConfigured: async () => true, listModels: async () => [],
    async stream(request) {
      requests.push({ tools: request.tools, messages: structuredClone(request.messages) });
      if (requests.length === 1) return { toolCalls: [{ id: "read", name: "read_file", arguments: '{"path":"note.txt"}' }] };
      request.onText("Found note.txt containing hello.");
      return { toolCalls: [] };
    },
  };
  configureSubagents({
    provider: () => provider, model: () => "test",
    tools: () => [
      { name: "agent_context", description: "", inputSchema: { type: "object" } },
      { name: "read_skill", description: "", inputSchema: { type: "object" } },
      { name: "list_files", description: "", inputSchema: { type: "object" } },
      { name: "read_file", description: "", inputSchema: { type: "object" } },
      { name: "grep", description: "", inputSchema: { type: "object" } },
      { name: "web_fetch", description: "", inputSchema: { type: "object" } },
      { name: "web_search", description: "", inputSchema: { type: "object" } },
    ],
    executeTool: async (name, input) => {
      assert.equal(name, "read_file");
      assert.deepEqual(input, { path: "note.txt" });
      return "1\thello\n[lines 1-1 of 1]";
    },
  });

  const result = await subagentTool.execute({ task: "Inspect the note.", context: "Only inspect note.txt." }, {
    projectRoot: root, confirm: async () => false,
  });

  assert.equal(result, "Found note.txt containing hello.");
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0]!.tools.map((tool) => tool.name), ["agent_context", "read_skill", "list_files", "read_file", "grep", "web_fetch", "web_search"]);
  assert.match(requests[0]!.messages[1]!.content, /Inspect the note/);
  assert.match(requests[1]!.messages.at(-1)!.content, /hello/);
});
