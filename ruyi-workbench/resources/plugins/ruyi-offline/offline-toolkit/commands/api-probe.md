---
name: 探测 API
description: 探测本地或内网 HTTP 接口
argument-hint: "<url> [method]"
---

Mac execution: use shell_run or script_run (bash/Python/Node), absolute POSIX paths and prepared local dependencies. Never source the user profile to discover tools.

# API Probe

Probe a local or intranet HTTP API.

Steps:

1. Identify URL, method, headers, and body.
2. Read-only methods (GET, HEAD, OPTIONS) can be sent directly. For POST, PUT, PATCH, DELETE, or anything else that may change data, show the user the method, URL, and body first and send only after they confirm.
3. Call `http_request` with `url`, `method`, `headers`, `body` (an object is sent as JSON), and `timeoutMs` if needed. It does not follow redirects; a 3xx returns `location`.
4. Summarize status, headers, and a compact response excerpt.
5. Suggest the next local log/source file to inspect.

`http_request` is a Ruyi MCP tool (`mcp__ruyi__http_request` in Claude Code). If absent, use /usr/bin/curl through shell_run with a JSON body file:

```sh
/usr/bin/curl -sS -i 'http://127.0.0.1:8080/health'
/usr/bin/curl -sS -i -X POST 'http://127.0.0.1:8080/api/items' -H 'Content-Type: application/json' --data-binary '@body.json'
```

Keep credentials out of logs and redact sensitive response fields.
