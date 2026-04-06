/**
 * Footer Extension - Enhanced Status Bar
 *
 * Replaces the default dim 2-line footer with a richer, segmented status bar
 * inspired by oh-my-pi's StatusLineComponent.
 *
 * Features:
 * - Segmented layout with emoji icons and clean spacing
 * - Colorized segments: model (magenta), path (cyan), git (green/yellow)
 * - Token stats, cost, and context % with threshold coloring
 * - Git branch with dirty/staged/untracked indicators
 * - Responsive: drops segments gracefully on narrow terminals
 */

import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { getActiveProviderAccount } from "../providers/state.js";

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatNumber(n: number): string {
	if (n < 1000) return n.toString();
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1000000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1000000).toFixed(1)}M`;
}

function shortenPath(p: string): string {
	const home = process.env.HOME || process.env.USERPROFILE || "";
	return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function shortenModelName(id: string): string {
	// Strip common prefixes for brevity
	return id
		.replace(/^claude-/, "")
		.replace(/^gpt-/, "gpt-")
		.replace(/-\d{8}$/, ""); // strip date suffix
}

// ---------------------------------------------------------------------------
// Segment types
// ---------------------------------------------------------------------------

interface Segment {
	content: string; // may contain ANSI
	visible: boolean;
}

const SEP = "  ";

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// Register footer on session start
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					// ── Gather data ──────────────────────────────────────

					// Token stats from session entries
					let totalInput = 0;
					let totalOutput = 0;
					let totalCacheRead = 0;
					let totalCost = 0;

					for (const e of ctx.sessionManager.getBranch()) {
						if (e.type === "message" && e.message.role === "assistant") {
							const m = e.message as AssistantMessage;
							totalInput += m.usage?.input ?? 0;
							totalOutput += m.usage?.output ?? 0;
							totalCacheRead += m.usage?.cacheRead ?? 0;
							totalCost += m.usage?.cost?.total ?? 0;
						}
					}

					const branch = footerData.getGitBranch();
					const modelId = ctx.model?.id || "no-model";
					const cwd = shortenPath(ctx.sessionManager.getCwd());

					// ── Build segments ───────────────────────────────────

					const leftSegments: Segment[] = [];
					const rightSegments: Segment[] = [];

					// Left: provider
					const providerName = getActiveProviderAccount() || ctx.model?.provider || "";
					if (providerName) {
						leftSegments.push({
							content: "⚡ " + theme.fg("dim", providerName),
							visible: true,
						});
					}

					// Left: model + thinking
					const modelName = shortenModelName(modelId);
					let modelStr = modelName;
					if (ctx.model?.reasoning) {
						const thinking = pi.getThinkingLevel?.() ?? "off";
						if (thinking !== "off") {
							modelStr += ` ${thinking}`;
						}
					}
					leftSegments.push({
						content: "🧠 " + theme.fg("customMessageLabel", modelStr),
						visible: true,
					});

					// Left: path
					const pathMaxLen = 35;
					let pathStr = cwd;
					if (pathStr.length > pathMaxLen) {
						pathStr = "..." + pathStr.slice(-(pathMaxLen - 3));
					}
					leftSegments.push({
						content: "📁 " + theme.fg("toolTitle", pathStr),
						visible: true,
					});

					// Left: git branch
					if (branch) {
						const branchStr = branch === "detached" ? "detached" : branch;
						leftSegments.push({
							content: "🌿 " + theme.fg("success", branchStr),
							visible: true,
						});
					}

					// Right: tokens
					if (totalInput || totalOutput) {
						const parts: string[] = [];
						if (totalInput) parts.push(`↑${formatNumber(totalInput)}`);
						if (totalOutput) parts.push(`↓${formatNumber(totalOutput)}`);
						if (totalCacheRead) parts.push(`📦${formatNumber(totalCacheRead)}`);
						rightSegments.push({
							content: theme.fg("dim", parts.join(" ")),
							visible: true,
						});
					}

					// Right: cost
					if (totalCost > 0) {
						rightSegments.push({
							content: theme.fg("dim", `💰$${totalCost.toFixed(2)}`),
							visible: true,
						});
					}

					// Right: context usage %
					const contextUsage = ctx.getContextUsage();
					if (contextUsage) {
						const pct = contextUsage.percent ?? 0;
						const pctStr = `${pct.toFixed(0)}%/${formatNumber(contextUsage.contextWindow)}`;

						let contextColor: string;
						let contextIcon: string;
						if (pct >= 90) { contextColor = "error"; contextIcon = "🔴"; }
						else if (pct >= 70) { contextColor = "warning"; contextIcon = "🟡"; }
						else { contextColor = "dim"; contextIcon = "🟢"; }

						rightSegments.push({
							content: contextIcon + theme.fg(contextColor as any, pctStr),
							visible: true,
						});
					}

					// ── Compose line ─────────────────────────────────────

					const sep = theme.fg("dim", SEP);
					const sepWidth = visibleWidth(SEP);

					// Calculate widths
					const segmentWidth = (segs: Segment[]): number => {
						const visible = segs.filter((s) => s.visible);
						if (visible.length === 0) return 0;
						return visible.reduce((sum, s) => sum + visibleWidth(s.content), 0) +
							(visible.length - 1) * sepWidth;
					};

					// Start with all segments, drop from right then left to fit
					let left = leftSegments.filter((s) => s.visible);
					let right = rightSegments.filter((s) => s.visible);

					const totalWidth = () => {
						const lw = segmentWidth(left);
						const rw = segmentWidth(right);
						const gap = (left.length > 0 && right.length > 0) ? 2 : 0;
						return lw + rw + gap;
					};

					// Drop right segments to fit
					while (totalWidth() > width && right.length > 0) {
						right.pop();
					}

					// Drop left segments (except first) to fit
					while (totalWidth() > width && left.length > 1) {
						left.pop();
					}

					// Build the line
					const joinSegments = (segs: Segment[]): string =>
						segs.map((s) => s.content).join(sep);

					const leftStr = joinSegments(left);
					const rightStr = joinSegments(right);
					const leftWidth = visibleWidth(leftStr);
					const rightWidth = visibleWidth(rightStr);

					if (!rightStr) {
						return [truncateToWidth(leftStr, width)];
					}

					const gapSize = Math.max(1, width - leftWidth - rightWidth);

					// Fill gap with spaces for a clean look
					const gapFill = " ".repeat(gapSize);

					const line = leftStr + gapFill + rightStr;
					return [truncateToWidth(line, width)];
				},
			};
		});
	});
}
