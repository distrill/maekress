# Gmkres Harness

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
limit. Routine shell commands and file edits run directly; sensitive paths and
potentially risky commands require approval in the TUI. MCP connectivity is a
later step. See [TODO.md](./TODO.md) for planned improvements.

OpenAI Codex sign-in uses a browser OAuth flow and stores tokens in
`~/.config/gmkres/auth.json` with restrictive file permissions. This is a
third-party harness integration against the Codex client transport, not a
published API contract, so it may change or stop working. Save OpenRouter API
keys with `/login openrouter_api_key`; optionally set `OPENROUTER_MODEL`.
Set `CODEX_MODEL` to override the Codex default model.
The Codex transport advertises client version `0.156.1` by default so newer
catalog models are discoverable; override it with `CODEX_CLIENT_VERSION` if
needed.
The selected provider and per-provider model are saved in
`~/.config/gmkres/config.json`.

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

Inside the TUI, use `Enter` to submit a message, `Ctrl+J` for a newline, `Esc`
to interrupt an active model turn or shell command, and `Ctrl+C` to quit.
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
alone does not solve context exhaustion. Input and scrollback messages
wrap at word boundaries. Interruption cannot undo tool
operations that have already completed. On exit, the TUI prints `resume with gmkres --resume <resume_id>`.
Run that command from the same project directory to restore the chat and its selected
provider/model. Sessions are saved under `~/.config/gmkres/sessions/` after
completed turns; an interrupted turn may need to be sent again. Draft text and
previous terminal scrollback are not restored.
Submitted messages remain in the terminal's scrollback, so tmux copy mode
(`prefix` then `[`) can inspect earlier entries.

Use `/login openai_codex` to sign in, `/provider codex` or `/provider openrouter` to
switch providers, and `/model MODEL` to choose a model. OpenRouter keys are
stored in the same private auth file as Codex credentials. `OPENROUTER_API_KEY`
remains supported as an environment-variable fallback.
