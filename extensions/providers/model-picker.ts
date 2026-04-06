/**
 * Model Picker TUI Component
 *
 * Interactive model selector grouped by provider, sorted newest-first,
 * with type-to-filter search and cost/context window info.
 */

import type { Api, Model } from "@mariozechner/pi-ai";
import {
	type Component,
	Key,
	matchesKey,
	truncateToWidth,
	type TUI,
	visibleWidth,
} from "@mariozechner/pi-tui";
import { getModelDate } from "./model-dates.js";

// ── Types ────────────────────────────────────────────────────────────────

interface ModelGroup {
	provider: string;
	models: Model<Api>[];
}

type Row =
	| { type: "header"; provider: string }
	| { type: "model"; model: Model<Api> };

// ── Format helpers ───────────────────────────────────────────────────────

function formatContextWindow(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
	if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
	return `${tokens}`;
}

function formatCost(cost: { input: number; output: number }): string {
	if (cost.input === 0 && cost.output === 0) return "free";
	const fmtNum = (n: number) => {
		if (n >= 10) return `$${n.toFixed(0)}`;
		if (n >= 1) return `$${n.toFixed(1)}`;
		if (n >= 0.01) return `$${n.toFixed(2)}`;
		return `$${n.toFixed(3)}`;
	};
	return `${fmtNum(cost.input)}/${fmtNum(cost.output)}`;
}

function padRight(s: string, targetVisWidth: number): string {
	const vis = visibleWidth(s);
	const pad = Math.max(0, targetVisWidth - vis);
	return s + " ".repeat(pad);
}

// ── Component ────────────────────────────────────────────────────────────

export class ModelPickerComponent implements Component {
	private allGroups: ModelGroup[];
	private rows: Row[] = [];
	private selectableIndices: number[] = [];
	private selectedPos: number = 0;
	private filter: string = "";
	private tui: TUI;
	private onDone: (result: Model<Api> | null) => void;
	private currentModelId?: string;
	private cachedLines?: string[];
	private cachedWidth?: number;
	private scrollOffset: number = 0;
	private maxVisible: number = 20;

	// ANSI helpers
	private dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
	private bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
	private cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
	private green = (s: string) => `\x1b[32m${s}\x1b[0m`;
	private yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
	private magenta = (s: string) => `\x1b[35m${s}\x1b[0m`;
	private bgCyan = (s: string) => `\x1b[46m\x1b[30m${s}\x1b[0m`;

	constructor(
		models: Model<Api>[],
		currentModelId: string | undefined,
		tui: TUI,
		onDone: (result: Model<Api> | null) => void,
	) {
		this.tui = tui;
		this.onDone = onDone;
		this.currentModelId = currentModelId;

		// Group by provider
		const groupMap = new Map<string, Model<Api>[]>();
		for (const m of models) {
			const list = groupMap.get(m.provider) || [];
			list.push(m);
			groupMap.set(m.provider, list);
		}

		// Sort providers alphabetically, models within each group by release date desc
		this.allGroups = [...groupMap.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([provider, providerModels]) => ({
				provider,
				models: providerModels.sort(
					(a, b) => getModelDate(b.id).localeCompare(getModelDate(a.id)),
				),
			}));

		this.rebuildRows();

		// Pre-select the current model if possible
		if (currentModelId) {
			const idx = this.selectableIndices.findIndex((ri) => {
				const row = this.rows[ri];
				return row.type === "model" && row.model.id === currentModelId;
			});
			if (idx >= 0) this.selectedPos = idx;
		}
	}

