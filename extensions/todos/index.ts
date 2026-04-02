/**
 * Todos Extension - Filesystem-based task management
 *
 * Stores todos as markdown files with JSON frontmatter in .cortex/todos/.
 * Each todo has three sections: title (in frontmatter), description, and plan
 * (ordered steps with completion tracking). Everything in one place.
 *
 * Includes a refine workflow: the agent asks clarifying questions about a todo,
 * the user answers via an interactive Q&A TUI (/answer), and the agent updates
 * the todo description and plan with the refined details.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { complete, type Model, type Api, type UserMessage, StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, ModelRegistry, Theme } from "@mariozechner/pi-coding-agent";
import { BorderedLoader } from "@mariozechner/pi-coding-agent";
import {
	type Component,
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	truncateToWidth,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
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

interface PlanStep {
	number: number;
	text: string;
	completed: boolean;
}

interface TodoFile {
	meta: TodoMeta;
	description: string;
	plan: PlanStep[];
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
		const body = match[2];

		// Parse structured sections from body
		const descMatch = body.match(/## Description\n([\s\S]*?)(?=\n## |\n*$)/);
		const description = descMatch ? descMatch[1].trim() : body.trim();

		const planMatch = body.match(/## Plan\n([\s\S]*?)(?=\n## |\n*$)/);
		const plan: PlanStep[] = [];
		if (planMatch) {
			for (const line of planMatch[1].trim().split("\n")) {
				const stepMatch = line.match(/^(\d+)\.\s+\[(x| )\]\s+(.+)$/);
				if (stepMatch) {
					plan.push({
						number: parseInt(stepMatch[1], 10),
						text: stepMatch[3].trim(),
						completed: stepMatch[2] === "x",
					});
				}
			}
		}

		return { meta, description, plan };
	} catch {
		return null;
	}
}

function serializeTodoFile(todo: TodoFile): string {
	const frontmatter = JSON.stringify(todo.meta, null, 2);
	let body = "\n";

	if (todo.description) {
		body += `## Description\n${todo.description}\n\n`;
	}

	if (todo.plan.length > 0) {
		body += `## Plan\n`;
		for (const step of todo.plan) {
			body += `${step.number}. [${step.completed ? "x" : " "}] ${step.text}\n`;
		}
		body += "\n";
	}

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
	todo: "\u25cb",          // ○
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
// Q&A extraction for /answer command
// ---------------------------------------------------------------------------

interface ExtractedQuestion {
	question: string;
	context?: string;
}

interface ExtractionResult {
	questions: ExtractedQuestion[];
}

const QA_SYSTEM_PROMPT = `You are a question extractor. Given text from a conversation, extract any questions that need answering.

Output a JSON object with this structure:
{
  "questions": [
    {
      "question": "The question text",
      "context": "Optional context that helps answer the question"
    }
  ]
}

Rules:
- Extract all questions that require user input
- Keep questions in the order they appeared
- Be concise with question text
- Include context only when it provides essential information for answering
- If no questions are found, return {"questions": []}`;

const HAIKU_MODEL_ID = "claude-haiku-4-5";

async function selectExtractionModel(
	currentModel: Model<Api>,
	modelRegistry: ModelRegistry,
): Promise<Model<Api>> {
	const haikuModel = modelRegistry.find("anthropic", HAIKU_MODEL_ID);
	if (!haikuModel) return currentModel;

	const auth = await modelRegistry.getApiKeyAndHeaders(haikuModel);
	if (!auth.ok) return currentModel;

	return haikuModel;
}

function parseExtractionResult(text: string): ExtractionResult | null {
	try {
		let jsonStr = text;
		const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
		if (jsonMatch) jsonStr = jsonMatch[1].trim();

		const parsed = JSON.parse(jsonStr);
		if (parsed && Array.isArray(parsed.questions)) return parsed as ExtractionResult;
		return null;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Q&A interactive component
// ---------------------------------------------------------------------------

class QnAComponent implements Component {
	private questions: ExtractedQuestion[];
	private answers: string[];
	private currentIndex: number = 0;
	private editor: Editor;
	private tui: TUI;
	private onDone: (result: string | null) => void;
	private showingConfirmation: boolean = false;
	private cachedWidth?: number;
	private cachedLines?: string[];

	private dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
	private bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
	private cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
	private green = (s: string) => `\x1b[32m${s}\x1b[0m`;
	private yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
	private gray = (s: string) => `\x1b[90m${s}\x1b[0m`;

	constructor(questions: ExtractedQuestion[], tui: TUI, onDone: (result: string | null) => void) {
		this.questions = questions;
		this.answers = questions.map(() => "");
		this.tui = tui;
		this.onDone = onDone;

		const editorTheme: EditorTheme = {
			borderColor: this.dim,
			selectList: {
				selectedBg: (s: string) => `\x1b[44m${s}\x1b[0m`,
				matchHighlight: this.cyan,
				itemSecondary: this.gray,
			},
		};
		this.editor = new Editor(tui, editorTheme);
		this.editor.disableSubmit = true;
		this.editor.onChange = () => {
			this.invalidate();
			this.tui.requestRender();
		};
	}

	private saveCurrentAnswer(): void {
		this.answers[this.currentIndex] = this.editor.getText();
	}

	private navigateTo(index: number): void {
		if (index < 0 || index >= this.questions.length) return;
		this.saveCurrentAnswer();
		this.currentIndex = index;
		this.editor.setText(this.answers[index] || "");
		this.invalidate();
	}

	private submit(): void {
		this.saveCurrentAnswer();
		const parts: string[] = [];
		for (let i = 0; i < this.questions.length; i++) {
			const q = this.questions[i];
			const a = this.answers[i]?.trim() || "(no answer)";
			parts.push(`Q: ${q.question}`);
			if (q.context) parts.push(`> ${q.context}`);
			parts.push(`A: ${a}`);
			parts.push("");
		}
		this.onDone(parts.join("\n").trim());
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	handleInput(data: string): void {
		if (this.showingConfirmation) {
			if (matchesKey(data, Key.enter) || data.toLowerCase() === "y") {
				this.submit();
				return;
			}
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data.toLowerCase() === "n") {
				this.showingConfirmation = false;
				this.invalidate();
				this.tui.requestRender();
				return;
			}
			return;
		}

		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.onDone(null);
			return;
		}
		if (matchesKey(data, Key.tab)) {
			if (this.currentIndex < this.questions.length - 1) {
				this.navigateTo(this.currentIndex + 1);
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, Key.shift("tab"))) {
			if (this.currentIndex > 0) {
				this.navigateTo(this.currentIndex - 1);
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, Key.enter) && !matchesKey(data, Key.shift("enter"))) {
			this.saveCurrentAnswer();
			if (this.currentIndex < this.questions.length - 1) {
				this.navigateTo(this.currentIndex + 1);
			} else {
				this.showingConfirmation = true;
			}
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		this.editor.handleInput(data);
		this.invalidate();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const lines: string[] = [];
		const boxWidth = Math.min(width - 4, 120);
		const contentWidth = boxWidth - 4;

		const horizontalLine = (count: number) => "\u2500".repeat(count);
		const boxLine = (content: string, leftPad: number = 2): string => {
			const paddedContent = " ".repeat(leftPad) + content;
			const contentLen = visibleWidth(paddedContent);
			const rightPad = Math.max(0, boxWidth - contentLen - 2);
			return this.dim("\u2502") + paddedContent + " ".repeat(rightPad) + this.dim("\u2502");
		};
		const emptyBoxLine = (): string => this.dim("\u2502") + " ".repeat(boxWidth - 2) + this.dim("\u2502");
		const padToWidth = (line: string): string => {
			const len = visibleWidth(line);
			return line + " ".repeat(Math.max(0, width - len));
		};

		lines.push(padToWidth(this.dim("\u256d" + horizontalLine(boxWidth - 2) + "\u256e")));
		const title = `${this.bold(this.cyan("Questions"))} ${this.dim(`(${this.currentIndex + 1}/${this.questions.length})`)}`;
		lines.push(padToWidth(boxLine(title)));
		lines.push(padToWidth(this.dim("\u251c" + horizontalLine(boxWidth - 2) + "\u2524")));

		const progressParts: string[] = [];
		for (let i = 0; i < this.questions.length; i++) {
			const answered = (this.answers[i]?.trim() || "").length > 0;
			const current = i === this.currentIndex;
			if (current) progressParts.push(this.cyan("\u25cf"));
			else if (answered) progressParts.push(this.green("\u25cf"));
			else progressParts.push(this.dim("\u25cb"));
		}
		lines.push(padToWidth(boxLine(progressParts.join(" "))));
		lines.push(padToWidth(emptyBoxLine()));

		const q = this.questions[this.currentIndex];
		const questionText = `${this.bold("Q:")} ${q.question}`;
		for (const line of wrapTextWithAnsi(questionText, contentWidth)) {
			lines.push(padToWidth(boxLine(line)));
		}
		if (q.context) {
			lines.push(padToWidth(emptyBoxLine()));
			for (const line of wrapTextWithAnsi(this.gray(`> ${q.context}`), contentWidth - 2)) {
				lines.push(padToWidth(boxLine(line)));
			}
		}
		lines.push(padToWidth(emptyBoxLine()));

		const editorWidth = contentWidth - 4 - 3;
		const editorLines = this.editor.render(editorWidth);
		for (let i = 1; i < editorLines.length - 1; i++) {
			if (i === 1) lines.push(padToWidth(boxLine(this.bold("A: ") + editorLines[i])));
			else lines.push(padToWidth(boxLine("   " + editorLines[i])));
		}
		lines.push(padToWidth(emptyBoxLine()));

		if (this.showingConfirmation) {
			lines.push(padToWidth(this.dim("\u251c" + horizontalLine(boxWidth - 2) + "\u2524")));
			lines.push(padToWidth(boxLine(truncateToWidth(`${this.yellow("Submit all answers?")} ${this.dim("(Enter/y to confirm, Esc/n to cancel)")}`, contentWidth))));
		} else {
			lines.push(padToWidth(this.dim("\u251c" + horizontalLine(boxWidth - 2) + "\u2524")));
			lines.push(padToWidth(boxLine(truncateToWidth(`${this.dim("Tab/Enter")} next \u00b7 ${this.dim("Shift+Tab")} prev \u00b7 ${this.dim("Shift+Enter")} newline \u00b7 ${this.dim("Esc")} cancel`, contentWidth))));
		}
		lines.push(padToWidth(this.dim("\u2570" + horizontalLine(boxWidth - 2) + "\u256f")));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

// ---------------------------------------------------------------------------
// Tasks TUI with selection
// ---------------------------------------------------------------------------

type TaskAction = "refine" | "work" | null;

class TodoListComponent {
	private todos: TodoFile[];
	private theme: Theme;
	private onClose: (action: TaskAction, todo?: TodoFile) => void;
	private selectedIndex: number = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(todos: TodoFile[], theme: Theme, onClose: (action: TaskAction, todo?: TodoFile) => void) {
		this.todos = todos;
		this.theme = theme;
		this.onClose = onClose;
	}

	private getOpenTodos(): TodoFile[] {
		return this.todos.filter((t) => t.meta.status !== "done");
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.onClose(null);
			return;
		}

		const openTodos = this.getOpenTodos();
		if (openTodos.length === 0) {
			this.onClose(null);
			return;
		}

		if (matchesKey(data, Key.up)) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.invalidate();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.selectedIndex = Math.min(openTodos.length - 1, this.selectedIndex + 1);
			this.invalidate();
			return;
		}

		if (data === "r" && openTodos.length > 0) {
			this.onClose("refine", openTodos[this.selectedIndex]);
			return;
		}
		if ((data === "w" || matchesKey(data, Key.enter)) && openTodos.length > 0) {
			this.onClose("work", openTodos[this.selectedIndex]);
			return;
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
			const openTodos = this.getOpenTodos();
			const doneTodos = this.todos.filter((t) => t.meta.status === "done");

			const groups: Record<string, TodoFile[]> = { "todo": [], "in-progress": [], "blocked": [] };
			for (const t of openTodos) {
				(groups[t.meta.status] ?? groups["todo"]).push(t);
			}

			let flatIndex = 0;
			for (const [status, items] of Object.entries(groups)) {
				if (items.length === 0) continue;
				lines.push(truncateToWidth(`  ${th.fg("accent", status.toUpperCase())} ${th.fg("dim", `(${items.length})`)}`, width));
				for (const t of items) {
					const icon = STATUS_ICONS[t.meta.status] ?? "\u25cb";
					const statusColor = t.meta.status === "blocked" ? "error" : "muted";
					const priority = t.meta.priority ? PRIORITY_LABELS[t.meta.priority] || "" : "";
					const assignee = t.meta.assignee ? th.fg("dim", ` @${t.meta.assignee}`) : "";
					const planInfo = t.plan.length > 0 ? th.fg("dim", ` [${t.plan.filter((s) => s.completed).length}/${t.plan.length}]`) : "";
					const titleText = th.fg("text", t.meta.title);
					const cursor = flatIndex === this.selectedIndex ? th.fg("accent", "\u25b6 ") : "  ";
					const highlight = flatIndex === this.selectedIndex ? th.fg("accent", `#${t.meta.id}`) : th.fg("muted", `#${t.meta.id}`);
					lines.push(truncateToWidth(`  ${cursor}${th.fg(statusColor, icon)} ${highlight} ${priority ? th.fg("warning", priority) + " " : ""}${titleText}${planInfo}${assignee}`, width));
					flatIndex++;
				}
				lines.push("");
			}

			if (doneTodos.length > 0) {
				lines.push(truncateToWidth(`  ${th.fg("success", "DONE")} ${th.fg("dim", `(${doneTodos.length})`)}`, width));
				for (const t of doneTodos.slice(0, 3)) {
					lines.push(truncateToWidth(`    ${th.fg("success", "\u2713")} ${th.fg("dim", `#${t.meta.id}`)} ${th.fg("dim", t.meta.title)}`, width));
				}
				if (doneTodos.length > 3) {
					lines.push(truncateToWidth(`    ${th.fg("dim", `... ${doneTodos.length - 3} more`)}`, width));
				}
				lines.push("");
			}
		}

		lines.push(truncateToWidth(`  ${th.fg("dim", "\u2191\u2193 select \u00b7 r refine \u00b7 w/Enter work \u00b7 Esc close")}`, width));
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
// Refine prompt builder
// ---------------------------------------------------------------------------

function buildRefinePrompt(id: string, title: string): string {
	return (
		`Let's refine task #${id} "${title}": ` +
		"Ask me for the missing details needed to build a solid description and implementation plan for this todo. " +
		"Do not rewrite the todo yet and do not make assumptions. " +
		"Ask clear, concrete questions and wait for my answers before drafting any structured description or plan steps.\n\n"
	);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

const TodoParams = Type.Object({
	action: StringEnum(["create", "update", "list", "get", "set-description", "set-plan", "add-step", "complete-step", "delete", "refine"] as const, {
		description: "Action to perform",
	}),
	id: Type.Optional(Type.String({ description: "Todo ID (required for most actions except create, list)" })),
	title: Type.Optional(Type.String({ description: "Todo title (for create, update)" })),
	description: Type.Optional(Type.String({ description: "Description text (for create, set-description)" })),
	status: Type.Optional(StringEnum(["todo", "in-progress", "done", "blocked"] as const, {
		description: "Status (for create, update)",
	})),
	assignee: Type.Optional(Type.String({ description: "Team member name (for create, update)" })),
	priority: Type.Optional(StringEnum(["low", "medium", "high"] as const, {
		description: "Priority level (for create, update)",
	})),
	tags: Type.Optional(Type.Array(Type.String(), { description: "Tags (for create, update)" })),
	steps: Type.Optional(Type.Array(Type.String(), { description: "Plan step descriptions (for create, set-plan)" })),
	step: Type.Optional(Type.String({ description: "Single step text (for add-step)" })),
	step_number: Type.Optional(Type.Number({ description: "Step number (for complete-step, add-step position)" })),
	filter_status: Type.Optional(Type.String({ description: "Filter by status (for list)" })),
	filter_assignee: Type.Optional(Type.String({ description: "Filter by assignee (for list)" })),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "todo",
		label: "Todo",
		description: [
			"Manage project tasks stored in .cortex/todos/. Each todo has a title, description, and plan (ordered steps with completion tracking).",
			"Actions: create (title, description?, steps?, assignee?, priority?, tags?),",
			"update (id, status?, assignee?, priority?, title?, tags?),",
			"list (filter_status?, filter_assignee?), get (id),",
			"set-description (id, description) - replace the description,",
			"set-plan (id, steps[]) - replace all plan steps,",
			"add-step (id, step, step_number?) - add a plan step at position (or end),",
			"complete-step (id, step_number) - toggle a plan step's completion,",
			"delete (id), refine (id) - ask user clarifying questions to build description and plan.",
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
					const planSteps: PlanStep[] = (params.steps ?? []).map((text, i) => ({
						number: i + 1,
						text,
						completed: false,
					}));
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
						description: params.description ?? "",
						plan: planSteps,
					};
					writeTodo(cwd, todo);
					const stepInfo = planSteps.length > 0 ? ` (${planSteps.length} plan steps)` : "";
					return {
						content: [{ type: "text", text: `Created todo #${id}: ${params.title}${stepInfo}` }],
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
							const planProgress = t.plan.length > 0 ? ` [${t.plan.filter((s) => s.completed).length}/${t.plan.length} steps]` : "";
							return `${icon} #${t.meta.id}: ${t.meta.title} (${t.meta.status})${priority}${planProgress}${assignee}`;
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
					if (todo.description) text += `\n## Description\n${todo.description}\n`;
					if (todo.plan.length > 0) {
						const completedCount = todo.plan.filter((s) => s.completed).length;
						text += `\n## Plan (${completedCount}/${todo.plan.length})\n`;
						for (const step of todo.plan) {
							text += `${step.number}. [${step.completed ? "x" : " "}] ${step.text}\n`;
						}
					}
					return {
						content: [{ type: "text", text }],
						details: { action: "get", todo: todo.meta },
					};
				}

				case "set-description": {
					if (!params.id) {
						return { content: [{ type: "text", text: "Error: id required for set-description" }], details: {} };
					}
					const todo = readTodo(cwd, params.id);
					if (!todo) {
						return { content: [{ type: "text", text: `Todo #${params.id} not found` }], details: {} };
					}
					todo.description = params.description ?? "";
					todo.meta.updated_at = new Date().toISOString();
					writeTodo(cwd, todo);
					return {
						content: [{ type: "text", text: `Updated description for todo #${params.id}` }],
						details: { action: "set-description", todo: todo.meta },
					};
				}

				case "set-plan": {
					if (!params.id) {
						return { content: [{ type: "text", text: "Error: id required for set-plan" }], details: {} };
					}
					const todo = readTodo(cwd, params.id);
					if (!todo) {
						return { content: [{ type: "text", text: `Todo #${params.id} not found` }], details: {} };
					}
					todo.plan = (params.steps ?? []).map((text, i) => ({
						number: i + 1,
						text,
						completed: false,
					}));
					todo.meta.updated_at = new Date().toISOString();
					writeTodo(cwd, todo);
					return {
						content: [{ type: "text", text: `Set ${todo.plan.length} plan steps for todo #${params.id}` }],
						details: { action: "set-plan", todo: todo.meta, stepCount: todo.plan.length },
					};
				}

				case "add-step": {
					if (!params.id || !params.step) {
						return { content: [{ type: "text", text: "Error: id and step required for add-step" }], details: {} };
					}
					const todo = readTodo(cwd, params.id);
					if (!todo) {
						return { content: [{ type: "text", text: `Todo #${params.id} not found` }], details: {} };
					}
					const newStep: PlanStep = {
						number: todo.plan.length + 1,
						text: params.step,
						completed: false,
					};
					if (params.step_number !== undefined && params.step_number >= 1 && params.step_number <= todo.plan.length + 1) {
						todo.plan.splice(params.step_number - 1, 0, newStep);
						todo.plan.forEach((s, i) => { s.number = i + 1; });
					} else {
						todo.plan.push(newStep);
					}
					todo.meta.updated_at = new Date().toISOString();
					writeTodo(cwd, todo);
					return {
						content: [{ type: "text", text: `Added step ${newStep.number} to todo #${params.id}: ${params.step}` }],
						details: { action: "add-step", todo: todo.meta, stepCount: todo.plan.length },
					};
				}

				case "complete-step": {
					if (!params.id || params.step_number === undefined) {
						return { content: [{ type: "text", text: "Error: id and step_number required for complete-step" }], details: {} };
					}
					const todo = readTodo(cwd, params.id);
					if (!todo) {
						return { content: [{ type: "text", text: `Todo #${params.id} not found` }], details: {} };
					}
					const step = todo.plan.find((s) => s.number === params.step_number);
					if (!step) {
						return { content: [{ type: "text", text: `Step ${params.step_number} not found in todo #${params.id}` }], details: {} };
					}
					step.completed = !step.completed;
					todo.meta.updated_at = new Date().toISOString();
					writeTodo(cwd, todo);
					const completedCount = todo.plan.filter((s) => s.completed).length;
					return {
						content: [{ type: "text", text: `Step ${params.step_number} ${step.completed ? "completed" : "uncompleted"} (${completedCount}/${todo.plan.length})` }],
						details: { action: "complete-step", todo: todo.meta, completedCount, totalSteps: todo.plan.length },
					};
				}

				case "refine": {
					if (!params.id) {
						return { content: [{ type: "text", text: "Error: id required for refine" }], details: {} };
					}
					const todo = readTodo(cwd, params.id);
					if (!todo) {
						return { content: [{ type: "text", text: `Todo #${params.id} not found` }], details: {} };
					}
					let context = `# Refining Todo #${todo.meta.id}: ${todo.meta.title}\n\n`;
					context += `**Current status**: ${todo.meta.status}\n`;
					if (todo.meta.assignee) context += `**Assignee**: ${todo.meta.assignee}\n`;
					if (todo.meta.priority) context += `**Priority**: ${todo.meta.priority}\n`;
					if (todo.meta.tags?.length) context += `**Tags**: ${todo.meta.tags.join(", ")}\n`;
					if (todo.description) context += `\n**Current description**:\n${todo.description}\n`;
					if (todo.plan.length > 0) {
						context += `\n**Current plan**:\n`;
						for (const s of todo.plan) {
							context += `${s.number}. [${s.completed ? "x" : " "}] ${s.text}\n`;
						}
					}
					context += `\nAsk the user clarifying questions to build a comprehensive description and implementation plan for this task. `;
					context += `Do not make assumptions. Ask clear, concrete questions and wait for answers. `;
					context += `After getting answers, use "set-description" to update the description and "set-plan" to set the plan steps.`;
					return {
						content: [{ type: "text", text: context }],
						details: { action: "refine", todo: todo.meta },
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
			if (args.step_number !== undefined) text += ` ${theme.fg("accent", `step ${args.step_number}`)}`;
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
				let line = `${theme.fg(statusColor, icon)} ${theme.fg("accent", `#${todo.id}`)} ${theme.fg("muted", todo.title)}${assignee}`;
				if (details.completedCount !== undefined) {
					line += ` ${theme.fg("dim", `(${details.completedCount}/${details.totalSteps})`)}`;
				}
				if (details.stepCount !== undefined) {
					line += ` ${theme.fg("dim", `(${details.stepCount} steps)`)}`;
				}
				return new Text(line, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "", 0, 0);
		},
	});

	// -----------------------------------------------------------------------
	// /tasks command — interactive TUI with refine/work actions
	// -----------------------------------------------------------------------

	pi.registerCommand("tasks", {
		description: "Show all tasks — select one to refine or work on",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/tasks requires interactive mode", "error");
				return;
			}

			const todos = readAllTodos(ctx.cwd);
			let nextPrompt: string | null = null;

			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				return new TodoListComponent(todos, theme, (action, todo) => {
					if (action && todo) {
						if (action === "refine") {
							nextPrompt = buildRefinePrompt(todo.meta.id, todo.meta.title);
						} else if (action === "work") {
							nextPrompt = `Work on todo #${todo.meta.id} "${todo.meta.title}"`;
						}
					}
					done();
				});
			});

			if (nextPrompt) {
				ctx.ui.setEditorText(nextPrompt);
			}
		},
	});

	// -----------------------------------------------------------------------
	// /answer command — extract questions from last message into Q&A TUI
	// -----------------------------------------------------------------------

	const answerHandler = async (ctx: ExtensionContext) => {
		if (!ctx.hasUI) {
			ctx.ui.notify("/answer requires interactive mode", "error");
			return;
		}
		if (!ctx.model) {
			ctx.ui.notify("No model selected", "error");
			return;
		}

		const branch = ctx.sessionManager.getBranch();
		let lastAssistantText: string | undefined;

		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type === "message") {
				const msg = entry.message;
				if ("role" in msg && msg.role === "assistant") {
					if (msg.stopReason !== "stop") {
						ctx.ui.notify(`Last assistant message incomplete (${msg.stopReason})`, "error");
						return;
					}
					const textParts = msg.content
						.filter((c: any): c is { type: "text"; text: string } => c.type === "text")
						.map((c: any) => c.text);
					if (textParts.length > 0) {
						lastAssistantText = textParts.join("\n");
						break;
					}
				}
			}
		}

		if (!lastAssistantText) {
			ctx.ui.notify("No assistant messages found", "error");
			return;
		}

		const extractionModel = await selectExtractionModel(ctx.model, ctx.modelRegistry);

		const extractionResult = await ctx.ui.custom<ExtractionResult | null>((tui, theme, _kb, done) => {
			const loader = new BorderedLoader(tui, theme, `Extracting questions using ${extractionModel.id}...`);
			loader.onAbort = () => done(null);

			const doExtract = async () => {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(extractionModel);
				if (!auth.ok) throw new Error(auth.error);

				const userMessage: UserMessage = {
					role: "user",
					content: [{ type: "text", text: lastAssistantText! }],
					timestamp: Date.now(),
				};

				const response = await complete(
					extractionModel,
					{ systemPrompt: QA_SYSTEM_PROMPT, messages: [userMessage] },
					{ apiKey: auth.apiKey, headers: auth.headers, signal: loader.signal },
				);

				if (response.stopReason === "aborted") return null;

				const responseText = response.content
					.filter((c: any): c is { type: "text"; text: string } => c.type === "text")
					.map((c: any) => c.text)
					.join("\n");

				return parseExtractionResult(responseText);
			};

			doExtract().then(done).catch(() => done(null));
			return loader;
		});

		if (extractionResult === null) {
			ctx.ui.notify("Cancelled", "info");
			return;
		}
		if (extractionResult.questions.length === 0) {
			ctx.ui.notify("No questions found in the last message", "info");
			return;
		}

		const answersResult = await ctx.ui.custom<string | null>((tui, _theme, _kb, done) => {
			return new QnAComponent(extractionResult.questions, tui, done);
		});

		if (answersResult === null) {
			ctx.ui.notify("Cancelled", "info");
			return;
		}

		pi.sendMessage(
			{
				customType: "answers",
				content: "I answered your questions:\n\n" + answersResult,
				display: true,
			},
			{ triggerTurn: true },
		);
	};

	pi.registerCommand("answer", {
		description: "Extract questions from last assistant message into interactive Q&A",
		handler: (_args, ctx) => answerHandler(ctx),
	});

	pi.registerShortcut("ctrl+.", {
		description: "Extract and answer questions",
		handler: answerHandler,
	});
}
