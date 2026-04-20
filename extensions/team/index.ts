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

import { execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message, Model } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import { type ExtensionAPI, type ExtensionContext, DynamicBorder, copyToClipboard, getAgentDir, getMarkdownTheme, parseFrontmatter } from "@mariozechner/pi-coding-agent";
import {
	Container,
	type Focusable,
	fuzzyMatch,
	Input,
	Key,
	Markdown,
	matchesKey,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
	type TUI,
} from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { isTmuxAvailable, openEditorPane } from "./tmux.ts";

// ---------------------------------------------------------------------------
// Active process tracking (for external cancellation)
// ---------------------------------------------------------------------------

const activeProcesses = new Set<import("node:child_process").ChildProcess>();

export function killAllSubagents(): number {
	let killed = 0;
	for (const proc of activeProcesses) {
		if (!proc.killed) {
			proc.kill("SIGTERM");
			killed++;
			// Force kill after 5 seconds
			setTimeout(() => {
				if (!proc.killed) proc.kill("SIGKILL");
			}, 5000);
		}
	}
	activeProcesses.clear();
	return killed;
}

export function hasRunningSubagents(): boolean {
	for (const proc of activeProcesses) {
		if (!proc.killed) return true;
	}
	return false;
}

// Expose on globalThis for escape-cancel extension
if (typeof globalThis !== "undefined") {
	(globalThis as any).__piKillAllSubagents = killAllSubagents;
	(globalThis as any).__piHasRunningSubagents = hasRunningSubagents;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;

const AGENT_ICONS: Record<string, string> = {
	"team-lead": "👑 ",
	"architect": "🏗  ",
	"dev-backend": "⚙  ",
	"dev-frontend": "🎨 ",
	"qa": "🔍 ",
};
const DEFAULT_AGENT_ICON = "🤖 ";

/** Visual column width of an icon string (emoji = 2 cols, spaces = 1 col each). */
function iconVisualWidth(icon: string): number {
	// Count trailing spaces; the emoji itself is 2 columns wide
	const spaces = icon.length - icon.trimEnd().length;
	return 2 + spaces;
}

function getAgentIcon(name: string): string {
	for (const [key, icon] of Object.entries(AGENT_ICONS)) {
		if (name === key || name.includes(key)) return icon;
	}
	return DEFAULT_AGENT_ICON;
}

// ---------------------------------------------------------------------------
// Agent management helpers
// ---------------------------------------------------------------------------

function getProjectAgentsDir(cwd: string): string {
	return path.join(cwd, ".cortex", "agents");
}

/**
 * Read project-level provider defaults from .cortex/providers.json.
 * Returns default provider and model for agents that don't specify their own.
 */
function getProjectProviderDefaults(cwd: string): { agents?: string; model?: string } {
	try {
		const configPath = path.join(cwd, ".cortex", "providers.json");
		if (!fs.existsSync(configPath)) return {};
		const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
		return config.defaults || {};
	} catch {
		return {};
	}
}

function ensureProjectAgentsDir(cwd: string): string {
	const dir = getProjectAgentsDir(cwd);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function serializeAgentFile(frontmatter: Record<string, any>, body: string): string {
	const lines: string[] = [];
	for (const [key, value] of Object.entries(frontmatter)) {
		if (value === undefined || value === null) continue;
		lines.push(`${key}: ${String(value)}`);
	}
	return `---\n${lines.join("\n")}\n---\n\n${body}`;
}

function copyAgentToProject(cwd: string, agent: AgentConfig): string {
	try {
		const dir = ensureProjectAgentsDir(cwd);
		const fileName = `${agent.name}.md`;
		const destPath = path.join(dir, fileName);
		
		const content = fs.readFileSync(agent.filePath, "utf-8");
		fs.writeFileSync(destPath, content, "utf-8");
		
		return destPath;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to copy agent to project: ${message}`);
	}
}

function createAgentOverride(cwd: string, agent: AgentConfig): AgentConfig {
	const newPath = copyAgentToProject(cwd, agent);
	return {
		...agent,
		source: "project",
		filePath: newPath,
	};
}

function updateAgentFrontmatter(
	agent: AgentConfig,
	updates: { model?: string; tools?: string[]; thinking?: string; provider?: string }
): void {
	try {
		const content = fs.readFileSync(agent.filePath, "utf-8");
		const { frontmatter, body } = parseFrontmatter<Record<string, any>>(content);
		
		if (updates.model !== undefined) {
			if (updates.model === "") {
				delete frontmatter.model;
			} else {
				frontmatter.model = updates.model;
			}
		}
		
		if (updates.tools !== undefined) {
			frontmatter.tools = updates.tools.join(", ");
		}
		
		if (updates.thinking !== undefined) {
			if (updates.thinking === "") {
				delete frontmatter.thinking;
			} else {
				frontmatter.thinking = updates.thinking;
			}
		}

		if (updates.provider !== undefined) {
			if (updates.provider === "") {
				delete frontmatter.provider;
			} else {
				frontmatter.provider = updates.provider;
			}
		}
		
		const serialized = serializeAgentFile(frontmatter, body);
		fs.writeFileSync(agent.filePath, serialized, "utf-8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to update agent configuration: ${message}`);
	}
}

function deleteProjectAgent(cwd: string, agentName: string): boolean {
	try {
		const filePath = path.join(getProjectAgentsDir(cwd), `${agentName}.md`);
		if (!fs.existsSync(filePath)) return false;
		fs.unlinkSync(filePath);
		return true;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to delete agent: ${message}`);
	}
}

// ---------------------------------------------------------------------------
// Disabled agents management
// ---------------------------------------------------------------------------

function getDisabledAgentsPath(cwd: string): string {
	return path.join(cwd, ".cortex", "agents", ".disabled.json");
}

function loadDisabledAgents(cwd: string): Set<string> {
	const filePath = getDisabledAgentsPath(cwd);
	try {
		if (!fs.existsSync(filePath)) return new Set();
		const content = fs.readFileSync(filePath, "utf-8");
		const arr = JSON.parse(content);
		return new Set(Array.isArray(arr) ? arr : []);
	} catch {
		return new Set();
	}
}

function saveDisabledAgents(cwd: string, disabled: Set<string>): void {
	const dir = path.join(cwd, ".cortex", "agents");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		getDisabledAgentsPath(cwd),
		JSON.stringify([...disabled].sort(), null, 2),
		"utf-8"
	);
}

function disableAgent(cwd: string, name: string): void {
	const disabled = loadDisabledAgents(cwd);
	disabled.add(name);
	saveDisabledAgents(cwd, disabled);
}

function enableAgent(cwd: string, name: string): void {
	const disabled = loadDisabledAgents(cwd);
	disabled.delete(name);
	saveDisabledAgents(cwd, disabled);
}

interface AgentTemplate {
	name: string;
	description: string;
	path: string;
}

function getAvailableTemplates(): AgentTemplate[] {
	const __dirname = path.dirname(fileURLToPath(import.meta.url));
	const templatesDir = path.resolve(__dirname, "../../templates/agents");
	
	if (!fs.existsSync(templatesDir)) return [];
	
	const templates: AgentTemplate[] = [];
	for (const entry of fs.readdirSync(templatesDir, { withFileTypes: true })) {
		if (!entry.name.endsWith(".md") || !entry.isFile()) continue;
		
		const filePath = path.join(templatesDir, entry.name);
		try {
			const content = fs.readFileSync(filePath, "utf-8");
			const { frontmatter } = parseFrontmatter<Record<string, string>>(content);
			
			if (frontmatter.description) {
				templates.push({
					name: entry.name.replace(/\.md$/, ""),
					description: frontmatter.description,
					path: filePath,
				});
			}
		} catch {
			continue;
		}
	}
	
	return templates.sort((a, b) => a.name.localeCompare(b.name));
}

function createAgentFromTemplate(cwd: string, name: string, templatePath: string): AgentConfig {
	try {
		const dir = ensureProjectAgentsDir(cwd);
		const content = fs.readFileSync(templatePath, "utf-8");
		const { frontmatter, body } = parseFrontmatter<Record<string, any>>(content);
		
		// Update the name in frontmatter
		frontmatter.name = name;
		
		const serialized = serializeAgentFile(frontmatter, body);
		const destPath = path.join(dir, `${name}.md`);
		fs.writeFileSync(destPath, serialized, "utf-8");
		
		// Parse the new file to create AgentConfig
		const tools = frontmatter.tools
			?.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean);
		
		return {
			name: frontmatter.name,
			description: frontmatter.description || "",
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model,
			provider: frontmatter.provider,
			thinking: frontmatter.thinking,
			systemPrompt: body,
			source: "project",
			filePath: destPath,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to create agent from template: ${message}`);
	}
}

