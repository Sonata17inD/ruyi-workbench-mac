# 如意 Ruyi —— 工作台本体

这个目录是如意工作台的应用本体：Node 后端、原生 JS 前端、桌面壳、内置资源与打包工具。
**项目介绍、界面截图、能力一览与快速上手见仓库根目录的 [README](../README.md)（English: [README_EN](../README_EN.md)）。**

## 目录

| 路径 | 内容 |
|---|---|
| `app/backend/` | 工作台后端的 CommonJS 服务，零 npm 运行时依赖 |
| `app/src/` | 服务装配源码，顺序记录在 `manifest.json` |
| `app/server.js` | 工作台的命令行入口，加载 `node app/build.js` 生成的 `app/workbench-runtime.cjs` |
| `app/public/` | 前端：`index.html`、`app.js` 组合根、`js/` 下的原生 ES 模块、分层 CSS、`locales/` 中英语言包；无框架、无构建 |
| `desktop-macos/` | AppKit／WKWebView 宿主、离线构建与内测说明 |
| `resources/` | 内置 Playbook、Claude Code 离线插件市场 `plugins/ruyi-offline`（`offline-toolkit` 技能集）、安装与启动脚本 |
| `config/` | 配置示例与出厂默认值 |
| `docs/` | 用户手册、管理员手册、架构、离线部署、源码审阅、技能目录 |
| `tools/` | Mac 原生构建、离线打包和开发工具 |
| `start-macos.command` | 从源码启动工作台 |

## 运行

```sh
node app/server.js serve --open     # 默认监听 127.0.0.1:8765
node app/server.js doctor           # 检查引擎、依赖、端口和数据目录
node app/server.js mcp-config       # 输出工作台 MCP 配置
node app/server.js install          # 把工作台 MCP 注册进本机 Claude Code
node app/server.js mcp              # 以 stdio MCP server 方式运行
```

源码运行需要 Mac 和 Node.js。开发、CI 和离线包使用 Node.js 24，后端无需运行 `npm install`。
数据目录默认 `~/.ruyi-workbench`（3.0 之前叫 `~/.win-claude-workbench`，满足迁移条件时首次启动迁移），可用 `RUYI_HOME` 覆盖。

同一数据目录由一个服务实例持有。并行开发实例须分别指定 `RUYI_HOME`。绑定非回环地址需要显式传入 `--allow-remote`。

## 打包

Apple Silicon 离线包装分 Full 和 Slim。Full 随附独立 Python、ACC、文档与浏览器依赖。Slim 随附工作台、Node.js、ripgrep 和 Mac 原生宿主。构建参数、资产校验和包体检查见 [离线构建说明](desktop-macos/OFFLINE-PACKAGING.md)，DMG 打包与安装见 [Mac 内部试用说明](desktop-macos/INTERNAL-TRIAL.md)。

## 文档

- 用户手册：[中文](docs/manuals/USER-GUIDE_CN.md) · [English](docs/manuals/USER-GUIDE_EN.md)
- 管理员手册（部署、引擎、安全边界、计费、回归）：[中文](docs/manuals/ADMIN-GUIDE_CN.md) · [English](docs/manuals/ADMIN-GUIDE_EN.md)
- 架构说明：[中文](docs/ARCHITECTURE_CN.md) · [English](docs/ARCHITECTURE_EN.md)
- 离线部署：[中文](docs/OFFLINE_DEPLOYMENT_CN.md) · [English](docs/OFFLINE_DEPLOYMENT_EN.md)
- 早期外部材料阅读记录（历史）：[中文](docs/SOURCE_REVIEW_CN.md) · [English](docs/SOURCE_REVIEW_EN.md)
- 技能与一键任务目录：[中文](docs/SKILLS-CATALOG_CN.md)
- 工作流模型规范：[中文](docs/MODEL-WORKFLOW-SPEC_CN.md) · [English](docs/MODEL-WORKFLOW-SPEC_EN.md)
- 后续管家 3.x 迭代（方案，不代表已交付）：[62 号计划](../docs/optimization-plan/62-steward-3x-iterations.md)

## 品牌与兼容标识

本项目原名 **Win Claude Workbench**，v0.8 起更名 **如意 Ruyi**。MCP 服务标识为 `ruyi`，工具名前缀为 `mcp__ruyi__`。存量目录与变量的迁移范围见 [历史名称与外来格式](../docs/mac-native/LEGACY-REFERENCES.md)。

本项目是 clean-room 独立实现：不含 Anthropic 泄露源码，不分发官方 Claude Code，不复制第三方插件源码；随包前端静态库的许可见 [`../THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md)，本体按 [Apache-2.0](../LICENSE) 发布。
