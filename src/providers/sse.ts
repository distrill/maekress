export async function* readSseData(response: Response, signal: AbortSignal): AsyncGenerator<string> {
  if (!response.body) throw new Error("Provider returned an empty stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal.aborted) throw new Error("Request cancelled.");
      const { value, done } = await reader.read();
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
    await reader.cancel().catch(() => {});
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
