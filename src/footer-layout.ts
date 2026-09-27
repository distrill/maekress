// Keep the split footer inside the terminal, leaving a scrollback row when possible.
export function footerLayout(rows: number, draftLines: number, suggestionLines: number, permissionLines: number) {
  const capacity = Math.max(1, rows - 1);
  // On tiny terminals, prioritize the composer and permission prompt over decoration.
  const inputBorder = Math.min(2, Math.max(0, capacity - 1));
  let remaining = capacity - inputBorder - 1; // at least one editor row
  const permission = Math.min(permissionLines, remaining);
  remaining -= permission;
  const status = Math.min(2, remaining);
  remaining -= status;
  const activity = Math.min(1, remaining);
  remaining -= activity;
  const spacer = Math.min(1, remaining);
  remaining -= spacer;
  const suggestions = Math.min(suggestionLines, remaining);
  remaining -= suggestions;
  const editor = Math.min(Math.max(1, draftLines), remaining + 1);
  return {
    permission, status, activity, spacer, suggestions, editor,
    inputBorder,
    height: permission + status + activity + spacer + suggestions + editor + inputBorder,
  };
}
