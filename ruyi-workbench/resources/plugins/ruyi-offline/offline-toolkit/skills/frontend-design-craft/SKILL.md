---
name: 前端设计精修
description: 新做或打磨前端界面的视觉与交互，只用本地资源
---

Mac browser contract: system browser_open only hands off a URL; it proves neither page load nor DOM attachment. For DOM work, inspect browser_backend_status for an explicitly configured managed/custom/CDP/bundled target and verify the target URL and page content. Do not navigate the Workbench tab or close unowned pages. Native screenshot, OCR, input and AX require their own diagnostics readiness and authorization. Test narrow widths with an available viewport capability, not scaled screenshots; report unperformed checks honestly.

# Frontend Design Craft

Use this skill when building a new frontend UI or polishing the look and interaction of an existing one in an offline Mac environment. For a page that is already broken (errors, blank screen, failed requests), use browser-debug.

Inspired by the popular Claude plugin category for frontend design, but implemented as local-only guidance plus Workbench tools.

Workflow:

1. Use `project_snapshot` and `dependency_inventory` to understand the app stack.
2. Use `frontend_audit` before and after edits to catch offline CDN usage, viewport issues, font scaling, and generic visual patterns.
3. Avoid CDN fonts, icon CDNs, remote images, hosted JS, and remote CSS. Bundle assets locally.
4. Prefer the app's existing component system and icons. If none exists, use simple HTML/CSS with local assets.
5. Run the dev server with shell_start(command, timeoutMs) and inspect shell_poll, or use the CLI background facility. Retain its owned process identity and logs; stop it when done. Poll the URL with http_request until ready.
6. Mac browser contract: system browser_open only hands off a URL; it proves neither page load nor DOM attachment. For DOM work, inspect browser_backend_status for an explicitly configured managed/custom/CDP/bundled target and verify the target URL and page content. Do not navigate the Workbench tab or close unowned pages. Native screenshot, OCR, input and AX require their own diagnostics readiness and authorization. Test narrow widths with an available viewport capability, not scaled screenshots; report unperformed checks honestly.
7. For fixed UI controls, use stable dimensions, responsive constraints, and text wrapping. Do not let labels resize boards, toolbars, or tiles.

Output expectations:

- Mention the files changed.
- Include the local URL or file path that was verified.
- Report any offline asset risks found by `frontend_audit`.
