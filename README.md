# Cortex

[![pi package](https://img.shields.io/badge/pi-package-blue)](https://github.com/mariozechner/pi-coding-agent)

> An AI development team system for pi — coordinate specialized agents to implement features, review code, and debug issues

## Overview

Cortex transforms pi into a full development team. Instead of working alone, you orchestrate specialized AI agents (backend dev, frontend dev, architect, QA, and team lead) who collaborate on your codebase. Each agent has specific tools, expertise, and responsibilities — just like a real engineering team.

Cortex ships as a single pi package containing:
- **16 extensions** for team orchestration, task management, code intelligence, security, and DX
- **5 specialized agents** with distinct roles and capabilities
- **9 agent templates** for quick customization (devops, designer, mobile, security, and more)
- **3 workflow skills** for feature implementation, code review, and debugging
- **Slash commands** for quick access to common workflows
- **Task management system** with rich plans, Q&A refinement, and isolated git worktrees
- **Long-term memory** that persists knowledge across sessions

Whether you're building a new feature, fixing a bug, or reviewing a pull request, Cortex provides structured workflows that coordinate the right agents at the right time.

## Features

### 🤝 Team Orchestration
- **Run** individual agents for specific tasks
- **Parallel** execution for concurrent work
- **Chain** workflows where each step feeds into the next
- Isolated pi subprocesses per agent with full context
- Tmux integration for subagent visibility

### ✅ Task Management
- Create todos with **title**, **description**, and **full implementation plan**
- Plans are rich documents with context, numbered change sections, file paths, code snippets, and verification steps
- **Refine** todos through interactive Q&A to clarify requirements
- Track status (`todo`, `in-progress`, `done`, `blocked`) and priority
- Integrated with git worktrees for isolated feature branches
- **Completion reports** generated after merges

### 🧠 Intelligence & Memory
- **Knowledge** — long-term memory that extracts durable insights across sessions
- **Memory** — preserves cortex context (todos, worktrees, file ops) across compaction cycles
- **TTSR Rules** — zero context-cost rules that inject guidance only when triggered by model output

### 🔧 Code Intelligence
- **LSP integration** — diagnostics, go-to-definition, references, hover, symbols, rename, and formatting
- Auto-discovers language servers from `node_modules/.bin`, `.venv/bin`, and `PATH`
- Diagnostics shown automatically after file changes

### 🎯 Workflow Skills
- **implement-feature**: End-to-end feature implementation with planning, development, and QA review
- **review-code**: Structured code review workflow via QA agent
- **debug-issue**: Systematic debugging with root cause analysis and verification

### 🛡️ Security Guard
- **Three-layer defense** against malicious commands and prompt injection
- Blocks dangerous bash commands (`rm -rf`, `sudo`, `curl|bash`, fork bombs)
- Protects credentials (SSH keys, AWS, GPG, production env files)
- Strips prompt injection attempts from file contents before they reach the agent
- Configurable via `.cortex/security-policy.json`
- Full audit log of all security events

### 🎨 Developer Experience
- **Welcome screen** with branded Pi logo, tips, and recent sessions
- **Enhanced footer** with model, git branch, tokens, cost, and context % indicators
- **ESC ESC** double-tap to cancel all running operations
- **Tool repair** that catches malformed tool calls before they break workflows
- **Multi-account providers** for managing API keys across projects
- `/tasks` TUI for browsing and managing todos
- `/answer` (or `Ctrl+.`) for Q&A refinement
- Hot-reload extensions with `/reload`
- Tokyo Night color theme

## Installation

**Prerequisites**: [pi coding agent](https://github.com/mariozechner/pi-coding-agent) must be installed.

Clone this repository and install it as a pi package:

```bash
# Note: Update the repository URL to the actual cortex repository when published
git clone https://github.com/yourusername/cortex.git
cd cortex
pi install .
```

Verify installation:

```bash
pi list
```

You should see `cortex` in your installed packages.

To enable Cortex resources in your pi session:

```bash
pi config
```

Select the Cortex extensions, skills, prompts, and theme to enable them.

## Quick Start

Start a pi session in your project directory:

```bash
pi
```

### Example 1: Implement a Feature

Use the `/implement` command to kick off a full feature workflow:

```
/implement Add a search API endpoint that filters users by name and email
```

Cortex will:
1. Run the architect to analyze your codebase and create a detailed plan
2. Create a todo with the full implementation plan
3. Get team lead approval on the plan
4. Create an isolated git worktree
5. Run the backend developer to implement the changes
6. Run QA to review and test
7. Get team lead validation of completion
8. Mark the todo as done

### Example 2: Review Code

Review changes on a branch:

```
/review the feature/search branch
```

Or review uncommitted changes:

```
/review my current changes
```

The QA agent will analyze the code for correctness, security issues, quality, and test coverage, producing structured findings with priority levels (P0–P3) and confidence scores.

### Example 3: Scout and Plan

Need to understand how to approach a complex change? Scout the codebase first:

```
/scout-and-plan How would we add real-time notifications to this app?
```

The architect will analyze your codebase, understand the architecture, and create a comprehensive plan.

### All Commands

| Command | Description |
|---------|-------------|
| `/implement {{task}}` | Full feature implementation workflow |
| `/review {{target}}` | Code review workflow |
| `/scout-and-plan {{goal}}` | Explore architecture and create plan |
| `/tasks` or `/todo` | Open task management TUI |
| `/answer` or `Ctrl+.` | Answer agent questions in Q&A flow |
| `/security [status\|log\|reload]` | Security guard status and audit log |
| `/lsp` or `/lsp restart` | LSP status and restart language servers |
| `/knowledge [status\|rebuild\|clear]` | Long-term knowledge management |
| `/providers` | Provider/account management |
| `/report [todo-id]` | View completion report for a merged todo |
| `/rules` or `/rules status` | List TTSR rules and firing status |
| `ESC ESC` | Cancel all running operations |

## Package Structure

```
cortex/
├── package.json                # pi package manifest
├── extensions/
│   ├── answer/index.ts         # Q&A extraction and interactive answering
│   ├── escape-cancel/index.ts  # Double-tap ESC to cancel all operations
│   ├── footer/index.ts         # Enhanced status bar
│   ├── knowledge/index.ts      # Long-term memory across sessions
│   ├── lsp/                    # Language Server Protocol integration
│   │   ├── index.ts
│   │   ├── client.ts
│   │   └── defaults.json
│   ├── memory/index.ts         # Context preservation across compaction
│   ├── providers/index.ts      # Multi-account provider management
│   ├── report/index.ts         # Completion reports for merged todos
│   ├── review/index.ts         # Structured code review tools
│   ├── security/
│   │   ├── index.ts            # Security guard hooks and /security command
│   │   └── engine.ts           # Stateless threat scanning engine
│   ├── team/
│   │   ├── index.ts            # Subagent orchestration
│   │   └── tmux.ts             # Tmux integration for subagents
│   ├── todos/index.ts          # Task management with description + plan
│   ├── tool-repair/index.ts    # Tool call validation and repair
│   ├── ttsr/index.ts           # Time Traveling Streamed Rules
│   ├── welcome/index.ts        # Branded startup screen
│   └── worktree/index.ts       # Git worktree management per todo
├── agents/                     # Team member definitions (markdown + YAML frontmatter)
│   ├── team-lead.md
│   ├── dev-backend.md
│   ├── dev-frontend.md
│   ├── architect.md
│   └── qa.md
├── templates/agents/           # Agent templates for customization
│   ├── data-engineer.md
│   ├── designer.md
│   ├── devops.md
│   ├── empty.md
│   ├── mobile.md
│   ├── performance.md
│   ├── product.md
│   ├── security.md
│   └── technical-writer.md
├── examples/rules/             # Example TTSR rule files
│   ├── no-console-log.md
│   └── no-node-fetch.md
├── skills/
│   ├── implement-feature/      # End-to-end feature implementation
│   ├── review-code/            # Code review via QA agent
│   └── debug-issue/            # Systematic debugging workflow
├── prompts/
│   ├── implement.md            # /implement {{task}}
│   ├── review.md               # /review {{target}}
│   └── scout-and-plan.md       # /scout-and-plan {{goal}}
└── themes/
    └── cortex.json             # Tokyo Night color theme
```

## Extensions

### Team Orchestration (`extensions/team/`)

Registers a `team` tool and `/team` command. Spawns isolated `pi` subprocesses per agent.

- **Actions**: `run` (single agent), `parallel` (concurrent tasks), `chain` (sequential with `{previous}` placeholder), `list`
- **Tmux integration**: When running inside tmux, subagents can be displayed in split panes
- **Agent discovery** (later wins, full override by name):
  1. Package-bundled (`cortex/agents/`) — defaults
  2. User-global (`~/.pi/agent/agents/`) — personal overrides
  3. Pi project-local (`.pi/agents/`) — walks up directory tree
  4. Cortex project-local (`.cortex/agents/`) — project root only, highest priority

Agents are defined as markdown files with YAML frontmatter: `name`, `description`, `tools`, `model`, `thinking`.

### Task Management (`extensions/todos/`)

Registers a `todo` tool and `/tasks` command. Persists as markdown files in `.cortex/todos/`.

Each todo has three sections:
1. **Title** (frontmatter) — brief name
2. **Description** (markdown) — what and why
3. **Plan** (markdown) — full implementation document with context, numbered change sections, file paths, code snippets, and verification steps

**Actions**: `create`, `update`, `list`, `get`, `set-description`, `set-plan`, `delete`, `refine`

**Refine flow**: Agent asks clarifying questions → `/answer` Q&A TUI auto-triggers → agent updates description and plan.

**`/tasks` TUI navigation**:
- `↑`/`↓` — navigate tasks
- `Enter` or `w` — work on selected task
- `r` — refine selected task (Q&A flow)
- `Esc` or `Ctrl+C` — quit

### Git Worktrees (`extensions/worktree/`)

Registers a `worktree` tool for isolated git worktrees per todo.

- **create** — creates a worktree with branch `todo/<id>-<slug>`
- **commit** — stages and commits all changes in a worktree
- **merge** — merges a todo branch into the base branch
- **remove** — cleans up a worktree and optionally its branch
- **list** — shows all active worktrees

Worktrees live in `.cortex/worktrees/` and keep feature work isolated from your main working copy.

### Q&A Flow (`extensions/answer/`)

Registers `/answer` command and `Ctrl+.` shortcut.

Extracts questions from the last assistant message using a fast model, presents an interactive TUI to navigate and answer them, then sends compiled answers back and triggers a new turn. Automatically triggered after todo refinement.

### Code Review (`extensions/review/`)

Registers `report_finding` and `submit_review` tools plus a `/review` command.

- **`report_finding`** — file a finding with priority (P0=critical, P1=major, P2=moderate, P3=nit), confidence score, file path, and line range
- **`submit_review`** — submit final verdict (`approve`, `request-changes`, `comment`) with summary
- `/review` command provides interactive mode selection for reviewing branches, diffs, or files

### LSP Integration (`extensions/lsp/`)

Registers an `lsp` tool and `/lsp` command. Provides IDE-like code intelligence to agents.

**Capabilities**: diagnostics, go-to-definition, type-definition, references, hover, symbols, rename, code actions, format.

- Auto-discovers language servers from `node_modules/.bin`, `.venv/bin`, and `PATH`
- Hooks into `write`/`edit` to show diagnostics after file changes
- Default configurations for common languages (TypeScript, Python, Go, Rust, etc.)
- `/lsp` — show status; `/lsp restart` — restart all servers

### Knowledge (`extensions/knowledge/`)

Autonomous long-term memory that extracts durable knowledge from past sessions.

**Two-phase pipeline**:
1. **Per-session extraction** — technical decisions, patterns, pitfalls
2. **Cross-session consolidation** — builds `KNOWLEDGE.md` and a compact summary

Injected into new sessions via `before_agent_start` hook. Storage in `.cortex/knowledge/`.

**Commands**:
- `/knowledge` — show current knowledge summary
- `/knowledge status` — extraction stats
- `/knowledge rebuild` — force rebuild from all sessions
- `/knowledge clear` — delete all knowledge data

**Configuration** via `.cortex/config.json`:
```json
{ "knowledge": { "enabled": true } }
```

### Memory (`extensions/memory/`)

Preserves cortex context across pi compaction cycles.

Before compaction, snapshots active todos, worktrees, team outputs, and file operations to `.cortex/memory/session-state.json`. After compaction, injects a concise restoration message so the agent continues with awareness of prior context.

### TTSR Rules (`extensions/ttsr/`)

Time Traveling Streamed Rules — zero context-cost rules that inject themselves only when the model starts generating matching output.

**How it works**: Rules define regex triggers that watch the model's output stream. When a pattern matches, the stream aborts, the rule injects as a system reminder, and the request retries. Each rule fires only once per session.

**Rule format** — markdown with YAML frontmatter:
```yaml
---
name: no-console-log
description: Use structured logging instead of console.log
ttsrTrigger: "console\\.log\\("
---

Do NOT use `console.log()` for logging in production code.
Use the project's structured logger instead.
```

**Rule locations**:
- `.cortex/rules/` — project-level rules
- `~/.cortex/rules/` — user-global rules

**Commands**: `/rules` — list rules; `/rules status` — show which rules have fired

See `examples/rules/` for sample rules.

### Security Guard (`extensions/security/`)

Three-layer defense system that protects agents from executing dangerous commands, leaking credentials, and following malicious instructions.

**Layer 1 — Pre-execution gate (`tool_call` hook)**: Scans bash commands and file paths before tools execute. Blocks dangerous patterns immediately.

**Layer 2 — Content scanner (`tool_result` hook)**: Scans file contents and command output for prompt injection patterns. Strips matched injections before they reach the agent's context.

**Layer 3 — System prompt hardening (`before_agent_start` hook)**: Appends security rules instructing the agent to never follow embedded instructions that ask it to ignore rules or reveal prompts.

**Default rules**:
- **Blocked commands**: `rm -rf /`, `rm -rf ~`, `curl|bash`, `sudo`, `mkfs`, fork bombs
- **Protected paths** (write-only): `.ssh/`, `.aws/`, `.gnupg/`, `.kube/config`, `.env.production`
- **Injection detection**: instruction overrides, role hijacking, prompt extraction
- **Allowlist**: `curl localhost`, `rm -rf node_modules`, `rm -rf dist`, etc.

**Configuration**: Customize via `.cortex/security-policy.json`:
```json
{
  "enabled": true,
  "commands": [
    { "pattern": "rm\\s+-[rf]*[rf][rf]*\\s+[/~.]", "severity": "block", "category": "destructive", "description": "Recursive rm on system paths" }
  ],
  "protected_paths": [...],
  "injection_patterns": [...],
  "allowlist_commands": [...]
}
```

**Commands**: `/security status` — stats + policy; `/security log` — recent audit entries; `/security reload` — re-read policy

**Audit log**: `.cortex/security-audit.log` (1MB max, auto-rotates to `.bak`)

### Providers (`extensions/providers/`)

Multi-account provider management. Configure multiple API keys per provider (e.g., Anthropic Work + Anthropic Personal) and assign them to agents.

**Config files** (project overrides global):
- `~/.cortex/providers.json` — user-global (stores raw API keys)
- `.cortex/providers.json` — project-local (env var references only, safe to commit)

**Command**: `/providers` — list, add, remove, reload accounts

### Completion Reports (`extensions/report/`)

Generates completion reports after worktree merges — includes file changes, diffs, and agent activity summaries.

**Command**: `/report [todo-id]` — view report for a specific todo (most recent if no ID)

### Enhanced Footer (`extensions/footer/`)

Replaces the default footer with a segmented status bar showing:
- Model name (magenta)
- Working directory (cyan)
- Git branch with dirty/staged/untracked indicators (green/yellow)
- Token stats, cost, and context % with threshold coloring
- Responsive: drops segments gracefully on narrow terminals

### Welcome Screen (`extensions/welcome/`)

Branded startup screen with Pi logo, tips, and recent sessions. Shown once at startup, replaced when the user starts typing.

### Escape Cancel (`extensions/escape-cancel/`)

Double-tap `ESC` within 400ms to cancel all running operations — main agent stream and all subagent processes.

### Tool Repair (`extensions/tool-repair/`)

Validates tool call arguments before execution to prevent JSON streaming errors from breaking agent workflows. Catches truncated/malformed JSON in `edit` and `write` tools and returns clear retry messages.

## Team Members

Cortex includes 5 specialized agents:

### 👔 Team Lead
**Role**: Orchestrator and coordinator
**Tools**: `read`, `grep`, `find`, `ls`, `bash`, `worktree`, `team`
**Model**: claude-sonnet-4-5

Analyzes requirements, breaks them into tasks, creates implementation plans, and coordinates other team members. Reviews plans before implementation and validates completion. Does not write code — focuses on coordination and quality gates.

### ⚙️ Backend Developer
**Role**: Server-side implementation
**Tools**: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`, `lsp`
**Model**: claude-sonnet-4-5

Implements APIs, database schemas, backend business logic, and server infrastructure. Has LSP access for code intelligence.

### 🎨 Frontend Developer
**Role**: UI and client-side implementation
**Tools**: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`, `lsp`
**Model**: claude-sonnet-4-5

Implements UI components, client-side logic, styling, responsive design, and accessibility. Has LSP access for code intelligence.

### 🏗️ Architect
**Role**: System design and planning
**Tools**: `read`, `grep`, `find`, `ls` (read-only)
**Model**: claude-sonnet-4-5 with high thinking budget

Analyzes codebases, understands architecture, and designs detailed implementation plans with context, numbered change sections, file paths, code snippets, and verification steps. Does not write code.

### 🔍 QA Specialist
**Role**: Testing and code review
**Tools**: `read`, `grep`, `find`, `ls`, `bash`, `report_finding`, `submit_review`
**Model**: claude-sonnet-4-5 with high thinking budget

Reviews code for correctness, security, and maintainability. Uses structured review tools to file findings with priority levels (P0–P3) and confidence scores, then submits a verdict.

## Agent Templates

Cortex includes 9 agent templates in `templates/agents/` to help you create custom agents for your project:

| Template | Description |
|----------|-------------|
| `data-engineer` | Databases, ETL pipelines, data models, migrations |
| `designer` | UI/UX review, accessibility, design system consistency |
| `devops` | CI/CD, infrastructure, containerization, deployments |
| `empty` | Blank template to start from scratch |
| `mobile` | iOS/Android with native or cross-platform frameworks |
| `performance` | Profiling, optimization, load testing |
| `product` | Requirements analysis, user stories, scope management |
| `security` | Vulnerability review, dependency audits, auth flow validation |
| `technical-writer` | Documentation, API docs, READMEs, changelogs, ADRs |

### Using Templates

Copy a template to your project's `.cortex/agents/` directory and customize:

```bash
mkdir -p .cortex/agents
cp $(pi root)/cortex/templates/agents/devops.md .cortex/agents/
# Edit .cortex/agents/devops.md to customize for your project
```

The agent will appear in `team list` and can be assigned tasks like any built-in agent.

### Per-Project Agent Overrides

Override built-in agents by creating a file with the same name in `.cortex/agents/`:

```bash
# Override backend dev for a Python/FastAPI project
cp $(pi root)/cortex/templates/agents/empty.md .cortex/agents/dev-backend.md
# Edit to add Python-specific instructions
```

**Agent discovery order** (later wins):
1. **Package-bundled** (`cortex/agents/`) — defaults
2. **User-global** (`~/.pi/agent/agents/`) — personal overrides
3. **Pi project-local** (`.pi/agents/`) — walks up directory tree
4. **Cortex project-local** (`.cortex/agents/`) — project root only, highest priority

Use `team list` to see all available agents and their sources.

## Skills

### 🚀 implement-feature

**Command**: `/implement {{task}}`

Coordinates the full lifecycle:
1. Architect creates detailed implementation plan
2. Team lead reviews and approves plan
3. Creates isolated git worktree for the feature
4. Delegates implementation to appropriate developers
5. QA reviews the implementation
6. Team lead validates completion against plan
7. Finalizes todo and cleans up worktree

### 🔍 review-code

**Command**: `/review {{target}}`

Delegates to the QA agent to review uncommitted changes, branches, pull requests, or specific files. Produces structured reviews with verdict, findings (P0–P3), and recommendations.

### 🐛 debug-issue

Systematic debugging process:
1. Gather context (errors, stack traces, reproduction steps)
2. Architect analyzes and identifies root causes
3. Create todo with fix plan
4. Developer implements fix
5. QA verifies the fix
6. Finalize todo

## TTSR Rules

Time Traveling Streamed Rules let you enforce coding standards with zero context cost. Rules are invisible to the agent until it starts generating output that matches a trigger — then the rule fires, the output resets, and the agent retries with the rule injected.

### Writing Rules

Create a markdown file with YAML frontmatter:

```yaml
---
name: no-console-log
description: Use structured logging instead of console.log
ttsrTrigger: "console\\.log\\("
---

Do NOT use `console.log()` for logging in production code.
Use the project's structured logger instead:
- `logger.debug()`, `logger.info()`, `logger.warn()`, `logger.error()`
```

### Rule Locations

- **Project rules**: `.cortex/rules/*.md`
- **User-global rules**: `~/.cortex/rules/*.md`

See `examples/rules/` for more examples.

## Usage Examples

### Full Feature Implementation

```
You: /implement Add pagination to the users API with page size and page number parameters

Cortex:
1. Runs architect to analyze codebase
2. Creates todo with plan:
   - Modify users controller (line 45, add pagination params)
   - Update users repository (add limit/offset to query)
   - Add pagination response wrapper
   - Write tests for pagination edge cases
3. Team lead approves plan
4. Creates worktree: .cortex/worktrees/todo-001-add-pagination-to-users-api
5. Backend developer implements changes in worktree
6. QA reviews with report_finding/submit_review tools
7. Team lead confirms all plan items completed
8. Todo marked done, worktree merged and cleaned up
```

### Code Review

```
You: /review the changes on the feature/websocket-notifications branch

Cortex:
1. QA agent diffs: git diff main...feature/websocket-notifications
2. Files findings using report_finding tool:
   - [P0] Authentication not checked before WebSocket connections — server/ws.ts:23
   - [P1] Connections not cleaned up on disconnect — server/ws.ts:67
   - [P3] Missing rate limiting for message frequency
3. Submits review: request-changes (P0/P1 must be fixed)
```

### Using the Team Tool Directly

Run a single agent:
```
team run architect "Analyze the authentication system in this codebase"
```

Run developers in parallel:
```
team parallel tasks=[
  {agent: "dev-backend", task: "Add rate limiting middleware"},
  {agent: "dev-frontend", task: "Add loading spinner to user list"}
]
```

Chain tasks sequentially:
```
team chain steps=[
  {agent: "architect", task: "Design a caching strategy for the API"},
  {agent: "dev-backend", task: "Implement the caching strategy: {previous}"}
]
```

### Todo Refinement

```
You: /tasks
(selects "Add real-time notifications", presses 'r')

Team Lead: I need to clarify:
1. What events should trigger notifications?
2. Should they persist across sessions?
3. Expected delivery latency?

(Ctrl+. auto-triggers — Q&A TUI appears)

Q1: What events? → New messages, friend requests, system announcements
Q2: Persist?     → Yes, show unread on login
Q3: Latency?     → Under 1 second for online users

[Submits answers → Team lead updates todo with detailed plan]
```

## Configuration

### Enable/Disable Resources

```bash
pi config
```

Enable or disable extensions, skills, prompts, and themes individually.

### Hot Reload Extensions

After modifying extension code:
```
/reload
```

### Data Directory

Cortex creates a `.cortex/` directory in your project:

```
.cortex/
├── todos/                  # Todo markdown files
├── worktrees/              # Isolated git worktrees per todo
├── knowledge/              # Long-term knowledge base
├── memory/                 # Compaction state snapshots
├── rules/                  # Project-level TTSR rules
├── agents/                 # Project-level agent overrides
├── security-audit.log      # Security event log
├── security-policy.json    # Custom security rules (optional)
├── providers.json          # Project-local provider config (optional)
└── config.json             # Extension configuration (optional)
```

Add `.cortex/worktrees/` to your `.gitignore`.

## Contributing

### Areas for Contribution

- **New agents**: Add specialized agents via templates
- **New skills**: Create workflows for common tasks (refactoring, migration, etc.)
- **TTSR rules**: Share coding standard rules
- **Extension improvements**: Enhance existing extensions
- **Documentation**: Improve guides, add examples
- **Bug fixes**: Report and fix issues

### Development Setup

1. Clone the repository
2. Install as a local pi package: `pi install /path/to/cortex`
3. Make changes to extensions, agents, or skills
4. Test with `/reload` in an active pi session
5. Submit a pull request

### Extension Development

Extensions use the pi Extension API:

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
export default function (pi: ExtensionAPI) {
  pi.registerTool({ name, description, parameters, execute });
  pi.registerCommand(name, { description, handler });
  pi.on(event, handler);
}
```

See `extensions/` for examples. Refer to the [pi documentation](https://github.com/mariozechner/pi-coding-agent) for full API details.

---

Built with [pi](https://github.com/mariozechner/pi-coding-agent) — the extensible AI coding agent harness.
