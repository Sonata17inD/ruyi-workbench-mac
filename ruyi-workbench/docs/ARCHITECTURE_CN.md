# Ruyi for Mac 架构

桌面宿主管理本地服务生命周期并用 WKWebView 显示工作台。浏览器和桌面窗口使用同一套界面和本地 HTTP API。界面的普通请求读取快照或提交操作，运行中的任务通过 SSE 更新。[Mac 宿主](../desktop-macos/README.md) · [Web 入口](../app/public/index.html)

## 后端装配和数据

Node 入口加载工作台运行时。领域实现位于 `app/backend/`，依赖由 `app/src/` 中的装配片段接入。修改片段后，在仓库根目录运行 `node ruyi-workbench/app/build.js` 重新生成运行时。跨片段引用和路由可以从生成的清册查到。[启动入口](../app/server.js) · [模块依赖图](../../docs/architecture/module-dependency-graph.md) · [路由清册](../../docs/architecture/route-inventory.md)

同一数据根由一个服务实例独占。启动时取得系统锁，再执行迁移和恢复。会话头和正文分别持久化，切换执行引擎时保留工作台对话。对存储格式或恢复顺序的改动需覆盖已有数据。[所有权](../app/backend/server-ownership.cjs) · [持久状态清册](../../docs/architecture/durable-state-inventory.md)

## 从会话到执行

会话路由决定下一回合交给 Claude CLI 或配置的 Provider。Provider 回合负责流式事件、工具调用和用量，HTTP 模块管理候选端点与重试资格。编排器按节点依赖和资源可用性调度子任务。待决交互通过 Mission 和 Intervention 的数据契约交给界面。[会话路由](../app/backend/session-engine-route.cjs) · [Provider 回合](../app/backend/provider-turn.cjs) · [HTTP](../app/backend/provider-http.cjs) · [交互契约](../../docs/MISSION-SCHEMA.md)

桌面自动化通过本地 MCP 工具调用，实际可用能力取决于发行变体、已安装组件和当前的 macOS 授权。Full 与 Slim 共用产品源码，打包清单和离线依赖决定随包资源。[模型工作流](MODEL-WORKFLOW-SPEC_CN.md) · [发行说明](MACOS-RELEASE_CN.md)
