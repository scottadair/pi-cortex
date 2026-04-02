# Cortex

[![pi package](https://img.shields.io/badge/pi-package-blue)](https://github.com/mariozechner/pi-coding-agent)

> An AI development team system for pi — coordinate specialized agents to implement features, review code, and debug issues

## Overview

Cortex transforms pi into a full development team. Instead of working alone, you orchestrate specialized AI agents (backend dev, frontend dev, architect, QA, and team lead) who collaborate on your codebase. Each agent has specific tools, expertise, and responsibilities — just like a real engineering team.

Cortex ships as a single pi package containing:
- **Extensions** for team orchestration and task management
- **5 specialized agents** with distinct roles and capabilities
- **3 workflow skills** for feature implementation, code review, and debugging
- **Slash commands** for quick access to common workflows
- **Task management system** with rich plans, Q&A refinement, and isolated git worktrees

Whether you're building a new feature, fixing a bug, or reviewing a pull request, Cortex provides structured workflows that coordinate the right agents at the right time.

## Features

### 🤝 Team Orchestration
- **Run** individual agents for specific tasks
- **Parallel** execution for concurrent work
- **Chain** workflows where each step feeds into the next
- Isolated pi subprocesses per agent with full context

### ✅ Task Management
- Create todos with **title**, **description**, and **full implementation plan**
- Plans are rich documents with context, numbered change sections, file paths, code snippets, and verification steps
- **Refine** todos through interactive Q&A to clarify requirements
- Track status (`todo`, `in-progress`, `done`, `blocked`) and priority
- Integrated with git worktrees for isolated feature branches

### 🎯 Workflow Skills
- **implement-feature**: End-to-end feature implementation with planning, development, and QA review
- **review-code**: Structured code review workflow via QA agent
- **debug-issue**: Systematic debugging with root cause analysis and verification

### 🎨 Developer Experience
- Tokyo Night color theme
- `/tasks` TUI for browsing and managing todos
- `/answer` (or `Ctrl+.`) for Q&A refinement
- Hot-reload extensions with `/reload`

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

**Available Commands**:
- `/implement {{task}}` — Full feature implementation workflow
- `/review {{target}}` — Code review workflow
- `/scout-and-plan {{goal}}` — Explore architecture and create plan
- `/tasks` or `/todo` — Open task management TUI
- `/answer` or `Ctrl+.` — Answer agent questions in Q&A flow

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

The QA agent will analyze the code for correctness, security issues, quality, and test coverage.

### Example 3: Scout and Plan

Need to understand how to approach a complex change? Scout the codebase first:

```
/scout-and-plan How would we add real-time notifications to this app?
```

The architect will analyze your codebase, understand the architecture, and create a comprehensive plan.

## Team Members

Cortex includes 5 specialized agents, each with specific tools and responsibilities:

### 👔 Team Lead
**Role**: Orchestrator and coordinator  
**Tools**: `read`, `grep`, `find`, `ls`, `bash`, `worktree`, `team`  
**Model**: claude-sonnet-4-5

The team lead analyzes requirements, breaks them into tasks, creates implementation plans, and coordinates other team members. Reviews plans before implementation and validates completion. Does not write code directly — focuses on coordination and quality gates.

### ⚙️ Backend Developer
**Role**: Server-side implementation  
**Tools**: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`  
**Model**: claude-sonnet-4-5

Implements APIs, database schemas, backend business logic, and server infrastructure. Follows existing patterns, writes tests, and keeps changes focused on the assigned task.

### 🎨 Frontend Developer
**Role**: UI and client-side implementation  
**Tools**: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`  
**Model**: claude-sonnet-4-5

Implements UI components, client-side logic, styling, responsive design, and accessibility. Follows existing UI patterns and component structure.

### 🏗️ Architect
**Role**: System design and planning  
**Tools**: `read`, `grep`, `find`, `ls` (read-only)  
**Model**: claude-sonnet-4-5 with high thinking budget

Analyzes codebases, understands architecture, and designs detailed implementation plans. Plans include context, numbered change sections with file paths and code snippets, list of files to modify, and verification steps. Does not write code — focuses on design and planning.

### 🔍 QA Specialist
**Role**: Testing and code review  
**Tools**: `read`, `grep`, `find`, `ls`, `bash` (read-only + test execution)  
**Model**: claude-sonnet-4-5 with high thinking budget

Reviews code for correctness, security, and maintainability. Runs tests, identifies bugs and edge cases, validates implementations against requirements. Provides structured reviews with verdicts, issue severity, and specific recommendations.

## Skills

Skills provide structured workflows for common development tasks. Load a skill by referencing it in your prompt, or use the associated slash command.

### 🚀 implement-feature

**Purpose**: End-to-end feature implementation workflow  
**Command**: `/implement {{task}}`

Coordinates the full lifecycle:
1. Architect creates detailed implementation plan
2. Team lead reviews and approves plan
3. Creates isolated git worktree for the feature
4. Delegates implementation to appropriate developers
5. QA reviews the implementation
6. Team lead validates completion against plan
7. Finalizes todo and cleans up worktree

Use when you need to implement a new feature or make substantial changes.

### 🔍 review-code

**Purpose**: Structured code review workflow  
**Command**: `/review {{target}}`

Delegates to the QA agent to review:
- Uncommitted changes (`git diff`)
- Specific branches (`git diff main...branch`)
- Pull requests
- Specific files or folders

The QA agent provides a structured review with verdict (PASS/FAIL/NEEDS CHANGES), summary, issues with severity levels, suggestions, and test results.

Use when you need a thorough code review before merging.

### 🐛 debug-issue

**Purpose**: Systematic debugging workflow  
**Command**: Manual (no dedicated slash command)

Provides a structured debugging process:
1. Gather context (errors, stack traces, reproduction steps)
2. Architect analyzes and identifies root causes
3. Create todo with fix plan
4. Team lead reviews fix plan
5. Developer implements fix
6. QA verifies the fix
7. Team lead validates against plan
8. Finalize todo

Use when investigating bugs or unexpected behavior that require systematic analysis.

## Task Management

Cortex provides a powerful task management system integrated with git worktrees.

### Task Structure

Each todo has three sections:

1. **Title** (frontmatter): Brief name for the task
2. **Description** (markdown): What needs to be done and why
3. **Plan** (markdown): Full implementation document with:
   - Context: Why this change is needed
   - Changes: Numbered sections with specific file paths, line numbers, code snippets
   - Files to modify: List of affected files with rationale
   - Verification: How to build, test, and validate

### The /tasks TUI

Launch the tasks interface:

```
/tasks
```

Or use the alias:

```
/todo
```

**Keyboard Navigation**:
- `↑`/`↓`: Navigate tasks
- `Enter` or `w`: Work on selected task
- `r`: Refine selected task (Q&A flow)
- `Esc` or `Ctrl+C`: Quit

**Quick Actions**:
- `Ctrl+Shift+W`: Work on selected task (same as `Enter`)
- `Ctrl+Shift+R`: Refine selected task (same as `r`)

**Filtering**: Tasks show status (`todo`, `in-progress`, `done`, `blocked`) and priority (`high`, `medium`, `low`).

### The /answer Q&A Flow

When an agent asks clarifying questions, use `/answer` (or press `Ctrl+.`) to enter an interactive Q&A interface:

1. Agent asks questions in its response
2. You invoke `/answer` or press `Ctrl+.` (automatically triggered after todo refinement)
3. TUI extracts questions and lets you answer each one
4. Answers are sent back to the agent
5. Agent updates the todo description and plan based on your answers

This workflow is particularly useful during todo refinement (`r` key in `/tasks`) to build detailed plans collaboratively. Note that `/answer` is automatically triggered after you initiate a refinement.

### Git Worktrees

Cortex creates isolated git worktrees for each todo, allowing you to:
- Work on multiple features simultaneously
- Keep changes isolated on feature branches
- Avoid conflicts with your main working directory

**Create worktree**:
```typescript
worktree create todo_id="003" todo_title="Add search feature"
```

**Remove worktree** (after merging):
```typescript
worktree remove todo_id="003"
```

All team tool calls should pass the worktree path as `cwd` to work in the isolated branch.

## Usage Examples

### Example 1: Full Feature Implementation

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
6. QA reviews, runs tests, validates edge cases
7. Team lead confirms all plan items completed
8. Todo marked done, worktree cleaned up
```

### Example 2: Code Review

```
You: /review the changes on the feature/websocket-notifications branch

Cortex:
1. QA agent runs: git diff main...feature/websocket-notifications
2. Reviews code for:
   - Correctness: proper WebSocket connection handling
   - Security: no exposed secrets, proper auth checks
   - Quality: error handling, cleanup on disconnect
   - Tests: coverage for new WebSocket logic
3. Produces structured review with verdict and specific issues

QA Output:
**Verdict**: NEEDS CHANGES

**Summary**: The WebSocket implementation is mostly sound, but there are
two security issues and one potential memory leak.

**Issues Found**:
- [critical] Authentication not checked before allowing connections — server/ws.ts:23
- [major] WebSocket connections not cleaned up on disconnect — server/ws.ts:67
- [minor] Missing rate limiting for message frequency

**Suggestions**:
- Consider adding heartbeat/ping-pong for connection health

**Tests**: Existing tests pass, but missing tests for disconnect scenarios.
```

### Example 3: Using the Team Tool Directly

You can also call team members directly for ad-hoc tasks:

```
You: Run the architect to analyze how authentication works in this codebase

(uses team tool)
team run architect "Analyze the authentication system in this codebase. Map the flow from login request through token generation to protected route access."

Architect: [analyzes codebase and produces detailed explanation]
```

Or run developers in parallel:

```
(uses team tool)
team parallel tasks=[
  {agent: "dev-backend", task: "Add rate limiting middleware to /api/users"},
  {agent: "dev-frontend", task: "Add loading spinner to user list component"}
]
```

Or chain tasks:

```
(uses team tool)
team chain steps=[
  {agent: "architect", task: "Design a caching strategy for the API"},
  {agent: "dev-backend", task: "Implement the caching strategy from: {previous}"}
]
```

### Example 4: Todo Refinement

```
You: /tasks
(selects "Add real-time notifications")
(presses 'r' for refine)

Team Lead: I need to clarify the requirements for real-time notifications:

1. What events should trigger notifications?
2. Should notifications persist across sessions?
3. What's the expected notification delivery latency?
4. Should users be able to configure notification preferences?

You: (presses Ctrl+.)

[Q&A TUI appears]

Q1: What events should trigger notifications?
A1: New messages, friend requests, and system announcements

Q2: Should notifications persist across sessions?
A2: Yes, show unread notifications when user logs in

Q3: What's the expected notification delivery latency?
A3: Under 1 second for online users

Q4: Should users be able to configure notification preferences?
A4: Yes, users should be able to enable/disable each notification type

[Submits answers]

Team Lead: [updates todo description and creates detailed plan based on answers]
```

## Configuration

### Enable/Disable Resources

Use `pi config` to manage which Cortex resources are active:

```bash
pi config
```

You can enable/disable:
- Extensions (team, todos)
- Skills (implement-feature, review-code, debug-issue)
- Prompts (/implement, /review, /scout-and-plan)
- Theme (Tokyo Night)

### Hot Reload Extensions

After modifying extension code, reload without restarting pi:

```
/reload
```

### Data Directory

Cortex creates a `.cortex/` directory in your project:

```
.cortex/
├── todos/          # Todo markdown files (title, description, plan)
└── worktrees/      # Isolated git worktrees per todo
```

Add `.cortex/worktrees/` to your `.gitignore` to avoid committing temporary branches.

## Contributing

Contributions are welcome! Here's how to get involved:

### Areas for Contribution

- **New agents**: Add specialized agents (e.g., devops, designer, security)
- **New skills**: Create workflows for common tasks (e.g., refactoring, migration)
- **Extension improvements**: Enhance team orchestration or task management
- **Documentation**: Improve guides, add examples, write tutorials
- **Bug fixes**: Report and fix issues

### Development Setup

1. Clone the repository
2. Install as a local pi package: `pi install /path/to/cortex`
3. Make changes to extensions, agents, or skills
4. Test with `/reload` in an active pi session
5. Submit a pull request

### Guidelines

- Follow existing code patterns and conventions
- Keep agents focused on specific roles
- Write clear commit messages
- Test workflows end-to-end before submitting
- Update documentation for user-facing changes

### Extension Development

Extensions use the pi Extension API. See `extensions/team/index.ts` and `extensions/todos/index.ts` for examples.

Key APIs:
- `pi.registerTool()` — add tools for agents to use
- `pi.registerCommand()` — add slash commands
- `pi.on()` — handle lifecycle events

Refer to the [pi documentation](https://github.com/mariozechner/pi-coding-agent) for full API details.

---

Built with [pi](https://github.com/mariozechner/pi-coding-agent) — the extensible AI coding agent harness.
