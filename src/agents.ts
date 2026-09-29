import { readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const maekressDirectory = path.join(homedir(), ".config", "maekress");
const maxInstructionBytes = 48_000;
const maxSkillFiles = 100;

export type AgentFile = { path: string; content: string };
export type AgentContext = { instructions: AgentFile[]; skills: string[] };

async function readOptional(file: string): Promise<string | undefined> {
  try {
    const contents = await readFile(file, "utf8");
    if (Buffer.byteLength(contents, "utf8") > maxInstructionBytes) throw new Error(`Agent guidance exceeds ${maxInstructionBytes} bytes: ${file}`);
    return contents;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function filesBelow(directory: string, prefix = ""): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const relative = path.join(prefix, entry.name);
      if (entry.isDirectory()) files.push(...await filesBelow(path.join(directory, entry.name), relative));
      else if (entry.isFile() && /\.(?:md|txt)$/i.test(entry.name)) files.push(relative);
      if (files.length >= maxSkillFiles) return files.slice(0, maxSkillFiles);
    }
    return files;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function projectSegments(projectRoot: string, targetPath: string): string[] {
  const target = path.resolve(projectRoot, targetPath || ".");
  if (target !== projectRoot && !target.startsWith(`${projectRoot}${path.sep}`)) throw new Error("Path must stay within the project directory.");
  // A file target inherits its containing directory; an explicit directory also works.
  const relative = path.relative(projectRoot, path.extname(target) ? path.dirname(target) : target);
  return relative ? relative.split(path.sep) : [];
}

export async function globalAgentGuidance(): Promise<AgentFile | undefined> {
  const file = path.join(maekressDirectory, "agents.md");
  const content = await readOptional(file);
  return content === undefined ? undefined : { path: "~/.config/maekress/agents.md", content };
}

export async function resolveAgentContext(projectRoot: string, targetPath = "."): Promise<AgentContext> {
  const root = await realpath(projectRoot);
  const instructions: AgentFile[] = [];
  const global = await globalAgentGuidance();
  if (global) instructions.push(global);
  const directories = [root];
  let current = root;
  for (const segment of projectSegments(root, targetPath)) {
    current = path.join(current, segment);
    directories.push(current);
  }
  const skills: string[] = [];
  for (const directory of directories) {
    const agentFile = path.join(directory, ".maekress", "agents.md");
    const content = await readOptional(agentFile);
    if (content !== undefined) instructions.push({ path: path.relative(root, agentFile) || ".maekress/agents.md", content });
    for (const skill of await filesBelow(path.join(directory, ".maekress", "skills"))) {
      skills.push(path.join(path.relative(root, directory), ".maekress", "skills", skill));
    }
  }
  for (const skill of await filesBelow(path.join(maekressDirectory, "skills"))) skills.unshift(`~/.config/maekress/skills/${skill}`);
  return { instructions, skills };
}

export async function readSkill(projectRoot: string, skillPath: string): Promise<string> {
  const globalPrefix = "~/.config/maekress/skills/";
  const root = await realpath(projectRoot);
  const candidate = skillPath.startsWith(globalPrefix)
    ? path.join(maekressDirectory, "skills", skillPath.slice(globalPrefix.length))
    : path.resolve(root, skillPath);
  const allowed = candidate.startsWith(`${path.join(maekressDirectory, "skills")}${path.sep}`)
    || candidate.startsWith(`${root}${path.sep}`) && candidate.includes(`${path.sep}.maekress${path.sep}skills${path.sep}`);
  if (!allowed) throw new Error("Skill path must name a discovered maekress skill.");
  const resolved = await realpath(candidate);
  if (resolved !== candidate && !resolved.startsWith(`${root}${path.sep}`) && !resolved.startsWith(`${maekressDirectory}${path.sep}`)) throw new Error("Skill path must not resolve outside its allowed directory.");
  const content = await readFile(resolved, "utf8");
  if (Buffer.byteLength(content, "utf8") > maxInstructionBytes) throw new Error(`Skill exceeds ${maxInstructionBytes} bytes.`);
  return content;
}
