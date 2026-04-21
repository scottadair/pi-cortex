---
name: debug-issue
description: |
  Systematic debugging workflow. Analyzes error context, maps relevant code,
  forms and tests hypotheses, and produces a diagnosis first. Only implements
  a fix after the user explicitly approves code changes.
---

# Debug Issue Workflow

Use this workflow for bugs, incidents, and unexpected behavior. **Investigation is read-only by default.** If the user asks you to investigate, diagnose, troubleshoot, or explain what happened, stop after the diagnosis + plan unless they explicitly ask you to implement the fix.

## 1. Gather Context
Understand the bug by collecting information:
- Error messages, stack traces, or unexpected behavior descriptions
- Steps to reproduce
- Which parts of the codebase are likely involved
- Whether the user wants **diagnosis only** or already approves implementation

If the user intent is ambiguous, ask before editing anything.

## 2. Analyze
Use the `team` tool to run the **architect** agent for analysis:

```
team run architect "Analyze this bug: <description>. Find the relevant code, trace the execution path, and identify likely root causes. Do not edit code."
```

## 3. Create a Todo with Fix Plan
Save the analysis as a todo with a full plan document. The architect's output is automatically saved to a file — use the path shown in `[Full output saved to: <path>]`:

```
todo create title="Fix: <bug description>" description="<root cause summary>" plan_file="<path from architect output>"
```

## 4. Plan Review
Run the **team-lead** to review the fix plan before implementation:

```
team run team-lead "Review this fix plan for: <bug description>. The plan is:

<architect's plan>

Evaluate completeness of root cause analysis, feasibility of fix, and risk of regressions. Output your verdict as APPROVED or REVISE."
```

- If **APPROVED**, continue to step 5.
- If **REVISE**, pass feedback to the architect for one revision, update the todo plan, and re-review. Max 1 revision round.

## 5. Decide Whether to Implement
If the user asked to investigate, diagnose, troubleshoot, or explain what happened:
- Present the root cause
- Summarize the proposed fix
- Call out risks, follow-ups, and validation steps
- **Stop here** unless the user explicitly asks you to implement the fix

Do **not** edit code just because you found the bug.

If the user explicitly approves implementation, continue to step 6.

## 6. Create Worktree
Create an isolated worktree before any code changes:

```
worktree create todo_id="<id>" todo_title="Fix: <bug description>"
```

Note the returned worktree path — pass it as `cwd` to all subsequent `team` tool calls.

## 7. Implement Fix
Run the appropriate developer agent, referencing the plan and using the worktree `cwd`:

```
team run dev-backend "Fix the bug per the plan: <specific change section>" cwd="<worktree path>"
```

## 8. Verify
Run QA to verify the fix:

```
team run qa "Verify the fix for: <bug description>. Run relevant tests and confirm the bug is resolved without regressions." cwd="<worktree path>"
```

## 9. Completion Validation
Run the **team-lead** to validate the fix matches the plan:

```
team run team-lead "Validate this bug fix against the plan. The plan was:

<plan from todo>

QA verification result:

<QA output>

Check that the root cause was addressed and QA issues were resolved. Run `git diff` in the worktree to inspect the changes. Output your verdict as APPROVED or NEEDS WORK." cwd="<worktree path>"
```

- If **APPROVED**, proceed to step 10.
- If **NEEDS WORK**, pass gaps to the developer, re-run QA, and re-validate. Max 1 rework round.

## 10. Commit, Push & Open PR
Commit the worktree changes, push the branch, and open a PR from the worktree directory:

```
worktree commit todo_id="<id>" message="Fix <bug description>"
(
  cd "<worktree path>" &&
  git push -u origin <branch-name> &&
  GITHUB_TOKEN="" gh pr create --title "fix: <short description>" --body "<summary/details/test plan>" &&
  GITHUB_TOKEN="" gh pr merge --auto --squash <branch-name>
)
```

Do **not** use local merge as the normal workflow.

## 11. Finalize
Update the todo status and clean up the worktree after the PR is merged:

```
todo update id="<id>" status="done"
worktree remove todo_id="<id>"
```