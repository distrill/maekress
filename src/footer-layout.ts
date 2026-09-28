// Keep the split footer inside the terminal, leaving a scrollback row when possible.
// `editor` is the *desired* editor height; `editorRows` clamps it to the terminal so
// callers can keep the split footer (which can grow beyond this layout) in bounds.
export function footerLayout(rows: number, draftLines: number, suggestionLines: number, permissionLines: number, queuedLines = 0, pendingToolLines = 0) {
  const capacity = Math.max(1, rows - 1);
  // On tiny terminals, prioritize the composer and permission prompt over decoration.
  const inputBorder = Math.min(2, Math.max(0, capacity - 1));
  let remaining = capacity - inputBorder - 1; // at least one editor row
  const permission = Math.min(permissionLines, remaining); // border + fixed key-hint row before body growth
  remaining -= permission;
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
  return {
    permission, queued, pendingTool, status, activity, spacer, suggestions, editor,
    inputBorder,
    editorRows: Math.min(editor, remaining + 1),
    // This is the rendered footer height, so it must use the clamped editor
    // size. The desired `editor` value is retained for future resize passes.
    height: permission + queued + pendingTool + status + activity + spacer + suggestions
      + Math.min(editor, remaining + 1) + inputBorder,
  };
}
