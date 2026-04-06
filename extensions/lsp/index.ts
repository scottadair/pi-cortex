/**
 * LSP Extension - Language Server Protocol Integration
 *
 * Provides IDE-like code intelligence to agents: diagnostics, go-to-definition,
 * references, hover info, symbols, rename, code actions, and formatting.
 *
 * Auto-discovers language servers from node_modules/.bin, .venv/bin, and PATH.
 * Hooks into write/edit to show diagnostics after file changes.
 *
 * Commands:
 *   /lsp          - Show LSP status
 *   /lsp restart  - Restart all language servers
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
	type Diagnostic,
	type LspClient,
	LspClientManager,
	type ServerConfig,
	detectLanguageId,
	fileToUri,
	uriToFile,
} from "./client.ts";

// ---------------------------------------------------------------------------
// Load default configs
// ---------------------------------------------------------------------------

function loadDefaultConfigs(): Record<string, ServerConfig> {
	try {
		const __dirname = path.dirname(new URL(import.meta.url).pathname);
		const defaultsPath = path.join(__dirname, "defaults.json");
		const content = fs.readFileSync(defaultsPath, "utf-8");
		return JSON.parse(content) as Record<string, ServerConfig>;
	} catch {
		return {};
	}
}

function loadProjectConfigs(cwd: string): Record<string, ServerConfig> {
	try {
		const configPath = path.join(cwd, ".cortex", "lsp.json");
		if (!fs.existsSync(configPath)) return {};
		const content = fs.readFileSync(configPath, "utf-8");
		return JSON.parse(content) as Record<string, ServerConfig>;
	} catch {
		return {};
	}
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const SEVERITY_NAMES: Record<number, string> = { 1: "error", 2: "warning", 3: "info", 4: "hint" };
const SEVERITY_ICONS: Record<number, string> = { 1: "x", 2: "!", 3: "i", 4: "." };

function formatDiagnostic(d: Diagnostic, filePath: string): string {
	const sev = SEVERITY_NAMES[d.severity ?? 1] ?? "error";
	const line = d.range.start.line + 1;
	const col = d.range.start.character + 1;
	const source = d.source ? `[${d.source}] ` : "";
	const code = d.code ? ` (${d.code})` : "";
	return `${filePath}:${line}:${col} [${sev}] ${source}${d.message}${code}`;
}

function formatDiagnosticsSummary(diagnostics: Diagnostic[]): string {
	const counts = { error: 0, warning: 0, info: 0, hint: 0 };
	for (const d of diagnostics) {
		const sev = SEVERITY_NAMES[d.severity ?? 1] ?? "error";
		if (sev in counts) counts[sev as keyof typeof counts]++;
	}
	const parts: string[] = [];
	if (counts.error > 0) parts.push(`${counts.error} error(s)`);
	if (counts.warning > 0) parts.push(`${counts.warning} warning(s)`);
	if (counts.info > 0) parts.push(`${counts.info} info(s)`);
	return parts.length > 0 ? parts.join(", ") : "no issues";
}

function shortenPath(filePath: string): string {
	const home = process.env.HOME || process.env.USERPROFILE || "";
	return home && filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
}

function resolveColumn(filePath: string, line: number, symbol?: string, occurrence?: number): number {
	if (!symbol) return 0;
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		const lines = content.split("\n");
		const targetLine = lines[line] ?? "";
		const occ = Math.max(1, occurrence ?? 1);

		let fromIndex = 0;
		let found = 0;
		while (fromIndex <= targetLine.length - symbol.length) {
			const idx = targetLine.indexOf(symbol, fromIndex);
			if (idx === -1) break;
			found++;
			if (found === occ) return idx;
			fromIndex = idx + symbol.length;
		}

		// Case-insensitive fallback
		const lower = targetLine.toLowerCase();
		const lowerSymbol = symbol.toLowerCase();
		fromIndex = 0;
		found = 0;
		while (fromIndex <= lower.length - lowerSymbol.length) {
			const idx = lower.indexOf(lowerSymbol, fromIndex);
			if (idx === -1) break;
			found++;
			if (found === occ) return idx;
			fromIndex = idx + lowerSymbol.length;
		}
	} catch { /* ignore */ }
	return 0;
}

// ---------------------------------------------------------------------------
// Tool schema
// ---------------------------------------------------------------------------