	private rebuildRows(): void {
		this.rows = [];
		this.selectableIndices = [];
		const lowerFilter = this.filter.toLowerCase();

		for (const group of this.allGroups) {
			const filtered = lowerFilter
				? group.models.filter(
						(m) =>
							m.id.toLowerCase().includes(lowerFilter) ||
							m.name.toLowerCase().includes(lowerFilter) ||
							m.provider.toLowerCase().includes(lowerFilter),
					)
				: group.models;

			if (filtered.length === 0) continue;

			this.rows.push({ type: "header", provider: group.provider });
			for (const model of filtered) {
				this.selectableIndices.push(this.rows.length);
				this.rows.push({ type: "model", model });
			}
		}

		// Clamp selection
		if (this.selectedPos >= this.selectableIndices.length) {
			this.selectedPos = Math.max(0, this.selectableIndices.length - 1);
		}

		this.adjustScroll();
	}

	private adjustScroll(): void {
		if (this.selectableIndices.length === 0) return;
		const selectedRowIdx = this.selectableIndices[this.selectedPos];
		if (selectedRowIdx < this.scrollOffset) {
			this.scrollOffset = Math.max(0, selectedRowIdx - 1);
		} else if (selectedRowIdx >= this.scrollOffset + this.maxVisible) {
			this.scrollOffset = selectedRowIdx - this.maxVisible + 2;
		}
	}

	invalidate(): void {
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.onDone(null);
			return;
		}

		if (matchesKey(data, Key.enter)) {
			if (this.selectableIndices.length > 0) {
				const row = this.rows[this.selectableIndices[this.selectedPos]];
				if (row.type === "model") {
					this.onDone(row.model);
					return;
				}
			}
			return;
		}

		if (matchesKey(data, Key.up)) {
			if (this.selectedPos > 0) {
				this.selectedPos--;
				this.adjustScroll();
				this.invalidate();
				this.tui.requestRender();
			}
			return;
		}

		if (matchesKey(data, Key.down)) {
			if (this.selectedPos < this.selectableIndices.length - 1) {
				this.selectedPos++;
				this.adjustScroll();
				this.invalidate();
				this.tui.requestRender();
			}
			return;
		}

		if (matchesKey(data, Key.backspace)) {
			if (this.filter.length > 0) {
				this.filter = this.filter.slice(0, -1);
				this.rebuildRows();
				this.invalidate();
				this.tui.requestRender();
			}
			return;
		}

