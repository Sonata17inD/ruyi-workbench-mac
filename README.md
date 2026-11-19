# Ruyi for Mac · 如意工作台

[English](README_EN.md) · [贡献指南](CONTRIBUTING.md) · [改造进度](docs/mac-native/STATUS.md)

面向 Apple Silicon 的离线优先 Agent 工作台。保留 Node Agent 核心、Web UI、Python 文档工具，以及 AppKit／WKWebView 原生宿主；系统能力通过 Mac 原生 helper 提供。

支持 Anthropic Messages、OpenAI 兼容模型服务、本机 Claude Code／Kimi Code CLI、MCP 工具、文件与 Office 文档、会话恢复和多 Agent 协作。系统浏览器打开网址只是交接，不代表已连接 DOM 自动化。

## 开发

开发使用 Node.js 24、Python 3.12 和 Xcode Command Line Tools。部署目标为 arm64、macOS 14；最低系统实机验收另行登记。

```bash
cd ruyi-workbench
npm start
npm run doctor
npm run build:desktop
```

后端零 npm 运行依赖。当前拼接源码位于 `app/src/`，修改后运行 `node app/build.js`；新显式模块位于 `app/backend/`。模块化改造的完成状态见进度记录。

## 内部试用包

```bash
npm run package:offline:full
npm run package:offline:slim
npm run package:trial:macos
```

Full／Slim 使用本地离线运行时和资产锁。构建所需资产与验收要求见 [Mac 打包工具](ruyi-workbench/tools/package-macos-offline.js)。本分支处于 Mac 专用化实施中，命令存在不表示当前候选已通过发行验收。正式签名、公证不属于本轮内部试用交付。

## 数据与权限

独立安装的 `Ruyi Full.app` 默认使用 `~/.ruyi-workbench-full`，在 macOS 中以 `Ruyi Full` 单独授权。Slim 和开发版默认使用 `~/.ruyi-workbench`。可用 `RUYI_HOME` 指定数据目录。开发测试使用隔离数据。

截图、屏幕 OCR、输入与辅助功能分别按原生诊断显示权限和就绪状态；本地图片 OCR 无需录屏权限。诊断失败显示未知，不视为已授权或已就绪。用户文件继续支持 GB18030、BOM 与 CRLF。

## 验证

```bash
node dev-harness/syntax-gate.js
node ruyi-workbench/app/build.js --check
node dev-harness/run-all.js --fast
node dev-harness/macos-capability-projection.e2e.js
```

`--fast` 已包含单元测试。开发中运行受影响范围，最终集成才进行完整 Mac 适用回归、独占能效对照与 Full／Slim 打包验收。跳过和未执行项不计入通过。

版本与测试清册见 [工程事实](facts.json)，清册数量不表示通过数量。

[审查报告](docs/audits/2026-11-13-mac-only/REPORT.md) · [历史变更](CHANGELOG.md) · [第三方许可](THIRD-PARTY-NOTICES.md) · [Apache-2.0](LICENSE)
