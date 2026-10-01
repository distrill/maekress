# maekress Harness

A personal, hackable harness for making games. See [GOALS.md](./GOALS.md) for
the longer-term direction.

## Current state

The first slices are provider-backed chat, a harness-owned tool loop, and a
tmux-oriented TUI prototype.
The TUI uses OpenTUI's split-footer mode so settled messages go into normal
terminal scrollback while the composer stays live at the bottom. The current
provider adapters stream text and function calls from OpenAI Codex and
OpenRouter. The harness executes registered tools, returns results to the
model, and repeats until the model responds normally, without a fixed tool-round
limit. The main agent can delegate bounded, independent inspection, research, and
analysis to an isolated read-only subagent. A subagent receives only its task and
an optional minimal handoff, has no access to the main transcript, cannot recurse,
and returns a concise report; it cannot edit files or run commands. Routine shell commands and file edits run directly; sensitive paths and
potentially risky commands require approval in the TUI. MCP connectivity is a
later step. See [TODO.md](./TODO.md) for planned improvements.

OpenAI Codex sign-in uses a browser OAuth flow and stores tokens in
`~/.config/maekress/auth.json` with restrictive file permissions. This is a
third-party harness integration against the Codex client transport, not a
published API contract, so it may change or stop working. Save OpenRouter API
keys with `/login openrouter_api_key`; optionally set `OPENROUTER_MODEL`.
Set `CODEX_MODEL` to override the Codex default model.
The Codex transport advertises client version `0.156.1` by default so newer
catalog models are discoverable; override it with `CODEX_CLIENT_VERSION` if
needed.
The selected provider and per-provider model are saved in
`~/.config/maekress/config.json`.

## Agent guidance and skills

User-wide guidance and skills live in `~/.config/maekress/agents.md` and
`~/.config/maekress/skills/`. Project guidance and skills live in
`.maekress/agents.md` and `.maekress/skills/`. A project may place
`.maekress/agents.md` in subdirectories: when working on a file, apply each
applicable instruction file from the project root through that file's directory,
with the closest guidance taking precedence. The global guidance supplies
defaults for every project.

Project tools include file listing, chunked reading (using character `offset`
and `limit`), and text search. Routine file creation, unified-diff patching,
exact-text edits, and shell commands run without a prompt; sensitive paths and
potentially risky commands require interactive approval. The command check is
heuristic, not a security sandbox. File tools stay inside the project root;
patching can optionally check a SHA-256 to reject stale edits. Built-in and
future MCP tools share the `HarnessTool` interface and can be added with
`registerTool`.

## Run

Requires Node.js 26.4 or newer. OpenTUI currently needs Node's experimental
FFI flag to load its native renderer.

```sh
npm install
npm start
```

Inside the TUI, type `/` to get inline command suggestions (arrow keys to choose, Tab to complete, Enter to run). Use `Enter` to submit a message, `Ctrl+J` for a newline, `Esc`
to interrupt an active model turn or shell command, and `Ctrl+C` to quit.
Use `Ctrl+V` or `/paste-image` to attach an image from the **local host clipboard**
(PNG, JPEG, or WebP, up to 5 MiB). The input title shows the attachment count;
`[image 01]` is a display marker, not the data sent to the model. Submit with
`Enter` (with or without text). Image bytes are saved in the private session
JSON so retry and resume can send them again; this increases session file size.
A vision-capable model is required. In tmux or over SSH, the clipboard read
runs on the host running maekress, not in the terminal client; terminal paste of
an image by itself may not carry image bytes. Use the explicit shortcut or
command when the image is in that host clipboard.
The scrollback shows right-aligned user boxes, left-aligned assistant boxes, and
single-line tool summaries instead of tool arguments and results. Resuming a
session reconstructs this compact view from saved messages; full tool results
remain in the session for the model.
The first footer line shows `user@host`, model/provider, and `ctx: N%` when both
the provider-reported input token count and model context limit are known. An
animated working icon appears at the end of that line only while busy. In a Git
repository, a second line shows the working directory (with home abbreviated to `~`), compact file counts (`'` modified, `-` deleted, `+` added/untracked; zeros
omitted) or `✓ clean`, then
the branch name. Context percentage uses the last request size, not cumulative
usage or a prediction for the next turn. Unknown values are hidden rather than estimated. Use `/help` for key hints. Customize or extend these small modules in `src/status.ts`:
add a function to `statusModules` and its id to `statusOrder`, or reorder/remove
ids there. Git status refreshes in the background. The harness currently sends
the full saved conversation each turn and does not compact it; provider usage
alone does not solve context exhaustion. At 85%, 90%, and 95% of the model's
known context limit, one-time notices appear and the status line changes from
amber to red. These warnings use the last provider-reported request size, not
an estimate of the next turn; they do not block sending. Use `/new` to save the
current session and start a fresh one in the same project with the selected
provider/model; the old resume ID is printed. After a provider error or an
interrupted request, the submitted message and completed tool rounds are saved;
send another message to steer the continuation, or use `/retry` to continue without
sending the message twice. Messages queued during a turn are sent in order when
that turn ends, including after an interruption. Context-limit errors
also suggest `/new`. No automatic compaction occurs. Input and scrollback messages
wrap at word boundaries. Interruption cannot undo tool
operations that have already completed. On exit, the TUI prints `resume with maekress --resume <resume_id>`.
Run that command from the same project directory to restore the chat and its selected
provider/model. Sessions are saved under `~/.config/maekress/sessions/` after
completed turns; an interrupted turn may need to be sent again. Draft text and
previous terminal scrollback are not restored.
Submitted messages remain in the terminal's scrollback, so tmux copy mode
(`prefix` then `[`) can inspect earlier entries.

Use `/login openai_codex` to sign in, `/provider codex` or `/provider openrouter` to
switch providers, and `/model MODEL` to choose a model. OpenRouter keys are
stored in the same private auth file as Codex credentials. `OPENROUTER_API_KEY`
remains supported as an environment-variable fallback.
