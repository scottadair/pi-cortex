/**
 * JSON Repair Extension
 *
 * Patches JSON.parse to handle malformed JSON from LLM streaming.
 * When the standard parse fails with "Bad control character in string literal",
 * it sanitizes control characters (0x00-0x1F except \t \n \r) inside JSON
 * string literals and retries.
 *
 * This works around a known issue where models occasionally emit unescaped
 * control characters in tool call argument JSON, causing parse failures
 * in the RPC layer and streaming JSON accumulator.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/**
 * Escape unescaped control characters inside JSON string values.
 *
 * Walks the raw JSON text tracking whether we're inside a string literal
 * (between unescaped double-quotes). Any byte 0x00-0x1F found inside a
 * string that isn't already part of a valid escape sequence gets replaced
 * with its \uXXXX form.
 */
function sanitizeControlCharsInJson(raw: string): string {
	const result: string[] = [];
	let inString = false;
	let i = 0;

	while (i < raw.length) {
		const ch = raw[i];
		const code = raw.charCodeAt(i);

		if (inString) {
			if (ch === "\\") {
				// Valid escape sequence — pass through as-is
				result.push(ch);
				i++;
				if (i < raw.length) {
					result.push(raw[i]);
					i++;
				}
				continue;
			}
			if (ch === '"') {
				// End of string
				inString = false;
				result.push(ch);
				i++;
				continue;
			}
			if (code < 0x20) {
				// Control character inside string — escape it
				// Keep \t (0x09), \n (0x0a), \r (0x0d) as their short forms
				if (code === 0x09) {
					result.push("\\t");
				} else if (code === 0x0a) {
					result.push("\\n");
				} else if (code === 0x0d) {
					result.push("\\r");
				} else {
					result.push(`\\u${code.toString(16).padStart(4, "0")}`);
				}
				i++;
				continue;
			}
			result.push(ch);
			i++;
		} else {
			if (ch === '"') {
				inString = true;
			}
			result.push(ch);
			i++;
		}
	}

	return result.join("");
}

export default function (_pi: ExtensionAPI) {
	const originalParse = JSON.parse;

	JSON.parse = function (text: string, reviver?: (key: string, value: any) => any): any {
		try {
			return originalParse.call(JSON, text, reviver);
		} catch (err: any) {
			const msg = err?.message ?? "";
			if (
				msg.includes("control character") ||
				msg.includes("Bad control") ||
				msg.includes("bad control")
			) {
				// Sanitize and retry
				const sanitized = sanitizeControlCharsInJson(text);
				return originalParse.call(JSON, sanitized, reviver);
			}
			throw err;
		}
	} as typeof JSON.parse;
}
