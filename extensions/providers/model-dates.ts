/**
 * Model date extraction for newest-first sorting.
 *
 * Strategy:
 * 1. Extract date from model ID (many contain dates like 20250514, 2024-05-13)
 * 2. Fall back to a curated map for well-known models without embedded dates
 * 3. Unknown models get "0000-00-00" and sort to the bottom
 */

/**
 * Curated release dates for models whose IDs don't contain a date.
 * Only needs entries for models without date patterns in their ID.
 */
const KNOWN_DATES: Record<string, string> = {
	// Anthropic (alias / latest pointers)
	"claude-haiku-4-5": "2025-10-01",
	"claude-opus-4-5": "2025-11-01",
	"claude-opus-4-6": "2026-03-01",
	"claude-opus-4-0": "2025-05-14",
	"claude-opus-4-1": "2025-08-05",
	"claude-sonnet-4-0": "2025-05-14",
	"claude-sonnet-4-5": "2025-09-29",
	"claude-sonnet-4-6": "2026-03-01",
	"claude-3-5-haiku-latest": "2024-10-22",

	// OpenAI (no date in ID)
	"gpt-4o": "2024-05-13",
	"gpt-4o-mini": "2024-07-18",
	"gpt-4": "2023-06-13",
	"gpt-4-turbo": "2024-04-09",
	"gpt-4.1": "2025-04-14",
	"gpt-4.1-mini": "2025-04-14",
	"gpt-4.1-nano": "2025-04-14",
	"gpt-5": "2025-06-01",
	"gpt-5-mini": "2025-06-01",
	"gpt-5-nano": "2025-06-01",
	"gpt-5-pro": "2025-06-01",
	"gpt-5-chat-latest": "2025-06-01",
	"gpt-5.1": "2025-09-01",
	"gpt-5.1-codex": "2025-09-01",
	"gpt-5.1-codex-max": "2025-09-01",
	"gpt-5.1-codex-mini": "2025-09-01",
	"gpt-5.1-instant": "2025-09-01",
	"gpt-5.1-thinking": "2025-09-01",
	"gpt-5.1-chat-latest": "2025-09-01",
	"gpt-5.2": "2025-12-01",
	"gpt-5.2-chat-latest": "2025-12-01",
	"gpt-5.2-codex": "2025-12-01",
	"gpt-5.2-pro": "2025-12-01",
	"gpt-5.3-chat-latest": "2026-02-01",
	"gpt-5.3-codex": "2026-02-01",
	"gpt-5.3-codex-spark": "2026-02-01",
	"gpt-5.4": "2026-03-15",
	"gpt-5.4-mini": "2026-03-15",
	"gpt-5.4-nano": "2026-03-15",
	"gpt-5.4-pro": "2026-03-15",
	"o1": "2024-12-17",
	"o1-pro": "2025-03-19",
	"o3": "2025-04-16",
	"o3-mini": "2025-01-31",
	"o3-pro": "2025-06-10",
	"o3-deep-research": "2025-06-10",
	"o4-mini": "2025-04-16",
	"o4-mini-deep-research": "2025-06-10",
	"codex-mini-latest": "2025-05-16",
	"gpt-oss-120b": "2025-07-01",
	"gpt-oss-20b": "2025-07-01",

	// Google
	"gemini-2.5-pro": "2025-03-25",
	"gemini-2.5-flash": "2025-04-17",
	"gemini-2.5-flash-lite": "2025-06-01",
	"gemini-2.0-flash": "2025-02-05",
	"gemini-2.0-flash-lite": "2025-02-05",
	"gemini-1.5-pro": "2024-05-01",
	"gemini-1.5-flash": "2024-05-01",
	"gemini-1.5-flash-8b": "2024-10-01",
	"gemini-3-flash-preview": "2025-12-01",
	"gemini-3-pro-preview": "2025-12-01",
	"gemini-3.1-pro-preview": "2026-02-01",
	"gemini-3.1-pro-preview-customtools": "2026-02-01",
	"gemini-3.1-flash-lite-preview": "2026-02-01",
	"gemini-flash-latest": "2025-04-17",
	"gemini-flash-lite-latest": "2025-06-01",
	"gemini-live-2.5-flash": "2025-04-17",
	"gemini-pro-latest": "2025-03-25",

	// xAI
	"grok-2": "2024-08-01",
	"grok-2-latest": "2024-12-12",
	"grok-2-vision": "2024-08-01",
	"grok-2-vision-latest": "2024-12-12",
	"grok-3": "2025-02-18",
	"grok-3-latest": "2025-02-18",
	"grok-3-fast": "2025-02-18",
	"grok-3-fast-latest": "2025-02-18",
	"grok-3-mini": "2025-02-18",
	"grok-3-mini-fast": "2025-02-18",
	"grok-3-mini-fast-latest": "2025-02-18",
	"grok-3-mini-latest": "2025-02-18",
	"grok-4": "2025-07-01",
	"grok-4-fast": "2025-07-01",
	"grok-4-fast-non-reasoning": "2025-07-01",
	"grok-4-1-fast": "2025-09-01",
	"grok-4-1-fast-non-reasoning": "2025-09-01",
	"grok-beta": "2024-06-01",
	"grok-vision-beta": "2024-06-01",
	"grok-code-fast-1": "2025-10-01",

	// Mistral
	"mistral-large-latest": "2025-03-01",
	"mistral-small-latest": "2025-02-01",
	"codestral-latest": "2025-05-01",
	"devstral-latest": "2025-05-01",
	"devstral-small-latest": "2025-05-01",
	"pixtral-large-latest": "2025-02-01",
	"magistral-medium-latest": "2025-06-01",
	"magistral-small-latest": "2025-06-01",

	// DeepSeek
	"deepseek-chat": "2025-01-20",
	"deepseek-reasoner": "2025-01-20",

	// Groq
	"llama-3.3-70b-versatile": "2024-12-01",
	"llama-3.1-8b-instant": "2024-07-23",

	// GitHub Copilot aliases
	"claude-haiku-4.5": "2025-10-01",
	"claude-opus-4.5": "2025-11-01",
	"claude-opus-4.6": "2026-03-01",
	"claude-sonnet-4": "2025-05-14",
	"claude-sonnet-4.5": "2025-09-29",
	"claude-sonnet-4.6": "2026-03-01",

	// ZAI
	"glm-4.5": "2025-01-01",
	"glm-4.5-air": "2025-01-01",
	"glm-4.5-flash": "2025-01-01",
	"glm-4.5v": "2025-01-01",
	"glm-4.6": "2025-04-01",
	"glm-4.6v": "2025-04-01",
	"glm-4.6v-flash": "2025-04-01",
	"glm-4.7": "2025-07-01",
	"glm-4.7-flash": "2025-07-01",
	"glm-4.7-flashx": "2025-07-01",
	"glm-5": "2025-10-01",
	"glm-5-turbo": "2025-10-01",
	"glm-5.1": "2026-01-01",
	"glm-5v-turbo": "2025-10-01",
};

