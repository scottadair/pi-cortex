---
name: no-node-fetch
description: Prevent use of deprecated node-fetch package
ttsrTrigger: "node-fetch|require\\(['\"]node-fetch['\"]\\)|from ['\"]node-fetch['\"]"
---

Do NOT use the `node-fetch` package. Use the built-in `fetch()` API which is available natively in Node.js 18+ and Bun.

Instead of:
```typescript
import fetch from "node-fetch";
```

Use the global `fetch()` directly:
```typescript
const response = await fetch("https://example.com");
```
