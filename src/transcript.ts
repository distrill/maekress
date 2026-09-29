import type { ModelMessage, ToolCall } from "./providers/types.ts";
import { imageLabel } from "./images.ts";
import { width, take } from "./text-width.ts";
import { markdownBox, type MarkdownBox } from "./markdown.ts";

// Transcript output goes to the captured stdout scrollback, not the footer renderer.
function clean(text: string): string {
  return text.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))|[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

function rows(text: string, max: number): string[] {
  const result: string[] = [];
  for (const line of clean(text).replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n")) {
    if (!line) { result.push(""); continue; }
    let remaining = line;
    while (width(remaining) > max) {
      const [chunk] = take(remaining, max);
      const breakAt = chunk.lastIndexOf(" ");
      if (breakAt > 0 && width(chunk) - width(chunk.slice(0, breakAt)) < max / 2) {
        result.push(chunk.slice(0, breakAt));
        remaining = remaining.slice(breakAt + 1);
      } else {
        result.push(chunk);
        remaining = remaining.slice(chunk.length);
      }
    }
    result.push(remaining);
  }
  return result;
}

// Display names are configurable; defaults keep "You" and "Agent" stable in tests.
export type DisplayNames = { user: string; agent: string };
const defaultNames: DisplayNames = { user: "You", agent: "Agent" };

export type ChatEntry = { role: "user" | "assistant" | "tool"; text: string; styled?: MarkdownBox };

// Borders stay neutral so role colors belong to text, not box geometry.
const assistantBorder = "#E5E9F0";

export function chatBox(role: "user" | "assistant", text: string, columns = 80, label?: string, names: DisplayNames = defaultNames): string {
  // Captured stdout is split at the terminal width by *character count* before
  // OpenTUI renders it. ANSI color sequences count toward that limit even though
  // they take no cells, so they truncate the right border. Keep box lines plain.
  const available = Math.max(4, columns - 1);
  const boxWidth = Math.min(available, Math.max(4, columns - 8));
  const inner = boxWidth - 4;
  const indent = role === "user" ? " ".repeat(Math.max(0, columns - boxWidth - 1)) : "";
  const title = clean(label ?? (role === "user" ? names.user : names.agent)).replace(/\s+/g, " ").trim();
  const heading = `─ ${take(title, Math.max(0, boxWidth - 5))[0]} `;
  let output = `\n${indent}╭${heading}${"─".repeat(Math.max(0, boxWidth - 2 - width(heading)))}╮\n`;
  for (const row of rows(text, inner)) {
    output += `${indent}│ ${row}${" ".repeat(Math.max(0, inner - width(row)))} │\n`;
  }
  return output + `${indent}╰${"─".repeat(boxWidth - 2)}╯\n`;
}

function short(text: string, max = 52): string {
  const flat = clean(text).replace(/\s+/g, " ").trim();
  if (width(flat) <= max) return flat;
  return take(flat, Math.max(0, max - 1))[0] + "…";
}

export function elapsed(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

export function toolGlance(call: ToolCall, result?: string, columns = 80, durationMs?: number): string {
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(call.arguments); } catch { /* Invalid arguments are reported by the tool result. */ }
  const payload = typeof args.content === "string" ? args.content : typeof args.patch === "string" ? args.patch :
    typeof args.newText === "string" ? args.newText : "";
  const count = payload ? ` · ${payload.split("\n").length} lines` : "";
  const error = result?.startsWith("Tool error:") ? " · failed" : "";
  return glance(`${toolTarget(call)}${count}${error}${durationMs === undefined ? "" : ` · ${elapsed(durationMs)}`}`, columns);
}

// Consecutive calls to the same tool/target share one scrollback line.
// Results remain separate in the session; only their presentation is folded.
export class ToolGlanceBatch {
  private first: ToolCall | undefined;
  private key = "";
  private result = "";
  private failures = 0;
  private total = 0;
  private durationMs: number | undefined;

  get count(): number { return this.total; }
  get label(): string { return this.key; }
  preview(columns = 80): string | undefined {
    if (!this.total) return undefined;
    return this.total === 1
      ? toolGlance(this.first!, this.result, columns, this.durationMs)
      : glance(`${this.key} ×${this.total}${this.failures ? ` (${this.failures} failed)` : ""}${this.durationMs === undefined ? "" : ` · ${elapsed(this.durationMs)}`}`, columns);
  }

  add(call: ToolCall, result: string, columns = 80, durationMs?: number): string | undefined {
    const key = toolTarget(call);
    const flushed = this.total && key !== this.key ? this.flush(columns) : undefined;
    if (!this.total) this.first = call;
    this.key = key;
    this.result = result;
    this.total++;
    if (durationMs !== undefined) this.durationMs = (this.durationMs ?? 0) + durationMs;
    if (result.startsWith("Tool error:")) this.failures++;
    return flushed;
  }

  flush(columns = 80): string | undefined {
    if (!this.total) return undefined;
    const text = this.preview(columns)!;
    this.first = undefined;
    this.key = "";
    this.result = "";
    this.durationMs = undefined;
    this.failures = this.total = 0;
    return text;
  }
}

export function toolTarget(call: ToolCall): string {
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(call.arguments); } catch { /* Invalid arguments still get a summary. */ }
  const target = typeof args.path === "string" ? args.path : typeof args.query === "string" ? `“${args.query}”` :
    typeof args.command === "string" ? args.command : "";
  return `${call.name}${target ? `: ${target}` : ""}`;
}

export function glance(text: string, columns = 80): string {
  // Captured stdout measures ANSI escape codes as characters before rendering.
  // Keep this plain, like chatBox, so truncation actually fits one row.
  const prefix = "  · ";
  return `${prefix}${short(text, Math.max(0, columns - 1 - prefix.length))}\n`;
}

export function historyEntries(messages: ModelMessage[], columns = 80, names: DisplayNames = defaultNames): ChatEntry[] {
  const entries: ChatEntry[] = [];
  const batch = new ToolGlanceBatch();
  const flush = () => {
    const text = batch.flush(columns);
    if (text) entries.push({ role: "tool", text });
  };
  for (const message of messages) {
    if (message.role === "user") {
      flush();
      entries.push({ role: "user", text: chatBox("user", imageLabel(message), columns, names.user, names) });
    }
    if (message.role === "assistant") {
      if (message.content) {
        flush();
        entries.push({ role: "assistant", text: chatBox("assistant", message.content, columns, names.agent, names), styled: markdownBox(message.content, columns, names.agent, assistantBorder) });
      }
      for (const call of message.toolCalls ?? []) {
        const result = messages.find((item) => item.role === "tool" && item.toolCallId === call.id);
        if (!result) continue;
        const text = batch.add(call, result.content, columns);
        if (text) entries.push({ role: "tool", text });
      }
    }
  }
  flush();
  return entries;
}

export function history(messages: ModelMessage[], columns = 80, names: DisplayNames = defaultNames): string {
  return historyEntries(messages, columns, names).map((entry) => entry.text).join("");
}
