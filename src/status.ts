import { execFile } from "node:child_process";
import { homedir, hostname, userInfo } from "node:os";
import { sep } from "node:path";
import { promisify } from "node:util";

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
  contextUsed?: number;
  contextLimit?: number;
  git?: string;
};

// A module returns a short label or nothing. Add one here, then add its id to
// statusOrder to display it.
export type StatusModule = (state: StatusState) => string | undefined;
export const statusModules: Record<string, StatusModule> = {
  identity: () => `${userInfo().username}@${hostname()}`,
  cwd: (state) => displayCwd(state.cwd),
  git: (state) => state.git,
  model: (state) => `${state.model} | ${state.provider}`,
  // Before a provider reports usage, show zero; after that, use its observed input size.
  context: (state) => state.contextUsed === undefined
    ? "ctx: 0%"
    : state.contextLimit === undefined || state.contextLimit <= 0
      ? undefined : `ctx: ${Math.round(state.contextUsed / state.contextLimit * 100)}%`,
};

// Git gets its own line so long paths and branches don't crowd out the main status.
export const statusOrder = ["identity", "model", "context"];

export function formatStatus(state: StatusState): string {
  const main = statusOrder.map((id) => statusModules[id]?.(state)).filter(Boolean).join("  ·  ");
  return state.git ? `${main}\n${statusModules.cwd(state)}  ·  ${statusModules.git(state)}` : main;
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
    const symbols = { m: "'", d: "-", a: "+" };
    const summary = (Object.entries(counts) as Array<[keyof typeof counts, number]>)
      .filter(([, count]) => count > 0).map(([kind, count]) => `${count}${symbols[kind]}`).join(" ");
    return `${summary || "✓ clean"}  ·  ${branch}`;
  } catch {
    return undefined; // Outside a repository, unavailable git, or timed out.
  }
}
