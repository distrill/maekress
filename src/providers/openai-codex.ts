import { getCodexCredential } from "../auth.ts";
import type { ModelProvider, ModelMessage, ToolCall } from "./types.ts";
import { providerError, readSseData, withStreamIdleTimeout } from "./sse.ts";
import { imageParts } from "../images.ts";

const clientVersion = process.env.CODEX_CLIENT_VERSION ?? "0.156.1";

type CodexEvent = {
  type?: string;
  delta?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  item?: { type?: string; id?: string; call_id?: string; name?: string; arguments?: string };
  response?: {
    error?: { message?: string };
    output?: Array<{ type?: string; id?: string; call_id?: string; name?: string; arguments?: string }>;
    usage?: { input_tokens?: number };
  };
};

export function codexInputMessage(message: ModelMessage): Array<Record<string, unknown>> {
  if (message.role === "tool") {
    return [{ type: "function_call_output", call_id: message.toolCallId, output: message.content }];
  }
  const items: Array<Record<string, unknown>> = [];
  if (message.content || message.images?.length || !message.toolCalls?.length) {
    const content = message.images?.length ? imageParts(message).map((part) => part.type === "text"
      ? { type: "input_text", text: part.text }
      : { type: "input_image", image_url: `data:${part.image.mimeType};base64,${part.image.data}` }) : message.content;
    items.push({ role: message.role, content });
  }
  for (const call of message.toolCalls ?? []) {
    items.push({ type: "function_call", call_id: call.id, name: call.name, arguments: call.arguments });
  }
  return items;
}

function codexToolCall(item: { id?: string; call_id?: string; name?: string; arguments?: string }): ToolCall | undefined {
  if (typeof item.name !== "string" || typeof item.arguments !== "string") return undefined;
  return { id: item.call_id ?? item.id ?? `call_${item.name}`, name: item.name, arguments: item.arguments };
}

export const codexProvider: ModelProvider = {
  id: "openai-codex",
  label: "OpenAI Codex",
  defaultModel: process.env.CODEX_MODEL ?? "gpt-5.5",
  isConfigured: async () => Boolean(await getCodexCredential()),
  async listModels() {
    const credential = await getCodexCredential();
    if (!credential) return [{ id: this.defaultModel, name: this.defaultModel }];
    const response = await fetch(`https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(clientVersion)}`, {
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        "ChatGPT-Account-ID": credential.accountId,
        originator: "maekress",
        version: clientVersion,
        "User-Agent": `maekress/${clientVersion}`,
      },
    });
    if (!response.ok) throw await providerError(response);
    const payload = await response.json() as { models?: Array<{ slug?: string; display_name?: string; visibility?: string; priority?: number; supported_in_api?: boolean; context_window?: number }> };
    return (payload.models ?? [])
      .filter((item) => item.visibility !== "hide" && item.supported_in_api !== false && typeof item.slug === "string")
      .sort((left, right) => (left.priority ?? 1000) - (right.priority ?? 1000))
      .flatMap((item) => typeof item.slug === "string" ? [{ id: item.slug, name: item.display_name ?? item.slug, contextLength: item.context_window }] : []);
  },
  async stream({ model, messages, tools, signal, onText }) {
    const credential = await getCodexCredential();
    if (!credential) throw new Error("Sign in first with /login codex.");
    const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
    const input = messages.filter((message) => message.role !== "system").flatMap(codexInputMessage);
    return withStreamIdleTimeout(signal, async (streamSignal, activity) => {
    const response = await fetch("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        "ChatGPT-Account-ID": credential.accountId,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        originator: "maekress",
        version: clientVersion,
        "User-Agent": `maekress/${clientVersion}`,
      },
      body: JSON.stringify({
        model,
        store: false,
        stream: true,
        instructions: system || "You are a helpful assistant.",
        input,
        tools: tools.map((tool) => ({
          type: "function",
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
          strict: false,
        })),
        tool_choice: "auto",
        text: { verbosity: "low" },
      }),
      signal: streamSignal,
    });
    if (!response.ok) throw await providerError(response);
    const calls = new Map<string, ToolCall>();
    let inputTokens: number | undefined;
    for await (const data of readSseData(response, streamSignal, activity)) {
      const event = JSON.parse(data) as CodexEvent;
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") onText(event.delta);
      if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
        const call = codexToolCall(event.item);
        if (call) calls.set(call.id, call);
      }
      if (event.type === "response.function_call_arguments.done") {
        const call = codexToolCall(event);
        if (call) calls.set(call.id, call);
      }
      if (event.type === "response.completed") {
        if (typeof event.response?.usage?.input_tokens === "number") inputTokens = event.response.usage.input_tokens;
        for (const item of event.response?.output ?? []) {
          if (item.type !== "function_call") continue;
          const call = codexToolCall(item);
          if (call) calls.set(call.id, call);
        }
      }
      if (event.type === "response.failed" || event.type === "error") {
        throw new Error(event.response?.error?.message ?? "Codex request failed.");
      }
    }
    return { toolCalls: [...calls.values()], inputTokens };
    });
  },
};
