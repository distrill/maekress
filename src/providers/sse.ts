// Fail a stalled connection, but allow long responses as long as bytes keep arriving.
// This also covers waiting for the initial HTTP response.
export async function withStreamIdleTimeout<T>(
  signal: AbortSignal,
  run: (signal: AbortSignal, activity: () => void) => Promise<T>,
  idleMs = 120_000,
): Promise<T> {
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  let timer: ReturnType<typeof setTimeout>;
  const activity = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error(`Provider stream stalled for ${idleMs / 1000}s without data.`)), idleMs);
  };
  activity();
  try {
    return await run(combined, activity);
  } catch (error) {
    if (controller.signal.aborted && !signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function* readSseData(response: Response, signal: AbortSignal, activity: () => void = () => {}): AsyncGenerator<string> {
  if (!response.body) throw new Error("Provider returned an empty stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new Error("Request cancelled.");
      const { value, done } = await reader.read();
      if (signal.aborted) throw signal.reason;
      if (value?.length) activity();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
        if (data && data !== "[DONE]") yield data;
        boundary = buffer.indexOf("\n\n");
      }
      if (done) break;
    }
    if (buffer.trim()) {
      const data = buffer.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
      if (data && data !== "[DONE]") yield data;
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!signal.aborted) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function providerError(response: Response): Promise<Error> {
  const body = await response.text();
  let detail = body;
  try {
    const parsed = JSON.parse(body) as { error?: string | { message?: string } };
    if (typeof parsed.error === "string") detail = parsed.error;
    else if (parsed.error?.message) detail = parsed.error.message;
  } catch {
    detail = body || response.statusText;
  }
  return new Error(`Provider returned HTTP ${response.status}: ${detail}`);
}
