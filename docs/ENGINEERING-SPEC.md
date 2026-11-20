# Ruyi for Mac 工程入口

后端通过 `ruyi-workbench/app/server.js` 启动。独立实现位于 `app/backend`，`app/src` 中的片段按装配清单连接运行时依赖。修改片段后，在仓库根目录运行 `node ruyi-workbench/app/build.js` 更新装配产物。

跨模块符号和 HTTP 路由分别见[模块依赖图](architecture/module-dependency-graph.md)与[路由清册](architecture/route-inventory.md)。前端 CLI 元数据由 `ruyi-workbench/app/public/js/agent-cli-registry.js` 提供，后端在会话执行入口判定实际可用的路由。

开发环境、离线约束及行为测试入口见[贡献指南](../CONTRIBUTING.md)。Mac 宿主的部署和权限要求见[发行说明](../ruyi-workbench/docs/MACOS-RELEASE_CN.md)。
