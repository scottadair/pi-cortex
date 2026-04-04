# Memory Cycle Extension

Preserves cortex-specific context across pi compaction cycles.

## What It Does

Before compaction:
- Snapshots active todos, worktrees, team outputs, and file operations
- Saves to `.cortex/memory/session-state.json`

After compaction:
- Injects a concise restoration message into the next LLM call
- Agent continues with awareness of prior context

## Hook Flow

```
User fills context → pi triggers compaction
    ↓
session_before_compact → extract state → save JSON
    ↓
session_compact → set needsRestoration flag
    ↓
User sends next message → context hook fires
    ↓
context → load state → prepend restoration message → clear flag
    ↓
LLM receives restored context → agent continues seamlessly
```

## Usage

### View Current State
```bash
/memory
```

### Manual Save
```bash
/memory save
```

### Clear State
```bash
/memory clear
```

## Storage

**Location**: `.cortex/memory/session-state.json`

**Format**:
```json
{
  "savedAt": "2026-04-04T20:16:23.000Z",
  "activeTodos": [
    { "id": "005", "title": "Feature X", "status": "in-progress", "hasPlan": true }
  ],
  "activeWorktrees": [
    { "branch": "todo/005-feature-x", "path": ".cortex/worktrees/todo-005-feature-x" }
  ],
  "recentTeamOutputs": [
    { "agent": "architect", "file": "architect-20260404-143035.md", "timestamp": "20260404-143035" }
  ],
  "fileOps": {
    "readFiles": ["src/foo.ts"],
    "writtenFiles": ["src/bar.ts"],
    "editedFiles": ["src/baz.ts"]
  }
}
```

## Restoration Message Example

```
[Cortex Memory — restored after context compaction]

**Active Todos:**
- #005 "Feature X" (in-progress) [has plan]
- #008 "Bug fix" (todo)

**Active Worktrees:**
- todo/005-feature-x → .cortex/worktrees/todo-005-feature-x

**Recent Team Activity:**
- architect (14:30)
- dev-backend (14:35)

**Files Modified:** src/foo.ts, src/bar.ts (+3 more)
**Files Read:** src/baz.ts, README.md

Continue your current task with this context in mind.
```

**Size**: < 500 tokens (limits applied automatically)

## Dependencies

- **todos extension**: Imports `readAllTodos()` to discover active todos
- **git**: Runs `git worktree list --porcelain` to discover worktrees
- **team extension**: Reads `.cortex/team-outputs/` directory (no import)

## Error Handling

All operations gracefully degrade:
- Missing todos → empty list
- No git → no worktrees
- Missing team outputs → empty list
- Corrupted state file → treated as missing
- Filesystem errors → silently ignored

Memory is non-critical infrastructure. Failures never crash the session.

## Status Bar

Shows "💾 Memory" when state exists, cleared otherwise.

## Architecture Notes

### Why `context` hook?

The `context` hook modifies messages in-flight without creating persistent session entries. This is cleaner than `sendMessage` which would create a permanent entry and trigger a new turn.

### Why one-time restoration?

The `needsRestoration` flag is set during `session_compact` and cleared immediately after the first `context` hook fires. This ensures restoration happens exactly once per compaction, on the first LLM call.

### Why no LLM summarization?

We piggyback on pi's built-in compaction. We only preserve *cortex domain state* (todos, worktrees, team outputs) that pi doesn't inherently track.

## Implementation Details

**File**: `extensions/memory/index.ts` (380 lines)

**Key functions**:
- `getActiveTodos()` — via todos extension import
- `getActiveWorktrees()` — git worktree list parser
- `getRecentTeamOutputs()` — directory scan + filename parse
- `saveState()` / `loadState()` — JSON persistence
- `buildRestorationMessage()` — concise markdown builder
- `updateStatusBar()` — UI integration

**Registered hooks**:
- `session_before_compact`
- `session_compact`
- `context`
- `session_start`
- `session_switch`

**Registered commands**:
- `/memory` (default, save, clear)

## Future Enhancements

- Memory analytics (`/memory stats`)
- Selective restoration (`/memory restore todos`)
- Memory history (keep last N states)
- Cross-session memory (restore on switch)
- Memory compression (group files by directory)
