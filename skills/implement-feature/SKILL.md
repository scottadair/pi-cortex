---
name: implement-feature
description: |
  End-to-end feature implementation workflow. Scouts the codebase, creates an
  implementation plan, implements in stages with the appropriate developer, and
  runs QA review. Use when asked to implement a new feature or make substantial changes.
---

# Implement Feature Workflow

Follow these steps to implement a feature end-to-end:

## 1. Analyze and Plan
Use the `team` tool to run the **architect** agent with the feature requirements. The architect will analyze the codebase and produce a detailed implementation plan.

```
team run architect "Analyze the codebase and create an implementation plan for: <feature description>"
```

## 2. Save the Plan
Use the `plan` tool to save the architect's output as a persistent plan:

```
plan create title="<feature name>" goal="<goal>" steps=["step 1", "step 2", ...]
plan update id="<plan-id>" status="active"
```

## 3. Create Tasks
For each plan step, create a todo assigned to the appropriate team member:

```
todo create title="<step description>" assignee="dev-backend" priority="high"
```

Use `dev-backend` for server-side work and `dev-frontend` for UI work.

## 4. Implement
Run the appropriate developer agent for each task:

```
team run dev-backend "<specific task with context from the plan>"
team run dev-frontend "<specific task with context from the plan>"
```

Mark todos as done after each step:
```
todo update id="<id>" status="done"
plan complete-step id="<plan-id>" step_number=<n>
```

## 5. QA Review
After implementation, run the QA agent to review all changes:

```
team run qa "Review the implementation of <feature>. Run tests and check for issues."
```

## 6. Finalize
Update plan status to completed when all steps are done and QA passes.
