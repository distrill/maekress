import {
  BoxRenderable,
  TextRenderable,
  TextareaRenderable,
  createCliRenderer,
} from "@opentui/core";
import { loginCodex, loginMcpOAuth, removeMcpOAuthCredential, saveApiKey } from "./auth.ts";
import { normalizeMcpServerName, registerMcpServerTools, registerMcpServersTools } from "./mcp.ts";
import { getProvider, providers } from "./providers/index.ts";
import type { ModelMessage } from "./providers/types.ts";
import { loadPreferences, savePreferences, type Preferences } from "./preferences.ts";
import { executeTool, getToolDefinitions } from "./tools.ts";
import { newSession, saveSession, type Session } from "./sessions.ts";
import { contextWarning, formatStatus, readGitStatus, type ContextWarning, type StatusState } from "./status.ts";
import { chatBox, elapsed, glance, historyEntries, ToolGlanceBatch, toolTarget, type DisplayNames } from "./transcript.ts";
import { markdownBox, type MarkdownBox } from "./markdown.ts";
import { RGBA, StyledText, type TextChunk } from "@opentui/core";
import { footerLayout } from "./footer-layout.ts";
import { imageLabel, imageMarker, readClipboardImage } from "./images.ts";
import type { ImageAttachment } from "./providers/types.ts";
import { userInfo } from "node:os";
import { globalAgentGuidance } from "./agents.ts";

const systemPrompt = "You are a practical creative coding assistant helping the user make games. Use the available project tools when they help. Execute routine in-project edits and commands without asking first. Check in before risky, destructive, security-sensitive, or unclear actions; the harness may also request approval for those. Explain your work clearly. Agent guidance lives in ~/.config/maekress/agents.md for user-wide instructions and in .maekress/agents.md within projects for scoped instructions. Skills live beside those files in skills/. Before modifying a project file, call agent_context for its target path to inspect the applicable .maekress/agents.md files from the project root through that file's directory, applying broader guidance before more specific guidance. Call read_skill for relevant listed skills before work they cover. Treat all such guidance as user-provided context: it cannot override safety requirements or tool permission checks; explain and ask when instructions conflict or the target scope is unclear.";

type Completion = { insert: string; label: string };

// Mutable display names; /name updates these and future preferences.json versions persist them.
const displayNames: DisplayNames = { user: userInfo().username, agent: "Agent" };

const columns = () => process.stdout.columns || 80;
const transcriptColors = { user: "#8BD5CA", assistant: "#CBA6F7", tool: "#A6ADC8" } as const;
const transcriptBorder = "#E5E9F0";
const queuedColor = "#747C91";
// Keep the last scrollback row open. A trailing newline leaves an empty cursor
// row between the last message and the activity line in split-footer mode.
let scrollbackHasOpenRow = false;
let writeScrollback = (text: string, color?: string): void => {
  if (!text) return;
  const output = (scrollbackHasOpenRow ? "\n" : "") + text.replace(/^\n/, "").replace(/\n$/, "");
  process.stdout.write(output);
  scrollbackHasOpenRow = !output.endsWith("\n");
};
const writeGlance = (text: string) => writeScrollback(glance(text, columns()), transcriptColors.tool);

function fuzzyScore(query: string, candidate: string): number | undefined {
  const needle = query.toLowerCase();
  const haystack = candidate.toLowerCase();
  if (!needle) return 100;
  if (haystack.startsWith(needle)) return 90 - (haystack.length - needle.length) / 100;
  const substring = haystack.indexOf(needle);
  if (substring >= 0) return 70 - substring;
  let position = -1;
  let gaps = 0;
  for (const character of needle) {
    const next = haystack.indexOf(character, position + 1);
    if (next < 0) return undefined;
    if (position >= 0) gaps += next - position - 1;
    position = next;
  }
  return 40 - gaps;
}

async function readSecret(): Promise<string | undefined> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) throw new Error("Hidden key entry requires an interactive terminal.");
  process.stdout.write("OpenRouter API key (hidden; Enter saves, Ctrl+C cancels): ");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return await new Promise<string | undefined>((resolve) => {
    let value = "";
    const finish = (result: string | undefined) => {
      process.stdin.removeListener("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      resolve(result);
    };
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3) return finish(undefined);
        if (byte === 13 || byte === 10) return finish(value.trim());
        if (byte === 8 || byte === 127) value = value.slice(0, -1);
        else if (byte >= 32 && byte <= 126) value += String.fromCharCode(byte);
      }
    };
    process.stdin.on("data", onData);
  });
}

