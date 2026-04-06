---
name: no-console-log
description: Use structured logging instead of console.log
ttsrTrigger: "console\\.log\\("
---

Do NOT use `console.log()` for logging in production code. Use the project's structured logger instead.

- For debug output: `logger.debug()`
- For informational messages: `logger.info()`
- For warnings: `logger.warn()`
- For errors: `logger.error()`

`console.log()` is acceptable only in CLI scripts and test files.
