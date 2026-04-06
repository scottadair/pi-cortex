/**
 * LSP Client - JSON-RPC client for Language Server Protocol
 *
 * Manages language server processes, handles the JSON-RPC protocol,
 * and provides methods for common LSP operations.
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ServerConfig {
	command: string;
	args?: string[];
	fileTypes: string[];
	rootMarkers: string[];
	initOptions?: Record<string, unknown>;
	settings?: Record<string, unknown>;
}

export interface Diagnostic {
	range: { start: { line: number; character: number }; end: { line: number; character: number } };
	severity?: 1 | 2 | 3 | 4; // error, warning, info, hint
	code?: string | number;
	source?: string;
	message: string;
}

export interface Location {
	uri: string;
	range: { start: { line: number; character: number }; end: { line: number; character: number } };
}

export interface DocumentSymbol {
	name: string;
	detail?: string;
	kind: number;
	range: { start: { line: number; character: number }; end: { line: number; character: number } };
	selectionRange: { start: { line: number; character: number }; end: { line: number; character: number } };
	children?: DocumentSymbol[];
}

export interface TextEdit {
	range: { start: { line: number; character: number }; end: { line: number; character: number } };
	newText: string;
}

interface PendingRequest {
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
}

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

const LANGUAGE_MAP: Record<string, string> = {
	".ts": "typescript", ".tsx": "typescriptreact", ".js": "javascript",
	".jsx": "javascriptreact", ".mjs": "javascript", ".cjs": "javascript",
	".rs": "rust", ".go": "go", ".py": "python",
	".c": "c", ".h": "c", ".cpp": "cpp", ".cc": "cpp", ".hpp": "cpp",
	".zig": "zig", ".lua": "lua",
	".html": "html", ".htm": "html",
	".css": "css", ".scss": "scss", ".less": "less",
	".json": "json", ".jsonc": "jsonc",
	".rb": "ruby", ".java": "java", ".kt": "kotlin",
	".swift": "swift", ".cs": "csharp", ".php": "php",
	".sh": "shellscript", ".bash": "shellscript",
};

export function detectLanguageId(filePath: string): string {
	const ext = path.extname(filePath).toLowerCase();
	return LANGUAGE_MAP[ext] ?? "plaintext";
}

export function fileToUri(filePath: string): string {
	const resolved = path.resolve(filePath);
	return process.platform === "win32"
		? `file:///${resolved.replace(/\\/g, "/")}`
		: `file://${resolved}`;
}

export function uriToFile(uri: string): string {
	if (!uri.startsWith("file://")) return uri;
	let filePath = decodeURIComponent(uri.slice(7));
	if (process.platform === "win32" && filePath.startsWith("/") && /^[A-Za-z]:/.test(filePath.slice(1))) {
		filePath = filePath.slice(1);
	}
	return filePath;
}

// ---------------------------------------------------------------------------
// LSP Client
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 30_000;

export class LspClient {
	readonly name: string;
	readonly cwd: string;
	readonly config: ServerConfig;

	private proc: ChildProcess | null = null;
	private requestId = 0;
	private pendingRequests = new Map<number, PendingRequest>();
	private buffer = Buffer.alloc(0);
	private diagnostics = new Map<string, Diagnostic[]>();
	private openFiles = new Map<string, number>(); // uri -> version
	private initialized = false;
	private serverCapabilities: Record<string, unknown> = {};

	constructor(name: string, config: ServerConfig, cwd: string) {
		this.name = name;
		this.config = config;
		this.cwd = cwd;
	}

	async start(): Promise<void> {
		if (this.proc) return;

		// Resolve command - check node_modules/.bin, .venv/bin, then PATH
		const command = this.resolveCommand();

		this.proc = spawn(command, this.config.args ?? [], {
			cwd: this.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, NODE_NO_WARNINGS: "1" },
		});

		this.proc.stdout?.on("data", (data: Buffer) => this.onData(data));
		this.proc.stderr?.on("data", () => { /* discard stderr */ });
		this.proc.on("exit", () => {
			this.proc = null;
			this.initialized = false;
			// Reject all pending requests
			for (const pending of this.pendingRequests.values()) {
				pending.reject(new Error("LSP server exited"));
			}
			this.pendingRequests.clear();
		});

		// Initialize handshake
		const result = await this.request("initialize", {
			processId: process.pid,
			rootUri: fileToUri(this.cwd),
			rootPath: this.cwd,
			capabilities: {
				textDocument: {
					synchronization: { didSave: true, dynamicRegistration: false },
					hover: { contentFormat: ["markdown", "plaintext"], dynamicRegistration: false },
					definition: { dynamicRegistration: false, linkSupport: true },
					typeDefinition: { dynamicRegistration: false, linkSupport: true },
					references: { dynamicRegistration: false },
					documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
					rename: { dynamicRegistration: false, prepareSupport: true },
					codeAction: { dynamicRegistration: false },
					formatting: { dynamicRegistration: false },
					publishDiagnostics: { relatedInformation: true },
				},
				workspace: {
					applyEdit: false,
					configuration: true,
				},
			},
			initializationOptions: this.config.initOptions ?? {},
		}) as Record<string, unknown>;

		this.serverCapabilities = (result?.capabilities ?? {}) as Record<string, unknown>;
		this.notify("initialized", {});
		this.initialized = true;
	}

	async shutdown(): Promise<void> {
		if (!this.proc) return;

		// Close all open files
		for (const uri of this.openFiles.keys()) {
			this.notify("textDocument/didClose", { textDocument: { uri } });
		}
		this.openFiles.clear();

		try {
			await this.request("shutdown", null);
			this.notify("exit", null);
		} catch {
			// Force kill if shutdown fails
		}

		if (this.proc && !this.proc.killed) {
			this.proc.kill("SIGTERM");
			setTimeout(() => { if (this.proc && !this.proc.killed) this.proc.kill("SIGKILL"); }, 3000);
		}
		this.proc = null;
		this.initialized = false;
	}

	isRunning(): boolean {
		return this.proc !== null && this.initialized;
	}

	// ── Document management ─────────────────────────────────────────────

	openDocument(filePath: string): void {
		const uri = fileToUri(filePath);
		if (this.openFiles.has(uri)) return;

		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			return;
		}

		this.openFiles.set(uri, 1);
		this.notify("textDocument/didOpen", {
			textDocument: {
				uri,
				languageId: detectLanguageId(filePath),
				version: 1,
				text: content,
			},
		});
	}

	updateDocument(filePath: string): void {
		const uri = fileToUri(filePath);
		const version = (this.openFiles.get(uri) ?? 0) + 1;

		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			return;
		}

		if (!this.openFiles.has(uri)) {
			this.openFiles.set(uri, version);
			this.notify("textDocument/didOpen", {
				textDocument: { uri, languageId: detectLanguageId(filePath), version, text: content },
			});
		} else {
			this.openFiles.set(uri, version);
			this.notify("textDocument/didChange", {
				textDocument: { uri, version },
				contentChanges: [{ text: content }],
			});
		}
	}

	// ── LSP operations ──────────────────────────────────────────────────

	getDiagnostics(uri: string): Diagnostic[] {
		return this.diagnostics.get(uri) ?? [];
	}

	getAllDiagnostics(): Map<string, Diagnostic[]> {
		return new Map(this.diagnostics);
	}

	async getDefinition(filePath: string, line: number, character: number): Promise<Location[]> {
		this.openDocument(filePath);
		const result = await this.request("textDocument/definition", {
			textDocument: { uri: fileToUri(filePath) },
			position: { line, character },
		});
		return this.normalizeLocations(result);
	}

	async getTypeDefinition(filePath: string, line: number, character: number): Promise<Location[]> {
		this.openDocument(filePath);
		const result = await this.request("textDocument/typeDefinition", {
			textDocument: { uri: fileToUri(filePath) },
			position: { line, character },
		});
		return this.normalizeLocations(result);
	}

	async getReferences(filePath: string, line: number, character: number): Promise<Location[]> {
		this.openDocument(filePath);
		const result = await this.request("textDocument/references", {
			textDocument: { uri: fileToUri(filePath) },
			position: { line, character },
			context: { includeDeclaration: true },
		});
		return this.normalizeLocations(result);
	}

	async getHover(filePath: string, line: number, character: number): Promise<string | null> {
		this.openDocument(filePath);
		const result = await this.request("textDocument/hover", {
			textDocument: { uri: fileToUri(filePath) },
			position: { line, character },
		}) as { contents?: unknown } | null;

		if (!result?.contents) return null;
		return this.extractHoverText(result.contents);
	}

	async getSymbols(filePath: string): Promise<DocumentSymbol[]> {
		this.openDocument(filePath);
		const result = await this.request("textDocument/documentSymbol", {
			textDocument: { uri: fileToUri(filePath) },
		});
		return (Array.isArray(result) ? result : []) as DocumentSymbol[];
	}

	async rename(filePath: string, line: number, character: number, newName: string): Promise<TextEdit[]> {
		this.openDocument(filePath);
		const result = await this.request("textDocument/rename", {
			textDocument: { uri: fileToUri(filePath) },
			position: { line, character },
			newName,
		}) as { changes?: Record<string, TextEdit[]>; documentChanges?: Array<{ textDocument: { uri: string }; edits: TextEdit[] }> } | null;

		if (!result) return [];

		// Flatten workspace edit into a list of edits with file info
		const edits: TextEdit[] = [];
		if (result.changes) {
			for (const textEdits of Object.values(result.changes)) {
				edits.push(...textEdits);
			}
		}
		if (result.documentChanges) {
			for (const change of result.documentChanges) {
				if ("edits" in change) edits.push(...change.edits);
			}
		}
		return edits;
	}

	async getCodeActions(filePath: string, startLine: number, startChar: number, endLine: number, endChar: number): Promise<Array<{ title: string; kind?: string }>> {
		this.openDocument(filePath);
		const uri = fileToUri(filePath);
		const diagnostics = this.getDiagnostics(uri).filter((d) =>
			d.range.start.line >= startLine && d.range.end.line <= endLine,
		);

		const result = await this.request("textDocument/codeAction", {
			textDocument: { uri },
			range: { start: { line: startLine, character: startChar }, end: { line: endLine, character: endChar } },
			context: { diagnostics },
		});

		if (!Array.isArray(result)) return [];
		return result.map((a: any) => ({ title: a.title, kind: a.kind }));
	}

	async format(filePath: string): Promise<TextEdit[]> {
		this.openDocument(filePath);
		const result = await this.request("textDocument/formatting", {
			textDocument: { uri: fileToUri(filePath) },
			options: { tabSize: 2, insertSpaces: true },
		});
		return (Array.isArray(result) ? result : []) as TextEdit[];
	}

	// ── Private helpers ─────────────────────────────────────────────────

	private resolveCommand(): string {
		const cmd = this.config.command;

		// Check node_modules/.bin
		const nmBin = path.join(this.cwd, "node_modules", ".bin", cmd);
		if (fs.existsSync(nmBin)) return nmBin;

		// Check .venv/bin (Python)
		const venvBin = path.join(this.cwd, ".venv", "bin", cmd);
		if (fs.existsSync(venvBin)) return venvBin;

		// Fall back to PATH
		return cmd;
	}

	private async request(method: string, params: unknown): Promise<unknown> {
		if (!this.proc?.stdin) throw new Error("LSP server not running");

		const id = ++this.requestId;
		const message = JSON.stringify({ jsonrpc: "2.0", id, method, params });
		const header = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n`;

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new Error(`LSP request timed out: ${method}`));
			}, REQUEST_TIMEOUT_MS);

			this.pendingRequests.set(id, {
				resolve: (result) => { clearTimeout(timer); resolve(result); },
				reject: (error) => { clearTimeout(timer); reject(error); },
			});

			this.proc!.stdin!.write(header + message);
		});
	}

	private notify(method: string, params: unknown): void {
		if (!this.proc?.stdin) return;
		const message = JSON.stringify({ jsonrpc: "2.0", method, params });
		const header = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n`;
		this.proc.stdin.write(header + message);
	}

	private onData(data: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, data]);

		while (true) {
			const headerEnd = this.findHeaderEnd();
			if (headerEnd === -1) break;

			const headerText = this.buffer.subarray(0, headerEnd).toString();
			const match = headerText.match(/Content-Length: (\d+)/i);
			if (!match) break;

			const contentLength = parseInt(match[1], 10);
			const messageStart = headerEnd + 4; // skip \r\n\r\n
			const messageEnd = messageStart + contentLength;

			if (this.buffer.length < messageEnd) break;

			const messageText = this.buffer.subarray(messageStart, messageEnd).toString();
			this.buffer = this.buffer.subarray(messageEnd);

			try {
				const msg = JSON.parse(messageText);
				this.handleMessage(msg);
			} catch {
				// Ignore malformed messages
			}
		}
	}

	private findHeaderEnd(): number {
		for (let i = 0; i < this.buffer.length - 3; i++) {
			if (this.buffer[i] === 13 && this.buffer[i + 1] === 10 &&
				this.buffer[i + 2] === 13 && this.buffer[i + 3] === 10) {
				return i;
			}
		}
		return -1;
	}

	private handleMessage(msg: any): void {
		// Response to our request
		if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
			const pending = this.pendingRequests.get(msg.id)!;
			this.pendingRequests.delete(msg.id);
			if (msg.error) {
				pending.reject(new Error(`LSP error: ${msg.error.message}`));
			} else {
				pending.resolve(msg.result);
			}
			return;
		}

		// Server request (workspace/configuration)
		if (msg.method === "workspace/configuration" && msg.id !== undefined) {
			const items = msg.params?.items ?? [];
			const result = items.map((item: any) => {
				const section = item.section ?? "";
				return this.config.settings?.[section] ?? {};
			});
			this.sendResponse(msg.id, result);
			return;
		}

		// Server notification
		if (msg.method === "textDocument/publishDiagnostics" && msg.params) {
			this.diagnostics.set(msg.params.uri, msg.params.diagnostics ?? []);
		}
	}

	private sendResponse(id: number, result: unknown): void {
		if (!this.proc?.stdin) return;
		const message = JSON.stringify({ jsonrpc: "2.0", id, result });
		const header = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n`;
		this.proc.stdin.write(header + message);
	}

	private normalizeLocations(result: unknown): Location[] {
		if (!result) return [];
		if (Array.isArray(result)) {
			return result.map((loc: any) => {
				if (loc.targetUri) {
					return { uri: loc.targetUri, range: loc.targetSelectionRange ?? loc.targetRange };
				}
				return loc as Location;
			});
		}
		// Single location
		const loc = result as any;
		if (loc.uri) return [loc as Location];
		if (loc.targetUri) return [{ uri: loc.targetUri, range: loc.targetSelectionRange ?? loc.targetRange }];
		return [];
	}

	private extractHoverText(contents: unknown): string {
		if (typeof contents === "string") return contents;
		if (Array.isArray(contents)) {
			return contents.map((c) => this.extractHoverText(c)).join("\n\n");
		}
		if (typeof contents === "object" && contents !== null) {
			if ("value" in contents && typeof (contents as any).value === "string") {
				return (contents as any).value;
			}
		}
		return String(contents);
	}
}

// ---------------------------------------------------------------------------
// Client Manager
// ---------------------------------------------------------------------------

export class LspClientManager {
	private clients = new Map<string, LspClient>();
	private configs: Record<string, ServerConfig>;
	private cwd: string;

	constructor(configs: Record<string, ServerConfig>, cwd: string) {
		this.configs = configs;
		this.cwd = cwd;
	}

	/**
	 * Find the appropriate server config for a file path.
	 */
	findServerForFile(filePath: string): { name: string; config: ServerConfig } | null {
		const ext = path.extname(filePath).toLowerCase();

		for (const [name, config] of Object.entries(this.configs)) {
			if (config.fileTypes.includes(ext)) {
				return { name, config };
			}
		}
		return null;
	}

	/**
	 * Get or start an LSP client for a file.
	 */
	async getClientForFile(filePath: string): Promise<LspClient | null> {
		const server = this.findServerForFile(filePath);
		if (!server) return null;

		const existing = this.clients.get(server.name);
		if (existing?.isRunning()) return existing;

		const client = new LspClient(server.name, server.config, this.cwd);
		try {
			await client.start();
			this.clients.set(server.name, client);
			return client;
		} catch {
			return null;
		}
	}

	/**
	 * Get all active clients.
	 */
	getActiveClients(): Array<{ name: string; client: LspClient }> {
		const active: Array<{ name: string; client: LspClient }> = [];
		for (const [name, client] of this.clients) {
			if (client.isRunning()) active.push({ name, client });
		}
		return active;
	}

	/**
	 * Shutdown all clients.
	 */
	async shutdownAll(): Promise<void> {
		const shutdowns = Array.from(this.clients.values()).map((c) => c.shutdown());
		await Promise.allSettled(shutdowns);
		this.clients.clear();
	}

	/**
	 * Restart a specific client.
	 */
	async restart(name: string): Promise<boolean> {
		const client = this.clients.get(name);
		if (client) {
			await client.shutdown();
			this.clients.delete(name);
		}
		// Will be lazily restarted on next request
		return true;
	}
}
