/**
 * Providers Extension - Multi-account provider management
 *
 * Allows users to configure multiple API keys/accounts per provider
 * (e.g., Anthropic Work + Anthropic Personal) and assign them to agents.
 *
 * Config files (project overrides global):
 * - ~/.cortex/providers.json  (user-global, stores raw API keys)
 * - .cortex/providers.json    (project-local, env var references ONLY)
 *
 * SECURITY: Raw API keys are ONLY stored in ~/.cortex/providers.json.
 * Project-local .cortex/providers.json may only contain env var references
 * to prevent accidental commits of secrets.
 *
 * Registers:
 * - /providers command (list, add, remove, reload)
 * - Auto-registers providers via pi.registerProvider()
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	type Component,
	Key,
	matchesKey,
	type TUI,
} from "@mariozechner/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AccountConfig {
	/** Base provider to inherit from (e.g., "anthropic", "openai") */
	provider: string;
	/** API key — literal string, env var name, or !command */
	apiKey?: string;
	/** Use OAuth/subscription credentials instead of API key */
	auth?: "subscription";
	/** Override base URL (for proxies, custom endpoints) */
	baseUrl?: string;
	/** Override API type */
	api?: string;
	/** Custom headers */
	headers?: Record<string, string>;
}

interface ProvidersConfig {
	accounts: Record<string, AccountConfig>;
	defaults?: {
		/** Default provider for subagents */
		agents?: string;
		/** Default provider for interactive mode */
		interactive?: string;
	};
}

// ---------------------------------------------------------------------------
// Known provider base URLs and API types
// ---------------------------------------------------------------------------

const KNOWN_PROVIDERS: Record<string, { baseUrl: string; api: string; displayName: string }> = {
	anthropic: { baseUrl: "https://api.anthropic.com", api: "anthropic-messages", displayName: "Anthropic" },
	openai: { baseUrl: "https://api.openai.com/v1", api: "openai-responses", displayName: "OpenAI" },
	google: { baseUrl: "https://generativelanguage.googleapis.com/v1beta", api: "google-generative-ai", displayName: "Google" },
	mistral: { baseUrl: "https://api.mistral.ai/v1", api: "mistral-conversations", displayName: "Mistral" },
	groq: { baseUrl: "https://api.groq.com/openai/v1", api: "openai-completions", displayName: "Groq" },
	xai: { baseUrl: "https://api.x.ai/v1", api: "openai-completions", displayName: "xAI" },
	deepseek: { baseUrl: "https://api.deepseek.com/v1", api: "openai-completions", displayName: "DeepSeek" },
};

const PROVIDER_CHOICES = [
	...Object.entries(KNOWN_PROVIDERS).map(([id, p]) => ({ id, label: p.displayName })),
	{ id: "custom", label: "Custom" },
];

const API_TYPES = [
	"anthropic-messages",
	"openai-completions",
	"openai-responses",
	"google-generative-ai",
	"mistral-conversations",
];

// ---------------------------------------------------------------------------
// Config loading with source tracking
// ---------------------------------------------------------------------------

function getGlobalConfigPath(): string {
	return path.join(os.homedir(), ".cortex", "providers.json");
}

function getProjectConfigPath(cwd: string): string {
	return path.join(cwd, ".cortex", "providers.json");
}

function readConfigFile(filePath: string): ProvidersConfig | null {
	try {
		if (!fs.existsSync(filePath)) return null;
		const content = fs.readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(content);
		if (!parsed.accounts || typeof parsed.accounts !== "object") {
			return null;
		}
		return parsed as ProvidersConfig;
	} catch {
		return null;
	}
}

/** Track which file each account came from */
let accountSources = new Map<string, string>();

function loadConfig(cwd: string): ProvidersConfig {
	accountSources = new Map();
	const globalPath = getGlobalConfigPath();
	const projectPath = getProjectConfigPath(cwd);
	const global = readConfigFile(globalPath);
	const project = readConfigFile(projectPath);

	const merged: ProvidersConfig = { accounts: {}, defaults: {} };

	if (global) {
		Object.assign(merged.accounts, global.accounts);
		if (global.defaults) Object.assign(merged.defaults!, global.defaults);
		for (const name of Object.keys(global.accounts)) {
			accountSources.set(name, globalPath);
		}
	}
	if (project) {
		Object.assign(merged.accounts, project.accounts);
		if (project.defaults) Object.assign(merged.defaults!, project.defaults);
		for (const name of Object.keys(project.accounts)) {
			accountSources.set(name, projectPath);
		}
	}

	return merged;
}

