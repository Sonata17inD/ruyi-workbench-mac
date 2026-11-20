# Ruyi for Mac 整体瘦身审查与分批修改计划

2026-11-19 · 源码基线 `7a34426695be` · Node.js 24.15.0 · 数字和源码行号对应审查基线

优先做三件事。**第一，退役 Kimi 的整个执行链，并让旧会话由用户重新选择引擎。第二，修复 Mac 浏览器的路径处理和安装包里缺失的帮助，再清退 Windows 路径与文档。第三，把持续发生的空闲工作去掉。** 大规模后端拆分排在这些变更之后。清理历史材料可以显著缩小检出目录，安装包大小、交互延迟和用电量分别验收。

## 1. 审查覆盖和验证

逐项读取 `git ls-files -z` 列出的 **8,222 个文件、312,444,601 字节**。8,098 个可按无 NUL 的 UTF-8 文本扫描，124 个按二进制或其他编码处理。按 JS、Python、Swift、C/Objective-C、HTML、CSS 和脚本等源码后缀计 1,930 个文件，包含生成物、第三方前端库和历史探针。全文扫描用于找候选；删除依据来自实际入口、调用者、依赖图、测试或下表中的复现。另核看了工作区未跟踪的四份 Full 手工验收文件，它们属于用户当前验收材料。忽略的运行时、虚拟环境和历次发行目录不计入源码统计。涉及帮助的问题另抽查了已有 App 载荷。

| 范围 | 本次核对结果 |
| --- | --- |
| Node 后端 | 399 个 CJS 模块、95,568 行，另有一份规则 JSON。84 个 JS 装配片段、4,091 行。对全部模块与片段解析、解析相对字面量 `require` 并核对可达性，399 个模块都能从装配源码到达。仅加载 `server.js` 的隔离进程已载入其中 395 个 CJS 和 1 个 JSON，含全部 11 个 Kimi 专名后端模块。 |
| Web、Mac 宿主、工具 | 115 个前端文件，10 个 `desktop-macos` 文件，70 个资源文件，15 个工具目录文件，108 个 MCP 树文件。核对了 Web 入口静态依赖、WKWebView/普通浏览器差异、Python 工具注册、Full/Slim 发布白名单和帮助读取路径。 |
| 测试与文档 | 1,149 个跟踪的 harness 文件。602 个顶层 E2E 中，76 个文件名以 `.static.e2e.js` 结尾，14 个列为 live 跳过。另有 344 个单元文件。根 `docs/` 210 个文件，移植证据 5,979 个文件。数量均按当前树计算。 |
| 本轮实际运行 | 语法门报告 2,036 次检查、0 失败。构建一致性、模块依赖图、路由清册检查通过。CLI 注册、后台任务托盘、会话头读取三个单元文件合计 24 个测试通过、0 跳过。另做了下表四个定向复现。 |
| 待实测 | 整套 E2E、WKWebView 首屏、整机能耗、修改后对照、重新打包及实机权限验收留在实施阶段。以往签名包的 CPU/RSS 数据只对应其冻结提交。 |

### 四项可复现的观察

