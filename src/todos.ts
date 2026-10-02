import type { HarnessTool } from "./tools.ts";

export const todoStatuses = ["pending", "in_progress", "completed"] as const;
export type TodoStatus = (typeof todoStatuses)[number];
export type Todo = { content: string; status: TodoStatus };

export function hasIncompleteTodos(todos: Todo[]): boolean {
  return todos.some((todo) => todo.status !== "completed");
}

export function todoMarker(status: TodoStatus): string {
  return status === "completed" ? "[x]" : status === "in_progress" ? "[~]" : "[ ]";
}

export function validTodos(value: unknown): value is Todo[] {
  return Array.isArray(value) && value.every((todo) => todo
    && typeof todo.content === "string" && todo.content.trim().length > 0
    && todo.content.length <= 500 && todoStatuses.includes(todo.status));
}

function todosFrom(input: Record<string, unknown>): Todo[] {
  if (!validTodos(input.todos)) {
    throw new Error("todos must be an array of items with non-empty content and a status of pending, in_progress, or completed.");
  }
  return input.todos.map((todo) => ({ content: todo.content.trim(), status: todo.status }));
}

function formatTodos(todos: Todo[]): string {
  if (!todos.length) return "No todos.";
  return todos.map((todo) => `${todoMarker(todo.status)} ${todo.content}`).join("\n");
}

export const todoTools: HarnessTool[] = [
  {
    name: "todo_write",
    description: "Replace the harness todo list with the current plan. Use it to track multi-step work; keep exactly one item in_progress while working and mark items completed as they finish.",
    inputSchema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "Ordered todo items.",
          items: {
            type: "object",
            properties: {
              content: { type: "string", description: "Concise task description." },
              status: { type: "string", description: "One of pending, in_progress, or completed." },
            },
            required: ["content", "status"],
            additionalProperties: false,
          },
        },
      },
      required: ["todos"],
      additionalProperties: false,
    },
    async execute(input, context) {
      if (!context.todos) throw new Error("Todo state is unavailable in this tool context.");
      context.todos.splice(0, context.todos.length, ...todosFrom(input));
      return formatTodos(context.todos);
    },
  },
  {
    name: "todo_list",
    description: "Read the current harness todo list.",
    inputSchema: { type: "object", additionalProperties: false },
    async execute(_input, context) {
      if (!context.todos) throw new Error("Todo state is unavailable in this tool context.");
      return formatTodos(context.todos);
    },
  },
];
