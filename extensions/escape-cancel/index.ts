/**
 * Escape Cancel Extension
 *
 * Double-tap ESC (within 400ms) cancels all running operations:
 * main agent stream + all subagent processes.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { matchesKey } from "@mariozechner/pi-tui";

const DOUBLE_TAP_WINDOW = 400; // ms

export default function (pi: ExtensionAPI) {
	let lastEscTime = 0;
	let unsub: (() => void) | null = null;

	function cancelAll(ctx: ExtensionContext) {
		const g = globalThis as any;
		let cancelled = false;

		// 1. Abort main agent stream
		if (!ctx.isIdle()) {
			ctx.abort();
			cancelled = true;
		}

		// 2. Kill all subagent processes (exposed by team extension)
		if (typeof g.__piKillAllSubagents === "function") {
			const killed = g.__piKillAllSubagents();
			if (killed > 0) cancelled = true;
		}

		if (cancelled && ctx.hasUI) {
			ctx.ui.notify("All operations cancelled (ESC ESC)", "warning");
		}
	}

	/** Check if there are running operations. */
	function hasRunningOperations(): boolean {
		const g = globalThis as any;

		// Check subagents
		if (typeof g.__piHasRunningSubagents === "function" && g.__piHasRunningSubagents()) {
			return true;
		}

		return false;
	}

	function setupInputListener(ctx: ExtensionContext) {
		if (unsub) return; // Already listening
		if (!ctx.hasUI) return;

		unsub = ctx.ui.onTerminalInput((data: string) => {
			// Only detect bare ESC key
			if (!matchesKey(data, "escape")) return undefined;

			const now = Date.now();
			if (now - lastEscTime < DOUBLE_TAP_WINDOW) {
				// Double-tap detected
				lastEscTime = 0;
				// Only cancel if something is actually running
				if (!ctx.isIdle() || hasRunningOperations()) {
					cancelAll(ctx);
					return { consume: true };
				}
			} else {
				lastEscTime = now;
			}

			// Don't consume — let the normal ESC handler work
			return undefined;
		});
	}

	// Show hint while agent is running
	pi.on("agent_start", async (_event, ctx) => {
		if (ctx.hasUI) {
			ctx.ui.setStatus("esc-hint", "\x1b[2m ESC ESC to cancel\x1b[0m");
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (ctx.hasUI) {
			ctx.ui.setStatus("esc-hint", undefined);
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		lastEscTime = 0;
		if (ctx.hasUI) {
			setupInputListener(ctx);
		}
	});

	pi.on("session_switch", async (_event, ctx) => {
		lastEscTime = 0;
		if (ctx.hasUI) {
			ctx.ui.setStatus("esc-hint", undefined);
		}
	});

	pi.on("session_shutdown", async () => {
		if (unsub) {
			unsub();
			unsub = null;
		}
	});
}