// ---------------------------------------------------------------------------
// Config file write helpers
// ---------------------------------------------------------------------------

function writeConfigFile(filePath: string, config: ProvidersConfig): void {
	const dir = path.dirname(filePath);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

function addAccountToFile(
	filePath: string,
	name: string,
	account: AccountConfig,
	setDefault?: boolean,
): void {
	const existing = readConfigFile(filePath) || { accounts: {} };
	existing.accounts[name] = account;
	if (setDefault) {
		existing.defaults = existing.defaults || {};
		existing.defaults.agents = name;
	}
	writeConfigFile(filePath, existing);
}

function removeAccountFromFile(filePath: string, name: string): boolean {
	const existing = readConfigFile(filePath);
	if (!existing || !existing.accounts[name]) return false;
	delete existing.accounts[name];
	if (existing.defaults?.agents === name) delete existing.defaults.agents;
	if (existing.defaults?.interactive === name) delete existing.defaults.interactive;
	writeConfigFile(filePath, existing);
	return true;
}

// ---------------------------------------------------------------------------
// API key validation
// ---------------------------------------------------------------------------

async function validateApiKey(
	provider: string,
	apiKey: string,
	baseUrl: string,
): Promise<{ valid: boolean; error?: string }> {
	try {
		const headers: Record<string, string> = {};
		let url: string;

		if (provider === "anthropic") {
			headers["x-api-key"] = apiKey;
			headers["anthropic-version"] = "2023-06-01";
			url = `${baseUrl}/v1/models`;
		} else {
			headers["Authorization"] = `Bearer ${apiKey}`;
			// Strip trailing /v1 if present to avoid double path
			const base = baseUrl.replace(/\/v1\/?$/, "");
			url = `${base}/v1/models`;
		}

		const res = await fetch(url, {
			headers,
			signal: AbortSignal.timeout(10000),
		});

		if (res.status === 401) {
			return { valid: false, error: "Invalid API key (401 Unauthorized)" };
		}
		if (res.status === 403) {
			return { valid: false, error: "Access denied (403 Forbidden)" };
		}

		return { valid: true };
	} catch (e: any) {
		return { valid: false, error: e.message || String(e) };
	}
}

/**
 * Resolve an API key value — if it looks like an env var name (all caps, underscores),
 * try to resolve it from the environment.
 */
function resolveKeyForValidation(apiKey: string): string | null {
	// If it starts with sk-, key-, etc. it's probably a literal key
	if (apiKey.startsWith("sk-") || apiKey.startsWith("key-") || apiKey.length > 40) {
		return apiKey;
	}
	// Try as env var
	const envValue = process.env[apiKey];
	if (envValue) return envValue;
	return null;
}

// ---------------------------------------------------------------------------
// Masked Input Component
// ---------------------------------------------------------------------------

class MaskedInputComponent implements Component {
	private value: string = "";
	private label: string;
	private tui: TUI;
	private onDone: (result: string | null) => void;
	private cachedLines?: string[];
	private cachedWidth?: number;

	private dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
	private cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
	private green = (s: string) => `\x1b[32m${s}\x1b[0m`;
	private yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

	constructor(label: string, tui: TUI, onDone: (result: string | null) => void) {
		this.label = label;
		this.tui = tui;
		this.onDone = onDone;
	}

	invalidate(): void {
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.enter)) {
			this.onDone(this.value || null);
			return;
		}
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.onDone(null);
			return;
		}
		if (matchesKey(data, Key.backspace)) {
			this.value = this.value.slice(0, -1);
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.ctrl("u"))) {
			this.value = "";
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		// Append printable characters (handles paste)
		let changed = false;
		for (const ch of data) {
			const code = ch.charCodeAt(0);
			if (code >= 32 && code !== 127) {
				this.value += ch;
				changed = true;
			}
		}
		if (changed) {
			this.invalidate();
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const lines: string[] = [];
		lines.push("");
		lines.push(`  ${this.cyan(this.label)}`);
		lines.push("");

		if (this.value.length > 0) {
			const maxDots = Math.min(this.value.length, width - 20);
			const masked = this.green("•".repeat(maxDots));
			const hint = this.dim(` (${this.value.length} chars)`);
			lines.push(`  ${masked}${hint}`);
		} else {
			lines.push(`  ${this.dim("Paste or type your API key...")}`);
		}

		lines.push("");
		lines.push(`  ${this.dim("Enter")} ${this.yellow("confirm")}  ${this.dim("Ctrl+U")} ${this.yellow("clear")}  ${this.dim("Esc")} ${this.yellow("cancel")}`);
		lines.push("");

		this.cachedLines = lines;
		this.cachedWidth = width;
		return lines;
	}
}

