import {
  BoxRenderable,
  TextRenderable,
  TextareaRenderable,
  createCliRenderer,
} from "@opentui/core";
import { loginCodex, saveApiKey } from "./auth.ts";
import { getProvider, providers } from "./providers/index.ts";
import type { ModelMessage } from "./providers/types.ts";
import { loadPreferences, savePreferences, type Preferences } from "./preferences.ts";
import { executeTool, getToolDefinitions } from "./tools.ts";
import { newSession, saveSession, type Session } from "./sessions.ts";
import { formatStatus, readGitStatus, type StatusState } from "./status.ts";

const systemPrompt = "You are a practical creative coding assistant helping the user make games. Use the available project tools when they help. Execute routine in-project edits and commands without asking first. Check in before risky, destructive, security-sensitive, or unclear actions; the harness may also request approval for those. Explain your work clearly.";

type Completion = { insert: string; label: string };

function wrapWords(text: string, width: number): string {
  const columns = Math.max(20, width);
  return text.split("\n").map((line) => {
    if (line.length <= columns) return line;
    const leading = line.match(/^\s*/)?.[0] ?? "";
    const words = line.trim().split(/\s+/);
    const rows: string[] = [];
    let current = leading;
    for (const word of words) {
      if (current.trim() && current.length + 1 + word.length > columns) {
        rows.push(current);
        current = "";
      }
      current += (current.trim() ? " " : "") + word;
    }
    rows.push(current);
    return rows.join("\n");
  }).join("\n");
}

