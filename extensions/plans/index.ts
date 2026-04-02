/**
 * Plans Extension - Filesystem-based plan management
 *
 * Stores plans as markdown files with JSON frontmatter in .cortex/plans/.
 * Plans have a goal, numbered steps with completion tracking, and notes.
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
	type PlanFile,
	type PlanStep,
	deletePlanFile,
	readAllPlans,
	readPlan,
	slugify,
	writePlan,
} from "./utils.js";

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

const PlanParams = Type.Object({
	action: StringEnum(
		["create", "update", "add-step", "complete-step", "get", "list", "delete"] as const,
		{ description: "Action to perform" },
	),
	id: Type.Optional(Type.String({ description: "Plan ID/slug (for update, add-step, complete-step, get, delete)" })),
	title: Type.Optional(Type.String({ description: "Plan title (for create, update)" })),
	goal: Type.Optional(Type.String({ description: "Plan goal description (for create, update)" })),
	steps: Type.Optional(Type.Array(Type.String(), { description: "Step descriptions (for create)" })),
	step: Type.Optional(Type.String({ description: "Step text (for add-step)" })),
	step_number: Type.Optional(Type.Number({ description: "Step number (for complete-step, add-step position)" })),
	status: Type.Optional(
		StringEnum(["draft", "active", "completed", "archived"] as const, {
			description: "Plan status (for update)",
		}),
	),
	filter_status: Type.Optional(Type.String({ description: "Filter by status (for list)" })),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "plan",
		label: "Plan",
		description: [
			"Manage implementation plans stored in .cortex/plans/.",
			"Actions: create (title, goal, steps[]), update (id, title?, goal?, status?),",
			"add-step (id, step, step_number?), complete-step (id, step_number),",
			"get (id), list (filter_status?), delete (id).",
			"Status: draft, active, completed, archived.",
		].join(" "),
		parameters: PlanParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cwd = ctx.cwd;

			switch (params.action) {
				case "create": {
					if (!params.title) {
						return { content: [{ type: "text", text: "Error: title required for create" }], details: {} };
					}
					const id = slugify(params.title);
					const existing = readPlan(cwd, id);
					if (existing) {
						return { content: [{ type: "text", text: `Plan "${id}" already exists. Choose a different title.` }], details: {} };
					}

					const now = new Date().toISOString();
					const steps: PlanStep[] = (params.steps ?? []).map((text, i) => ({
						number: i + 1,
						text,
						completed: false,
					}));

					const plan: PlanFile = {
						meta: {
							id,
							title: params.title,
							status: "draft",
							created_at: now,
							updated_at: now,
						},
						goal: params.goal ?? "",
						steps,
						notes: "",
					};

					writePlan(cwd, plan);
					return {
						content: [{ type: "text", text: `Created plan "${id}": ${params.title} (${steps.length} steps)` }],
						details: { action: "create", plan: plan.meta, stepCount: steps.length },
					};
				}

				case "update": {
					if (!params.id) {
						return { content: [{ type: "text", text: "Error: id required for update" }], details: {} };
					}
					const plan = readPlan(cwd, params.id);
					if (!plan) {
						return { content: [{ type: "text", text: `Plan "${params.id}" not found` }], details: {} };
					}
					if (params.title !== undefined) plan.meta.title = params.title;
					if (params.goal !== undefined) plan.goal = params.goal;
					if (params.status !== undefined) plan.meta.status = params.status;
					plan.meta.updated_at = new Date().toISOString();
					writePlan(cwd, plan);
					return {
						content: [{ type: "text", text: `Updated plan "${params.id}"` }],
						details: { action: "update", plan: plan.meta },
					};
				}

				case "add-step": {
					if (!params.id || !params.step) {
						return { content: [{ type: "text", text: "Error: id and step required for add-step" }], details: {} };
					}
					const plan = readPlan(cwd, params.id);
					if (!plan) {
						return { content: [{ type: "text", text: `Plan "${params.id}" not found` }], details: {} };
					}

					const newStep: PlanStep = {
						number: plan.steps.length + 1,
						text: params.step,
						completed: false,
					};

					if (params.step_number !== undefined && params.step_number >= 1 && params.step_number <= plan.steps.length + 1) {
						plan.steps.splice(params.step_number - 1, 0, newStep);
						// Renumber
						plan.steps.forEach((s, i) => { s.number = i + 1; });
					} else {
						plan.steps.push(newStep);
					}

					plan.meta.updated_at = new Date().toISOString();
					writePlan(cwd, plan);
					return {
						content: [{ type: "text", text: `Added step ${newStep.number} to plan "${params.id}": ${params.step}` }],
						details: { action: "add-step", plan: plan.meta, stepCount: plan.steps.length },
					};
				}

				case "complete-step": {
					if (!params.id || params.step_number === undefined) {
						return { content: [{ type: "text", text: "Error: id and step_number required for complete-step" }], details: {} };
					}
					const plan = readPlan(cwd, params.id);
					if (!plan) {
						return { content: [{ type: "text", text: `Plan "${params.id}" not found` }], details: {} };
					}
					const step = plan.steps.find((s) => s.number === params.step_number);
					if (!step) {
						return { content: [{ type: "text", text: `Step ${params.step_number} not found in plan "${params.id}"` }], details: {} };
					}
					step.completed = !step.completed;
					plan.meta.updated_at = new Date().toISOString();

					// Auto-complete plan if all steps done
					const allDone = plan.steps.every((s) => s.completed);
					if (allDone && plan.meta.status === "active") {
						plan.meta.status = "completed";
					}

					writePlan(cwd, plan);
					const completedCount = plan.steps.filter((s) => s.completed).length;
					return {
						content: [{ type: "text", text: `Step ${params.step_number} ${step.completed ? "completed" : "uncompleted"} (${completedCount}/${plan.steps.length})` }],
						details: { action: "complete-step", plan: plan.meta, completedCount, totalSteps: plan.steps.length },
					};
				}

				case "get": {
					if (!params.id) {
						return { content: [{ type: "text", text: "Error: id required for get" }], details: {} };
					}
					const plan = readPlan(cwd, params.id);
					if (!plan) {
						return { content: [{ type: "text", text: `Plan "${params.id}" not found` }], details: {} };
					}

					let text = `# ${plan.meta.title}\n\n`;
					text += `- **ID**: ${plan.meta.id}\n`;
					text += `- **Status**: ${plan.meta.status}\n`;
					text += `- **Created**: ${plan.meta.created_at}\n`;
					text += `- **Updated**: ${plan.meta.updated_at}\n\n`;

					if (plan.goal) text += `## Goal\n${plan.goal}\n\n`;

					if (plan.steps.length > 0) {
						const completedCount = plan.steps.filter((s) => s.completed).length;
						text += `## Steps (${completedCount}/${plan.steps.length})\n`;
						for (const step of plan.steps) {
							text += `${step.number}. [${step.completed ? "x" : " "}] ${step.text}\n`;
						}
						text += "\n";
					}

					if (plan.notes) text += `## Notes\n${plan.notes}\n`;

					return {
						content: [{ type: "text", text }],
						details: { action: "get", plan: plan.meta },
					};
				}

				case "list": {
					let plans = readAllPlans(cwd);
					if (params.filter_status) {
						plans = plans.filter((p) => p.meta.status === params.filter_status);
					}
					if (plans.length === 0) {
						return { content: [{ type: "text", text: "No plans found." }], details: { action: "list", count: 0 } };
					}
					const listing = plans
						.map((p) => {
							const completedCount = p.steps.filter((s) => s.completed).length;
							const progress = p.steps.length > 0 ? ` (${completedCount}/${p.steps.length} steps)` : "";
							return `- **${p.meta.title}** [${p.meta.id}] (${p.meta.status})${progress}`;
						})
						.join("\n");
					return {
						content: [{ type: "text", text: listing }],
						details: { action: "list", count: plans.length },
					};
				}

				case "delete": {
					if (!params.id) {
						return { content: [{ type: "text", text: "Error: id required for delete" }], details: {} };
					}
					const deleted = deletePlanFile(cwd, params.id);
					return {
						content: [{ type: "text", text: deleted ? `Deleted plan "${params.id}"` : `Plan "${params.id}" not found` }],
						details: { action: "delete", id: params.id, deleted },
					};
				}

				default:
					return { content: [{ type: "text", text: `Unknown action: ${params.action}` }], details: {} };
			}
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("plan ")) + theme.fg("muted", args.action);
			if (args.title) text += ` ${theme.fg("dim", `"${args.title}"`)}`;
			if (args.id) text += ` ${theme.fg("accent", args.id)}`;
			if (args.step_number !== undefined) text += ` ${theme.fg("accent", `#${args.step_number}`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as Record<string, any> | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			const plan = details.plan as { id: string; title: string; status: string } | undefined;
			if (plan) {
				const statusColor = plan.status === "completed" ? "success" : plan.status === "archived" ? "dim" : "accent";
				let text = theme.fg(statusColor, `[${plan.status}]`) + " " + theme.fg("muted", plan.title);
				if (details.completedCount !== undefined) {
					text += ` ${theme.fg("dim", `(${details.completedCount}/${details.totalSteps})`)}`;
				}
				return new Text(text, 0, 0);
			}

			const resultText = result.content[0];
			return new Text(resultText?.type === "text" ? resultText.text : "", 0, 0);
		},
	});

	// /plan command
	pi.registerCommand("plan", {
		description: "List plans or show a specific plan",
		handler: async (args, ctx) => {
			const cwd = ctx.cwd;
			const planId = args.trim();

			if (planId) {
				const plan = readPlan(cwd, planId);
				if (!plan) {
					ctx.ui.notify(`Plan "${planId}" not found`, "error");
					return;
				}
				const completedCount = plan.steps.filter((s) => s.completed).length;
				let text = `${plan.meta.title} [${plan.meta.status}]\n`;
				if (plan.goal) text += `Goal: ${plan.goal}\n`;
				if (plan.steps.length > 0) {
					text += `Steps (${completedCount}/${plan.steps.length}):\n`;
					for (const step of plan.steps) {
						text += `  ${step.number}. [${step.completed ? "x" : " "}] ${step.text}\n`;
					}
				}
				ctx.ui.notify(text, "info");
			} else {
				const plans = readAllPlans(cwd);
				if (plans.length === 0) {
					ctx.ui.notify("No plans found.", "info");
					return;
				}
				const listing = plans
					.map((p) => {
						const completedCount = p.steps.filter((s) => s.completed).length;
						const progress = p.steps.length > 0 ? ` (${completedCount}/${p.steps.length})` : "";
						return `${p.meta.id}: ${p.meta.title} [${p.meta.status}]${progress}`;
					})
					.join("\n");
				ctx.ui.notify(listing, "info");
			}
		},
	});
}
