// Repro: permission prompt visible, mirroring tui.ts layout + resizeComposer exactly.
import { createTestRenderer } from "@opentui/core/testing";
import { BoxRenderable, TextRenderable, TextareaRenderable } from "@opentui/core";
import { footerLayout } from "./src/footer-layout.ts";

const COLS = Number(process.argv[2] ?? 132);
const ROWS = Number(process.argv[3] ?? 40);
const noop = () => {};
const terminal = { columns: COLS, rows: ROWS, write: noop, on: noop, removeListener: noop, hasColors: true, addListener: noop };
const stdin = { resume: noop, pause: noop, on: noop, removeListener: noop, setRawMode: noop, isTTY: false, read: () => null };

const { renderer, flush, captureCharFrame } = await createTestRenderer({
  stdin, stdout: terminal, width: COLS, height: ROWS,
  screenMode: "split-footer", footerHeight: 7,
  externalOutputMode: "capture-stdout", exitOnCtrlC: false, useMouse: false,
});

const footer = new BoxRenderable(renderer, {
  id: "composer-footer", width: "100%", height: "100%",
  flexDirection: "column", paddingX: 1, paddingY: 0, gap: 0,
});
const inputWidth = () => Math.max(1, renderer.width - 2);
const inputBox = new BoxRenderable(renderer, {
  id: "input-box", width: inputWidth(), height: 3, paddingX: 1,
  border: true, borderStyle: "rounded", borderColor: "#8BD5CA",
  title: "You", titleColor: "#8BD5CA",
});
const approvalBox = new BoxRenderable(renderer, {
  id: "approval-box", width: "100%", height: 4, border: true, borderStyle: "rounded",
  borderColor: "#F9E2AF", title: "Permission (y/n)", titleColor: "#F9E2AF",
  flexDirection: "column", overflow: "hidden", visible: false,
});
const approvalText = new TextRenderable(renderer, { content: "", fg: "#E5E9F0", width: "100%", height: 2, wrapMode: "word", flexShrink: 0 });
const approvalHint = new TextRenderable(renderer, { content: "(y/n) · Esc stop", fg: "#F9E2AF", width: "100%", height: 1, flexShrink: 0 });
approvalBox.add(approvalText); approvalBox.add(approvalHint);
const pendingToolView = new TextRenderable(renderer, { content: "", fg: "#A6ADC8", width: "100%", height: 0, flexShrink: 0, wrapMode: "none" });
const activityView = new TextRenderable(renderer, { content: "", fg: "#E5E9F0", width: "100%", height: 1, flexShrink: 0 });
const activitySpacer = new BoxRenderable(renderer, { id: "activity-spacer", width: "100%", height: 1, flexShrink: 0 });
const status = new TextRenderable(renderer, { content: "you@host  ·  gpt-5.1 | OpenAI Codex  ·  ctx: 3%\n~/proj  ·  ✓ clean  ·  main", fg: "#8BD5CA", height: 2, flexShrink: 0 });
const completionView = new TextRenderable(renderer, { content: "", fg: "#A6ADC8", height: 0 });
const queuedView = new BoxRenderable(renderer, { id: "queued-messages", width: "100%", height: 0, flexDirection: "column", alignItems: "center", overflow: "hidden" });
const composer = new TextareaRenderable(renderer, {
  id: "composer", width: "100%", height: 1, wrapMode: "word",
  placeholder: "", placeholderColor: "#747C91",
  backgroundColor: "transparent", focusedBackgroundColor: "transparent",
  textColor: "#E5E9F0", cursorColor: "#8BD5CA",
});

let suggestionLines = 0;
function resizeComposer() {
  inputBox.width = inputWidth();
  const rows = ROWS;
  const editorWidth = Math.max(1, inputWidth() - 4);
  const lines = Math.max(1, composer.editorView.measureForDimensions(editorWidth, rows)?.lineCount ?? composer.lineCount);
  let permissionLines = 0;
  if (approvalBox.visible) {
    approvalText.width = Math.max(1, renderer.width - 4);
    permissionLines = Math.max(1, approvalText.virtualLineCount) + 3;
  }
  const layout = footerLayout(rows, lines, suggestionLines, permissionLines, 0, 1);
  pendingToolView.height = layout.pendingTool;
  activityView.height = layout.activity;
  activitySpacer.height = layout.spacer;
  status.height = layout.status;
  completionView.height = layout.suggestions;
  approvalBox.height = layout.permission;
  composer.height = layout.editor;
  inputBox.height = layout.editor + layout.inputBorder;
  // tui.ts as of today: only the composer is reserved in the split footer.
  if (renderer.footerHeight !== layout.editor + layout.inputBorder) renderer.footerHeight = layout.editor + layout.inputBorder;
}

footer.add(pendingToolView); footer.add(activityView); footer.add(activitySpacer);
footer.add(completionView); footer.add(approvalBox); footer.add(queuedView);
inputBox.add(composer); footer.add(inputBox); footer.add(status);
renderer.root.add(footer);
renderer.on("resize", resizeComposer);
resizeComposer();
composer.focus();
renderer.requestRender();
await flush();

const dump = (label) => {
  const stack = footer.getChildren()
    .map((c) => `${c.id ?? c.constructor.name.replace("Renderable", "")}:h${c.height}${c.visible === false ? "(hidden)" : ""}@y${c.y ?? "?"}`)
    .join(" ");
  const frame = captureCharFrame().split("\n");
  console.log(`\n== ${label} == footerHeight=${renderer.footerHeight} rows=${ROWS} frameLines=${frame.length}`);
  console.log("stack:", stack);
  const marks = frame.map((r, i) => ({ r, i })).filter(({ r }) => /You|Permission|you@host|╭|╰|npm start|·/.test(r));
  console.log(marks.length ? marks.map(({ r, i }) => `row ${i}: |${r}|`).join("\n") : "(no composer/approval rows found in captured frame)");
};

dump("idle");
approvalBox.visible = true;
approvalText.content = "cmd: tmux new-session -d -x 132 -y 40 'npm start'";
resizeComposer();
renderer.requestRender();
await flush();
dump("permission shown");
await renderer.destroy();
process.exit(0);
