/**
 * Answer Extension - Q&A extraction and interactive answering
 *
 * Provides an ask_user tool for agent-to-user communication with modes:
 * - select: Pick from a list of options (with multi-select, recommended, "Other")
 * - input: Free-text entry
 * - confirm: Yes/no question
 * - Batch mode: multiple questions via questions[] array
 *
 * Also provides /answer command and Ctrl+. shortcut for extracting questions
 * from the last assistant message and presenting them in an interactive TUI.
 *
 * Registers:
 * - ask_user tool
 * - /answer command
 * - Ctrl+. shortcut
 *
 * Exports triggerAnswer() for use by other extensions (e.g. todos refine auto-trigger).
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	type Component,
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	truncateToWidth,
	Text,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// Structured output for question extraction
// ---------------------------------------------------------------------------

interface ExtractedQuestion {
	question: string;
	context?: string;
}

// ---------------------------------------------------------------------------
// Simple regex-based question extraction
// ---------------------------------------------------------------------------

function extractQuestions(text: string): ExtractedQuestion[] {
	const lines = text.split("\n");
	const questions: ExtractedQuestion[] = [];

	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i]
			.replace(/^\s*[-*•]\s*/, "")
			.replace(/^\s*\d+[.)]\s*/, "")
			.replace(/\*{1,2}/g, "")
			.trim();
		if (trimmed.endsWith("?") && trimmed.length > 10) {
			questions.push({ question: trimmed });
		}
	}

	return questions;
}

// ---------------------------------------------------------------------------
// Terminal notification
// ---------------------------------------------------------------------------

function sendNotification(): void {
	try {
		process.stdout.write("\x1b]9;Waiting for input\x07");
	} catch {
		// Ignore if stdout isn't writable
	}
}

// ---------------------------------------------------------------------------
// Constants for select UI
// ---------------------------------------------------------------------------

const OTHER_LABEL = "Other (type your own)";
const RECOMMENDED_SUFFIX = " (Recommended)";
const DONE_LABEL = "✓ Done selecting";

function addRecommendedSuffix(labels: string[], index?: number): string[] {
	if (index === undefined || index < 0 || index >= labels.length) return labels;
	return labels.map((l, i) => (i === index ? l + RECOMMENDED_SUFFIX : l));
}

function stripRecommendedSuffix(label: string): string {
	return label.endsWith(RECOMMENDED_SUFFIX) ? label.slice(0, -RECOMMENDED_SUFFIX.length) : label;
}

// ---------------------------------------------------------------------------
// Multi-select helper (looped ctx.ui.select)
// ---------------------------------------------------------------------------

interface SelectUI {
	select: (q: string, opts: string[]) => Promise<string | undefined>;
	input: (q: string, p: string) => Promise<string | undefined>;
}

async function multiSelect(
	ui: SelectUI,
	question: string,
	options: { label: string }[],
	recommended?: number,
): Promise<{ selected: string[]; customInput?: string; cancelled: boolean }> {
	const selected = new Set<string>();

	while (true) {
		const labels: string[] = options.map((o, i) => {
			const check = selected.has(o.label) ? "☑" : "☐";
			let label = `${check} ${o.label}`;
			if (i === recommended) label += RECOMMENDED_SUFFIX;
			return label;
		});
		if (selected.size > 0) labels.push(DONE_LABEL);
		labels.push(OTHER_LABEL);

		const prefix = selected.size > 0 ? `(${selected.size} selected) ` : "";
		const choice = await ui.select(`${prefix}${question}`, labels);

		if (choice == null) {
			return { selected: Array.from(selected), cancelled: selected.size === 0 };
		}
		if (choice === DONE_LABEL) {
			return { selected: Array.from(selected), cancelled: false };
		}
		if (choice === OTHER_LABEL) {
			const input = await ui.input("Enter your response:", "");
			return {
				selected: Array.from(selected),
				customInput: input || undefined,
				cancelled: !input && selected.size === 0,
			};
		}

		// Toggle the option
		const raw = choice.replace(/^[☑☐] /, "").replace(RECOMMENDED_SUFFIX, "");
		if (selected.has(raw)) selected.delete(raw);
		else selected.add(raw);
	}
}

