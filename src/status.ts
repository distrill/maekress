import { execFile } from "node:child_process";
import { homedir, hostname } from "node:os";
import { sep } from "node:path";
import { promisify } from "node:util";
import { take, width } from "./text-width.ts";

const execFileAsync = promisify(execFile);
const home = homedir();

function displayCwd(cwd: string): string {
  return home && (cwd === home || cwd.startsWith(home.endsWith(sep) ? home : home + sep))
    ? `~${cwd.slice(home.length)}` : cwd;
}

export type StatusState = {
  cwd: string;
  provider: string;
  model: string;
  user?: string;
  contextUsed?: number;
  contextLimit?: number;
  git?: string;
};

export type ContextWarning = 0 | 85 | 90 | 95;

export function contextWarning(state: StatusState): ContextWarning {
  if (state.contextUsed === undefined || state.contextLimit === undefined || state.contextLimit <= 0) return 0;
  const percent = state.contextUsed / state.contextLimit * 100;
  return percent >= 95 ? 95 : percent >= 90 ? 90 : percent >= 85 ? 85 : 0;
}

// A module returns a short label or nothing. Add one here, then add its id to
// statusOrder to display it.
export type StatusModule = (state: StatusState) => string | undefined;
export const statusModules: Record<string, StatusModule> = {
  identity: (state) => [state.user, hostname()].filter(Boolean).join("@"),
  cwd: (state) => displayCwd(state.cwd),
  git: (state) => state.git,
  model: (state) => state.model,
  // Before a provider reports usage, show zero; after that, use its observed input size.
  context: (state) => state.contextUsed === undefined
    ? "ctx: 0%"
    : state.contextLimit === undefined || state.contextLimit <= 0
      ? undefined : `ctx: ${Math.round(state.contextUsed / state.contextLimit * 100)}%`,
};

// Git gets its own line so long paths and branches don't crowd out the main status.
export const statusOrder = ["identity", "model", "context"];

function clipped(text: string, max: number): string {
  if (max <= 0) return "";
  if (width(text) <= max) return text;
  const [prefix] = take(text, Math.max(0, max - 1));
  return `${prefix}…`;
}

function alignStatus(left: string | undefined, center: string | undefined, right: string | undefined, columns?: number): string {
  const parts = [left, center, right].filter((part): part is string => Boolean(part));
  if (!parts.length) return "";
  if (columns === undefined || columns <= 0) return parts.join("  ·  ");

  const compact = parts.join(" · ");
  if (width(compact) > columns) return clipped(compact, columns);

  const row = Array.from({ length: columns }, () => " ");
  const place = (text: string | undefined, start: number): boolean => {
    if (!text) return true;
    const textWidth = width(text);
    if (start < 0 || start + textWidth > columns) return false;
    for (let index = 0; index < textWidth; index++) if (row[start + index] !== " ") return false;
    let offset = 0;
    for (const char of text) row[start + offset++] = char;
    return true;
  };

  const leftOk = place(left, 0);
  const rightTextWidth = right ? width(right) : 0;
  const rightOk = place(right, columns - rightTextWidth);
  const centerTextWidth = center ? width(center) : 0;
  const centerOk = place(center, Math.max(0, Math.floor((columns - centerTextWidth) / 2)));
  return leftOk && centerOk && rightOk ? row.join("").trimEnd() : compact + " ".repeat(columns - width(compact));
}

function splitGit(git: string | undefined): [string | undefined, string | undefined] {
  if (!git) return [undefined, undefined];
  const separator = git.lastIndexOf("  ·  ");
  return separator < 0 ? [git, undefined] : [git.slice(0, separator), git.slice(separator + 5)];
}

export function formatStatus(state: StatusState, columns?: number): string {
  const modelContext = [statusModules.model(state), statusModules.context(state)].filter(Boolean).join(" · ");
  const main = alignStatus(statusModules.identity(state), undefined, modelContext, columns);
  const [gitSummary, gitBranch] = splitGit(statusModules.git(state));
  const gitRight = [gitSummary, gitBranch].filter(Boolean).join(" · ");
  const lines = [main];
  if (state.git) lines.push(alignStatus(statusModules.cwd(state), undefined, gitRight, columns));
  return lines.join("\n");
}

export async function readGitStatus(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1", "-b", "-z", "--untracked-files=all"], {
      cwd, timeout: 2000, maxBuffer: 4_000_000,
    });
    const separator = stdout.indexOf("\0");
    if (separator < 0) return undefined;
    const header = stdout.slice(0, separator);
    const changes = stdout.slice(separator + 1).split("\0");
    if (!header.startsWith("## ")) return undefined;
    const branch = header.slice(3).split("...")[0]!
      .replace(/^(No commits yet on |Initial commit on )/, "");
    const counts = { m: 0, d: 0, a: 0 };
    for (let i = 0; i < changes.length; i++) {
      const entry = changes[i]!;
      if (!entry) continue;
      const xy = entry.slice(0, 2);
      if (xy.includes("D")) counts.d++;
      else if (xy === "??" || xy.includes("A")) counts.a++;
      else counts.m++; // Modified, renamed, copied, conflicted, or type-changed.
      // In -z output, renames and copies have a second NUL-delimited path.
      if (xy.includes("R") || xy.includes("C")) i++;
    }
    const symbols = { m: "~", d: "-", a: "+" };
    const summary = (Object.entries(counts) as Array<[keyof typeof counts, number]>)
      .filter(([, count]) => count > 0).map(([kind, count]) => `${count}${symbols[kind]}`).join(" ");
    return `${summary || "✓ clean"}  ·  ${branch}`;
  } catch {
    return undefined; // Outside a repository, unavailable git, or timed out.
  }
}