const LspParams = Type.Object({
	action: StringEnum(
		["diagnostics", "definition", "type_definition", "references", "hover", "symbols", "rename", "code_actions", "format", "status", "reload"] as const,
		{ description: "LSP operation to perform" },
	),
	file: Type.Optional(Type.String({ description: "File path (required for most actions)" })),
	line: Type.Optional(Type.Number({ description: "Line number (1-indexed)" })),
	symbol: Type.Optional(Type.String({ description: "Symbol name to locate on the line (used to compute column)" })),
	occurrence: Type.Optional(Type.Number({ description: "Which occurrence of symbol on the line (1-indexed, default: 1)" })),
	new_name: Type.Optional(Type.String({ description: "New name for rename action" })),
});

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let manager: LspClientManager | null = null;

	// Initialize on session start
	pi.on("session_start", async (_event, ctx) => {
		const defaults = loadDefaultConfigs();
		const project = loadProjectConfigs(ctx.cwd);
		const configs = { ...defaults, ...project };
		manager = new LspClientManager(configs, ctx.cwd);
	});

	// Cleanup on session shutdown
	pi.on("session_shutdown", async () => {
		if (manager) {
			await manager.shutdownAll();
			manager = null;
		}
	});

	// Show diagnostics after write/edit tool results
	pi.on("tool_result", async (event, ctx) => {
		if (!manager) return;
		if (event.toolName !== "write" && event.toolName !== "edit") return;

		const filePath = (event.input as any)?.file_path ?? (event.input as any)?.path;
		if (!filePath || typeof filePath !== "string") return;

		const client = await manager.getClientForFile(filePath);
		if (!client) return;

		// Notify the LSP server of the change
		client.updateDocument(filePath);

		// Wait briefly for diagnostics to arrive from the server
		await new Promise((r) => setTimeout(r, 1500));

		const uri = fileToUri(filePath);
		const diagnostics = client.getDiagnostics(uri);

		if (diagnostics.length > 0) {
			const errors = diagnostics.filter((d) => d.severity === 1);
			const warnings = diagnostics.filter((d) => d.severity === 2);

			if (errors.length > 0 || warnings.length > 0) {
				const relPath = path.relative(ctx.cwd, filePath);
				const summary = formatDiagnosticsSummary(diagnostics);
				const details = diagnostics
					.filter((d) => (d.severity ?? 1) <= 2)
					.slice(0, 10)
					.map((d) => formatDiagnostic(d, relPath))
					.join("\n");

				// Append diagnostic info to the tool result
				const existing = event.content?.[0];
				const existingText = existing?.type === "text" ? existing.text : "";
				return {
					content: [
						{
							type: "text" as const,
							text: `${existingText}\n\n[LSP ${summary}]\n${details}`,
						},
					],
				};
			}
		}
	});

	// Register the lsp tool
	pi.registerTool({
		name: "lsp",
		label: "LSP",
		description: [
			"Language Server Protocol operations for code intelligence.",
			"Actions: diagnostics (errors/warnings), definition (go-to-def), type_definition, references (find usages),",
			"hover (type info), symbols (list file symbols), rename, code_actions (quick fixes), format, status, reload.",
			"Use 'symbol' parameter to specify which symbol on a line (computes column automatically).",
		].join(" "),
		parameters: LspParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!manager) {
				return {
					content: [{ type: "text" as const, text: "LSP not initialized. Try again after session start." }],
					details: { action: params.action, success: false },
				};
			}

			const action = params.action;
			const filePath = params.file ? path.resolve(ctx.cwd, params.file) : undefined;

			// Status action - no file needed
			if (action === "status") {
				const active = manager.getActiveClients();
				if (active.length === 0) {
					return {
						content: [{ type: "text" as const, text: "No active language servers." }],
						details: { action, success: true },
					};
				}
				const lines = active.map((a) => `  ${a.name}: running`);
				return {
					content: [{ type: "text" as const, text: `Active language servers:\n${lines.join("\n")}` }],
					details: { action, success: true },
				};
			}

			// Reload action
			if (action === "reload") {
				await manager.shutdownAll();
				return {
					content: [{ type: "text" as const, text: "All language servers restarted." }],
					details: { action, success: true },
				};
			}

			if (!filePath) {
				return {
					content: [{ type: "text" as const, text: "File path is required for this action." }],
					details: { action, success: false },
					isError: true,
				};
			}

			const client = await manager.getClientForFile(filePath);
			if (!client) {
				const ext = path.extname(filePath);
				return {
					content: [{ type: "text" as const, text: `No language server available for ${ext} files. Server may not be installed or not in PATH.` }],
					details: { action, success: false },
				};
			}

			const relPath = path.relative(ctx.cwd, filePath);
			// Convert 1-indexed line to 0-indexed for LSP
			const line = (params.line ?? 1) - 1;
			const character = resolveColumn(filePath, line, params.symbol, params.occurrence);

			try {
				switch (action) {
					case "diagnostics": {
						client.updateDocument(filePath);
						await new Promise((r) => setTimeout(r, 2000));

						const uri = fileToUri(filePath);
						const diagnostics = client.getDiagnostics(uri);

						if (diagnostics.length === 0) {
							return {
								content: [{ type: "text" as const, text: `${relPath}: no diagnostics` }],
								details: { action, success: true },
							};
						}

						const sorted = [...diagnostics].sort((a, b) => (a.severity ?? 1) - (b.severity ?? 1));
						const formatted = sorted.map((d) => formatDiagnostic(d, relPath));
						const summary = formatDiagnosticsSummary(diagnostics);

						return {
							content: [{ type: "text" as const, text: `${relPath}: ${summary}\n\n${formatted.join("\n")}` }],
							details: { action, success: true },
						};
					}

					case "definition": {
						const locations = await client.getDefinition(filePath, line, character);
						if (locations.length === 0) {
							return {
								content: [{ type: "text" as const, text: `No definition found for symbol at ${relPath}:${line + 1}:${character + 1}` }],
								details: { action, success: true },
							};
						}
						const results = locations.map((loc) => {
							const file = path.relative(ctx.cwd, uriToFile(loc.uri));
							return `${file}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`;
						});
						return {
							content: [{ type: "text" as const, text: `Definition:\n${results.join("\n")}` }],
							details: { action, success: true },
						};
					}

					case "type_definition": {
						const locations = await client.getTypeDefinition(filePath, line, character);
						if (locations.length === 0) {
							return {
								content: [{ type: "text" as const, text: `No type definition found at ${relPath}:${line + 1}:${character + 1}` }],
								details: { action, success: true },
							};
						}
						const results = locations.map((loc) => {
							const file = path.relative(ctx.cwd, uriToFile(loc.uri));
							return `${file}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`;
						});
						return {
							content: [{ type: "text" as const, text: `Type definition:\n${results.join("\n")}` }],
							details: { action, success: true },
						};
					}

					case "references": {
						const locations = await client.getReferences(filePath, line, character);
						if (locations.length === 0) {
							return {
								content: [{ type: "text" as const, text: `No references found at ${relPath}:${line + 1}:${character + 1}` }],
								details: { action, success: true },
							};
						}
						const results = locations.map((loc) => {
							const file = path.relative(ctx.cwd, uriToFile(loc.uri));
							return `${file}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`;
						});
						return {
							content: [{ type: "text" as const, text: `${locations.length} reference(s):\n${results.join("\n")}` }],
							details: { action, success: true },
						};
					}

					case "hover": {
						const hover = await client.getHover(filePath, line, character);
						if (!hover) {
							return {
								content: [{ type: "text" as const, text: `No hover info at ${relPath}:${line + 1}:${character + 1}` }],
								details: { action, success: true },
							};
						}
						return {
							content: [{ type: "text" as const, text: hover }],
							details: { action, success: true },
						};
					}

					case "symbols": {
						const symbols = await client.getSymbols(filePath);
						if (symbols.length === 0) {
							return {
								content: [{ type: "text" as const, text: `No symbols found in ${relPath}` }],
								details: { action, success: true },
							};
						}

						const SYMBOL_KINDS: Record<number, string> = {
							1: "File", 2: "Module", 3: "Namespace", 4: "Package",
							5: "Class", 6: "Method", 7: "Property", 8: "Field",
							9: "Constructor", 10: "Enum", 11: "Interface", 12: "Function",
							13: "Variable", 14: "Constant", 23: "Struct", 26: "TypeParam",
						};

						const formatSymbol = (s: any, indent: number): string[] => {
							const prefix = "  ".repeat(indent);
							const kind = SYMBOL_KINDS[s.kind] ?? "Symbol";
							const line = s.range.start.line + 1;
							const detail = s.detail ? ` ${s.detail}` : "";
							const lines = [`${prefix}${kind} ${s.name}${detail} @ line ${line}`];
							if (s.children) {
								for (const child of s.children) lines.push(...formatSymbol(child, indent + 1));
							}
							return lines;
						};

						const lines = symbols.flatMap((s) => formatSymbol(s, 0));
						return {
							content: [{ type: "text" as const, text: `Symbols in ${relPath}:\n${lines.join("\n")}` }],
							details: { action, success: true },
						};
					}

					case "rename": {
						if (!params.new_name) {
							return {
								content: [{ type: "text" as const, text: "new_name parameter is required for rename." }],
								details: { action, success: false },
								isError: true,
							};
						}
						const edits = await client.rename(filePath, line, character, params.new_name);
						return {
							content: [{ type: "text" as const, text: `Rename produced ${edits.length} edit(s). Apply them with the edit tool.` }],
							details: { action, success: true, edits },
						};
					}

					case "code_actions": {
						const actions = await client.getCodeActions(filePath, line, character, line, character);
						if (actions.length === 0) {
							return {
								content: [{ type: "text" as const, text: `No code actions available at ${relPath}:${line + 1}:${character + 1}` }],
								details: { action, success: true },
							};
						}
						const lines = actions.map((a, i) => `${i + 1}. [${a.kind ?? "action"}] ${a.title}`);
						return {
							content: [{ type: "text" as const, text: `Code actions:\n${lines.join("\n")}` }],
							details: { action, success: true },
						};
					}

					case "format": {
						const edits = await client.format(filePath);
						if (edits.length === 0) {
							return {
								content: [{ type: "text" as const, text: `${relPath}: already formatted` }],
								details: { action, success: true },
							};
						}

						// Apply formatting edits
						let content = fs.readFileSync(filePath, "utf-8");
						const lines = content.split("\n");

						// Apply edits in reverse order to preserve positions
						const sorted = [...edits].sort((a, b) => {
							if (a.range.start.line !== b.range.start.line) return b.range.start.line - a.range.start.line;
							return b.range.start.character - a.range.start.character;
						});

						for (const edit of sorted) {
							const startLine = edit.range.start.line;
							const startChar = edit.range.start.character;
							const endLine = edit.range.end.line;
							const endChar = edit.range.end.character;

							const before = lines.slice(0, startLine).join("\n")
								+ (startLine > 0 ? "\n" : "")
								+ (lines[startLine] ?? "").slice(0, startChar);
							const after = (lines[endLine] ?? "").slice(endChar)
								+ (endLine < lines.length - 1 ? "\n" : "")
								+ lines.slice(endLine + 1).join("\n");

							content = before + edit.newText + after;
							// Re-split for next iteration
							const newLines = content.split("\n");
							lines.length = 0;
							lines.push(...newLines);
						}

						fs.writeFileSync(filePath, content, "utf-8");
						client.updateDocument(filePath);

						return {
							content: [{ type: "text" as const, text: `${relPath}: formatted (${edits.length} edit(s) applied)` }],
							details: { action, success: true },
						};
					}

					default:
						return {
							content: [{ type: "text" as const, text: `Unknown action: ${action}` }],
							details: { action, success: false },
							isError: true,
						};
				}
			} catch (err: any) {
				return {
					content: [{ type: "text" as const, text: `LSP error (${action}): ${err.message}` }],
					details: { action, success: false },
					isError: true,
				};
			}
		},

		renderCall(args, theme) {
			const action = args.action || "...";
			const file = args.file ? shortenPath(args.file) : "";
			const symbol = args.symbol ? ` (${args.symbol})` : "";
			const line = args.line ? `:${args.line}` : "";
			return new Text(
				theme.fg("toolTitle", theme.bold("lsp ")) +
				theme.fg("accent", action) +
				(file ? theme.fg("dim", ` ${file}${line}${symbol}`) : ""),
				0, 0,
			);
		},

		renderResult(result, _opts, theme) {
			const details = result.details as { action?: string; success?: boolean } | undefined;
			const text = result.content[0];
			const content = text?.type === "text" ? text.text : "(no output)";

			if (details?.success === false) {
				return new Text(theme.fg("error", content), 0, 0);
			}

			// Color diagnostics
			if (details?.action === "diagnostics" && content.includes("[error]")) {
				const lines = content.split("\n");
				const colored = lines.map((l) => {
					if (l.includes("[error]")) return theme.fg("error", l);
					if (l.includes("[warning]")) return theme.fg("warning", l);
					return theme.fg("dim", l);
				});
				return new Text(colored.join("\n"), 0, 0);
			}

			return new Text(content, 0, 0);
		},
	});

	// /lsp command
	pi.registerCommand("lsp", {
		description: "LSP status and management",
		async handler(args, ctx) {
			if (!manager) {
				ctx.ui.notify("LSP not initialized.", "warning");
				return;
			}

			const subcommand = args[0];

			if (subcommand === "restart") {
				await manager.shutdownAll();
				ctx.ui.notify("All language servers restarted.", "info");
				return;
			}

			const active = manager.getActiveClients();
			if (active.length === 0) {
				ctx.ui.notify("No active language servers. They start lazily when you use the lsp tool.", "info");
			} else {
				const lines = active.map((a) => `  ${a.name}: running`);
				ctx.ui.notify(`Active language servers:\n${lines.join("\n")}`, "info");
			}
		},
	});
}
