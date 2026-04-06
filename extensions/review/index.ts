/**
 * Review Extension - Structured Code Review with Findings
 *
 * Provides `report_finding` and `submit_review` tools for structured code review,
 * plus a `/review` command with interactive mode selection.
 *
 * Inspired by oh-my-pi's review system with P0-P3 priority levels,
 * confidence scores, and file/line references.
 */

import { execSync } from "node:child_process";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Container, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FindingPriority = "P0" | "P1" | "P2" | "P3";

interface Finding {
	id: number;
	title: string;
	body: string;
	priority: FindingPriority;
	confidence: number;
	file_path: string;
	line_start: number;
	line_end: number;
}

type ReviewVerdict = "approve" | "request-changes" | "comment";

interface ReviewResult {
	verdict: ReviewVerdict;
	summary: string;
	findings: Finding[];
}

interface ReviewSession {
	findings: Finding[];
	nextId: number;
	startedAt: number;
}

// ---------------------------------------------------------------------------
// Priority display
// ---------------------------------------------------------------------------

const PRIORITY_META: Record<
	FindingPriority,
	{ label: string; color: string; icon: string; description: string }
> = {
	P0: { label: "P0 critical", color: "error", icon: "✘", description: "Security, data loss, crash" },
	P1: { label: "P1 major", color: "warning", icon: "⚠", description: "Bugs, incorrect behavior" },
	P2: { label: "P2 moderate", color: "muted", icon: "ⓘ", description: "Design, maintainability" },
	P3: { label: "P3 nit", color: "accent", icon: "·", description: "Style, minor suggestions" },
};

// ---------------------------------------------------------------------------
// Review session state
// ---------------------------------------------------------------------------

let currentSession: ReviewSession | null = null;

function getOrCreateSession(): ReviewSession {
	if (!currentSession) {
		currentSession = { findings: [], nextId: 1, startedAt: Date.now() };
	}
	return currentSession;
}

function clearSession(): void {
	currentSession = null;
}

// ---------------------------------------------------------------------------
// Tool schemas
// ---------------------------------------------------------------------------

const ReportFindingParams = Type.Object({
	title: Type.String({
		description:
			"<=80 chars, imperative mood. E.g., 'Unchecked null dereference in parseConfig'",
	}),
	body: Type.String({
		description: "Markdown explaining why this is a problem and how to fix it. One paragraph max.",
	}),
	priority: StringEnum(["P0", "P1", "P2", "P3"] as const, {
		description:
			"P0=critical (security/data-loss/crash), P1=major (bugs/correctness), P2=moderate (design/maintainability), P3=nit (style/minor)",
	}),
	confidence: Type.Number({
		minimum: 0,
		maximum: 1,
		description: "How confident you are this is a real issue (0.0 = speculative, 1.0 = certain)",
	}),
	file_path: Type.String({ description: "Path to the file containing the issue" }),
	line_start: Type.Number({ description: "Start line of the issue" }),
	line_end: Type.Number({ description: "End line of the issue (same as line_start for single line)" }),
});

