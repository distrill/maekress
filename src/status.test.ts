import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    assert.equal(await readGitStatus(cwd), "2m 1a 1d  ·  my-long-branch-name");
    const line = formatStatus({ cwd, provider: "Codex", model: "model", activity: "ready", git: await readGitStatus(cwd) });
    assert.equal(line, `model@codex  ·  ready\ncwd ${cwd}  ·  2m 1a 1d  ·  my-long-branch-name`);
    assert.equal(formatStatus({ cwd, provider: "Codex", model: "model", activity: "ready" }), "model@codex  ·  ready");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
