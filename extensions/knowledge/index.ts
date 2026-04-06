/**
 * Knowledge Extension - Autonomous Long-Term Memory
 *
 * Extracts durable knowledge from past sessions and injects a compact
 * summary into new sessions. Unlike the memory extension (which preserves
 * compaction state), this builds long-term project knowledge across sessions.
 *
 * Two-phase pipeline:
 *   Phase 1: Per-session extraction (technical decisions, patterns, pitfalls)
 *   Phase 2: Cross-session consolidation into KNOWLEDGE.md + summary
 *
 * Storage: .cortex/knowledge/
 * Config: .cortex/config.json { "knowledge": { "enabled": true } }
 *
 * Commands:
 *   /knowledge          - Show current knowledge summary
 *   /knowledge status   - Show extraction stats
 *   /knowledge rebuild  - Force rebuild from all sessions
 *   /knowledge clear    - Delete all knowledge data
 */

import { execSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface KnowledgeConfig {
	enabled: boolean;
	maxSessionAgeDays: number;
	minSessionAgeHours: number;
	maxSummaryChars: number;
}

const DEFAULT_CONFIG: KnowledgeConfig = {
	enabled: false,
	maxSessionAgeDays: 30,
	minSessionAgeHours: 1,
	maxSummaryChars: 4000,
};

function loadConfig(cwd: string): KnowledgeConfig {
	try {
		const configPath = path.join(cwd, ".cortex", "config.json");
		if (!fs.existsSync(configPath)) return DEFAULT_CONFIG;
		const content = fs.readFileSync(configPath, "utf-8");
		const config = JSON.parse(content);
		const knowledge = config.knowledge ?? {};
		return {
			enabled: knowledge.enabled ?? DEFAULT_CONFIG.enabled,
			maxSessionAgeDays: knowledge.maxSessionAgeDays ?? DEFAULT_CONFIG.maxSessionAgeDays,
			minSessionAgeHours: knowledge.minSessionAgeHours ?? DEFAULT_CONFIG.minSessionAgeHours,
			maxSummaryChars: knowledge.maxSummaryChars ?? DEFAULT_CONFIG.maxSummaryChars,
		};
	} catch {
		return DEFAULT_CONFIG;
	}
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function getKnowledgeDir(cwd: string): string {
	return path.join(cwd, ".cortex", "knowledge");
}

function ensureKnowledgeDir(cwd: string): string {
	const dir = getKnowledgeDir(cwd);
	fs.mkdirSync(dir, { recursive: true });
	fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
	return dir;
}

function readSummary(cwd: string): string | null {
	try {
		const summaryPath = path.join(getKnowledgeDir(cwd), "summary.md");
		if (!fs.existsSync(summaryPath)) return null;
		return fs.readFileSync(summaryPath, "utf-8");
	} catch {
		return null;
	}
}

function readKnowledge(cwd: string): string | null {
	try {
		const knowledgePath = path.join(getKnowledgeDir(cwd), "KNOWLEDGE.md");
		if (!fs.existsSync(knowledgePath)) return null;
		return fs.readFileSync(knowledgePath, "utf-8");
	} catch {
		return null;
	}
}

interface SessionExtraction {
	sessionId: string;
	extractedAt: string;
	synopsis: string;
	rawMemory: string;
}

function getSessionExtractionPath(cwd: string, sessionId: string): string {
	return path.join(getKnowledgeDir(cwd), "sessions", `${sessionId}.json`);
}

function hasSessionExtraction(cwd: string, sessionId: string): boolean {
	return fs.existsSync(getSessionExtractionPath(cwd, sessionId));
}

function writeSessionExtraction(cwd: string, extraction: SessionExtraction): void {
	ensureKnowledgeDir(cwd);
	const extractionPath = getSessionExtractionPath(cwd, extraction.sessionId);
	fs.writeFileSync(extractionPath, JSON.stringify(extraction, null, 2), "utf-8");
}

function listSessionExtractions(cwd: string): SessionExtraction[] {
	const sessionsDir = path.join(getKnowledgeDir(cwd), "sessions");
	if (!fs.existsSync(sessionsDir)) return [];

	const extractions: SessionExtraction[] = [];
	for (const file of fs.readdirSync(sessionsDir)) {
		if (!file.endsWith(".json")) continue;
		try {
			const content = fs.readFileSync(path.join(sessionsDir, file), "utf-8");
			extractions.push(JSON.parse(content));
		} catch {
			continue;
		}
	}
	return extractions;
}

function clearKnowledge(cwd: string): void {
	const dir = getKnowledgeDir(cwd);
	if (fs.existsSync(dir)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// Lease (prevent concurrent rebuilds)
// ---------------------------------------------------------------------------

function acquireLease(cwd: string): boolean {
	const leasePath = path.join(getKnowledgeDir(cwd), ".lease");
	ensureKnowledgeDir(cwd);

	if (fs.existsSync(leasePath)) {
		try {
			const content = fs.readFileSync(leasePath, "utf-8");
			const lease = JSON.parse(content);
			// Stale if older than 10 minutes
			if (Date.now() - lease.timestamp < 10 * 60 * 1000) {
				return false;
			}
		} catch { /* ignore */ }
	}

	fs.writeFileSync(leasePath, JSON.stringify({ pid: process.pid, timestamp: Date.now() }), "utf-8");
	return true;
}

function releaseLease(cwd: string): void {
	const leasePath = path.join(getKnowledgeDir(cwd), ".lease");
	try { fs.unlinkSync(leasePath); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Session reading
// ---------------------------------------------------------------------------

function getSessionMessages(sessionPath: string): string {
	try {
		const content = fs.readFileSync(sessionPath, "utf-8");
		const lines = content.split("\n").filter(Boolean);
		const messages: string[] = [];

		for (const line of lines) {
			try {
				const entry = JSON.parse(line);
				if (entry.type !== "message") continue;
				const msg = entry.message;
				if (!msg) continue;

				if (msg.role === "user") {
					const text = typeof msg.content === "string"
						? msg.content
						: (msg.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
					if (text) messages.push(`USER: ${text.slice(0, 500)}`);
				} else if (msg.role === "assistant") {
					const text = (msg.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
					if (text) messages.push(`ASSISTANT: ${text.slice(0, 1000)}`);
				}
			} catch { /* skip malformed lines */ }
		}

		// Cap at ~20k chars to fit in context
		let total = "";
		for (const m of messages) {
			if (total.length + m.length > 20000) break;
			total += m + "\n\n";
		}
		return total;
	} catch {
		return "";
	}
}

// ---------------------------------------------------------------------------
// Extraction & Consolidation (via pi subprocess)
// ---------------------------------------------------------------------------

function runExtraction(cwd: string, sessionContent: string): { synopsis: string; rawMemory: string } | null {
	const prompt = [
		"You are a knowledge extraction assistant. Read the following session transcript and extract durable, reusable knowledge.",
		"",
		"Focus on:",
		"- Technical decisions made and their rationale",
		"- Constraints discovered (API limitations, library quirks, etc.)",
		"- Resolved failures and their root causes",
		"- Recurring workflows or patterns",
		"- Architecture or design decisions",
		"",
		"Ignore:",
		"- Temporary debugging steps that led nowhere",
		"- File contents that were just read",
		"- Routine code changes without broader lessons",
		"",
		"Output format:",
		"SYNOPSIS: One sentence summary of what this session accomplished.",
		"",
		"KNOWLEDGE:",
		"- Bullet points of durable knowledge extracted",
		"",
		"---SESSION TRANSCRIPT---",
		sessionContent,
	].join("\n");

	try {
		const result = spawnSync(process.execPath, [process.argv[1], "--mode", "text", "-p", "--no-session", prompt], {
			cwd,
			encoding: "utf-8",
			timeout: 120_000,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, PI_SKIP_VERSION_CHECK: "1" },
		});

		if (result.status !== 0 || !result.stdout) return null;

		const output = result.stdout.trim();
		const synopsisMatch = output.match(/SYNOPSIS:\s*(.+?)(?:\n|$)/);
		const knowledgeMatch = output.match(/KNOWLEDGE:\s*([\s\S]+)/);

		return {
			synopsis: synopsisMatch?.[1]?.trim() ?? "Session processed",
			rawMemory: knowledgeMatch?.[1]?.trim() ?? output,
		};
	} catch {
		return null;
	}
}

function runConsolidation(cwd: string, extractions: SessionExtraction[], config: KnowledgeConfig): boolean {
	const extractionText = extractions.map((e) => {
		return `## Session: ${e.sessionId}\nSynopsis: ${e.synopsis}\n\n${e.rawMemory}`;
	}).join("\n\n---\n\n");

	const prompt = [
		"You are a knowledge consolidation assistant. Combine the following per-session knowledge extractions into a coherent project knowledge document.",
		"",
		"Produce TWO sections:",
		"",
		"SUMMARY:",
		`A compact summary (max ${config.maxSummaryChars} chars) of the most important project knowledge. This will be injected into new sessions as context. Focus on actionable guidance, not history.`,
		"",
		"KNOWLEDGE:",
		"A curated, deduplicated knowledge document organized by topic. Remove redundancy, merge related items, and drop stale or contradictory information.",
		"",
		"---EXTRACTIONS---",
		extractionText,
	].join("\n");

	try {
		const result = spawnSync(process.execPath, [process.argv[1], "--mode", "text", "-p", "--no-session", prompt], {
			cwd,
			encoding: "utf-8",
			timeout: 180_000,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, PI_SKIP_VERSION_CHECK: "1" },
		});

		if (result.status !== 0 || !result.stdout) return false;

		const output = result.stdout.trim();
		const summaryMatch = output.match(/SUMMARY:\s*([\s\S]+?)(?=\nKNOWLEDGE:)/);
		const knowledgeMatch = output.match(/KNOWLEDGE:\s*([\s\S]+)/);

		const dir = ensureKnowledgeDir(cwd);
		const summary = summaryMatch?.[1]?.trim() ?? output.slice(0, config.maxSummaryChars);
		const knowledge = knowledgeMatch?.[1]?.trim() ?? output;

		fs.writeFileSync(path.join(dir, "summary.md"), summary, "utf-8");
		fs.writeFileSync(path.join(dir, "KNOWLEDGE.md"), knowledge, "utf-8");
		fs.writeFileSync(path.join(dir, "last_consolidated.json"), JSON.stringify({
			timestamp: new Date().toISOString(),
			sessionCount: extractions.length,
		}), "utf-8");

		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

async function runPipeline(cwd: string, config: KnowledgeConfig, notify?: (msg: string) => void): Promise<{ extracted: number; consolidated: boolean }> {
	if (!acquireLease(cwd)) {
		notify?.("Knowledge rebuild already in progress.");
		return { extracted: 0, consolidated: false };
	}

	try {
		const sessions = await SessionManager.list(cwd);
		const now = Date.now();
		const minAge = config.minSessionAgeHours * 60 * 60 * 1000;
		const maxAge = config.maxSessionAgeDays * 24 * 60 * 60 * 1000;

		let extracted = 0;

		for (const session of sessions) {
			// Skip already extracted
			if (hasSessionExtraction(cwd, session.id)) continue;

			// Skip too recent or too old
			const age = now - session.modified.getTime();
			if (age < minAge || age > maxAge) continue;

			notify?.(`Extracting knowledge from session ${session.id.slice(0, 8)}...`);

			// Skip trivial sessions (fewer than 4 messages)
			if (session.messageCount < 4) continue;

			const messages = getSessionMessages(session.path);
			if (!messages || messages.length < 100) continue;

			const result = runExtraction(cwd, messages);
			if (!result) continue;

			writeSessionExtraction(cwd, {
				sessionId: session.id,
				extractedAt: new Date().toISOString(),
				synopsis: result.synopsis,
				rawMemory: result.rawMemory,
			});
			extracted++;
		}

		// Consolidation
		const allExtractions = listSessionExtractions(cwd);
		let consolidated = false;
		if (allExtractions.length > 0) {
			notify?.(`Consolidating ${allExtractions.length} session(s)...`);
			consolidated = runConsolidation(cwd, allExtractions, config);
		}

		return { extracted, consolidated };
	} finally {
		releaseLease(cwd);
	}
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// Inject knowledge summary into new sessions
	pi.on("before_agent_start", async (event, ctx) => {
		const config = loadConfig(ctx.cwd);
		if (!config.enabled) return;

		const summary = readSummary(ctx.cwd);
		if (!summary) return;

		const injection = [
			"<knowledge-guidance>",
			"The following is project knowledge extracted from past sessions.",
			"Treat it as heuristic context -- useful for process and prior decisions, not authoritative on current repo state.",
			"Prefer repo state and user instructions when they conflict with this knowledge.",
			"",
			summary,
			"</knowledge-guidance>",
		].join("\n");

		return {
			systemPrompt: event.systemPrompt + "\n\n" + injection,
		};
	});

	// Background extraction on session start (non-blocking)
	pi.on("session_start", async (event, ctx) => {
		const config = loadConfig(ctx.cwd);
		if (!config.enabled) return;

		// Only run on startup, not on reload/fork
		if (event.reason !== "startup" && event.reason !== "new") return;

		// Run extraction in background (don't block session start)
		setTimeout(async () => {
			try {
				const result = await runPipeline(ctx.cwd, config);
				if (result.extracted > 0 && ctx.hasUI) {
					ctx.ui.setStatus("knowledge", `Knowledge: ${result.extracted} new`);
					setTimeout(() => ctx.ui.setStatus("knowledge", undefined), 5000);
				}
			} catch {
				// Silently fail -- knowledge is non-critical
			}
		}, 5000); // Delay 5s to not compete with session initialization
	});

	// /knowledge command
	pi.registerCommand("knowledge", {
		description: "View or manage project knowledge",
		async handler(args, ctx) {
			const sub = args[0];
			const config = loadConfig(ctx.cwd);

			if (sub === "status") {
				const extractions = listSessionExtractions(ctx.cwd);
				const summary = readSummary(ctx.cwd);
				const lastConsolidated = (() => {
					try {
						const p = path.join(getKnowledgeDir(ctx.cwd), "last_consolidated.json");
						if (!fs.existsSync(p)) return null;
						return JSON.parse(fs.readFileSync(p, "utf-8"));
					} catch { return null; }
				})();

				const lines = [
					`Knowledge: ${config.enabled ? "enabled" : "disabled"}`,
					`Sessions extracted: ${extractions.length}`,
					`Summary: ${summary ? `${summary.length} chars` : "none"}`,
					`Last consolidated: ${lastConsolidated?.timestamp ?? "never"}`,
					`Config: maxAge=${config.maxSessionAgeDays}d, minAge=${config.minSessionAgeHours}h`,
				];

				if (extractions.length > 0) {
					lines.push("", "Recent extractions:");
					for (const e of extractions.slice(-5)) {
						lines.push(`  ${e.sessionId.slice(0, 8)} - ${e.synopsis}`);
					}
				}

				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			if (sub === "rebuild") {
				if (!config.enabled) {
					ctx.ui.notify('Knowledge is disabled. Enable in .cortex/config.json: { "knowledge": { "enabled": true } }', "warning");
					return;
				}
				ctx.ui.notify("Rebuilding knowledge (this may take a few minutes)...", "info");
				const result = await runPipeline(ctx.cwd, config, (msg) => ctx.ui.notify(msg, "info"));
				ctx.ui.notify(`Done: ${result.extracted} sessions extracted, consolidation ${result.consolidated ? "succeeded" : "skipped"}.`, "info");
				return;
			}

			if (sub === "clear") {
				clearKnowledge(ctx.cwd);
				ctx.ui.notify("Knowledge data cleared.", "info");
				return;
			}

			// Default: show summary
			const summary = readSummary(ctx.cwd);
			if (!summary) {
				const hint = config.enabled
					? "No knowledge yet. Run /knowledge rebuild or wait for automatic extraction."
					: 'Knowledge is disabled. Enable in .cortex/config.json: { "knowledge": { "enabled": true } }';
				ctx.ui.notify(hint, "info");
				return;
			}

			ctx.ui.notify(`Project Knowledge:\n\n${summary}`, "info");
		},
	});
}
