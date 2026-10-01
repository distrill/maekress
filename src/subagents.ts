import type { ModelMessage, ModelProvider, ToolCall } from "./providers/types.ts";
import type { HarnessTool, ToolContext, ToolDefinition } from "./tools.ts";

const maxTaskLength = 12_000;
const maxContextLength = 12_000;
const maxResultLength = 24_000;
const maxToolRounds = 12;
const readOnlyToolNames = new Set(["agent_context", "read_skill", "list_files", "read_file", "grep", "web_fetch", "web_search"]);

type SubagentConfiguration = {
  provider: () => ModelProvider;
  model: () => string;
  tools: () => ToolDefinition[];
  executeTool: (name: string, input: Record<string, unknown>, context: ToolContext) => Promise<string>;
};

let configuration: SubagentConfiguration | undefined;

export function configureSubagents(next: SubagentConfiguration): void {
  configuration = next;
}

function stringInput(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string") throw new Error(`Expected '${key}' to be a string.`);
  return value;
}

function parseCall(call: ToolCall): Record<string, unknown> {
  const input = JSON.parse(call.arguments) as unknown;
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("Tool arguments must be a JSON object.");
  return input as Record<string, unknown>;
}

export const subagentTool: HarnessTool = {
  name: "delegate",
  description: "Delegate a self-contained research, inspection, or analysis task to an isolated read-only subagent. It receives only this task and optional handoff context, not the main conversation. It cannot edit files, run commands, or delegate further. Returns a concise report.",
  inputSchema: {
    type: "object",
    properties: {
      task: { type: "string", description: "A self-contained task with a concrete question or deliverable." },
      context: { type: "string", description: "Optional minimal facts, paths, or constraints the subagent needs; do not paste the whole conversation." },
    },
    required: ["task"],
    additionalProperties: false,
  },
  async execute(input, context) {
    if (!configuration) throw new Error("Subagents have not been configured.");
    const task = stringInput(input, "task").trim();
    const handoff = typeof input.context === "string" ? input.context.trim() : "";
    if (!task) throw new Error("task cannot be empty.");
    if (task.length > maxTaskLength) throw new Error(`task exceeds ${maxTaskLength} characters.`);
    if (handoff.length > maxContextLength) throw new Error(`context exceeds ${maxContextLength} characters.`);

    const tools = configuration.tools().filter((tool) => readOnlyToolNames.has(tool.name));
    const messages: ModelMessage[] = [{
      role: "system" as const,
      content: `You are an isolated subagent. Complete the assigned task using the available read-only tools when useful. You have no access to the parent conversation, cannot modify files or run commands, and must not attempt to delegate work. Inspect before drawing conclusions. Return a concise report with findings, relevant paths, and recommended next steps; do not address the user directly.`,
    }, {
      role: "user" as const,
      content: handoff ? `Task:\n${task}\n\nMinimal handoff context:\n${handoff}` : `Task:\n${task}`,
    }];
    const report: string[] = [];
    for (let round = 0; round < maxToolRounds; round++) {
      context.signal?.throwIfAborted();
      const turn = await configuration.provider().stream({
        model: configuration.model(), messages, tools, signal: context.signal ?? new AbortController().signal,
        onText: (text) => report.push(text),
      });
      messages.push({ role: "assistant", content: "", toolCalls: turn.toolCalls });
      if (!turn.toolCalls.length) {
        const result = report.join("").trim();
        return result ? result.slice(0, maxResultLength) : "Subagent completed without a report.";
      }
      for (const call of turn.toolCalls) {
        let result: string;
        try {
          if (!readOnlyToolNames.has(call.name)) throw new Error(`Subagents may only use read-only tools; '${call.name}' is unavailable.`);
          result = await configuration.executeTool(call.name, parseCall(call), context);
        } catch (error) {
          result = `Tool error: ${error instanceof Error ? error.message : String(error)}`;
        }
        messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: result });
      }
    }
    return `${report.join("").trim()}\n\n[Subagent stopped after ${maxToolRounds} tool rounds.]`.trim().slice(0, maxResultLength);
  },
};