| 场景 | 当前结果 | 如何复核 |
| --- | --- | --- |
| 安装后的离线帮助 | 源码中用户/管理员手册各两种语言，共 4/4 可读。现有 Full `7a344266` 和 Slim `1ece927e` 各 0/4，均返回 HTTP 200、`ok:false`、`help.doc_missing`。 | 直接加载各自资源树的 `createLocalSupportRoutes`，指向包内手册目录，在已鉴权条件下调用 `GET /api/help/doc` 的四组 id/lang。仅调用真实处理函数，未启动 GUI。安装包验收要断言返回的正文。[处理函数](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/app/backend/local-support-routes.cjs#L20) · [清单](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/packaging/macos/runtime-files.json#L398) |
| 空闲托盘的 DOM 工作量 | 隐藏、零后台任务、500 行侧栏，手动驱动 60 次一秒回调，触发 60 次整栏选择和 30,000 次逐行查询，HTTP 请求为零。 | 用 `createBackgroundTray` 注入 `hidden:true` 的文档和返回空任务的 API，记录行上的 `querySelector`。这个实验隔离了 JS 工作量，WKWebView 的后台节流和硬件唤醒另测。[计时器](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/app/public/js/background-tray.js#L318) · [扫描](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/app/public/js/background-tray.js#L119) |
| 读取确定不存在的会话头 | 5 次耗时 82.95–85.82 ms，中位数 **84.63 ms**。测试明确要求至少等 60 ms。 | 用新临时 HOME、RUYI_HOME 及隔离环境加载 `server.js`，连续 5 次计时 `readSessionHeadResilient('nonexistentfixture')`，计时从函数调用开始。现有四次退避为 5、15、25、35 ms。[读取](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/app/backend/session-persistence.cjs#L34) · [断言](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/dev-harness/unit/session-head-read.test.js#L58) |
| 工作流分配传播 | 同一条 2,000 边链、同一结果，边按依赖顺序给出为 **1.12 ms**，逆序为 **83.36 ms**。 | 构造 `i0 → i1 → … → i2000`，仅给 i0 分配 owner。两种顺序分别预热 1 次，对 `propagateAssignments` 调用 5 次取中位数，均返回 pass。反向输入使当前实现反复遍历整张边表。[实现](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/app/backend/agent-quality.cjs#L299) |

## 2. 删除清单和用户可见影响

### Kimi 的退役边界

专名产品文件共 **14 个、4,107 行**，其中 11 个是 `backend/kimi-*.cjs`，还有 `src/05b-kimi-bridge.js` 和两个 `resources/kimi-acp-compat-*.mjs`。另有 **6 个专名测试或探针、3,405 行**。这些行数包括注释和需要迁出的少数共享代码。仅按文件名清理会遗漏大量活动路径。按 Kimi、Moonshot、月之暗面三者之一全文匹配，命中后端 74 个文件、装配源码及清单 12 个、前端 17 个，测试中有 74 个 E2E 和 33 个单元文件。命中数量包含注释和混合功能。[执行适配器](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/app/backend/agent-cli-adapters.cjs#L166) · [发行白名单](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/packaging/macos/runtime-files.json#L127)

| 层 | 修改及验收重点 |
| --- | --- |
| 配置与会话 | 先区分“没有指定引擎”和“指定的引擎已不可用”。今天删除注册项后，未知类型会静默变成 Claude。已有会话保留正文、附件和原模型信息，再次发送、恢复运行或自动调度前要求显式选择受支持的引擎。覆盖旧全局设置、上次选用、会话头和只有消息历史的档案。切换后从所选引擎的新执行上下文开始。此处是本计划建议的退役体验。[归一化](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/app/backend/agent-cli-types.cjs#L64) · [会话推断](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/app/backend/session-engine-route.cjs#L32) |
| 运行时 | 移除 CLI 路径探测、模型发现和模型特例、ACP、wire 监听、原生压缩/用量、专属搜索策略、MCP 清单双向同步、指令导入及 `/api/kimi/status` 的处理和鉴权登记。先从桥文件尾部迁出共享的 `maybeAutoCompactAgentSession`。Claude、Codex 的独立导入，以及用户自配的标准协议端点按各自协议工作。旧 MCP 导入来源仍须防止凭据被反向同步至别家 CLI。[装配桥](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/app/src/05b-kimi-bridge.js) · [导入](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/app/backend/cli-mcp-import.cjs#L24) · [模型特例](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/app/backend/context-governance-rules.json#L151) |
| UI、安装包与验收 | 删设置、向导、模型菜单、状态轮询、压缩入口、前端注册项、双语文案和包内专属资源。专名测试随实现退役，混合测试只删退出的用例。新建临时家目录放不可执行的占位 CLI 和带检测标记的配置，验证启动、状态页、导入和退出都不会探测、启动或回写 Kimi。验证源代码、生成装配、包清单和实际载荷，明确区分审查文档、第三方声明、用户历史原文。[前端注册](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/app/public/js/agent-cli-registry.js#L49) · [探测](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/app/backend/agent-cli-discovery.cjs#L118) · [状态接口](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/app/backend/session-execution-routes.cjs#L58) |

### Windows 遗留

| 已确认位置 | 修改及验收重点 |
| --- | --- |
| Mac 浏览器路径实际走了另一套规则 | 工作区收藏用 WKWebView 桥的存在判定路径语义。普通浏览器访问同一台 Mac 时走小写折叠、反斜杠替换和 trim；向导另有一份无条件折叠逻辑。统一使用 Mac 工作区输入规则，路径身份由后端确认。两个入口使用同一组大小写敏感卷、路径尾空格、含反斜杠文件名、根路径与已挂载卷夹具。原生桥只负责系统选择器。[工作区收藏](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/app/public/js/workspace-preferences.js#L125) · [向导](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/app/public/js/onboarding-wizard.js#L51) · [桥](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/app/public/js/host-bridge.js#L4) |
| 遗留执行和探测分支 | Mac 专用打包器仍根据 `win32` 选择进程组策略。Python ACC 仍读 `LOCALAPPDATA`，Node 的旧记忆导入也会扫该位置，包根探测仍接受 `Start-Workbench.cmd`。统一 Mac 数据根和文件标记，清理用户界面中的盘符样例、PowerShell 工具提示及两套假 AppData 夹具。用临时家目录验证 CLI、MCP、浏览器 profile 与产品数据隔离。[打包器](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/tools/macos-offline-lib.js#L66) · [ACC](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/mcp/ai-computer-control/src/ai_computer_control/paths.py#L21) · [旧导入](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/app/backend/memory-migrations.cjs#L57) · [包识别](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/app/backend/workbench-path-discovery.cjs#L59) |
| 旧品牌、迁移、路径保底 | `WIN_CLAUDE_WORKBENCH_HOME`、旧数据根和旧 MCP 标识有真实读取方。把支持范围收敛为 Mac 默认根、Full 独立根和 `RUYI_HOME`。旧目录/链接的迁移收口到升级步骤，先用旧 Mac 数据验证可发现、可回退，再退出日常启动路径；原有用户文件和密钥由用户保有。UNC/盘符/设备命名空间的例外与多根重试可从工作区执行路径退出，在输入边界拒绝不支持的路径。附件和 ZIP 名称继续剥离外部目录，Mac 真实路径、符号链接与受保护数据目录仍校验。GB18030、BOM、CRLF 继续按文件格式验证。[数据根](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/app/backend/workbench-data-roots.cjs#L27) · [UNC 重试](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/app/backend/workspace-unc-policy.cjs#L78) · [附件名](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/app/backend/attachment-store.cjs#L23) |
| 已经误导人的说明 | 退役仍要求双击 `.cmd` 的开始指南和 overlay 操作手册，修订用户/管理员手册、MCP 安装说明、问题模板和贡献入口。当前手册首页虽提示 Mac 用户另阅发行说明，第 16 行仍把旧启动器列为操作步骤。将日常使用、部署权限和恢复步骤分别放进对应的中英手册，发行说明只维护版本差异；将实际供帮助 API 读取的手册登记进 Full/Slim 白名单。[开始指南](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/README-START-HERE.txt#L2) · [旧更新指南](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/tools/APPLY-OVERLAY.md#L15) · [用户手册](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/docs/manuals/USER-GUIDE_CN.md#L16) · [PR 模板](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/.github/PULL_REQUEST_TEMPLATE.md#L11) |

## 3. 架构、重复实现与无效保底

**静态图没有发现循环依赖。** 84 个装配片段有 594 条跨片段依赖边、14 条前向边、0 个非平凡强连通分量。后端字面量相对 `require` 图和前端静态 import 图也未发现环。工厂注入、延迟回调和运行时调用超出静态图的边界。现有主要维护成本来自共享装配作用域、初始化顺序和单个函数承担过多状态转换。[依赖摘要](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/docs/architecture/module-dependency-graph.md#L7) · [实际入口](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/app/server.js#L4) · [生成装配位置](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/app/build.js#L24)

| 发现 | 建议的修改边界 |
| --- | --- |
| `runOpenAiTurn` 2,490 行，`runAgentWorkflow` 1,147 行，`runClaudeTurn` 954 行，`normalizeConfig` 833 行，均含空行与注释 | 一次只处理一条调用链。Provider 回合先分清请求/流式帧、工具审批与执行、历史提交三个已有边界，保留唯一的停止和落盘责任方。工作流让就绪、等待、暂停、取消和完成拥有明确的转移条件。配置在磁盘/HTTP 入口做归一，内部读取规范化后的结构，旧版本迁移按 schema 做一次。先锁定同一假 provider 的事件顺序、工具结果、停止时最后一条持久化消息，再移动代码。[Provider](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/app/backend/provider-turn.cjs#L147) · [工作流](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/app/backend/agent-workflow.cjs#L81) · [CLI](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/app/backend/agent-cli-turn.cjs#L41) · [配置](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/app/backend/config-schema.cjs#L194) |
| `createWorkbenchApi` 暴露 547 项，导出测试把语料中出现的标识符计作使用；部分依赖在对象建好后由 `Object.assign` 补填 | 按生产调用、公开嵌入接口、仓内测试、开发工具四类核对消费者。纯函数测试直引所属模块，启动和路由端到端测试仍走正式入口。先收回仅用于测试的导出，再让管家、隐私配置的必需依赖在装配时传入。逐域把 `src` 的接线迁入显式模块，最后一个片段退出时再撤拼接器、manifest 行区间和对应门。同步修正仍把 `server.js` 写作拼接产物的开发说明。[导出](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/app/src/14-main.js#L53) · [导出测试](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/dev-harness/unit/export-surface.test.js#L9) · [管家接线](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/app/src/13g-steward.js#L46) · [隐私接线](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/app/src/13ab-privacy-api.js#L11) |
| API 路由依次 await 多个域，再检查响应是否结束；特殊域另认处理标志、已发头或连接状态 | 先固定 171 个现有路由判定点与 157 条鉴权规则的行为，按方法和路径前缀直接找到所属域，原处理函数逐组迁移。通用未匹配、未授权、流式响应和连接取消有明确的退出路径。收益先看调用次数和可维护性，耗时用本地请求对照。[分派](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/app/backend/workbench-api-router.cjs#L15) · [路由清册](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/docs/architecture/route-inventory.md) |
| 三个只声明、无调用或导出的函数，以及已退役 Shell 面板的空方法 | 删 `retrievalContentHash`、`luhn`、`kimiAcpNormalizedToolName` 的闲置定义。前端 `newShellSession` 恒返回 null，`updateShellPolling` 为空；一并移除注入、导航调用、启动步骤及强制存在的静态断言。后台 Shell 任务和原生隐私检测分别走其实际测试。[检索](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/app/backend/retrieval-index.cjs#L132) · [隐私](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/app/backend/privacy-core.cjs#L68) · [Kimi](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/app/backend/kimi-acp-interventions.cjs#L45) · [前端](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/app/public/js/tool-runtime.js#L353) · [启动](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/app/public/app.js#L1273) |
| MCP 的 stdio、HTTP 两种实现复制了 pending 请求的超时、取消和批量失败；Agent 钩子在没有订阅时也会复制和深冻上下文 | MCP 只共享 pending 表项的创建与释放，传输各自负责发送和关闭；验超时、EOF、取消竞争、取消后迟到的响应。Agent 分派先确定该阶段有监听者，存在时才生成不可变快照。现有注册接口和回调顺序继续可用。[MCP 两组回调](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/app/backend/mcp-transports.cjs#L187) · [第二处](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/app/backend/mcp-transports.cjs#L553) · [钩子](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/app/backend/agent-loop-hooks.cjs#L109) |
| 重试、缺省值和吞错混在同一层 | 缺失会话、权限拒绝、损坏 JSON、写者正在提交应有各自结果。核对同目录原子替换、格式迁移、另一个允许的写进程等真实写入路径，再将等待读写者的逻辑限于已知竞争。ACC 创建目录失败目前会静默返回目标路径，应在首次实际使用时交付可诊断的错误。将“空数据也能继续”的分支从必需配置、权限确认、写入失败路径移出；非关键遥测失败仍可独立处理。[会话竞争测试](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/dev-harness/unit/session-head-read.test.js#L45) · [ACC 目录](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/mcp/ai-computer-control/src/ai_computer_control/paths.py#L30) · [配置恢复](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/app/backend/config-store.cjs#L159) |

清理防御性代码的尺度是能否说明调用契约和失效后果。重复归一、可证明不可达的通道、静默换引擎、无条件等待可直接列入删除项。授权、工具执行前确认、原子落盘与并发写保护、子进程归属及损坏数据恢复都有可观察的外部后果，应将必要检查集中到边界，并用对应失败用例验证。

## 4. 能效、延迟和安装包

| 优先级与位置 | 当前成本 | 修改办法与有效性指标 |
| --- | --- | --- |
| 高 · Web 托盘和侧栏 | 托盘启动后固定每秒渲染和扫描全栏，另有 3/10 秒刷新、10 秒计数、展开输出后每 2 秒请求。侧栏的 `railRowChips` 对同一行取两遍会话；缓存未命中时，每次线性搜索 `state.sessions`，R 行、S 个会话最坏 O(R×S)。 | 用任务事件、线程切换及侧栏渲染完成通知更新受影响的行。首次显示、事件流恢复时补一次快照，确认事件覆盖新增/完成后去掉健康连接下的空闲拉取。仅可见且显示计时或输出的任务更新自己。每轮渲染建一次会话 ID 索引并复用行对象。记录 0/50/500 行的回调、查询、请求、侧栏渲染 P95，以及断流重接后任务是否对齐。[托盘](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/app/public/js/background-tray.js#L99) · [行查找](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/app/public/js/steward-board.js#L890) |
| 高 · 后端调度 | 等待间隔从 2 秒取最小值，节点配置 60 秒也会最多约 2 秒就唤醒调度。任务先完成时，`Promise.race` 中的计时器会留到到期。每个活动 Claude 子节点另有 250 ms 邮箱轮询。 | 工作流按最早的真实检查时间或截止时间安排一个可取消的计时器，入队、停止、恢复直接唤醒；只在确需观察外部条件时轮询。钉住暂停期间的超时计算、并发槽、插话先后和重复投递。对链传播改用邻接表和就绪队列，先固定多源冲突时现有优先级及含环输入返回值。[等待调度](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/app/backend/agent-workflow.cjs#L608) · [竞速等待](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/app/backend/agent-workflow.cjs#L1182) · [子节点](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/app/backend/claude-subagent.cjs#L236) |
| 高 · 带历史数据的启动、Web 首屏 | 监听前恢复孤立任务会顺序读会话头，空目录基准不能反映其成本。Web 入口的静态依赖闭包覆盖 79 个自有 JS 中的 78 个，含入口共 2,763,795 未压缩字节，另 1 个走动态导入。启动早期和加载配置后各设一次语言，同语言仍调用全页翻译。设置控件在面板隐藏时也会填充。 | 对 0/100/1,000 个历史会话记录读头次数和健康就绪时间。优先用已知活动记录定位恢复对象，旧数据走一次核对；任何可执行入口须等自己的恢复完成。Web 只在首次打开时加载设置/迁移等非首屏模块，语言相同时只翻译新增 DOM。验证首屏可交互、首个模型请求前的本地耗时和首次打开设置的 P95，以防只是把等待移给下一次点击。[启动](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/app/backend/server-startup.cjs#L92) · [语言](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/app/public/js/i18n.js#L139) · [设置](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/app/public/js/provider-settings.js#L188) |
| 中 · Mac 窗口/Office 读取 | 窗口移动和缩放每次回调都在主线程原子写 frame。Excel 读取每次创建 daemon 线程，20 秒后可向调用方返回超时，原线程仍运行，相邻的慢请求可能叠加。 | 合并窗口写盘，同值跳过，关闭/退出时刷最后位置；测持续拖动时的实际写次数。对 Office 先测并发慢文件和正常文件的延迟；用有界且可终止的读取任务处理超时，只把所需结果带回主进程。验超时后工作线程或进程归零、其他工具仍可用、读取内容一致。[宿主](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/desktop-macos/RuyiDesktop.swift#L679) · [Excel](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/mcp/ai-computer-control/src/ai_computer_control/tools/office_read.py#L27) |
| 中 · Full 离线依赖和构建 I/O | ACC 直接声明 `psutil`、`pyperclip`、`mcp[cli]`；业务源码无前两项 import，剪贴板走 Mac 原生实现。打包器识别 Mach-O 前调用全树 inventory，为普通文件算完整 SHA 后又读文件头。 | 查 CLI 是否有发行入口，重解依赖及各配置锁、离线 wheel 清单；在干净的 Full 环境跑 `pip check` 和 stdio、剪贴板、Office、浏览器冒烟。Mach-O 发现改为安全遍历和读文件头；资产锁校验、最终签名载荷清单和独立验包继续逐件核验。记录实际删除的 wheel、App/DMG 字节数和构建读取字节数。[ACC 依赖](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/mcp/ai-computer-control/pyproject.toml#L16) · [原生剪贴板](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/mcp/ai-computer-control/src/ai_computer_control/tools/macos_input.py#L84) · [打包遍历](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/tools/macos-offline-lib.js#L133) |

原生进程监督器已经使用 kqueue，已归档的旧版对照测的是特定 helper 和包指纹。宿主中 0.5 秒的页面验收计时器只在相应验收模式启用。全局搜索到计时器只用于发现候选，优先修改正式运行路径上已确认的重复工作。[监督器](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/resources/macos-process-helper.c#L397) · [宿主计时器](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/desktop-macos/RuyiDesktop.swift#L572)

## 5. 测试、文档和历史材料

| 清理对象 | 处置 |
| --- | --- |
| 快速检查自身重复 | 语法扫描的目录交叠，1,636 个不同文件被检查 2,036 次。对已收集路径去重可确定少启动 **400 个 Node 进程（19.6%）**，继续对前端按 ES module 解析。指定单件运行目前仍带整批单元，分离定向入口和集成入口。删不存在的 overlay 测试超时项、没有成员的已知失败表及专用分支。比较实际耗时、文件集合、失败报告和退出码。[语法门](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/dev-harness/syntax-gate.js#L17) · [测试选择](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/dev-harness/run-all.js#L470) |
| 退出的运行场景 | `credential-vault.e2e.js` 的 119 行 DPAPI 夹具在 Mac 上无条件跳过；先把跨进程恢复和篡改处理的独有断言并入 Mac Keychain 测试，再退役该件。旧 overlay 的“不存在”用例并入通用未注册路由和鉴权测试。测试里 326 个 E2E、158 个单元仍含旧的 `WIN_CLAUDE_WORKBENCH_HOME`；迁移到隔离 HOME、RUYI_HOME 和 Mac 浏览器 profile 后再删旧夹具。[凭据 E2E](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/dev-harness/credential-vault.e2e.js#L45) · [overlay](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/dev-harness/macos-overlay-boundary.e2e.js#L47) · [隔离目录](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/dev-harness/lib/fixture-home.js#L62) |
| 锁住行数、文件名、空实现的测试 | 对每项源文本断言找出唯一保护的用户行为。构建器已校验拼接行区间；重算同一公式的断言可并入构建器的错输入用例。保留产品行为、传输契约、鉴权、配置/会话迁移、重复启动、停止与恢复、实际 Mac 能力测试。把旧快照替换为可触发的断言后再减少件数；live 跳过单列。[行区间](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/dev-harness/manifest-ranges.static.e2e.js#L24) · [构建校验](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/ruyi-workbench/app/build.js#L71) · [源码快照](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/dev-harness/architecture-contract-snapshots.static.e2e.js#L15) |
| 文案和生成文档双写 | 两份 `docs/i18n/locales` 与应用目录的对应语言包逐字节相同，共 **665,072 字节**。文档直接指向随包词典，测试改读同一处，保留两种语言键名、插值、界面回归。依赖图、路由表、状态清册的人读版和机读版需确认消费者，重复的人读明细可按需生成，确保 CI 仍能检测结构漂移。[语言门](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/dev-harness/i18n.static.e2e.js#L11) · [另一处读取](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/dev-harness/copy-path-guard.static.e2e.js#L55) |
| 移植证据与历史方案 | `MACOS-PORTING/evidence` 有 **5,979 个文件，248.44 MiB，占跟踪内容逻辑字节数 83.38%**。其中 P5 占 181.87 MiB；证据目录中相同 Git blob 的额外副本有 1,501 个，检出后占 7.03 MiB。有现行消费者的探针和锁直接放到测试或打包目录。重复尝试、展开日志、其他 agent 的开发指令和过时副本直接删除，无需另存归档。`docs/optimization-plan` 95 个文件、`docs/archive` 36 个文件先区分现行契约与历史叙述；把仍往历史文档目录写结果的评测脚本改为输出到独立运行目录。保留 Git 历史和第三方许可。[Mac 实机验证](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/docs/mac-native/STATUS.md) · [仍在用的 Office 探针](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/mcp/ai-computer-control/tests/verify_macos_office_sample.py#L134) · [写回历史目录的评测](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/dev-harness/111-compaction-live.js#L80) |

## 6. 实施顺序与验收

每批都可以单独评审和回退。行为改动与覆盖其行为的测试同批落地。避免先删测试让退役功能看起来已经清干净。

| 批次 | 交付内容 | 通过条件 |
| --- | --- | --- |
| 0 · 建立对照 | 冻结当前提交、Node 版本、Full/Slim 变体、输入夹具和缓存状态。记录带历史的启动、列表与模型首帧、空闲、前后台切换、文件树/安装包体积。用离线假模型隔离网络和生成时间。 | 同机可重放，记录冷启动样本与预热样本、原始耗时、请求/计时器/文件读取次数和候选指纹。 |
| 1 · 低风险删除与帮助修复 | 删死定义和空面板接线，给语法门去重，语言包归一。删除错误的安装入口，补齐可从 Full/Slim 打开的 Mac 帮助手册。 | 语法扫描去重前后文件集合一致；双语键和插值通过；源码和两种包均能读到四份正文。可先验证临时白名单载荷，最终集成再做整包。 |
| 2 · Kimi 退役 | 先完成失效引擎的通用会话行为，再删发现、导入、执行、压缩、UI、测试和包资源。重算装配、路由和事实清单。 | 旧对话可读，续聊或定时任务不能误发给 Claude；用户主动选择后可继续。Claude CLI 与三种标准线协议各走一次假端点回合；无专属模型预设、后台进程、配置目录读写、专属 API 和载荷文件。 |
| 3 · Windows 收口 | 统一 Mac 原生壳和浏览器的路径语义、工具和打包路径；退出 AppData、旧安装器、旧同步与迁移热路径。同步更新夹具、文档及贡献入口。 | Full/Slim 独立数据根、旧 Mac 安装升级/回退、敏感目录与链接、外来文件名和编码、Keychain 恢复均通过。对照源码、测试、产品说明和载荷的 Windows 命中，记录每项已移除或实际还需服务的行为。 |
| 4 · 能耗与交互延迟 | 依次替换托盘轮询和侧栏查找、会话头无条件退避、工作流等待和传播。独立提交首屏懒加载、窗口写盘；用读写计数决定是否进一步优化启动恢复和 Office worker。 | 第 1 节四个复现逐一对照。隐藏空闲托盘的逐秒侧栏扫描降至 0。确认不存在且无写者的会话头无固定退避。逆序长链保留结果，工作量随边数近似线性。断线重接、暂停/停止、并发写入和恢复专项通过。 |
| 5 · 后端解耦与依赖裁剪 | 按 Provider 回合、工作流、配置、路由逐域调整职责；收敛导出和后填 hooks。按实际使用精简 ACC 根依赖、打包读取。没有独立消费者的适配层随调用者退役。 | 可从正式入口独立验证各域，通用协议、事件顺序、授权、流式收尾与可恢复写入等价。字面依赖图继续无环；同时检查注入顺序。离线锁可重建，两个包分别做功能和尺寸对照。 |
| 6 · 仓库收尾与发行验收 | 将阶段 1–5 已替代的结构锁、移植过程日志、旧方案和生成镜像退出活跃树，修正仍指向旧目录的现行入口。独占跑性能基准，集中构建 Full/Slim。 | 定向和完整 Mac 适用回归分别列通过、失败、跳过；给出两个制品的源码/资产指纹、安装升级回退、帮助、权限、截图输入和睡眠唤醒结果。工作树字节、制品字节、CPU、延迟各自报告。 |

**性能对照方法。** 后端复用现有配对基准，基线与候选在同机交错运行，沿用工程既有的启动、请求 P95、RSS 不超过基线 110% 的回归预算，并为本轮针对的热点单列前后值。现有脚本只测空会话列表，需加真实规模的会话、长列表和假模型首帧。前端以 WKWebView 的“可输入并能发送”、首次打开设置、任务出现与停止为观测点；分别测可见空闲、隐藏空闲、运行任务、断流恢复。用 Instruments 记录整个 App、WebContent 和 Node 进程树的 CPU 与唤醒，需报告能耗时另行采集同条件的能耗数据。测试计时器回调数、CPU 时间、耗电量分别列出。收益超出测量波动后再写入发布说明。[后端配对基准](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/dev-harness/macos-workbench-performance.py) · [监督器专项](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a34426695be07f2e89050c2dfcd9a4e39ce3a07/dev-harness/macos-supervisor-energy.py)

## 7. 工作树实施与验收

第 1–6 节记录基线发现和分批计划，源码行号对应 `7a344266`。本节记录截至 2026-11-20 的未提交工作树及由它生成的内部候选。

### 已删除的开发遗留物

按可检入文件统计，基线为 8,222 个、约 298.0 MiB，当前为 1,990 个、约 34.4 MiB，逻辑字节减少约 **88.5%**。当前口径含新报告与锁文件，排除 Git 元数据、忽略的依赖和构建产物，以及用户自有的未跟踪手工验收目录。相对基线已删除 **6,241 个跟踪文件**。其中移植过程证据占 5,979 个、248.44 MiB。其余删除包括阶段方案、给开发 agent 的交接提示词、旧安装说明、重复双语词典、过期原型和测试，以及已经退役的产品模块。两代端口批改脚本、按行号切分后端的脚本、一次性工具派发改写脚本、v2.5 临时冒烟脚本均已删除。旧 Claude 压缩决策探针和两个已被正式链路测试覆盖的 DeepSeek 搜索协议探针也已清退。另清理 9 个废弃发行目录。过时的 5 份预览版与旧分发说明已直接删除，面向用户的变更记录收敛到未发布条目。支持说明、双语安全政策和 GitHub 表单改为 Mac 现行入口。以上删除未创建归档或备份。仍由正式运行路径加载的内置角色提示词、第三方许可和用户当前的手工验收材料有独立用途。

另删除两个绑定开发机旧 provider ID、用于旧发行说明取证的 ASR 探针，以及早期 stdio 工具数故障诊断脚本和它的单工具 Python 夹具。现行语音路由测试覆盖两种上游协议，Mac MCP 能力测试直接从真实服务读取工具清单。

### 已实施的结构与性能调整

| 范围 | 产品变化与核验 |
| --- | --- |
| 引擎 | 11 个 Kimi 专属后端模块以及探测、执行、同步、设置、菜单和专属 API 已退出。未知引擎在发送和手动压缩时提示不可用。第一方产品源码有 3 个后端文件保留旧名字，用于清除旧配置键和保护已有外部文件。 |
| 装配与路由 | 83 个片段、580 条边、0 个非平凡强连通分量。鉴权之后按首段选择候选域，只有共用前缀才按原顺序查找。会话列表只进一个域处理器。覆盖清册的单元断言以及鉴权、SSE、迁移入口实测通过。路由清册含 170 个判定点、156 条鉴权规则、6 个未覆盖点。 |
| 回合与文件 | CLI 与 Provider 共用回合末元数据协调，每回合从读完整正文改成只读一次会话头，各自的待办覆盖顺序保持原样。Provider 的端点选择和故障切换归到 HTTP 层。文件搜索只映射命中项的路径，符号链接上的匹配正文可以逐字回读。glob 大括号达到既有 64 项上限立即停止，匹配状态数组复用，5,000 组基线对照结果一致。 |
| 空闲与启动 | 托盘按事件更新，子节点邮箱由入队通知唤醒；工作流按实际截止时间等待，减少无效唤醒。逆序 2,000 边传播的五次调用中位数从 61.84 ms 降至 1.85 ms，另有 2,000 组随机图结果对照。窗口移动/缩放合并写盘。启动 CLI 探测使用单个在途 Promise。 |
| 界面与测试 | 前端使用后端给出的上下文上限，缺值显示未知或已用 token。删除前端模型猜测表及测试中的重复实现。Mac Chrome 夹具统一使用独立 profile 与隔离密钥；真实浏览器的隐私专项 1,562 项检查通过，含 15 次 DOM 发送及 54 个 provider 请求。加密存储的测试覆盖主配置、备份、损坏恢复和 MCP 凭据。 |
| 发行依赖 | Full 离线 Python 锁由 66 项降到 57 项。Full 与 Slim 的四份帮助正文均随包分发，实际 HTTP 返回内容与源文件相符。 |

### Full 与 Slim 候选

下表对应包含 Office 超时回收、Provider 与调度器调整、导出精简和 MCP 请求清理合并的两个 ad-hoc 签名 arm64 内部候选，共有同一组 **819 个源码文件**。已逐项比对两个 manifest 的源码哈希及构建时的工作树内容。均通过只读搬移、WKWebView、DMG 挂载安装、LaunchServices 启动、隔离数据升级及回退。Full 另通过离线依赖、Office、PDF、图表及 Chromium 验收。测试使用隔离目录。

| 变体 | App 逻辑字节，旧 → 当前 | DMG 字节，旧 → 当前 | 当前 DMG SHA-256 |
| --- | ---: | ---: | --- |
| Full，旧包 `7a344266` | 1,015,633,100 → 1,007,892,968 | 436,020,264 → 433,513,923 | `ea71ba3b3b737f1f4de4652225c3a326c2782950287f3e4208ffa57cf986a170` |
| Slim，旧包 `1ece927e` | 140,528,734 → 140,242,827 | 51,513,957 → 51,404,639 | `7e4e0a87f5694f670125390dac98e73db6326eced9e3dfbb8eacba57ec2195fd` |

### 同机性能

使用 1,000 个真实格式的隔离会话，在同机交错测量基线 `7a344266` 和生成最终两款候选的工作树，每边 3 组，每组 200 次已鉴权列表请求。表内为各组中位数。

| 指标 | 基线 | 当前 | 变化 |
| --- | ---: | ---: | ---: |
| 健康端点就绪 | 147.25 ms | 135.44 ms | −8.0% |
| 会话列表请求 P95 | 5.009 ms | 3.369 ms | −32.7% |
| 进程树 RSS | 308.70 MiB | 326.52 MiB | +5.8% |

前一候选使用同一版 v3 监督器执行 10 秒空闲子进程，预热后测 3 次，合计子进程 CPU 时间的中位数为 **0.04515 秒**。该专项只测监督器。最终制品的整机输入功率、睡眠唤醒与运行验收范围见本节末尾。历史制品的权限与唤醒记录见 [Mac 平台状态](../../mac-native/STATUS.md)。

### 集中回归的阶段结果

单元集中运行得到 2,721 通过、4 跳过、0 失败。之后针对修改过的平台与取消用例做了定向验证。语法门检查 1,613 个文件通过，构建、依赖图、路由、持久化清册、架构快照与项目事实检查均通过。清理委托横幅静态测试前的 596 件 E2E 中，分段运行、修复复验后，572 件取得通过记录，13 件按清单跳过，11 件桌面实机专项待验。实机输入与截图宿主上一次受锁屏和权限拒绝影响。通过数包括重跑成功的用例，其中插话撤回和管家自动续跑出现过时序波动，仍值得跟踪。帮助和引导用例改为等待服务退出，三件定向复验均首跑通过。

### 配置、首屏和测试清理

配置入口移除了逐字段维护、最终又被覆盖的 changed 标记，并共用规范化结果构造落盘数据。69 个配置测试通过。对 2,000 个包含旧版本、未知键和显式值的输入，按三种调用方式与前一候选逐项比对，6,000 次结果一致。

Mermaid 在出现图块时加载。从 app.js 递归解析静态模块导入与再导出，首屏依赖从 78 个文件、2,735,789 字节降至 75 个、2,642,032 字节，净少 93,757 字节。真实 Chrome 在首屏发出 0 次 Mermaid 运行时请求，打开图表会话后发出 1 次并渲染出 SVG。字节数按未压缩源码统计。首屏发送实测见下文。

删除 138 行针对废弃委托横幅的源码文本锁。当前消息历史的正文、折叠、跨线程开合状态和长会话窗口由真实 Chrome 回归覆盖；保留两种语言的摘要文案与插值检查。委托横幅清理完成时，清册计 595 件 E2E，当时有通过记录的为 571 件，13 件 live 跳过，11 件等待实机；最终桌面结果见下文。多处测试中的旧迭代交接说明也已删去。

### Provider 与工作流调度

回合仅在提供 orchestrate_agents 时读取角色库与工作流。角色目录已经去重，调用者直接使用其有序结果。角色、工作流及模型提示共用一个组装入口。修正了仅在 Provider 自身声明模型时缺少选型提示的问题；12 个真实回合用例通过，覆盖项目角色文本中和和模型指引。

节点执行与重规划回调改为每次运行创建一次，调度器在暂停时由完成、恢复或取消事件唤醒，停止后统一等待已派发的节点结束。隔离 HTTP 用例通过真实模型端点夹具独立控制两个节点完成时间，验证暂停期间下游保持排队、恢复后在慢节点结束前完成。调度、生命周期、重规划和模板用例通过。预估波次移除重复扫描及额外循环次数限制，与前一候选逐项比对 5,000 个含等待、环、缺失依赖及重复 ID 的图，波次与插入顺序一致。

### Mac 实测

最终 Full 与冻结基线 Full（`7a344266`）各从隔离目录启动三次，交错运行。通过 WKWebView 的真实编辑框发送同一条消息，本地假模型立即回第一段正文，等待 450 ms 后回第二段。每次验证模型只收到一次请求。以点击发送为起点，在页面内独立观测 HTTP 响应流中的第一个正文事件和消息区 DOM 文本变化。

| 指标 | 基线三次（ms） | 最终候选三次（ms） | 中位数变化 |
| --- | --- | --- | --- |
| 页面收到第一个正文事件 | 303、308、305 | 211、202、209 | 305 → 209 ms |
| 消息区 DOM 出现第一段正文 | 736、735、730 | 644、628、635 | 735 → 635 ms |

锁屏状态下，两款 App 的 DOM 均在第二段到达时或接近该时刻才出现第一段文字。第一项反映本地链路响应延迟；第二项记录文本节点变更。前台解锁窗口的实际绘制时刻仍待实测。

Office 读表修改前的 Slim 通过 WKWebView 在独立数据根中启动三次。每次在应用内编辑框输入并发送，隔离模型端点各收到一次请求，页面显示回复。进程启动至测试点击发送为 2,173、1,036、1,036 ms，点击至页面确认回显为 177、174、179 ms。原生验收器每 500 ms 检查一次页面就绪，启动到点击的观测值是可交互时刻的上界。

Office 读表修改前的 Full 隐藏窗口、接交流电、关闭管家和调度后台任务，基线与候选交错运行，每次静置 3 秒后采样 10 秒，每边 3 组。macOS 提供的宿主与 Node 两个 PID 合计的 CPU 时间中位数从 12.02 ms 降至 8.30 ms，中断唤醒从 89 次降至 87 次。两进程能量估算中位数从 1.44 mJ 上升至 1.75 mJ，单组范围分别为 1.28–16.20 mJ、0.75–4.49 mJ。样本离散且未计入 WebContent 等进程，不能据此推断整机耗电改善。

### Office 读取与超时回收

结构化 XLSX 解析在独立进程内完成，20 秒截止时间覆盖文件打开、数据与公式读取和结果序列化。仅解析进程使用系统定时器。短间隔请求复用同一进程；最后一次读取后空闲 30 秒，宿主关闭管道并回收子进程。普通读取单次打开工作簿，显式要求公式时才按公式模式再打开一次。日期、时间、时长和数字的 Python 类型可通过内部传输还原。

含 150,000 个共享字符串的慢表在先前实现以 50 ms 为测试截止时间，返回后仍消耗 0.41 秒 CPU。新实现超时返回时原 PID 已回收，后续普通工作簿成功读取。阻塞文件读取同样能超时回收。12 次并发调用读取成功，实际空闲 30.04 秒后进程与定时器已释放，下一次调用正常启动新进程。Office 读写、PDF 分页、格式、类型与异常用例均通过。

在两个只读 Full DMG 中用各自签名的 Python 和已安装工具读取同一小表。旧、新各 3 个独立服务进程，每个进程读 32 次。首次读取中位数由 184.65 ms 升至 319.14 ms；随后 31 次读取的中位数由 0.910 ms 降至 0.875 ms。新解析进程在空闲回收前的 RSS 中位数为 51.1 MiB。50 ms 测试截止时间下，慢表在 55.72 ms 返回的同时已回收解析进程。可写安装目录实测发现 Python 默认会生成字节码缓存，改用禁写字节码的解释器入口后，Full 在真实读表后重新通过完整文件清单和严格签名验证。

### 后端入口与 MCP 请求生命周期

包入口从 524 个键收至 520 个。扫描 1,055 个测试与工具 JS 后，从入口移除四个没有消费者的名字：`normalizeSessionEngineRoute`、`warmPretenderProjectionIndex`、`claudeProjectsRoot`、`stewardThreadStateRank`。内部调用与启动预热保留。导出清单剔除了旧实施波次、交接说明和重复测试索引，生成的装配文件减少 144 行。

stdio 和 SSE 共用按请求 ID 登记、收取响应、取消、超时和断连清理的逻辑。stdio 的执行准入和 SSE 的 HTTP 确认仍在各自传输层。60 项定向单元通过。真实子进程收到一次带原请求 ID 的超时取消通知，旧进程退出，下一次请求在新进程成功。远程传输、索引延迟建立、会话存储和管家线程排序 E2E 通过。构建、装配依赖、路由、持久化、架构和项目事实检查通过。

### 本机最终验收

2026-11-20 在已解锁的 macOS 27.0.1 桌面运行此前待验的 11 件。源码链路的截图、辅助功能、输入事件、窗口与剪贴板、OCR、组合观察、受控录制、手动录制和真实应用输入共 9 件通过，合计 324 项通过、0 跳过。输入事件首次运行在夹具退出时未确认原剪贴板已恢复。验收器改为等待输出管道关闭，并在恢复失败时记录版本号；单独复验 43 项通过，含恢复原剪贴板及释放修饰键。首次失败的原因未独立确定。

从最终 Full DMG 复制出的 App 与镜像内宿主 CDHash 均为 `5e92b06e1b5ab5ff51440a79607f8ed14cfed3c6`，签名校验通过。通过 LaunchServices 启动后，隔离服务确认了正确的 App 和工具字节。首次产品链路验收中，macOS 对该副本的屏幕录制、辅助功能和事件投递返回拒绝。用户为这份副本授权后，截图宿主 7 项、输入宿主 14 项均通过。正常 HTTP 工具入口返回了 3420 × 2214 的真实 PNG；隔离窗口收到完整中文及 emoji、一次鼠标按下、一次释放和一次垂直滚动。修饰键和鼠标按钮全部释放，测试启动的进程均已退出。

输入初验曾记录额外的鼠标释放，另有窗口失焦、光标位置无法确认的调用。验收器增加事件来源 PID 记录，按实际观测到的 App 进程树核对按下、释放和滚动次数。指针静止后，最终复验中这三个事件来自同一个受验子进程。产品权限检查和光标定位判据保持原值。本轮待验的 11 件桌面专项至此全部通过，595 件 E2E 中有 582 件通过记录、13 件 live 跳过。

Full 的原生依赖清单含 209 个 Mach-O 文件，Slim 含 7 个。arm64 切片中的最低系统版本最高均为 14.0。按 2026-11-20 更新的契约，Full 与 Slim 的运行验收只要求本机 Apple Silicon、macOS 27.0.1。两款已在本机安装和启动。macOS 14.0 为构建部署目标，未进行该版本的运行验收。内部试用版本使用 ad-hoc 签名。

最终 Full 与基线 Full 各运行三组隐藏空闲场景，按基线、候选、候选、基线、基线、候选交错启动。测试机接交流电，电池为 100% 且未在充电，后台管家和调度关闭。读取 AppleSmartBattery 的整机输入功率累加值与样本数，以相邻硬件更新窗口的差值求平均，每组 57–58 个硬件样本。基线三组为 9.42、7.41、6.57 W；候选为 7.14、6.39、6.72 W。三组中位数分别为 7.41 W 和 6.72 W。两组范围有重叠，读数包含屏幕和其他进程，尚不能量化 Ruyi 自身的节电比例。

两个最终 DMG 的隔离安装均成功启动，并建立了唤醒验收所需的事件流和游标。首次五分钟观察窗口内没有发生睡眠。第二次观察中，系统在 11:23:21 记录了由软件请求进入 DarkWake；Full 和 Slim 的原生报告都记录到一次睡眠通知。11:25:30 验收器到达共用截止时间并退出，两款 App 当时的唤醒计数均为 0。验收器已将等待睡眠、等待唤醒和恢复后的健康检查分开计时。当前候选的实际唤醒恢复仍未验实。
