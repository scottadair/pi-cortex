/**
 * Worktree Extension - Git worktree management for todo isolation
 *
 * Creates isolated git worktrees per todo so agents work on separate branches
 * without affecting the main working copy.
 *
 * Actions:
 *   - create: Create a worktree for a todo (branch: todo/<id>-<slug>)
 *   - remove: Remove a todo's worktree and optionally its branch
 *   - list: List all active worktrees
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(text: string, maxLen = 40): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, maxLen);
}

function branchName(todoId: string, todoTitle: string): string {
	return `todo/${todoId}-${slugify(todoTitle)}`;
}

function worktreeDirName(todoId: string, todoTitle: string): string {
	return `todo-${todoId}-${slugify(todoTitle)}`;
}

function getRepoRoot(cwd: string): string {
	return execSync("git rev-parse --show-toplevel", { cwd, encoding: "utf-8" }).trim();
}

function getWorktreesDir(repoRoot: string): string {
	return path.join(repoRoot, ".cortex", "worktrees");
}

function ensureExcluded(repoRoot: string): void {
	const excludePath = path.join(repoRoot, ".git", "info", "exclude");
	const pattern = ".cortex/worktrees/";

	let content = "";
	if (fs.existsSync(excludePath)) {
		content = fs.readFileSync(excludePath, "utf-8");
		if (content.includes(pattern)) return;
	}

	fs.mkdirSync(path.dirname(excludePath), { recursive: true });
	fs.appendFileSync(excludePath, `\n${pattern}\n`);
}

interface WorktreeInfo {
	path: string;
	branch: string;
	head: string;
	bare: boolean;
}

function parseWorktreeList(cwd: string): WorktreeInfo[] {
	const raw = execSync("git worktree list --porcelain", { cwd, encoding: "utf-8" });
	const entries: WorktreeInfo[] = [];
	let current: Partial<WorktreeInfo> = {};

	for (const line of raw.split("\n")) {
		if (line.startsWith("worktree ")) {
			if (current.path) entries.push(current as WorktreeInfo);
			current = { path: line.slice(9), branch: "", head: "", bare: false };
		} else if (line.startsWith("HEAD ")) {
			current.head = line.slice(5);
		} else if (line.startsWith("branch ")) {
			current.branch = line.slice(7).replace("refs/heads/", "");
		} else if (line === "bare") {
			current.bare = true;
		}
	}
	if (current.path) entries.push(current as WorktreeInfo);

	return entries;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

const WorktreeParams = Type.Object({
	action: StringEnum(["create", "remove", "list"] as const, {
		description: "Action to perform",
	}),
	todo_id: Type.Optional(Type.String({ description: "Todo ID (for create/remove)" })),
	todo_title: Type.Optional(Type.String({ description: "Todo title (for create, used to derive branch name)" })),
	base: Type.Optional(Type.String({ description: "Base ref to branch from (for create, defaults to HEAD)" })),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "worktree",
		label: "Worktree",
		description: [
			"Manage git worktrees for todo isolation.",
			"Actions: create (new worktree for a todo), remove (clean up a todo's worktree), list (show all worktrees).",
			"Each todo gets its own branch (todo/<id>-<slug>) and working directory under .cortex/worktrees/.",
		].join(" "),
		parameters: WorktreeParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const repoRoot = getRepoRoot(ctx.cwd);
			const worktreesDir = getWorktreesDir(repoRoot);

			if (params.action === "list") {
				const entries = parseWorktreeList(repoRoot);
				const listing = entries
					.map((e) => `- ${e.branch || "(detached)"} → ${e.path}${e.bare ? " [bare]" : ""}`)
					.join("\n");
				return {
					content: [{ type: "text", text: listing || "No worktrees found." }],
					details: { entries },
				};
			}

			if (params.action === "create") {
				if (!params.todo_id || !params.todo_title) {
					return {
						content: [{ type: "text", text: "Create requires todo_id and todo_title." }],
						details: {},
						isError: true,
					};
				}

				const branch = branchName(params.todo_id, params.todo_title);
				const dirName = worktreeDirName(params.todo_id, params.todo_title);
				const wtPath = path.join(worktreesDir, dirName);

				// If worktree already exists, return its path
				if (fs.existsSync(wtPath)) {
					return {
						content: [{ type: "text", text: `Worktree already exists: ${wtPath}` }],
						details: { path: wtPath, branch, existed: true },
					};
				}

				ensureExcluded(repoRoot);
				fs.mkdirSync(worktreesDir, { recursive: true });

				// Check if branch already exists (resuming work)
				let branchExists = false;
				try {
					execSync(`git rev-parse --verify refs/heads/${branch}`, {
						cwd: repoRoot,
						stdio: "ignore",
					});
					branchExists = true;
				} catch {
					// Branch doesn't exist yet
				}

				const base = params.base || "HEAD";
				try {
					if (branchExists) {
						execSync(`git worktree add ${JSON.stringify(wtPath)} ${branch}`, {
							cwd: repoRoot,
							encoding: "utf-8",
						});
					} else {
						execSync(
							`git worktree add ${JSON.stringify(wtPath)} -b ${branch} ${base}`,
							{ cwd: repoRoot, encoding: "utf-8" },
						);
					}
				} catch (err: any) {
					return {
						content: [{ type: "text", text: `Failed to create worktree: ${err.message}` }],
						details: {},
						isError: true,
					};
				}

				return {
					content: [{ type: "text", text: `Created worktree at ${wtPath} on branch ${branch}` }],
					details: { path: wtPath, branch, existed: false },
				};
			}

			if (params.action === "remove") {
				if (!params.todo_id) {
					return {
						content: [{ type: "text", text: "Remove requires todo_id." }],
						details: {},
						isError: true,
					};
				}

				// Find the worktree by matching todo ID prefix
				const entries = parseWorktreeList(repoRoot);
				const prefix = `todo-${params.todo_id}-`;
				const match = entries.find((e) => {
					const dirName = path.basename(e.path);
					return dirName.startsWith(prefix);
				});

				if (!match) {
					return {
						content: [{ type: "text", text: `No worktree found for todo ${params.todo_id}.` }],
						details: {},
						isError: true,
					};
				}

				try {
					execSync(`git worktree remove ${JSON.stringify(match.path)}`, {
						cwd: repoRoot,
						encoding: "utf-8",
					});
				} catch {
					// Force remove if standard fails (e.g., untracked files)
					execSync(`git worktree remove --force ${JSON.stringify(match.path)}`, {
						cwd: repoRoot,
						encoding: "utf-8",
					});
				}

				// Try to delete the branch (safe delete, won't force)
				if (match.branch) {
					try {
						execSync(`git branch -d ${match.branch}`, {
							cwd: repoRoot,
							encoding: "utf-8",
						});
					} catch {
						// Branch not fully merged — leave it
					}
				}

				return {
					content: [{ type: "text", text: `Removed worktree ${match.path} (branch: ${match.branch})` }],
					details: { path: match.path, branch: match.branch },
				};
			}

			return {
				content: [{ type: "text", text: `Unknown action: ${params.action}` }],
				details: {},
				isError: true,
			};
		},
	});
}
