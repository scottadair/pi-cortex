---
name: implement-feature
description: |
  End-to-end feature implementation workflow. Creates a todo with description
  and a full implementation plan, implements with the appropriate developers,
  and runs QA review. Use when asked to implement a new feature or make
  substantial changes.
---

# Implement Feature Workflow

Follow these steps to implement a feature end-to-end:

## 1. Analyze and Plan
Use the `team` tool to run the **architect** agent with the feature requirements. The architect will analyze the codebase and produce a detailed implementation plan.

```
team run architect "Analyze the codebase and create an implementation plan for: <feature description>"
```

## 2. Create a Todo with Plan
Use the `todo` tool to create a task. Save the architect's full output as the plan — it should include Context, Changes (with numbered sections, file paths, code snippets), Files to modify, and Verification:

```
todo create title="<feature name>" description="<one-line summary>" plan="<full plan markdown from architect>"
```

## 3. Create Worktree
Create an isolated worktree for the implementation so changes happen on a separate branch:

```
worktree create todo_id="<id>" todo_title="<feature name>"
```

Note the returned worktree path — pass it as `cwd` to all subsequent team tool calls.

## 4. Implement
Run the appropriate developer agent for each change section in the plan, using the worktree `cwd`:

```
team run dev-backend "<specific task referencing the plan's change section>" cwd="<worktree path>"
team run dev-frontend "<specific task referencing the plan's change section>" cwd="<worktree path>"
```

## 5. QA Review
After implementation, run the QA agent to review all changes in the worktree:

```
team run qa "Review the implementation of <feature>. Run tests and check for issues." cwd="<worktree path>"
```

## 6. Finalize
Update the todo status when QA passes and clean up the worktree:
```
todo update id="<id>" status="done"
worktree remove todo_id="<id>"
```