// ---------------------------------------------------------------------------
// ask_user tool parameters and details
// ---------------------------------------------------------------------------

const QuestionItem = Type.Object({
	id: Type.String({ description: "Question ID, e.g. 'auth', 'cache'" }),
	question: Type.String({ description: "Question text" }),
	options: Type.Optional(
		Type.Array(
			Type.Object({
				label: Type.String({ description: "Option label" }),
				markdown: Type.Optional(Type.String({ description: "Markdown preview" })),
			}),
		),
	),
	multi: Type.Optional(Type.Boolean({ description: "Allow multiple selections" })),
	recommended: Type.Optional(Type.Number({ description: "Index of recommended option (0-indexed)" })),
});

const AskUserParams = Type.Object({
	// Single-question mode (backward compatible)
	question: Type.Optional(Type.String({ description: "The question to ask the user" })),
	mode: Type.Optional(
		StringEnum(["select", "input", "confirm"] as const),
	),
	options: Type.Optional(
		Type.Array(
			Type.Object({
				label: Type.String({ description: "Option label shown in the list" }),
				markdown: Type.Optional(Type.String({ description: "Markdown preview shown when this option is highlighted" })),
			}),
			{ description: "Options for select mode" },
		),
	),
	placeholder: Type.Optional(Type.String({ description: "Placeholder text for input mode" })),
	detail: Type.Optional(Type.String({ description: "Detail text for confirm mode" })),
	multi: Type.Optional(Type.Boolean({ description: "Allow multiple selections in select mode" })),
	recommended: Type.Optional(Type.Number({ description: "Index of recommended option (0-indexed)" })),
	// Multi-question batch mode (takes priority over single-question params)
	questions: Type.Optional(
		Type.Array(QuestionItem, {
			description: "Multi-question batch mode. When provided, mode/question/options are ignored.",
		}),
	),
});

// ---------------------------------------------------------------------------
// Details types
// ---------------------------------------------------------------------------

interface QuestionResult {
	id: string;
	question: string;
	options: string[];
	multi: boolean;
	selectedOptions: string[];
	customInput?: string;
}

interface AskUserDetails {
	mode: string;
	question: string;
	answer?: string;
	cancelled?: boolean;
	selectedMarkdown?: string;
	results?: QuestionResult[];
}

function buildAskUserDetails(input: {
	mode: string;
	question: string;
	answer?: string;
	cancelled?: boolean;
	selectedMarkdown?: string;
	results?: QuestionResult[];
}): AskUserDetails {
	const details: AskUserDetails = {
		mode: input.mode,
		question: input.question,
	};
	if (input.answer !== undefined) details.answer = input.answer;
	if (input.cancelled) details.cancelled = true;
	if (input.selectedMarkdown !== undefined) details.selectedMarkdown = input.selectedMarkdown;
	if (input.results) details.results = input.results;
	return details;
}

// ---------------------------------------------------------------------------
// Batch Question TUI Component
// ---------------------------------------------------------------------------

interface BatchQuestion {
	id: string;
	question: string;
	options?: { label: string; markdown?: string }[];
	multi?: boolean;
	recommended?: number;
}

interface BatchQuestionResult {
	selectedOptions: string[];
	customInput?: string;
	cursorIndex: number;
}

class BatchQuestionComponent implements Component {
	private questions: BatchQuestion[];
	private results: BatchQuestionResult[];
	private currentIndex: number = 0;
	private editor: Editor;
	private tui: TUI;
	private onDone: (result: QuestionResult[] | null) => void;
	private showingConfirmation: boolean = false;
	private cachedWidth?: number;
	private cachedLines?: string[];

