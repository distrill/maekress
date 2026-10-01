import { exec } from "node:child_process";
import { promisify } from "node:util";
import { open, readdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { readSkill, resolveAgentContext } from "./agents.ts";

const execAsync = promisify(exec);

export type JsonSchema = {
  type: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
};

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
};

export type HarnessTool = ToolDefinition & {
  execute: (input: Record<string, unknown>, context: ToolContext) => Promise<string>;
};

export type ToolContext = {
  projectRoot: string;
  confirm: (message: string) => Promise<boolean>;
  signal?: AbortSignal;
};

const ignoredDirectories = new Set([".git", "node_modules", "dist", "build"]);
const outputLimit = 12_000;
const writeLimit = 1_000_000;

// A conservative prompt for obvious hazards, not a shell sandbox.
function sensitivePath(relativePath: string): boolean {
  const segments = relativePath.replaceAll("\\", "/").toLowerCase().split("/");
  return segments.some((part) => /^(\.env(?:\..*)?|\.git|\.ssh|\.config|auth\.json|credentials(?:\..*)?|id_(?:rsa|ed25519)(?:\..*)?)$/.test(part));
}

function riskyCommand(command: string): boolean {
  return /\b(?:sudo|su|chmod|chown|mkfs|dd|shutdown|reboot|curl|wget|scp|ssh|rsync|npm\s+publish|git\s+(?:push|reset|clean)|docker\s+(?:rm|system\s+prune)|rm\b|rmdir\b)\b/i.test(command)
    || /(?:^|\s)(?:\.\.\/|\/etc\/|\/home\/|~\/)/.test(command)
    || /(?:\|\s*(?:sh|bash|zsh)\b|>\s*\/|\b(?:OPENROUTER_API_KEY|TOKEN|PASSWORD|SECRET)\b)/i.test(command);
}

async function confirmSensitivePath(context: ToolContext, relativePath: string, action: string): Promise<boolean> {
  return !sensitivePath(relativePath) || context.confirm(`${action} sensitive path ${relativePath}?`);
}

