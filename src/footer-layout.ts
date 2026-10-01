// Keep the split footer inside the terminal, leaving a scrollback row when possible.
// `editor` is the *desired* editor height; `editorRows` clamps it to the terminal so
// callers can keep the split footer (which can grow beyond this layout) in bounds.
export function footerLayout(rows: number, draftLines: number, suggestionLines: number, permissionLines: number, queuedLines = 0, pendingToolLines = 0, pendingUserLines = 0, pendingInspectLines = 0, todoLines = 0) {
  const capacity = Math.max(1, rows - 1);
  // On tiny terminals, prioritize the composer and permission prompt over decoration.
  const inputBorder = Math.min(2, Math.max(0, capacity - 1));
  let remaining = capacity - inputBorder - 1; // at least one editor row
  const permission = Math.min(permissionLines, remaining); // border + fixed key-hint row before body growth
  remaining -= permission;
  const pendingUser = Math.min(pendingUserLines, remaining);
  remaining -= pendingUser;
  const todos = Math.min(todoLines, remaining);
  remaining -= todos;
  const pendingTool = Math.min(pendingToolLines, remaining);
  remaining -= pendingTool;
  const queued = Math.min(queuedLines, remaining);
  remaining -= queued;
  const status = Math.min(2, remaining);
  remaining -= status;
  const activity = Math.min(1, remaining);
  remaining -= activity;
  const spacer = Math.min(1, remaining);
  remaining -= spacer;
  const suggestions = Math.min(suggestionLines, remaining);
  remaining -= suggestions;
  const editor = Math.max(1, draftLines);
  const editorAndInspect = remaining + 1;
  const editorRows = Math.min(editor, editorAndInspect);
  // Inspect previews are lowest priority: keep the composer responsive and let
  // a growing draft consume these rows first. The full inspect record remains
  // available in scrollback when replaced.
  const pendingInspect = Math.min(pendingInspectLines, Math.max(0, editorAndInspect - editorRows));
  return {
    permission, queued, pendingUser, pendingInspect, pendingTool, todos, status, activity, spacer, suggestions, editor,
    inputBorder,
    editorRows,
    height: permission + queued + pendingUser + pendingInspect + pendingTool + todos + status + activity + spacer + suggestions
      + editorRows + inputBorder,
  };
}
