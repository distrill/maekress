import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveAgentContext } from "./agents.ts";

test("resolveAgentContext reuses a recent result for the same directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "maekress-agents-"));
  const guidanceDirectory = path.join(root, ".maekress");
  await mkdir(guidanceDirectory);
  await writeFile(path.join(guidanceDirectory, "agents.md"), "first guidance\n");

  const first = await resolveAgentContext(root);
  await writeFile(path.join(guidanceDirectory, "agents.md"), "second guidance\n");
  const second = await resolveAgentContext(root);

  assert.deepEqual(second, first);
  assert.match(second.instructions.at(-1)?.content ?? "", /first guidance/);
});

test("resolveAgentContext caches file targets by their containing directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "maekress-agents-"));
  const guidanceDirectory = path.join(root, ".maekress");
  await mkdir(guidanceDirectory);
  await writeFile(path.join(guidanceDirectory, "agents.md"), "first guidance\n");
  await writeFile(path.join(root, "note.txt"), "note\n");

  const first = await resolveAgentContext(root, "note.txt");
  await writeFile(path.join(guidanceDirectory, "agents.md"), "second guidance\n");
  const second = await resolveAgentContext(root, ".");

  assert.deepEqual(second, first);
});
