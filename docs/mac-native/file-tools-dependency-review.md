# 文件工具依赖复核

对照提交：`81129721`。文件工具移出共享作用域，并修复扫描器把 literal 后的除号当作正则的问题，原先漏扫的声明与依赖重新显现。

以下每条边的全部符号均在原消费者源码中存在；没有通过删除依赖记录宣称消环。独立 file-tools 模块使用显式端口，旧宿主仍需继续拆分。数字／字符串／模板除法和正则花括号已有扫描回归；两个大文件顶层声明另经 Node 内置 Acorn AST 对照，漏项和误项均为零。此 AST 对照是开发检查，不引入产品依赖。

| 消费者 | 提供者 | 既有引用数 |
| --- | --- | --- |
| 05-claude-engine.js | 12-tool-dispatch.js | 2 / 2 |
| 05b-kimi-bridge.js | 12-tool-dispatch.js | 1 / 1 |
| 06d-memory-domain.js | 12-tool-dispatch.js | 2 / 2 |
| 08-agent-runs.js | 12-tool-dispatch.js | 2 / 2 |
| 09-workflow.js | 12-tool-dispatch.js | 4 / 4 |
| 11c-file-visual-io.js | 00-boot.js | 2 / 2 |
| 11d-media-inspection.js | 00-boot.js | 1 / 1 |
| 12-tool-dispatch.js | 00-boot.js | 19 / 19 |
| 12-tool-dispatch.js | 01-config.js | 10 / 10 |
| 12-tool-dispatch.js | 02-session-store.js | 18 / 18 |
| 12-tool-dispatch.js | 03-bridge-guard.js | 20 / 20 |
| 12-tool-dispatch.js | 04-desktop-shell.js | 1 / 1 |
| 12-tool-dispatch.js | 04-permission-runtime.js | 7 / 7 |
| 12-tool-dispatch.js | 05-claude-engine.js | 4 / 4 |
| 12-tool-dispatch.js | 06-provider-engine.js | 11 / 11 |
| 12-tool-dispatch.js | 06d-memory-domain.js | 6 / 6 |
| 12-tool-dispatch.js | 07-autonomy.js | 14 / 14 |
| 12-tool-dispatch.js | 08-agent-runs.js | 2 / 2 |
| 12-tool-dispatch.js | 10-context-governance.js | 2 / 2 |
| 12-tool-dispatch.js | 11-native-tools.js | 63 / 63 |
| 12-tool-dispatch.js | 11c-file-visual-io.js | 1 / 1 |
| 12-tool-dispatch.js | 11d-media-inspection.js | 1 / 1 |
| 13-http-router.js | 12-tool-dispatch.js | 5 / 5 |

修正后旧宿主为 663 边、1 个 SCC、32 成员；这仍是未清偿的架构债务。
