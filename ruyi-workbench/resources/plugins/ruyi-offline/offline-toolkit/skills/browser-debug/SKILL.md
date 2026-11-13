---
name: 网页调试
description: 排查已经出问题的本地网页：报错、白屏、布局错位、页面发出的接口请求失败
---

# Browser Debug

Use for a broken local page, layout or frontend request. For new UI use frontend-design-craft; for backend endpoints use api-debugger.

Mac execution: use shell_run or script_run (bash/Python/Node), absolute POSIX paths and prepared local dependencies. Never source the user profile to discover tools.

Mac browser contract: system browser_open only hands off a URL; it proves neither page load nor DOM attachment. For DOM work, inspect browser_backend_status for an explicitly configured managed/custom/CDP/bundled target and verify the target URL and page content. Do not navigate the Workbench tab or close unowned pages. Native screenshot, OCR, input and AX require their own diagnostics readiness and authorization. Test narrow widths with an available viewport capability, not scaled screenshots; report unperformed checks honestly.

1. Start the dev server with shell_start(command, timeoutMs) and read shell_poll, or use the CLI's background facility. Retain its process identity and logs. Poll the URL with http_request.
2. Reproduce the failure and inspect server output, endpoint status and response body.
3. Verify the actual page through a ready DOM backend or an authorized native visual path. Never infer success from a URL handoff.
4. Fix the cause, rerun the same scenario, and check narrow viewports when available. Stop only the process tree you own.
5. Keep scripts in the workspace when reuse is needed. No CDN or internet-font assumptions; use frontend_audit to find remote assets.