	private dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
	private bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
	private cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
	private green = (s: string) => `\x1b[32m${s}\x1b[0m`;
	private yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
	private gray = (s: string) => `\x1b[90m${s}\x1b[0m`;
	constructor(
		questions: BatchQuestion[],
		tui: TUI,
		_theme: any,
		onDone: (result: QuestionResult[] | null) => void,
	) {
		this.questions = questions;
		this.tui = tui;
		this.onDone = onDone;

		// Initialize results for each question
		this.results = questions.map((q) => ({
			selectedOptions: [],
			customInput: undefined,
			cursorIndex: q.recommended ?? 0,
		}));

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

		// Load editor text for first question if it's an input question
		if (!questions[0]?.options?.length) {
			this.editor.setText(this.results[0]?.customInput || "");
		}
	}

	private get currentQuestion(): BatchQuestion {
		return this.questions[this.currentIndex];
	}

	private get currentResult(): BatchQuestionResult {
		return this.results[this.currentIndex];
	}

	private get isSelectQuestion(): boolean {
		return (this.currentQuestion.options?.length ?? 0) > 0;
	}

	/** Total options including "Other" and possibly "Done" */
	private getDisplayOptions(): string[] {
		const q = this.currentQuestion;
		const r = this.currentResult;
		if (!q.options?.length) return [];

		const labels: string[] = q.options.map((o, i) => {
			if (q.multi) {
				const check = r.selectedOptions.includes(o.label) ? "☑" : "☐";
				let label = `${check} ${o.label}`;
				if (i === q.recommended) label += RECOMMENDED_SUFFIX;
				return label;
			}
			let label = o.label;
			if (i === q.recommended) label += RECOMMENDED_SUFFIX;
			return label;
		});
		if (q.multi && r.selectedOptions.length > 0) {
			labels.push(DONE_LABEL);
		}
		labels.push(OTHER_LABEL);
		return labels;
	}

	private saveCurrentInput(): void {
		if (!this.isSelectQuestion) {
			this.currentResult.customInput = this.editor.getText();
		}
	}

	private navigateTo(index: number): void {
		if (index < 0 || index >= this.questions.length) return;
		this.saveCurrentInput();
		this.currentIndex = index;
		// Load editor for input questions
		if (!this.isSelectQuestion) {
			this.editor.setText(this.currentResult.customInput || "");
		}
		this.invalidate();
	}

	private isQuestionAnswered(index: number): boolean {
		const r = this.results[index];
		const q = this.questions[index];
		if (q.options?.length) {
			return r.selectedOptions.length > 0 || r.customInput !== undefined;
		}
		return (r.customInput?.trim() || "").length > 0;
	}

	private submit(): void {
		this.saveCurrentInput();
		const results: QuestionResult[] = this.questions.map((q, i) => ({
			id: q.id,
			question: q.question,
			options: q.options?.map((o) => o.label) ?? [],
			multi: q.multi ?? false,
			selectedOptions: this.results[i].selectedOptions,
			customInput: this.results[i].customInput,
		}));
		this.onDone(results);
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

		// Global navigation
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.onDone(null);
			return;
		}

