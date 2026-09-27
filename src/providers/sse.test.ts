import { test } from "node:test";
import assert from "node:assert/strict";
import { readSseData, withStreamIdleTimeout } from "./sse.ts";

test("stalled provider stream times out with an actionable error", async () => {
  const response = new Response(new ReadableStream({ start() {} }));
  await assert.rejects(
    withStreamIdleTimeout(new AbortController().signal, async (signal, activity) => {
      for await (const data of readSseData(response, signal, activity)) void data;
    }, 20),
    /stalled.*without data/i,
  );
});

test("incoming bytes reset the stream idle timer", async () => {
  const response = new Response(new ReadableStream({
    async start(controller) {
      controller.enqueue(new TextEncoder().encode("data: first\n\n"));
      await new Promise((resolve) => setTimeout(resolve, 15));
      controller.enqueue(new TextEncoder().encode("data: second\n\n"));
      controller.close();
    },
  }));
  const events = await withStreamIdleTimeout(new AbortController().signal, async (signal, activity) => {
    const received: string[] = [];
    for await (const data of readSseData(response, signal, activity)) received.push(data);
    return received;
  }, 100);
  assert.deepEqual(events, ["first", "second"]);
});
