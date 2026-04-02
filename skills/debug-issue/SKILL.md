---
name: debug-issue
description: |
  Systematic debugging workflow. Analyzes error context, maps relevant code,
  forms and tests hypotheses, then implements and verifies a fix.
  Use when investigating bugs or unexpected behavior.
---

# Debug Issue Workflow

## 1. Gather Context
Understand the bug by collecting information:
- Error messages, stack traces, or unexpected behavior descriptions
- Steps to reproduce
- Which parts of the codebase are likely involved

## 2. Analyze
Use the `team` tool to run the **architect** agent for analysis:

```
team run architect "Analyze this bug: <description>. Find the relevant code, trace the execution path, and identify likely root causes."
```

## 3. Create a Todo with Fix Plan
Save the analysis as a todo with a full plan document:

```
todo create title="Fix: <bug description>" description="<root cause summary>" plan="<full plan with Context, Root Cause, Changes (specific files/lines/code), Verification>"
```

## 4. Implement Fix
Run the appropriate developer agent, referencing the plan:

```
team run dev-backend "Fix the bug per the plan: <specific change section>"
```

## 5. Verify
Run QA to verify the fix:

```
team run qa "Verify the fix for: <bug description>. Run relevant tests and confirm the bug is resolved without regressions."
```