const SubmitReviewParams = Type.Object({
	verdict: StringEnum(["approve", "request-changes", "comment"] as const, {
		description:
			"approve = no blocking issues, request-changes = has P0/P1 findings that must be fixed, comment = observations only",
	}),
	summary: Type.String({
		description: "One paragraph summary of the review. What was reviewed, key observations, overall assessment.",
	}),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shortenPath(filePath: string): string {
	const home = process.env.HOME || process.env.USERPROFILE || "";
	return home && filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
}

function getGitBranch(cwd: string): string | null {
	try {
		return execSync("git symbolic-ref --short HEAD 2>/dev/null", {
			cwd,
			encoding: "utf-8",
		}).trim() || null;
	} catch {
		return null;
	}
}

function getDefaultBranch(cwd: string): string {
	try {
		// Try remote HEAD first
		const remote = execSync("git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null", {
			cwd,
			encoding: "utf-8",
		}).trim();
		if (remote) return remote.replace("refs/remotes/origin/", "");
	} catch { /* ignore */ }

	// Fall back to checking common names
	for (const name of ["main", "master"]) {
		try {
			execSync(`git rev-parse --verify ${name} 2>/dev/null`, { cwd, encoding: "utf-8" });
			return name;
		} catch { /* ignore */ }
	}
	return "main";
}

function hasUncommittedChanges(cwd: string): boolean {
	try {
		const status = execSync("git status --porcelain 2>/dev/null", { cwd, encoding: "utf-8" });
		return status.trim().length > 0;
	} catch {
		return false;
	}
}

function getRecentCommits(cwd: string, count = 10): Array<{ hash: string; message: string }> {
	try {
		const log = execSync(`git log --oneline -${count} 2>/dev/null`, { cwd, encoding: "utf-8" });
		return log.trim().split("\n").filter(Boolean).map((line) => {
			const spaceIdx = line.indexOf(" ");
			return {
				hash: line.slice(0, spaceIdx),
				message: line.slice(spaceIdx + 1),
			};
		});
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function renderFinding(f: Finding, theme: ExtensionContext["theme"]): string {
	const meta = PRIORITY_META[f.priority];
	const icon = theme.fg(meta.color as any, meta.icon);
	const prio = theme.fg(meta.color as any, `[${f.priority}]`);
	const title = theme.fg("text", f.title);
	const location = theme.fg("dim", `${shortenPath(f.file_path)}:${f.line_start}${f.line_end !== f.line_start ? `-${f.line_end}` : ""}`);
	const confidence = theme.fg("dim", `(${Math.round(f.confidence * 100)}%)`);

	return `${icon} ${prio} ${title}\n  ${location} ${confidence}\n  ${theme.fg("muted", f.body)}`;
}

function renderFindingSummary(findings: Finding[], theme: ExtensionContext["theme"]): string {
	const counts: Record<FindingPriority, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
	for (const f of findings) counts[f.priority]++;

	const parts: string[] = [];
	for (const p of ["P0", "P1", "P2", "P3"] as FindingPriority[]) {
		if (counts[p] > 0) {
			const meta = PRIORITY_META[p];
			parts.push(theme.fg(meta.color as any, `${meta.icon} ${p}: ${counts[p]}`));
		}
	}
	return parts.join("  ");
}

function renderVerdict(verdict: ReviewVerdict, theme: ExtensionContext["theme"]): string {
	switch (verdict) {
		case "approve":
			return theme.fg("success", "✔ APPROVED");
		case "request-changes":
			return theme.fg("error", "✘ CHANGES REQUESTED");
		case "comment":
			return theme.fg("warning", "💬 COMMENTED");
	}
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// ── report_finding tool ─────────────────────────────────────────────
	pi.registerTool({
		name: "report_finding",
		label: "Finding",
		description: [
			"Report a code review finding with priority, confidence, and file location.",
			"Use during code review to report issues found.",
			"Priority: P0=critical (security/crash), P1=major (bugs), P2=moderate (design), P3=nit (style).",
			"Confidence: 0.0-1.0 indicating certainty this is a real issue.",
		].join(" "),
		parameters: ReportFindingParams,

		async execute(_toolCallId, params) {
			const session = getOrCreateSession();
			const finding: Finding = {
				id: session.nextId++,
				title: params.title.slice(0, 80),
				body: params.body,
				priority: params.priority as FindingPriority,
				confidence: Math.max(0, Math.min(1, params.confidence)),
				file_path: params.file_path,
				line_start: params.line_start,
				line_end: params.line_end,
			};
			session.findings.push(finding);

			const meta = PRIORITY_META[finding.priority];
			return {
				content: [
					{
						type: "text" as const,
						text: `Finding #${finding.id} recorded: [${finding.priority}] ${finding.title} at ${finding.file_path}:${finding.line_start}`,
					},
				],
				details: { finding },
			};
		},

		renderCall(args, theme) {
			const prio = (args.priority || "P2") as FindingPriority;
			const meta = PRIORITY_META[prio];
			const icon = theme.fg(meta.color as any, meta.icon);
			const prioLabel = theme.fg(meta.color as any, `[${prio}]`);
			const title = args.title || "...";
			const location = args.file_path
				? theme.fg("dim", ` ${shortenPath(args.file_path)}:${args.line_start || "?"}`)
				: "";
			return new Text(`${icon} ${prioLabel} ${title}${location}`, 0, 0);
		},

		renderResult(result, _opts, theme) {
			const finding = result.details?.finding as Finding | undefined;
			if (!finding) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			return new Text(renderFinding(finding, theme), 0, 0);
		},
	});

	// ── submit_review tool ──────────────────────────────────────────────
	pi.registerTool({
		name: "submit_review",
		label: "Review",
		description: [
			"Submit the final code review verdict with summary.",
			"Call this after reporting all findings to conclude the review.",
			"Verdict: approve (no blocking issues), request-changes (P0/P1 must be fixed), comment (observations only).",
		].join(" "),
		parameters: SubmitReviewParams,

		async execute(_toolCallId, params) {
			const session = getOrCreateSession();
			const reviewResult: ReviewResult = {
				verdict: params.verdict as ReviewVerdict,
				summary: params.summary,
				findings: [...session.findings],
			};

			// Clear session after submitting
			const findingCount = session.findings.length;
			clearSession();

			const counts: Record<FindingPriority, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
			for (const f of reviewResult.findings) counts[f.priority]++;

			const countParts: string[] = [];
			for (const p of ["P0", "P1", "P2", "P3"] as FindingPriority[]) {
				if (counts[p] > 0) countParts.push(`${p}: ${counts[p]}`);
			}

			return {
				content: [
					{
						type: "text" as const,
						text: [
							`Review submitted: ${params.verdict.toUpperCase()}`,
							`Findings: ${findingCount} (${countParts.join(", ") || "none"})`,
							`Summary: ${params.summary}`,
						].join("\n"),
					},
				],
				details: { review: reviewResult },
			};
		},

		renderCall(args, theme) {
			const verdict = (args.verdict || "comment") as ReviewVerdict;
			return new Text(
				theme.fg("toolTitle", theme.bold("review ")) + renderVerdict(verdict, theme),
				0,
				0,
			);
		},

		renderResult(result, { expanded }, theme) {
			const review = result.details?.review as ReviewResult | undefined;
			if (!review) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const container = new Container();

			// Verdict header
			const verdictStr = renderVerdict(review.verdict, theme);
			container.addChild(new Text(verdictStr, 0, 0));
			container.addChild(new Spacer(1));

			// Summary
			container.addChild(new Text(theme.fg("text", review.summary), 0, 0));

			// Finding counts
			if (review.findings.length > 0) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(renderFindingSummary(review.findings, theme), 0, 0));
				container.addChild(new Spacer(1));

				// Sort findings by priority (P0 first)
				const sorted = [...review.findings].sort((a, b) => {
					const order: Record<FindingPriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
					return order[a.priority] - order[b.priority];
				});

				if (expanded) {
					// Show all findings
					for (const f of sorted) {
						container.addChild(new Text(renderFinding(f, theme), 0, 0));
						container.addChild(new Spacer(1));
					}
				} else {
					// Show first 5 findings collapsed
					const toShow = sorted.slice(0, 5);
					for (const f of toShow) {
						container.addChild(new Text(renderFinding(f, theme), 0, 0));
						container.addChild(new Spacer(1));
					}
					if (sorted.length > 5) {
						container.addChild(
							new Text(
								theme.fg("muted", `... +${sorted.length - 5} more findings (Ctrl+O to expand)`),
								0,
								0,
							),
						);
					}
				}
			} else {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("success", "No issues found."), 0, 0));
			}

			return container;
		},
	});

	// ── /review command ─────────────────────────────────────────────────
	pi.registerCommand("review", {
		description: "Start an interactive code review",
		async handler(args, ctx) {
			// Clear any previous review session
			clearSession();

			const cwd = ctx.cwd;
			const currentBranch = getGitBranch(cwd);
			const defaultBranch = getDefaultBranch(cwd);
			const hasChanges = hasUncommittedChanges(cwd);

			// If args provided, skip interactive selection
			if (args.length > 0) {
				const arg = args.join(" ");
				await startReview(ctx, arg);
				return;
			}

			// Build review mode options
			interface ReviewOption {
				label: string;
				value: string;
			}

			const options: ReviewOption[] = [];

			// Uncommitted changes
			if (hasChanges) {
				options.push({ label: "Uncommitted changes", value: "uncommitted" });
			}

			// Branch comparison (only if not on default branch)
			if (currentBranch && currentBranch !== defaultBranch) {
				options.push({ label: `Branch: ${currentBranch} vs ${defaultBranch}`, value: `branch:${defaultBranch}` });
			}

			// Recent commits
			const commits = getRecentCommits(cwd, 5);
			for (const c of commits) {
				options.push({ label: `Commit: ${c.hash} ${c.message}`, value: `commit:${c.hash}` });
			}

			if (options.length === 0) {
				ctx.ui.notify("Nothing to review -- no uncommitted changes, branches, or commits found.", "warning");
				return;
			}

			const choice = await ctx.ui.select(
				"What would you like to review?",
				options.map((o) => o.label),
			);

			if (choice === undefined) return; // cancelled

			const selected = options.find((o) => o.label === choice);
			if (!selected) return;
			await startReview(ctx, selected.value);
		},
	});

	async function startReview(ctx: ExtensionContext, mode: string) {
		let diffCommand: string;
		let reviewDescription: string;

		if (mode === "uncommitted") {
			diffCommand = "git diff && git diff --staged";
			reviewDescription = "uncommitted changes (working tree + staged)";
		} else if (mode.startsWith("branch:")) {
			const base = mode.slice("branch:".length);
			const current = getGitBranch(ctx.cwd) || "HEAD";
			diffCommand = `git diff ${base}...${current}`;
			reviewDescription = `branch ${current} compared to ${base}`;
		} else if (mode.startsWith("commit:")) {
			const hash = mode.slice("commit:".length);
			diffCommand = `git show ${hash}`;
			reviewDescription = `commit ${hash}`;
		} else {
			// Treat as freeform description
			diffCommand = `git diff`;
			reviewDescription = mode;
		}

		// Build the review task and send as a user message to trigger the team tool
		const task = [
			`Use the team tool to run the qa agent with this task:`,
			``,
			`Perform a structured code review of ${reviewDescription}.`,
			`First, examine the changes by running: \`${diffCommand}\``,
			`Then read the relevant source files to understand context.`,
			`For each issue found, use the \`report_finding\` tool with a clear imperative title, priority (P0-P3), confidence (0.0-1.0), exact file path and line range, and one paragraph explaining the problem.`,
			`After reporting all findings, call \`submit_review\` with the appropriate verdict (approve/request-changes/comment) and a summary.`,
		].join("\n");

		ctx.ui.notify(`Starting review of ${reviewDescription}...`, "info");
		pi.sendUserMessage(task);
	}
}
