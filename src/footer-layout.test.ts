import assert from "node:assert/strict";
import { test } from "node:test";
import { footerLayout } from "./footer-layout.ts";

for (const rows of [1, 2, 3, 4, 5, 7, 10, 24, 40]) {
  test(`footer stays within ${rows} terminal rows`, () => {
    for (const draft of [1, 5, 40]) for (const suggestions of [0, 7]) for (const permission of [0, 4, 25]) {
      const layout = footerLayout(rows, draft, suggestions, permission);
      assert.ok(layout.height <= rows);
      assert.ok(layout.height >= 1);
      assert.ok(layout.editor >= 1);
      assert.equal(layout.height, layout.editor + layout.inputBorder + layout.permission + layout.queued + layout.pendingTool + layout.status + layout.activity + layout.spacer + layout.suggestions);
    }
  });
}

test("permission prompt gets its border and key-hint row before other decorations", () => {
  for (const rows of [7, 10, 24]) {
    const layout = footerLayout(rows, 20, 7, 30, 20, 1);
    assert.ok(layout.permission >= 3, `hint should fit at ${rows} rows`);
    assert.ok(layout.editor >= 1);
  }
  assert.ok(footerLayout(3, 1, 0, 30).permission < 3);
});

test("pending tool line sits above activity while preserving the editor", () => {
  const layout = footerLayout(24, 1, 0, 0, 0, 1);
  assert.equal(layout.pendingTool, 1);
  assert.equal(layout.activity, 1);
  assert.equal(layout.height, 8);
  assert.equal(footerLayout(3, 1, 0, 0, 0, 1).editor, 1);
});

test("queued cards take available space without hiding the editor", () => {
  assert.equal(footerLayout(24, 1, 0, 0, 4).queued, 4);
  assert.equal(footerLayout(24, 1, 0, 0, 4).height, 11);
  const tiny = footerLayout(5, 1, 0, 0, 20);
  assert.equal(tiny.editor, 1);
  assert.ok(tiny.height <= 5);
  assert.equal(tiny.queued, 1);
});

test("normal footer grows and shrinks with draft and suggestions", () => {
  assert.equal(footerLayout(24, 1, 0, 0).height, 7);
  assert.equal(footerLayout(24, 5, 0, 0).height, 11);
  assert.equal(footerLayout(24, 1, 7, 0).height, 14);
  assert.equal(footerLayout(10, 40, 7, 20).height, 9);
});
