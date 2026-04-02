---
name: review-code
description: |
  Code review workflow. Delegates to the QA agent to review code changes,
  a pull request, or recent commits. Use when asked to review code or a PR.
---

# Code Review Workflow

## 1. Determine Review Scope
Identify what to review:
- Recent uncommitted changes: `git diff`
- A specific branch: `git diff main...<branch>`
- A PR: use the PR number or branch name
- Specific files or folders

## 2. Run QA Review
Use the `team` tool to delegate to the **qa** agent:

```
team run qa "Review the code changes. Run `git diff` to see what changed. Check for correctness, security issues, code quality, and test coverage. Provide a structured review with verdict."
```

For branch reviews:
```
team run qa "Review changes on branch <branch> compared to main. Run `git diff main...<branch>`. Provide a structured review."
```

## 3. Address Issues
If the QA agent identifies issues, delegate fixes to the appropriate developer:

```
team run dev-backend "<fix description based on QA feedback>"
```

Then re-run QA to verify the fixes.