function sha256(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

async function safeWriteTarget(root: string, relativePath: string): Promise<string> {
  const absoluteRoot = await realpath(root);
  const target = path.resolve(absoluteRoot, relativePath);
  if (target === absoluteRoot || !target.startsWith(`${absoluteRoot}${path.sep}`)) {
    throw new Error("Path must stay within the project directory.");
  }
  const parent = await realpath(path.dirname(target));
  if (!parent.startsWith(`${absoluteRoot}${path.sep}`) && parent !== absoluteRoot) {
    throw new Error("Path must stay within the project directory.");
  }
  const resolvedTarget = path.join(parent, path.basename(target));
  try {
    const existingTarget = await realpath(resolvedTarget);
    if (!existingTarget.startsWith(`${absoluteRoot}${path.sep}`)) throw new Error("Path must stay within the project directory.");
    return existingTarget;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return resolvedTarget;
  }
}

async function atomicReplace(target: string, contents: string, mode = 0o600): Promise<void> {
  const temporary = path.join(path.dirname(target), `.gmkres-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", mode);
    try {
      await handle.writeFile(contents, "utf8");
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function applyUnifiedPatch(contents: string, patch: string): string {
  const newline = contents.includes("\r\n") ? "\r\n" : "\n";
  const hadFinalNewline = contents.endsWith("\n");
  const source = contents.split(/\r?\n/);
  if (hadFinalNewline) source.pop();
  const patchLines = patch.split(/\r?\n/);
  if (patchLines.at(-1) === "") patchLines.pop();
  const hunks: Array<{ start: number; oldCount: number; newCount: number; lines: string[] }> = [];
  let active: (typeof hunks)[number] | undefined;
  for (const line of patchLines) {
    const header = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (header) {
      active = {
        start: Math.max(0, Number(header[1]) - 1),
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        newCount: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      hunks.push(active);
    } else if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      continue;
    } else if (line.startsWith("\\ No newline at end of file")) {
      continue;
    } else if (active && /^[ +\-]/.test(line)) {
      active.lines.push(line);
    } else if (line.trim()) {
      throw new Error("Patch must be a unified diff with valid hunk headers.");
    }
  }
  if (!hunks.length) throw new Error("Patch contains no unified diff hunks.");
  for (const hunk of hunks) {
    const oldCount = hunk.lines.filter((line) => line[0] !== "+").length;
    const newCount = hunk.lines.filter((line) => line[0] !== "-").length;
    if (oldCount !== hunk.oldCount || newCount !== hunk.newCount) throw new Error("Patch hunk line counts do not match its header.");
  }

  let offset = 0;
  for (const hunk of hunks) {
    const oldLines = hunk.lines.filter((line) => line[0] !== "+").map((line) => line.slice(1));
    const newLines = hunk.lines.filter((line) => line[0] !== "-").map((line) => line.slice(1));
    let position = hunk.start + offset;
    const matchesAt = (start: number) => oldLines.every((line, index) => source[start + index] === line);
    if (!matchesAt(position)) {
      const candidates = source.flatMap((_, index) => matchesAt(index) ? [index] : []);
      if (candidates.length !== 1) throw new Error(candidates.length ? "Patch context is ambiguous; include more context." : "Patch context did not match the current file.");
      position = candidates[0]!;
    }
    source.splice(position, oldLines.length, ...newLines);
    offset += newLines.length - oldLines.length;
  }
  const result = source.join(newline);
  return hadFinalNewline ? `${result}${newline}` : result;
}

const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
};

function linesForDiff(contents: string): string[] {
  if (!contents) return [];
  const lines = contents.split(/\r?\n/);
  if (contents.endsWith("\n")) lines.pop();
  return lines;
}

function formatCount(count: number, color: string, sign: string): string {
  return count ? `${color}${sign}${count}${ansi.reset}` : `${ansi.dim}${sign}0${ansi.reset}`;
}

function hunkRange(start: number, count: number): string {
  if (count === 0) return `${start},0`;
  return count === 1 ? `${start}` : `${start},${count}`;
}

function prettyDiff(relativePath: string, before: string, after: string): string {
  if (before === after) return "";

  const oldLines = linesForDiff(before);
  const newLines = linesForDiff(after);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix
    && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix += 1;

  const context = 3;
  const oldChangeEnd = oldLines.length - suffix;
  const newChangeEnd = newLines.length - suffix;
  const oldContextStart = Math.max(0, prefix - context);
  const oldContextEnd = Math.min(oldLines.length, oldChangeEnd + context);

  const beforeContext = oldLines.slice(oldContextStart, prefix);
  const removed = oldLines.slice(prefix, oldChangeEnd);
  const added = newLines.slice(prefix, newChangeEnd);
  const afterContext = oldLines.slice(oldChangeEnd, oldContextEnd);

  const oldCount = beforeContext.length + removed.length + afterContext.length;
  const newCount = beforeContext.length + added.length + afterContext.length;
  const oldStart = oldCount === 0 ? 0 : oldContextStart + 1;
  const newStart = newCount === 0 ? 0 : oldContextStart + 1;

  const output = [
    `${ansi.bold}✦ ${relativePath}${ansi.reset} · ${formatCount(added.length, ansi.green, "+")} ${formatCount(removed.length, ansi.red, "-")}`,
    `${ansi.dim}${"─".repeat(Math.min(80, Math.max(24, relativePath.length + 16)))}${ansi.reset}`,
    `${ansi.cyan}@@ -${hunkRange(oldStart, oldCount)} +${hunkRange(newStart, newCount)} @@${ansi.reset}`,
    ...beforeContext.map((line) => `${ansi.dim}  ${line}${ansi.reset}`),
    ...removed.map((line) => `${ansi.red}- ${line}${ansi.reset}`),
    ...added.map((line) => `${ansi.green}+ ${line}${ansi.reset}`),
    ...afterContext.map((line) => `${ansi.dim}  ${line}${ansi.reset}`),
  ];

  const formatted = output.join("\n");
  if (formatted.length <= outputLimit) return formatted;
  return `${formatted.slice(0, outputLimit - 80)}\n${ansi.dim}… diff truncated to ${outputLimit} characters${ansi.reset}`;
}

function stringInput(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string") throw new Error(`Expected '${key}' to be a string.`);
  return value;
}

async function projectPath(root: string, relativePath: string): Promise<string> {
  const absoluteRoot = await realpath(root);
  const candidate = path.resolve(absoluteRoot, relativePath || ".");
  if (candidate !== absoluteRoot && !candidate.startsWith(`${absoluteRoot}${path.sep}`)) {
    throw new Error("Path must stay within the project directory.");
  }

  try {
    const resolved = await realpath(candidate);
    if (resolved !== absoluteRoot && !resolved.startsWith(`${absoluteRoot}${path.sep}`)) {
      throw new Error("Path must stay within the project directory.");
    }
    return resolved;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return candidate;
    throw error;
  }
}

async function collectFiles(directory: string, relative = ""): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const childRelative = path.join(relative, entry.name);
    const childAbsolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(childAbsolute, childRelative));
    else if (entry.isFile()) files.push(childRelative);
    if (files.length >= 500) return files.slice(0, 500);
  }
  return files;
}

const builtinTools: HarnessTool[] = [
  {
    name: "agent_context",
    description: "Get applicable maekress agent instructions and available skills for a project path. Resolve this before changing files.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Target file or directory relative to the project root; defaults to the root." } },
      additionalProperties: false,
    },
    async execute(input, context) {
      const target = typeof input.path === "string" ? input.path : ".";
      const resolved = await resolveAgentContext(context.projectRoot, target);
      const instructions = resolved.instructions.length
        ? resolved.instructions.map((file) => `--- ${file.path} ---\n${file.content}`).join("\n\n")
        : "(no applicable agent guidance)";
      const skills = resolved.skills.length ? resolved.skills.map((skill) => `- ${skill}`).join("\n") : "(no skills found)";
      return `Applicable agent guidance (broadest to most specific):\n${instructions}\n\nAvailable skills:\n${skills}`;
    },
  },
  {
    name: "read_skill",
    description: "Read a skill listed by agent_context.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Exact skill path returned by agent_context." } },
      required: ["path"],
      additionalProperties: false,
    },
    async execute(input, context) {
      return readSkill(context.projectRoot, stringInput(input, "path"));
    },
  },
  {
    name: "list_files",
    description: "List project files under a directory, excluding common generated folders.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Directory relative to the project root; defaults to the root." } },
      additionalProperties: false,
    },
    async execute(input, context) {
      const target = await projectPath(context.projectRoot, typeof input.path === "string" ? input.path : ".");
      const entries = await collectFiles(target);
      return entries.length ? entries.join("\n") : "No files found.";
    },
  },
  {
    name: "read_file",
    description: "Read a UTF-8 text file inside the project. Large files can be read in chunks with offset and limit (character positions).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the project root." },
        offset: { type: "integer", description: "Character offset to start reading; defaults to 0." },
        limit: { type: "integer", description: `Maximum characters to return; defaults to ${outputLimit}.` },
      },
      required: ["path"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const target = await projectPath(context.projectRoot, stringInput(input, "path"));
      const fileStats = await stat(target);
      if (!fileStats.isFile()) throw new Error("Path is not a file.");
      const offset = input.offset === undefined ? 0 : input.offset;
      const limit = input.limit === undefined ? outputLimit : input.limit;
      if (!Number.isSafeInteger(offset) || (offset as number) < 0) throw new Error("offset must be a nonnegative integer.");
      if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > outputLimit) throw new Error(`limit must be between 1 and ${outputLimit}.`);
      const contents = await readFile(target, "utf8");
      const chunk = contents.slice(offset as number, (offset as number) + (limit as number));
      return `${chunk}\n[characters ${offset}-${(offset as number) + chunk.length} of ${contents.length}]`;
    },
  },
  {
    name: "search_text",
    description: "Search project text files for a literal, case-insensitive string.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to search for." },
        path: { type: "string", description: "Directory to search, relative to the project root; defaults to the root." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const query = stringInput(input, "query").toLocaleLowerCase();
      if (!query) throw new Error("Search query cannot be empty.");
      const start = await projectPath(context.projectRoot, typeof input.path === "string" ? input.path : ".");
      const files = await collectFiles(start);
      const matches: string[] = [];
      for (const relative of files) {
        const target = path.join(start, relative);
        try {
          const fileStats = await stat(target);
          if (fileStats.size > outputLimit) continue;
          const contents = await readFile(target, "utf8");
          contents.split(/\r?\n/).forEach((line, index) => {
            if (line.toLocaleLowerCase().includes(query)) {
              matches.push(`${path.relative(context.projectRoot, target)}:${index + 1}: ${line}`);
            }
          });
        } catch {
          continue;
        }
        if (matches.join("\n").length > outputLimit) break;
      }
      return matches.length ? matches.join("\n").slice(0, outputLimit) : "No matches found.";
    },
  },
  {
    name: "create_file",
    description: "Create a new UTF-8 text file inside the project. Sensitive paths require approval. Existing files are never overwritten.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "New file path relative to the project root; parent directory must exist." },
        content: { type: "string", description: `UTF-8 file contents, up to ${writeLimit} bytes.` },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const relativePath = stringInput(input, "path");
      const content = stringInput(input, "content");
      if (Buffer.byteLength(content, "utf8") > writeLimit) throw new Error(`File exceeds ${writeLimit} bytes.`);
      const target = await safeWriteTarget(context.projectRoot, relativePath);
      const displayPath = path.relative(context.projectRoot, target);
      if (!await confirmSensitivePath(context, displayPath, "Create")) return "File creation declined by user.";
      let handle;
      try {
        handle = await open(target, "wx", 0o644);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("File already exists; create_file never overwrites files.");
        throw error;
      }
      try {
        await handle.writeFile(content, "utf8");
      } catch (error) {
        await unlink(target).catch(() => undefined);
        throw error;
      } finally {
        await handle.close();
      }
      return `Created ${displayPath} (sha256 ${sha256(content)}).\n\n${prettyDiff(displayPath, "", content)}`;
    },
  },
  {
    name: "apply_patch",
    description: "Apply a unified diff to one project file. Sensitive paths require approval. Optionally provide the SHA-256 of the version you read to reject stale edits.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the project root." },
        patch: { type: "string", description: "Unified diff containing one or more hunks for this file." },
        expected_sha256: { type: "string", description: "Optional SHA-256 of the current file contents." },
      },
      required: ["path", "patch"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const relativePath = stringInput(input, "path");
      const patchText = stringInput(input, "patch");
      const expectedHash = input.expected_sha256;
      if (expectedHash !== undefined && typeof expectedHash !== "string") throw new Error("expected_sha256 must be a string.");
      if (Buffer.byteLength(patchText, "utf8") > writeLimit) throw new Error(`Patch exceeds ${writeLimit} bytes.`);
      const target = await safeWriteTarget(context.projectRoot, relativePath);
      const original = await readFile(target, "utf8");
      const currentHash = sha256(original);
      if (expectedHash !== undefined && expectedHash !== currentHash) throw new Error(`File changed since it was read (expected ${expectedHash}, found ${currentHash}).`);
      const updated = applyUnifiedPatch(original, patchText);
      if (Buffer.byteLength(updated, "utf8") > writeLimit) throw new Error(`Updated file exceeds ${writeLimit} bytes.`);
      const displayPath = path.relative(context.projectRoot, target);
      if (updated === original) return `No changes needed for ${displayPath}.`;
      if (!await confirmSensitivePath(context, displayPath, "Patch")) return "Patch declined by user.";
      const latest = await readFile(target, "utf8");
      if (sha256(latest) !== currentHash) throw new Error("File changed while awaiting approval; patch was not applied.");
      const fileStats = await stat(target);
      await atomicReplace(target, updated, fileStats.mode & 0o777);
      return `Updated ${displayPath} (sha256 ${sha256(updated)}).\n\n${prettyDiff(displayPath, original, updated)}`;
    },
  },
  {
    name: "edit_file",
    description: "Replace one exact text occurrence in a project file. Sensitive paths require approval.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the project root." },
        oldText: { type: "string", description: "Exact existing text to replace." },
        newText: { type: "string", description: "Replacement text." },
      },
      required: ["path", "oldText", "newText"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const target = await projectPath(context.projectRoot, stringInput(input, "path"));
      const oldText = stringInput(input, "oldText");
      const newText = stringInput(input, "newText");
      if (!oldText) throw new Error("oldText cannot be empty.");
      const contents = await readFile(target, "utf8");
      const firstMatch = contents.indexOf(oldText);
      if (firstMatch < 0) throw new Error("oldText was not found in the file.");
      if (contents.indexOf(oldText, firstMatch + oldText.length) >= 0) {
        throw new Error("oldText matched more than once; provide a more specific match.");
      }
      const displayPath = path.relative(context.projectRoot, target);
      if (!await confirmSensitivePath(context, displayPath, "Edit")) return "Edit declined by user.";
      if (await readFile(target, "utf8") !== contents) throw new Error("File changed while preparing edit; edit was not applied.");
      const updated = contents.slice(0, firstMatch) + newText + contents.slice(firstMatch + oldText.length);
      const fileStats = await stat(target);
      await atomicReplace(target, updated, fileStats.mode & 0o777);
      return `Updated ${displayPath}.\n\n${prettyDiff(displayPath, contents, updated)}`;
    },
  },
  {
    name: "web_fetch",
    description: "Fetch a URL and return its contents. HTML pages are converted to readable text; JSON and other formats are returned as-is.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to fetch (must start with http:// or https://)." },
      },
      required: ["url"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const url = stringInput(input, "url");
      if (!/^https?:\/\//i.test(url)) throw new Error("URL must start with http:// or https://.");
      const response = await fetch(url, {
        signal: context.signal,
        redirect: "follow",
        headers: { "User-Agent": "Mozilla/5.0 (compatible; maekress/0.1)", Accept: "text/html, application/json, text/plain, */*" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      const contentType = response.headers.get("content-type") ?? "";
      const body = (await response.text()).slice(0, outputLimit * 4);
      if (!/html/i.test(contentType)) return body.slice(0, outputLimit);
      // Strip HTML to readable text: remove scripts/styles, tags, decode common entities, collapse whitespace.
      const text = body
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<(br|hr|\/p|\/div|\/tr|\/li|\/h[1-6])\b[^>]*>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
        .replace(/[ \t]+/g, " ")
        .replace(/\n[ \t]+/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      return text.slice(0, outputLimit);
    },
  },
  {
    name: "web_search",
    description: "Search the web and return results with titles, URLs, and descriptions.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const query = stringInput(input, "query");
      if (!query.trim()) throw new Error("Search query cannot be empty.");
      // Exa MCP: free, keyless web search via JSON-RPC over SSE.
      const rpcBody = JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "web_search_exa", arguments: { query } },
      });
      const response = await fetch("https://mcp.exa.ai/mcp", {
        method: "POST", signal: context.signal,
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: rpcBody,
      });
      if (!response.ok) throw new Error(`Exa MCP returned ${response.status}: ${response.statusText}`);
      const sse = await response.text();
      // Parse SSE: find the data line containing the JSON-RPC result.
      for (const line of sse.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice("data:".length).trim();
        if (!payload) continue;
        try {
          const rpc = JSON.parse(payload) as { result?: { content?: Array<{ text?: string }> }; error?: { message?: string } };
          if (rpc.error) throw new Error(`Exa: ${rpc.error.message}`);
          if (rpc.result?.content?.length) {
            return rpc.result.content.map((c) => c.text ?? "").join("\n").slice(0, outputLimit);
          }
        } catch (error) {
          if (error instanceof SyntaxError) continue;
          throw error;
        }
      }
      return "No results found.";
    },
  },
  {
    name: "cmd",
    description: "Run a shell command in the project directory. Potentially risky commands require user approval.",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string", description: "Shell command to run." } },
      required: ["command"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const command = stringInput(input, "command");
      if (riskyCommand(command) && !await context.confirm(`Run potentially risky command: ${command}`)) return "Command declined by user.";
      context.signal?.throwIfAborted();
      const { stdout, stderr } = await execAsync(command, {
        cwd: context.projectRoot,
        timeout: 120_000,
        maxBuffer: outputLimit * 2,
        signal: context.signal,
      });
      return [stdout, stderr && `stderr:\n${stderr}`].filter(Boolean).join("\n").slice(0, outputLimit) || "Command completed with no output.";
    },
  },
];

const tools = new Map(builtinTools.map((tool) => [tool.name, tool]));

export function registerTool(tool: HarnessTool): void {
  if (tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
  tools.set(tool.name, tool);
}

export function getToolDefinitions(): ToolDefinition[] {
  return [...tools.values()].map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<string> {
  const tool = tools.get(name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return tool.execute(input, context);
}
