/**
 * Security Scanning Engine
 *
 * Pure-function threat detection engine for the Security Guard extension.
 * All functions are stateless and testable in isolation.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ═══════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════

export type Severity = "block" | "warn";

export type ThreatCategory =
	| "destructive"
	| "remote_exec"
	| "permissions"
	| "exfiltration"
	| "credentials"
	| "injection";

export interface ThreatResult {
	severity: Severity;
	category: ThreatCategory;
	description: string;
	matched: string;
}

export interface PolicyRule {
	pattern: string;
	severity: Severity;
	category: ThreatCategory;
	description: string;
}

export interface SecurityPolicy {
	enabled: boolean;
	commands: PolicyRule[];
	protected_paths: PolicyRule[];
	injection_patterns: PolicyRule[];
	allowlist_commands: string[];
	allowlist_paths: string[];
}

// ═══════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════

const MAX_SCAN_LENGTH = 50000;

// ═══════════════════════════════════════════════════════════════════
// Default Policy
// ═══════════════════════════════════════════════════════════════════

function getDefaultPolicy(): SecurityPolicy {
	return {
		enabled: true,
		commands: [
			{
				pattern: String.raw`rm\s+-[rf]*[rf][rf]*\s+(\.\./|/|~)`,
				severity: "block",
				category: "destructive",
				description: "Recursive/forced rm on system or parent paths",
			},
			{
				pattern: String.raw`\|\s*(ba)?sh\b`,
				severity: "block",
				category: "remote_exec",
				description: "Pipe to shell",
			},
			{
				pattern: String.raw`\bsudo\b`,
				severity: "block",
				category: "permissions",
				description: "Sudo usage",
			},
			{
				pattern: String.raw`\b(mkfs|dd\s+.*of=/dev/)`,
				severity: "block",
				category: "destructive",
				description: "Disk formatting",
			},
			{
				pattern: String.raw`:\(\)\s*\{\s*:\|:&\s*\};\s*:`,
				severity: "block",
				category: "destructive",
				description: "Fork bomb",
			},
		],
		protected_paths: [
			{
				pattern: String.raw`\.ssh/`,
				severity: "block",
				category: "credentials",
				description: "SSH keys",
			},
			{
				pattern: String.raw`\.aws/`,
				severity: "block",
				category: "credentials",
				description: "AWS credentials",
			},
			{
				pattern: String.raw`\.gnupg/`,
				severity: "block",
				category: "credentials",
				description: "GPG keys",
			},
			{
				pattern: String.raw`\.kube/config`,
				severity: "block",
				category: "credentials",
				description: "Kubernetes config",
			},
			{
				pattern: String.raw`\.env\.production`,
				severity: "block",
				category: "credentials",
				description: "Production env",
			},
		],
		injection_patterns: [
			{
				pattern: String.raw`ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|rules|guidelines)`,
				severity: "block",
				category: "injection",
				description: "Instruction override attempt",
			},
			{
				pattern: String.raw`you\s+are\s+now\s+`,
				severity: "block",
				category: "injection",
				description: "Role hijacking attempt",
			},
			{
				pattern: String.raw`reveal\s+(your\s+)?(system\s+prompt|instructions)`,
				severity: "block",
				category: "injection",
				description: "Prompt extraction attempt",
			},
			{
				pattern: String.raw`do\s+not\s+follow\s+(your|the)\s+(original|previous)\s+(instructions?|rules)`,
				severity: "block",
				category: "injection",
				description: "Instruction override attempt",
			},
		],
		allowlist_commands: [
			String.raw`^curl\s+(https?://)?localhost`,
			String.raw`^curl\s+-s?\s+https?://`,
			String.raw`rm\s+-rf\s+(node_modules|dist|build|target|__pycache__|coverage)`,
		],
		allowlist_paths: [],
	};
}

// ═══════════════════════════════════════════════════════════════════
// Policy Loading
// ═══════════════════════════════════════════════════════════════════

export function loadPolicy(cwd: string): SecurityPolicy {
	const policyPath = join(cwd, ".cortex", "security-policy.json");

	if (!existsSync(policyPath)) {
		return getDefaultPolicy();
	}

	try {
		const content = readFileSync(policyPath, "utf-8");
		const custom = JSON.parse(content) as Partial<SecurityPolicy>;
		const defaults = getDefaultPolicy();

		return {
			enabled: custom.enabled ?? defaults.enabled,
			commands: custom.commands ?? defaults.commands,
			protected_paths: custom.protected_paths ?? defaults.protected_paths,
			injection_patterns: custom.injection_patterns ?? defaults.injection_patterns,
			allowlist_commands: custom.allowlist_commands ?? defaults.allowlist_commands,
			allowlist_paths: custom.allowlist_paths ?? defaults.allowlist_paths,
		};
	} catch {
		return getDefaultPolicy();
	}
}

// ═══════════════════════════════════════════════════════════════════
// Regex Helpers
// ═══════════════════════════════════════════════════════════════════

const regexCache = new Map<string, RegExp>();

function getRegex(pattern: string, flags = "i"): RegExp {
	const key = `${pattern}::${flags}`;
	let re = regexCache.get(key);
	if (!re) {
		try {
			re = new RegExp(pattern, flags);
		} catch {
			// Invalid regex — fall back to literal match
			re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
		}
		regexCache.set(key, re);
	}
	return re;
}

function safeTest(re: RegExp, text: string): boolean {
	if (text.length > MAX_SCAN_LENGTH) return false;
	try {
		return re.test(text);
	} catch {
		return false;
	}
}

function safeExec(re: RegExp, text: string): RegExpExecArray | null {
	if (text.length > MAX_SCAN_LENGTH) return null;
	try {
		return re.exec(text);
	} catch {
		return null;
	}
}

// ═══════════════════════════════════════════════════════════════════
// Scanning Functions
// ═══════════════════════════════════════════════════════════════════

function isAllowlisted(text: string, allowlist: string[]): boolean {
	for (const pattern of allowlist) {
		const re = getRegex(pattern);
		if (safeTest(re, text.trim())) return true;
	}
	return false;
}

export function scanCommand(command: string, policy: SecurityPolicy): ThreatResult[] {
	if (!policy.enabled) return [];

	const trimmed = command.trim();
	if (trimmed.length === 0) return [];

	// Check allowlist first
	if (isAllowlisted(trimmed, policy.allowlist_commands)) return [];

	const threats: ThreatResult[] = [];

	for (const rule of policy.commands) {
		const re = getRegex(rule.pattern);
		const match = safeExec(re, trimmed);
		if (match) {
			threats.push({
				severity: rule.severity,
				category: rule.category,
				description: rule.description,
				matched: match[0],
			});
		}
	}

	return threats;
}

export function scanFilePath(filePath: string, policy: SecurityPolicy): ThreatResult[] {
	if (!policy.enabled) return [];

	const normalized = filePath.replace(/\\/g, "/");

	// Check allowlist first
	if (isAllowlisted(normalized, policy.allowlist_paths)) return [];

	const threats: ThreatResult[] = [];

	for (const rule of policy.protected_paths) {
		const re = getRegex(rule.pattern);
		if (safeTest(re, normalized) || safeTest(re, filePath)) {
			threats.push({
				severity: rule.severity,
				category: rule.category,
				description: rule.description,
				matched: filePath,
			});
		}
	}

	return threats;
}

export function scanContent(text: string, policy: SecurityPolicy): ThreatResult[] {
	if (!policy.enabled) return [];
	if (!text || text.length === 0) return [];

	const threats: ThreatResult[] = [];

	for (const rule of policy.injection_patterns) {
		const re = getRegex(rule.pattern);
		const match = safeExec(re, text);
		if (match) {
			threats.push({
				severity: rule.severity,
				category: rule.category,
				description: rule.description,
				matched: match[0],
			});
		}
	}

	return threats;
}

export function stripInjections(
	text: string,
	policy: SecurityPolicy,
): { cleaned: string; redactions: ThreatResult[] } {
	if (!policy.enabled) return { cleaned: text, redactions: [] };

	const redactions: ThreatResult[] = [];
	let cleaned = text;

	for (const rule of policy.injection_patterns) {
		if (rule.severity !== "block") continue;

		const re = getRegex(rule.pattern, "gi");
		const matches: string[] = [];
		let match: RegExpExecArray | null;

		while ((match = safeExec(re, cleaned)) !== null) {
			matches.push(match[0]);
			// Prevent infinite loop
			if (!re.global) break;
		}

		if (matches.length > 0) {
			for (const m of matches) {
				redactions.push({
					severity: rule.severity,
					category: rule.category,
					description: rule.description,
					matched: m,
				});
			}

			// Replace matched content with redaction notice
			const redactedRe = getRegex(rule.pattern, "gi");
			cleaned = cleaned.replace(redactedRe, `[REDACTED: ${rule.description}]`);
		}
	}

	return { cleaned, redactions };
}

// ═══════════════════════════════════════════════════════════════════
// Formatting
// ═══════════════════════════════════════════════════════════════════

export function formatThreat(threat: ThreatResult, verbose: boolean): string {
	const icon = threat.severity === "block" ? "🛑" : "⚠️";
	const label = `${icon} [${threat.category.toUpperCase()}]`;

	if (verbose) {
		return `${label} ${threat.description}\n   Matched: "${threat.matched}"`;
	}
	return `${label} ${threat.description}`;
}

export function formatThreatsForBlock(threats: ThreatResult[], verbose: boolean): string {
	const header = "🛡️ SECURITY GUARD — Blocked";
	const details = threats.map((t) => formatThreat(t, verbose)).join("\n");
	return `${header}\n\n${details}\n\nThis action was blocked by security policy. If you believe this is a false positive, ask the user to confirm.`;
}
