/**
 * TTSR Extension - Time Traveling Streamed Rules
 *
 * Zero context-cost rules that inject themselves only when the model starts
 * generating matching output. Rules define regex triggers that watch the
 * model's output stream. When a pattern matches, the stream aborts, the
 * rule injects as a system reminder, and the request retries.
 *
 * Each rule fires only once per session, preventing loops.
 *
 * Rule files: .cortex/rules/ (project) and ~/.cortex/rules/ (user-global)
 * Format: Markdown with YAML frontmatter (name, description, ttsrTrigger)
 *
 * Commands:
 *   /rules        - List all registered TTSR rules
 *   /rules status - Show which rules have fired this session
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TtsrRule {
	name: string;
	description: string;
	trigger: RegExp;
	triggerSource: string; // original regex string for display
	content: string; // rule body to inject on match
	source: "project" | "user";
	filePath: string;
}

// ---------------------------------------------------------------------------
// TtsrManager
// ---------------------------------------------------------------------------

class TtsrManager {
	private rules: TtsrRule[] = [];
	private firedRules = new Set<string>();
	private buffer = "";
	private injectedRules: TtsrRule[] = []; // rules waiting to be injected into context

	addRule(rule: TtsrRule): boolean {
		// Deduplicate by name (first registered wins — project loaded after user, so project wins)
		if (this.rules.some((r) => r.name === rule.name)) {
			return false;
		}
		this.rules.push(rule);
		return true;
	}

	getRules(): readonly TtsrRule[] {
		return this.rules;
	}

	getFiredRules(): ReadonlySet<string> {
		return this.firedRules;
	}

	getInjectedRules(): TtsrRule[] {
		return this.injectedRules;
	}

	hasRules(): boolean {
		return this.rules.length > 0;
	}

	resetBuffer(): void {
		this.buffer = "";
	}

	/**
	 * Append streaming delta text and check for matches.
	 * Returns matched rules that haven't fired yet this session.
	 */
	appendAndCheck(delta: string): TtsrRule[] {
		this.buffer += delta;

		const matched: TtsrRule[] = [];
		for (const rule of this.rules) {
			if (this.firedRules.has(rule.name)) continue;
			if (rule.trigger.test(this.buffer)) {
				matched.push(rule);
			}
		}
		return matched;
	}

	/**
	 * Mark rules as fired and queue them for injection.
	 */
	markFired(rules: TtsrRule[]): void {
		for (const rule of rules) {
			this.firedRules.add(rule.name);
			if (!this.injectedRules.some((r) => r.name === rule.name)) {
				this.injectedRules.push(rule);
			}
		}
	}

	/**
	 * Reset for a new session (keeps rules, clears fired state).
	 */
	resetSession(): void {
		this.firedRules.clear();
		this.injectedRules = [];
		this.buffer = "";
	}

	/**
	 * Build the system prompt addition for all injected rules.
	 */
	buildInjectionPrompt(): string | null {
		if (this.injectedRules.length === 0) return null;

		const parts = this.injectedRules.map(
			(r) => `## Rule: ${r.name}\n${r.content}`,
		);
		return [
			"<ttsr-rules>",
			"The following rules were triggered by your output. Follow them for the remainder of this session.",
			"",
			...parts,
			"</ttsr-rules>",
		].join("\n");
	}
}

// ---------------------------------------------------------------------------
// Rule discovery
// ---------------------------------------------------------------------------

function loadRulesFromDir(dir: string, source: TtsrRule["source"]): TtsrRule[] {
	const rules: TtsrRule[] = [];
	if (!fs.existsSync(dir)) return rules;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return rules;
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
		if (!frontmatter.name || !frontmatter.ttsrTrigger) continue;

		// Validate regex
		let trigger: RegExp;
		try {
			trigger = new RegExp(frontmatter.ttsrTrigger);
		} catch {
			// Invalid regex — skip this rule
			continue;
		}

		rules.push({
			name: frontmatter.name,
			description: frontmatter.description || "",
			trigger,
			triggerSource: frontmatter.ttsrTrigger,
			content: body.trim(),
			source,
			filePath,
		});
	}

	return rules;
}

