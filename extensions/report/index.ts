/**
 * Report Extension - Completion reports for merged todos
 *
 * Generates and displays completion reports after worktree merges.
 * Reports include file changes, diffs, and agent activity summaries.
 *
 * Commands:
 *   /report [todo-id] - View completion report (most recent if no ID)
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import type { TodoFile, TodoMeta } from "../todos/index.ts";

// ---------------------------------------------------------------------------
// Report Generation
// ---------------------------------------------------------------------------

export function generateCompletionReport(repoRoot: string, branch: string, baseBranch: string, mergeCommit: string): string {
	const timestamp = new Date().toISOString();
	const sections: string[] = [];

	// Header
	sections.push(`# Completion Report`);
	sections.push(`**Merged**: ${timestamp}`);
	sections.push(`**Branch**: \`${branch}\` → \`${baseBranch}\``);
	sections.push(`**Commit**: \`${mergeCommit}\``);
	sections.push("");

	// Git diff --stat (using merge commit, not HEAD)
	try {
		const statOutput = execSync(`git diff --stat ${mergeCommit}~1..${mergeCommit}`, {
			cwd: repoRoot,
			encoding: "utf-8",
		});
		sections.push("## Changes");
		sections.push("```");
		sections.push(statOutput.trim());
		sections.push("```");
		sections.push("");
	} catch (err: any) {
		sections.push("## Changes");
		sections.push("*(Failed to generate diff stats)*");
		sections.push("");
	}

	// Agent Activity
	try {
		const teamOutputsDir = path.join(repoRoot, ".cortex", "team-outputs");
		if (fs.existsSync(teamOutputsDir)) {
			const files = fs.readdirSync(teamOutputsDir).filter((f) => f.endsWith(".md"));
			if (files.length > 0) {
				sections.push("## Agent Activity");
				sections.push("| Agent | Timestamp | Output |");
				sections.push("|-------|-----------|--------|");
				for (const file of files.sort()) {
					const match = file.match(/^(.+?)-(\d+)\.md$/);
					if (match) {
						const agent = match[1];
						const ts = new Date(Number.parseInt(match[2], 10)).toISOString();
						sections.push(`| ${agent} | ${ts} | \`${file}\` |`);
					}
				}
				sections.push("");
			}
		}
	} catch {
		// Skip agent activity if unavailable
	}

	// Per-file diffs (using merge commit, not HEAD)
	try {
		const diffOutput = execSync(`git diff ${mergeCommit}~1..${mergeCommit}`, {
			cwd: repoRoot,
			encoding: "utf-8",
			maxBuffer: 10 * 1024 * 1024, // 10MB
		});

		if (diffOutput.trim()) {
			sections.push("## File Diffs");
			sections.push("```diff");
			sections.push(diffOutput.trim());
			sections.push("```");
			sections.push("");
		}
	} catch (err: any) {
		sections.push("## File Diffs");
		sections.push("*(Failed to generate diffs)*");
		sections.push("");
	}

	return sections.join("\n");
}

// ---------------------------------------------------------------------------
// Report Parsing
// ---------------------------------------------------------------------------

interface FileChange {
	path: string;
	status: "added" | "modified" | "deleted";
	additions: number;
	deletions: number;
	diff: string;
}

interface CompletionReport {
	timestamp: string;
	branch: string;
	baseBranch: string;
	commit: string;
	files: FileChange[];
}

export function parseCompletionReport(markdown: string): CompletionReport | null {
	const timestampMatch = markdown.match(/\*\*Merged\*\*:\s*(.+)/);
	const branchMatch = markdown.match(/\*\*Branch\*\*:\s*`(.+?)`\s*→\s*`(.+?)`/);
	const commitMatch = markdown.match(/\*\*Commit\*\*:\s*`(.+?)`/);

	if (!timestampMatch || !branchMatch || !commitMatch) {
		return null;
	}

	const report: CompletionReport = {
		timestamp: timestampMatch[1],
		branch: branchMatch[1],
		baseBranch: branchMatch[2],
		commit: commitMatch[1],
		files: [],
	};

	// Extract diff section
	const diffMatch = markdown.match(/## File Diffs\n```diff\n([\s\S]+?)\n```/);
	if (!diffMatch) {
		return report;
	}

	const fullDiff = diffMatch[1];
	const fileDiffs = fullDiff.split(/(?=diff --git)/);

	for (const fileDiff of fileDiffs) {
		if (!fileDiff.trim()) continue;

		const pathMatch = fileDiff.match(/diff --git a\/(.+?) b\/(.+)/);
		if (!pathMatch) continue;

		const filePath = pathMatch[2];
		let status: "added" | "modified" | "deleted" = "modified";

		if (fileDiff.includes("new file mode")) status = "added";
		else if (fileDiff.includes("deleted file mode")) status = "deleted";

		const additions = (fileDiff.match(/^\+[^+]/gm) || []).length;
		const deletions = (fileDiff.match(/^-[^-]/gm) || []).length;

		report.files.push({
			path: filePath,
			status,
			additions,
			deletions,
			diff: fileDiff,
		});
	}

	return report;
}

// ---------------------------------------------------------------------------
// TUI Overlay
// ---------------------------------------------------------------------------

class ReportOverlayComponent {
	private report: CompletionReport;
	private repoRoot: string;
	private selectedIndex = 0;
	private viewMode: "list" | "diff" = "list";
	private scrollOffset = 0;
	private invalidate: () => void;

	constructor(report: CompletionReport, repoRoot: string, invalidate: () => void) {
		this.report = report;
		this.repoRoot = repoRoot;
		this.invalidate = invalidate;
	}

	render(width: number, height: number) {
		if (this.viewMode === "list") {
			return this.renderList(width, height);
		}
		return this.renderDiff(width, height);
	}

	private renderList(width: number, height: number) {
		const titleText = `Completion Report — ${this.report.branch}`;
		const infoText = `${this.report.timestamp} | ${this.report.files.length} files changed`;
		const helpText = "↑/↓: navigate | Enter: view diff | r: rollback file | q: close";

		const contentHeight = height - 6; // Reserve space for header and footer
		const visibleFiles = this.report.files.slice(this.scrollOffset, this.scrollOffset + contentHeight);

		const fileLines = visibleFiles.map((file, idx) => {
			const globalIdx = this.scrollOffset + idx;
			const isSelected = globalIdx === this.selectedIndex;
			const prefix = isSelected ? "▶ " : "  ";
			const statusIcon = file.status === "added" ? "+" : file.status === "deleted" ? "-" : "~";
			const stats = `+${file.additions} -${file.deletions}`;
			const line = `${prefix}${statusIcon} ${file.path} (${stats})`;

			return Text({
				text: line,
				color: isSelected ? "accent" : file.status === "added" ? "success" : file.status === "deleted" ? "error" : "default",
			});
		});

		return Container({
			direction: "vertical",
			children: [
				Text({ text: titleText, bold: true, color: "accent" }),
				Text({ text: infoText, color: "muted" }),
				Spacer({ height: 1 }),
				...fileLines,
				Spacer({ height: 1 }),
				Text({ text: helpText, color: "muted" }),
			],
		});
	}

	private renderDiff(width: number, height: number) {
		const file = this.report.files[this.selectedIndex];
		if (!file) {
			return Container({
				direction: "vertical",
				children: [Text({ text: "No file selected", color: "error" })],
			});
		}

		const titleText = `Diff: ${file.path}`;
		const helpText = "↑/↓: scroll | Esc: back to list | r: rollback | q: close";

		const contentHeight = height - 4;
		const diffLines = file.diff.split("\n");
		const visibleLines = diffLines.slice(this.scrollOffset, this.scrollOffset + contentHeight);

		const styledLines = visibleLines.map((line) => {
			let color: string = "default";
			if (line.startsWith("+")) color = "success";
			else if (line.startsWith("-")) color = "error";
			else if (line.startsWith("@@")) color = "accent";

			return Text({ text: line, color });
		});

		return Container({
			direction: "vertical",
			children: [
				Text({ text: titleText, bold: true, color: "accent" }),
				Spacer({ height: 1 }),
				...styledLines,
				Spacer({ height: 1 }),
				Text({ text: helpText, color: "muted" }),
			],
		});
	}

	handleInput(key: string): boolean {
		if (key === "q") {
			return false; // Close overlay
		}

		if (this.viewMode === "list") {
			if (key === "up" || key === "k") {
				this.selectedIndex = Math.max(0, this.selectedIndex - 1);
				this.adjustScroll();
				this.invalidate();
			} else if (key === "down" || key === "j") {
				this.selectedIndex = Math.min(this.report.files.length - 1, this.selectedIndex + 1);
				this.adjustScroll();
				this.invalidate();
			} else if (key === "return") {
				this.viewMode = "diff";
				this.scrollOffset = 0;
				this.invalidate();
			} else if (key === "r") {
				this.rollbackFile();
			}
		} else {
			// diff mode
			if (key === "up" || key === "k") {
				this.scrollOffset = Math.max(0, this.scrollOffset - 1);
				this.invalidate();
			} else if (key === "down" || key === "j") {
				const file = this.report.files[this.selectedIndex];
				const maxScroll = Math.max(0, file.diff.split("\n").length - 10);
				this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
				this.invalidate();
			} else if (key === "escape") {
				this.viewMode = "list";
				this.scrollOffset = 0;
				this.invalidate();
			} else if (key === "r") {
				this.rollbackFile();
			}
		}

		return true; // Keep overlay open
	}

	private adjustScroll() {
		// Auto-scroll to keep selected item visible (simplified)
		if (this.selectedIndex < this.scrollOffset) {
			this.scrollOffset = this.selectedIndex;
		} else if (this.selectedIndex >= this.scrollOffset + 20) {
			this.scrollOffset = this.selectedIndex - 19;
		}
	}

	private rollbackFile() {
		const file = this.report.files[this.selectedIndex];
		if (!file) return;

		try {
			const filePath = file.path;
			const mergeCommit = this.report.commit;
			const commitMsg = `revert: ${path.basename(filePath)} (rollback from completion report)`;

			// Bug #3 fix: Different handling for added vs modified/deleted files
			if (file.status === "added") {
				execSync(`git rm ${JSON.stringify(filePath)}`, { cwd: this.repoRoot });
			} else {
				execSync(`git checkout ${mergeCommit}~1 -- ${JSON.stringify(filePath)}`, { cwd: this.repoRoot });
				execSync(`git add ${JSON.stringify(filePath)}`, { cwd: this.repoRoot });
			}
			execSync(`git commit -m ${JSON.stringify(commitMsg)}`, { cwd: this.repoRoot });

			// TODO: Show success message, maybe remove from list or update status
			this.invalidate();
		} catch (err: any) {
			// TODO: Show error message in overlay
			console.error(`Rollback failed: ${err.message}`);
		}
	}
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerCommand("report", {
		description: "View completion report for a merged todo",
		async handler(ctx, args) {
			const { readTodo, readAllTodos } = await import("../todos/index.js");

			let todoId = args[0];
			let todo: TodoFile | null = null;

			if (!todoId) {
				// Find most recent todo with a completion report
				const allTodos = await readAllTodos(ctx.cwd);
				const completed = allTodos
					.filter((t) => t.completionReport.trim() !== "")
					.sort((a, b) => {
						const aTime = new Date(a.meta.updated_at || 0).getTime();
						const bTime = new Date(b.meta.updated_at || 0).getTime();
						return bTime - aTime;
					});

				if (completed.length === 0) {
					ctx.ui.writeLine("No completed todos with reports found.");
					return;
				}

				todo = completed[0];
				todoId = todo.meta.id;
			} else {
				todo = await readTodo(ctx.cwd, todoId);
				if (!todo) {
					ctx.ui.writeLine(`Todo ${todoId} not found.`);
					return;
				}
			}

			if (!todo.completionReport || todo.completionReport.trim() === "") {
				ctx.ui.writeLine(`Todo ${todoId} has no completion report.`);
				return;
			}

			const report = parseCompletionReport(todo.completionReport);
			if (!report) {
				ctx.ui.writeLine(`Failed to parse completion report for todo ${todoId}.`);
				return;
			}

			const repoRoot = execSync("git rev-parse --show-toplevel", {
				cwd: ctx.cwd,
				encoding: "utf-8",
			}).trim();

			await ctx.ui.custom((invalidate) => {
				const component = new ReportOverlayComponent(report, repoRoot, invalidate);
				return {
					render: (w, h) => component.render(w, h),
					handleInput: (key) => component.handleInput(key),
				};
			});
		},
	});
}