// ---------------------------------------------------------------------------
// Agent discovery
// ---------------------------------------------------------------------------

interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	provider?: string;
	thinking?: string;
	systemPrompt: string;
	source: "package" | "user" | "pi-project" | "project";
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
			provider: frontmatter.provider,
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

	// 3. Pi project-local agents (.pi/agents/)
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".pi", "agents");
		if (fs.existsSync(candidate)) {
			for (const agent of loadAgentsFromDir(candidate, "pi-project")) {
				agentMap.set(agent.name, agent);
			}
			break;
		}
		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) break;
		currentDir = parentDir;
	}

	// 4. Cortex project-local agents (.cortex/agents/) — project root only, highest priority
	const cortexAgentsDir = path.join(cwd, ".cortex", "agents");
	for (const agent of loadAgentsFromDir(cortexAgentsDir, "project")) {
		agentMap.set(agent.name, agent);
	}

	// 5. Filter out disabled agents
	const disabled = loadDisabledAgents(cwd);
	for (const name of disabled) {
		agentMap.delete(name);
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
	outputFile?: string;
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

function normalizeInlineText(text: string): string {
	return text.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

function summarizeToolArgs(args: Record<string, unknown>): string {
	const cmd = args.command as string | undefined;
	if (cmd) {
		const normalized = normalizeInlineText(cmd);
		return normalized.length > 60 ? normalized.slice(0, 60) + "..." : normalized;
	}
	const filePath = (args.file_path || args.path) as string | undefined;
	if (filePath) return normalizeInlineText(filePath);
	const pattern = args.pattern as string | undefined;
	if (pattern) return normalizeInlineText(`/${pattern}/`);
	return normalizeInlineText(JSON.stringify(args)).slice(0, 50);
}

// ---------------------------------------------------------------------------
// Widget-based agent status display
// ---------------------------------------------------------------------------

interface AgentStatus {
	name: string;
	task: string;
	status: "running" | "done" | "failed";
	turns: number;
	cost: number;
	lastTool?: string;
	startedAt: number;
	parentId?: string;
	delegatedAgent?: string;
}

class AgentWidgetManager {
	private agents = new Map<string, AgentStatus>();
	private ctx: ExtensionContext;
	private removeTimer?: ReturnType<typeof setTimeout>;
	// Track pending team tool calls: toolCallId → nested agentId in widget
	private pendingDelegations = new Map<string, string>();

	constructor(ctx: ExtensionContext) {
		this.ctx = ctx;
	}

	register(agentId: string, name: string, task: string): void {
		if (this.removeTimer) {
			clearTimeout(this.removeTimer);
			this.removeTimer = undefined;
		}
		const normalizedTask = normalizeInlineText(task);
		this.agents.set(agentId, {
			name,
			task: normalizedTask.length > 60 ? normalizedTask.slice(0, 60) + "..." : normalizedTask,
			status: "running",
			turns: 0,
			cost: 0,
			startedAt: Date.now(),
		});
		this.render();
	}

	update(agentId: string, patch: Partial<AgentStatus>): void {
		const agent = this.agents.get(agentId);
		if (agent) {
			Object.assign(agent, patch);
			this.render();
		}
	}

	/**
	 * Register a nested agent delegation (e.g. team-lead → dev-frontend).
	 * Called when we detect a `team` tool call with action "run" in messages.
	 */
	registerDelegation(parentAgentId: string, toolCallId: string, childName: string, childTask: string): void {
		const childId = `${childName}-delegated-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		this.pendingDelegations.set(toolCallId, childId);
		const normalizedTask = normalizeInlineText(childTask);
		this.agents.set(childId, {
			name: childName,
			task: normalizedTask.length > 60 ? normalizedTask.slice(0, 60) + "..." : normalizedTask,
			status: "running",
			turns: 0,
			cost: 0,
			startedAt: Date.now(),
			parentId: parentAgentId,
		});
		// Update parent to show it's delegating
		const parent = this.agents.get(parentAgentId);
		if (parent) {
			parent.delegatedAgent = childName;
		}
		this.render();
	}

	/**
	 * Complete a nested delegation when we see the tool result come back.
	 */
	completeDelegation(toolCallId: string, success: boolean): void {
		const childId = this.pendingDelegations.get(toolCallId);
		if (!childId) return;
		this.pendingDelegations.delete(toolCallId);
		const child = this.agents.get(childId);
		if (child) {
			child.status = success ? "done" : "failed";
		}
		// Clear parent's delegatedAgent
		if (child?.parentId) {
			const parent = this.agents.get(child.parentId);
			if (parent && parent.delegatedAgent === child.name) {
				parent.delegatedAgent = undefined;
			}
		}
		this.render();
	}

	complete(agentId: string, success: boolean): void {
		const agent = this.agents.get(agentId);
		if (agent) {
			agent.status = success ? "done" : "failed";
			// Also complete any still-running nested agents under this parent
			for (const [childId, child] of this.agents) {
				if (child.parentId === agentId && child.status === "running") {
					child.status = success ? "done" : "failed";
				}
			}
			this.render();
		}
		const allDone = [...this.agents.values()].every((a) => a.status !== "running");
		if (allDone) {
			this.removeTimer = setTimeout(() => this.cleanup(), 3000);
		}
	}

	cleanup(): void {
		if (this.removeTimer) {
			clearTimeout(this.removeTimer);
			this.removeTimer = undefined;
		}
		if (this.ctx.hasUI) {
			this.ctx.ui.setWidget("team-agents", undefined);
		}
	}

	private render(): void {
		if (!this.ctx.hasUI) return;

		const entries = [...this.agents.entries()];
		// Separate top-level and nested agents
		const topLevel = entries.filter(([_, a]) => !a.parentId);
		const nested = entries.filter(([_, a]) => a.parentId);
		const nestedByParent = new Map<string, [string, AgentStatus][]>();
		for (const entry of nested) {
			const parentId = entry[1].parentId!;
			if (!nestedByParent.has(parentId)) nestedByParent.set(parentId, []);
			nestedByParent.get(parentId)!.push(entry);
		}

		const allStatuses = entries.map(([_, a]) => a);
		const running = allStatuses.filter((a) => a.status === "running").length;
		const total = entries.length;

		// Sort: running first, then done/failed
		const sorted = [...topLevel].sort((a, b) => {
			if (a[1].status === "running" && b[1].status !== "running") return -1;
			if (a[1].status !== "running" && b[1].status === "running") return 1;
			return 0;
		});

		// Calculate column width: longest (indent + icon + name) across all rows
		const TOP_INDENT = "  ";           // 2 chars
		const CHILD_INDENT = "    \u2514 "; // 6 chars
		let maxLabelLen = 0;
		for (const [agentId, agent] of sorted) {
			const icon = getAgentIcon(agent.name);
			const visualWidth = TOP_INDENT.length + iconVisualWidth(icon) + agent.name.length;
			maxLabelLen = Math.max(maxLabelLen, visualWidth);
			const children = nestedByParent.get(agentId);
			if (children) {
				for (const [_, child] of children) {
					const childIcon = getAgentIcon(child.name);
					const childVisualWidth = CHILD_INDENT.length + iconVisualWidth(childIcon) + child.name.length;
					maxLabelLen = Math.max(maxLabelLen, childVisualWidth);
				}
			}
		}

		this.ctx.ui.setWidget("team-agents", (_tui, theme) => {
			const border = (s: string) => theme.fg("border", s);

			const headerText = running > 0
				? theme.fg("warning", `${running}`) + theme.fg("muted", `/${total} running`)
				: theme.fg("success", `${total} done`);

			const formatAgent = (agent: AgentStatus, indent: string, isNested: boolean) => {
				const icon = getAgentIcon(agent.name);
				const label = indent + icon + theme.fg("accent", agent.name);
				const visualLen = indent.length + iconVisualWidth(icon) + agent.name.length;
				const paddingNeeded = maxLabelLen - visualLen;
				const paddedLabel = label + " ".repeat(Math.max(0, paddingNeeded));

				const elapsed = Math.round((Date.now() - agent.startedAt) / 1000);
				const elapsedStr = elapsed >= 60
					? `${Math.floor(elapsed / 60)}m${elapsed % 60}s`
					: `${elapsed}s`;

				let status: string;
				if (agent.status === "running") status = theme.fg("warning", "\u25b6 running");
				else if (agent.status === "done") status = theme.fg("success", "\u2713 done  ");
				else status = theme.fg("error", "\u2717 failed");

				// Nested agents don't have their own turn/cost visibility,
				// so show the delegated task instead
				if (isNested) {
					const taskPreview = agent.task.length > 50 ? agent.task.slice(0, 50) + "..." : agent.task;
					return border("\u2502 ") + `${paddedLabel}  ${status}  ${theme.fg("dim", taskPreview)}  ${theme.fg("dim", elapsedStr)}`;
				}

				const turnsCost = theme.fg("dim", `T${agent.turns}`) + " " + theme.fg("muted", `$${agent.cost.toFixed(2)}`);
				// Truncate the raw tool string BEFORE applying theme colors
				const rawTool = normalizeInlineText(agent.lastTool || "");
				const toolTruncated = rawTool.length > 40 ? rawTool.slice(0, 40) + "..." : rawTool;
				const tool = toolTruncated ? theme.fg("muted", " \u2502 ") + theme.fg("toolTitle", toolTruncated) : "";

				return border("\u2502 ") + `${paddedLabel}  ${status}  ${turnsCost}${tool}  ${theme.fg("dim", elapsedStr)}`;
			};

			return {
				render: () => {
					const lines: string[] = [];

					// Header
					lines.push(border("\u250c\u2500 ") + theme.fg("accent", theme.bold("Team")) + theme.fg("muted", " \u2500 ") + headerText);

					// Agent rows
					for (const [agentId, agent] of sorted) {
						lines.push(formatAgent(agent, TOP_INDENT, false));
						const children = nestedByParent.get(agentId);
						if (children) {
							for (const [_, child] of children) {
								lines.push(formatAgent(child, CHILD_INDENT, true));
							}
						}
					}

					// Summary footer
					const totalCost = allStatuses.reduce((sum, a) => sum + a.cost, 0);
					const maxElapsed = allStatuses.length > 0 ? Math.max(...allStatuses.map(a => Math.round((Date.now() - a.startedAt) / 1000))) : 0;
					const elapsedStr = maxElapsed >= 60
						? `${Math.floor(maxElapsed / 60)}m${maxElapsed % 60}s`
						: `${maxElapsed}s`;
					lines.push(border("\u2514\u2500 ") + theme.fg("dim", `Total: $${totalCost.toFixed(2)} \u2502 ${elapsedStr}`));

					return lines;
				},
				invalidate: () => {}
			};
		}, { placement: "aboveEditor" });
	}
}

const JSON_ERROR_PATTERNS = [
	'Unexpected non-whitespace character after JSON',
	'Bad control character in string literal in JSON',
	'Unterminated string in JSON',
	'Expected property name or \'}\'',
];

function containsJsonError(text: string): boolean {
	for (const pattern of JSON_ERROR_PATTERNS) {
		if (text.includes(pattern)) return true;
	}
	if (text.includes('Unexpected token') && text.includes('JSON')) return true;
	return false;
}

function isJsonParseError(result: SingleResult): boolean {
	// Check stderr
	if (containsJsonError(result.stderr)) return true;

	// Check toolResult messages
	for (const msg of result.messages) {
		if (msg.role !== 'toolResult') continue;
		
		if (typeof msg.content === 'string') {
			if (containsJsonError(msg.content)) return true;
		} else if (Array.isArray(msg.content)) {
			for (const part of msg.content) {
				if (part.type === 'text' && containsJsonError(part.text)) return true;
			}
		}
	}

	return false;
}

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => TeamDetails,
	widget?: AgentWidgetManager,
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

	// Read project provider defaults from .cortex/providers.json
	const projectDefaults = getProjectProviderDefaults(defaultCwd);
	const effectiveProvider = agent.provider || projectDefaults.agents;
	const effectiveModel = agent.model || projectDefaults.model;

	// Use provider/model syntax when both are set so pi resolves the
	// model under the correct provider's credentials.
	// If the model already contains a "/" it already specifies its provider,
	// so don't prepend another one (avoids "anthropic-work/anthropic/claude-sonnet-4-6").
	const modelAlreadyHasProvider = effectiveModel ? effectiveModel.includes("/") : false;
	if (effectiveModel && effectiveProvider && !modelAlreadyHasProvider) {
		args.push("--model", `${effectiveProvider}/${effectiveModel}`);
	} else {
		if (effectiveModel) args.push("--model", effectiveModel);
		if (effectiveProvider && !modelAlreadyHasProvider) args.push("--provider", effectiveProvider);
	}

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

	const agentId = `${agentName}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
	if (widget) {
		widget.register(agentId, agentName, task);
	}

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
		let buffer = "";

		const MAX_JSON_RETRIES = 2;
		let jsonRetryCount = 0;

		while (true) {
			// Reset state for retry
			wasAborted = false;
			buffer = "";

			const exitCode = await new Promise<number>((resolve) => {
				const invocation = getPiInvocation(args);
				const proc = spawn(invocation.command, invocation.args, {
					cwd: defaultCwd,
					shell: false,
					stdio: ["ignore", "pipe", "pipe"],
				});
				activeProcesses.add(proc);

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

						if (widget && msg.role === "assistant") {
							const content = (msg.content ?? []) as Array<Record<string, any>>;
							let lastTool: string | undefined;
							for (const part of content) {
								if (part.type === "toolCall") {
									lastTool = `${part.name} ${summarizeToolArgs(part.arguments ?? {})}`;
									// Detect nested team delegations
									if (part.name === "team" && part.id) {
										const teamArgs = part.arguments ?? {};
										if (teamArgs.action === "run" && teamArgs.agent) {
											widget.registerDelegation(
												agentId, part.id,
												teamArgs.agent,
												teamArgs.task || "(delegated task)",
											);
										} else if (teamArgs.action === "parallel" && Array.isArray(teamArgs.tasks)) {
											for (const t of teamArgs.tasks) {
												if (t.agent) {
													widget.registerDelegation(
														agentId, part.id,
														t.agent,
														t.task || "(parallel task)",
													);
												}
											}
										} else if (teamArgs.action === "chain" && Array.isArray(teamArgs.steps)) {
											// For chains, show the first step as delegated
											const first = teamArgs.steps[0];
											if (first?.agent) {
												widget.registerDelegation(
													agentId, part.id,
													`${first.agent} (+${teamArgs.steps.length - 1} more)`,
													first.task || "(chain)",
												);
											}
										}
									}
								}
							}
							widget.update(agentId, {
								turns: currentResult.usage.turns,
								cost: currentResult.usage.cost,
								...(lastTool ? { lastTool } : {}),
							});
						}

						emitUpdate();
					}

					if (event.type === "tool_result_end" && event.message) {
						const toolResultMsg = event.message as Message;
						currentResult.messages.push(toolResultMsg);
						// Complete nested delegation when tool result comes back
						if (widget && toolResultMsg.role === "toolResult") {
							const trMsg = toolResultMsg as any;
							if (trMsg.toolCallId && trMsg.toolName === "team") {
								widget.completeDelegation(trMsg.toolCallId, !trMsg.isError);
							}
						}
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
					activeProcesses.delete(proc);
					resolve(code ?? 0);
				});

				proc.on("error", () => {
					activeProcesses.delete(proc);
					resolve(1);
				});

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

			// Check for JSON parse error and retry
			if (currentResult.exitCode !== 0 && isJsonParseError(currentResult) && jsonRetryCount < MAX_JSON_RETRIES) {
				jsonRetryCount++;
				// Accumulate costs before reset
				const prevCost = currentResult.usage.cost;
				const prevInput = currentResult.usage.input;
				const prevOutput = currentResult.usage.output;
				const prevCacheRead = currentResult.usage.cacheRead;
				const prevCacheWrite = currentResult.usage.cacheWrite;
				// Reset for retry
				currentResult.messages = [];
				currentResult.stderr = "";
				currentResult.usage = {
					input: prevInput,
					output: prevOutput,
					cacheRead: prevCacheRead,
					cacheWrite: prevCacheWrite,
					cost: prevCost,
					contextTokens: 0,
					turns: 0,
				};
				currentResult.stopReason = undefined;
				currentResult.errorMessage = undefined;
				continue;
			}
			break;
		}

		if (widget) {
			widget.complete(agentId, currentResult.exitCode === 0);
		}

		// Save agent output to file so callers can reference it by path
		const finalText = getFinalOutput(currentResult.messages);
		if (finalText && currentResult.exitCode === 0) {
			const outputDir = path.join(defaultCwd, ".cortex", "team-outputs");
			fs.mkdirSync(outputDir, { recursive: true });

			// Ensure .cortex/team-outputs/ is git-excluded
			try {
				const repoRoot = execSync("git rev-parse --show-toplevel", { cwd: defaultCwd, encoding: "utf-8" }).trim();
				const excludePath = path.join(repoRoot, ".git", "info", "exclude");
				const pattern = ".cortex/team-outputs/";
				const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf-8") : "";
				if (!existing.includes(pattern)) {
					fs.mkdirSync(path.dirname(excludePath), { recursive: true });
					fs.appendFileSync(excludePath, `\n${pattern}\n`);
				}
			} catch { /* not a git repo or exclude failed — non-critical */ }

			const safeName = agentName.replace(/[^\w.-]+/g, "_");
			const outputPath = path.join(outputDir, `${safeName}-${Date.now()}.md`);
			fs.writeFileSync(outputPath, finalText, "utf-8");
			currentResult.outputFile = outputPath;
		}

		return currentResult;
	} catch (err) {
		if (widget) {
			widget.complete(agentId, false);
		}
		throw err;
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
	cwd: Type.Optional(Type.String({ description: "Working directory override. Use to run agents in a git worktree." })),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "team",
		label: "Team",
		description: [
			"Delegate tasks to specialized team members with isolated context.",
			"Modes: run (single agent + task), parallel (tasks array), chain (sequential steps with {previous} placeholder), list (show available team members).",
			"Available team members: team-lead, dev-backend, dev-frontend, architect, qa.",
			"Agent discovery: package (cortex/agents/) → user (~/.pi/agent/agents/) → pi-project (.pi/agents/) → project (.cortex/agents/).",
		].join(" "),
		parameters: TeamParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const effectiveCwd = params.cwd || ctx.cwd;
			const { agents } = discoverAgents(effectiveCwd);
			const widget = ctx.hasUI ? new AgentWidgetManager(ctx) : undefined;
			if (widget && signal) {
				signal.addEventListener("abort", () => widget.cleanup(), { once: true });
			}

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
						effectiveCwd, agents, step.agent, taskWithContext,
						i + 1, signal, chainUpdate, makeDetails("chain"), widget,
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
				const lastResult = results[results.length - 1];
				const chainOutput = getFinalOutput(lastResult.messages) || "(no output)";
				const chainFileSuffix = lastResult.outputFile ? `\n\n[Full output saved to: ${lastResult.outputFile}]` : "";
				return {
					content: [{ type: "text", text: chainOutput + chainFileSuffix }],
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
						effectiveCwd, agents, t.agent, t.task,
						undefined, signal,
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"), widget,
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
					effectiveCwd, agents, params.agent, params.task,
					undefined, signal, onUpdate, makeDetails("single"), widget,
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
				const output = getFinalOutput(result.messages) || "(no output)";
				const fileSuffix = result.outputFile ? `\n\n[Full output saved to: ${result.outputFile}]` : "";
				return {
					content: [{ type: "text", text: output + fileSuffix }],
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

	// ---------------------------------------------------------------------------
	// Agent TUI components
	// ---------------------------------------------------------------------------

	class AgentSelectorComponent extends Container implements Focusable {
		private searchInput: Input;
		private listContainer: Container;
		private allAgents: AgentConfig[];
		private filteredAgents: AgentConfig[];
		private selectedIndex = 0;
		private onSelectCallback: (agent: AgentConfig) => void;
		private onCancelCallback: () => void;
		private tui: TUI;
		private theme: ExtensionContext["theme"];
		private headerText: Text;
		private hintText: Text;
		private disabledCount = 0;
		public projectProviderDefault?: string;
		public projectModelDefault?: string;

		private _focused = false;
		get focused(): boolean {
			return this._focused;
		}
		set focused(value: boolean) {
			this._focused = value;
			this.searchInput.focused = value;
		}

		constructor(
			tui: TUI,
			theme: ExtensionContext["theme"],
			agents: AgentConfig[],
			disabledCount: number,
			onSelect: (agent: AgentConfig) => void,
			onCancel: () => void,
			private onQuickAction?: (agent: AgentConfig, action: "n" | "m" | "t" | "k" | "d" | "e") => void,
		) {
			super();
			this.tui = tui;
			this.theme = theme;
			this.allAgents = agents;
			this.filteredAgents = agents;
			this.disabledCount = disabledCount;
			this.onSelectCallback = onSelect;
			this.onCancelCallback = onCancel;

			this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			this.addChild(new Spacer(1));

			this.headerText = new Text("", 1, 0);
			this.addChild(this.headerText);
			this.addChild(new Spacer(1));

			this.searchInput = new Input();
			this.searchInput.onSubmit = () => {
				const selected = this.filteredAgents[this.selectedIndex];
				if (selected) this.onSelectCallback(selected);
			};
			this.addChild(this.searchInput);

			this.addChild(new Spacer(1));
			this.listContainer = new Container();
			this.addChild(this.listContainer);

			this.addChild(new Spacer(1));
			this.hintText = new Text("", 1, 0);
			this.addChild(this.hintText);
			this.addChild(new Spacer(1));
			this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			this.updateHeader();
			this.updateHints();
			this.applyFilter(this.searchInput.getValue());
		}

		setAgents(agents: AgentConfig[], disabledCount: number): void {
			this.allAgents = agents;
			this.disabledCount = disabledCount;
			this.updateHeader();
			this.applyFilter(this.searchInput.getValue());
			this.tui.requestRender();
		}

		getSelectedAgent(): AgentConfig | null {
			return this.filteredAgents[this.selectedIndex] ?? null;
		}

		private updateHeader(): void {
			const projectCount = this.allAgents.filter((a) => a.source === "project").length;
			const disabledHint = this.disabledCount > 0 ? `, ${this.disabledCount} disabled` : "";
			const title = `Agents (${projectCount} project, ${this.allAgents.length} total${disabledHint})`;
			this.headerText.setText(this.theme.fg("accent", this.theme.bold(title)));
		}

		private updateHints(): void {
			const disabledHint = this.disabledCount > 0
				? ` \u00b7 ${this.disabledCount} disabled (/agent enable)`
				: "";
			this.hintText.setText(
				this.theme.fg(
					"dim",
					`Type to search \u00b7 \u2191\u2193 select \u00b7 Enter actions \u00b7 n new \u00b7 Esc close${disabledHint}`,
				),
			);
		}

		private applyFilter(query: string): void {
			const trimmed = query.trim();
			if (!trimmed) {
				this.filteredAgents = this.allAgents;
			} else {
				const tokens = trimmed.split(/\s+/).filter(Boolean);
				if (tokens.length === 0) {
					this.filteredAgents = this.allAgents;
				} else {
					const matches: Array<{ agent: AgentConfig; score: number }> = [];
					for (const agent of this.allAgents) {
						const searchText = `${agent.name} ${agent.description} ${agent.source}`;
						let totalScore = 0;
						let matched = true;
						for (const token of tokens) {
							const result = fuzzyMatch(token, searchText);
							if (!result.matches) {
								matched = false;
								break;
							}
							totalScore += result.score;
						}
						if (matched) {
							matches.push({ agent, score: totalScore });
						}
					}
					this.filteredAgents = matches.sort((a, b) => a.score - b.score).map((m) => m.agent);
				}
			}
			this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredAgents.length - 1));
			this.updateList();
		}

		private updateList(): void {
			this.listContainer.clear();

			if (this.filteredAgents.length === 0) {
				this.listContainer.addChild(new Text(this.theme.fg("muted", "  No matching agents"), 0, 0));
				return;
			}

			const maxVisible = 10;
			const startIndex = Math.max(
				0,
				Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredAgents.length - maxVisible),
			);
			const endIndex = Math.min(startIndex + maxVisible, this.filteredAgents.length);

			for (let i = startIndex; i < endIndex; i++) {
				const agent = this.filteredAgents[i];
				if (!agent) continue;
				const isSelected = i === this.selectedIndex;
				const prefix = isSelected ? this.theme.fg("accent", "\u25b6 ") : "  ";

				const sourceLabels: Record<AgentConfig["source"], string> = {
					project: "[prj]",
					"package": "[pkg]",
					user: "[usr]",
					"pi-project": "[pi]",
				};
				const sourceLabel = sourceLabels[agent.source];
				const sourceColor = agent.source === "project" ? "accent" : "muted";

				const nameColor = isSelected ? "accent" : "text";
				const modelText = agent.model
					? this.theme.fg("dim", ` [${agent.model}]`)
					: this.projectModelDefault
						? this.theme.fg("dim", ` [default: ${this.projectModelDefault}]`)
						: this.theme.fg("dim", " [default]");
				const toolsText = agent.tools ? this.theme.fg("dim", ` {${agent.tools.length} tools}`) : "";
				const thinkingText = agent.thinking ? this.theme.fg("dim", " ~" + agent.thinking) : "";

				// Show provider: agent-specific in muted, inherited default in dim
				let providerText = "";
				if (agent.provider) {
					providerText = this.theme.fg("muted", ` @${agent.provider}`);
				} else if (this.projectProviderDefault) {
					providerText = this.theme.fg("dim", ` @${this.projectProviderDefault}`);
				}

				const line =
					prefix +
					this.theme.fg(sourceColor, sourceLabel) +
					" " +
					this.theme.fg(nameColor, agent.name) +
					modelText +
					providerText +
					toolsText +
					thinkingText;

				this.listContainer.addChild(new Text(line, 0, 0));
			}

			if (startIndex > 0 || endIndex < this.filteredAgents.length) {
				const scrollInfo = this.theme.fg(
					"dim",
					`  (${this.selectedIndex + 1}/${this.filteredAgents.length})`,
				);
				this.listContainer.addChild(new Text(scrollInfo, 0, 0));
			}
		}

		handleInput(keyData: string): void {
			if (matchesKey(keyData, Key.up)) {
				if (this.filteredAgents.length === 0) return;
				this.selectedIndex = this.selectedIndex === 0 ? this.filteredAgents.length - 1 : this.selectedIndex - 1;
				this.updateList();
				this.tui.requestRender();
				return;
			}
			if (matchesKey(keyData, Key.down)) {
				if (this.filteredAgents.length === 0) return;
				this.selectedIndex = this.selectedIndex === this.filteredAgents.length - 1 ? 0 : this.selectedIndex + 1;
				this.updateList();
				this.tui.requestRender();
				return;
			}
			if (matchesKey(keyData, Key.enter)) {
				const selected = this.filteredAgents[this.selectedIndex];
				if (selected) this.onSelectCallback(selected);
				return;
			}
			if (matchesKey(keyData, Key.escape) || matchesKey(keyData, Key.ctrl("c"))) {
				this.onCancelCallback();
				return;
			}

			// Quick action shortcuts - only 'n' for new (when search is empty)
			if (keyData === "n" && !this.searchInput.getValue()) {
				if (this.onQuickAction) this.onQuickAction(this.filteredAgents[this.selectedIndex], "n");
				return;
			}

			this.searchInput.handleInput(keyData);
			this.applyFilter(this.searchInput.getValue());
			this.tui.requestRender();
		}

		override invalidate(): void {
			super.invalidate();
			this.updateHeader();
			this.updateHints();
			this.updateList();
		}
	}

	class AgentActionMenuComponent extends Container {
		private selectList: SelectList;
		private onSelectCallback: (action: string) => void;
		private onCancelCallback: () => void;

		constructor(
			theme: ExtensionContext["theme"],
			agent: AgentConfig,
			onSelect: (action: string) => void,
			onCancel: () => void,
		) {
			super();
			this.onSelectCallback = onSelect;
			this.onCancelCallback = onCancel;

			const options: SelectItem[] = [
				...(isTmuxAvailable() ? [{ value: "edit", label: "edit", description: "Edit in vim (tmux)" }] : []),
				{ value: "model", label: "model", description: "Change model" },
				{ value: "provider", label: "provider", description: "Set provider" },
				{ value: "tools", label: "tools", description: "Configure tools" },
				{ value: "thinking", label: "thinking", description: "Set thinking level" },
				{ value: "copyPath", label: "copy path", description: "Copy file path to clipboard" },
				...(agent.source !== "project" 
					? [{ value: "disable", label: "disable", description: "Hide this agent from the project" }]
					: []),
				...(agent.source === "project" ? [{ value: "delete", label: "delete", description: "Delete project agent" }] : []),
			];

			this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			this.addChild(
				new Text(
					theme.fg("accent", theme.bold(`Actions for ${agent.name}`)),
				),
			);

			this.selectList = new SelectList(options, options.length, {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});

			this.selectList.onSelect = (item) => this.onSelectCallback(item.value);
			this.selectList.onCancel = () => this.onCancelCallback();

			this.addChild(this.selectList);
			this.addChild(new Text(theme.fg("dim", "Enter to confirm \u00b7 Esc back")));
			this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		}

		handleInput(keyData: string): void {
			this.selectList.handleInput(keyData);
		}

		override invalidate(): void {
			super.invalidate();
		}
	}

	class ModelPickerComponent extends Container {
		private selectList: SelectList;

		constructor(
			theme: ExtensionContext["theme"],
			models: Model[],
			currentModel: string | undefined,
			projectDefaultModel: string | undefined,
			onSelect: (modelId: string) => void,
			onCancel: () => void,
		) {
			super();

			// Group models by provider
			const grouped = new Map<string, Model[]>();
			for (const model of models) {
				const provider = model.provider || "other";
				if (!grouped.has(provider)) grouped.set(provider, []);
				grouped.get(provider)!.push(model);
			}

			// Build flat list with provider headers (non-selectable separators)
			const items: SelectItem[] = [
				{
					value: "__default_model",
					label: (currentModel ? "" : "✓ ") + "Use default model",
					description: projectDefaultModel
						? `Project default: ${projectDefaultModel}`
						: "Use pi's active default model",
				},
			];
			for (const [provider, providerModels] of grouped) {
				// Add provider header as separator
				items.push({ value: `__header_${provider}`, label: `--- ${provider} ---`, description: "" });
				// Add models
				for (const model of providerModels) {
					const isCurrentModel = model.id === currentModel;
					const label = (isCurrentModel ? "\u2713 " : "") + model.name;
					items.push({ value: model.id, label, description: model.id });
				}
			}

			this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			this.addChild(new Text(theme.fg("accent", theme.bold("Select model"))));

			this.selectList = new SelectList(items, Math.min(15, items.length), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});

			this.selectList.onSelect = (item) => {
				// Skip header items
				if (item.value.startsWith("__header_")) return;
				if (item.value === "__default_model") {
					onSelect("");
					return;
				}
				onSelect(item.value);
			};
			this.selectList.onCancel = onCancel;

			this.addChild(this.selectList);
			this.addChild(new Text(theme.fg("dim", "Enter to confirm \u00b7 Esc back")));
			this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		}

		handleInput(keyData: string): void {
			this.selectList.handleInput(keyData);
		}

		override invalidate(): void {
			super.invalidate();
		}
	}

	class ToolsPickerComponent extends Container {
		private knownTools = ["read", "write", "edit", "bash", "grep", "find", "ls"];
		private selectedTools: Set<string>;
		private selectedIndex = 0;
		private tui: TUI;
		private theme: ExtensionContext["theme"];
		private listContainer: Container;
		private onConfirmCallback: (tools: string[]) => void;
		private onCancelCallback: () => void;

		constructor(
			tui: TUI,
			theme: ExtensionContext["theme"],
			currentTools: string[] | undefined,
			onConfirm: (tools: string[]) => void,
			onCancel: () => void,
		) {
			super();
			this.tui = tui;
			this.theme = theme;
			this.selectedTools = new Set(currentTools ?? []);
			this.onConfirmCallback = onConfirm;
			this.onCancelCallback = onCancel;

			this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			this.addChild(new Text(theme.fg("accent", theme.bold("Configure tools (Space to toggle)"))));
			this.addChild(new Spacer(1));

			this.listContainer = new Container();
			this.addChild(this.listContainer);

			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("dim", "Space toggle \u00b7 Enter confirm \u00b7 Esc cancel")));
			this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			this.updateList();
		}

		private updateList(): void {
			this.listContainer.clear();

			for (let i = 0; i < this.knownTools.length; i++) {
				const tool = this.knownTools[i];
				const isSelected = i === this.selectedIndex;
				const isChecked = this.selectedTools.has(tool);
				const prefix = isSelected ? this.theme.fg("accent", "\u25b6 ") : "  ";
				const checkbox = isChecked ? "[x]" : "[ ]";
				const checkboxColor = isChecked ? "accent" : "muted";
				const textColor = isSelected ? "accent" : "text";

				const line = prefix + this.theme.fg(checkboxColor, checkbox) + " " + this.theme.fg(textColor, tool);
				this.listContainer.addChild(new Text(line, 0, 0));
			}
		}

		handleInput(keyData: string): void {
			if (matchesKey(keyData, Key.up)) {
				this.selectedIndex = this.selectedIndex === 0 ? this.knownTools.length - 1 : this.selectedIndex - 1;
				this.updateList();
				this.tui.requestRender();
				return;
			}
			if (matchesKey(keyData, Key.down)) {
				this.selectedIndex = this.selectedIndex === this.knownTools.length - 1 ? 0 : this.selectedIndex + 1;
				this.updateList();
				this.tui.requestRender();
				return;
			}
			if (keyData === " ") {
				const tool = this.knownTools[this.selectedIndex];
				if (this.selectedTools.has(tool)) {
					this.selectedTools.delete(tool);
				} else {
					this.selectedTools.add(tool);
				}
				this.updateList();
				this.tui.requestRender();
				return;
			}
			if (matchesKey(keyData, Key.enter)) {
				this.onConfirmCallback(Array.from(this.selectedTools));
				return;
			}
			if (matchesKey(keyData, Key.escape)) {
				this.onCancelCallback();
				return;
			}
		}

		override invalidate(): void {
			super.invalidate();
			this.updateList();
		}
	}

	class ThinkingPickerComponent extends Container {
		private selectList: SelectList;

		constructor(
			theme: ExtensionContext["theme"],
			currentThinking: string | undefined,
			onSelect: (thinking: string) => void,
			onCancel: () => void,
		) {
			super();

			const options: SelectItem[] = [
				{ value: "", label: (!currentThinking ? "\u2713 " : "") + "off", description: "No extended thinking" },
				{ value: "low", label: (currentThinking === "low" ? "\u2713 " : "") + "low", description: "Minimal thinking budget" },
				{ value: "medium", label: (currentThinking === "medium" ? "\u2713 " : "") + "medium", description: "Moderate thinking budget" },
				{ value: "high", label: (currentThinking === "high" ? "\u2713 " : "") + "high", description: "Extended thinking budget" },
			];

			this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			this.addChild(new Text(theme.fg("accent", theme.bold("Select thinking level"))));

			this.selectList = new SelectList(options, options.length, {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});

			this.selectList.onSelect = (item) => onSelect(item.value);
			this.selectList.onCancel = onCancel;

			this.addChild(this.selectList);
			this.addChild(new Text(theme.fg("dim", "Enter to confirm \u00b7 Esc back")));
			this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		}

		handleInput(keyData: string): void {
			this.selectList.handleInput(keyData);
		}

		override invalidate(): void {
			super.invalidate();
		}
	}

	class TemplatePickerComponent extends Container {
		private selectList: SelectList;

		constructor(
			theme: ExtensionContext["theme"],
			templates: AgentTemplate[],
			onSelect: (templatePath: string) => void,
			onCancel: () => void,
		) {
			super();

			const items: SelectItem[] = templates.map((t) => ({
				value: t.path,
				label: t.name,
				description: t.description,
			}));

			this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			this.addChild(new Text(theme.fg("accent", theme.bold("Select template"))));

			this.selectList = new SelectList(items, Math.min(10, items.length), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});

			this.selectList.onSelect = (item) => onSelect(item.value);
			this.selectList.onCancel = onCancel;

			this.addChild(this.selectList);
			this.addChild(new Text(theme.fg("dim", "Enter to confirm \u00b7 Esc back")));
			this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		}

		handleInput(keyData: string): void {
			this.selectList.handleInput(keyData);
		}

		override invalidate(): void {
			super.invalidate();
		}
	}

	class DeleteConfirmComponent extends Container {
		private selectList: SelectList;

		constructor(
			theme: ExtensionContext["theme"],
			agentName: string,
			onConfirm: () => void,
			onCancel: () => void,
		) {
			super();

			const options: SelectItem[] = [
				{ value: "cancel", label: "Cancel", description: "Keep the agent" },
				{ value: "delete", label: "Delete", description: "Permanently delete" },
			];

			this.addChild(new DynamicBorder((s: string) => theme.fg("error", s)));
			this.addChild(new Text(theme.fg("error", theme.bold(`Delete ${agentName}?`))));
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("warning", "This will permanently delete the project agent file.")));
			this.addChild(new Spacer(1));

			this.selectList = new SelectList(options, options.length, {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});

			this.selectList.onSelect = (item) => {
				if (item.value === "delete") onConfirm();
				else onCancel();
			};
			this.selectList.onCancel = onCancel;

			this.addChild(this.selectList);
			this.addChild(new Text(theme.fg("dim", "Enter to confirm · Esc cancel")));
			this.addChild(new DynamicBorder((s: string) => theme.fg("error", s)));
		}

		handleInput(keyData: string): void {
			this.selectList.handleInput(keyData);
		}

		override invalidate(): void {
			super.invalidate();
		}
	}

	class NameInputComponent extends Container {
		private input: Input;
		private tui: TUI;
		private onCancelCallback: () => void;
		private ctx: ExtensionContext;

		constructor(
			tui: TUI,
			theme: ExtensionContext["theme"],
			defaultName: string,
			onConfirm: (name: string) => void,
			onCancel: () => void,
			ctx: ExtensionContext,
		) {
			super();
			this.tui = tui;
			this.ctx = ctx;
			this.onCancelCallback = onCancel;

			this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			this.addChild(new Text(theme.fg("accent", theme.bold("Enter agent name"))));
			this.addChild(new Spacer(1));

			this.input = new Input();
			this.input.setValue(defaultName);
			this.input.onSubmit = () => {
				const name = this.input.getValue().trim();
				if (!name) return;
				
				// Validate agent name: only alphanumeric, hyphens, underscores
				const normalized = name.toLowerCase();
				if (!/^[a-z0-9_-]+$/.test(normalized)) {
					this.ctx.ui.notify(
						"Invalid agent name. Use only letters, numbers, hyphens, and underscores.",
						"error"
					);
					return;
				}
				
				onConfirm(normalized);
			};
			this.addChild(this.input);

			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("dim", "Enter to confirm \u00b7 Esc cancel")));
			this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		}

		get focused(): boolean {
			return this.input.focused;
		}

		set focused(value: boolean) {
			this.input.focused = value;
		}

		handleInput(keyData: string): void {
			if (matchesKey(keyData, Key.escape)) {
				this.onCancelCallback();
				return;
			}
			this.input.handleInput(keyData);
		}

		override invalidate(): void {
			super.invalidate();
		}
	}

	// ---------------------------------------------------------------------------
	// /agent command — manage per-project agent configurations
	// ---------------------------------------------------------------------------

	pi.registerCommand("agent", {
		description: "Manage per-project agent configurations",
		handler: async (args, ctx) => {
			const cwd = ctx.cwd;
			const sub = (args || "").trim();

			// Handle /agent enable subcommand
			if (sub === "enable") {
				if (!ctx.hasUI) {
					ctx.ui.notify("/agent enable requires interactive mode", "error");
					return;
				}
				const disabled = loadDisabledAgents(cwd);
				if (disabled.size === 0) {
					ctx.ui.notify("No disabled agents", "info");
					return;
				}
				const choice = await ctx.ui.select(
					"Enable agent",
					[...disabled].sort()
				);
				if (choice) {
					enableAgent(cwd, choice);
					ctx.ui.notify(`Enabled agent ${choice}`, "info");
				}
				return;
			}

			if (!ctx.hasUI) {
				ctx.ui.notify("/agent requires interactive mode", "error");
				return;
			}
			let rootTui: TUI | null = null;

			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				rootTui = tui;
				let selector: AgentSelectorComponent | null = null;
				let actionMenu: AgentActionMenuComponent | null = null;
				let activeComponent:
					| {
							render: (width: number) => string[];
							invalidate: () => void;
							handleInput?: (data: string) => void;
							focused?: boolean;
					  }
					| null = null;
				let wrapperFocused = false;

				const setActiveComponent = (
					component:
						| {
								render: (width: number) => string[];
								invalidate: () => void;
								handleInput?: (data: string) => void;
								focused?: boolean;
						  }
						| null,
				) => {
					if (activeComponent && "focused" in activeComponent) {
						activeComponent.focused = false;
					}
					activeComponent = component;
					if (activeComponent && "focused" in activeComponent) {
						activeComponent.focused = wrapperFocused;
					}
					tui.requestRender();
				};

				const refreshAgents = () => {
					const { agents } = discoverAgents(cwd);
					const disabledCount = loadDisabledAgents(cwd).size;
					selector?.setAgents(agents, disabledCount);
				};

				const copyAgentPathToClipboard = (agent: AgentConfig) => {
					const absolutePath = path.resolve(agent.filePath);
					try {
						copyToClipboard(absolutePath);
						ctx.ui.notify(`Copied ${absolutePath} to clipboard`, "info");
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						ctx.ui.notify(message, "error");
					}
				};

				const ensureProjectAgent = (agent: AgentConfig): AgentConfig => {
					if (agent.source === "project") return agent;
					const overridden = createAgentOverride(cwd, agent);
					ctx.ui.notify(`Created project override for ${agent.name}`, "info");
					refreshAgents();
					return overridden;
				};

				const handleAction = async (agent: AgentConfig, action: string) => {
					if (action === "disable") {
						disableAgent(cwd, agent.name);
						refreshAgents();
						if (ctx.hasUI) ctx.ui.notify(`Disabled agent ${agent.name}`, "info");
						setActiveComponent(selector);
						return;
					}

					if (action === "edit") {
						const targetAgent = ensureProjectAgent(agent);
						const filePath = path.resolve(targetAgent.filePath);
						openEditorPane(filePath);
						setActiveComponent(selector);
						return;
					}

					if (action === "model") {
						const targetAgent = ensureProjectAgent(agent);
						const models = ctx.modelRegistry.getAvailable();
						const projectDefaults = getProjectProviderDefaults(cwd);
						const modelPicker = new ModelPickerComponent(
							theme,
							models,
							targetAgent.model,
							projectDefaults.model,
							(modelId) => {
								updateAgentFrontmatter(targetAgent, { model: modelId });
								if (modelId) {
									ctx.ui.notify(`Updated model for ${targetAgent.name}`, "info");
								} else {
									ctx.ui.notify(`Cleared model for ${targetAgent.name} (using default)`, "info");
								}
								refreshAgents();
								setActiveComponent(selector);
							},
							() => setActiveComponent(actionMenu),
						);
						setActiveComponent(modelPicker);
						return;
					}

					if (action === "tools") {
						const targetAgent = ensureProjectAgent(agent);
						const toolsPicker = new ToolsPickerComponent(
							tui,
							theme,
							targetAgent.tools,
							(tools) => {
								updateAgentFrontmatter(targetAgent, { tools });
								ctx.ui.notify(`Updated tools for ${targetAgent.name}`, "info");
								refreshAgents();
								setActiveComponent(selector);
							},
							() => setActiveComponent(actionMenu),
						);
						setActiveComponent(toolsPicker);
						return;
					}

					if (action === "thinking") {
						const targetAgent = ensureProjectAgent(agent);
						const thinkingPicker = new ThinkingPickerComponent(
							theme,
							targetAgent.thinking,
							(thinking) => {
								updateAgentFrontmatter(targetAgent, { thinking });
								ctx.ui.notify(`Updated thinking for ${targetAgent.name}`, "info");
								refreshAgents();
								setActiveComponent(selector);
							},
							() => setActiveComponent(actionMenu),
						);
						setActiveComponent(thinkingPicker);
						return;
					}

					if (action === "provider") {
						const targetAgent = ensureProjectAgent(agent);
						// Read available providers from .cortex/providers.json
						const providerDefaults = getProjectProviderDefaults(cwd);
						let providerAccounts: string[] = [];
						try {
							const globalPath = path.join(os.homedir(), ".cortex", "providers.json");
							const projectPath = path.join(cwd, ".cortex", "providers.json");
							for (const p of [globalPath, projectPath]) {
								if (fs.existsSync(p)) {
									const cfg = JSON.parse(fs.readFileSync(p, "utf-8"));
									if (cfg.accounts) providerAccounts.push(...Object.keys(cfg.accounts));
								}
							}
						} catch { /* ignore */ }
						providerAccounts = [...new Set(providerAccounts)];

						const options: string[] = [
							`Use project default${providerDefaults.agents ? ` (${providerDefaults.agents})` : ""}`,
							...providerAccounts,
						];

						const choice = await ctx.ui.select(
							`Provider for ${targetAgent.name}${targetAgent.provider ? ` (current: ${targetAgent.provider})` : ""}`,
							options,
						);

						if (choice != null) {
							if (choice.startsWith("Use project default")) {
								updateAgentFrontmatter(targetAgent, { provider: "" });
								ctx.ui.notify(`Cleared provider for ${targetAgent.name} (using project default)`, "info");
							} else {
								updateAgentFrontmatter(targetAgent, { provider: choice });
								ctx.ui.notify(`Set provider for ${targetAgent.name} to '${choice}'`, "info");
							}
							refreshAgents();
						}
						setActiveComponent(selector);
						return;
					}

					if (action === "copyPath") {
						copyAgentPathToClipboard(agent);
						setActiveComponent(selector);
						return;
					}

					if (action === "delete") {
						if (agent.source !== "project") {
							ctx.ui.notify("Can only delete project agents", "warning");
							setActiveComponent(selector);
							return;
						}
						
						// Show confirmation component
						const confirmComponent = new DeleteConfirmComponent(
							theme,
							agent.name,
							() => {
								try {
									deleteProjectAgent(cwd, agent.name);
									ctx.ui.notify(`Deleted ${agent.name}`, "info");
									refreshAgents();
									setActiveComponent(selector);
								} catch (error) {
									const message = error instanceof Error ? error.message : String(error);
									ctx.ui.notify(message, "error");
									setActiveComponent(selector);
								}
							},
							() => setActiveComponent(actionMenu),
						);
						setActiveComponent(confirmComponent);
						return;
					}

					setActiveComponent(selector);
				};

				const handleQuickAction = (agent: AgentConfig | null, action: "n" | "m" | "t" | "k" | "d" | "e") => {
					if (action === "n") {
						// New agent flow: template picker -> name input -> create -> (optionally edit)
						const templates = getAvailableTemplates();
						if (templates.length === 0) {
							ctx.ui.notify("No templates found", "warning");
							return;
						}

						const templatePicker = new TemplatePickerComponent(
							theme,
							templates,
							(templatePath) => {
								const nameInput = new NameInputComponent(
									tui,
									theme,
									"my-agent",
									(name) => {
										try {
											const newAgent = createAgentFromTemplate(cwd, name, templatePath);
											ctx.ui.notify(`Created ${name}`, "info");
											refreshAgents();

											if (isTmuxAvailable()) {
												const filePath = path.resolve(newAgent.filePath);
												openEditorPane(filePath);
											}

											setActiveComponent(selector);
										} catch (error) {
											const message = error instanceof Error ? error.message : String(error);
											ctx.ui.notify(message, "error");
											setActiveComponent(selector);
										}
									},
									() => setActiveComponent(selector),
									ctx,
								);
								setActiveComponent(nameInput);
							},
							() => setActiveComponent(selector),
						);
						setActiveComponent(templatePicker);
						return;
					}

					if (!agent) return;

					// Direct shortcuts for m, t, k
					if (action === "m") {
						void handleAction(agent, "model");
						return;
					}
					if (action === "t") {
						void handleAction(agent, "tools");
						return;
					}
					if (action === "k") {
						void handleAction(agent, "thinking");
						return;
					}
					if (action === "d") {
						void handleAction(agent, "delete");
						return;
					}
					if (action === "e") {
						void handleAction(agent, "edit");
						return;
					}
				};

				const showActionMenu = (agent: AgentConfig) => {
					actionMenu = new AgentActionMenuComponent(
						theme,
						agent,
						(action) => {
							void handleAction(agent, action);
						},
						() => setActiveComponent(selector),
					);
					setActiveComponent(actionMenu);
				};

				const { agents } = discoverAgents(cwd);
				const disabledCount = loadDisabledAgents(cwd).size;
				selector = new AgentSelectorComponent(
					tui,
					theme,
					agents,
					disabledCount,
					(agent) => {
						showActionMenu(agent);
					},
					() => done(),
					handleQuickAction,
				);
				const projectDefaults = getProjectProviderDefaults(cwd);
				selector.projectProviderDefault = projectDefaults.agents;
				selector.projectModelDefault = projectDefaults.model;

				setActiveComponent(selector);

				const rootComponent = {
					get focused() {
						return wrapperFocused;
					},
					set focused(value: boolean) {
						wrapperFocused = value;
						if (activeComponent && "focused" in activeComponent) {
							activeComponent.focused = value;
						}
					},
					render(width: number) {
						return activeComponent ? activeComponent.render(width) : [];
					},
					invalidate() {
						activeComponent?.invalidate();
					},
					handleInput(data: string) {
						activeComponent?.handleInput?.(data);
					},
				};

				return rootComponent;
			});
		},
	});
}
