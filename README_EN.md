# Ruyi for Mac

[简体中文](README.md) · [Contributing](CONTRIBUTING.md) · [Implementation status](docs/mac-native/STATUS.md)

An offline-first agent workbench for Apple Silicon. Node agents, a Web UI and Python document tools run inside an AppKit/WKWebView host, with native Mac system helpers. Supports Anthropic Messages and OpenAI-compatible providers, local Claude Code and Codex CLIs, MCP tools, Office documents, session recovery and agent collaboration.

## Run Codex with a ChatGPT plan

Install the Codex CLI (for example, `npm install -g @openai/codex`). In **Settings → Connections and tools → Agent CLI**, expand **Codex CLI · ChatGPT**, choose **Continue with ChatGPT**, and authorize plan usage in the system browser. Under **Models & capabilities**, select Codex CLI as the main conversation engine and choose a model available to the account. Use an ordinary workbench thread for streaming chat and Ruyi MCP tools. The Agent CLI settings also provide sign-out and a link to ChatGPT usage.

Development uses Node.js 24, Python 3.12 and Xcode Command Line Tools. Full and Slim qualify on the local Apple Silicon Mac running macOS 27.0.1. The arm64 build retains its macOS 14 deployment target. The backend has zero npm runtime dependencies.

```bash
cd ruyi-workbench
npm start
npm run doctor
npm run build:desktop
npm run package:offline:full -- --assets "$ASSETS" --output dist/full
npm run package:offline:slim -- --assets "$ASSETS" --output dist/slim
npm run package:trial:macos -- --package dist/full --output dist/images/full
npm run package:trial:macos -- --package dist/slim --output dist/images/slim
```

When upgrading, quit and move the old Slim Ruyi.app out of Applications before installing Ruyi.app (formerly Ruyi Full) and Ruyi Slim.app. Each edition keeps its existing data directory.

Mac specialization is in progress: these commands do not establish release acceptance. Full/Slim packaging uses local offline assets. Formal signing and notarization are outside this internal trial iteration.

Ruyi stores data in `~/.ruyi-workbench-full`, and Ruyi Slim uses `~/.ruyi-workbench`. Set `RUYI_HOME` to override the default. Preserve Mac migration, sessions and credentials; tests use isolated data. Capture, screen OCR, input and accessibility report separate native permission states. Local-image OCR does not require screen recording permission. Failed diagnostics mean unknown. Opening a system browser URL is a handoff, not a DOM connection.

Edit current concatenated backend sources under `app/src/`, then run `node app/build.js`. Explicit modules live in `app/backend/`. Run targeted checks while developing; reserve complete Mac regression, exclusive performance benchmarks and Full/Slim package validation for integration.

```bash
node dev-harness/syntax-gate.js
node ruyi-workbench/app/build.js --check
node dev-harness/run-all.js --fast
node dev-harness/macos-capability-projection.e2e.js
```

The fast suite includes unit tests. Skipped and unexecuted checks are not passes.

See [generated engineering facts](facts.json) for the version and test inventory; inventory counts are not pass counts.

[Audit](docs/audits/2026-11-19-mac-slim/REPORT.md) · [History](CHANGELOG.md) · [Third-party notices](THIRD-PARTY-NOTICES.md) · [Apache-2.0](LICENSE)
