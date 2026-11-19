---
name: 前端审计
description: 审计前端的离线就绪度与界面风险
---

Mac browser contract: system browser_open only hands off a URL; it proves neither page load nor DOM attachment. For DOM work, inspect browser_backend_status for an explicitly configured managed/custom/CDP/bundled target and verify the target URL and page content. Do not navigate the Workbench tab or close unowned pages. Native screenshot, OCR, input and AX require their own diagnostics readiness and authorization. Test narrow widths with an available viewport capability, not scaled screenshots; report unperformed checks honestly.

# Frontend Audit

Audit the frontend for offline readiness and UI risks.

Steps:

1. Call `dependency_inventory`.
2. Call `frontend_audit`.
3. Inspect the app's main pages/components.
4. If safe, start the local dev server as a background job (it never exits, so a one-shot `shell_run` would only hit its timeout): `shell_start` with `command` and a large `timeoutMs` on the workbench provider engine (the background command is killed at its deadline, 30 minutes by default; stop it later with `shell_kill`), or the agent CLI's own background shell.
5. Mac browser contract: system browser_open only hands off a URL; it proves neither page load nor DOM attachment. For DOM work, inspect browser_backend_status for an explicitly configured managed/custom/CDP/bundled target and verify the target URL and page content. Do not navigate the Workbench tab or close unowned pages. Native screenshot, OCR, input and AX require their own diagnostics readiness and authorization. Test narrow widths with an available viewport capability, not scaled screenshots; report unperformed checks honestly.
6. Report asset, layout, accessibility, and offline dependency issues.

The tools above are Ruyi Workbench MCP tools (in Claude Code: `mcp__ruyi__<name>`); without them, use Grep and Read for the audit and a background Bash command for the dev server.
