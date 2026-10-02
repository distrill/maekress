import { strict as assert } from "node:assert";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { executeTool } from "./tools.ts";

const context = (projectRoot: string) => ({ projectRoot, confirm: async () => true });

test("apply_patch accepts common wrapped patches with a context-only hunk header", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "maekress-tools-"));
  await writeFile(path.join(projectRoot, "note.txt"), "before\nold\nafter\n");

  await executeTool("apply_patch", {
    path: "note.txt",
    patch: "*** Begin Patch\n@@\n-old\n+new\n*** End Patch",
  }, context(projectRoot));

  assert.equal(await readFile(path.join(projectRoot, "note.txt"), "utf8"), "before\nnew\nafter\n");
});

test("apply_patch applies valid context when unified-diff line counts are inaccurate", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "maekress-tools-"));
  await writeFile(path.join(projectRoot, "note.txt"), "before\nold\nafter\n");

  await executeTool("apply_patch", {
    path: "note.txt",
    patch: "@@ -1,8 +1,12 @@\n before\n-old\n+new\n after",
  }, context(projectRoot));

  assert.equal(await readFile(path.join(projectRoot, "note.txt"), "utf8"), "before\nnew\nafter\n");
});
