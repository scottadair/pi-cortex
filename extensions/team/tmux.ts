import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function isTmuxAvailable(): boolean {
	return !!process.env.TMUX;
}

export function openEditorPane(filePath: string): boolean {
	if (!isTmuxAvailable()) return false;
	const editor = process.env.VISUAL || process.env.EDITOR || "vim";
	try {
		execSync(`tmux split-window -h -l 50% "${editor} '${filePath}'"`, { timeout: 5000 });
		return true;
	} catch {
		return false;
	}
}

export class TmuxPaneManager {
	private panes = new Map<string, { paneId: string; logPath: string }>();
	private logOnly = new Map<string, string>();
	private queue: Array<{ agentId: string; agentName: string }> = [];
	private firstRightPaneId: string | null = null;
	private maxVisiblePanes = 4;
	private pendingTimers = new Set<ReturnType<typeof setTimeout>>();

	createPane(agentId: string, agentName: string): string {
		const logPath = path.join(os.tmpdir(), `cortex-agent-${agentId}.log`);
		fs.writeFileSync(logPath, `=== ${agentName} ===\n`, "utf-8");

		if (this.panes.size >= this.maxVisiblePanes) {
			this.queue.push({ agentId, agentName });
			this.logOnly.set(agentId, logPath);
			return logPath;
		}

		this.spawnPane(agentId, logPath);
		return logPath;
	}

	writeLog(agentId: string, line: string): void {
		const logPath = this.panes.get(agentId)?.logPath ?? this.logOnly.get(agentId);
		if (logPath) {
			try {
				fs.appendFileSync(logPath, line + "\n");
			} catch {
				/* non-fatal */
			}
		}
	}

	removePane(agentId: string): void {
		const pane = this.panes.get(agentId);
		if (pane) {
			const timer = setTimeout(() => {
				this.pendingTimers.delete(timer);
				this.exec(`tmux kill-pane -t ${pane.paneId}`);
				try {
					fs.unlinkSync(pane.logPath);
				} catch {
					/* ignore */
				}
				this.panes.delete(agentId);
				if (this.panes.size === 0) this.firstRightPaneId = null;
				this.promoteQueued();
			}, 2000);
			this.pendingTimers.add(timer);
			return;
		}

		// Log-only agent (was queued, never got a pane)
		const logPath = this.logOnly.get(agentId);
		if (logPath) {
			this.logOnly.delete(agentId);
			this.queue = this.queue.filter((q) => q.agentId !== agentId);
			const timer = setTimeout(() => {
				this.pendingTimers.delete(timer);
				try {
					fs.unlinkSync(logPath);
				} catch {
					/* ignore */
				}
			}, 2000);
			this.pendingTimers.add(timer);
		}
	}

	cleanup(): void {
		for (const timer of this.pendingTimers) clearTimeout(timer);
		this.pendingTimers.clear();

		for (const { paneId, logPath } of this.panes.values()) {
			this.exec(`tmux kill-pane -t ${paneId}`);
			try {
				fs.unlinkSync(logPath);
			} catch {
				/* ignore */
			}
		}
		for (const logPath of this.logOnly.values()) {
			try {
				fs.unlinkSync(logPath);
			} catch {
				/* ignore */
			}
		}
		this.panes.clear();
		this.logOnly.clear();
		this.queue = [];
		this.firstRightPaneId = null;
	}

	private spawnPane(agentId: string, logPath: string): void {
		let paneId: string;
		if (this.panes.size === 0) {
			paneId = this.exec(`tmux split-window -h -d -l 50% -P -F "#{pane_id}" "tail -f '${logPath}'"`);
			this.firstRightPaneId = paneId;
		} else {
			paneId = this.exec(
				`tmux split-window -v -d -t ${this.firstRightPaneId} -P -F "#{pane_id}" "tail -f '${logPath}'"`,
			);
			// Rebalance the right column
			if (this.firstRightPaneId) {
				this.exec(`tmux select-layout -t ${this.firstRightPaneId} even-vertical`);
			}
		}
		if (paneId) {
			this.panes.set(agentId, { paneId, logPath });
		}
	}

	private promoteQueued(): void {
		while (this.queue.length > 0 && this.panes.size < this.maxVisiblePanes) {
			const next = this.queue.shift()!;
			const logPath = this.logOnly.get(next.agentId);
			if (logPath) {
				this.logOnly.delete(next.agentId);
				this.spawnPane(next.agentId, logPath);
			}
		}
	}

	private exec(cmd: string): string {
		try {
			return execSync(cmd, { encoding: "utf-8", timeout: 5000 }).trim();
		} catch {
			return "";
		}
	}
}