/**
 * Try to extract a date from a model ID string.
 * Handles patterns like: 20250514, 2024-05-13, 2025-09-2025, -0309-
 */
function extractDateFromId(modelId: string): string | null {
	// Pattern: YYYYMMDD (e.g., claude-3-5-sonnet-20241022)
	const yyyymmdd = modelId.match(/(\d{4})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])/);
	if (yyyymmdd) {
		const [, y, m, d] = yyyymmdd;
		if (parseInt(y) >= 2023 && parseInt(y) <= 2030) {
			return `${y}-${m}-${d}`;
		}
	}

	// Pattern: YYYY-MM-DD (e.g., gpt-4o-2024-05-13)
	const dash = modelId.match(/(20[23]\d)-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])/);
	if (dash) {
		return `${dash[1]}-${dash[2]}-${dash[3]}`;
	}

	// Pattern: preview-MM-YYYY or preview-MM-YY (e.g., gemini-2.5-flash-preview-04-17)
	const previewDate = modelId.match(/preview-(0[1-9]|1[0-2])-(2[0-9])/);
	if (previewDate) {
		return `20${previewDate[2]}-${previewDate[1]}-01`;
	}

	// Pattern: MMYY at end (e.g., mistral-large-2501)
	const mmyy = modelId.match(/-(2[4-9])(0[1-9]|1[0-2])$/);
	if (mmyy) {
		return `20${mmyy[1]}-${mmyy[2]}-01`;
	}

	return null;
}

/**
 * Get a sortable date string for a model. Used for newest-first ordering.
 * Returns "0000-00-00" for unknown models (sorts to bottom).
 */
export function getModelDate(modelId: string): string {
	// First try the curated map
	if (KNOWN_DATES[modelId]) {
		return KNOWN_DATES[modelId];
	}

	// Then try extracting from the ID
	const extracted = extractDateFromId(modelId);
	if (extracted) return extracted;

	// Unknown → bottom of the list
	return "0000-00-00";
}
