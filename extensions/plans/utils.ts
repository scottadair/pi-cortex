/**
 * Plan parsing and serialization utilities
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

export interface PlanStep {
	number: number;
	text: string;
	completed: boolean;
}

export interface PlanMeta {
	id: string;
	title: string;
	status: "draft" | "active" | "completed" | "archived";
	created_at: string;
	updated_at: string;
}

export interface PlanFile {
	meta: PlanMeta;
	goal: string;
	steps: PlanStep[];
	notes: string;
}

// ---------------------------------------------------------------------------
// Slug generation
// ---------------------------------------------------------------------------

export function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
}

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

export function getPlansDir(cwd: string): string {
	return path.join(cwd, ".cortex", "plans");
}

export function ensurePlansDir(cwd: string): string {
	const dir = getPlansDir(cwd);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

export function parsePlanFile(content: string): PlanFile | null {
	const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (!match) return null;

	let meta: PlanMeta;
	try {
		meta = JSON.parse(match[1]) as PlanMeta;
	} catch {
		return null;
	}

	const body = match[2];

	// Extract goal
	const goalMatch = body.match(/## Goal\n([\s\S]*?)(?=\n## |\n*$)/);
	const goal = goalMatch ? goalMatch[1].trim() : "";

	// Extract steps
	const stepsMatch = body.match(/## Steps\n([\s\S]*?)(?=\n## |\n*$)/);
	const steps: PlanStep[] = [];
	if (stepsMatch) {
		const stepLines = stepsMatch[1].trim().split("\n");
		for (const line of stepLines) {
			const stepMatch = line.match(/^(\d+)\.\s+\[(x| )\]\s+(.+)$/);
			if (stepMatch) {
				steps.push({
					number: parseInt(stepMatch[1], 10),
					text: stepMatch[3].trim(),
					completed: stepMatch[2] === "x",
				});
			}
		}
	}

	// Extract notes
	const notesMatch = body.match(/## Notes\n([\s\S]*?)(?=\n## |\n*$)/);
	const notes = notesMatch ? notesMatch[1].trim() : "";

	return { meta, goal, steps, notes };
}

export function serializePlanFile(plan: PlanFile): string {
	const frontmatter = JSON.stringify(plan.meta, null, 2);

	let body = "";
	if (plan.goal) {
		body += `\n## Goal\n${plan.goal}\n`;
	}

	if (plan.steps.length > 0) {
		body += `\n## Steps\n`;
		for (const step of plan.steps) {
			body += `${step.number}. [${step.completed ? "x" : " "}] ${step.text}\n`;
		}
	}

	if (plan.notes) {
		body += `\n## Notes\n${plan.notes}\n`;
	}

	return `---\n${frontmatter}\n---\n${body}`;
}

export function readAllPlans(cwd: string): PlanFile[] {
	const dir = getPlansDir(cwd);
	if (!fs.existsSync(dir)) return [];

	const plans: PlanFile[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (!entry.name.endsWith(".md") || !entry.isFile()) continue;
		try {
			const content = fs.readFileSync(path.join(dir, entry.name), "utf-8");
			const plan = parsePlanFile(content);
			if (plan) plans.push(plan);
		} catch {
			continue;
		}
	}

	return plans.sort((a, b) => b.meta.updated_at.localeCompare(a.meta.updated_at));
}

export function readPlan(cwd: string, id: string): PlanFile | null {
	const filePath = path.join(getPlansDir(cwd), `${id}.md`);
	if (!fs.existsSync(filePath)) return null;
	try {
		return parsePlanFile(fs.readFileSync(filePath, "utf-8"));
	} catch {
		return null;
	}
}

export function writePlan(cwd: string, plan: PlanFile): void {
	const dir = ensurePlansDir(cwd);
	fs.writeFileSync(path.join(dir, `${plan.meta.id}.md`), serializePlanFile(plan), "utf-8");
}

export function deletePlanFile(cwd: string, id: string): boolean {
	const filePath = path.join(getPlansDir(cwd), `${id}.md`);
	if (!fs.existsSync(filePath)) return false;
	fs.unlinkSync(filePath);
	return true;
}
