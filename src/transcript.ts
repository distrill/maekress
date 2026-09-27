import type { ModelMessage, ToolCall } from "./providers/types.ts";

// Transcript output goes to the captured stdout scrollback, not the footer renderer.
function clean(text: string): string {
  return text.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))|[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

function width(text: string): number {
  let count = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (/\p{Mark}/u.test(char) || code === 0x200d || code === 0xfe0f) continue;
    count += code >= 0x1100 && (code <= 0x115f || code >= 0x2329 && code <= 0x232a || code >= 0x2e80 && code <= 0xa4cf || code >= 0xac00 && code <= 0xd7a3 || code >= 0xf900 && code <= 0xfaff || code >= 0xfe10 && code <= 0xfe19 || code >= 0xfe30 && code <= 0xfe6f || code >= 0xff00 && code <= 0xff60 || code >= 0xffe0 && code <= 0xffe6 || code >= 0x1f300 && code <= 0x1faff) ? 2 : 1;
  }
  return count;
}

function take(text: string, max: number): [string, string] {
  let used = 0;
  let index = 0;
  for (const char of text) {
    const size = width(char);
    if (used + size > max) break;
    used += size;
    index += char.length;
  }
  return [text.slice(0, index), text.slice(index)];
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

export function chatBox(role: "user" | "assistant", text: string, columns = 80, label?: string): string {
  // Captured stdout is split at the terminal width by *character count* before
  // OpenTUI renders it. ANSI color sequences count toward that limit even though
  // they take no cells, so they truncate the right border. Keep box lines plain.
  const available = Math.max(4, columns - 1);
  const boxWidth = Math.min(available, Math.max(4, columns - 8));
  const inner = boxWidth - 4;
  const indent = role === "user" ? " ".repeat(Math.max(0, columns - boxWidth - 1)) : "";
  const title = clean(label ?? (role === "user" ? "You" : "Assistant")).replace(/\s+/g, " ").trim();
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

export function toolGlance(call: ToolCall, result?: string, columns = 80): string {
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(call.arguments); } catch { /* Invalid arguments are reported by the tool result. */ }
  const target = typeof args.path === "string" ? args.path : typeof args.query === "string" ? `“${args.query}”` :
    typeof args.command === "string" ? args.command : "";
  const payload = typeof args.content === "string" ? args.content : typeof args.patch === "string" ? args.patch :
    typeof args.newText === "string" ? args.newText : "";
  const count = payload ? ` · ${payload.split("\n").length} lines` : "";
  const error = result?.startsWith("Tool error:") ? " · failed" : "";
  return glance(`${call.name}${target ? `: ${target}` : ""}${count}${error}`, columns);
}

export function glance(text: string, columns = 80): string {
  // Captured stdout measures ANSI escape codes as characters before rendering.
  // Keep this plain, like chatBox, so truncation actually fits one row.
  const prefix = "  · ";
  return `${prefix}${short(text, Math.max(0, columns - 1 - prefix.length))}\n`;
}

export function history(messages: ModelMessage[], columns = 80): string {
  let output = "";
  for (const message of messages) {
    if (message.role === "user") output += chatBox("user", message.content, columns);
    if (message.role === "assistant") {
      if (message.content) output += chatBox("assistant", message.content, columns);
      for (const call of message.toolCalls ?? []) {
        const result = messages.find((item) => item.role === "tool" && item.toolCallId === call.id);
        output += toolGlance(call, result?.content, columns);
      }
    }
  }
  return output;
}
