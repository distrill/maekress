import type { ModelProvider, ModelMessage, ToolCall } from "./types.ts";
import { providerError, readSseData, withStreamIdleTimeout } from "./sse.ts";
import { getApiKey } from "../auth.ts";
import { imageParts } from "../images.ts";

export function anthropicMessage(message: ModelMessage): Record<string, unknown> {
  if (message.role === "system") return {};
  if (message.role === "tool") return { role: "user", content: [{ type: "tool_result", tool_use_id: message.toolCallId, content: message.content }] };
  const content: Array<Record<string, unknown>> = [];
  if (message.content) content.push({ type: "text", text: message.content });
  for (const part of message.images?.length ? imageParts(message) : []) {
    if (part.type === "text") content.push({ type: "text", text: part.text });
    else content.push({ type: "image", source: { type: "base64", media_type: part.image.mimeType, data: part.image.data } });
  }
  for (const call of message.toolCalls ?? []) content.push({ type: "tool_use", id: call.id, name: call.name, input: JSON.parse(call.arguments || "{}") });
  return { role: message.role, content: content.length ? content : message.content };
}

export const anthropicProvider: ModelProvider = {
  id: "anthropic",
  label: "Anthropic",
  defaultModel: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-20250514",
  isConfigured: async () => Boolean(await getApiKey("anthropic") ?? process.env.ANTHROPIC_API_KEY),
  async listModels() { return [{ id: this.defaultModel, name: this.defaultModel }]; },
  async stream({ model, messages, tools, signal, onText }) {
    const apiKey = await getApiKey("anthropic") ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("Connect Anthropic with /provider add anthropic before using it.");
    const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
    return withStreamIdleTimeout(signal, async (streamSignal, activity) => {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: 16384, system, messages: messages.filter((message) => message.role !== "system").map(anthropicMessage), tools: tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })), stream: true }),
        signal: streamSignal,
      });
      if (!response.ok) throw await providerError(response);
      const calls = new Map<number, ToolCall>();
      let inputTokens: number | undefined;
      for await (const data of readSseData(response, streamSignal, activity)) {
        const event = JSON.parse(data) as { type?: string; index?: number; delta?: { type?: string; text?: string; partial_json?: string }; content_block?: { type?: string; id?: string; name?: string }; message?: { usage?: { input_tokens?: number } }; usage?: { input_tokens?: number } };
        if (event.type === "message_start" && typeof event.message?.usage?.input_tokens === "number") inputTokens = event.message.usage.input_tokens;
        if (event.type === "content_block_start" && event.content_block?.type === "tool_use") calls.set(event.index ?? calls.size, { id: event.content_block.id ?? `tool_${event.index}`, name: event.content_block.name ?? "", arguments: "" });
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && typeof event.delta.text === "string") onText(event.delta.text);
        if (event.type === "content_block_delta" && event.delta?.type === "input_json_delta") {
          const call = calls.get(event.index ?? -1);
          if (call && typeof event.delta.partial_json === "string") call.arguments += event.delta.partial_json;
        }
        if (event.type === "message_delta" && typeof event.usage?.input_tokens === "number") inputTokens = event.usage.input_tokens;
      }
      return { toolCalls: [...calls.values()], inputTokens };
    });
  },
};
