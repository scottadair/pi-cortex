/**
 * Memory Cycle Extension
 *
 * Preserves cortex-specific context across pi compaction by snapshotting
 * state (todos, worktrees, team outputs, file ops) before compaction and
 * restoring it after via a concise context injection.
 *
 * Hooks:
 * - session_before_compact: Save state snapshot
 * - session_compact: Set restoration flag
 * - context: Inject restoration message once after compaction
 * - session_start/session_switch: Load state, update status bar
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readAllTodos, type TodoFile } from "../todos/index.ts";

// ═══════════════════════════════════════════════════════════════════
// Data Model
// ═══════════════════════════════════════════════════════════════════

interface MemoryState {
	savedAt: string;
	activeTodos: Array<{ id: string; title: string; status: string; hasPlan: boolean }>;
	activeWorktrees: Array<{ branch: string; path: string }>;
	recentTeamOutputs: Array<{ agent: string; file: string; timestamp: string }>;
	fileOps: {
		readFiles: string[];
		writtenFiles: string[];
		editedFiles: string[];
	};
}

// ═══════════════════════════════════════════════════════════════════
// File Paths
// ═══════════════════════════════════════════════════════════════════

function getMemoryDir(cwd: string): string {
	return join(cwd, ".cortex", "memory");
}

function ensureMemoryDir(cwd: string): string {
	const dir = getMemoryDir(cwd);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function getStatePath(cwd: string): string {
	return join(getMemoryDir(cwd), "session-state.json");
}

// ═══════════════════════════════════════════════════════════════════
// State Extraction Helpers
// ═══════════════════════════════════════════════════════════════════

function getActiveTodos(cwd: string): Array<{ id: string; title: string; status: string; hasPlan: boolean }> {
	try {
		const allTodos = readAllTodos(cwd);
		return allTodos
			.filter((t) => t.meta.status !== "done")
			.map((t) => ({
				id: t.meta.id,
				title: t.meta.title,
				status: t.meta.status,
				hasPlan: !!t.plan,
			}));
	} catch {
		return [];
	}
}

function getActiveWorktrees(cwd: string): Array<{ branch: string; path: string }> {
	try {
		const output = execSync("git worktree list --porcelain", {
			cwd,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "ignore"],
		});

		const worktrees: Array<{ branch: string; path: string }> = [];
		const lines = output.split("\n");
		let currentPath = "";

		for (const line of lines) {
			if (line.startsWith("worktree ")) {
				currentPath = line.slice("worktree ".length);
			} else if (line.startsWith("branch ")) {
				const branch = line.slice("branch ".length).replace("refs/heads/", "");
				if (currentPath.includes(".cortex/worktrees/")) {
					worktrees.push({ branch, path: currentPath });
				}
				currentPath = "";
			}
		}

		return worktrees;
	} catch {
		return [];
	}
}

function getRecentTeamOutputs(cwd: string): Array<{ agent: string; file: string; timestamp: string }> {
	try {
		const outputDir = join(cwd, ".cortex", "team-outputs");
		if (!existsSync(outputDir)) return [];

		const files = execSync(`ls -t "${outputDir}"`, {
			cwd,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "ignore"],
		})
			.trim()
			.split("\n")
			.filter(Boolean);

		const recent: Array<{ agent: string; file: string; timestamp: string }> = [];
		for (const file of files.slice(0, 10)) {
			const filePath = join(outputDir, file);
			try {
				const stat = statSync(filePath);
				const match = file.match(/^(.+?)-(\d{8}-\d{6})\.md$/);
				if (match) {
					const agent = match[1];
					const timestamp = match[2];
					recent.push({ agent, file, timestamp });
				}
			} catch {
				continue;
			}
		}

		return recent;
	} catch {
		return [];
	}
}

// ═══════════════════════════════════════════════════════════════════
// State Persistence
// ═══════════════════════════════════════════════════════════════════

function saveState(cwd: string, state: MemoryState): void {
	try {
		ensureMemoryDir(cwd);
		const path = getStatePath(cwd);
		writeFileSync(path, JSON.stringify(state, null, 2), "utf-8");
	} catch {
		// Silently fail — memory is non-critical
	}
}

function loadState(cwd: string): MemoryState | null {
	try {
		const path = getStatePath(cwd);
		if (!existsSync(path)) return null;
		const content = readFileSync(path, "utf-8");
		return JSON.parse(content) as MemoryState;
	} catch {
		return null;
	}
}

function clearState(cwd: string): void {
	try {
		const path = getStatePath(cwd);
		if (existsSync(path)) {
			unlinkSync(path);
		}
	} catch {
		// Ignore errors
	}
}

// ═══════════════════════════════════════════════════════════════════
// Restoration Message Builder
// ═══════════════════════════════════════════════════════════════════

function buildRestorationMessage(state: MemoryState): string {
	const lines: string[] = [];
	lines.push("[Cortex Memory — restored after context compaction]");
	lines.push("");

	// Active todos
	if (state.activeTodos.length > 0) {
		lines.push("**Active Todos:**");
		for (const todo of state.activeTodos) {
			const planNote = todo.hasPlan ? " [has plan]" : "";
			lines.push(`- #${todo.id} "${todo.title}" (${todo.status})${planNote}`);
		}
		lines.push("");
	}

	// Active worktrees
	if (state.activeWorktrees.length > 0) {
		lines.push("**Active Worktrees:**");
		for (const wt of state.activeWorktrees) {
			const shortPath = wt.path.includes(".cortex/worktrees/")
				? wt.path.slice(wt.path.indexOf(".cortex/worktrees/"))
				: wt.path;
			lines.push(`- ${wt.branch} → ${shortPath}`);
		}
		lines.push("");
	}

	// Recent team activity
	if (state.recentTeamOutputs.length > 0) {
		lines.push("**Recent Team Activity:**");
		const recent = state.recentTeamOutputs.slice(0, 5);
		for (const output of recent) {
			// Format timestamp: 20260404-143035 → 14:30
			const time = output.timestamp.split("-")[1];
			const formatted = `${time.slice(0, 2)}:${time.slice(2, 4)}`;
			lines.push(`- ${output.agent} (${formatted})`);
		}
		lines.push("");
	}

	// File operations
	const hasFiles =
		state.fileOps.writtenFiles.length > 0 ||
		state.fileOps.editedFiles.length > 0 ||
		state.fileOps.readFiles.length > 0;

	if (hasFiles) {
		const modified = [...state.fileOps.writtenFiles, ...state.fileOps.editedFiles];
		if (modified.length > 0) {
			const fileList = modified.slice(0, 8).join(", ");
			const more = modified.length > 8 ? ` (+${modified.length - 8} more)` : "";
			lines.push(`**Files Modified:** ${fileList}${more}`);
		}

		if (state.fileOps.readFiles.length > 0) {
			const fileList = state.fileOps.readFiles.slice(0, 8).join(", ");
			const more = state.fileOps.readFiles.length > 8 ? ` (+${state.fileOps.readFiles.length - 8} more)` : "";
			lines.push(`**Files Read:** ${fileList}${more}`);
		}
		lines.push("");
	}

	lines.push("Continue your current task with this context in mind.");

	return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════
// Status Display Helpers
// ═══════════════════════════════════════════════════════════════════

function formatStateForDisplay(state: MemoryState): string {
	const lines: string[] = [];
	lines.push(`💾 Memory State (saved ${new Date(state.savedAt).toLocaleString()})`);
	lines.push("");
	lines.push(`Active todos: ${state.activeTodos.length}`);
	lines.push(`Active worktrees: ${state.activeWorktrees.length}`);
	lines.push(`Recent team outputs: ${state.recentTeamOutputs.length}`);
	lines.push(
		`File ops: ${state.fileOps.readFiles.length} read, ${state.fileOps.writtenFiles.length} written, ${state.fileOps.editedFiles.length} edited`,
	);

	if (state.activeTodos.length > 0) {
		lines.push("");
		lines.push("Active todos:");
		for (const todo of state.activeTodos) {
			const planNote = todo.hasPlan ? " [plan]" : "";
			lines.push(`  #${todo.id}: ${todo.title} (${todo.status})${planNote}`);
		}
	}

	return lines.join("\n");
}

function buildCurrentState(cwd: string): MemoryState {
	const fileOps = {
		readFiles: [],
		writtenFiles: [],
		editedFiles: [],
	};

	return {
		savedAt: new Date().toISOString(),
		activeTodos: getActiveTodos(cwd),
		activeWorktrees: getActiveWorktrees(cwd),
		recentTeamOutputs: getRecentTeamOutputs(cwd),
		fileOps,
	};
}

// ═══════════════════════════════════════════════════════════════════
// Extension Entry Point
// ═══════════════════════════════════════════════════════════════════

export default function (pi: ExtensionAPI) {
	// Track whether restoration should happen on the next context event
	let needsRestoration = false;

	function updateStatusBar(ctx: ExtensionContext): void {
		if (!ctx.hasUI || !ctx.ui.setStatus) return;

		const state = loadState(ctx.cwd);
		if (state) {
			ctx.ui.setStatus("memory", "💾 Memory");
		} else {
			ctx.ui.setStatus("memory", undefined);
		}
	}

	// ================================================================
	// Hook: session_before_compact
	// ================================================================

	pi.on("session_before_compact", async (event, ctx) => {
		const preparation = event.preparation;

		// Extract file operations from the compaction preparation
		const readFiles = Array.from(preparation.fileOps.read);
		const writtenFiles = Array.from(preparation.fileOps.written);
		const editedFiles = Array.from(preparation.fileOps.edited);

		const state: MemoryState = {
			savedAt: new Date().toISOString(),
			activeTodos: getActiveTodos(ctx.cwd),
			activeWorktrees: getActiveWorktrees(ctx.cwd),
			recentTeamOutputs: getRecentTeamOutputs(ctx.cwd),
			fileOps: {
				readFiles,
				writtenFiles,
				editedFiles,
			},
		};

		saveState(ctx.cwd, state);

		if (ctx.hasUI && ctx.ui.notify) {
			ctx.ui.notify("💾 Memory saved before compaction", "info");
		}
	});

	// ================================================================
	// Hook: session_compact
	// ================================================================

	pi.on("session_compact", async (_event, _ctx) => {
		needsRestoration = true;
	});

	// ================================================================
	// Hook: context
	// ================================================================

	pi.on("context", async (event, ctx) => {
		if (!needsRestoration) return;
		needsRestoration = false;

		const state = loadState(ctx.cwd);
		if (!state) return;

		const restorationText = buildRestorationMessage(state);

		// Prepend a user message with the restoration context
		const restorationMessage = {
			role: "user" as const,
			content: [{ type: "text" as const, text: restorationText }],
			timestamp: Date.now(),
		};

		return { messages: [restorationMessage, ...event.messages] };
	});

	// ================================================================
	// Hook: session_start
	// ================================================================

	pi.on("session_start", async (_event, ctx) => {
		needsRestoration = false;
		updateStatusBar(ctx);
	});

	// ================================================================
	// Hook: session_switch
	// ================================================================

	pi.on("session_switch", async (_event, ctx) => {
		needsRestoration = false;
		updateStatusBar(ctx);
	});

	// ================================================================
	// Command: /memory
	// ================================================================

	pi.registerCommand("memory", {
		description: "View or manage cortex memory state",
		handler: async (args, ctx) => {
			const sub = (args || "").trim().toLowerCase();

			if (sub === "save") {
				// Manual snapshot
				const state = buildCurrentState(ctx.cwd);
				saveState(ctx.cwd, state);
				updateStatusBar(ctx);
				ctx.ui.notify("💾 Memory state saved", "info");
				return;
			}

			if (sub === "clear") {
				clearState(ctx.cwd);
				updateStatusBar(ctx);
				ctx.ui.notify("🗑️  Memory state cleared", "info");
				return;
			}

			// Default: show current state
			const state = loadState(ctx.cwd);
			if (!state) {
				ctx.ui.notify("No memory state saved yet. State is captured during compaction.", "info");
				return;
			}
			ctx.ui.notify(formatStateForDisplay(state), "info");
		},
	});
}
