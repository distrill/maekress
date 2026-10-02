# maekress

A small, hackable AI coding harness for the terminal. Maekress owns its chat loop,
tool execution, session state, and UI so you can understand—and change—the pieces
that make an agent useful for your projects.

> **Experimental.** This is a personal project under active development. Review
> tool activity and do not treat its approval checks as a security boundary.

## Features

- Streaming chat with OpenAI Codex, OpenRouter, and Anthropic
- A terminal UI built with OpenTUI, designed to work well in tmux
- Built-in project tools for reading, searching, editing files, and running commands
- Interactive approval for sensitive paths and potentially risky commands
- Persistent sessions, retries, queued messages, clipboard image attachments, and Git/context status
- Session-backed todo lists with styled pending, active, and completed states
- Read-only subagents for bounded inspection, research, and analysis
- MCP server connections and project-local agent guidance and skills

## Requirements

- Node.js **26.4+**
- A terminal that supports color; tmux is recommended
- An account or API key for at least one supported provider

OpenTUI currently requires Node's experimental FFI support. The start script
includes the necessary runtime flags.

## Install and run

```sh
git clone <your-fork-url> maekress
cd maekress
npm install
npm start
```

Run from the project you want the agent to work in. To restore the most recent session:

```sh
npm start -- restore
```

To restore a specific session:

```sh
npm start -- restore <session_id>
```

## Connect a provider

Start maekress, then use one of these commands:

```text
/provider add codex       Sign in with OpenAI in a browser
/provider add openrouter  Save an OpenRouter API key
/provider add anthropic   Save an Anthropic API key
/model                    Browse and select a model
```

Credentials are stored locally in `~/.config/maekress/auth.json` with restrictive
permissions. They are not stored in this repository. `OPENROUTER_API_KEY` and
`ANTHROPIC_API_KEY` are supported as environment-variable fallbacks.

The Codex connection uses an undocumented client transport and may break as that
transport changes.

## Using the TUI

Type `/help` in the app for the complete reference. The essentials:

| Action | Shortcut / command |
| --- | --- |
| Send a message | `Enter` |
| Insert a newline | `Ctrl+J` |
| Stop a turn or command | `Esc` |
| Quit | `Ctrl+C` |
| Browse command suggestions | `/`, arrows, `Tab` |
| Attach a clipboard image | `Ctrl+V` or `/paste-image` |
| Start a fresh session | `/new` |
| Resume/retry a stopped turn | `/retry` |
| Inspect tool output | `/inspect <id>` |

While a turn is running, messages can be queued. Use `Ctrl+K` to select a queued
message, `Ctrl+L` to edit it, and `Ctrl+D` to remove it.

Images must be PNG, JPEG, or WebP and are read from the clipboard of the host
running maekress—not necessarily the machine displaying your terminal over SSH.
Image data is saved with the session so retries can resend it.

## Safety and privacy

- The agent can make direct in-project edits and run routine commands.
- It asks for approval before actions it classifies as risky, but this is a
  convenience safeguard rather than a sandbox. Check commands and diffs.
- Sessions, credentials, and preferences live under `~/.config/maekress/`.
  Sessions may contain prompts, tool output, and image data.
- The complete saved conversation is sent to the selected provider each turn.
  There is currently no automatic context compaction.

## Customization

Maekress intentionally keeps its implementation small and modular:

- `src/tools.ts` — built-in tool definitions and execution
- `src/tui.ts` — terminal UI and interaction loop
- `src/providers/` — provider adapters
- `src/status.ts` — footer status modules
- `src/mcp.ts` — MCP connectivity

Global guidance and skills live in `~/.config/maekress/agents.md` and
`~/.config/maekress/skills/`. Project-specific guidance belongs in
`.maekress/agents.md` and `.maekress/skills/`; more deeply nested guidance takes
precedence for files beneath it.

See [GOALS.md](./GOALS.md) for the project direction.

## Development

Run all tests with:

```sh
node --experimental-ffi --experimental-strip-types --test src/*.test.ts
```
