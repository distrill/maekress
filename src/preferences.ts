import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const configDirectory = path.join(homedir(), ".config", "gmkres");
const configPath = path.join(configDirectory, "config.json");

export type Preferences = {
  provider?: string;
  models?: Record<string, string>;
};

export async function loadPreferences(): Promise<Preferences> {
  try {
    return JSON.parse(await readFile(configPath, "utf8")) as Preferences;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export async function savePreferences(preferences: Preferences): Promise<void> {
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  await chmod(configDirectory, 0o700);
  const temporaryPath = `${configPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(preferences, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, configPath);
}
