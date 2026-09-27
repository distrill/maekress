import { createHostClipboard } from "@opentui/core";
import type { ImageAttachment, ModelMessage } from "./providers/types.ts";

const maxBytes = 5 * 1024 * 1024;
const supported = ["image/png", "image/jpeg", "image/webp"] as const;

export function imageAttachment(mimeType: string, bytes: Uint8Array): ImageAttachment {
  if (!supported.includes(mimeType as typeof supported[number])) throw new Error(`Unsupported image format: ${mimeType}`);
  if (!bytes.length || bytes.length > maxBytes) throw new Error(`Image must be between 1 byte and ${maxBytes / 1024 / 1024} MiB.`);
  const png = bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp = bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).toString() === "RIFF" && Buffer.from(bytes.subarray(8, 12)).toString() === "WEBP";
  if (!(mimeType === "image/png" && png || mimeType === "image/jpeg" && jpeg || mimeType === "image/webp" && webp)) {
    throw new Error("Clipboard image bytes do not match their MIME type.");
  }
  return { mimeType: mimeType as ImageAttachment["mimeType"], data: Buffer.from(bytes).toString("base64") };
}

export async function readClipboardImage(): Promise<ImageAttachment> {
  const clipboard = createHostClipboard({ maxReadBytes: maxBytes, timeoutMs: 3000 });
  try {
    const result = await clipboard.read({ preferredTypes: [...supported] });
    if (result.status === "read") return imageAttachment(result.representation.mimeType, result.representation.bytes);
    if (result.status === "failed") throw result.error;
    throw new Error(`No clipboard image available (${result.status}). Clipboard is read on the machine running gmkres.`);
  } finally {
    await clipboard.dispose();
  }
}

export function imageMarker(index: number): string {
  return `[image ${String(index + 1).padStart(2, "0")}]`;
}

// Preserve the position of pasted images in both provider requests and chat.
// Older sessions (and messages with deleted markers) still attach unmatched images at the end.
export function imageParts(message: Pick<ModelMessage, "content" | "images">): Array<{ type: "text"; text: string } | { type: "image"; image: ImageAttachment }> {
  const images = message.images ?? [];
  const parts: Array<{ type: "text"; text: string } | { type: "image"; image: ImageAttachment }> = [];
  const used = new Set<number>();
  const marker = /\[image (\d+)\]/g;
  let start = 0;
  for (const match of message.content.matchAll(marker)) {
    const index = Number(match[1]) - 1;
    if (index < 0 || index >= images.length || used.has(index)) continue;
    if (match.index > start) parts.push({ type: "text", text: message.content.slice(start, match.index) });
    parts.push({ type: "image", image: images[index]! });
    used.add(index);
    start = match.index + match[0].length;
  }
  if (start < message.content.length) parts.push({ type: "text", text: message.content.slice(start) });
  if (!parts.some((part) => part.type === "text" && part.text.trim())) {
    parts.unshift({ type: "text", text: "Please examine the attached image." });
  }
  images.forEach((image, index) => { if (!used.has(index)) parts.push({ type: "image", image }); });
  return parts;
}

export function imageLabel(message: Pick<ModelMessage, "content" | "images">): string {
  const labels = message.images?.map((_, index) => imageMarker(index)).filter((label) => !message.content.includes(label)).join(" ") ?? "";
  return [message.content, labels].filter(Boolean).join("\n");
}
