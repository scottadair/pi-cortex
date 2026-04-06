/**
 * Welcome Extension - Startup Screen
 *
 * Shows a branded welcome screen with Pi logo, tips, and recent sessions.
 * Replaces the default pi header with a full-width two-column layout
 * inspired by oh-my-pi's WelcomeComponent.
 *
 * The welcome header is shown once at startup and replaced when the
 * user starts typing or runs a command.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

// ---------------------------------------------------------------------------
// Time formatting
// ---------------------------------------------------------------------------

function timeAgo(date: Date): string {
	const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
	if (seconds < 60) return "just now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d ago`;
	const weeks = Math.floor(days / 7);
	return `${weeks}w ago`;
}

// ---------------------------------------------------------------------------
// Logo (block art, gradient magenta -> cyan)
// ---------------------------------------------------------------------------

const PI_LOGO = [
	"▀████████████▀",
	" ╘███    ███  ",
	"  ███    ███  ",
	"  ███    ███  ",
	" ▄███▄  ▄███▄",
];

function gradientLine(line: string): string {
	const colors = [
		"\x1b[38;5;199m", // bright magenta
		"\x1b[38;5;171m", // magenta-purple
		"\x1b[38;5;135m", // purple
		"\x1b[38;5;99m",  // purple-blue
		"\x1b[38;5;75m",  // cyan-blue
		"\x1b[38;5;51m",  // bright cyan
	];
	const reset = "\x1b[0m";

	let result = "";
	let colorIdx = 0;
	const step = Math.max(1, Math.floor(line.length / colors.length));

	for (let i = 0; i < line.length; i++) {
		if (i > 0 && i % step === 0 && colorIdx < colors.length - 1) {
			colorIdx++;
		}
		const char = line[i];
		if (char !== " ") {
			result += colors[colorIdx] + char + reset;
		} else {
			result += char;
		}
	}
	return result;
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

function pad(text: string, width: number): string {
	const vis = visibleWidth(text);
	if (vis >= width) return truncateToWidth(text, width);
	return text + " ".repeat(width - vis);
}

function center(text: string, width: number): string {
	const vis = visibleWidth(text);
	if (vis >= width) return truncateToWidth(text, width);
	const left = Math.floor((width - vis) / 2);
	return " ".repeat(left) + text + " ".repeat(width - vis - left);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let headerActive = false;

	pi.on("session_start", async (event, ctx) => {
		if (!ctx.hasUI) return;
		// Only show on fresh startup, not reload/fork
		if (event.reason !== "startup" && event.reason !== "new") return;

		// Fetch recent sessions
		interface RecentSession {
			name: string;
			firstMessage: string;
			timeAgo: string;
		}

		let recentSessions: RecentSession[] = [];
		try {
			const sessions = await SessionManager.list(ctx.cwd);
			recentSessions = sessions
				.sort((a, b) => b.modified.getTime() - a.modified.getTime())
				.slice(0, 5)
				.map((s) => ({
					name: s.name || s.firstMessage?.slice(0, 40) || s.id.slice(0, 8),
					firstMessage: s.firstMessage?.slice(0, 50) || "",
					timeAgo: timeAgo(s.modified),
				}));
		} catch {
			// Ignore session listing errors
		}

		const modelName = ctx.model?.name || ctx.model?.id || "no model";
		const providerName = ctx.model?.provider || "";

		headerActive = true;

		ctx.ui.setHeader((_tui, theme) => {
			return {
				invalidate() {},
				render(termWidth: number): string[] {
					const boxWidth = Math.max(20, termWidth - 2);
					const innerWidth = boxWidth - 2; // for borders

					// Box drawing chars
					const h = theme.fg("dim", "\u2500");
					const v = theme.fg("dim", "\u2502");
					const tl = theme.fg("dim", "\u256d");
					const tr = theme.fg("dim", "\u256e");
					const bl = theme.fg("dim", "\u2570");
					const br = theme.fg("dim", "\u256f");

					const lines: string[] = [];

					// Two-column layout
					const leftWidth = Math.min(50, Math.floor(innerWidth * 0.55));
					const rightWidth = innerWidth - leftWidth - 1; // 1 for column separator
					const showTwoColumns = rightWidth >= 22;

					// Top border
					lines.push(tl + h.repeat(innerWidth) + tr);

					if (showTwoColumns) {
						// Left column: logo + model info
						const leftLines: string[] = [];
						leftLines.push("");
						for (const logoLine of PI_LOGO) {
							leftLines.push(center(gradientLine(logoLine), leftWidth));
						}
						leftLines.push("");
						leftLines.push(center(theme.fg("muted", modelName), leftWidth));
						leftLines.push(center(theme.fg("dim", providerName), leftWidth));
						leftLines.push("");

						// Right column: tips + sessions
						const rightLines: string[] = [];
						rightLines.push("");
						rightLines.push(" " + theme.bold(theme.fg("accent", "Tips")));
						rightLines.push(" " + theme.fg("dim", "/") + theme.fg("muted", " commands"));
						rightLines.push(" " + theme.fg("dim", "!") + theme.fg("muted", " run bash"));
						rightLines.push(" " + theme.fg("dim", "?") + theme.fg("muted", " shortcuts"));
						rightLines.push(" " + theme.fg("dim", "\u2500".repeat(Math.max(1, rightWidth - 2))));

						if (recentSessions.length > 0) {
							rightLines.push(" " + theme.bold(theme.fg("accent", "Recent")));
							for (const s of recentSessions.slice(0, 4)) {
								const label = s.name.length > rightWidth - 12
									? s.name.slice(0, rightWidth - 15) + "..."
									: s.name;
								rightLines.push(
									" " + theme.fg("muted", label) + theme.fg("dim", ` ${s.timeAgo}`)
								);
							}
						} else {
							rightLines.push(" " + theme.fg("dim", "No recent sessions"));
						}
						rightLines.push("");

						// Merge columns
						const maxRows = Math.max(leftLines.length, rightLines.length);
						const colSep = theme.fg("dim", "\u2502");
						for (let i = 0; i < maxRows; i++) {
							const left = pad(leftLines[i] ?? "", leftWidth);
							const right = pad(rightLines[i] ?? "", rightWidth);
							lines.push(v + left + colSep + right + v);
						}

						// Bottom border with column junction
						lines.push(
							bl +
							h.repeat(leftWidth) +
							theme.fg("dim", "\u2534") +
							h.repeat(rightWidth) +
							br
						);
					} else {
						// Single column fallback for narrow terminals
						lines.push(v + pad("", innerWidth) + v);
						for (const logoLine of PI_LOGO) {
							lines.push(v + center(gradientLine(logoLine), innerWidth) + v);
						}
						lines.push(v + pad("", innerWidth) + v);
						lines.push(v + center(theme.fg("muted", modelName), innerWidth) + v);
						lines.push(v + center(theme.fg("dim", providerName), innerWidth) + v);
						lines.push(v + pad("", innerWidth) + v);

						if (recentSessions.length > 0) {
							const sepLine = " " + theme.fg("dim", "\u2500".repeat(Math.max(1, innerWidth - 4))) + " ";
							lines.push(v + center(sepLine, innerWidth) + v);
							lines.push(v + " " + pad(theme.bold(theme.fg("accent", "Recent sessions")), innerWidth - 1) + v);
							for (const s of recentSessions.slice(0, 3)) {
								const entry = " " + theme.fg("muted", s.name) + theme.fg("dim", ` ${s.timeAgo}`);
								lines.push(v + pad(entry, innerWidth) + v);
							}
							lines.push(v + pad("", innerWidth) + v);
						}

						lines.push(bl + h.repeat(innerWidth) + br);
					}

					return lines;
				},
			};
		});

		// Auto-dismiss welcome after first agent turn
		pi.on("agent_start", async (_ev, startCtx) => {
			if (headerActive) {
				headerActive = false;
				startCtx.ui.setHeader(undefined);
			}
		});
	});
}
