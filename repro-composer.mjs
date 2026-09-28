// Repro: full startup footer, mirroring tui.ts layout.
import { createTestRenderer } from "@opentui/core/testing";
import { BoxRenderable, TextRenderable, TextareaRenderable } from "@opentui/core";
import { footerLayout } from "./src/footer-layout.ts";

const noop = () => {};
const terminal = { columns: 100, rows: 24, write: noop, on: noop, removeListener: noop, hasColors: true, addListener: noop };
const stdin = { resume: noop, pause: noop, on: noop, removeListener: noop, setRawMode: noop, isTTY: false, read: () => null };

const { renderer, flush, captureCharFrame } = await createTestRenderer({
  stdin, stdout: terminal, width: 100, height: 24,
  screenMode: "split-footer", footerHeight: 7,
  externalOutputMode: "capture-stdout", exitOnCtrlC: false, useMouse: false,
});

const transcriptColors = { user: "#8BD5CA", assistant: "#CBA6F7", tool: "#A6ADC8" };

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
const queuedView = new BoxRenderable(renderer, {
  id: "queued-messages", width: "100%", height: 0, flexDirection: "column",
  alignItems: "center", overflow: "hidden",
});
const approvalBox = new BoxRenderable(renderer, {
  id: "approval-box", width: "100%", height: 4, border: true, borderStyle: "rounded",
  borderColor: "#F9E2AF", title: "Permission (y/n)", titleColor: "#F9E2AF",
  flexDirection: "column", overflow: "hidden", visible: false,
});
const approvalText = new TextRenderable(renderer, { content: "", fg: "#E5E9F0", width: "100%", height: 2, wrapMode: "word", flexShrink: 0 });
const approvalHint = new TextRenderable(renderer, { content: "(y/n) · Esc stop", fg: "#F9E2AF", width: "100%", height: 1, flexShrink: 0 });
approvalBox.add(approvalText); approvalBox.add(approvalHint);
const pendingToolView = new TextRenderable(renderer, { content: "", fg: transcriptColors.tool, width: "100%", height: 0, flexShrink: 0, wrapMode: "none" });
const activityView = new TextRenderable(renderer, { content: "", fg: "#E5E9F0", width: "100%", height: 1, flexShrink: 0 });
const activitySpacer = new BoxRenderable(renderer, { id: "activity-spacer", width: "100%", height: 1, flexShrink: 0 });
const status = new TextRenderable(renderer, { content: "", fg: "#8BD5CA", height: 2, flexShrink: 0 });
const completionView = new TextRenderable(renderer, { content: "", fg: "#A6ADC8", height: 0 });

const composer = new TextareaRenderable(renderer, {
  id: "composer", width: "100%", height: 1, wrapMode: "word",
  placeholder: "", placeholderColor: "#747C91",
  backgroundColor: "transparent", focusedBackgroundColor: "transparent",
  textColor: "#E5E9F0", cursorColor: "#8BD5CA",
});

let suggestionLines = 0;
const toolBatch = { count: 0 };
function resizeComposer() {
  inputBox.width = inputWidth();
  const rows = 24;
  const editorWidth = Math.max(1, inputWidth() - 4);
  const lines = Math.max(1, composer.editorView.measureForDimensions(editorWidth, rows)?.lineCount ?? composer.lineCount);
  const layout = footerLayout(rows, lines, suggestionLines, 0, 0, toolBatch.count ? 1 : 0);
  queuedView.height = layout.queued;
  pendingToolView.height = layout.pendingTool;
  activityView.height = layout.activity;
  activitySpacer.height = layout.spacer;
  status.height = layout.status;
  completionView.height = layout.suggestions;
  approvalBox.height = layout.permission;
  composer.height = layout.editor;
  inputBox.height = layout.editor + layout.inputBorder;
}
resizeComposer();

footer.add(pendingToolView);
footer.add(activityView);
footer.add(activitySpacer);
footer.add(completionView);
footer.add(approvalBox);
footer.add(queuedView);
inputBox.add(composer);
footer.add(inputBox);
footer.add(status);
renderer.root.add(footer);
renderer.on("resize", resizeComposer);
composer.focus();
renderer.requestRender();
await flush();

console.log("inputBox.height =", inputBox.height, "composer.height =", composer.height);
console.log("editorWidth =", Math.max(1, inputWidth() - 4));
console.log("measured lines =", composer.editorView.measureForDimensions(Math.max(1, inputWidth() - 4), 24));
console.log("footer children heights:", footer.getChildren().map((c) => c.height));
console.log("frame tail:\n" + captureCharFrame().split("\n").slice(-10).join("\n"));

await renderer.destroy();
process.exit(0);
