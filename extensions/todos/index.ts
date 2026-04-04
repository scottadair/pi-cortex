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
import { isTmuxAvailable, openEditorPane } from "../team/tmux.ts";
import { triggerAnswer } from "../answer/index.ts";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { DynamicBorder, copyToClipboard, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import {
	Container,
	type Focusable,
	Input,
	Key,
	Markdown,
	matchesKey,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
	type TUI,
	fuzzyMatch,
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

interface TodoFile {
	meta: TodoMeta;
	description: string;
	plan: string;
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

		// Use indexOf for robust section extraction.
		// Plan content often contains ## headers (## Context, ## Changes, etc.)
		// so regex with lookahead for \n## would truncate it.
		const descHeader = "## Description\n";
		const planHeader = "## Plan\n";
		const descIndex = body.indexOf(descHeader);
		const planIndex = body.indexOf(planHeader);

		let description = "";
		let plan = "";

		if (descIndex !== -1 && planIndex !== -1 && descIndex < planIndex) {
			// Both sections present (normal order): description between headers, plan is everything after
			description = body.substring(descIndex + descHeader.length, planIndex).trim();
			plan = body.substring(planIndex + planHeader.length).trim();
		} else if (descIndex !== -1 && planIndex !== -1 && planIndex < descIndex) {
			// Both sections present (reversed order)
			plan = body.substring(planIndex + planHeader.length, descIndex).trim();
			description = body.substring(descIndex + descHeader.length).trim();
		} else if (descIndex !== -1) {
			// Only description
			description = body.substring(descIndex + descHeader.length).trim();
		} else if (planIndex !== -1) {
			// Only plan
			plan = body.substring(planIndex + planHeader.length).trim();
		} else if (body.trim()) {
			// No sections found: treat whole body as description (backwards compat)
			return { meta, description: body.trim(), plan: "" };
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

	if (todo.plan) {
		body += `## Plan\n${todo.plan}\n\n`;
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
		return b.meta.id.localeCompare(a.meta.id);
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

function deleteTodoFile(cwd: string, id: string): boolean {
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
// Todo search / filter helpers
// ---------------------------------------------------------------------------

function buildTodoSearchText(todo: TodoFile): string {
	const tags = (todo.meta.tags ?? []).join(" ");
	const assignee = todo.meta.assignee ? `@${todo.meta.assignee}` : "";
	return `#${todo.meta.id} ${todo.meta.title} ${tags} ${todo.meta.status} ${assignee}`.trim();
}

function filterTodos(todos: TodoFile[], query: string): TodoFile[] {
	const trimmed = query.trim();
	if (!trimmed) return todos;

	const tokens = trimmed.split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return todos;

	const matches: Array<{ todo: TodoFile; score: number }> = [];
	for (const todo of todos) {
		const text = buildTodoSearchText(todo);
		let totalScore = 0;
		let matched = true;
		for (const token of tokens) {
			const result = fuzzyMatch(token, text);
			if (!result.matches) {
				matched = false;
				break;
			}
			totalScore += result.score;
		}
		if (matched) {
			matches.push({ todo, score: totalScore });
		}
	}

	return matches
		.sort((a, b) => {
			const aDone = a.todo.meta.status === "done";
			const bDone = b.todo.meta.status === "done";
			if (aDone !== bDone) return aDone ? 1 : -1;
			return a.score - b.score;
		})
		.map((m) => m.todo);
}

// ---------------------------------------------------------------------------
// Todo selector TUI component
// ---------------------------------------------------------------------------

type TodoMenuAction = "work" | "refine" | "view" | "edit" | "close" | "reopen" | "delete" | "copyPath" | "copyText";

class TodoSelectorComponent extends Container implements Focusable {
	private searchInput: Input;
	private listContainer: Container;
	private allTodos: TodoFile[];
	private filteredTodos: TodoFile[];
	private selectedIndex = 0;
	private onSelectCallback: (todo: TodoFile) => void;
	private onCancelCallback: () => void;
	private tui: TUI;
	private theme: Theme;
	private headerText: Text;
	private hintText: Text;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(
		tui: TUI,
		theme: Theme,
		todos: TodoFile[],
		onSelect: (todo: TodoFile) => void,
		onCancel: () => void,
		initialSearch?: string,
		private onQuickAction?: (todo: TodoFile, action: "work" | "refine") => void,
	) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.allTodos = todos;
		this.filteredTodos = todos;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;

		this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		this.addChild(new Spacer(1));

		this.headerText = new Text("", 1, 0);
		this.addChild(this.headerText);
		this.addChild(new Spacer(1));

		this.searchInput = new Input();
		if (initialSearch) {
			this.searchInput.setValue(initialSearch);
		}
		this.searchInput.onSubmit = () => {
			const selected = this.filteredTodos[this.selectedIndex];
			if (selected) this.onSelectCallback(selected);
		};
		this.addChild(this.searchInput);

		this.addChild(new Spacer(1));
		this.listContainer = new Container();
		this.addChild(this.listContainer);

		this.addChild(new Spacer(1));
		this.hintText = new Text("", 1, 0);
		this.addChild(this.hintText);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		this.updateHeader();
		this.updateHints();
		this.applyFilter(this.searchInput.getValue());
	}

	setTodos(todos: TodoFile[]): void {
		this.allTodos = todos;
		this.updateHeader();
		this.applyFilter(this.searchInput.getValue());
		this.tui.requestRender();
	}

	private updateHeader(): void {
		const openCount = this.allTodos.filter((t) => t.meta.status !== "done").length;
		const closedCount = this.allTodos.length - openCount;
		const title = `Todos (${openCount} open, ${closedCount} done)`;
		this.headerText.setText(this.theme.fg("accent", this.theme.bold(title)));
	}

	private updateHints(): void {
		this.hintText.setText(
			this.theme.fg(
				"dim",
				"Type to search \u00b7 \u2191\u2193 select \u00b7 Enter actions \u00b7 Ctrl+Shift+W work \u00b7 Ctrl+Shift+R refine \u00b7 Esc close",
			),
		);
	}

	private applyFilter(query: string): void {
		this.filteredTodos = filterTodos(this.allTodos, query);
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredTodos.length - 1));
		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();

		if (this.filteredTodos.length === 0) {
			this.listContainer.addChild(new Text(this.theme.fg("muted", "  No matching todos"), 0, 0));
			return;
		}

		const maxVisible = 10;
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredTodos.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.filteredTodos.length);

		for (let i = startIndex; i < endIndex; i++) {
			const todo = this.filteredTodos[i];
			if (!todo) continue;
			const isSelected = i === this.selectedIndex;
			const isDone = todo.meta.status === "done";
			const prefix = isSelected ? this.theme.fg("accent", "\u25b6 ") : "  ";
			const icon = STATUS_ICONS[todo.meta.status] ?? "\u25cb";
			const statusColor = todo.meta.status === "blocked" ? "error" : isDone ? "dim" : "muted";
			const titleColor = isSelected ? "accent" : isDone ? "dim" : "text";
			const priority = todo.meta.priority ? PRIORITY_LABELS[todo.meta.priority] || "" : "";
			const assignee = todo.meta.assignee ? this.theme.fg("dim", ` @${todo.meta.assignee}`) : "";
			const planInfo = todo.plan ? this.theme.fg("dim", " [plan]") : "";
			const tagText = todo.meta.tags?.length ? this.theme.fg("muted", ` [${todo.meta.tags.join(", ")}]`) : "";
			const idText = isSelected ? this.theme.fg("accent", `#${todo.meta.id}`) : this.theme.fg("muted", `#${todo.meta.id}`);

			const line =
				prefix +
				this.theme.fg(statusColor, icon) +
				" " +
				idText +
				" " +
				(priority ? this.theme.fg("warning", priority) + " " : "") +
				this.theme.fg(titleColor, todo.meta.title) +
				tagText +
				planInfo +
				assignee +
				" " +
				this.theme.fg(statusColor === "dim" ? "dim" : "success", `(${todo.meta.status})`);

			this.listContainer.addChild(new Text(line, 0, 0));
		}

		if (startIndex > 0 || endIndex < this.filteredTodos.length) {
			const scrollInfo = this.theme.fg(
				"dim",
				`  (${this.selectedIndex + 1}/${this.filteredTodos.length})`,
			);
			this.listContainer.addChild(new Text(scrollInfo, 0, 0));
		}
	}

	handleInput(keyData: string): void {
		if (matchesKey(keyData, Key.up)) {
			if (this.filteredTodos.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredTodos.length - 1 : this.selectedIndex - 1;
			this.updateList();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(keyData, Key.down)) {
			if (this.filteredTodos.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.filteredTodos.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(keyData, Key.enter)) {
			const selected = this.filteredTodos[this.selectedIndex];
			if (selected) this.onSelectCallback(selected);
			return;
		}
		if (matchesKey(keyData, Key.escape) || matchesKey(keyData, Key.ctrl("c"))) {
			this.onCancelCallback();
			return;
		}
		if (matchesKey(keyData, Key.ctrlShift("r"))) {
			const selected = this.filteredTodos[this.selectedIndex];
			if (selected && this.onQuickAction) this.onQuickAction(selected, "refine");
			return;
		}
		if (matchesKey(keyData, Key.ctrlShift("w"))) {
			const selected = this.filteredTodos[this.selectedIndex];
			if (selected && this.onQuickAction) this.onQuickAction(selected, "work");
			return;
		}
		this.searchInput.handleInput(keyData);
		this.applyFilter(this.searchInput.getValue());
		this.tui.requestRender();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateHeader();
		this.updateHints();
		this.updateList();
	}
}

// ---------------------------------------------------------------------------
// Todo action menu component
// ---------------------------------------------------------------------------

class TodoActionMenuComponent extends Container {
	private selectList: SelectList;
	private onSelectCallback: (action: TodoMenuAction) => void;
	private onCancelCallback: () => void;

	constructor(
		theme: Theme,
		todo: TodoFile,
		onSelect: (action: TodoMenuAction) => void,
		onCancel: () => void,
	) {
		super();
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;

		const isDone = todo.meta.status === "done";
		const title = todo.meta.title || "(untitled)";
		const options: SelectItem[] = [
			{ value: "view", label: "view", description: "View todo details" },
			...(isTmuxAvailable() ? [{ value: "edit", label: "edit", description: "Edit in vim (tmux)" }] : []),
			{ value: "work", label: "work", description: "Work on todo" },
			{ value: "refine", label: "refine", description: "Refine task with Q&A" },
			...(isDone
				? [{ value: "reopen", label: "reopen", description: "Reopen todo" }]
				: [{ value: "close", label: "close", description: "Mark as done" }]),
			{ value: "copyPath", label: "copy path", description: "Copy file path to clipboard" },
			{ value: "copyText", label: "copy text", description: "Copy title and body to clipboard" },
			{ value: "delete", label: "delete", description: "Delete todo" },
		];

		this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		this.addChild(
			new Text(
				theme.fg("accent", theme.bold(`Actions for #${todo.meta.id} "${title}"`)),
			),
		);

		this.selectList = new SelectList(options, options.length, {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});

		this.selectList.onSelect = (item) => this.onSelectCallback(item.value as TodoMenuAction);
		this.selectList.onCancel = () => this.onCancelCallback();

		this.addChild(this.selectList);
		this.addChild(new Text(theme.fg("dim", "Enter to confirm \u00b7 Esc back")));
		this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
	}

	handleInput(keyData: string): void {
		this.selectList.handleInput(keyData);
	}

	override invalidate(): void {
		super.invalidate();
	}
}

// ---------------------------------------------------------------------------
// Todo delete confirmation component
// ---------------------------------------------------------------------------

class TodoDeleteConfirmComponent extends Container {
	private selectList: SelectList;

	constructor(theme: Theme, message: string, onConfirm: (confirmed: boolean) => void) {
		super();

		const options: SelectItem[] = [
			{ value: "yes", label: "Yes" },
			{ value: "no", label: "No" },
		];

		this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		this.addChild(new Text(theme.fg("accent", message)));

		this.selectList = new SelectList(options, options.length, {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});

		this.selectList.onSelect = (item) => onConfirm(item.value === "yes");
		this.selectList.onCancel = () => onConfirm(false);

		this.addChild(this.selectList);
		this.addChild(new Text(theme.fg("dim", "Enter to confirm \u00b7 Esc back")));
		this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
	}

	handleInput(keyData: string): void {
		this.selectList.handleInput(keyData);
	}

	override invalidate(): void {
		super.invalidate();
	}
}

// ---------------------------------------------------------------------------
// Todo detail overlay component
// ---------------------------------------------------------------------------

type TodoOverlayAction = "back" | "work";

class TodoDetailOverlayComponent {
	private todo: TodoFile;
	private theme: Theme;
	private tui: TUI;
	private markdown: Markdown;
	private scrollOffset = 0;
	private viewHeight = 0;
	private totalLines = 0;
	private onAction: (action: TodoOverlayAction) => void;

	constructor(
		tui: TUI,
		theme: Theme,
		todo: TodoFile,
		onAction: (action: TodoOverlayAction) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.todo = todo;
		this.onAction = onAction;
		this.markdown = new Markdown(this.getMarkdownText(), 1, 0, getMarkdownTheme());
	}

	private getMarkdownText(): string {
		const parts: string[] = [];
		if (this.todo.description) {
			parts.push("## Description\n" + this.todo.description);
		}
		if (this.todo.plan) {
			parts.push("## Plan\n" + this.todo.plan);
		}
		return parts.length > 0 ? parts.join("\n\n") : "_No details yet._";
	}

	handleInput(keyData: string): void {
		if (matchesKey(keyData, Key.escape) || matchesKey(keyData, Key.ctrl("c"))) {
			this.onAction("back");
			return;
		}
		if (matchesKey(keyData, Key.enter)) {
			this.onAction("work");
			return;
		}
		if (matchesKey(keyData, Key.up)) {
			this.scrollBy(-1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(keyData, Key.down)) {
			this.scrollBy(1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(keyData, Key.left)) {
			this.scrollBy(-(this.viewHeight || 1));
			this.tui.requestRender();
			return;
		}
		if (matchesKey(keyData, Key.right)) {
			this.scrollBy(this.viewHeight || 1);
			this.tui.requestRender();
			return;
		}
	}

	render(width: number): string[] {
		const maxHeight = Math.max(10, Math.floor((this.tui.terminal.rows || 24) * 0.8));
		const headerLines = 3;
		const footerLines = 3;
		const borderLines = 2;
		const innerWidth = Math.max(10, width - 2);
		const contentHeight = Math.max(1, maxHeight - headerLines - footerLines - borderLines);

		const markdownLines = this.markdown.render(innerWidth);
		this.totalLines = markdownLines.length;
		this.viewHeight = contentHeight;
		const maxScroll = Math.max(0, this.totalLines - contentHeight);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));

		const visibleLines = markdownLines.slice(this.scrollOffset, this.scrollOffset + contentHeight);
		const lines: string[] = [];

		// Title line
		const titleText = ` ${this.todo.meta.title || `Todo #${this.todo.meta.id}`} `;
		const titleWidth = visibleWidth(titleText);
		if (titleWidth >= innerWidth) {
			lines.push(truncateToWidth(this.theme.fg("accent", titleText.trim()), innerWidth));
		} else {
			const leftWidth = Math.max(0, Math.floor((innerWidth - titleWidth) / 2));
			const rightWidth = Math.max(0, innerWidth - titleWidth - leftWidth);
			lines.push(
				this.theme.fg("borderMuted", "\u2500".repeat(leftWidth)) +
				this.theme.fg("accent", titleText) +
				this.theme.fg("borderMuted", "\u2500".repeat(rightWidth)),
			);
		}

		// Meta line
		const icon = STATUS_ICONS[this.todo.meta.status] ?? "\u25cb";
		const statusColor = this.todo.meta.status === "done" ? "dim" : this.todo.meta.status === "blocked" ? "error" : "success";
		const priority = this.todo.meta.priority ? ` ${PRIORITY_LABELS[this.todo.meta.priority] || ""}` : "";
		const assignee = this.todo.meta.assignee ? ` @${this.todo.meta.assignee}` : "";
		const tagText = this.todo.meta.tags?.length ? ` [${this.todo.meta.tags.join(", ")}]` : "";
		lines.push(
			this.theme.fg("accent", `#${this.todo.meta.id}`) +
			this.theme.fg("muted", " \u00b7 ") +
			this.theme.fg(statusColor, `${icon} ${this.todo.meta.status}`) +
			this.theme.fg("warning", priority) +
			this.theme.fg("muted", tagText) +
			this.theme.fg("dim", assignee),
		);
		lines.push("");

		// Content
		for (const line of visibleLines) {
			lines.push(truncateToWidth(line, innerWidth));
		}
		while (lines.length < headerLines + contentHeight) {
			lines.push("");
		}

		// Footer
		lines.push("");
		const workHint = this.theme.fg("accent", "enter") + this.theme.fg("muted", " work");
		const backHint = this.theme.fg("dim", "esc back");
		const navHint = this.theme.fg("dim", "\u2191/\u2193 scroll \u00b7 \u2190/\u2192 page");
		let footerLine = [workHint, backHint, navHint].join(this.theme.fg("muted", " \u00b7 "));
		if (this.totalLines > this.viewHeight) {
			const start = Math.min(this.totalLines, this.scrollOffset + 1);
			const end = Math.min(this.totalLines, this.scrollOffset + this.viewHeight);
			footerLine += this.theme.fg("dim", ` ${start}-${end}/${this.totalLines}`);
		}
		lines.push(footerLine);

		// Frame with border
		const borderColor = (text: string) => this.theme.fg("borderMuted", text);
		const top = borderColor(`\u250c${"\u2500".repeat(innerWidth)}\u2510`);
		const bottom = borderColor(`\u2514${"\u2500".repeat(innerWidth)}\u2518`);
		const framedLines = lines.map((line) => {
			const truncated = truncateToWidth(line, innerWidth);
			const padding = Math.max(0, innerWidth - visibleWidth(truncated));
			return borderColor("\u2502") + truncated + " ".repeat(padding) + borderColor("\u2502");
		});

		return [top, ...framedLines, bottom].map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {
		this.markdown = new Markdown(this.getMarkdownText(), 1, 0, getMarkdownTheme());
	}

	private scrollBy(delta: number): void {
		const maxScroll = Math.max(0, this.totalLines - this.viewHeight);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset + delta, maxScroll));
	}
}

// ---------------------------------------------------------------------------
// Refine prompt builder
// ---------------------------------------------------------------------------

function buildRefinePrompt(id: string, title: string): string {
	return (
		`Let's refine task #${id} "${title}": ` +
		"Ask me for the missing details needed to build a solid description and a full implementation plan. " +
		"Do not rewrite the todo yet and do not make assumptions. " +
		"Ask clear, concrete questions and wait for my answers before writing the plan document.\n\n"
	);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

const TodoParams = Type.Object({
	action: StringEnum(["create", "update", "list", "get", "set-description", "set-plan", "delete", "refine"] as const, {
		description: "Action to perform. Use 'refine' when the user wants to refine, flesh out, or improve a todo's description and plan — this triggers the interactive Q&A workflow.",
	}),
	id: Type.Optional(Type.String({ description: "Todo ID (required for most actions except create, list)" })),
	title: Type.Optional(Type.String({ description: "Todo title (for create, update)" })),
	description: Type.Optional(Type.String({ description: "Description text (for create, set-description)" })),
	plan: Type.Optional(Type.String({ description: "Full implementation plan as markdown (for create, set-plan). Include Context, Changes (with file paths and code), Files to modify, and Verification sections." })),
	plan_file: Type.Optional(Type.String({ description: "Path to file containing the plan (alternative to inline plan). Use the output file path from a team run. The file is deleted after reading." })),
	status: Type.Optional(StringEnum(["todo", "in-progress", "done", "blocked"] as const, {
		description: "Status (for create, update)",
	})),
	assignee: Type.Optional(Type.String({ description: "Team member name (for create, update)" })),
	priority: Type.Optional(StringEnum(["low", "medium", "high"] as const, {
		description: "Priority level (for create, update)",
	})),
	tags: Type.Optional(Type.Array(Type.String(), { description: "Tags (for create, update)" })),
	filter_status: Type.Optional(Type.String({ description: "Filter by status (for list)" })),
	filter_assignee: Type.Optional(Type.String({ description: "Filter by assignee (for list)" })),
});

export default function (pi: ExtensionAPI) {
	// Track whether the current turn was initiated by a refine action,
	// so we can auto-open the /answer Q&A TUI when the agent responds.
	let refineInProgress = false;

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description: [
			"Manage project tasks stored in .cortex/todos/. Each todo has a title, description, and plan.",
			"The plan is a full implementation document in markdown — not just a checklist.",
			"A good plan includes: Context (why), Changes (numbered sections with specific file paths, line numbers, code snippets), Files to modify, and Verification (how to test).",
			"Actions: create (title, description?, plan? or plan_file?, assignee?, priority?, tags?),",
			"update (id, status?, assignee?, priority?, title?, tags?),",
			"list (filter_status?, filter_assignee?), get (id),",
			"set-description (id, description) - replace the description,",
			"set-plan (id, plan or plan_file) - replace the full plan document,",
			"delete (id), refine (id) - ask user clarifying questions to build description and plan.",
			"Status: todo, in-progress, done, blocked. Priority: low, medium, high.",
			"Assignees are team member names: team-lead, dev-backend, dev-frontend, architect, qa.",
		].join(" "),
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cwd = ctx.cwd;

			function resolvePlan(): string {
				if (params.plan_file) {
					try {
						const content = fs.readFileSync(params.plan_file, "utf-8");
						try { fs.unlinkSync(params.plan_file); } catch { /* ignore cleanup failure */ }
						return content;
					} catch (err: any) {
						throw new Error(`Could not read plan file: ${params.plan_file} - ${err.message}`);
					}
				}
				return params.plan ?? "";
			}

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
						description: params.description ?? "",
						plan: resolvePlan(),
					};
					writeTodo(cwd, todo);
					const planInfo = todo.plan ? " (with plan)" : "";
					return {
						content: [{ type: "text", text: `Created todo #${id}: ${params.title}${planInfo}` }],
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
							const hasPlan = t.plan ? " [has plan]" : "";
							return `${icon} #${t.meta.id}: ${t.meta.title} (${t.meta.status})${priority}${hasPlan}${assignee}`;
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
					if (todo.plan) text += `\n## Plan\n${todo.plan}\n`;
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
					todo.plan = resolvePlan();
					todo.meta.updated_at = new Date().toISOString();
					writeTodo(cwd, todo);
					return {
						content: [{ type: "text", text: `Updated plan for todo #${params.id}` }],
						details: { action: "set-plan", todo: todo.meta },
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
					refineInProgress = true;
					let context = `# Refining Todo #${todo.meta.id}: ${todo.meta.title}\n\n`;
					context += `**Current status**: ${todo.meta.status}\n`;
					if (todo.meta.assignee) context += `**Assignee**: ${todo.meta.assignee}\n`;
					if (todo.meta.priority) context += `**Priority**: ${todo.meta.priority}\n`;
					if (todo.meta.tags?.length) context += `**Tags**: ${todo.meta.tags.join(", ")}\n`;
					if (todo.description) context += `\n**Current description**:\n${todo.description}\n`;
					if (todo.plan) context += `\n**Current plan**:\n${todo.plan}\n`;
					context += `\nAsk the user clarifying questions to build a comprehensive description and a full implementation plan for this task. `;
					context += `Do not make assumptions. Ask clear, concrete questions and wait for answers. `;
					context += `After getting answers, use "set-description" for the description and "set-plan" for the plan. `;
					context += `The plan should be a full document with: Context (why this change), Changes (numbered sections with specific files, line numbers, code), Files to modify, and Verification (how to test).`;
					return {
						content: [{ type: "text", text: context }],
						details: { action: "refine", todo: todo.meta },
					};
				}

				case "delete": {
					if (!params.id) {
						return { content: [{ type: "text", text: "Error: id required for delete" }], details: {} };
					}
					const deleted = deleteTodoFile(cwd, params.id);
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
				let line = `${theme.fg(statusColor, icon)} ${theme.fg("accent", `#${todo.id}`)} ${theme.fg("muted", todo.title)}${assignee}`;

				return new Text(line, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "", 0, 0);
		},
	});

	// -----------------------------------------------------------------------
	// /tasks and /todo commands — interactive TUI with selector, action menu,
	// detail overlay, and delete confirmation
	// -----------------------------------------------------------------------

	const todosHandler = async (_args: string | undefined, ctx: ExtensionContext) => {
		if (!ctx.hasUI) {
			ctx.ui.notify("/todo requires interactive mode", "error");
			return;
		}

		const cwd = ctx.cwd;
		const searchTerm = (_args ?? "").trim();
		let nextPrompt: string | null = null;
		let rootTui: TUI | null = null;

		await ctx.ui.custom<void>((tui, theme, _kb, done) => {
			rootTui = tui;
			let selector: TodoSelectorComponent | null = null;
			let actionMenu: TodoActionMenuComponent | null = null;
			let deleteConfirm: TodoDeleteConfirmComponent | null = null;
			let activeComponent:
				| {
						render: (width: number) => string[];
						invalidate: () => void;
						handleInput?: (data: string) => void;
						focused?: boolean;
					}
				| null = null;
			let wrapperFocused = false;

			const setActiveComponent = (
				component:
					| {
							render: (width: number) => string[];
							invalidate: () => void;
							handleInput?: (data: string) => void;
							focused?: boolean;
						}
					| null,
			) => {
				if (activeComponent && "focused" in activeComponent) {
					activeComponent.focused = false;
				}
				activeComponent = component;
				if (activeComponent && "focused" in activeComponent) {
					activeComponent.focused = wrapperFocused;
				}
				tui.requestRender();
			};

			const copyTodoPathToClipboard = (todoId: string) => {
				const filePath = path.join(getTodosDir(cwd), `${todoId}.md`);
				const absolutePath = path.resolve(filePath);
				try {
					copyToClipboard(absolutePath);
					ctx.ui.notify(`Copied ${absolutePath} to clipboard`, "info");
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(message, "error");
				}
			};

			const copyTodoTextToClipboard = (todo: TodoFile) => {
				const title = todo.meta.title || "(untitled)";
				const parts: string[] = [`# ${title}`];
				if (todo.description) parts.push(`\n## Description\n${todo.description}`);
				if (todo.plan) parts.push(`\n## Plan\n${todo.plan}`);
				const text = parts.join("\n");
				try {
					copyToClipboard(text);
					ctx.ui.notify("Copied todo text to clipboard", "info");
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(message, "error");
				}
			};

			const openTodoOverlay = async (todo: TodoFile): Promise<TodoOverlayAction> => {
				const action = await ctx.ui.custom<TodoOverlayAction>(
					(overlayTui, overlayTheme, _overlayKb, overlayDone) =>
						new TodoDetailOverlayComponent(
							overlayTui,
							overlayTheme,
							todo,
							overlayDone,
						),
					{
						overlay: true,
						overlayOptions: { width: "80%", maxHeight: "80%", anchor: "center" },
					},
				);

				return action ?? "back";
			};

			const applyTodoAction = async (
				todo: TodoFile,
				action: TodoMenuAction,
			): Promise<"stay" | "exit"> => {
				if (action === "refine") {
					nextPrompt = buildRefinePrompt(todo.meta.id, todo.meta.title);
					refineInProgress = true;
					done();
					return "exit";
				}
				if (action === "work") {
					let prompt = `Work on todo #${todo.meta.id} "${todo.meta.title}"`;
					if (todo.description) prompt += `\n\n## Description\n${todo.description}`;
					if (todo.plan) prompt += `\n\n## Plan\n${todo.plan}`;
					prompt += `\n\nIMPORTANT: If any file paths reference images (png, jpg, gif, webp), use the read tool to view them for context.`;
					nextPrompt = prompt;
					done();
					return "exit";
				}
				if (action === "view") {
					return "stay";
				}
				if (action === "edit") {
					const filePath = path.resolve(path.join(getTodosDir(cwd), `${todo.meta.id}.md`));
					openEditorPane(filePath);
					return "stay";
				}
				if (action === "copyPath") {
					copyTodoPathToClipboard(todo.meta.id);
					return "stay";
				}
				if (action === "copyText") {
					copyTodoTextToClipboard(todo);
					return "stay";
				}
				if (action === "close") {
					todo.meta.status = "done";
					todo.meta.updated_at = new Date().toISOString();
					writeTodo(cwd, todo);
					const updatedTodos = readAllTodos(cwd);
					selector?.setTodos(updatedTodos);
					ctx.ui.notify(`Closed todo #${todo.meta.id}`, "info");
					return "stay";
				}
				if (action === "reopen") {
					todo.meta.status = "todo";
					todo.meta.updated_at = new Date().toISOString();
					writeTodo(cwd, todo);
					const updatedTodos = readAllTodos(cwd);
					selector?.setTodos(updatedTodos);
					ctx.ui.notify(`Reopened todo #${todo.meta.id}`, "info");
					return "stay";
				}
				if (action === "delete") {
					deleteTodoFile(cwd, todo.meta.id);
					const updatedTodos = readAllTodos(cwd);
					selector?.setTodos(updatedTodos);
					ctx.ui.notify(`Deleted todo #${todo.meta.id}`, "info");
					return "stay";
				}
				return "stay";
			};

			const handleActionSelection = async (todo: TodoFile, action: TodoMenuAction) => {
				if (action === "view") {
					const overlayAction = await openTodoOverlay(todo);
					if (overlayAction === "work") {
						await applyTodoAction(todo, "work");
						return;
					}
					if (actionMenu) {
						setActiveComponent(actionMenu);
					}
					return;
				}

				if (action === "delete") {
					const message = `Delete todo #${todo.meta.id}? This cannot be undone.`;
					deleteConfirm = new TodoDeleteConfirmComponent(theme, message, (confirmed) => {
						if (!confirmed) {
							setActiveComponent(actionMenu);
							return;
						}
						void (async () => {
							await applyTodoAction(todo, "delete");
							setActiveComponent(selector);
						})();
					});
					setActiveComponent(deleteConfirm);
					return;
				}

				const result = await applyTodoAction(todo, action);
				if (result === "stay") {
					setActiveComponent(selector);
				}
			};

			const showActionMenu = (todo: TodoFile) => {
				actionMenu = new TodoActionMenuComponent(
					theme,
					todo,
					(action) => {
						void handleActionSelection(todo, action);
					},
					() => {
						setActiveComponent(selector);
					},
				);
				setActiveComponent(actionMenu);
			};

			const todos = readAllTodos(cwd);

			selector = new TodoSelectorComponent(
				tui,
				theme,
				todos,
				(todo) => {
					showActionMenu(todo);
				},
				() => done(),
				searchTerm || undefined,
				(todo, action) => {
					const title = todo.meta.title || "(untitled)";
					if (action === "refine") {
						nextPrompt = buildRefinePrompt(todo.meta.id, title);
						refineInProgress = true;
					} else {
						nextPrompt = `Work on todo #${todo.meta.id} "${title}"`;
					}
					done();
				},
			);

			setActiveComponent(selector);

			const rootComponent = {
				get focused() {
					return wrapperFocused;
				},
				set focused(value: boolean) {
					wrapperFocused = value;
					if (activeComponent && "focused" in activeComponent) {
						activeComponent.focused = value;
					}
				},
				render(width: number) {
					return activeComponent ? activeComponent.render(width) : [];
				},
				invalidate() {
					activeComponent?.invalidate();
				},
				handleInput(data: string) {
					activeComponent?.handleInput?.(data);
				},
			};

			return rootComponent;
		});

		if (nextPrompt) {
			ctx.ui.setEditorText(nextPrompt);
			rootTui?.requestRender();
		}
	};

	pi.registerCommand("tasks", {
		description: "Show all tasks — select one to refine or work on",
		handler: todosHandler,
	});

	pi.registerCommand("todo", {
		description: "Show all tasks — select one to refine or work on",
		handler: todosHandler,
	});

	// -----------------------------------------------------------------------
	// Auto-trigger /answer after a refine turn completes
	// -----------------------------------------------------------------------

	pi.on("turn_end", async (_event, ctx) => {
		if (!refineInProgress) return;
		refineInProgress = false;
		if (!ctx.hasUI) return;
		// Small delay to let the UI finish rendering the assistant response
		await new Promise((resolve) => setTimeout(resolve, 100));
		await triggerAnswer(pi, ctx);
	});
}
