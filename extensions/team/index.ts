/**
 * Team Extension - AI Development Team Orchestration
 *
 * Spawns isolated `pi` processes for specialized team members.
 *
 * Supports three modes:
 *   - Single: { action: "run", agent: "name", task: "..." }
 *   - Parallel: { action: "parallel", tasks: [{ agent, task }, ...] }
 *   - Chain: { action: "chain", steps: [{ agent, task }, ...] }
 *   - List: { action: "list" }
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import { type ExtensionAPI, getAgentDir, getMarkdownTheme, parseFrontmatter } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;

// ---------------------------------------------------------------------------
// Agent discovery
// ---------------------------------------------------------------------------

interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	thinking?: string;
	systemPrompt: string;
	source: "package" | "user" | "project";
	filePath: string;
}

interface AgentDiscoveryResult {
	agents: AgentConfig[];
}

function loadAgentsFromDir(dir: string, source: AgentConfig["source"]): AgentConfig[] {
	const agents: AgentConfig[] = [];
	if (!fs.existsSync(dir)) return agents;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
		if (!frontmatter.name || !frontmatter.description) continue;

		const tools = frontmatter.tools
			?.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean);

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model,
			thinking: frontmatter.thinking,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function discoverAgents(cwd: string): AgentDiscoveryResult {
	const agentMap = new Map<string, AgentConfig>();

	// 1. Package-bundled agents (cortex/agents/)
	const __dirname = path.dirname(fileURLToPath(import.meta.url));
	const packageAgentsDir = path.resolve(__dirname, "../../agents");
	for (const agent of loadAgentsFromDir(packageAgentsDir, "package")) {
		agentMap.set(agent.name, agent);
	}

	// 2. User-global agents (~/.pi/agent/agents/)
	const userDir = path.join(getAgentDir(), "agents");
	for (const agent of loadAgentsFromDir(userDir, "user")) {
		agentMap.set(agent.name, agent);
	}

	// 3. Project-local agents (.pi/agents/)
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".pi", "agents");
		if (fs.existsSync(candidate)) {
			for (const agent of loadAgentsFromDir(candidate, "project")) {
				agentMap.set(agent.name, agent);
			}
			break;
		}
		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) break;
		currentDir = parentDir;
	}

	return { agents: Array.from(agentMap.values()) };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

function formatUsageStats(usage: UsageStats, model?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`\u2191${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`\u2193${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "read ") + themeFg("accent", shortenPath(rawPath));
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "write ") + themeFg("accent", shortenPath(rawPath));
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			return themeFg("muted", "grep ") + themeFg("accent", `/${pattern}/`);
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

// ---------------------------------------------------------------------------
// Process spawning
// ---------------------------------------------------------------------------

interface SingleResult {
	agent: string;
	agentSource: AgentConfig["source"];
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

interface TeamDetails {
	mode: "single" | "parallel" | "chain" | "list";
	results: SingleResult[];
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<TeamDetails>) => void;

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => TeamDetails,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "package",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (agent.model) args.push("--model", agent.model);
	if (agent.thinking) args.push("--thinking", agent.thinking);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpDir: string | null = null;
	let tmpPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: agent.model,
		step,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cortex-team-"));
			const safeName = agentName.replace(/[^\w.-]+/g, "_");
			tmpPath = path.join(tmpDir, `prompt-${safeName}.md`);
			await fs.promises.writeFile(tmpPath, agent.systemPrompt, { encoding: "utf-8", mode: 0o600 });
			args.push("--append-system-prompt", tmpPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data: Buffer) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data: Buffer) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => resolve(1));

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) throw new Error("Agent was aborted");
		return currentResult;
	} finally {
		if (tmpPath) try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
		if (tmpDir) try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
	}
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the team member to invoke" }),
	task: Type.String({ description: "Task to delegate" }),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the team member to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
});

const TeamParams = Type.Object({
	action: StringEnum(["run", "parallel", "chain", "list"] as const, {
		description: "Execution mode",
	}),
	agent: Type.Optional(Type.String({ description: "Team member name (for run mode)" })),
	task: Type.Optional(Type.String({ description: "Task description (for run mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	steps: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential chain execution" })),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "team",
		label: "Team",
		description: [
			"Delegate tasks to specialized team members with isolated context.",
			"Modes: run (single agent + task), parallel (tasks array), chain (sequential steps with {previous} placeholder), list (show available team members).",
			"Available team members: team-lead, dev-backend, dev-frontend, architect, qa.",
		].join(" "),
		parameters: TeamParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const { agents } = discoverAgents(ctx.cwd);

			const makeDetails =
				(mode: TeamDetails["mode"]) =>
				(results: SingleResult[]): TeamDetails => ({ mode, results });

			// List mode
			if (params.action === "list") {
				const listing = agents
					.map((a) => `- **${a.name}** (${a.source}): ${a.description}`)
					.join("\n");
				return {
					content: [{ type: "text", text: listing || "No agents found." }],
					details: makeDetails("list")([]),
				};
			}

			// Chain mode
			if (params.action === "chain") {
				if (!params.steps || params.steps.length === 0) {
					return {
						content: [{ type: "text", text: "Chain mode requires steps array." }],
						details: makeDetails("chain")([]),
					};
				}

				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.steps.length; i++) {
					const step = params.steps[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")([...results, currentResult]),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent(
						ctx.cwd, agents, step.agent, taskWithContext,
						i + 1, signal, chainUpdate, makeDetails("chain"),
					);
					results.push(result);

					const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
					if (isError) {
						const errorMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				return {
					content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
					details: makeDetails("chain")(results),
				};
			}

			// Parallel mode
			if (params.action === "parallel") {
				if (!params.tasks || params.tasks.length === 0) {
					return {
						content: [{ type: "text", text: "Parallel mode requires tasks array." }],
						details: makeDetails("parallel")([]),
					};
				}

				if (params.tasks.length > MAX_PARALLEL_TASKS) {
					return {
						content: [{ type: "text", text: `Too many tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` }],
						details: makeDetails("parallel")([]),
					};
				}

				const allResults: SingleResult[] = new Array(params.tasks.length);
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "package",
						task: params.tasks[i].task,
						exitCode: -1,
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						const running = allResults.filter((r) => r.exitCode === -1).length;
						onUpdate({
							content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent(
						ctx.cwd, agents, t.agent, t.task,
						undefined, signal,
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => r.exitCode === 0).length;
				const summaries = results.map((r) => {
					const output = getFinalOutput(r.messages);
					const preview = output.slice(0, 100) + (output.length > 100 ? "..." : "");
					return `[${r.agent}] ${r.exitCode === 0 ? "completed" : "failed"}: ${preview || "(no output)"}`;
				});
				return {
					content: [{ type: "text", text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}` }],
					details: makeDetails("parallel")(results),
				};
			}

			// Single run mode
			if (params.action === "run") {
				if (!params.agent || !params.task) {
					const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
					return {
						content: [{ type: "text", text: `Run mode requires agent and task. Available: ${available}` }],
						details: makeDetails("single")([]),
					};
				}

				const result = await runSingleAgent(
					ctx.cwd, agents, params.agent, params.task,
					undefined, signal, onUpdate, makeDetails("single"),
				);
				const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
				if (isError) {
					const errorMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
					details: makeDetails("single")([result]),
				};
			}

			return {
				content: [{ type: "text", text: `Unknown action: ${params.action}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			if (args.action === "list") {
				return new Text(theme.fg("toolTitle", theme.bold("team ")) + theme.fg("muted", "list"), 0, 0);
			}

			if (args.action === "chain" && args.steps?.length > 0) {
				let text = theme.fg("toolTitle", theme.bold("team ")) + theme.fg("accent", `chain (${args.steps.length} steps)`);
				for (let i = 0; i < Math.min(args.steps.length, 3); i++) {
					const step = args.steps[i];
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text += "\n  " + theme.fg("muted", `${i + 1}.`) + " " + theme.fg("accent", step.agent) + theme.fg("dim", ` ${preview}`);
				}
				if (args.steps.length > 3) text += `\n  ${theme.fg("muted", `... +${args.steps.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}

			if (args.action === "parallel" && args.tasks?.length > 0) {
				let text = theme.fg("toolTitle", theme.bold("team ")) + theme.fg("accent", `parallel (${args.tasks.length} tasks)`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}

			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text = theme.fg("toolTitle", theme.bold("team ")) + theme.fg("accent", agentName);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as TeamDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "\u2192 ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			// Single result
			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
				const icon = isError ? theme.fg("error", "\u2717") : theme.fg("success", "\u2713");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage) container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "\u2500\u2500\u2500 Task \u2500\u2500\u2500"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "\u2500\u2500\u2500 Output \u2500\u2500\u2500"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(new Text(theme.fg("muted", "\u2192 ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0));
							}
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			// Chain result
			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "\u2713") : theme.fg("error", "\u2717");

				const aggregateUsage = (): UsageStats => {
					const total: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
					for (const r of details.results) {
						total.input += r.usage.input;
						total.output += r.usage.output;
						total.cacheRead += r.usage.cacheRead;
						total.cacheWrite += r.usage.cacheWrite;
						total.cost += r.usage.cost;
						total.turns += r.usage.turns;
					}
					return total;
				};

				if (expanded) {
					const container = new Container();
					container.addChild(new Text(`${icon} ${theme.fg("toolTitle", theme.bold("chain "))}${theme.fg("accent", `${successCount}/${details.results.length} steps`)}`, 0, 0));

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "\u2713") : theme.fg("error", "\u2717");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);
						container.addChild(new Spacer(1));
						container.addChild(new Text(`${theme.fg("muted", `\u2500\u2500\u2500 Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`, 0, 0));
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(new Text(theme.fg("muted", "\u2192 ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0));
							}
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage());
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold("chain "))}${theme.fg("accent", `${successCount}/${details.results.length} steps`)}`;
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "\u2713") : theme.fg("error", "\u2717");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `\u2500\u2500\u2500 Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage());
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			// Parallel result
			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const failCount = details.results.filter((r) => r.exitCode > 0).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "\u23f3")
					: failCount > 0
						? theme.fg("warning", "\u25d0")
						: theme.fg("success", "\u2713");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(new Text(`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`, 0, 0));

					const aggregateUsage = (): UsageStats => {
						const total: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
						for (const r of details.results) {
							total.input += r.usage.input;
							total.output += r.usage.output;
							total.cacheRead += r.usage.cacheRead;
							total.cacheWrite += r.usage.cacheWrite;
							total.cost += r.usage.cost;
							total.turns += r.usage.turns;
						}
						return total;
					};

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "\u2713") : theme.fg("error", "\u2717");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);
						container.addChild(new Spacer(1));
						container.addChild(new Text(`${theme.fg("muted", "\u2500\u2500\u2500 ")}${theme.fg("accent", r.agent)} ${rIcon}`, 0, 0));
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(new Text(theme.fg("muted", "\u2192 ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0));
							}
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage());
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon = r.exitCode === -1
						? theme.fg("warning", "\u23f3")
						: r.exitCode === 0
							? theme.fg("success", "\u2713")
							: theme.fg("error", "\u2717");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "\u2500\u2500\u2500 ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});

	// /team command — list available agents
	pi.registerCommand("team", {
		description: "List available team members",
		handler: async (_args, ctx) => {
			const { agents } = discoverAgents(ctx.cwd);
			if (agents.length === 0) {
				ctx.ui.notify("No team members found.", "warning");
				return;
			}
			const listing = agents.map((a) => `${a.name} (${a.source}): ${a.description}`).join("\n");
			ctx.ui.notify(listing, "info");
		},
	});
}