// ---------------------------------------------------------------------------
// Add wizard
// ---------------------------------------------------------------------------

async function handleAdd(ctx: any, currentConfig: ProvidersConfig, cwd: string, doLoad: () => any): Promise<void> {
	// Step 1: Pick provider
	const providerLabels = PROVIDER_CHOICES.map((p) => p.label);
	const providerChoice = await ctx.ui.select("Select provider", providerLabels);
	if (providerChoice == null) {
		ctx.ui.notify("Cancelled", "info");
		return;
	}
	const providerEntry = PROVIDER_CHOICES.find((p) => p.label === providerChoice);
	if (!providerEntry) return;

	let providerId = providerEntry.id;
	let baseUrl = KNOWN_PROVIDERS[providerId]?.baseUrl || "";
	let apiType = KNOWN_PROVIDERS[providerId]?.api || "";

	// Custom provider: ask for base URL and API type
	if (providerId === "custom") {
		const customId = await ctx.ui.input("Provider ID (e.g., 'my-proxy')", "");
		if (!customId) { ctx.ui.notify("Cancelled", "info"); return; }
		providerId = customId.trim();

		const customUrl = await ctx.ui.input("Base URL", "https://");
		if (!customUrl) { ctx.ui.notify("Cancelled", "info"); return; }
		baseUrl = customUrl.trim();

		const typeChoice = await ctx.ui.select("API type", API_TYPES);
		if (!typeChoice) { ctx.ui.notify("Cancelled", "info"); return; }
		apiType = typeChoice;
	}

	// Step 2: Account name
	const suggestedName = providerId;
	const accountName = await ctx.ui.input(
		"Account name",
		suggestedName,
	);
	if (!accountName) { ctx.ui.notify("Cancelled", "info"); return; }
	const name = accountName.trim().toLowerCase().replace(/\s+/g, "-");

	// Check for duplicates
	if (currentConfig.accounts[name]) {
		const overwrite = await ctx.ui.confirm(
			`Account '${name}' already exists. Overwrite?`,
			"This will replace the existing account configuration.",
		);
		if (!overwrite) { ctx.ui.notify("Cancelled", "info"); return; }
	}

	// Step 3: Auth method
	const authChoice = await ctx.ui.select("How to authenticate?", [
		"Paste API key (stored securely in ~/.cortex/)",
		"Environment variable reference",
	]);
	if (authChoice == null) { ctx.ui.notify("Cancelled", "info"); return; }

	const isPasteKey = authChoice.startsWith("Paste");
	let apiKeyValue: string | undefined;
	let rawKeyForValidation: string | null = null;

	if (isPasteKey) {
		// Step 4a: Masked input for API key
		const key = await (ctx.ui.custom as any)((tui: TUI, _theme: any, _kb: any, done: (r: string | null) => void) => {
			return new MaskedInputComponent("Paste your API key:", tui, done);
		});
		if (!key) { ctx.ui.notify("Cancelled", "info"); return; }
		apiKeyValue = key;
		rawKeyForValidation = key;
	} else {
		// Step 4b: Env var name
		const envVarName = await ctx.ui.input(
			"Environment variable name",
			`${providerId.toUpperCase().replace(/-/g, "_")}_API_KEY`,
		);
		if (!envVarName) { ctx.ui.notify("Cancelled", "info"); return; }
		apiKeyValue = envVarName.trim();
		rawKeyForValidation = resolveKeyForValidation(apiKeyValue!);
	}

	// Step 5: Scope (only for env var — raw keys are forced to global)
	let targetFile: string;
	if (isPasteKey) {
		// SECURITY: Raw API keys are ONLY stored in ~/.cortex/providers.json
		targetFile = getGlobalConfigPath();
	} else {
		const scopeChoice = await ctx.ui.select("Save to?", [
			`Global (~/.cortex/providers.json)`,
			`Project (.cortex/providers.json)`,
		]);
		if (scopeChoice == null) { ctx.ui.notify("Cancelled", "info"); return; }
		targetFile = scopeChoice.startsWith("Global")
			? getGlobalConfigPath()
			: getProjectConfigPath(cwd);
	}

	// Step 6: Set as default?
	const setDefault = await ctx.ui.confirm(
		"Set as default provider for agents?",
		`Agents without a provider field will use '${name}'`,
	);

	// Step 7: Validate API key
	if (rawKeyForValidation) {
		ctx.ui.notify("Validating API key...", "info");
		const validationUrl = baseUrl || KNOWN_PROVIDERS[providerId]?.baseUrl || "";
		const result = await validateApiKey(providerId, rawKeyForValidation, validationUrl);

		if (!result.valid) {
			const saveAnyway = await ctx.ui.confirm(
				`Validation failed: ${result.error}`,
				"Save the account anyway?",
			);
			if (!saveAnyway) { ctx.ui.notify("Cancelled", "info"); return; }
		} else {
			ctx.ui.notify("✓ API key is valid!", "info");
		}
	} else if (!isPasteKey) {
		ctx.ui.notify(
			`⚠ Could not validate: env var '${apiKeyValue}' is not currently set. The key will be validated when used.`,
			"info",
		);
	}

	// Step 8: Build account config and save
	const account: AccountConfig = { provider: providerId };
	if (apiKeyValue) account.apiKey = apiKeyValue;
	if (baseUrl && !KNOWN_PROVIDERS[providerId]) account.baseUrl = baseUrl;
	if (apiType && !KNOWN_PROVIDERS[providerId]) account.api = apiType;

	addAccountToFile(targetFile, name, account, setDefault);

	// Reload
	doLoad();

	const scopeLabel = targetFile === getGlobalConfigPath() ? "global" : "project";
	ctx.ui.notify(
		`✓ Added provider account '${name}' (${providerId}) to ${scopeLabel} config`,
		"info",
	);
}

