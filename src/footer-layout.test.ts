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
      assert.equal(layout.height, layout.editor + layout.inputBorder + layout.permission + layout.status + layout.activity + layout.spacer + layout.suggestions);
    }
  });
}

test("normal footer grows and shrinks with draft and suggestions", () => {
  assert.equal(footerLayout(24, 1, 0, 0).height, 7);
  assert.equal(footerLayout(24, 5, 0, 0).height, 11);
  assert.equal(footerLayout(24, 1, 7, 0).height, 14);
  assert.equal(footerLayout(10, 40, 7, 20).height, 9);
});
