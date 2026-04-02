---
name: implement-feature
description: |
  End-to-end feature implementation workflow. Creates a todo with description
  and a full implementation plan, implements with the appropriate developers,
  and runs QA review with team lead oversight. Use when asked to implement a
  new feature or make substantial changes.
---

# Implement Feature Workflow

Follow these steps to implement a feature end-to-end:

## 1. Analyze and Plan
Use the `team` tool to run the **architect** agent with the feature requirements. The architect will analyze the codebase and produce a detailed implementation plan.

```
team run architect "Analyze the codebase and create an implementation plan for: <feature description>"
```

## 2. Create a Todo with Plan
Use the `todo` tool to create a task. The architect's output is automatically saved to a file — use the file path shown in `[Full output saved to: <path>]` to save the full plan without copying it:

```
todo create title="<feature name>" description="<one-line summary>" plan_file="<path from architect output>"
```

## 3. Plan Review
Run the **team-lead** agent to review the architect's plan before implementation begins:

```
team run team-lead "Review this implementation plan for <feature>. The plan is:

<architect's plan>

Evaluate completeness, feasibility, scope, and risk. Output your verdict as APPROVED or REVISE."
```

- If the team lead's verdict is **APPROVED**, proceed to step 4.
- If the verdict is **REVISE**, pass the team lead's issues back to the architect:
  ```
  team run architect "Revise your plan based on this feedback: <team lead issues>. Original requirements: <feature description>"
  ```
  Update the todo's plan with the revised output (`todo set-plan id="<id>" plan_file="<path from revised architect output>"`), then re-run the team lead review. Allow at most 1 revision round — if still not approved after revision, proceed anyway.

## 4. Create Worktree
Create an isolated worktree for the implementation so changes happen on a separate branch:

```
worktree create todo_id="<id>" todo_title="<feature name>"
```

Note the returned worktree path — pass it as `cwd` to all subsequent team tool calls.

## 5. Implement
Run the appropriate developer agent for each change section in the plan, using the worktree `cwd`:

```
team run dev-backend "<specific task referencing the plan's change section>" cwd="<worktree path>"
team run dev-frontend "<specific task referencing the plan's change section>" cwd="<worktree path>"
```

## 6. QA Review
After implementation, run the QA agent to review all changes in the worktree:

```
team run qa "Review the implementation of <feature>. Run tests and check for issues." cwd="<worktree path>"
```

## 7. Completion Validation
Run the **team-lead** to validate the implementation matches the plan:

```
team run team-lead "Validate this implementation against the plan. The plan was:

<plan from todo>

QA review result:

<QA output>

Check that all planned changes were made and QA issues were addressed. Run `git diff` in the worktree to see actual changes. Output your verdict as APPROVED or NEEDS WORK." cwd="<worktree path>"
```

- If **APPROVED**, proceed to step 8.
- If **NEEDS WORK**, pass the team lead's gaps back to the appropriate developer:
  ```
  team run dev-backend "<specific gaps to address>" cwd="<worktree path>"
  ```
  Then re-run QA (step 6), then re-run team lead validation. Allow at most 1 rework round — if still not approved, proceed to finalize with a note about remaining gaps.

## 8. Commit & Merge
Commit all changes in the worktree and merge the branch back:

```
worktree commit todo_id="<id>" message="<feature name>: <brief summary>"
worktree merge todo_id="<id>"
```

## 9. Finalize
Update the todo status and clean up the worktree:

```
todo update id="<id>" status="done"
worktree remove todo_id="<id>"
```