		// Left/right arrow for question navigation
		if (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab"))) {
			if (this.currentIndex > 0) {
				this.navigateTo(this.currentIndex - 1);
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
			if (this.currentIndex < this.questions.length - 1) {
				this.navigateTo(this.currentIndex + 1);
				this.tui.requestRender();
			}
			return;
		}

		if (this.isSelectQuestion) {
			const opts = this.getDisplayOptions();
			const r = this.currentResult;
			const q = this.currentQuestion;

			// Up/down to move cursor
			if (matchesKey(data, Key.up)) {
				r.cursorIndex = Math.max(0, r.cursorIndex - 1);
				this.invalidate();
				this.tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.down)) {
				r.cursorIndex = Math.min(opts.length - 1, r.cursorIndex + 1);
				this.invalidate();
				this.tui.requestRender();
				return;
			}

			// Enter or Space to select
			if (matchesKey(data, Key.enter) || data === " ") {
				const selected = opts[r.cursorIndex];
				if (!selected) return;

				if (selected === DONE_LABEL) {
					// Advance to next question or submit
					this.advanceOrSubmit();
					return;
				}

				if (selected === OTHER_LABEL) {
					// Switch to input mode for this question
					this.currentResult.customInput = "";
					this.editor.setText("");
					// Temporarily treat as input — we'll render the editor
					// Store that we're in "other" mode by clearing options temporarily
					// Actually, let's just advance after getting input inline
					this.invalidate();
					this.tui.requestRender();
					return;
				}

				if (q.multi) {
					// Toggle selection
					const raw = selected.replace(/^[☑☐] /, "").replace(RECOMMENDED_SUFFIX, "");
					const idx = r.selectedOptions.indexOf(raw);
					if (idx >= 0) {
						r.selectedOptions.splice(idx, 1);
					} else {
						r.selectedOptions.push(raw);
					}
					this.invalidate();
					this.tui.requestRender();
					return;
				}

				// Single select — pick and advance
				const raw = stripRecommendedSuffix(selected);
				r.selectedOptions = [raw];
				r.customInput = undefined;
				this.advanceOrSubmit();
				return;
			}
		} else {
			// Input question — forward to editor
			if (matchesKey(data, Key.enter) && !matchesKey(data, Key.shift("enter"))) {
				this.saveCurrentInput();
				this.advanceOrSubmit();
				return;
			}
			this.editor.handleInput(data);
			this.invalidate();
			this.tui.requestRender();
		}
	}

	private advanceOrSubmit(): void {
		if (this.currentIndex < this.questions.length - 1) {
			this.navigateTo(this.currentIndex + 1);
		} else {
			this.saveCurrentInput();
			this.showingConfirmation = true;
		}
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
		const emptyBoxLine = (): string =>
			this.dim("\u2502") + " ".repeat(boxWidth - 2) + this.dim("\u2502");
		const padToWidth = (line: string): string => {
			const len = visibleWidth(line);
			return line + " ".repeat(Math.max(0, width - len));
		};

		// Top border + title
		lines.push(padToWidth(this.dim("\u256d" + horizontalLine(boxWidth - 2) + "\u256e")));
		const title = `${this.bold(this.cyan("Ask"))} ${this.dim(`(${this.currentIndex + 1}/${this.questions.length})`)}`;
		lines.push(padToWidth(boxLine(title)));
		lines.push(padToWidth(this.dim("\u251c" + horizontalLine(boxWidth - 2) + "\u2524")));

		// Progress dots
		const progressParts: string[] = [];
		for (let i = 0; i < this.questions.length; i++) {
			const current = i === this.currentIndex;
			const answered = this.isQuestionAnswered(i);
			if (current) progressParts.push(this.cyan("\u25cf"));
			else if (answered) progressParts.push(this.green("\u25cf"));
			else progressParts.push(this.dim("\u25cb"));
		}
		lines.push(padToWidth(boxLine(progressParts.join(" "))));
		lines.push(padToWidth(emptyBoxLine()));

		// Question text with ID
		const q = this.currentQuestion;
		const idLabel = this.dim(`[${q.id}] `);
		const questionText = `${idLabel}${this.bold(q.question)}`;
		for (const line of wrapTextWithAnsi(questionText, contentWidth)) {
			lines.push(padToWidth(boxLine(line)));
		}
		lines.push(padToWidth(emptyBoxLine()));

		// Content: options or editor
		if (this.isSelectQuestion) {
			const opts = this.getDisplayOptions();
			const r = this.currentResult;
			for (let i = 0; i < opts.length; i++) {
				const isCursor = i === r.cursorIndex;
				const pointer = isCursor ? this.cyan("▸ ") : "  ";
				let label = opts[i];

				// Color the option
				if (label === DONE_LABEL) {
					label = isCursor ? this.cyan(label) : this.green(label);
				} else if (label === OTHER_LABEL) {
					label = isCursor ? this.cyan(label) : this.dim(label);
				} else if (label.startsWith("☑")) {
					label = this.green(label);
				} else if (isCursor) {
					label = this.cyan(label);
				} else {
					label = this.dim(label);
				}

				lines.push(padToWidth(boxLine(pointer + label)));
			}
		} else {
			// Input mode — show editor
			const editorWidth = contentWidth - 4 - 3;
			const editorLines = this.editor.render(editorWidth);
			for (let i = 1; i < editorLines.length - 1; i++) {
				if (i === 1) lines.push(padToWidth(boxLine(this.bold("A: ") + editorLines[i])));
				else lines.push(padToWidth(boxLine("   " + editorLines[i])));
			}
		}
		lines.push(padToWidth(emptyBoxLine()));

		// Footer
		if (this.showingConfirmation) {
			lines.push(padToWidth(this.dim("\u251c" + horizontalLine(boxWidth - 2) + "\u2524")));
			lines.push(
				padToWidth(
					boxLine(
						truncateToWidth(
							`${this.yellow("Submit all answers?")} ${this.dim("(Enter/y to confirm, Esc/n to cancel)")}`,
							contentWidth,
						),
					),
				),
			);
		} else {
			lines.push(padToWidth(this.dim("\u251c" + horizontalLine(boxWidth - 2) + "\u2524")));
			const navHint = this.isSelectQuestion
				? `${this.dim("\u2191\u2193")} select \u00b7 ${this.dim("Enter")} pick \u00b7 ${this.dim("\u2190\u2192")} question \u00b7 ${this.dim("Esc")} cancel`
				: `${this.dim("Enter")} next \u00b7 ${this.dim("\u2190\u2192")} question \u00b7 ${this.dim("Shift+Enter")} newline \u00b7 ${this.dim("Esc")} cancel`;
			lines.push(padToWidth(boxLine(truncateToWidth(navHint, contentWidth))));
		}
		lines.push(padToWidth(this.dim("\u2570" + horizontalLine(boxWidth - 2) + "\u256f")));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

// ---------------------------------------------------------------------------
// Interactive Q&A TUI component (for /answer extraction)
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
// Answer handler — exported for use by other extensions
// ---------------------------------------------------------------------------

export async function triggerAnswer(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/answer requires interactive mode", "error");
		return;
	}

	const branch = ctx.sessionManager.getBranch();
	let lastAssistantText: string | undefined;

	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "message") {
			const msg = entry.message;
			if ("role" in msg && msg.role === "assistant") {
				if ("stopReason" in msg && msg.stopReason !== "stop") {
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

	const questions = extractQuestions(lastAssistantText);

	if (questions.length === 0) {
		ctx.ui.notify("No questions found in the last message", "info");
		return;
	}

	const answersResult = await ctx.ui.custom<string | null>((tui, _theme, _kb, done) => {
		return new QnAComponent(questions, tui, done);
	});

	if (answersResult === null) {
		ctx.ui.notify("Cancelled", "info");
		return;
	}

	pi.sendMessage(
		{
			customType: "answers",
			content: "I answered your questions in the following way:\n\n" + answersResult,
			display: true,
		},
		{ triggerTurn: true },
	);
}

// ---------------------------------------------------------------------------
// Extension registration
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// Register ask_user tool
	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description:
			"Ask the user a question with inline interactive UI. " +
			"Three modes: 'select' shows an inline picker with options (supports multi-select via multi:true, " +
			"recommended option via recommended:<index>). 'input' prompts for free-text entry. " +
			"'confirm' asks a yes/no question. " +
			"For select mode, provide options[] with label and optional markdown for each. " +
			"An 'Other (type your own)' option is automatically added to select questions. " +
			"For multiple related questions, use questions[] array with id per question instead of calling multiple times.",
		parameters: AskUserParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// Terminal notification
			sendNotification();

			// ── Batch mode: questions[] takes priority ──────────────
			if (params.questions && params.questions.length > 0) {
				const batchQuestions: BatchQuestion[] = params.questions.map((q) => ({
					id: q.id,
					question: q.question,
					options: q.options,
					multi: q.multi,
					recommended: q.recommended,
				}));

				const results = await ctx.ui.custom<QuestionResult[] | null>(
					(tui, theme, _kb, done) => {
						return new BatchQuestionComponent(batchQuestions, tui, theme, done);
					},
				);

				if (!results) {
					return {
						content: [{ type: "text" as const, text: "[User cancelled]" }],
						details: buildAskUserDetails({ mode: "batch", question: "Multiple questions", cancelled: true }),
					};
				}

				// Format structured results
				const lines = results.map((r) => {
					if (r.customInput) return `${r.id}: "${r.customInput}"`;
					if (r.selectedOptions.length > 0) {
						return r.multi
							? `${r.id}: [${r.selectedOptions.join(", ")}]`
							: `${r.id}: ${r.selectedOptions[0]}`;
					}
					return `${r.id}: (skipped)`;
				});

				return {
					content: [{ type: "text" as const, text: `User answers:\n${lines.join("\n")}` }],
					details: buildAskUserDetails({
						mode: "batch",
						question: "Multiple questions",
						results,
					}),
				};
			}

			// ── Single question mode ────────────────────────────────
			const { question, mode, options, placeholder, detail } = params;

			if (!question) {
				return {
					content: [{ type: "text" as const, text: "Error: question is required (or use questions[] for batch mode)" }],
				};
			}

			if (mode === "select") {
				if (!options || options.length === 0) {
					return {
						content: [{ type: "text" as const, text: "Error: options[] required for select mode" }],
					};
				}

				const selectUi: SelectUI = {
					select: (q, o) => ctx.ui.select(q, o),
					input: (q, p) => ctx.ui.input(q, p),
				};

				if (params.multi) {
					// Multi-select mode
					const { selected, customInput, cancelled } = await multiSelect(
						selectUi,
						question,
						options,
						params.recommended,
					);
					if (cancelled) {
						return {
							content: [{ type: "text" as const, text: "[User cancelled]" }],
							details: buildAskUserDetails({ mode, question, cancelled: true }),
						};
					}
					const parts: string[] = [];
					if (selected.length > 0) parts.push(`User selected: ${selected.join(", ")}`);
					if (customInput) parts.push(`User provided custom input: ${customInput}`);
					return {
						content: [{ type: "text" as const, text: parts.join("\n") || "[No selection]" }],
						details: buildAskUserDetails({ mode, question, answer: selected.join(", ") }),
					};
				}

				// Single-select with "Other" and "Recommended"
				const displayLabels = addRecommendedSuffix(
					options.map((o) => o.label),
					params.recommended,
				);
				displayLabels.push(OTHER_LABEL);

				const result = await ctx.ui.select(question, displayLabels);
				if (result == null) {
					return {
						content: [{ type: "text" as const, text: "[User cancelled]" }],
						details: buildAskUserDetails({ mode, question, cancelled: true }),
					};
				}
				if (result === OTHER_LABEL) {
					const customInput = await ctx.ui.input("Enter your response:", "");
					if (!customInput) {
						return {
							content: [{ type: "text" as const, text: "[User cancelled]" }],
							details: buildAskUserDetails({ mode, question, cancelled: true }),
						};
					}
					return {
						content: [{ type: "text" as const, text: `User provided custom input: ${customInput}` }],
						details: buildAskUserDetails({ mode, question, answer: customInput }),
					};
				}
				const cleanResult = stripRecommendedSuffix(result);
				const opt = options.find((o) => o.label === cleanResult);
				return {
					content: [{ type: "text" as const, text: `User selected: ${cleanResult}` }],
					details: buildAskUserDetails({
						mode,
						question,
						answer: cleanResult,
						selectedMarkdown: opt?.markdown,
					}),
				};
			}

			if (mode === "input") {
				const answer = await ctx.ui.input(question, placeholder || "");
				if (!answer) {
					return {
						content: [{ type: "text" as const, text: "[User cancelled]" }],
						details: buildAskUserDetails({ mode, question, cancelled: true }),
					};
				}
				return {
					content: [{ type: "text" as const, text: `User answered: ${answer}` }],
					details: buildAskUserDetails({ mode, question, answer }),
				};
			}

			if (mode === "confirm") {
				const confirmed = await ctx.ui.confirm(question, detail || "", { timeout: 60000 });
				return {
					content: [
						{
							type: "text" as const,
							text: confirmed ? "User confirmed: Yes" : "User declined: No",
						},
					],
					details: buildAskUserDetails({ mode, question, answer: confirmed ? "Yes" : "No" }),
				};
			}

			return {
				content: [{ type: "text" as const, text: `Error: unknown mode '${mode}'` }],
			};
		},

		renderCall(args, theme) {
			// Batch mode
			if (args.questions?.length) {
				let text = theme.fg("toolTitle", theme.bold("ask_user "));
				text += theme.fg("muted", `${args.questions.length} questions`);
				const ids = args.questions.map((q: any) => q.id).join(", ");
				text += theme.fg("dim", `  [${ids}]`);
				return new Text(text, 0, 0);
			}

			// Single mode
			let text = theme.fg("toolTitle", theme.bold("ask_user "));
			text += theme.fg("muted", args.mode || "");
			if (args.multi) text += theme.fg("dim", " multi");
			text += theme.fg("dim", `  "${args.question}"`);
			if (args.mode === "select" && args.options?.length) {
				text += theme.fg("dim", `  ${args.options.length} options`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as AskUserDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.cancelled) {
				return new Text(theme.fg("dim", "[Cancelled]"), 0, 0);
			}

			// Batch results — tree rendering
			if (details.results && details.results.length > 0) {
				const hasAny = details.results.some(
					(r) => r.customInput !== undefined || r.selectedOptions.length > 0,
				);
				const icon = hasAny ? theme.fg("success", "✓") : theme.fg("warning", "⚠");
				const lines: string[] = [
					`${icon} ${theme.fg("accent", "Ask")} ${theme.fg("dim", `(${details.results.length} questions)`)}`,
				];

				for (let i = 0; i < details.results.length; i++) {
					const r = details.results[i];
					const isLast = i === details.results.length - 1;
					const branch = isLast ? "└─" : "├─";
					const hasAnswer = r.customInput !== undefined || r.selectedOptions.length > 0;
					const statusIcon = hasAnswer
						? theme.fg("success", "✓")
						: theme.fg("warning", "⚠");

					if (r.customInput !== undefined) {
						const preview = r.customInput.length > 50
							? r.customInput.slice(0, 47) + "..."
							: r.customInput;
						lines.push(
							`${theme.fg("dim", branch)} ${statusIcon} ${theme.fg("dim", `[${r.id}]`)} ${theme.fg("muted", `"${preview}"`)}`,
						);
					} else if (r.selectedOptions.length > 0) {
						const answer = r.multi
							? r.selectedOptions.join(", ")
							: r.selectedOptions[0];
						lines.push(
							`${theme.fg("dim", branch)} ${statusIcon} ${theme.fg("dim", `[${r.id}]`)} ${theme.fg("accent", answer)}`,
						);
					} else {
						lines.push(
							`${theme.fg("dim", branch)} ${statusIcon} ${theme.fg("dim", `[${r.id}]`)} ${theme.fg("warning", "(skipped)")}`,
						);
					}
				}

				return new Text(lines.join("\n"), 0, 0);
			}

			// Confirm mode
			if (details.mode === "confirm") {
				const color = details.answer === "Yes" ? "success" : "warning";
				const icon = details.answer === "Yes" ? "✓" : "✗";
				const label = details.answer === "Yes" ? "Confirmed" : "Declined";
				return new Text(
					`${theme.fg(color, icon)} ${theme.fg(color, label)}`,
					0,
					0,
				);
			}

			// Select or input — single question
			const icon = theme.fg("success", "✓");
			const summary =
				details.mode === "select"
					? `Selected: ${details.answer}`
					: `Answer: ${details.answer}`;

			if (expanded && details.selectedMarkdown) {
				const preview = details.selectedMarkdown
					.split("\n")
					.slice(0, 8)
					.map((l) => theme.fg("muted", "  " + l))
					.join("\n");
				return new Text(
					`${icon} ${theme.fg("accent", summary)}\n${preview}`,
					0,
					0,
				);
			}

			return new Text(`${icon} ${theme.fg("accent", summary)}`, 0, 0);
		},
	});

	pi.registerCommand("answer", {
		description: "Extract questions from last assistant message into interactive Q&A",
		handler: (_args, ctx) => triggerAnswer(pi, ctx),
	});

	pi.registerShortcut("ctrl+.", {
		description: "Extract and answer questions",
		handler: (ctx) => triggerAnswer(pi, ctx),
	});
}