function writeMessage(text: string): void {
  process.stdout.write(wrapWords(text, (process.stdout.columns || 80) - 2));
}

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
    process.stdout.write("Could not load saved preferences; using defaults.\n");
  }
  let activeProvider = "openai-codex";
  try {
    if (resumed?.provider || preferences.provider) activeProvider = getProvider(resumed?.provider ?? preferences.provider!).id;
  } catch {
    if (resumed) throw new Error(`Unknown session provider '${resumed.provider}'.`);
    process.stdout.write(`Unknown saved provider '${preferences.provider}'; using OpenAI Codex.\n`);
  }
  let activeModel = resumed?.model ?? preferences.models?.[activeProvider] ?? getProvider(activeProvider).defaultModel;
  const session = resumed ?? newSession(process.cwd(), activeProvider, activeModel, systemPrompt);
  process.stderr.write("Saving session…\n");
  await saveSession(session);
  const initialStatus = "Checking saved credentials…";

  let cleanupStatus = () => {};
  process.stderr.write("Starting terminal UI…\n");
  const renderer = await createCliRenderer({
    screenMode: "split-footer",
    footerHeight: 13,
    externalOutputMode: "capture-stdout",
    exitOnCtrlC: true,
    useMouse: false,
    onDestroy: () => {
      cleanupStatus();
      process.stdout.write(`\nresume with gmkres --resume ${session.id}\n`);
    },
  });

  const footer = new BoxRenderable(renderer, {
    id: "composer-footer",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    paddingX: 1,
    paddingY: 0,
    gap: 0,
  });

  const status = new TextRenderable(renderer, {
    content: initialStatus,
    fg: "#8BD5CA",
    height: 2,
  });

  const completionView = new TextRenderable(renderer, {
    content: "",
    fg: "#A6ADC8",
    height: 7,
  });

  let composer: TextareaRenderable;
  const messages: ModelMessage[] = session.messages;
  let busy = false;
  let turnController: AbortController | undefined;
  let resolveToolConfirmation: ((approved: boolean) => void) | undefined;
  let workingTimer: ReturnType<typeof setInterval> | undefined;
  let workingPhase = "";
  let workingFrame = 0;
  let notice = initialStatus.startsWith("Not connected") || initialStatus.startsWith("Could not") ? initialStatus : "ready";
  let statusClosed = false;
  const statusState: StatusState = {
    cwd: process.cwd(), provider: getProvider(activeProvider).label, model: activeModel,
    activity: notice,
  };
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  function renderStatus(): void {
    if (statusClosed) return;
    statusState.provider = getProvider(activeProvider).label;
    statusState.model = activeModel;
    statusState.activity = workingTimer
      ? `${frames[workingFrame++ % frames.length]} ${workingPhase} · Esc to stop`
      : notice;
    status.content = formatStatus(statusState);
  }
  function setNotice(message: string): void {
    notice = message;
    renderStatus();
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
  cleanupStatus = () => { statusClosed = true; clearInterval(gitTimer); if (workingTimer) clearInterval(workingTimer); };
  let completionChoices: Completion[] = [];
  let completionIndex = 0;
  let completionStart = 0;
  let completionSuppressedInput: string | undefined;
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
    }).catch(() => { modelCatalogs.delete(provider.id); });
  }

  async function checkpoint(): Promise<void> {
    try {
      await saveSession(session);
    } catch (error) {
      setNotice(`Could not save chat: ${error instanceof Error ? error.message : String(error)}`);
      process.stdout.write(`Could not save chat checkpoint: ${error instanceof Error ? error.message : String(error)}\n`);
    }
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
    process.stdout.write(`\n\x1b[1;33mApproval required\x1b[0m\n${message}\nType y to approve or n to deny.\n`);
    stopWorking();
    setNotice(`Approval required · ${message} · y/n`);
    composer.placeholder = "Type y to approve or n to deny, then Enter";
    composer.focus();
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

  function renderCompletions(): void {
    if (!completionChoices.length) {
      completionView.content = "";
      return;
    }
    const { start, visible } = completionWindow();
    const hasMoreAbove = start > 0;
    const hasMoreBelow = start + visible.length < completionChoices.length;
    const rows = visible.map((choice, index) => `${start + index === completionIndex ? "›" : " "} ${choice.label}`);
    if (hasMoreBelow) rows.push("↓ more");
    completionView.content = `${hasMoreAbove ? "↑ more above" : "Suggestions"} · ${completionChoices.length} matches\n${rows.join("\n")}`;
  }

  async function updateCompletions(input: string): Promise<void> {
    if (input === completionSuppressedInput) {
      renderCompletions();
      return;
    }
    completionSuppressedInput = undefined;
    if (!input.startsWith("/")) return showCompletions([], input);
    const commandNames = ["help", "login", "model", "provider"];
    const firstSpace = input.indexOf(" ");
    if (firstSpace < 0) {
      return showCompletions(matchChoices(input.slice(1), commandNames.map((name) => ({ insert: `/${name}${name === "help" ? "" : " "}`, label: `/${name}` }))), input);
    }
    const command = input.slice(0, firstSpace);
    const query = input.slice(firstSpace + 1).trimStart();
    if (command === "/login") {
      const sources = ["openai_codex", "openrouter_api_key"];
      return showCompletions(matchChoices(query, sources.map((source) => ({ insert: `/login ${source}`, label: source }))), input);
    }
    if (command === "/provider") {
      const choices = [
        { insert: "/provider codex", label: "codex · OpenAI Codex" },
        { insert: "/provider openrouter", label: "openrouter · OpenRouter" },
      ];
      return showCompletions(matchChoices(query, choices), input);
    }
    if (command === "/model") {
      const provider = getProvider(activeProvider);
      let catalog = modelCatalogs.get(provider.id);
      if (!catalog) {
        catalog = provider.listModels().catch(() => [{ id: provider.defaultModel, name: provider.defaultModel }]);
        modelCatalogs.set(provider.id, catalog);
      }
      const models = await catalog;
      const choices = models.map((model) => ({ insert: `/model ${model.id}`, label: model.id === model.name ? model.id : `${model.id} · ${model.name}` }));
      const matched = matchChoices(query, choices);
      if (!query) matched.sort((left, right) => Number(right.insert.endsWith(activeModel)) - Number(left.insert.endsWith(activeModel)));
      showCompletions(matched, input);
      return;
    }
    showCompletions([], input);
  }

  async function handleInput(text: string): Promise<void> {
    const input = text.trim();
    if (!input || busy) return;
    if (input === "/help") {
      process.stdout.write("\nCommands: /login openai_codex · /login openrouter_api_key · /provider codex|openrouter · /model MODEL · /help\nKeys: Enter send · Ctrl+J newline · Esc stop · ↑/↓ choose · Tab completes · Ctrl+C quit\nTools: list_files, read_file, search_text; routine file edits and commands run directly. Sensitive paths and potentially risky commands ask for approval (type y or n).\nOpenRouter OAuth login is planned.\n\n");
      return;
    }
    if (input === "/model") {
      setNotice(`${getProvider(activeProvider).label} · ${activeModel}`);
      process.stdout.write(`Current model: ${activeModel}\n\n`);
      return;
    }
    if (input === "/login codex" || input === "/login openai-codex" || input === "/login openai_codex") {
      busy = true;
      composer.blur();
      setNotice("Waiting for OpenAI sign-in…");
      try {
        await loginCodex((url) => {
          process.stdout.write("\nOpenAI sign-in URL (a browser should open):\n");
          process.stdout.write(`${url}\n\n`);
        });
        setNotice("ready");
        process.stdout.write("OpenAI Codex sign-in complete.\n\n");
      } catch (error) {
        setNotice("OpenAI sign-in failed");
        process.stdout.write(`OpenAI sign-in failed: ${error instanceof Error ? error.message : String(error)}\n\n`);
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
          process.stdout.write("OpenRouter key entry cancelled or empty.\n");
        } else {
          await saveApiKey("openrouter", apiKey);
          saved = true;
          process.stdout.write("OpenRouter API key saved in ~/.config/gmkres/auth.json.\n");
        }
      } catch (error) {
        process.stdout.write(`Could not save OpenRouter key: ${error instanceof Error ? error.message : String(error)}\n`);
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
        activeProvider = provider.id;
        activeModel = preferences.models?.[provider.id] ?? provider.defaultModel;
        statusState.contextUsed = undefined;
        statusState.contextLimit = undefined;
        refreshContextLimit();
        setNotice(provider.id === "openrouter" && !await provider.isConfigured()
          ? "Use /login openrouter_api_key to connect OpenRouter"
          : `${provider.label} selected`);
        await persistSelection();
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (input.startsWith("/model ")) {
      activeModel = input.slice("/model ".length).trim();
      statusState.contextUsed = undefined;
      statusState.contextLimit = undefined;
      refreshContextLimit();
      setNotice(activeModel ? "Model updated" : "Model name cannot be empty");
      if (activeModel) await persistSelection();
      return;
    }

    const provider = getProvider(activeProvider);
    if (!await provider.isConfigured()) {
      setNotice(provider.id === "openrouter"
        ? "Sign in with /login openrouter_api_key before using OpenRouter"
        : "Sign in with /login codex before chatting");
      process.stdout.write(`${notice}.\n\n`);
      return;
    }

    const turnStart = messages.length;
    busy = true;
    composer.blur();
    messages.push({ role: "user", content: input });
    process.stdout.write("\n\x1b[1;36mYou\x1b[0m\n");
    writeMessage(input);
    process.stdout.write("\n");
    const controller = new AbortController();
    turnController = controller;
    try {
      while (true) {
        controller.signal.throwIfAborted();
        composer.blur();
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
        statusState.contextUsed = result.inputTokens;
        renderStatus();
        const answer = turnText.join("");
        if (!result.toolCalls.length) {
          stopWorking();
          messages.push({ role: "assistant", content: answer });
          await checkpoint();
          process.stdout.write(`\n\x1b[1;35m${provider.label}\x1b[0m\n`);
          writeMessage(answer);
          process.stdout.write("\n\n");
          setNotice("ready");
          return;
        }

        messages.push({ role: "assistant", content: answer, toolCalls: result.toolCalls });
        if (answer) {
          process.stdout.write(`\n\x1b[1;35m${provider.label}\x1b[0m\n`);
          writeMessage(answer);
          process.stdout.write("\n");
        }
        for (const call of result.toolCalls) {
          controller.signal.throwIfAborted();
          startWorking(`running ${call.name}`);
          process.stdout.write(`\n\x1b[1;34mTool call\x1b[0m ${call.name}\n`);
          writeMessage(call.arguments);
          process.stdout.write("\n");
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
            composer.blur();
            composer.placeholder = "Type a message. Enter sends, Ctrl+J adds a line.";
          }
          controller.signal.throwIfAborted();
          messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: toolResult });
          process.stdout.write(`\x1b[1;34mTool result\x1b[0m ${call.name}\n`);
          writeMessage(toolResult);
          process.stdout.write("\n");
        }
        void readGitStatus(statusState.cwd).then((git) => { statusState.git = git; renderStatus(); });
        await checkpoint();
      }
    } catch (error) {
      if (controller.signal.aborted) {
        // Drop the unfinished assistant/tool exchange, but keep completed rounds and the user request.
        const pending = messages.findLastIndex((message) => message.role === "assistant" && message.toolCalls?.length);
        if (pending > turnStart) {
          const calls = messages[pending]!.toolCalls!;
          const results = messages.slice(pending + 1);
          if (results.length < calls.length) messages.splice(pending);
        }
        process.stdout.write("\nInterrupted. Completed tool actions cannot be undone.\n\n");
        setNotice("Interrupted · ready");
        await checkpoint();
      } else {
        const message = error instanceof Error ? error.message : String(error);
        process.stdout.write(`\n\x1b[1;31mProvider error\x1b[0m\n${message}\n\n`);
        setNotice("Provider error · see scrollback");
        messages.splice(turnStart);
      }
    } finally {
      stopWorking();
      turnController = undefined;
      busy = false;
      resolveToolConfirmation = undefined;
      composer.placeholder = "Type a message. Enter sends, Ctrl+J adds a line.";
      composer.focus();
    }
  }

  composer = new TextareaRenderable(renderer, {
    id: "composer",
    width: "100%",
    height: 4,
    wrapMode: "word",
    placeholder: "Type a message. Enter sends, Ctrl+J adds a line.",
    placeholderColor: "#747C91",
    backgroundColor: "#171923",
    focusedBackgroundColor: "#171923",
    textColor: "#E5E9F0",
    cursorColor: "#8BD5CA",
    onContentChange: () => void updateCompletions(composer.plainText),
    keyBindings: [
      { name: "return", action: "submit" },
      { name: "j", ctrl: true, action: "newline" },
    ],
    onSubmit: () => {
      const message = composer.plainText;
      composer.setText("");
      if (resolveToolConfirmation) {
        const approved = /^(y|yes)$/i.test(message.trim());
        const denied = /^(n|no)$/i.test(message.trim());
        if (!approved && !denied) {
          setNotice("Type y to approve or n to deny, then Enter");
          return;
        }
        const resolve = resolveToolConfirmation;
        resolveToolConfirmation = undefined;
        composer.blur();
        composer.placeholder = "Type a message. Enter sends, Ctrl+J adds a line.";
        setNotice(approved ? "Approved · running tool" : "Denied · returning result to model");
        if (approved) startWorking("running tool");
        resolve(approved);
        return;
      }
      void handleInput(message);
    },
  });
  renderer.keyInput.on("keypress", (key) => {
    if (key.name !== "escape" && key.name !== "esc") return;
    if (resolveToolConfirmation) {
      const resolve = resolveToolConfirmation;
      resolveToolConfirmation = undefined;
      turnController?.abort();
      stopWorking();
      setNotice("Stopping…");
      resolve(false);
    } else if (turnController) {
      turnController.abort();
      stopWorking();
      setNotice("Stopping…");
    }
  });
  composer.onKeyDown = (key) => {
    if (completionChoices.length > 0 && (key.name === "up" || key.name === "down")) {
      key.preventDefault();
      moveCompletion(key.name === "down" ? 1 : -1);
      return;
    }
    if (completionChoices.length > 0 && key.name === "return") {
      const choice = completionChoices[completionIndex]!;
      const currentInput = composer.plainText;
      if (currentInput.startsWith("/model ") && choice.insert.length > "/model ".length) {
        key.preventDefault();
        activeModel = choice.insert.slice("/model ".length);
        statusState.contextUsed = undefined;
        statusState.contextLimit = undefined;
        refreshContextLimit();
        setNotice("Model selected");
        void persistSelection();
        composer.setText("");
        completionChoices = [];
        completionSuppressedInput = undefined;
        renderCompletions();
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
        if (choice.insert === "/help") {
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

  footer.add(composer);
  footer.add(completionView);
  footer.add(status);
  renderer.root.add(footer);
  composer.focus();
  process.stderr.write("Terminal UI ready. Type a message or /help.\n");

  // Credential checks may refresh an expired OAuth token over the network.
  // Keep the prompt usable while that happens instead of blocking renderer startup.
  const selectedProvider = getProvider(activeProvider);
  void selectedProvider.isConfigured().then((configured) => {
    if (activeProvider !== selectedProvider.id || statusClosed) return;
    setNotice(configured
      ? `${selectedProvider.label} connected`
      : `Not connected | /login ${selectedProvider.id === "openai-codex" ? "openai_codex" : "openrouter_api_key"}`);
  }).catch((error) => {
    if (activeProvider !== selectedProvider.id || statusClosed) return;
    const detail = error instanceof Error ? error.message : String(error);
    setNotice(`Credential check failed: ${detail}`);
    process.stdout.write(`Credential check failed: ${detail}\n`);
  });

  process.stdout.write("\x1b[1;35mGMKRES\x1b[0m — tmux scrollback prototype\n");
  process.stdout.write(`Providers: ${providers.map((provider) => provider.id).join(", ")}\n`);
  process.stdout.write("Use /login openai_codex, /provider openrouter, /model MODEL, or /help.\n\n");
  process.stdout.write(`Session: ${session.id}${resumed ? " (resumed)" : ""}\n`);
  if (resumed) process.stdout.write(`Restored ${messages.length - 1} messages. Ask for a recap if needed.\n\n`);
}
