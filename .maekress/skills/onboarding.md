# Maekress onboarding

Use this skill to give a concise, practical tour of maekress. Tailor the depth to
what the user asks, but cover the workflow below before diving into advanced
customization.

## Start here

- Run `npm start` from the project directory you want the harness to work in.
- Type `/` to browse commands and project skills. Use the arrow keys to select a
  suggestion, `Tab` to complete it, and `Enter` to select or run it.
- Send a message with `Enter`; insert a newline with `Ctrl+J`.
- `Esc` stops an active model turn or command. `Ctrl+C` quits.
- Use `/help` any time for the in-app reference.

## Providers and models

Connect a provider from inside the TUI:

```text
/provider add codex       Sign in with OpenAI in a browser
/provider add openrouter  Save an OpenRouter API key
/provider add anthropic   Save an Anthropic API key
/provider rm <name>       Remove that provider's stored credential
```

Then run `/model` to browse all available models, or `/model <query>` to narrow
choices. Choosing a model also switches to its provider. Credentials are kept
locally in `~/.config/maekress/auth.json`; OpenRouter and Anthropic also support
`OPENROUTER_API_KEY` and `ANTHROPIC_API_KEY` environment-variable fallbacks.

## Everyday agent workflow

1. Ask for a task in plain language. The agent can inspect files, make routine
   project edits, and run routine commands directly.
2. Check the compact tool summaries in scrollback. Use `/inspect <id>` to open
   the detailed output or diff for a tool call or subagent result. Recent inspect
   IDs are offered as completions after typing `/inspect `.
3. Review approval prompts carefully. Potentially risky commands and sensitive
   paths ask for confirmation: press `y` to approve, `n` to deny, or `Esc` to
   cancel the turn.
4. For work with several steps, ask the agent to maintain a todo list. The footer
   shows pending, active, and completed items; completed items are muted and
   struck through.

Approval is a convenience safeguard, not a sandbox. Always review commands and
diffs, especially in repositories with valuable or sensitive data.

## Queue follow-ups while the agent works

You do not need to wait for a turn to finish. Type a follow-up and press `Enter`
to queue it; queued messages send in order when the current turn ends or is
interrupted.

- `Ctrl+K` — select/cycle queued messages
- `Ctrl+L` — edit the selected queued message; `Enter` saves it
- `Ctrl+D` — remove the selected queued message
- `Esc` — cancel a queued-message edit and retain the original

## Sessions and retries

- `/new` saves the current session and starts a fresh one in the same project.
- `/retry` continues after an interrupted or failed turn without sending the
  message again.
- To resume from the shell, run `npm start -- --resume <resume_id>` from the same
  project directory.

Sessions are stored under `~/.config/maekress/sessions/` and can contain prompts,
tool results, and attached image data. The full saved conversation is sent to the
selected provider on subsequent turns; there is no automatic context compaction.

## Images and input history

- `Ctrl+V` or `/paste-image` attaches a PNG, JPEG, or WebP from the local host
  clipboard (up to 5 MiB). A vision-capable model is required.
- Over SSH or tmux, the clipboard is read on the machine running maekress, not
  necessarily the machine displaying the terminal.
- At the first/last input line, use `Up`/`Down` to move through previously sent
  messages. Otherwise those keys move within multi-line input.

## MCP, guidance, skills, and subagents

- Add an MCP server with `/mcp add <name> <url> [scope]`; remove one with
  `/mcp rm <name>`. Use `/mcp` to see the expected syntax.
- Project guidance lives in `.maekress/agents.md`; project skills live in
  `.maekress/skills/`. Global equivalents live in `~/.config/maekress/`.
  More deeply nested guidance applies to files below it and takes precedence.
- Run a skill with `/<skill-name>`; command completion lists available skills.
- The agent can delegate bounded inspection, research, or analysis to a read-only
  subagent. Subagents receive only their task and minimal handoff context; they
  cannot edit files, run commands, or delegate further.

## Status and scrollback

The footer shows the selected model/provider, context usage when available, and
Git state for the current project. The main transcript remains ordinary terminal
scrollback, so tmux copy mode works naturally. Compact tool summaries keep the
conversation readable; use `/inspect` whenever you need the full detail.
