import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ModelMessage } from "./providers/types.ts";

const directory = path.join(homedir(), ".config", "gmkres", "sessions");

export type Session = {
  version: 1;
  id: string;
  projectRoot: string;
  provider: string;
  model: string;
  messages: ModelMessage[];
};

export function newSession(projectRoot: string, provider: string, model: string, systemPrompt: string): Session {
  return {
    version: 1,
    id: randomBytes(16).toString("hex"),
    projectRoot,
    provider,
    model,
    messages: [{ role: "system", content: systemPrompt }],
  };
}

export async function loadSession(id: string): Promise<Session> {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("Invalid resume ID.");
  let raw: string;
  try {
    raw = await readFile(path.join(directory, `${id}.json`), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`No session found for ${id}.`);
    throw error;
  }
  const session = JSON.parse(raw) as Session;
  if (session.version !== 1 || session.id !== id || typeof session.projectRoot !== "string"
    || typeof session.provider !== "string" || typeof session.model !== "string"
    || !Array.isArray(session.messages) || !session.messages.length
    || !session.messages.every((message) => message && typeof message.content === "string"
      && ["system", "user", "assistant", "tool"].includes(message.role)
      && (message.images === undefined || (message.role === "user" && Array.isArray(message.images)
        && message.images.every((image) => image && ["image/png", "image/jpeg", "image/webp"].includes(image.mimeType)
          && typeof image.data === "string" && image.data.length > 0 && image.data.length <= 7_000_000
          && /^[A-Za-z0-9+/]+={0,2}$/.test(image.data)))))) {
    throw new Error("Session file is invalid or unsupported.");
  }
  return session;
}

const pendingSaves = new Map<string, Promise<void>>();

export function saveSession(session: Session): Promise<void> {
  // Snapshot before any awaits, and serialize writes to avoid older checkpoints
  // replacing newer ones when selection changes while a turn is finishing.
  const snapshot = `${JSON.stringify(session, null, 2)}\n`;
  const previous = pendingSaves.get(session.id) ?? Promise.resolve();
  const save = previous.catch(() => {}).then(() => writeSnapshot(session.id, snapshot));
  pendingSaves.set(session.id, save);
  void save.finally(() => {
    if (pendingSaves.get(session.id) === save) pendingSaves.delete(session.id);
  }).catch(() => {});
  return save;
}

async function writeSnapshot(id: string, snapshot: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporaryPath = path.join(directory, `${id}.${process.pid}.tmp`);
  await writeFile(temporaryPath, snapshot, { mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, path.join(directory, `${id}.json`));
}
