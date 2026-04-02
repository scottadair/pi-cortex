/**
 * Todos Extension - Filesystem-based task management
 *
 * Stores todos as markdown files with JSON frontmatter in .cortex/todos/.
 * Each todo is a separate file, human-readable, and persists across sessions.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

interface TodoMeta {
	id: string;
	title: string;
	status: "todo" | "in-progress" | "done" | "blocked";
	assignee?: string;
	priority?: "low" | "medium" | "high";
	tags?: string[];
	created_at: string;
	updated_at: string;
}

interface TodoFile {
	meta: TodoMeta;
	body: string;
}

// ---------------------------------------------------------------------------
// Filesystem operations
// ---------------------------------------------------------------------------

function getTodosDir(cwd: string): string {
	return path.join(cwd, ".cortex", "todos");
}

function ensureTodosDir(cwd: string): string {
	const dir = getTodosDir(cwd);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function parseTodoFile(content: string): TodoFile | null {
	const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (!match) return null;
	try {
		const meta = JSON.parse(match[1]) as TodoMeta;
		return { meta, body: match[2].trim() };
	} catch {
		return null;
	}
}

function serializeTodoFile(todo: TodoFile): string {
	const frontmatter = JSON.stringify(todo.meta, null, 2);
	const body = todo.body ? `\n${todo.body}\n` : "\n";
	return `---\n${frontmatter}\n---\n${body}`;
}

function readAllTodos(cwd: string): TodoFile[] {
	const dir = getTodosDir(cwd);
	if (!fs.existsSync(dir)) return [];

	const todos: TodoFile[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (!entry.name.endsWith(".md") || !entry.isFile()) continue;
		try {
			const content = fs.readFileSync(path.join(dir, entry.name), "utf-8");
			const todo = parseTodoFile(content);
			if (todo) todos.push(todo);
		} catch {
			continue;
		}
	}

	return todos.sort((a, b) => {
		const priorityOrder = { high: 0, medium: 1, low: 2 };
		const pa = priorityOrder[a.meta.priority ?? "medium"];
		const pb = priorityOrder[b.meta.priority ?? "medium"];
		if (pa !== pb) return pa - pb;
		return a.meta.id.localeCompare(b.meta.id);
	});
}

function readTodo(cwd: string, id: string): TodoFile | null {
	const filePath = path.join(getTodosDir(cwd), `${id}.md`);
	if (!fs.existsSync(filePath)) return null;
	try {
		return parseTodoFile(fs.readFileSync(filePath, "utf-8"));
	} catch {
		return null;
	}
}

function writeTodo(cwd: string, todo: TodoFile): void {
	const dir = ensureTodosDir(cwd);
	fs.writeFileSync(path.join(dir, `${todo.meta.id}.md`), serializeTodoFile(todo), "utf-8");
}

function deleteTodo(cwd: string, id: string): boolean {
	const filePath = path.join(getTodosDir(cwd), `${id}.md`);
	if (!fs.existsSync(filePath)) return false;
	fs.unlinkSync(filePath);
	return true;
}

function nextId(cwd: string): string {
	const todos = readAllTodos(cwd);
	let max = 0;
	for (const t of todos) {
		const n = parseInt(t.meta.id, 10);
		if (!isNaN(n) && n > max) max = n;
	}
	return String(max + 1).padStart(3, "0");
}

// ---------------------------------------------------------------------------
// Status / priority formatting
// ---------------------------------------------------------------------------

const STATUS_ICONS: Record<string, string> = {
	todo: "\u25cb",         // ○
	"in-progress": "\u25d4", // ◔
	done: "\u2713",          // ✓
	blocked: "\u2717",       // ✗
};

const PRIORITY_LABELS: Record<string, string> = {
	high: "\u2191",   // ↑
	medium: "\u2500",  // ─
	low: "\u2193",    // ↓
};

// ---------------------------------------------------------------------------
// TUI component
// ---------------------------------------------------------------------------

class TodoListComponent {
	private todos: TodoFile[];
	private theme: Theme;
	private onClose: () => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(todos: TodoFile[], theme: Theme, onClose: () => void) {
		this.todos = todos;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const lines: string[] = [];
		const th = this.theme;

		lines.push("");
		const title = th.fg("accent", " Tasks ");
		lines.push(truncateToWidth(th.fg("borderMuted", "\u2500".repeat(3)) + title + th.fg("borderMuted", "\u2500".repeat(Math.max(0, width - 12))), width));
		lines.push("");

		if (this.todos.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No tasks yet.")}`, width));
		} else {
			const groups: Record<string, TodoFile[]> = { "todo": [], "in-progress": [], "blocked": [], "done": [] };
			for (const t of this.todos) {
				(groups[t.meta.status] ?? groups["todo"]).push(t);
			}

			for (const [status, items] of Object.entries(groups)) {
				if (items.length === 0) continue;
				lines.push(truncateToWidth(`  ${th.fg("accent", status.toUpperCase())} ${th.fg("dim", `(${items.length})`)}`, width));
				for (const t of items) {
					const icon = STATUS_ICONS[t.meta.status] ?? "\u25cb";
					const statusColor = t.meta.status === "done" ? "success" : t.meta.status === "blocked" ? "error" : "muted";
					const priority = t.meta.priority ? PRIORITY_LABELS[t.meta.priority] || "" : "";
					const assignee = t.meta.assignee ? th.fg("dim", ` @${t.meta.assignee}`) : "";
					const titleText = t.meta.status === "done" ? th.fg("dim", t.meta.title) : th.fg("text", t.meta.title);
					lines.push(truncateToWidth(`    ${th.fg(statusColor, icon)} ${th.fg("accent", `#${t.meta.id}`)} ${priority ? th.fg("warning", priority) + " " : ""}${titleText}${assignee}`, width));
				}
				lines.push("");
			}
		}

		lines.push(truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width));
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

const TodoParams = Type.Object({
	action: StringEnum(["create", "update", "list", "get", "append", "delete"] as const, {
		description: "Action to perform",
	}),
	id: Type.Optional(Type.String({ description: "Todo ID (for update, get, append, delete)" })),
	title: Type.Optional(Type.String({ description: "Todo title (for create, update)" })),
	description: Type.Optional(Type.String({ description: "Todo body text (for create)" })),
	status: Type.Optional(StringEnum(["todo", "in-progress", "done", "blocked"] as const, {
		description: "Status (for create, update)",
	})),
	assignee: Type.Optional(Type.String({ description: "Team member name (for create, update)" })),
	priority: Type.Optional(StringEnum(["low", "medium", "high"] as const, {
		description: "Priority level (for create, update)",
	})),
	tags: Type.Optional(Type.Array(Type.String(), { description: "Tags (for create, update)" })),
	text: Type.Optional(Type.String({ description: "Text to append (for append)" })),
	filter_status: Type.Optional(Type.String({ description: "Filter by status (for list)" })),
	filter_assignee: Type.Optional(Type.String({ description: "Filter by assignee (for list)" })),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "todo",
		label: "Todo",
		description: [
			"Manage project tasks stored in .cortex/todos/.",
			"Actions: create (title, description?, assignee?, priority?, tags?),",
			"update (id, status?, assignee?, priority?, title?, tags?),",
			"list (filter_status?, filter_assignee?), get (id), append (id, text), delete (id).",
			"Status: todo, in-progress, done, blocked. Priority: low, medium, high.",
			"Assignees are team member names: team-lead, dev-backend, dev-frontend, architect, qa.",
		].join(" "),
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cwd = ctx.cwd;

			switch (params.action) {
				case "create": {
					if (!params.title) {
						return { content: [{ type: "text", text: "Error: title required for create" }], details: {} };
					}
					const id = nextId(cwd);
					const now = new Date().toISOString();
					const todo: TodoFile = {
						meta: {
							id,
							title: params.title,
							status: params.status ?? "todo",
							assignee: params.assignee,
							priority: params.priority ?? "medium",
							tags: params.tags,
							created_at: now,
							updated_at: now,
						},
						body: params.description ?? "",
					};
					writeTodo(cwd, todo);
					return {
						content: [{ type: "text", text: `Created todo #${id}: ${params.title}` }],
						details: { action: "create", todo: todo.meta },
					};
				}

				case "update": {
					if (!params.id) {
						return { content: [{ type: "text", text: "Error: id required for update" }], details: {} };
					}
					const existing = readTodo(cwd, params.id);
					if (!existing) {
						return { content: [{ type: "text", text: `Todo #${params.id} not found` }], details: {} };
					}
					if (params.title !== undefined) existing.meta.title = params.title;
					if (params.status !== undefined) existing.meta.status = params.status;
					if (params.assignee !== undefined) existing.meta.assignee = params.assignee;
					if (params.priority !== undefined) existing.meta.priority = params.priority;
					if (params.tags !== undefined) existing.meta.tags = params.tags;
					existing.meta.updated_at = new Date().toISOString();
					writeTodo(cwd, existing);
					return {
						content: [{ type: "text", text: `Updated todo #${params.id}` }],
						details: { action: "update", todo: existing.meta },
					};
				}

				case "list": {
					let todos = readAllTodos(cwd);
					if (params.filter_status) {
						todos = todos.filter((t) => t.meta.status === params.filter_status);
					}
					if (params.filter_assignee) {
						todos = todos.filter((t) => t.meta.assignee === params.filter_assignee);
					}
					if (todos.length === 0) {
						return { content: [{ type: "text", text: "No todos found." }], details: { action: "list", count: 0 } };
					}
					const listing = todos
						.map((t) => {
							const icon = STATUS_ICONS[t.meta.status] ?? "\u25cb";
							const assignee = t.meta.assignee ? ` @${t.meta.assignee}` : "";
							const priority = t.meta.priority ? ` [${t.meta.priority}]` : "";
							return `${icon} #${t.meta.id}: ${t.meta.title} (${t.meta.status})${priority}${assignee}`;
						})
						.join("\n");
					return {
						content: [{ type: "text", text: listing }],
						details: { action: "list", count: todos.length },
					};
				}

				case "get": {
					if (!params.id) {
						return { content: [{ type: "text", text: "Error: id required for get" }], details: {} };
					}
					const todo = readTodo(cwd, params.id);
					if (!todo) {
						return { content: [{ type: "text", text: `Todo #${params.id} not found` }], details: {} };
					}
					let text = `# Todo #${todo.meta.id}: ${todo.meta.title}\n\n`;
					text += `- **Status**: ${todo.meta.status}\n`;
					if (todo.meta.assignee) text += `- **Assignee**: ${todo.meta.assignee}\n`;
					if (todo.meta.priority) text += `- **Priority**: ${todo.meta.priority}\n`;
					if (todo.meta.tags?.length) text += `- **Tags**: ${todo.meta.tags.join(", ")}\n`;
					text += `- **Created**: ${todo.meta.created_at}\n`;
					text += `- **Updated**: ${todo.meta.updated_at}\n`;
					if (todo.body) text += `\n${todo.body}`;
					return {
						content: [{ type: "text", text }],
						details: { action: "get", todo: todo.meta },
					};
				}

				case "append": {
					if (!params.id || !params.text) {
						return { content: [{ type: "text", text: "Error: id and text required for append" }], details: {} };
					}
					const todo = readTodo(cwd, params.id);
					if (!todo) {
						return { content: [{ type: "text", text: `Todo #${params.id} not found` }], details: {} };
					}
					todo.body = todo.body ? `${todo.body}\n\n${params.text}` : params.text;
					todo.meta.updated_at = new Date().toISOString();
					writeTodo(cwd, todo);
					return {
						content: [{ type: "text", text: `Appended to todo #${params.id}` }],
						details: { action: "append", todo: todo.meta },
					};
				}

				case "delete": {
					if (!params.id) {
						return { content: [{ type: "text", text: "Error: id required for delete" }], details: {} };
					}
					const deleted = deleteTodo(cwd, params.id);
					return {
						content: [{ type: "text", text: deleted ? `Deleted todo #${params.id}` : `Todo #${params.id} not found` }],
						details: { action: "delete", id: params.id, deleted },
					};
				}

				default:
					return { content: [{ type: "text", text: `Unknown action: ${params.action}` }], details: {} };
			}
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action);
			if (args.title) text += ` ${theme.fg("dim", `"${args.title}"`)}`;
			if (args.id) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			if (args.status) text += ` ${theme.fg("muted", `[${args.status}]`)}`;
			if (args.assignee) text += ` ${theme.fg("dim", `@${args.assignee}`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as Record<string, any> | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			const todo = details.todo as TodoMeta | undefined;
			if (todo) {
				const icon = STATUS_ICONS[todo.status] ?? "\u25cb";
				const statusColor = todo.status === "done" ? "success" : todo.status === "blocked" ? "error" : "muted";
				const assignee = todo.assignee ? theme.fg("dim", ` @${todo.assignee}`) : "";
				return new Text(
					`${theme.fg(statusColor, icon)} ${theme.fg("accent", `#${todo.id}`)} ${theme.fg("muted", todo.title)}${assignee}`,
					0, 0,
				);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "", 0, 0);
		},
	});

	// /tasks command
	pi.registerCommand("tasks", {
		description: "Show all tasks in an interactive view",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/tasks requires interactive mode", "error");
				return;
			}
			const todos = readAllTodos(ctx.cwd);
			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				return new TodoListComponent(todos, theme, () => done());
			});
		},
	});
}
