/**
 * Tool Repair Extension
 *
 * Validates tool call arguments to prevent JSON streaming errors
 * from breaking agent workflows. Intercepts tool calls before execution to:
 * - Detect truncated/malformed JSON in edit and write tools
 * - Block invalid tool calls with clear retry messages
 *
 * NOTE: Empty newText ("") is valid for edit (it means "delete this text").
 * Only missing/undefined fields indicate streaming corruption.
 */

import type { ExtensionAPI, ToolCallEvent } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event: ToolCallEvent, _ctx) => {
		const { toolName, input } = event;

		// ================================================================
		// Generic Empty Input Check (All Tools)
		// ================================================================
		if (
			input === undefined ||
			input === null ||
			(typeof input === "object" && Object.keys(input).length === 0)
		) {
			return {
				block: true,
				reason:
					`Tool call '${toolName}' has empty or missing input parameters. ` +
					"This is likely due to a JSON streaming error. Please retry the tool call with valid parameters.",
			};
		}

		// ================================================================
		// Edit Tool Validation
		// ================================================================
		if (isToolCallEventType("edit", event)) {
			if (!input.path || typeof input.path !== "string") {
				return {
					block: true,
					reason:
						"Edit tool call is missing 'path'. Likely a JSON streaming error. Please retry the edit.",
				};
			}

			if (!Array.isArray(input.edits)) {
				return {
					block: true,
					reason:
						"Edit tool call is missing 'edits' array. Likely a JSON streaming error. Please retry the edit.",
				};
			}

			if (input.edits.length === 0) {
				return {
					block: true,
					reason:
						"Edit tool call has an empty 'edits' array. Please retry with at least one edit entry.",
				};
			}

			for (let i = 0; i < input.edits.length; i++) {
				const edit = input.edits[i];

				if (typeof edit !== "object" || edit === null) {
					return {
						block: true,
						reason:
							`Edit entry ${i + 1} is not a valid object. Likely a JSON streaming error. Please retry.`,
					};
				}

				const hasOldText = "oldText" in edit && typeof edit.oldText === "string";
				const hasNewText = "newText" in edit && typeof edit.newText === "string";

				// Last entry missing BOTH fields = truncated by streaming
				if (i === input.edits.length - 1 && !hasOldText && !hasNewText) {
					return {
						block: true,
						reason:
							"Last edit entry is truncated (missing both oldText and newText). " +
							"JSON streaming cutoff. Please retry the edit.",
					};
				}

				// oldText is required and must be non-empty (it's the text to find)
				if (!hasOldText || edit.oldText.length === 0) {
					return {
						block: true,
						reason:
							`Edit entry ${i + 1} has missing/empty 'oldText'. Likely a JSON streaming error. Please retry.`,
					};
				}

				// newText must exist as a string, but CAN be empty (means delete)
				if (!hasNewText) {
					return {
						block: true,
						reason:
							`Edit entry ${i + 1} is missing 'newText'. Likely a JSON streaming error. Please retry.`,
					};
				}
			}

			return undefined;
		}

		// ================================================================
		// Write Tool Validation
		// ================================================================
		if (isToolCallEventType("write", event)) {
			if (!input.path || typeof input.path !== "string") {
				return {
					block: true,
					reason:
						"Write tool call is missing 'path'. Likely a JSON streaming error. Please retry.",
				};
			}

			if (!("content" in input) || typeof input.content !== "string") {
				return {
					block: true,
					reason:
						"Write tool call is missing 'content'. Likely a JSON streaming error. Please retry.",
				};
			}

			return undefined;
		}

		// Allow all other tools through
		return undefined;
	});
}
