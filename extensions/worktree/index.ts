/**
 * Worktree Extension - Git worktree management for todo isolation
 *
 * Creates isolated git worktrees per todo so agents work on separate branches
 * without affecting the main working copy.
 *
 * Actions:
 *   - create: Create a worktree for a todo (branch: todo/<id>-<slug>)
 *   - commit: Commit all changes in a todo's worktree
 *   - merge: Merge a todo's branch into the base branch
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
	action: StringEnum(["create", "commit", "merge", "remove", "list"] as const, {
		description: "Action to perform",
	}),
	todo_id: Type.Optional(Type.String({ description: "Todo ID (for create/remove/commit/merge)" })),
	todo_title: Type.Optional(Type.String({ description: "Todo title (for create, used to derive branch name)" })),
	message: Type.Optional(Type.String({ description: "Commit message (for commit, auto-generated if omitted)" })),
	base: Type.Optional(Type.String({ description: "Base ref to branch from (for create) or merge into (for merge). Defaults to HEAD / main worktree branch." })),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "worktree",
		label: "Worktree",
		description: [
			"Manage git worktrees for todo isolation.",
			"Actions: create (new worktree), commit (stage & commit all changes), merge (merge todo branch into base), remove (clean up worktree), list (show all).",
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

			if (params.action === "commit") {
				if (!params.todo_id) {
					return {
						content: [{ type: "text", text: "Commit requires todo_id." }],
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

				// Check if there are any changes to commit
				const status = execSync("git status --porcelain", { cwd: match.path, encoding: "utf-8" }).trim();
				if (!status) {
					return {
						content: [{ type: "text", text: "No changes to commit." }],
						details: { path: match.path, branch: match.branch },
					};
				}

				const commitMsg = params.message || `${match.branch.replace("todo/", "").replace(/^\d+-/, "").replace(/-/g, " ")}`;

				try {
					execSync("git add -A", { cwd: match.path, encoding: "utf-8" });
					execSync(`git commit -m ${JSON.stringify(commitMsg)}`, { cwd: match.path, encoding: "utf-8" });
				} catch (err: any) {
					return {
						content: [{ type: "text", text: `Failed to commit: ${err.message}` }],
						details: {},
						isError: true,
					};
				}

				return {
					content: [{ type: "text", text: `Committed changes in ${match.path} on branch ${match.branch}: "${commitMsg}"` }],
					details: { path: match.path, branch: match.branch, message: commitMsg },
				};
			}

			if (params.action === "merge") {
				if (!params.todo_id) {
					return {
						content: [{ type: "text", text: "Merge requires todo_id." }],
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

				if (!match || !match.branch) {
					return {
						content: [{ type: "text", text: `No worktree/branch found for todo ${params.todo_id}.` }],
						details: {},
						isError: true,
					};
				}

				// Check for uncommitted changes in the worktree
				const status = execSync("git status --porcelain", { cwd: match.path, encoding: "utf-8" }).trim();
				if (status) {
					return {
						content: [{ type: "text", text: `Worktree has uncommitted changes. Run worktree commit first.\n${status}` }],
						details: { path: match.path, branch: match.branch },
						isError: true,
					};
				}

				// Determine the base branch (current branch of the main worktree)
				const baseBranch = params.base || execSync("git rev-parse --abbrev-ref HEAD", { cwd: repoRoot, encoding: "utf-8" }).trim();

				try {
					execSync(`git merge ${match.branch}`, { cwd: repoRoot, encoding: "utf-8" });
				} catch (err: any) {
					return {
						content: [{ type: "text", text: `Failed to merge ${match.branch} into ${baseBranch}: ${err.message}` }],
						details: {},
						isError: true,
					};
				}

				// Store merge commit SHA for stable report generation
				const mergeCommit = execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf-8" }).trim();

				// Generate completion report (non-blocking)
				if (params.todo_id) {
					try {
						const { generateCompletionReport } = await import("../report/index.ts");
						const { readTodo, writeTodo } = await import("../todos/index.ts");

						const report = generateCompletionReport(repoRoot, match.branch, baseBranch, mergeCommit);
						const todo = readTodo(ctx.cwd, params.todo_id);

						if (todo) {
							todo.completionReport = report;
							todo.meta.updated_at = new Date().toISOString();
							writeTodo(ctx.cwd, todo);
						}
					} catch (err: any) {
						// Report generation failure should not block the merge
						console.error(`Failed to generate completion report: ${err.message}`);
					}
				}

				return {
					content: [{ type: "text", text: `Merged ${match.branch} into ${baseBranch}` }],
					details: { branch: match.branch, baseBranch },
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

			// Generate completion report (never block on failure)
			if (params.todo_id) {
				try {
					const { generateCompletionReport } = await import("../report/index.ts");
					const { readTodo, writeTodo } = await import("../todos/index.ts");
					
					const report = generateCompletionReport(repoRoot, match.branch, baseBranch);
					const todo = readTodo(ctx.cwd, params.todo_id);
					
					if (todo) {
						todo.completionReport = report;
						todo.meta.updated_at = new Date().toISOString();
						writeTodo(ctx.cwd, todo);
					}
				} catch (reportErr: any) {
					// Report generation failure should never block the merge
					console.warn(`Warning: Failed to generate completion report: ${reportErr.message}`);
				}
			}

			return {
				content: [{ type: "text", text: `Unknown action: ${params.action}` }],
				details: {},
				isError: true,
			};
		},
	});
}
