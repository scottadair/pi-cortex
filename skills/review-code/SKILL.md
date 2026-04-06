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

Or use the `/review` command for interactive mode selection.

## 2. Run QA Review
Use the `team` tool to delegate to the **qa** agent. The QA agent has access to `report_finding` and `submit_review` tools for structured output.

For uncommitted changes:
```
team run qa "Perform a structured code review of uncommitted changes. Run `git diff && git diff --staged` to see changes. For each issue, use `report_finding` with priority (P0-P3), confidence, file path, and line range. After all findings, call `submit_review` with verdict and summary."
```

For branch reviews:
```
team run qa "Perform a structured code review of branch <branch> compared to main. Run `git diff main...<branch>`. For each issue, use `report_finding` with priority (P0-P3), confidence, file path, and line range. After all findings, call `submit_review` with verdict and summary."
```

For commit reviews:
```
team run qa "Review changes in commit <hash>. Run `git show <hash>`. For each issue, use `report_finding`. After all findings, call `submit_review`."
```

## 3. Interpret Results
The review produces structured findings with priorities:
- **P0 (critical)**: Security vulnerabilities, data loss, crashes — must fix
- **P1 (major)**: Bugs, incorrect behavior — should fix
- **P2 (moderate)**: Design, maintainability — consider fixing
- **P3 (nit)**: Style, minor — optional

Verdicts:
- **approve**: No P0/P1 issues found
- **request-changes**: Has P0/P1 issues that must be fixed
- **comment**: Observations only, no blocking issues

## 4. Address Issues
If the QA agent identifies blocking issues (P0/P1), delegate fixes to the appropriate developer:

```
team run dev-backend "<fix description based on QA findings>"
```

Then re-run QA to verify the fixes.
