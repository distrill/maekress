# Harness goals

Build a personal, hackable AI harness for making games. The harness should make
its model loop, tools, and interface understandable and easy to change rather
than hiding them behind a larger agent framework.

## Starting points

- Chat with OpenAI Codex subscription auth and OpenRouter.
- Own the conversation state and tool execution loop.
- Support local built-in tools and MCP tools through a common tool interface.
- Begin with project inspection and controlled file editing/command execution.
- Grow toward direct creative-tool integrations, starting with Aseprite.
- Keep the UI replaceable so interaction modes and presentation can evolve.
- Preserve native tmux scrollback and copy-mode as a first-class interaction.

## Design posture

Keep the first implementation small and observable. Treat provider transport,
authentication, tool definitions, tool execution, and UI as separate pieces.
Run routine in-project edits and commands directly. Ask before risky or
security-sensitive actions. Keep local credentials out of project files and logs.
