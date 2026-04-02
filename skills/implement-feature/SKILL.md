---
name: implement-feature
description: |
  End-to-end feature implementation workflow. Creates a todo with description
  and plan, implements in stages with the appropriate developer, and runs QA
  review. Use when asked to implement a new feature or make substantial changes.
---

# Implement Feature Workflow

Follow these steps to implement a feature end-to-end:

## 1. Analyze and Plan
Use the `team` tool to run the **architect** agent with the feature requirements. The architect will analyze the codebase and produce a detailed implementation plan.

```
team run architect "Analyze the codebase and create an implementation plan for: <feature description>"
```

## 2. Create a Todo with Plan
Use the `todo` tool to create a task with the architect's plan saved as steps:

```
todo create title="<feature name>" description="<goal and context>" steps=["step 1", "step 2", ...] priority="high"
```

## 3. Implement
Run the appropriate developer agent for each step:

```
team run dev-backend "<specific task with context from the plan>"
team run dev-frontend "<specific task with context from the plan>"
```

Mark steps done as you go:
```
todo complete-step id="<id>" step_number=<n>
```

## 4. QA Review
After implementation, run the QA agent to review all changes:

```
team run qa "Review the implementation of <feature>. Run tests and check for issues."
```

## 5. Finalize
Update the todo status when all steps are done and QA passes:
```
todo update id="<id>" status="done"
```
