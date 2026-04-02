import { execSync } from "node:child_process";

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
