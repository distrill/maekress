import { strict as assert } from "node:assert";
import { test } from "node:test";
import { hasIncompleteTodos, todoMarker, todoTools } from "./todos.ts";

const context = (todos: Parameters<(typeof todoTools)[number]["execute"]>[1]["todos"] = []) => ({
  projectRoot: process.cwd(),
  confirm: async () => true,
  todos,
});

test("todo tools replace and report the session-backed list", async () => {
  const todos = [];
  const write = todoTools.find((tool) => tool.name === "todo_write")!;
  const list = todoTools.find((tool) => tool.name === "todo_list")!;
  assert.equal(await write.execute({ todos: [
    { content: " inspect code ", status: "completed" },
    { content: "implement todos", status: "in_progress" },
    { content: "verify behavior", status: "pending" },
  ] }, context(todos)), "[x] inspect code\n[~] implement todos\n[ ] verify behavior");
  assert.deepEqual(todos, [
    { content: "inspect code", status: "completed" },
    { content: "implement todos", status: "in_progress" },
    { content: "verify behavior", status: "pending" },
  ]);
  assert.equal(await list.execute({}, context(todos)), "[x] inspect code\n[~] implement todos\n[ ] verify behavior");
});

test("todo markers reflect each status", () => {
  assert.equal(todoMarker("pending"), "[ ]");
  assert.equal(todoMarker("in_progress"), "[~]");
  assert.equal(todoMarker("completed"), "[x]");
});

test("completed todo lists can be distinguished from active ones", () => {
  assert.equal(hasIncompleteTodos([]), false);
  assert.equal(hasIncompleteTodos([{ content: "done", status: "completed" }]), false);
  assert.equal(hasIncompleteTodos([{ content: "working", status: "in_progress" }]), true);
  assert.equal(hasIncompleteTodos([{ content: "next", status: "pending" }]), true);
});

test("todo_write rejects invalid items", async () => {
  const write = todoTools.find((tool) => tool.name === "todo_write")!;
  await assert.rejects(write.execute({ todos: [{ content: "", status: "done" }] }, context()), /todos must be an array/);
});
