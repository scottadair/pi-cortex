/**
 * Providers Extension - Multi-account provider management
 *
 * Allows users to configure multiple API keys/accounts per provider
 * (e.g., Anthropic Work + Anthropic Personal) and assign them to agents.
 *
 * Config files (project overrides global):
 * - ~/.cortex/providers.json  (user-global)
 * - .cortex/providers.json    (project-local)
 *
 * Registers:
 * - /providers command (list, reload)
 * - Auto-registers providers via pi.registerProvider()
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
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

const KNOWN_PROVIDERS: Record<string, { baseUrl: string; api: string }> = {
	anthropic: { baseUrl: "https://api.anthropic.com", api: "anthropic-messages" },
	openai: { baseUrl: "https://api.openai.com/v1", api: "openai-responses" },
	google: { baseUrl: "https://generativelanguage.googleapis.com/v1beta", api: "google-generative-ai" },
	mistral: { baseUrl: "https://api.mistral.ai/v1", api: "mistral-conversations" },
	groq: { baseUrl: "https://api.groq.com/openai/v1", api: "openai-completions" },
	xai: { baseUrl: "https://api.x.ai/v1", api: "openai-completions" },
	deepseek: { baseUrl: "https://api.deepseek.com/v1", api: "openai-completions" },
};

// ---------------------------------------------------------------------------
// Config loading
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

function mergeConfigs(global: ProvidersConfig | null, project: ProvidersConfig | null): ProvidersConfig {
	const merged: ProvidersConfig = {
		accounts: {},
		defaults: {},
	};

	// Global first, project overrides
	if (global) {
		Object.assign(merged.accounts, global.accounts);
		if (global.defaults) Object.assign(merged.defaults!, global.defaults);
	}
	if (project) {
		Object.assign(merged.accounts, project.accounts);
		if (project.defaults) Object.assign(merged.defaults!, project.defaults);
	}

	return merged;
}

function loadConfig(cwd: string): ProvidersConfig {
	const global = readConfigFile(getGlobalConfigPath());
	const project = readConfigFile(getProjectConfigPath(cwd));
	return mergeConfigs(global, project);
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

		// API key — pi handles env var resolution and !command execution natively
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

	// Load and register on startup
	const doLoad = () => {
		// Unregister previously registered accounts
		for (const name of lastRegistered) {
			try {
				pi.unregisterProvider(name);
			} catch {
				// Ignore
			}
		}

		currentConfig = loadConfig(cwd);
		const result = registerAccounts(pi, currentConfig);
		lastRegistered = result.registered;
		lastErrors = result.errors;

		return result;
	};

	// Initial load
	doLoad();

	// Update cwd on session start
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.cwd) {
			cwd = ctx.cwd;
			doLoad();
		}
	});

	// /providers command
	pi.registerCommand("providers", {
		description: "Manage multi-account providers (list, reload)",
		handler: async (args, ctx) => {
			const subcommand = args?.trim().toLowerCase() || "list";

			if (subcommand === "reload") {
				const result = doLoad();
				if (result.registered.length > 0) {
					ctx.ui.notify(`Reloaded ${result.registered.length} provider(s): ${result.registered.join(", ")}`, "info");
				}
				if (result.errors.length > 0) {
					ctx.ui.notify(`Errors: ${result.errors.join("; ")}`, "error");
				}
				if (result.registered.length === 0 && result.errors.length === 0) {
					ctx.ui.notify("No providers configured. Add accounts to .cortex/providers.json", "info");
				}
				return;
			}

			if (subcommand === "list" || subcommand === "") {
				const lines: string[] = [];
				lines.push("# Configured Providers\n");

				const accountEntries = Object.entries(currentConfig.accounts);
				if (accountEntries.length === 0) {
					lines.push("No accounts configured.\n");
					lines.push("Create `.cortex/providers.json` or `~/.cortex/providers.json` with:");
					lines.push("```json");
					lines.push(JSON.stringify({
						accounts: {
							"anthropic-work": {
								provider: "anthropic",
								apiKey: "ANTHROPIC_WORK_API_KEY",
							},
							"anthropic-personal": {
								provider: "anthropic",
								apiKey: "ANTHROPIC_PERSONAL_API_KEY",
							},
						},
					}, null, 2));
					lines.push("```");
				} else {
					for (const [name, account] of accountEntries) {
						const isRegistered = lastRegistered.includes(name);
						const status = isRegistered ? "✓" : "✗";
						const authType = account.auth === "subscription" ? "subscription" : "api-key";
						const baseUrl = account.baseUrl || KNOWN_PROVIDERS[account.provider]?.baseUrl || "unknown";

						lines.push(`- **${status} ${name}**`);
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

				// Config file locations
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

			ctx.ui.notify(`Unknown subcommand: ${subcommand}. Use: list, reload`, "error");
		},
	});
}
