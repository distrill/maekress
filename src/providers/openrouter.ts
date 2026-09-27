import type { ModelProvider, ModelMessage, ToolCall } from "./types.ts";
import { providerError, readSseData } from "./sse.ts";
import { getApiKey } from "../auth.ts";

function openRouterMessage(message: ModelMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.toolCallId, name: message.name, content: message.content };
  }
  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

export const openRouterProvider: ModelProvider = {
  id: "openrouter",
  label: "OpenRouter",
  defaultModel: process.env.OPENROUTER_MODEL ?? "openai/gpt-4.1",
  isConfigured: async () => Boolean(await getApiKey("openrouter") ?? process.env.OPENROUTER_API_KEY),
  async listModels() {
    const response = await fetch("https://openrouter.ai/api/v1/models?sort=most-popular");
    if (!response.ok) throw await providerError(response);
    const payload = await response.json() as { data?: Array<{ id?: string; name?: string; context_length?: number }> };
    return (payload.data ?? []).flatMap((item) => typeof item.id === "string"
      ? [{ id: item.id, name: item.name ?? item.id, contextLength: item.context_length }]
      : []);
  },
  async stream({ model, messages, tools, signal, onText }) {
    const apiKey = await getApiKey("openrouter") ?? process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error("Sign in with /login openrouter_api_key before using OpenRouter.");
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost",
        "X-Title": "gmkres",
      },
      body: JSON.stringify({
        model,
        messages: messages.map(openRouterMessage),
        tools: tools.map((tool) => ({
          type: "function",
          function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
        })),
        tool_choice: "auto",
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal,
    });
    if (!response.ok) throw await providerError(response);
    const calls = new Map<number, ToolCall>();
    let inputTokens: number | undefined;
    for await (const data of readSseData(response, signal)) {
      const event = JSON.parse(data) as {
        choices?: Array<{ delta?: {
          content?: string | Array<{ text?: string }>;
          tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
        } }>;
        error?: { message?: string };
        usage?: { prompt_tokens?: number };
      };
      if (event.error?.message) throw new Error(event.error.message);
      if (typeof event.usage?.prompt_tokens === "number") inputTokens = event.usage.prompt_tokens;
      const content = event.choices?.[0]?.delta?.content;
      if (typeof content === "string") onText(content);
      else if (Array.isArray(content)) {
        for (const part of content) if (typeof part.text === "string") onText(part.text);
      }
      for (const delta of event.choices?.[0]?.delta?.tool_calls ?? []) {
        const index = delta.index ?? calls.size;
        const call = calls.get(index) ?? { id: delta.id ?? `call_${index}`, name: "", arguments: "" };
        if (delta.id) call.id = delta.id;
        if (typeof delta.function?.name === "string") call.name += delta.function.name;
        if (typeof delta.function?.arguments === "string") call.arguments += delta.function.arguments;
        calls.set(index, call);
      }
    }
    return { toolCalls: [...calls.values()], inputTokens };
  },
};
