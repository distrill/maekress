import { strict as assert } from "node:assert";
import { test } from "node:test";
import { newSession, saveSession, loadSession } from "./sessions.ts";

test("session checkpoint and resume preserve messages and selection", async () => {
  const session = newSession(process.cwd(), "openai-codex", "example-model", "instructions");
  session.messages.push({ role: "user", content: "hello" });
  await saveSession(session);
  assert.deepEqual(await loadSession(session.id), session);
  session.model = "another-model";
  session.messages.push({ role: "assistant", content: "hi" });
  await saveSession(session);
  assert.deepEqual(await loadSession(session.id), session);
});

test("queued messages and todos persist across save and resume", async () => {
  const session = newSession(process.cwd(), "openai-codex", "example-model", "instructions");
  session.queue = [{ content: "first" }, { content: "second", images: [{ mimeType: "image/png", data: "aGk=" }] }];
  session.todos = [{ content: "implement todos", status: "in_progress" }];
  await saveSession(session);
  assert.deepEqual(await loadSession(session.id), session);
});

test("reject malformed and nonexistent resume IDs", async () => {
  await assert.rejects(loadSession("../auth.json"), /Invalid resume ID/);
  await assert.rejects(loadSession("0".repeat(32)), /No session found/);
});