function discoverRules(cwd: string): TtsrRule[] {
	const ruleMap = new Map<string, TtsrRule>();

	// 1. User-global rules (~/.cortex/rules/) — lower priority
	const home = process.env.HOME || process.env.USERPROFILE || "";
	if (home) {
		const userDir = path.join(home, ".cortex", "rules");
		for (const rule of loadRulesFromDir(userDir, "user")) {
			ruleMap.set(rule.name, rule);
		}
	}

	// 2. Project rules (.cortex/rules/) — higher priority, overrides user
	const projectDir = path.join(cwd, ".cortex", "rules");
	for (const rule of loadRulesFromDir(projectDir, "project")) {
		ruleMap.set(rule.name, rule);
	}

	return Array.from(ruleMap.values());
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const manager = new TtsrManager();
	let abortPending = false;

	// Load rules on session start
	pi.on("session_start", async (_event, ctx) => {
		manager.resetSession();

		const rules = discoverRules(ctx.cwd);
		for (const rule of rules) {
			manager.addRule(rule);
		}

		if (manager.hasRules()) {
			const count = manager.getRules().length;
			ctx.ui.setStatus("ttsr", `TTSR: ${count} rule${count !== 1 ? "s" : ""}`);
		}
	});

	// Reset buffer at the start of each turn
	pi.on("turn_start", async () => {
		manager.resetBuffer();
		abortPending = false;
	});

	// Monitor streaming output for rule triggers
	pi.on("message_update", async (event, ctx) => {
		if (!manager.hasRules() || abortPending) return;

		const streamEvent = (event as any).assistantMessageEvent;
		if (!streamEvent) return;

		// Collect text from text_delta and toolcall_delta events
		let delta = "";
		if (streamEvent.type === "text_delta" && typeof streamEvent.delta === "string") {
			delta = streamEvent.delta;
		} else if (streamEvent.type === "toolcall_delta" && typeof streamEvent.delta === "string") {
			delta = streamEvent.delta;
		}

		if (!delta) return;

		const matched = manager.appendAndCheck(delta);
		if (matched.length === 0) return;

		// Rules matched — mark as fired
		manager.markFired(matched);
		abortPending = true;

		const names = matched.map((r) => r.name).join(", ");
		ctx.ui.notify(`TTSR triggered: ${names}`, "info");

		// Update status to show fired count
		const total = manager.getRules().length;
		const fired = manager.getFiredRules().size;
		ctx.ui.setStatus("ttsr", `TTSR: ${fired}/${total} fired`);

		// Abort the current generation
		ctx.abort();

		// Send a steering message to retry with the rules now injected
		// The rules will be added to context via the 'context' event below
		pi.sendMessage(
			{
				customType: "ttsr-retry",
				content: `[TTSR] Rules triggered: ${names}. Retrying with corrective guidance injected.`,
				display: false,
			},
			{ deliverAs: "steer", triggerTurn: true },
		);
	});

	// Inject fired rules into the context for every subsequent LLM call
	pi.on("context", async (event) => {
		const injection = manager.buildInjectionPrompt();
		if (!injection) return;

		// Inject as a system message near the end of the conversation
		// so the model sees the rules as recent guidance
		const messages = [...event.messages];
		messages.push({
			role: "user" as const,
			content: [{ type: "text" as const, text: injection }],
		});

		return { messages };
	});

	// /rules command
	pi.registerCommand("rules", {
		description: "List TTSR rules and their status",
		async handler(args, ctx) {
			const subcommand = args[0];
			const rules = manager.getRules();

			if (rules.length === 0) {
				ctx.ui.notify(
					"No TTSR rules found. Add .md files to .cortex/rules/ or ~/.cortex/rules/",
					"info",
				);
				return;
			}

			if (subcommand === "status") {
				const fired = manager.getFiredRules();
				const lines: string[] = [`TTSR Status: ${fired.size}/${rules.length} rules fired\n`];

				for (const rule of rules) {
					const status = fired.has(rule.name) ? "[FIRED]" : "[ready]";
					lines.push(`  ${status} ${rule.name}`);
					if (rule.description) {
						lines.push(`         ${rule.description}`);
					}
				}

				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			// Default: list all rules
			const lines: string[] = [`TTSR Rules: ${rules.length} loaded\n`];
			for (const rule of rules) {
				const fired = manager.getFiredRules().has(rule.name);
				const status = fired ? " [FIRED]" : "";
				lines.push(`  ${rule.name}${status} (${rule.source})`);
				if (rule.description) {
					lines.push(`    ${rule.description}`);
				}
				lines.push(`    trigger: /${rule.triggerSource}/`);
				lines.push(`    file: ${rule.filePath}`);
				lines.push("");
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

}
