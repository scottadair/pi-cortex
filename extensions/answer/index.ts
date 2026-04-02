/**
 * Answer Extension - Q&A extraction and interactive answering
 *
 * Extracts questions from assistant responses using a fast model,
 * presents them in an interactive TUI, and sends answers back.
 *
 * Registers:
 * - /answer command
 * - Ctrl+. shortcut
 *
 * Exports triggerAnswer() for use by other extensions (e.g. todos refine auto-trigger).
 */

import { complete, type Model, type Api, type UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { BorderedLoader } from "@mariozechner/pi-coding-agent";
import {
	type Component,
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	truncateToWidth,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@mariozechner/pi-tui";

// ---------------------------------------------------------------------------
// Structured output for question extraction
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
- If no questions are found, return {"questions": []}

Example output:
{
  "questions": [
    {
      "question": "What is your preferred database?",
      "context": "We can only configure MySQL and PostgreSQL because of what is implemented."
    },
    {
      "question": "Should we use TypeScript or JavaScript?"
    }
  ]
}`;

// ---------------------------------------------------------------------------
// Model selection — prefer fast models for extraction
// ---------------------------------------------------------------------------

const CODEX_MODEL_ID = "gpt-5.1-codex-mini";
const HAIKU_MODEL_ID = "claude-haiku-4-5";

async function selectExtractionModel(
	currentModel: Model<Api>,
	modelRegistry: ModelRegistry,
): Promise<Model<Api>> {
	const codexModel = modelRegistry.find("openai-codex", CODEX_MODEL_ID);
	if (codexModel) {
		const auth = await modelRegistry.getApiKeyAndHeaders(codexModel);
		if (auth.ok) return codexModel;
	}

	const haikuModel = modelRegistry.find("anthropic", HAIKU_MODEL_ID);
	if (!haikuModel) return currentModel;

	const auth = await modelRegistry.getApiKeyAndHeaders(haikuModel);
	if (!auth.ok) return currentModel;

	return haikuModel;
}

// ---------------------------------------------------------------------------
// JSON parsing
// ---------------------------------------------------------------------------

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
	pi.registerCommand("answer", {
		description: "Extract questions from last assistant message into interactive Q&A",
		handler: (_args, ctx) => triggerAnswer(pi, ctx),
	});

	pi.registerShortcut("ctrl+.", {
		description: "Extract and answer questions",
		handler: (ctx) => triggerAnswer(pi, ctx),
	});
}
