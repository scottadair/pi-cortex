# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Cortex is a pi coding harness package (`@mariozechner/pi-coding-agent`) that provides an AI development team system. It ships as a single pi package containing extensions, skills, themes, and prompts that create a structured multi-agent workflow.

## Package Structure

```
cortex/
├── package.json            # pi package manifest
├── extensions/
│   ├── team/index.ts       # Subagent orchestration (run/parallel/chain/list)
│   └── todos/index.ts      # Task management with description + plan, /answer Q&A
├── agents/                 # Team member definitions (markdown + YAML frontmatter)
│   ├── team-lead.md        # Orchestrator, delegates work
│   ├── dev-backend.md      # Backend developer, full tool access
│   ├── dev-frontend.md     # Frontend developer, full tool access
│   ├── architect.md        # System design, read-only, high thinking
│   └── qa.md               # Code review & testing, read-only + bash
├── skills/
│   ├── implement-feature/  # End-to-end feature implementation workflow
│   ├── review-code/        # Code review via QA agent
│   └── debug-issue/        # Systematic debugging workflow
├── prompts/
│   ├── implement.md        # /implement {{task}}
│   ├── review.md           # /review {{target}}
│   └── scout-and-plan.md   # /scout-and-plan {{goal}}
└── themes/
    └── cortex.json         # Tokyo Night color theme
```

Install locally: `pi install /Users/scott/Source/Personal/cortex`

## Extensions

### Team (`extensions/team/`)
Registers a `team` tool and `/team` command. Spawns isolated `pi` subprocesses per agent.
- **Actions**: `run` (single agent), `parallel` (concurrent tasks), `chain` (sequential with `{previous}` placeholder), `list`
- **Agent discovery** (later wins, full override by name):
  1. Package-bundled (`cortex/agents/`) — defaults
  2. User-global (`~/.pi/agent/agents/`) — personal overrides
  3. Pi project-local (`.pi/agents/`) — walks up directory tree
  4. **Cortex project-local (`.cortex/agents/`)** — project root only, highest priority
- Agents defined as markdown with YAML frontmatter: `name`, `description`, `tools`, `model`, `thinking`

### Todos (`extensions/todos/`)
Registers a `todo` tool, `/tasks` command, `/answer` command, and `Ctrl+.` shortcut. Persists as markdown files in `.cortex/todos/`.
- Each todo has three sections: **title** (frontmatter), **description** (markdown), **plan** (full implementation document in markdown)
- Plans are rich documents with Context, Changes (numbered sections with file paths, line numbers, code snippets), Files to modify, and Verification — not just checklists
- **Actions**: `create`, `update`, `list`, `get`, `set-description`, `set-plan`, `delete`, `refine`
- **Refine flow**: agent asks clarifying questions → user answers via `/answer` Q&A TUI → agent updates description and plan
- `/tasks` TUI: arrow keys to select, `r` to refine, `w`/Enter to work on a todo
- `/answer` (or `Ctrl+.`): extracts questions from last assistant message into interactive Q&A
- Status: `todo`, `in-progress`, `done`, `blocked`. Priority: `low`, `medium`, `high`

## Writing Extensions

Extensions export a default function receiving `ExtensionAPI`:

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
export default function (pi: ExtensionAPI) { ... }
```

Key APIs:
- `pi.registerTool({ name, description, parameters, execute, renderCall?, renderResult? })`
- `pi.registerCommand(name, { description, handler })`
- `pi.on(event, handler)` — lifecycle events
- Tool parameters use `@sinclair/typebox` and `StringEnum` from `@mariozechner/pi-ai`
- Tool execute returns `{ content: [{ type: "text", text }], details: {} }`
- Rendering uses `Text`, `Container`, `Markdown`, `Spacer` from `@mariozechner/pi-tui`

## Agent Definitions

Markdown files in `agents/` with YAML frontmatter:

```yaml
---
name: agent-name
description: What this agent does
tools: read, grep, find, ls, bash
model: claude-sonnet-4-5
thinking: high  # optional
---

System prompt body...
```

## Development

```bash
pi install /Users/scott/Source/Personal/cortex  # install package
pi list                                          # verify installation
pi config                                        # enable/disable resources
# /reload in pi session to hot-reload extensions
```

Data directory created at runtime:
- `.cortex/todos/` — todo markdown files (each with title, description, and plan)
