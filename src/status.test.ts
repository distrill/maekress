import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { homedir, hostname, tmpdir, userInfo } from "node:os";
import { join, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { formatStatus, readGitStatus } from "./status.ts";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

test("Git footer shows cwd, clean state, branch, and counts files once", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gmkres-status-"));
  try {
    git(cwd, "init", "-q", "-b", "my-long-branch-name");
    git(cwd, "config", "user.name", "Test");
    git(cwd, "config", "user.email", "test@example.com");
    for (const name of ["edit", "delete", "rename"]) await writeFile(join(cwd, name), name);
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "initial");
    assert.equal(await readGitStatus(cwd), "✓ clean  ·  my-long-branch-name");
    await writeFile(join(cwd, "edit"), "modified");
    git(cwd, "rm", "-q", "delete");
    git(cwd, "mv", "rename", "renamed");
    await writeFile(join(cwd, "new file"), "new");
    assert.equal(await readGitStatus(cwd), "2' 1- 1+  ·  my-long-branch-name");
    const line = formatStatus({ cwd, provider: "Codex", model: "model", git: await readGitStatus(cwd) });
    const identity = `${userInfo().username}@${hostname()}`;
    assert.equal(line, `${identity}  ·  model | Codex  ·  ctx: 0%\n${cwd}  ·  2' 1- 1+  ·  my-long-branch-name`);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("main status shows model and context, defaulting to zero before usage arrives", () => {
  const state = { cwd: homedir(), provider: "OpenAI Codex", model: "gpt-5.5" };
  const prefix = `${userInfo().username}@${hostname()}  ·  gpt-5.5 | OpenAI Codex`;
  assert.equal(formatStatus(state), `${prefix}  ·  ctx: 0%`);
  assert.equal(formatStatus({ ...state, contextLimit: 1000 }), `${prefix}  ·  ctx: 0%`);
  assert.equal(formatStatus({ ...state, contextUsed: 100, contextLimit: 1000 }), `${prefix}  ·  ctx: 10%`);
  assert.equal(formatStatus({ ...state, contextUsed: 0, contextLimit: 1000 }), `${prefix}  ·  ctx: 0%`);
  assert.equal(formatStatus({ ...state, contextUsed: 100 }), prefix);
  assert.equal(formatStatus({ ...state, contextUsed: 100, contextLimit: 0 }), prefix);
});

test("Git footer abbreviates only paths inside home", () => {
  const home = homedir();
  const state = { cwd: home, provider: "Codex", model: "model", git: "✓ clean  ·  main" };
  const footer = (cwd: string) => formatStatus({ ...state, cwd }).split("\n")[1];
  assert.equal(footer(home), "~  ·  ✓ clean  ·  main");
  assert.equal(footer(join(home, "dev", "project")), `~${sep}dev${sep}project  ·  ✓ clean  ·  main`);
  assert.equal(footer(`${home}-other`), `${home}-other  ·  ✓ clean  ·  main`);
});
