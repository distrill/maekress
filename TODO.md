## features
- [ ] subagents
- [ ] todo lists
- [ ] ask clarifying questions
- [ ] worktrees babyyyy
- [ ] diffs || expanded mode

## papercuts
- [ ] general "make it look good"
- [ ] interactive scroll back, show hide thinking etc, expand something to full screen (for terminal multiline copy)
- [ ] retry on error?
- [ ] better git integration
- [ ] log failures and improve them
- [ ] we get stuck sometimes. why. what's going on
- [ ] i want modes so that i can auto accept risky tool calls. probably except for _super_ risky ones

## donezel
- [x] mcp support
- [x] web search
- [x] it doesn't load models? i authed on a new computer and /model doesn't populate anything
- [x] risky tool approval renders too low. sometimes it's cut off, and even when it's not it's too low. it should be above the input but it covers the input
- [x] rm 12 tool limit
- [x] auto execute commands, ask for confirmation only when they look _sketchy guy_
- [x] linebreak on word
- [x] spinner to show "model working"
- [x] let me interrupt commands in flight \[esc\]
- [x] show cwd / git / model / activity on bottom status bar
- [x] show last provider-reported input tokens and model context limit when available
- [x] let me queue messages during a turn (send in order after completion/interruption)
- [x] fold consecutive tool calls by tool and target in scrollback; preview current group above activity
- [x] warn about compaction/context exhaustion handling
- [x] keep the permission modal (y/n) prompt visible when its message wraps
- [x] rename (at least in the display) run_command to cmd
- [x] local clipboard image paste (Ctrl+V or /paste-image; host clipboard, not terminal transport)
- [x] hitting "y" in a confirmation prompt does but should not fill the input box
- [x] persist queued messages across restart and allow editing/removing queued messages
- [x] render markdown
- [x] too many lines in the input box scrolls the input. that's weird, should grow to accommodate instead
- [x] it looks like on restore it calls agent "assistant". let's rename to "agent"
- [x] i want to be able to rename myself and the agent
- [x] queued message should have variable height. and the whole thing, including contents, should be the same "faded gray" color
- [x] every toolcall says 0s. it should probably be like "time since last thing
- [x] /new should clear the chat history in the screen. right now it just prints a new session id
- [x] model selection is weird. you shouldn't have to specify a provider, /model should show all model options, along with their providers, and selecting the model should also set the associated provider.
- [x] timer showing how long worked
- [x] up arrow should move up inside of the current message input if there is a line above. only at the top should it move to the previous message
- [x] up to go through previous messages

- [-] explore cmd palette
