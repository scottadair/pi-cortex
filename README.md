# Cortex

[![pi package](https://img.shields.io/badge/pi-package-blue)](https://github.com/mariozechner/pi-coding-agent)

> An AI development team for [pi](https://github.com/mariozechner/pi-coding-agent) — specialized agents that collaborate to implement features, review code, and debug issues.

## What is Cortex?

Cortex turns pi into a multi-agent development team. Instead of one AI assistant, you get specialized agents — backend dev, frontend dev, architect, QA, and team lead — that coordinate on your codebase like a real engineering team.

## Installation

```bash
git clone https://github.com/yourusername/cortex.git
cd cortex
pi install .
pi config  # enable extensions, skills, prompts, theme
```

## Quick Start

```bash
pi
```

**Implement a feature** — architect plans, developers build, QA reviews:
```
/implement Add a search API endpoint that filters users by name and email
```

**Review code** — structured findings with priority levels:
```
/review the feature/search branch
```

**Scout and plan** — analyze architecture before making changes:
```
/scout-and-plan How would we add real-time notifications?
```

**Debug an issue** — systematic root cause analysis and fix:
```
/debug Users are getting 500 errors on the /api/orders endpoint
```

## Team Members

| Agent | Role | Capabilities |
|-------|------|-------------|
| 👔 **Team Lead** | Orchestrator | Breaks down tasks, coordinates agents, validates completion |
| ⚙️ **Backend Dev** | Server-side code | APIs, databases, business logic, with LSP support |
| 🎨 **Frontend Dev** | Client-side code | UI components, styling, accessibility, with LSP support |
| 🏗️ **Architect** | System design | Codebase analysis, detailed implementation plans (read-only) |
| 🔍 **QA** | Testing & review | Code review with structured findings P0–P3 (read-only + bash) |

## Key Features

### Team Orchestration
Run agents individually, in parallel, or chained sequentially. Each agent runs in an isolated subprocess with its own tools and context.

### Task Management (`/tasks`)
Todos with rich implementation plans — not just checklists, but full documents with context, file paths, code snippets, and verification steps. Refine plans through interactive Q&A (`Ctrl+.`).

### Git Worktrees
Each todo gets an isolated git branch and working directory. Implement features without touching your main working copy.

### Code Intelligence (LSP)
Go-to-definition, references, hover, diagnostics, rename, and formatting. Auto-discovers language servers for TypeScript, Python, Go, Rust, and more.

### Security Guard
Three-layer defense: blocks dangerous commands before execution, strips prompt injection from file contents, and hardens system prompts. Full audit log. Configurable via `.cortex/security-policy.json`.

### Long-term Knowledge
Extracts durable insights from past sessions and injects them into new ones. Your agents learn about your codebase over time.

### TTSR Rules
Zero context-cost coding standards. Rules stay invisible until the model starts generating matching output — then they fire and the model retries with the rule injected. Add rules to `.cortex/rules/`.

## Commands

| Command | Description |
|---------|-------------|
| `/implement {{task}}` | Full feature workflow |
| `/review {{target}}` | Code review |
| `/scout-and-plan {{goal}}` | Architecture analysis |
| `/tasks` | Task management TUI |
| `/answer` / `Ctrl+.` | Answer agent questions |
| `/security status` | Security guard status |
| `/lsp` | LSP status |
| `/knowledge` | Knowledge management |
| `/rules` | TTSR rules status |
| `/providers` | API key management |
| `ESC ESC` | Cancel all operations |

## Customization

### Custom Agents

Override built-in agents or add new ones by placing markdown files in `.cortex/agents/`:

```yaml
---
name: my-agent
description: What this agent does
tools: read, write, edit, bash, grep, find, ls
model: claude-sonnet-4-5
thinking: high
---

System prompt for the agent...
```

**Discovery order** (later wins): package defaults → `~/.pi/agent/agents/` → `.pi/agents/` → `.cortex/agents/`

### Agent Templates

9 ready-made templates in `templates/agents/` — data-engineer, designer, devops, mobile, performance, product, security, technical-writer, and a blank template.

```bash
mkdir -p .cortex/agents
cp $(pi root)/cortex/templates/agents/devops.md .cortex/agents/
```

### TTSR Rules

```yaml
---
name: no-console-log
description: Use structured logging instead of console.log
ttsrTrigger: "console\\.log\\("
---

Do NOT use `console.log()`. Use the project's structured logger instead.
```

Place in `.cortex/rules/` (project) or `~/.cortex/rules/` (global).

## Project Data

Cortex stores data in `.cortex/` at your project root:

```
.cortex/
├── todos/              # Task files
├── worktrees/          # Isolated git worktrees (add to .gitignore)
├── knowledge/          # Long-term memory
├── rules/              # TTSR rules
├── agents/             # Agent overrides
└── security-audit.log  # Security events
```

## Development

```bash
pi install /path/to/cortex   # install locally
/reload                       # hot-reload after changes
pi config                     # enable/disable resources
```

Extensions use the [pi Extension API](https://github.com/mariozechner/pi-coding-agent):

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
export default function (pi: ExtensionAPI) {
  pi.registerTool({ name, description, parameters, execute });
  pi.registerCommand(name, { description, handler });
  pi.on(event, handler);
}
```

---

Built with [pi](https://github.com/mariozechner/pi-coding-agent).