// ---------------------------------------------------------------------------
// Remove handler
// ---------------------------------------------------------------------------

async function handleRemove(ctx: any, currentConfig: ProvidersConfig, doLoad: () => any): Promise<void> {
	const accountEntries = Object.entries(currentConfig.accounts);
	if (accountEntries.length === 0) {
		ctx.ui.notify("No accounts to remove. Run `/providers add` to add one first.", "info");
		return;
	}

	// Build picker options with details
	const options = accountEntries.map(([name, account]) => {
		const authType = account.auth === "subscription" ? "subscription" : "api-key";
		const source = accountSources.get(name);
		const scope = source?.includes(os.homedir()) ? "global" : "project";
		return `${name}  (${account.provider}, ${authType}, ${scope})`;
	});

	const choice = await ctx.ui.select("Select account to remove", options);
	if (choice == null) { ctx.ui.notify("Cancelled", "info"); return; }

	// Extract account name (first word before double-space)
	const selectedName = choice.split("  ")[0].trim();
	const account = currentConfig.accounts[selectedName];
	if (!account) return;

	// Show details and confirm
	const sourceFile = accountSources.get(selectedName);
	const authType = account.auth === "subscription" ? "subscription" : "api-key";
	const scope = sourceFile?.includes(os.homedir()) ? "global" : "project";

	const confirmed = await ctx.ui.confirm(
		`Remove '${selectedName}'?`,
		`Provider: ${account.provider} | Auth: ${authType} | Scope: ${scope}`,
	);
	if (!confirmed) { ctx.ui.notify("Cancelled", "info"); return; }

	// Remove from the source file
	if (sourceFile) {
		const removed = removeAccountFromFile(sourceFile, selectedName);
		if (removed) {
			doLoad();
			ctx.ui.notify(`✓ Removed account '${selectedName}'`, "info");
		} else {
			ctx.ui.notify(`Failed to remove '${selectedName}'`, "error");
		}
	} else {
		ctx.ui.notify(`Could not determine source file for '${selectedName}'`, "error");
	}
}

// ---------------------------------------------------------------------------
// Provider registration
// ---------------------------------------------------------------------------

