import { strict as assert } from "node:assert";
import { test } from "node:test";
import { imageAttachment, imageLabel, imageMarker } from "./images.ts";
import { codexInputMessage } from "./providers/openai-codex.ts";
import { openRouterMessage } from "./providers/openrouter.ts";
import { historyEntries } from "./transcript.ts";
import { loadSession, newSession, saveSession } from "./sessions.ts";

const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);

test("clipboard image becomes provider image input, not placeholder text", () => {
  const image = imageAttachment("image/png", png);
  const message = { role: "user" as const, content: "what is this?", images: [image] };
  assert.equal(imageLabel(message), "what is this?\n[image 01]");
  assert.deepEqual(codexInputMessage(message), [{ role: "user", content: [
    { type: "input_text", text: "what is this?" },
    { type: "input_image", image_url: `data:image/png;base64,${image.data}` },
  ] }]);
  assert.deepEqual(openRouterMessage(message), { role: "user", content: [
    { type: "text", text: "what is this?" },
    { type: "image_url", image_url: { url: `data:image/png;base64,${image.data}` } },
  ] });
  assert.match(historyEntries([message])[0]!.text, /\[image 01\]/);
  assert.doesNotMatch(historyEntries([message])[0]!.text, /base64/);
});

test("inline markers preserve paste order and positions in both providers and history", () => {
  const image = imageAttachment("image/png", png);
  const message = { role: "user" as const, content: `before ${imageMarker(0)} between ${imageMarker(1)} after`, images: [image, image] };
  assert.equal(imageLabel(message), message.content);
  assert.deepEqual(codexInputMessage(message)[0]!.content, [
    { type: "input_text", text: "before " },
    { type: "input_image", image_url: `data:image/png;base64,${image.data}` },
    { type: "input_text", text: " between " },
    { type: "input_image", image_url: `data:image/png;base64,${image.data}` },
    { type: "input_text", text: " after" },
  ]);
  assert.deepEqual(openRouterMessage(message).content, [
    { type: "text", text: "before " },
    { type: "image_url", image_url: { url: `data:image/png;base64,${image.data}` } },
    { type: "text", text: " between " },
    { type: "image_url", image_url: { url: `data:image/png;base64,${image.data}` } },
    { type: "text", text: " after" },
  ]);
  assert.match(historyEntries([message])[0]!.text, /before \[image 01\] between \[image 02\] after/);
});

test("image messages survive checkpoint and resume", async () => {
  const session = newSession(process.cwd(), "openai-codex", "test", "instructions");
  session.messages.push({ role: "user", content: "", images: [imageAttachment("image/png", png)] });
  await saveSession(session);
  assert.deepEqual((await loadSession(session.id)).messages, session.messages);
});

test("image bytes must match advertised format and respect size cap", () => {
  assert.throws(() => imageAttachment("image/jpeg", png), /do not match/);
  assert.throws(() => imageAttachment("image/gif", png), /Unsupported/);
  assert.throws(() => imageAttachment("image/png", new Uint8Array(0)), /between/);
});