		if (matchesKey(data, Key.ctrl("u"))) {
			this.filter = "";
			this.rebuildRows();
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		// Printable characters → add to filter
		const cleaned = data.replace(/\x1b\[200~/g, "").replace(/\x1b\[201~/g, "");
		let changed = false;
		for (const ch of cleaned) {
			const code = ch.charCodeAt(0);
			if (code >= 32 && code !== 127) {
				this.filter += ch;
				changed = true;
			}
		}
		if (changed) {
			this.rebuildRows();
			this.invalidate();
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const boxWidth = Math.min(width - 2, 90);
		const innerWidth = boxWidth - 4; // border + padding

		const h = this.dim("\u2500");
		const v = this.dim("\u2502");
		const tl = this.dim("\u256d");
		const tr = this.dim("\u256e");
		const bl = this.dim("\u2570");
		const br = this.dim("\u256f");
		const sep_l = this.dim("\u251c");
		const sep_r = this.dim("\u2524");

		const padLine = (content: string): string => {
			const vis = visibleWidth(content);
			const pad = Math.max(0, innerWidth - vis);
			return v + " " + content + " ".repeat(pad) + " " + v;
		};
		const emptyLine = (): string => v + " ".repeat(boxWidth - 2) + v;
		const sepLine = (): string => sep_l + h.repeat(boxWidth - 2) + sep_r;

		// Determine max visible rows based on terminal (estimate 30 rows available)
		this.maxVisible = Math.max(5, 30 - 10); // reserve for chrome

		const lines: string[] = [];

		// ── Title ──
		const modelCount = this.selectableIndices.length;
		const title = ` Select Model (${modelCount} available) `;
		const titlePrefix = h.repeat(2);
		const titleVis = 2 + visibleWidth(title);
		const titlePad = Math.max(0, boxWidth - 2 - titleVis);
		lines.push(tl + titlePrefix + this.bold(this.cyan(title)) + h.repeat(titlePad) + tr);

		// ── Filter bar ──
		lines.push(emptyLine());
		if (this.filter) {
			const filterText = `🔍 ${this.filter}`;
			lines.push(padLine(this.bgCyan(` ${this.filter} `) + this.dim("  ← type to filter, Ctrl+U clear")));
		} else {
			lines.push(padLine(this.dim("🔍 Type to filter...")));
		}
		lines.push(sepLine());

		// ── Model list ──
		if (this.selectableIndices.length === 0) {
			lines.push(emptyLine());
			if (this.filter) {
				lines.push(padLine(this.dim(`No models matching "${this.filter}"`)));
			} else {
				lines.push(padLine(this.dim("No models available. Check your API keys.")));
			}
			lines.push(emptyLine());
		} else {
			// Compute column widths from visible rows
			const idColWidth = Math.min(
				40,
				Math.max(
					...this.rows.map((r) =>
						r.type === "model" ? r.model.id.length : 0,
					),
					10,
				),
			);
			const ctxColWidth = 6; // e.g. "200k"
			const costColWidth = 14; // e.g. "$3.00/$15.00"

			lines.push(emptyLine());

			const visibleEnd = Math.min(
				this.rows.length,
				this.scrollOffset + this.maxVisible,
			);
			const visibleStart = this.scrollOffset;

			// Scroll indicators
			if (visibleStart > 0) {
				lines.push(padLine(this.dim(`  ↑ ${visibleStart} more above`)));
			}

			for (let i = visibleStart; i < visibleEnd; i++) {
				const row = this.rows[i];

				if (row.type === "header") {
					const label = ` ${row.provider} `;
					const lineLen = Math.max(0, innerWidth - visibleWidth(label) - 4);
					const half = Math.floor(lineLen / 2);
					lines.push(
						padLine(
							this.dim("─".repeat(half)) +
								this.bold(this.magenta(label)) +
								this.dim("─".repeat(lineLen - half)),
						),
					);
					continue;
				}

				// Model row
				const isSelectedRow = this.selectableIndices[this.selectedPos] === i;
				const isCurrent = row.model.id === this.currentModelId;

				const pointer = isSelectedRow ? this.cyan("▶ ") : "  ";
				const idStr = isSelectedRow
					? this.cyan(padRight(row.model.id, idColWidth))
					: padRight(row.model.id, idColWidth);
				const ctxStr = this.dim(
					padRight(formatContextWindow(row.model.contextWindow), ctxColWidth),
				);
				const costStr = this.dim(
					padRight(formatCost(row.model.cost), costColWidth),
				);
				const reasoningTag = row.model.reasoning
					? this.yellow("🧠")
					: "  ";
				const currentTag = isCurrent ? this.green(" ★") : "";

				const rowText = `${pointer}${idStr}  ${ctxStr}  ${costStr} ${reasoningTag}${currentTag}`;
				lines.push(padLine(truncateToWidth(rowText, innerWidth)));
			}

			// Scroll indicator
			const remaining = this.rows.length - visibleEnd;
			if (remaining > 0) {
				lines.push(padLine(this.dim(`  ↓ ${remaining} more below`)));
			}

			lines.push(emptyLine());
		}

		// ── Legend + hints ──
		lines.push(sepLine());
		lines.push(
			padLine(
				`${this.dim("★ current")}  ${this.yellow("🧠")} ${this.dim("reasoning")}  ${this.dim("cost = $/MTok in/out")}`,
			),
		);
		lines.push(
			padLine(
				`${this.dim("↑↓")} navigate  ${this.dim("Enter")} select  ${this.dim("Esc")} cancel`,
			),
		);
		lines.push(bl + h.repeat(boxWidth - 2) + br);

		this.cachedLines = lines;
		this.cachedWidth = width;
		return lines;
	}
}