function registerAccounts(pi: ExtensionAPI, config: ProvidersConfig): { registered: string[]; errors: string[] } {
	const registered: string[] = [];
	const errors: string[] = [];

	for (const [accountName, account] of Object.entries(config.accounts)) {
		const known = KNOWN_PROVIDERS[account.provider];

		if (!known && !account.baseUrl) {
			errors.push(`${accountName}: unknown provider "${account.provider}" and no baseUrl specified`);
			continue;
		}

		if (!account.apiKey && account.auth !== "subscription") {
			errors.push(`${accountName}: no apiKey or auth method specified`);
			continue;
		}

		const providerConfig: Record<string, any> = {
			baseUrl: account.baseUrl || known?.baseUrl,
			api: (account.api || known?.api) as any,
		};

		if (account.apiKey) {
			providerConfig.apiKey = account.apiKey;
		}

		if (account.headers) {
			providerConfig.headers = account.headers;
		}

		try {
			pi.registerProvider(accountName, providerConfig);
			registered.push(accountName);
		} catch (e: any) {
			errors.push(`${accountName}: registration failed — ${e.message || e}`);
		}
	}

	return { registered, errors };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let currentConfig: ProvidersConfig = { accounts: {}, defaults: {} };
	let lastRegistered: string[] = [];
	let lastErrors: string[] = [];
	let cwd = process.cwd();

	const doLoad = () => {
		for (const name of lastRegistered) {
			try { pi.unregisterProvider(name); } catch { /* ignore */ }
		}

		currentConfig = loadConfig(cwd);
		const result = registerAccounts(pi, currentConfig);
		lastRegistered = result.registered;
		lastErrors = result.errors;
		return result;
	};

	// Initial load
	doLoad();

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.cwd) {
			cwd = ctx.cwd;
			doLoad();
		}
	});

	// /providers command
	pi.registerCommand("providers", {
		description: "Manage provider accounts (list, add, remove, reload)",
		handler: async (args, ctx) => {
			const subcommand = args?.trim().toLowerCase() || "list";

			// ── Add ──────────────────────────────────────────────
			if (subcommand === "add") {
				return handleAdd(ctx, currentConfig, cwd, doLoad);
			}

			// ── Remove ───────────────────────────────────────────
			if (subcommand === "remove" || subcommand === "rm") {
				return handleRemove(ctx, currentConfig, doLoad);
			}

			// ── Reload ───────────────────────────────────────────
			if (subcommand === "reload") {
				const result = doLoad();
				if (result.registered.length > 0) {
					ctx.ui.notify(
						`Reloaded ${result.registered.length} provider(s): ${result.registered.join(", ")}`,
						"info",
					);
				}
				if (result.errors.length > 0) {
					ctx.ui.notify(`Errors: ${result.errors.join("; ")}`, "error");
				}
				if (result.registered.length === 0 && result.errors.length === 0) {
					ctx.ui.notify("No providers configured. Run `/providers add` to get started.", "info");
				}
				return;
			}

			// ── List ─────────────────────────────────────────────
			if (subcommand === "list" || subcommand === "") {
				const lines: string[] = [];
				lines.push("# Configured Providers\n");

				const accountEntries = Object.entries(currentConfig.accounts);
				if (accountEntries.length === 0) {
					lines.push("No accounts configured.\n");
					lines.push("Run `/providers add` to set up your first provider account.");
				} else {
					for (const [name, account] of accountEntries) {
						const isRegistered = lastRegistered.includes(name);
						const status = isRegistered ? "✓" : "✗";
						const authType = account.auth === "subscription" ? "subscription" : "api-key";
						const baseUrl = account.baseUrl || KNOWN_PROVIDERS[account.provider]?.baseUrl || "unknown";
						const source = accountSources.get(name);
						const scope = source?.includes(os.homedir()) ? "global" : "project";

						lines.push(`- **${status} ${name}** (${scope})`);
						lines.push(`  - Provider: ${account.provider}`);
						lines.push(`  - Auth: ${authType}`);
						lines.push(`  - URL: ${baseUrl}`);
						if (account.api) lines.push(`  - API: ${account.api}`);
						lines.push("");
					}
				}

				if (currentConfig.defaults?.agents || currentConfig.defaults?.interactive) {
					lines.push("## Defaults\n");
					if (currentConfig.defaults.agents) {
						lines.push(`- Agents: **${currentConfig.defaults.agents}**`);
					}
					if (currentConfig.defaults.interactive) {
						lines.push(`- Interactive: **${currentConfig.defaults.interactive}**`);
					}
					lines.push("");
				}

				const globalPath = getGlobalConfigPath();
				const projectPath = getProjectConfigPath(cwd);
				lines.push("## Config files\n");
				lines.push(`- Global: \`${globalPath}\` ${fs.existsSync(globalPath) ? "(found)" : "(not found)"}`);
				lines.push(`- Project: \`${projectPath}\` ${fs.existsSync(projectPath) ? "(found)" : "(not found)"}`);

				if (lastErrors.length > 0) {
					lines.push("\n## Errors\n");
					for (const err of lastErrors) {
						lines.push(`- ⚠ ${err}`);
					}
				}

				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			ctx.ui.notify(
				`Unknown subcommand: '${subcommand}'. Available: list, add, remove, reload`,
				"error",
			);
		},
	});
}
