import { getMcpOAuthCredential } from "./auth.ts";
import { registerTool, type JsonSchema, type ToolContext } from "./tools.ts";
import type { McpServerPreference } from "./preferences.ts";

const protocolVersion = "2025-06-18";

type RpcError = { code?: number; message?: string; data?: unknown };
type RpcResponse<T> = { result?: T; error?: RpcError };
type McpContent = { type?: string; text?: string; [key: string]: unknown };
type McpTool = { name: string; description?: string; inputSchema?: JsonSchema };

export type McpServerConfig = McpServerPreference & { name: string };

type McpClient = {
  serverName: string;
  url: string;
  accessToken: () => Promise<string | undefined>;
  nextId: number;
};

export function normalizeMcpServerName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
}

function parseRpcResponse<T>(contentType: string, body: string): RpcResponse<T> {
  if (contentType.includes("text/event-stream")) {
    for (const line of body.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice("data:".length).trim();
      if (!payload) continue;
      return JSON.parse(payload) as RpcResponse<T>;
    }
    throw new Error("MCP server returned an empty event stream.");
  }
  return JSON.parse(body) as RpcResponse<T>;
}

async function rpc<T>(client: McpClient, method: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const token = await client.accessToken();
  if (!token) throw new Error(`${client.serverName} MCP is not signed in. Use /mcp add ${client.serverName} <url> first.`);
  const body = JSON.stringify({ jsonrpc: "2.0", id: client.nextId++, method, ...(params ? { params } : {}) });
  const response = await fetch(client.url, {
    method: "POST",
    signal,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "MCP-Protocol-Version": protocolVersion,
    },
    body,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${client.serverName} MCP ${method} failed: HTTP ${response.status}${text ? `: ${text.slice(0, 300)}` : ""}`);
  const rpcResponse = parseRpcResponse<T>(response.headers.get("content-type") ?? "", text);
  if (rpcResponse.error) throw new Error(`${client.serverName} MCP ${method} failed: ${rpcResponse.error.message ?? "JSON-RPC error"}`);
  if (rpcResponse.result === undefined) throw new Error(`${client.serverName} MCP ${method} returned no result.`);
  return rpcResponse.result;
}

async function notifyInitialized(client: McpClient, signal?: AbortSignal): Promise<void> {
  const token = await client.accessToken();
  if (!token) return;
  await fetch(client.url, {
    method: "POST",
    signal,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "MCP-Protocol-Version": protocolVersion,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
  }).catch(() => undefined);
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part: McpContent) => {
      if (part.type === "text" && typeof part.text === "string") return part.text;
      return JSON.stringify(part);
    }).join("\n");
  }
  return JSON.stringify(content, null, 2);
}

export async function registerMcpServerTools(config: McpServerConfig, signal?: AbortSignal): Promise<number> {
  const name = normalizeMcpServerName(config.name);
  if (!name) throw new Error("MCP server name cannot be empty.");
  const credential = await getMcpOAuthCredential(name);
  if (!credential) return 0;
  const client: McpClient = {
    serverName: name,
    url: config.url,
    accessToken: async () => (await getMcpOAuthCredential(name))?.accessToken,
    nextId: 1,
  };
  await rpc(client, "initialize", {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: "maekress", version: "0.1.0" },
  }, signal);
  await notifyInitialized(client, signal);
  const listed = await rpc<{ tools?: McpTool[] }>(client, "tools/list", undefined, signal);
  let count = 0;
  for (const tool of listed.tools ?? []) {
    if (!tool.name || !tool.inputSchema) continue;
    const localName = `${name}__${tool.name.replace(/[^A-Za-z0-9_-]/g, "_")}`;
    try {
      registerTool({
        name: localName,
        description: `[${name} MCP] ${tool.description ?? tool.name}`,
        inputSchema: tool.inputSchema,
        async execute(input: Record<string, unknown>, context: ToolContext): Promise<string> {
          if (!await context.confirm(`Call ${name} MCP tool ${tool.name}?`)) return `${name} MCP call declined by user.`;
          const result = await rpc<{ content?: unknown; isError?: boolean }>(client, "tools/call", { name: tool.name, arguments: input }, context.signal);
          const text = contentToText(result.content ?? result);
          return result.isError ? `${name} MCP tool error: ${text}` : text;
        },
      });
      count++;
    } catch (error) {
      if (!(error instanceof Error) || !/Tool already registered/.test(error.message)) throw error;
    }
  }
  return count;
}

export async function registerMcpServersTools(servers: Record<string, McpServerPreference> | undefined, signal?: AbortSignal): Promise<Array<{ name: string; count: number; error?: string }>> {
  const results: Array<{ name: string; count: number; error?: string }> = [];
  for (const [rawName, server] of Object.entries(servers ?? {})) {
    const name = normalizeMcpServerName(rawName);
    if (!name) continue;
    try {
      results.push({ name, count: await registerMcpServerTools({ name, ...server }, signal) });
    } catch (error) {
      results.push({ name, count: 0, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}
