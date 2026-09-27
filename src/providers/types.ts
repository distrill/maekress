import type { ToolDefinition } from "../tools.ts";

export type ToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export type MessageRole = "system" | "user" | "assistant" | "tool";

export type ModelMessage = {
  role: MessageRole;
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
};

export type ProviderRequest = {
  model: string;
  messages: ModelMessage[];
  tools: ToolDefinition[];
  signal: AbortSignal;
  onText: (text: string) => void;
};

// inputTokens is the size of this provider request (not cumulative session usage).
export type ProviderTurn = { toolCalls: ToolCall[]; inputTokens?: number };

export type ModelProvider = {
  id: "openai-codex" | "openrouter";
  label: string;
  defaultModel: string;
  isConfigured: () => Promise<boolean>;
  listModels: () => Promise<Array<{ id: string; name: string; contextLength?: number }>>;
  stream: (request: ProviderRequest) => Promise<ProviderTurn>;
};
