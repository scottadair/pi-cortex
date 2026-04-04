/**
 * Answer Extension - Q&A extraction and interactive answering
 *
 * Provides an ask_user tool for agent-to-user communication with three modes:
 * - select: Pick from a list of options
 * - input: Free-text entry
 * - confirm: Yes/no question
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
		// Strip bullet points, numbered list prefixes, and bold markers
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
// ask_user tool parameters and details
// ---------------------------------------------------------------------------

const AskUserParams = Type.Object({
	question: Type.String({ description: "The question to ask the user" }),
	mode: StringEnum(["select", "input", "confirm"] as const),
	options: Type.Optional(Type.Array(Type.Object({
		label: Type.String({ description: "Option label shown in the list" }),
		markdown: Type.Optional(Type.String({ description: "Markdown preview shown when this option is highlighted" })),
	}), { description: "Options for select mode (required)" })),
	placeholder: Type.Optional(Type.String({ description: "Placeholder text for input mode" })),
	detail: Type.Optional(Type.String({ description: "Detail text for confirm mode" })),
});

interface AskUserDetails {
	mode: string;
	question: string;
	answer?: string;
	cancelled?: boolean;
	selectedMarkdown?: string;
}

function buildAskUserDetails(input: {
	mode: string;
	question: string;
	answer?: string;
	cancelled?: boolean;
	selectedMarkdown?: string;
}): AskUserDetails {
	const details: AskUserDetails = {
		mode: input.mode,
		question: input.question,
	};
	if (input.answer !== undefined) details.answer = input.answer;
	if (input.cancelled) details.cancelled = true;
	if (input.selectedMarkdown !== undefined) details.selectedMarkdown = input.selectedMarkdown;
	return details;
}



// ---------------------------------------------------------------------------
// Interactive Q&A TUI component
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

	// Extract questions using simple regex (lines ending in ?)
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
			"Three modes: 'select' shows an inline picker with options. " +
			"'input' prompts for free-text entry. 'confirm' asks a yes/no question. " +
			"For select mode, provide options[] with label and optional markdown for each.",
		parameters: AskUserParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { question, mode, options, placeholder, detail } = params;

			if (mode === "select") {
				if (!options || options.length === 0) {
					return {
						content: [{ type: "text" as const, text: "Error: options[] required for select mode" }],
					};
				}

				const labels = options.map((o) => o.label);
				const result = await ctx.ui.select(question, labels);

				if (result == null) {
					return {
						content: [{ type: "text" as const, text: "[User cancelled]" }],
						details: buildAskUserDetails({ mode, question, cancelled: true }),
					};
				}
				const opt = options.find((o) => o.label === result);
				return {
					content: [{ type: "text" as const, text: `User selected: ${result}` }],
					details: buildAskUserDetails({
						mode, question, answer: result,
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
				const confirmed = await ctx.ui.confirm(
					question,
					detail || "",
					{ timeout: 60000 },
				);
				return {
					content: [{ type: "text" as const, text: confirmed ? "User confirmed: Yes" : "User declined: No" }],
					details: buildAskUserDetails({ mode, question, answer: confirmed ? "Yes" : "No" }),
				};
			}

			return {
				content: [{ type: "text" as const, text: `Error: unknown mode '${mode}'` }],
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("ask_user "));
			text += theme.fg("muted", args.mode || "");
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

			if (details.mode === "confirm") {
				const color = details.answer === "Yes" ? "success" : "warning";
				const label = details.answer === "Yes" ? "Confirmed" : "Declined";
				return new Text(theme.fg(color, label), 0, 0);
			}

			// select or input
			const summary = details.mode === "select"
				? `Selected: ${details.answer}`
				: `Answer: ${details.answer}`;

			if (expanded && details.selectedMarkdown) {
				// Show summary + markdown preview as plain text lines
				const preview = details.selectedMarkdown
					.split("\n")
					.slice(0, 8)
					.map((l) => theme.fg("muted", "  " + l))
					.join("\n");
				return new Text(
					theme.fg("accent", summary) + "\n" + preview,
					0, 0,
				);
			}

			return new Text(theme.fg("accent", summary), 0, 0);
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