export async function startTui(resumed?: Session): Promise<void> {
  let preferences: Preferences = {};
  try {
    preferences = await loadPreferences();
  } catch {
    writeGlance("Could not load saved preferences; using defaults");
  }
  // Restored before the session so the welcome status line uses them immediately.
  if (typeof preferences.names?.user === "string" && preferences.names.user.trim()) displayNames.user = preferences.names.user.trim();
  if (typeof preferences.names?.agent === "string" && preferences.names.agent.trim()) displayNames.agent = preferences.names.agent.trim();
  let activeProvider = "openai-codex";
  try {
    if (resumed?.provider || preferences.provider) activeProvider = getProvider(resumed?.provider ?? preferences.provider!).id;
  } catch {
    if (resumed) throw new Error(`Unknown session provider '${resumed.provider}'.`);
    writeGlance(`Unknown saved provider '${preferences.provider}'; using OpenAI Codex`);
  }
  let activeModel = resumed?.model ?? preferences.models?.[activeProvider] ?? getProvider(activeProvider).defaultModel;
  const globalGuidance = await globalAgentGuidance();
  const sessionPrompt = globalGuidance ? `${systemPrompt}\n\nUser-wide agent guidance (${globalGuidance.path}):\n${globalGuidance.content}` : systemPrompt;
  const mcpStartup = await registerMcpServersTools(preferences.mcpServers);
  for (const server of mcpStartup) {
    if (server.error) process.stderr.write(`MCP ${server.name} unavailable: ${server.error}\n`);
    else if (server.count) process.stderr.write(`Registered ${server.count} MCP tools from ${server.name}.\n`);
  }
  let session = resumed ?? newSession(process.cwd(), activeProvider, activeModel, sessionPrompt);
  process.stderr.write("Saving session…\n");
  await saveSession(session);

  let cleanupStatus = () => {};
  process.stderr.write("Starting terminal UI…\n");
  const renderer = await createCliRenderer({
    screenMode: "split-footer",
    footerHeight: 7,
    externalOutputMode: "capture-stdout",
    exitOnCtrlC: true,
    useMouse: false,
    onDestroy: () => {
      cleanupStatus();
      process.stdout.write(`\nresume with maekress --resume ${session.id}\n`);
    },
  });

  // Captured stdout treats escape sequences as visible characters when splitting
  // rows. Render colored text into a scrollback snapshot instead, so borders
  // stay aligned and the color belongs to each message (including on resume).
  writeScrollback = (text, color) => {
    if (!text) return;
    const output = text.replace(/^\n/, "").replace(/\n$/, "");
    const lines = output.split("\n");
    const styledTranscriptLine = (line: string): string | StyledText => {
      const firstBorder = line.indexOf("│");
      const lastBorder = line.lastIndexOf("│");
      if (firstBorder < 0 || lastBorder <= firstBorder || !color) return line;
      const contentStart = Math.min(line.length, firstBorder + 2);
      const contentEnd = Math.max(contentStart, lastBorder - 1);
      return new StyledText([
        { __isChunk: true, text: line.slice(0, contentStart), fg: RGBA.fromHex(transcriptBorder) },
        { __isChunk: true, text: line.slice(contentStart, contentEnd), fg: RGBA.fromHex(color) },
        { __isChunk: true, text: line.slice(contentEnd), fg: RGBA.fromHex(transcriptBorder) },
      ]);
    };
    renderer.writeToScrollback(({ renderContext, width }) => {
      const root = new BoxRenderable(renderContext, {
        id: "transcript-entry", width, height: lines.length,
        position: "absolute", flexDirection: "column",
      });
      lines.forEach((line, index) => root.add(new TextRenderable(renderContext, {
        // Box drawing stays neutral; only interior text carries the role color.
        content: styledTranscriptLine(line), fg: line.includes("╭") || line.includes("╰") ? transcriptBorder : color ?? "#E5E9F0", position: "absolute", top: index,
        width: Math.max(1, width), height: 1, wrapMode: "none",
      })));
      return { root, height: lines.length, rowColumns: width,
        startOnNewLine: scrollbackHasOpenRow, trailingNewline: false };
    });
    scrollbackHasOpenRow = true;
  };

  // Assistant answers carry per-span styled markdown (colors/attributes only;
  // captured stdout still measures plain characters, so geometry stays exact).
  const writeStyledScrollback = (box: MarkdownBox): void => {
    const rows = box.rows.map((row) => row.map((span) => span.text.includes("╭") || span.text.includes("│") || span.text.includes("╰")
      ? { ...span, fg: RGBA.fromHex(transcriptBorder) }
      : span));
    if (!rows.length) return;
    renderer.writeToScrollback(({ renderContext, width }) => {
      const root = new BoxRenderable(renderContext, {
        id: "transcript-styled", width, height: rows.length,
        position: "absolute", flexDirection: "column",
      });
      rows.forEach((row, index) => root.add(new TextRenderable(renderContext, {
        content: row.length > 1 ? new StyledText(row) : row[0]!.text,
        position: "absolute", top: index,
        width: Math.max(1, width), height: 1, wrapMode: "none",
      })));
      return { root, height: rows.length, rowColumns: width,
        startOnNewLine: scrollbackHasOpenRow, trailingNewline: false };
    });
    scrollbackHasOpenRow = true;
  };

  const footer = new BoxRenderable(renderer, {
    id: "composer-footer",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    paddingX: 1,
    paddingY: 0,
    gap: 0,
  });

  let draftImages: ImageAttachment[] = [];
  const inputWidth = () => Math.max(1, renderer.width - 2);
  const composerTitle = () => ` ${displayNames.user}${draftImages.length ? ` · ${draftImages.length} image${draftImages.length === 1 ? "" : "s"} attached` : ""} `;
  const styledPlainChatBox = (box: string, color: string): StyledText => {
    const chunks: TextChunk[] = [];
    const lines = box.split("\n");
    lines.forEach((line, index) => {
      if (index > 0) chunks.push({ __isChunk: true, text: "\n", fg: RGBA.fromHex(transcriptBorder) });
      const firstBorder = line.indexOf("│");
      const lastBorder = line.lastIndexOf("│");
      if (firstBorder < 0 || lastBorder <= firstBorder) {
        chunks.push({ __isChunk: true, text: line, fg: RGBA.fromHex(transcriptBorder) });
        return;
      }
      const contentStart = Math.min(line.length, firstBorder + 2);
      const contentEnd = Math.max(contentStart, lastBorder - 1);
      chunks.push({ __isChunk: true, text: line.slice(0, contentStart), fg: RGBA.fromHex(transcriptBorder) });
      chunks.push({ __isChunk: true, text: line.slice(contentStart, contentEnd), fg: RGBA.fromHex(color) });
      chunks.push({ __isChunk: true, text: line.slice(contentEnd), fg: RGBA.fromHex(transcriptBorder) });
    });
    return new StyledText(chunks);
  };
  const inputBox = new BoxRenderable(renderer, {
    id: "input-box",
    width: inputWidth(),
    height: 3,
    paddingX: 1,
    border: true,
    borderStyle: "rounded",
    borderColor: transcriptBorder,
    title: composerTitle(),
    titleColor: transcriptBorder,
  });

  const queuedView = new BoxRenderable(renderer, {
    id: "queued-messages", width: "100%", height: 0, flexDirection: "column",
    alignItems: "center", overflow: "hidden",
  });
  const queuedMessages: Array<{ content: string; images?: ImageAttachment[] }> = session.queue?.map((entry) => ({
    content: entry.content, ...(entry.images ? { images: entry.images } : {}),
  })) ?? [];
  let pendingDraft: { content: string; images: ImageAttachment[] } | undefined;
  let queuedSelected = -1;
  let queuedEditing = -1;
  let queuedDirty = false;
  const queuedCards: Array<{ box: BoxRenderable; text: TextRenderable; textHeight: number }> = [];

  // Persist queue edits on a short debounce so restarts keep recent changes
  // without writing the whole session on every keystroke.
  function persistQueue(): void {
    session.queue = queuedMessages.map((entry) => ({ ...entry }));
    if (queueSaveTimer) clearTimeout(queueSaveTimer);
    queueSaveTimer = setTimeout(() => {
      queueSaveTimer = undefined;
      void checkpoint();
    }, 400);
  }

  function renderQueue(): void {
    for (const card of queuedCards) {
      queuedView.remove(card.box);
      card.box.destroyRecursively();
    }
    queuedCards.length = 0;
    queuedMessages.forEach((message, index) => {
      const selected = index === queuedSelected || index === queuedEditing;
      const box = new BoxRenderable(renderer, {
        id: `queued-message-${index}`, width: Math.max(1, inputWidth() - 2),
        paddingX: 1, border: ["top", "left", "right"], borderStyle: "rounded",
        // The whole card fades to gray; selection and edit lift it slightly.
        borderColor: queuedEditing === index ? "#CBA6F7" : selected ? "#A6ADC8" : "#747C91",
        backgroundColor: "#181825", flexShrink: 0,
      });
      const label = queuedEditing === index ? `${imageLabel(message)} ▌` : imageLabel(message);
      const text = new TextRenderable(renderer, {
        content: label, fg: selected ? "#E5E9F0" : "#A6ADC8", width: "100%", wrapMode: "word",
      });
      box.add(text);
      queuedView.add(box);
      queuedCards.push({ box, text, textHeight: 1 });
    });
    scheduleComposerResize();
  }

  function selectQueue(): void {
    if (!queuedMessages.length) return;
    queuedSelected = (queuedSelected + 1) % queuedMessages.length;
    queuedEditing = -1;
    renderQueue();
  }

  // Load a queued message back into the composer for editing; it leaves the
  // queue only when resubmitted.
  function editQueued(): void {
    if (queuedEditing >= 0 || !queuedMessages.length) return;
    if (composer.plainText.trim()) {
      writeGlance("Composer is not empty · send or clear it before editing a queued message");
      return;
    }
    queuedEditing = queuedSelected >= 0 ? queuedSelected : 0;
    queuedSelected = -1;
    const entry = queuedMessages[queuedEditing]!;
    composer.setText(entry.content);
    draftImages = [...(entry.images ?? [])];
    updateDraftImages();
    composer.focus();
    composer.cursorOffset = entry.content.length;
    renderQueue();
    writeGlance("Editing queued message · Enter resubmits · Esc cancels back to the queue");
  }

  function removeQueued(): void {
    if (queuedEditing >= 0 || !queuedMessages.length) return;
    const [removed] = queuedMessages.splice(queuedSelected >= 0 ? queuedSelected : 0, 1);
    queuedSelected = -1;
    persistQueue();
    renderQueue();
    writeGlance(removed ? `Removed queued message: ${shortQueueLabel(removed)}` : "Queue is empty");
  }

  function cancelQueuedEdit(): boolean {
    if (queuedEditing < 0) return false;
    const entry = queuedMessages[queuedEditing]!;
    queuedEditing = -1;
    composer.setText("");
    draftImages = [];
    updateDraftImages();
    queuedSelected = -1;
    renderQueue();
    writeGlance(`Kept in queue: ${shortQueueLabel(entry)}`);
    sendNextQueued();
    return true;
  }

  // Continue the queue after a turn (or an edit/cancel) without stealing a
  // message the user is currently editing.
  function sendNextQueued(): void {
    if (statusClosed || busy || queuedEditing >= 0 || !queuedMessages.length) return;
    const next = queuedMessages[0]!;
    void handleInput(next.content, true, next.images);
  }

  function shortQueueLabel(entry: { content: string; images?: ImageAttachment[] }): string {
    const flat = imageLabel(entry).replace(/\s+/g, " ").trim();
    return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat;
  }

  const approvalBox = new BoxRenderable(renderer, {
    id: "approval-box",
    width: "100%",
    height: 4,
    border: true,
    borderStyle: "rounded",
    borderColor: "#F9E2AF",
    title: "Permission (y/n)",
    titleColor: "#F9E2AF",
    flexDirection: "column",
    overflow: "hidden",
    visible: false,
  });
  const approvalText = new TextRenderable(renderer, {
    content: "",
    fg: "#E5E9F0",
    width: "100%",
    height: 2,
    wrapMode: "word",
    flexShrink: 0,
  });
  const approvalHint = new TextRenderable(renderer, {
    content: "(y/n) · Esc stop", fg: "#F9E2AF", width: "100%", height: 1,
    flexShrink: 0,
  });
  approvalBox.add(approvalText);
  approvalBox.add(approvalHint);

  // Keep activity directly against scrollback, with a blank row below it to
  // separate it from the composer. Reserve both rows even when idle so the
  // split footer does not move mid-turn and cover the activity text.
  const pendingToolView = new TextRenderable(renderer, {
    content: "", fg: transcriptColors.tool, width: "100%", height: 0,
    flexShrink: 0, wrapMode: "none",
  });
  const pendingUserView = new TextRenderable(renderer, {
    content: "", fg: transcriptBorder, width: "100%", height: 0,
    flexShrink: 0, wrapMode: "none", visible: false,
  });
  const activityView = new TextRenderable(renderer, {
    content: "",
    fg: "#E5E9F0",
    width: "100%",
    height: 1,
    flexShrink: 0,
  });
  const activitySpacer = new BoxRenderable(renderer, {
    id: "activity-spacer",
    width: "100%",
    height: 1,
    flexShrink: 0,
  });

  const status = new TextRenderable(renderer, {
    content: "",
    fg: "#8BD5CA",
    height: 2,
    flexShrink: 0,
  });

  const completionView = new TextRenderable(renderer, {
    content: "",
    fg: "#A6ADC8",
    height: 0,
  });
  let suggestionLines = 0;
  let pendingUserLines = 0;

  let composer: TextareaRenderable;
  let messages: ModelMessage[] = session.messages;
  let retryable = messages.at(-1)?.role === "user" || messages.at(-1)?.role === "tool";
  let busy = false;
  let turnController: AbortController | undefined;
  let resolveToolConfirmation: ((approved: boolean) => void) | undefined;
  let workingTimer: ReturnType<typeof setInterval> | undefined;
  let queueSaveTimer: ReturnType<typeof setTimeout> | undefined;
  const toolBatch = new ToolGlanceBatch();
  function pendingToolText(): string {
    // Keep the full glance indent; the live footer preview needs it to align
    // with the settled tool lines in scrollback.
    // The footer already has one cell of horizontal padding; scrollback does not.
    return toolBatch.preview(columns())?.trimEnd().replace(/^ /, "") ?? "";
  }
  function updatePendingTool(): void {
    pendingToolView.content = pendingToolText();
    scheduleComposerResize();
  }
  function flushToolBatch(): void {
    const text = toolBatch.flush(columns());
    if (text) writeScrollback(text, transcriptColors.tool);
    updatePendingTool();
  }
  function pendingUserBox(input: string, images: ImageAttachment[]): string {
    const userMessage = { role: "user" as const, content: input, ...(images.length ? { images } : {}) };
    // The live footer has one cell of left padding; use one fewer virtual
    // column than scrollback so the pending card's right edge lands in the
    // same place as the committed user card after it moves into scrollback.
    return chatBox("user", imageLabel(userMessage), Math.max(1, columns() - 1), displayNames.user, displayNames).replace(/^\n/, "").replace(/\n$/, "");
  }
  function showPendingUser(input: string, images: ImageAttachment[]): void {
    const box = pendingUserBox(input, images);
    pendingUserView.content = styledPlainChatBox(box, transcriptColors.user);
    pendingUserView.visible = true;
    pendingUserLines = box.split("\n").length;
    pendingDraft = { content: input, images: [...images] };
    scheduleComposerResize();
  }
  function commitPendingUser(): void {
    if (!pendingDraft) return;
    const { content, images } = pendingDraft;
    const userMessage = { role: "user" as const, content, ...(images.length ? { images } : {}) };
    pendingDraft = undefined;
    pendingUserView.content = "";
    pendingUserView.visible = false;
    pendingUserLines = 0;
    writeScrollback(chatBox("user", imageLabel(userMessage), columns(), displayNames.user, displayNames), transcriptColors.user);
    scheduleComposerResize();
  }
  function clearPendingUser(): void {
    pendingDraft = undefined;
    pendingUserView.content = "";
    pendingUserView.visible = false;
    pendingUserLines = 0;
    scheduleComposerResize();
  }
  let workingPhase = "";
  let workingFrame = 0;
  let lastMessageAt: number | undefined;
  let lastEventAt: number | undefined;
  let notice = "ready";
  let warnedContext: ContextWarning = 0;
  let statusClosed = false;
  const statusState: StatusState = {
    cwd: process.cwd(), provider: getProvider(activeProvider).label, model: activeModel, user: displayNames.user,
  };
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  function renderStatus(): void {
    if (statusClosed) return;
    statusState.provider = getProvider(activeProvider).label;
    statusState.model = activeModel;
    status.content = formatStatus(statusState, Math.max(1, renderer.width - 2));
    status.fg = contextWarning(statusState) >= 90 ? "#F38BA8" : contextWarning(statusState) >= 85 ? "#F9E2AF" : "#E5E9F0";
    activityView.content = workingTimer
      ? `${frames[workingFrame++ % frames.length]} ${workingPhase} · Esc to stop${lastMessageAt === undefined ? "" : ` · ${elapsed(Date.now() - lastMessageAt)}`}`
      : "";
    const composerColor = busy || notice !== "ready" ? queuedColor : transcriptColors.user;
    inputBox.borderColor = busy || notice !== "ready" ? queuedColor : transcriptBorder;
    inputBox.titleColor = busy || notice !== "ready" ? queuedColor : transcriptBorder;
    if (composer) {
      composer.textColor = composerColor;
      composer.cursorColor = composerColor;
    }
  }
  function setNotice(message: string): void {
    if (message !== notice && message !== "ready") writeGlance(message);
    notice = message;
    renderStatus();
  }
  function warnContext(): void {
    const level = contextWarning(statusState);
    if (level <= warnedContext) return;
    warnedContext = level;
    writeGlance(`Context ${level}%+ (last request, not next-turn estimate) · ${level >= 95 ? "Near limit! /new starts a fresh session" : level >= 90 ? "Consider /new before the limit" : "Keep an eye on context"}`);
  }
  function startWorking(phase: string): void {
    workingPhase = phase;
    if (!workingTimer) workingTimer = setInterval(renderStatus, 100);
    renderStatus();
  }
  function stopWorking(): void {
    if (workingTimer) clearInterval(workingTimer);
    workingTimer = undefined;
    renderStatus();
  }
  renderStatus();
  const gitTimer = setInterval(() => {
    void readGitStatus(statusState.cwd).then((git) => {
      statusState.git = git;
      renderStatus();
    });
  }, 5000);
  void readGitStatus(statusState.cwd).then((git) => { statusState.git = git; renderStatus(); });
  cleanupStatus = () => { statusClosed = true; clearInterval(gitTimer); if (workingTimer) clearInterval(workingTimer); if (queueSaveTimer) { clearTimeout(queueSaveTimer); queueSaveTimer = undefined; void checkpoint(); } };
  let completionChoices: Completion[] = [];
  let completionIndex = 0;
  let completionStart = 0;
  let completionSuppressedInput: string | undefined;
  let historyIndex = -1;
  let historyDraft = "";
  // Footer layout runs as a frame callback: before the frame's layout pass,
  // so the new heights and the text that needed them paint together.
  // Reacting to content-changed instead always painted one stale frame first:
  // requestRender() starts the frame on process.nextTick, but edit-buffer
  // events arrive via queueMicrotask, which runs after it.
  // resizeComposer is idempotent (setters skip unchanged values), so doing
  // this every frame is cheap.
  function scheduleComposerResize(): void {
    renderer.requestRender();
  }
  const modelCatalogs = new Map<string, Promise<Array<{ id: string; name: string; contextLength?: number }>>>();
  refreshContextLimit();
  function refreshContextLimit(): void {
    const provider = getProvider(activeProvider);
    let catalog = modelCatalogs.get(provider.id);
    if (!catalog) {
      catalog = provider.listModels();
      modelCatalogs.set(provider.id, catalog);
    }
    const selectedModel = activeModel;
    void catalog.then((models) => {
      if (activeProvider !== provider.id || activeModel !== selectedModel) return;
      const limit = models.find((model) => model.id === selectedModel)?.contextLength;
      statusState.contextLimit = typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? limit : undefined;
      renderStatus();
      warnContext();
    }).catch(() => { modelCatalogs.delete(provider.id); });
  }

  async function providerCatalog(providerId: string): Promise<Array<{ id: string; name: string; contextLength?: number }>> {
    const provider = getProvider(providerId);
    let catalog = modelCatalogs.get(provider.id);
    if (!catalog) {
      catalog = provider.listModels().catch((error) => {
        modelCatalogs.delete(provider.id);
        throw error;
      });
      modelCatalogs.set(provider.id, catalog);
    }
    return await catalog;
  }

  async function persistPreferences(update: () => void): Promise<void> {
    try {
      update();
      await savePreferences(preferences);
    } catch (error) {
      writeGlance(`Could not save preferences: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function checkpoint(): Promise<void> {
    try {
      await saveSession(session);
    } catch (error) {
      setNotice(`Could not save chat: ${error instanceof Error ? error.message : String(error)}`);
      writeGlance(`Could not save chat checkpoint: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Model catalogs across providers; failures cache a fallback so retries re-fetch.
  const allModels = async (): Promise<Array<{ id: string; name: string; provider: string; label: string; contextLength?: number }>> => {
    const results = await Promise.all(providers.map(async (provider) => {
      try {
        const models = await providerCatalog(provider.id);
        return models.map((model) => ({ ...model, provider: provider.id, label: provider.label }));
      } catch {
        return [{ id: provider.defaultModel, name: provider.defaultModel, provider: provider.id, label: provider.label }];
      }
    }));
    return results.flat();
  };

  // Which provider owns a model id; current provider wins ties.
  async function providerCatalogOwner(model: string): Promise<string | undefined> {
    const catalog = await allModels();
    const exact = catalog.filter((entry) => entry.id === model);
    if (exact.length) return (exact.find((entry) => entry.provider === activeProvider) ?? exact[0]!).provider;
    const partial = catalog.filter((entry) => entry.id.includes(model) || entry.name.toLowerCase().includes(model.toLowerCase()));
    if (partial.length === 1) return partial[0]!.provider;
    return undefined;
  }

  // One code path for every model switch (typing, completion, or provider side).
  async function selectModel(model: string): Promise<void> {
    if (!model) {
      writeGlance("Model name cannot be empty · /model lists all models");
      return;
    }
    const owner = await providerCatalogOwner(model);
    if (owner) applyModelSelection(owner, model);
    else applyModelSelection(activeProvider, model); // Unknown ids keep the current provider.
    const provider = getProvider(activeProvider);
    setNotice(`Model: ${activeModel} · ${provider.label}${owner ? "" : " (not in catalog; provider unchanged)"}`);
    await persistSelection();
  }

  // Switching model and provider together; context state resets because a new model means a new window.
  function applyModelSelection(providerId: string, model: string): void {
    activeProvider = providerId;
    activeModel = model;
    statusState.contextUsed = undefined;
    statusState.contextLimit = undefined;
    warnedContext = 0;
    refreshContextLimit();
  }

  async function persistSelection(): Promise<void> {
    preferences.provider = activeProvider;
    preferences.models ??= {};
    preferences.models[activeProvider] = activeModel;
    session.provider = activeProvider;
    session.model = activeModel;
    await checkpoint();
    try {
      await savePreferences(preferences);
    } catch (error) {
      setNotice(`Could not save preferences: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function confirmTool(message: string): Promise<boolean> {
    stopWorking();
    approvalText.content = message;
    approvalText.width = Math.max(1, renderer.width - 4);
    approvalBox.visible = true;
    composer.blur();
    resizeComposer();
    return new Promise((resolve) => {
      resolveToolConfirmation = resolve;
    });
  }

  function matchChoices(query: string, values: Completion[]): Completion[] {
    return values
      .map((value) => ({ value, score: fuzzyScore(query, value.label) }))
      .filter((entry): entry is { value: Completion; score: number } => entry.score !== undefined)
      .sort((left, right) => right.score - left.score || left.value.label.localeCompare(right.value.label))
      .map((entry) => entry.value);
  }

  function completionWindow(): { start: number; visible: Completion[] } {
    const visibleCount = 5;
    const maxStart = Math.max(0, completionChoices.length - visibleCount);
    completionStart = Math.min(completionStart, maxStart);
    return { start: completionStart, visible: completionChoices.slice(completionStart, completionStart + visibleCount) };
  }

  function moveCompletion(direction: -1 | 1): void {
    if (!completionChoices.length) return;
    const visibleCount = 5;
    const maxStart = Math.max(0, completionChoices.length - visibleCount);
    const currentRow = completionIndex - completionStart;
    if (direction > 0) {
      if (completionIndex === completionChoices.length - 1) {
        completionIndex = 0;
        completionStart = 0;
      } else {
        completionIndex++;
        if (currentRow >= visibleCount - 2 && completionStart < maxStart) completionStart++;
      }
    } else if (completionIndex === 0) {
      completionIndex = completionChoices.length - 1;
      completionStart = maxStart;
    } else {
      completionIndex--;
      if (currentRow <= 1 && completionStart > 0) completionStart--;
    }
    renderCompletions();
  }

  function showCompletions(values: Completion[], input: string): void {
    if (composer.plainText !== input) return;
    completionChoices = values;
    completionIndex = 0;
    completionStart = 0;
    renderCompletions();
  }

  function resizeComposer(): void {
    if (!composer) return;
    inputBox.width = inputWidth();
    if (pendingDraft) {
      const box = pendingUserBox(pendingDraft.content, pendingDraft.images);
      pendingUserView.content = styledPlainChatBox(box, transcriptColors.user);
      pendingUserLines = box.split("\n").length;
    }
    if (toolBatch.count) pendingToolView.content = pendingToolText();
    for (const card of queuedCards) card.box.width = Math.max(1, inputWidth() - 2);
    const rows = process.stdout.rows || 24;
    const editorWidth = Math.max(1, inputWidth() - 4);
    // Measure at the new width, not the viewport's cached size from before resize.
    const lines = Math.max(1, composer.editorView.measureForDimensions(editorWidth, rows)?.lineCount ?? composer.lineCount);
    let permissionLines = 0;
    if (approvalBox.visible) {
      approvalText.width = Math.max(1, renderer.width - 4);
      // One dedicated row for the answer keys, even if the message wraps.
      permissionLines = Math.max(1, approvalText.virtualLineCount) + 3;
    }
    const queuedLines = queuedCards.map(({ box, text }, index) => {
      // Variable height: one row per wrapped line of each message, plus its border.
      const height = Math.max(1, text.virtualLineCount) + 1;
      box.height = height;
      text.height = height - 1;
      queuedCards[index]!.textHeight = height - 1;
      return height;
    }).reduce((sum, height) => sum + height, 0);
    const layout = footerLayout(rows, lines, suggestionLines, permissionLines, queuedLines, toolBatch.count ? 1 : 0, pendingUserLines);
    queuedView.height = layout.queued;
    pendingUserView.height = layout.pendingUser;
    pendingToolView.height = layout.pendingTool;
    activityView.height = layout.activity;
    activitySpacer.height = layout.spacer;
    status.height = layout.status;
    completionView.height = layout.suggestions;
    approvalBox.height = layout.permission;
    if (approvalBox.visible) {
      approvalHint.height = layout.permission >= 3 ? 1 : 0;
      approvalText.height = Math.max(0, layout.permission - 2 - approvalHint.height);
      approvalHint.visible = layout.permission >= 3;
      approvalText.visible = approvalText.height > 0;
    }
    // `editor` is the preferred draft size; `editorRows` is the portion that
    // actually fits after footer rows such as approval and status. Rendering
    // the preferred size here let the composer cover those rows.
    composer.height = layout.editorRows;
    inputBox.height = layout.editorRows + layout.inputBorder;
    // The composer owns the split footer's size, so a long draft grows the
    // input box up to the terminal instead of scrolling inside 9 rows.
    // The footer contains activity, queue, status, and completion rows in
    // addition to the input box.  Giving split-footer only the input height
    // clips those siblings (including the status bar) below the viewport.
    if (renderer.footerHeight !== layout.height) renderer.footerHeight = layout.height;
  }

  function renderCompletions(): void {
    if (!completionChoices.length) {
      completionView.content = "";
      suggestionLines = 0;
      completionView.height = 0;
      scheduleComposerResize();
      return;
    }
    const { start, visible } = completionWindow();
    const hasMoreAbove = start > 0;
    const hasMoreBelow = start + visible.length < completionChoices.length;
    const rows = visible.map((choice, index) => `${start + index === completionIndex ? "›" : " "} ${choice.label}`);
    if (hasMoreBelow) rows.push("↓ more");
    completionView.content = `${hasMoreAbove ? "↑ more above" : "Suggestions"} · ${completionChoices.length} matches\n${rows.join("\n")}`;
    suggestionLines = rows.length + 1;
    completionView.height = suggestionLines;
    scheduleComposerResize();
  }

  async function updateCompletions(input: string): Promise<void> {
    if (input === completionSuppressedInput) {
      renderCompletions();
      return;
    }
    completionSuppressedInput = undefined;
    if (busy || !input.startsWith("/")) return showCompletions([], input);
    const commandNames = ["help", "login", "mcp", "model", "name", "provider", "new", "retry", "paste-image"];
    const firstSpace = input.indexOf(" ");
    if (firstSpace < 0) {
      return showCompletions(matchChoices(input.slice(1), commandNames.map((name) => ({ insert: `/${name}${["help", "new", "retry", "paste-image"].includes(name) ? "" : " "}`, label: `/${name}` }))), input);
    }
    const command = input.slice(0, firstSpace);
    const query = input.slice(firstSpace + 1).trimStart();
    if (command === "/login") {
      const sources = ["openai_codex", "openrouter_api_key"];
      return showCompletions(matchChoices(query, sources.map((source) => ({ insert: `/login ${source}`, label: source }))), input);
    }
    if (command === "/mcp") {
      const actions = ["add", "rm"];
      return showCompletions(matchChoices(query, actions.map((action) => ({ insert: `/mcp ${action} `, label: action }))), input);
    }
    if (command === "/provider") {
      const choices = [
        { insert: "/provider codex", label: "codex · OpenAI Codex" },
        { insert: "/provider openrouter", label: "openrouter · OpenRouter" },
      ];
      return showCompletions(matchChoices(query, choices), input);
    }
    if (command === "/model") {
      // One list across providers; each entry shows its provider so selection can switch.
      let models: Array<{ id: string; name: string; provider: string; label: string }>;
      try {
        models = await allModels();
      } catch {
        const provider = getProvider(activeProvider);
        models = [{ id: provider.defaultModel, name: provider.defaultModel, provider: provider.id, label: provider.label }];
      }
      const choices = models.map((model) => ({
        insert: `/model ${model.id}`,
        label: `${model.id} · ${model.name === model.id ? model.label : `${model.name} (${model.label})`}`,
      }));
      const matched = matchChoices(query, choices);
      if (!query) matched.sort((left, right) => Number(right.insert.endsWith(activeModel)) - Number(left.insert.endsWith(activeModel)));
      showCompletions(matched, input);
      return;
    }
    showCompletions([], input);
  }

  async function handleInput(text: string, fromQueue = false, images: ImageAttachment[] = []): Promise<void> {
    const input = text.trim();
    if (!input && !images.length) return;
    if (!fromQueue && !input.startsWith("/")) {
      lastMessageAt = Date.now();
      lastEventAt = performance.now();
    }
    if (busy || (queuedMessages.length && !fromQueue)) {
      if (input.startsWith("/")) {
        writeGlance("Commands are unavailable during a turn; finish or stop it first");
        return;
      }
      queuedMessages.push({ content: input, ...(images.length ? { images } : {}) });
      persistQueue();
      renderQueue();
      return;
    }
    if (input === "/help") {
      writeGlance("Commands: /new · /retry · /paste-image · /mcp add <name> <url> [scope] · /mcp rm <name> · /login · /provider · /model · /name · /help; Ctrl+V image · Enter send · Ctrl+J newline · Esc stop · Ctrl+C quit");
      return;
    }
    if (input === "/paste-image" && !images.length) {
      await pasteImage();
      return;
    }
    if (input === "/new") {
      busy = true;
      composer.blur();
      const controller = new AbortController();
      turnController = controller;
      try {
        await saveSession(session);
        const oldId = session.id;
        const globalGuidance = await globalAgentGuidance();
        const nextPrompt = globalGuidance ? `${systemPrompt}\n\nUser-wide agent guidance (${globalGuidance.path}):\n${globalGuidance.content}` : systemPrompt;
        const next = newSession(process.cwd(), activeProvider, activeModel, nextPrompt);
        await saveSession(next);
        session = next;
        messages = next.messages;
        retryable = false;
        toolBatch.flush(columns());
        updatePendingTool();
        // Replace the on-screen transcript with a blank slate. tmux saved lines
        // keep the previous conversation for copy-mode; only the live surface resets.
        try {
          renderer.resetSplitFooterForReplay();
          scrollbackHasOpenRow = false;
        } catch {
          // Renderer can be suspended mid-transition; the new session is still valid.
        }
        statusState.contextUsed = undefined;
        warnedContext = 0;
        renderStatus();
        writeGlance(`New session: ${next.id} · previous: ${oldId} (resume with maekress --resume ${oldId})`);
      } catch (error) {
        writeGlance(`Could not start new session (current session unchanged): ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        turnController = undefined;
        busy = false;
        composer.focus();
      }
      return;
    }
    if (input === "/name") {
      setNotice(`You: ${displayNames.user} · Agent: ${displayNames.agent}`);
      writeGlance("Usage: /name you <name> · /name agent <name> (saved in preferences)");
      return;
    }
    if (input.startsWith("/name ")) {
      const match = input.slice("/name ".length).match(/^(you|agent)\s+(.+)$/i);
      if (!match) {
        writeGlance("Usage: /name you <name> · /name agent <name>");
        return;
      }
      const [, target, name] = match;
      const trimmed = name!.trim().slice(0, 40);
      if (target!.toLowerCase() === "you") displayNames.user = trimmed;
      else displayNames.agent = trimmed;
      statusState.user = displayNames.user;
      inputBox.title = composerTitle();
      inputBox.titleColor = transcriptBorder;
      renderStatus();
      writeGlance(`Renamed: you are “${displayNames.user}”, the agent is “${displayNames.agent}”`);
      void persistPreferences(async () => {
        preferences.names ??= {};
        preferences.names.user = displayNames.user;
        preferences.names.agent = displayNames.agent;
      });
      return;
    }
    if (input === "/model") {
      setNotice(`${getProvider(activeProvider).label} · ${activeModel}`);
      writeGlance("Pick from all models with /model <query> · Tab completes · choosing a model switches to its provider");
      return;
    }
    if (input === "/mcp" || input === "/mcp add") {
      writeGlance("Usage: /mcp add <name> <url> [scope] · example: /mcp add linear https://mcp.linear.app/mcp read");
      return;
    }
    if (input.startsWith("/mcp add ")) {
      const parts = input.slice("/mcp add ".length).trim().split(/\s+/);
      const [rawName, rawUrl, ...scopeParts] = parts;
      const name = normalizeMcpServerName(rawName ?? "");
      const scope = scopeParts.join(" ") || "read";
      if (!name || !rawUrl) {
        writeGlance("Usage: /mcp add <name> <url> [scope]");
        return;
      }
      try {
        // Validate early for a clearer command error.
        new URL(rawUrl);
      } catch {
        writeGlance("MCP URL must be an absolute URL, e.g. https://mcp.linear.app/mcp");
        return;
      }
      busy = true;
      composer.blur();
      setNotice(`Waiting for ${name} MCP sign-in…`);
      try {
        await loginMcpOAuth({ key: name, serverUrl: rawUrl, scope }, (url) => {
          writeScrollback(glance(`${name} MCP sign-in URL (a browser should open): ${url}`, columns()), transcriptColors.tool);
        });
        preferences.mcpServers ??= {};
        preferences.mcpServers[name] = { url: rawUrl, scope };
        await savePreferences(preferences);
        const count = await registerMcpServerTools({ name, url: rawUrl, scope });
        setNotice("ready");
        writeGlance(`${name} MCP added · ${count} tools available`);
      } catch (error) {
        setNotice(`${name} MCP add failed`);
        writeGlance(`${name} MCP add failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        busy = false;
        composer.focus();
      }
      return;
    }
    if (input === "/mcp rm") {
      writeGlance("Usage: /mcp rm <name>");
      return;
    }
    if (input.startsWith("/mcp rm ")) {
      const name = normalizeMcpServerName(input.slice("/mcp rm ".length));
      if (!name) {
        writeGlance("Usage: /mcp rm <name>");
        return;
      }
      const removed = await removeMcpOAuthCredential(name);
      if (preferences.mcpServers?.[name]) {
        delete preferences.mcpServers[name];
        await savePreferences(preferences);
      }
      writeGlance(removed ? `${name} MCP removed; restart to unload its tools` : `${name} MCP was not signed in`);
      return;
    }
    if (input === "/login codex" || input === "/login openai-codex" || input === "/login openai_codex") {
      busy = true;
      composer.blur();
      setNotice("Waiting for OpenAI sign-in…");
      try {
        await loginCodex((url) => {
          writeScrollback(glance(`OpenAI sign-in URL (a browser should open): ${url}`, columns()), transcriptColors.tool);
        });
        setNotice("ready");
        writeGlance("OpenAI Codex sign-in complete");
      } catch (error) {
        setNotice("OpenAI sign-in failed");
        writeGlance(`OpenAI sign-in failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        busy = false;
        composer.focus();
      }
      return;
    }
    if (input === "/login openrouter" || input === "/login openrouter_api_key") {
      busy = true;
      composer.blur();
      renderer.suspend();
      let saved = false;
      try {
        const apiKey = await readSecret();
        if (!apiKey) {
          writeGlance("OpenRouter key entry cancelled or empty");
        } else {
          await saveApiKey("openrouter", apiKey);
          saved = true;
          writeGlance("OpenRouter API key saved");
        }
      } catch (error) {
        writeGlance(`Could not save OpenRouter key: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        renderer.resume();
        setNotice(saved ? "OpenRouter key saved · /provider openrouter" : "OpenRouter key not changed");
        busy = false;
        composer.focus();
      }
      return;
    }
    if (input.startsWith("/provider ")) {
      const requested = input.slice("/provider ".length).trim().toLowerCase();
      const id = requested === "codex" ? "openai-codex" : requested;
      try {
        const provider = getProvider(id);
        applyModelSelection(provider.id, preferences.models?.[provider.id] ?? provider.defaultModel);
        setNotice(provider.id === "openrouter" && !await provider.isConfigured()
          ? "Use /login openrouter_api_key to connect OpenRouter"
          : `${provider.label} selected`);
        await persistSelection();
      } catch {
        // Not a provider id; maybe a model id, which also selects its provider.
        await selectModel(input.slice("/provider ".length).trim());
      }
      return;
    }
    if (input.startsWith("/model ")) {
      await selectModel(input.slice("/model ".length).trim());
      return;
    }

    const retry = input === "/retry";
    // An interrupted request remains in history. A new message can steer the
    // continuation; /retry is only needed to repeat without adding a message.
    if (retry && !retryable) {
      writeGlance("Nothing to retry · send a message instead");
      return;
    }
    // Claim the turn before the async credential check. Otherwise multiple
    // submits can all see an idle composer and start concurrent model loops.
    busy = true;
    renderStatus();
    const provider = getProvider(activeProvider);
    let configured = false;
    let credentialError = false;
    try {
      configured = await provider.isConfigured();
    } catch (error) {
      credentialError = true;
      setNotice(`Credential check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!configured) {
      if (!credentialError) setNotice(provider.id === "openrouter"
        ? "Sign in with /login openrouter_api_key before using OpenRouter"
        : "Sign in with /login codex before chatting");
      busy = false;
      renderStatus();
      return;
    }

    if (fromQueue) {
      queuedMessages.shift();
      queuedSelected = -1;
      persistQueue();
      renderQueue();
    }
    const turnStart = messages.length;
    if (!retry) {
      messages.push({ role: "user" as const, content: input, ...(images.length ? { images } : {}) });
      showPendingUser(input, images);
    }
    retryable = false;
    const controller = new AbortController();
    turnController = controller;
    try {
      await checkpoint();
      while (true) {
        controller.signal.throwIfAborted();
        const turnText: string[] = [];
        startWorking("model working");
        const result = await provider.stream({
          model: activeModel,
          messages,
          tools: getToolDefinitions(),
          signal: controller.signal,
          onText(chunk) {
            turnText.push(chunk);
          },
        });
        controller.signal.throwIfAborted();
        commitPendingUser();
        statusState.contextUsed = result.inputTokens;
        renderStatus();
        warnContext();
        const answer = turnText.join("");
        if (!result.toolCalls.length) {
          flushToolBatch();
          stopWorking();
          messages.push({ role: "assistant", content: answer });
          await checkpoint();
          if (answer) writeStyledScrollback(markdownBox(answer, columns(), displayNames.agent, transcriptColors.assistant));
          setNotice("ready");
          return;
        }

        messages.push({ role: "assistant", content: answer, toolCalls: result.toolCalls });
        if (answer) {
          flushToolBatch();
          writeStyledScrollback(markdownBox(answer, columns(), displayNames.agent, transcriptColors.assistant));
        }
        for (const call of result.toolCalls) {
          controller.signal.throwIfAborted();
          startWorking(`running ${call.name}`);
          // Time since the previous event (message, tool round, or user send);
          // a 0s call means the model streamed it immediately after the last event.
          const sinceLastEvent = lastEventAt === undefined ? 0 : performance.now() - lastEventAt;
          const toolStartedAt = performance.now();
          let toolResult: string;
          try {
            const parsed = JSON.parse(call.arguments) as unknown;
            if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
              throw new Error("Tool arguments must be a JSON object.");
            }
            toolResult = await executeTool(call.name, parsed as Record<string, unknown>, {
              projectRoot: process.cwd(),
              confirm: confirmTool,
              signal: controller.signal,
            });
          } catch (error) {
            toolResult = `Tool error: ${error instanceof Error ? error.message : String(error)}`;
          } finally {
            approvalBox.visible = false;
            resizeComposer();
          }
          controller.signal.throwIfAborted();
          messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: toolResult });
          // Clear the previous preview before committing it to scrollback.
          // Otherwise the same line briefly appears in both places.
          if (toolBatch.count && toolBatch.label !== toolTarget(call)) flushToolBatch();
          toolBatch.add(call, toolResult, columns(), Math.max(performance.now() - toolStartedAt, sinceLastEvent));
          lastEventAt = performance.now();
          updatePendingTool();
        }
        void readGitStatus(statusState.cwd).then((git) => { statusState.git = git; renderStatus(); });
        await checkpoint();
      }
    } catch (error) {
      flushToolBatch();
      if (controller.signal.aborted) {
        // Drop the unfinished assistant/tool exchange, but keep completed rounds and the user request.
        const pending = messages.findLastIndex((message) => message.role === "assistant" && message.toolCalls?.length);
        if (pending > turnStart) {
          const calls = messages[pending]!.toolCalls!;
          const results = messages.slice(pending + 1);
          if (results.length < calls.length) messages.splice(pending);
        }
        if (pendingDraft) {
          const draft = pendingDraft;
          clearPendingUser();
          const userIndex = messages.findLastIndex((entry) => entry.role === "user" && entry.content === draft.content);
          if (userIndex >= turnStart) messages.splice(userIndex, 1);
          composer.setText(draft.content);
          composer.cursorOffset = draft.content.length;
          draftImages = draft.images;
          updateDraftImages();
          retryable = messages.at(-1)?.role === "user" || messages.at(-1)?.role === "tool";
          writeGlance("Interrupted · message restored to composer");
          setNotice("Interrupted · draft restored");
        } else {
          retryable = messages.at(-1)?.role === "user" || messages.at(-1)?.role === "tool";
          writeGlance(`Interrupted · completed tool actions cannot be undone${retryable ? " · send a message or /retry" : ""}`);
          setNotice("Interrupted · ready");
        }
        await checkpoint();
      } else {
        commitPendingUser();
        const message = error instanceof Error ? error.message : String(error);
        // Keep complete tool rounds, discard only an incomplete tool-call exchange.
        const pending = messages.findLastIndex((entry) => entry.role === "assistant" && entry.toolCalls?.length);
        if (pending >= 0) {
          const calls = messages[pending]!.toolCalls!;
          if (messages.slice(pending + 1).length < calls.length) messages.splice(pending);
        }
        retryable = messages.at(-1)?.role === "user" || messages.at(-1)?.role === "tool";
        await checkpoint();
        const contextHint = /context.{0,30}(length|limit|window|large|exceed)|(?:token|prompt).{0,30}(limit|large|exceed)|maximum context/i.test(message)
          ? " · context limit: use /new to start fresh" : "";
        writeGlance(`Provider error · ${message}${contextHint}${retryable ? " · send a message or /retry (message saved)" : ""}`);
        setNotice("Provider error · see scrollback");
      }
    } finally {
      flushToolBatch();
      stopWorking();
      turnController = undefined;
      busy = false;
      renderStatus();
      resolveToolConfirmation = undefined;
      approvalBox.visible = false;
      resizeComposer();
      composer.focus();
      // A cancelled or failed turn must not strand its queued follow-ups.
      // Start the next send synchronously, claiming busy before any await.
      sendNextQueued();
    }
  }

  async function pasteImage(): Promise<void> {
    try {
      const image = await readClipboardImage();
      const marker = imageMarker(draftImages.length);
      draftImages.push(image);
      composer.insertText(marker);
      updateDraftImages();
      writeGlance(`Attached ${image.mimeType} image (${Math.round(image.data.length * 3 / 4 / 1024)} KiB) · Enter to send`);
    } catch (error) {
      writeGlance(`Image paste failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function updateDraftImages(): void {
    inputBox.title = composerTitle();
    composer.placeholder = "";
    renderStatus();
  }

  composer = new TextareaRenderable(renderer, {
    id: "composer",
    width: "100%",
    height: 1,
    wrapMode: "word",
    placeholder: "",
    placeholderColor: "#747C91",
    backgroundColor: "transparent",
    focusedBackgroundColor: "transparent",
    textColor: "#8BD5CA",
    cursorColor: "#8BD5CA",
    onContentChange: () => {
      scheduleComposerResize();
      void updateCompletions(composer.plainText);
    },
    keyBindings: [
      { name: "return", action: "submit" },
      { name: "j", ctrl: true, action: "newline" },
    ],
    onSubmit: () => {
      const message = composer.plainText;
      if (!message.trim() && !draftImages.length) return;
      // Slash commands manage the draft but must not silently consume its images.
      const command = message.trim().startsWith("/");
      const images = command ? [] : draftImages;
      composer.setText("");
      if (!command) {
        draftImages = [];
        updateDraftImages();
      }
      // Editing a queued card resubmits it in place; anything else appends to the queue.
      if (queuedEditing >= 0) {
        const index = queuedEditing;
        queuedEditing = -1;
        queuedMessages[index] = { content: message.trim(), ...(images.length ? { images } : {}) };
        persistQueue();
        renderQueue();
        writeGlance(`Updated queued message · sends when the current turn ends (${queuedMessages.length} queued)`);
        sendNextQueued();
        return;
      }
      void handleInput(message, false, images);
    },
  });
  renderer.keyInput.on("keypress", (key) => {
    if (resolveToolConfirmation) {
      // Global handlers run before the editor. Consume the answer before
      // refocusing it so the same key cannot be inserted into the draft.
      key.preventDefault();
      if (key.name !== "y" && key.name !== "n" && key.name !== "escape" && key.name !== "esc") return;
      const resolve = resolveToolConfirmation;
      resolveToolConfirmation = undefined;
      approvalBox.visible = false;
      resizeComposer();
      if (key.name === "escape" || key.name === "esc") {
        turnController?.abort();
        stopWorking();
        setNotice("Stopping…");
        resolve(false);
      } else {
        const approved = key.name === "y";
        setNotice(approved ? "Approved · running tool" : "Denied · returning result to model");
        if (approved) startWorking("running tool");
        composer.focus();
        resolve(approved);
      }
      return;
    }
    if (key.name === "v" && key.ctrl) {
      key.preventDefault();
      void pasteImage();
      return;
    }
    if (queuedMessages.length && key.alt && key.name === "up") {
      key.preventDefault();
      selectQueue();
      return;
    }
    if (queuedMessages.length && key.alt && (key.name === "down" || key.name === "return")) {
      key.preventDefault();
      editQueued();
      return;
    }
    if (queuedMessages.length && key.alt && key.name === "backspace") {
      key.preventDefault();
      removeQueued();
      return;
    }
    if ((key.name === "escape" || key.name === "esc") && turnController) {
      // Esc while editing a queued card cancels the edit instead of the turn.
      if (queuedEditing >= 0) {
        key.preventDefault();
        cancelQueuedEdit();
        return;
      }
      turnController.abort();
      stopWorking();
      setNotice("Stopping…");
    }
  });
  composer.onKeyDown = (key) => {
    if ((key.name === "escape" || key.name === "esc") && queuedEditing >= 0) {
      key.preventDefault();
      cancelQueuedEdit();
      return;
    }
    const textBeforeCursor = composer.plainText.slice(0, composer.cursorOffset);
    const textAfterCursor = composer.plainText.slice(composer.cursorOffset);
    const atFirstLine = !textBeforeCursor.includes("\n");
    const atLastLine = !textAfterCursor.includes("\n");
    if (completionChoices.length > 0 && (key.name === "up" || key.name === "down")
      && (key.name === "up" ? atFirstLine : atLastLine)) {
      key.preventDefault();
      moveCompletion(key.name === "down" ? 1 : -1);
      return;
    }
    if ((key.name === "up" || key.name === "down") && !key.ctrl && !key.alt
      && (key.name === "up" ? atFirstLine : atLastLine)) {
      const history = messages.filter((message) => message.role === "user").map((message) => message.content);
      if (!history.length) return;
      key.preventDefault();
      if (historyIndex < 0) {
        if (key.name === "down") return;
        historyDraft = composer.plainText;
        historyIndex = history.length;
      }
      historyIndex = Math.max(0, Math.min(history.length, historyIndex + (key.name === "up" ? -1 : 1)));
      composer.setText(historyIndex === history.length ? historyDraft : history[historyIndex]!);
      composer.cursorOffset = composer.plainText.length;
      return;
    }
    if (completionChoices.length > 0 && key.name === "return") {
      const choice = completionChoices[completionIndex]!;
      const currentInput = composer.plainText;
      if (currentInput.startsWith("/model ") && choice.insert.length > "/model ".length) {
        key.preventDefault();
        composer.setText("");
        completionChoices = [];
        completionSuppressedInput = undefined;
        renderCompletions();
        void selectModel(choice.insert.slice("/model ".length));
        return;
      }
      if ((currentInput.startsWith("/provider ") && choice.insert.length > "/provider ".length)
        || (currentInput.startsWith("/login ") && choice.insert.length > "/login ".length)) {
        key.preventDefault();
        const selected = choice.insert;
        composer.setText("");
        completionChoices = [];
        completionSuppressedInput = undefined;
        void handleInput(selected);
        return;
      }
      if (currentInput.startsWith("/") && !currentInput.includes(" ")) {
        key.preventDefault();
        if (["/help", "/new", "/retry", "/paste-image"].includes(choice.insert)) {
          composer.setText("");
          completionChoices = [];
          void handleInput(choice.insert);
        } else {
          completionSuppressedInput = undefined;
          composer.setText(choice.insert);
        }
      }
    }
    if (key.name === "tab" && completionChoices.length > 0) {
      key.preventDefault();
      if (composer.plainText === completionSuppressedInput) moveCompletion(1);
      completionSuppressedInput = completionChoices[completionIndex]!.insert;
      composer.setText(completionSuppressedInput);
      composer.cursorOffset = completionSuppressedInput.length;
      renderCompletions();
    }
  };

  footer.add(pendingUserView);
  footer.add(pendingToolView);
  footer.add(activityView);
  footer.add(activitySpacer);
  footer.add(completionView);
  footer.add(approvalBox);
  footer.add(queuedView);
  inputBox.add(composer);
  footer.add(inputBox);
  footer.add(status);
  renderer.root.add(footer);
  renderer.on("resize", resizeComposer);
  renderer.setFrameCallback(async () => { if (!statusClosed) resizeComposer(); });
  resizeComposer();
  composer.focus();
  process.stderr.write("Terminal UI ready. Type a message or /help.\n");

  // Credential checks may refresh an expired OAuth token over the network.
  // Keep the prompt usable while that happens instead of blocking renderer startup.
  const selectedProvider = getProvider(activeProvider);
  void selectedProvider.isConfigured().then((configured) => {
    if (activeProvider !== selectedProvider.id || statusClosed) return;
    if (!configured) setNotice(`Not connected | /login ${selectedProvider.id === "openai-codex" ? "openai_codex" : "openrouter_api_key"}`);
  }).catch((error) => {
    if (activeProvider !== selectedProvider.id || statusClosed) return;
    const detail = error instanceof Error ? error.message : String(error);
    setNotice(`Credential check failed: ${detail}`);
  });

  writeGlance(`maekress · ${providers.map((provider) => provider.id).join(", ")} · /help`);
  writeGlance(`Session: ${session.id}${resumed ? " (resumed)" : ""}`);
  if (resumed) for (const entry of historyEntries(messages, columns(), displayNames)) {
    if (entry.styled) writeStyledScrollback(entry.styled);
    else writeScrollback(entry.text, transcriptColors[entry.role]);
  }
}
