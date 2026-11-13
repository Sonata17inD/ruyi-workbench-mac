---
name: 离线打包
description: 为隔离网或内网 Mac 机器准备项目分发包
---

# Offline Packaging

Prepare offline Mac distributions using the repository's current packaging manifest and local caches. Target Apple Silicon arm64 and macOS 14 or newer.

1. Identify runtime dependencies and verify they are already available locally. No implicit downloads during runtime acceptance.
2. Build from one frozen source revision. In ruyi-workbench, use npm run package:offline:full and npm run package:offline:slim; npm run package:trial:macos prepares the trial distribution. Check the scripts for exact input/output paths before running.
3. Treat packaging/macos/runtime-files.json as the runtime file allowlist. Verify ACC wheel contents, third-party licenses and source fingerprints.
4. Validate doctor, MCP startup, moved App paths and offline use with isolated data. Preserve installed Apps and real user data.
5. Build each candidate once after relevant checks pass. Record failed, skipped and external acceptance items separately. Internal signing checks do not establish formal notarization or macOS 14 real-machine acceptance.
6. Include installation and rollback instructions. Never describe a source-only check as a verified release.
