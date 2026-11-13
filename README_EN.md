# Ruyi for Mac

[简体中文](README.md) · [Contributing](CONTRIBUTING.md) · [Implementation status](docs/mac-native/STATUS.md)

An offline-first agent workbench for Apple Silicon. Node agents, a Web UI and Python document tools run inside an AppKit/WKWebView host, with native Mac system helpers. Supports Anthropic Messages and OpenAI-compatible providers, local Claude Code/Kimi Code CLIs, MCP tools, Office documents, session recovery and agent collaboration.

Development uses Node.js 24, Python 3.12 and Xcode Command Line Tools. The deployment target is arm64/macOS 14; actual minimum-system acceptance is recorded separately. The backend has zero npm runtime dependencies.

```bash
cd ruyi-workbench
npm start
npm run doctor
npm run build:desktop
npm run package:offline:full
npm run package:offline:slim
npm run package:trial:macos
```

Mac specialization is in progress: these commands do not establish release acceptance. Full/Slim packaging uses local offline assets. Formal signing and notarization are outside this internal trial iteration.

Data remains in `~/.ruyi-workbench` or `RUYI_HOME`. Preserve Mac migration, sessions and credentials; tests use isolated data. Capture, screen OCR, input and accessibility report separate native permission states. Local-image OCR does not require screen recording permission. Failed diagnostics mean unknown. Opening a system browser URL is a handoff, not a DOM connection.

Edit current concatenated backend sources under `app/src/`, then run `node app/build.js`. Explicit modules live in `app/backend/`. Run targeted checks while developing; reserve complete Mac regression, exclusive performance benchmarks and Full/Slim package validation for integration.

```bash
node dev-harness/syntax-gate.js
node ruyi-workbench/app/build.js --check
node dev-harness/run-all.js --fast
node dev-harness/macos-capability-projection.e2e.js
```

The fast suite includes unit tests. Skipped and unexecuted checks are not passes.

[Audit](docs/audits/2026-11-13-mac-only/REPORT.md) · [History](CHANGELOG.md) · [Third-party notices](THIRD-PARTY-NOTICES.md) · [Apache-2.0](LICENSE)
