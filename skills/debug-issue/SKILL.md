---
name: debug-issue
description: |
  Systematic debugging workflow. Analyzes error context, maps relevant code,
  forms and tests hypotheses, then implements and verifies a fix with team
  lead oversight. Use when investigating bugs or unexpected behavior.
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

## 4. Plan Review
Run the **team-lead** to review the fix plan before implementation:

```
team run team-lead "Review this fix plan for: <bug description>. The plan is:

<architect's plan>

Evaluate completeness of root cause analysis, feasibility of fix, and risk of regressions. Output your verdict as APPROVED or REVISE."
```

- If **APPROVED**, proceed to step 5.
- If **REVISE**, pass feedback to the architect for one revision, update the todo plan, and re-review. Max 1 revision round.

## 5. Implement Fix
Run the appropriate developer agent, referencing the plan:

```
team run dev-backend "Fix the bug per the plan: <specific change section>"
```

## 6. Verify
Run QA to verify the fix:

```
team run qa "Verify the fix for: <bug description>. Run relevant tests and confirm the bug is resolved without regressions."
```

## 7. Completion Validation
Run the **team-lead** to validate the fix matches the plan:

```
team run team-lead "Validate this bug fix against the plan. The plan was:

<plan from todo>

QA verification result:

<QA output>

Check that the root cause was addressed and QA issues were resolved. Run `git diff` to inspect the changes. Output your verdict as APPROVED or NEEDS WORK."
```

- If **APPROVED**, proceed to step 8.
- If **NEEDS WORK**, pass gaps to the developer, re-run QA, re-validate. Max 1 rework round.

## 8. Finalize
Update the todo status:
```
todo update id="<id>" status="done"
```
