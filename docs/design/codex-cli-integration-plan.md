# Ruyi for Mac 接入 Codex CLI 开发计划 v1

2026-11-23 · 开发计划与实施记录 · 代码基线 `5bf6df62`

**首版目标**是让用户在如意里选择「Codex CLI」，用 ChatGPT 授权套餐用量，选择当前账号可见的模型，在普通线程里完成一次有工具调用的任务。用户能看到输出、批准或拒绝操作、中止任务，并在重启如意后接着聊。建议首版使用用户安装的 Codex，按本仓库目前的开源、本机 Mac 发行形态设计。套餐推理需要联网，其他本地功能保持离线可用。[项目说明](../../README.md) · [工程约束](../../CONTRIBUTING.md)

## 技术路线

Ruyi 负责账号授权、模型选择、工作区、权限决策和显示。Node 后端通过标准输入输出驱动本机 `codex app-server`，Codex 负责模型回合、原生工具和线程上下文。如意的本地工具通过现有 MCP 服务提供。这个边界能保留工作台的停止按钮和审批卡，也符合后端只用 Node 内置模块的约束。`codex exec --json` 适合一次性任务探针；官方 SDK 适合引入运行时依赖的应用。产品集成选用 app-server 的双向协议。[接口选择与官方 Relay 案例](https://developers.openai.com/blog/codex-as-a-platform#example-relay)

**ChatGPT 套餐授权使用 Sign in with ChatGPT。** OpenAI 为本地开源应用提供动态注册及套餐授权，并给出了将访问令牌交给 Codex app-server 的配置。用户在系统浏览器里用已有 ChatGPT 账号向 Ruyi 授权，无需填写 OpenAI API Key。Ruyi 管理自己的授权记录，独立于用户在终端的 Codex 登录。官方对既有本地应用使用 app-server 内置登录另有兼容说明；若未来改为付费或远程托管发行，需按该发行形态重新确认接入渠道。[开源应用授权](https://developers.openai.com/siwc/token-sharing-open-source) · [套餐版 app-server 配置](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server) · [原生登录适用范围](https://learn.chatgpt.com/docs/app-server#auth-endpoints)

## 现有代码和可借鉴的案例

| 位置 | 现状及其对实现的影响 |
| --- | --- |
| 驱动登记与执行 | 前后端都有 CLI 注册表，线程已有 `{engine:'agent', agentCliType, model}`。目前非 HTTP Provider 回合统一交给 `runClaudeTurn`，内部使用 Claude 参数、stdin 格式和 `claudeSessionId`。从这里按驱动分派，增加独立 Codex 执行器，沿用上层回合所有权、事件和会话保存。[后端注册表](../../ruyi-workbench/app/backend/agent-cli-types.cjs) · [前端注册表](../../ruyi-workbench/app/public/js/agent-cli-registry.js) · [回合入口](../../ruyi-workbench/app/backend/session-turn-runtime.cjs) · [Claude 执行器](../../ruyi-workbench/app/backend/agent-cli-turn.cjs) |
| 设置与恢复 | “上次使用”只认 Claude。保存全局 `model` 及启动同步都可能把值写进用户的 Claude 设置。Codex 需要独立的模型、推理强度、缓存和原生线程绑定。旧配置中的值继续按 Claude 解释。[会话路由](../../ruyi-workbench/app/backend/session-engine-route.cjs) · [保存配置](../../ruyi-workbench/app/backend/config-patch.cjs) · [Claude 同步](../../ruyi-workbench/app/backend/claude-config-sync.cjs) · [启动同步](../../ruyi-workbench/app/backend/server-startup.cjs) |
| 用户入口 | 模型接口已有按会话选择驱动目录的入口。前端还需改首次向导对 CLI 就绪的判断、设置页的 Claude 路径字段、模型缓存的回退，以及历史消息的引擎徽标。测试切回旧线程时显示当时使用的模型。[模型接口](../../ruyi-workbench/app/backend/provider-routes.cjs) · [首次向导](../../ruyi-workbench/app/public/js/onboarding-wizard.js) · [设置页](../../ruyi-workbench/app/public/js/provider-settings.js) · [消息显示](../../ruyi-workbench/app/public/js/chat-render-primitives.js) |
| 工具与记账 | 迁移中心已识别 Codex 的 MCP 配置、技能和指令。新执行器应按实际加载来源去重，尤其是 `AGENTS.md`。已有 MCP 清单按线程传递工具包和桥接凭据。用量写入和汇总目前都把非 Claude 记录归到 OpenAI API，两个入口需一起改。[迁移中心](../../ruyi-workbench/app/backend/migration-center.cjs) · [指令过滤](../../ruyi-workbench/app/backend/agent-instruction-imports.cjs) · [MCP 清单](../../ruyi-workbench/app/backend/mcp-manifests.cjs) · [账本](../../ruyi-workbench/app/backend/usage-ledger.cjs) · [汇总](../../ruyi-workbench/app/backend/usage-summary.cjs) |
| 第二种 CLI 的历史实现 | 退役前的 Kimi ACP 接过双向 stdio、服务端请求和人工审批。可以参考请求 ID、待决请求清理、停止后续聊及真机验收设计。Codex 消息按 OpenAI 协议独立实现。[历史 RPC](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a344266/ruyi-workbench/app/backend/kimi-acp-rpc.cjs) · [历史审批桥](https://github.com/Sonata17inD/ruyi-workbench-mac/blob/7a344266/ruyi-workbench/app/backend/kimi-acp-interventions.cjs) · [退役记录](../audits/2026-11-19-mac-slim/REPORT.md) |

OpenAI 的 **Paste Perfect** 可用于对照桌面应用的账号授权与凭据生命周期，**Relay** 可用于对照本地 MCP 的读取、写入前人工确认和结果回显。两者分别覆盖了 Ruyi 最需要验证的两个交互。[Paste Perfect](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt) · [Relay](https://developers.openai.com/blog/codex-as-a-platform#example-relay)

## 实施顺序和验收

以下按一名熟悉仓库的开发者估算净开发与测试时间。先交付一条真实的订阅回合，再扩展界面和工具。版本兼容与真账号授权以第一阶段结果为准。

| 阶段 | 工作内容 | 进入下一阶段的条件 | 估算 |
| --- | --- | --- | --- |
| 0 · 验证订阅链路 | 选一个单独安装的正式版 CLI，保存其版本和协议样本。做最小 Ruyi 授权、查询该账号模型、启动 app-server、跑一条短文本回合。随后接一个只读本地 MCP 工具，核对预览接口是否接受该工具声明。 | 无 API Key 的测试账号返回 `turn.status=completed`；工具实际返回结果；记录测试过的版本、模型和脱敏后的终态。 | 1–2 人日 |
| 1 · 账号、探测与路由 | 增加 `agentCliType:'codex'`；探测手填路径、PATH 与常见 Mac 安装位置，保留异步缓存。从 Finder 启动验证路径。实现账号授权、刷新、退出及账号级模型目录。更新首次向导、设置、线程模型菜单、“上次使用”和中英文文案。 | 只装 Codex 的用户能完成引导。缺 CLI、断网、仅授予身份权限各有可操作的状态；切账号不串模型，切驱动和重启不改 Claude 的模型。 | 3–5 人日 |
| 2 · 主线程与恢复 | 编写基于 Node `child_process` 的 stdio 客户端和 Codex 回合执行器。接入普通聊天的输出、工具活动、进程管理、中止、消息落盘、重启续聊。复用现有工作区、会话记忆和任务上下文。 | 原界面完成两轮对话，重启续上同一线程。两条并行线程事件互不串线；中止、子进程异常退出和迟到事件都只结算一次。 | 3–4 人日 |
| 3 · 审批与 Ruyi 工具 | 对接现有权限决策、有效权限档、隐私网关和本地 MCP。以只读查询和需确认的工作区编辑各走通一例。补齐工具结果、消息来源、订阅用量及错误呈现。 | 用户拒绝后文件保持原值，批准后只改一次；只读档经原生工具和 MCP 均无法写入；配置的隐私模式在启动或发起 CLI 回合前生效。 | 3–5 人日 |
| 4 · 发行回归 | 加入假 app-server、假 OAuth/模型目录及 UI 回归。更新装配产物、Mac 运行文件清单和使用手册，用 Full/Slim 安装副本验证。 | 两包均从 Finder 完成真实授权、选模型、工具审批、停止和重启续聊；旧 Claude/API 会话和离线启动通过回归。 | 2–3 人日 |

合计 **12–19 人日**。如需让工作流节点、角色子代理、无人值守调度或管家主模型也消耗该订阅，另排后续迭代。当前工作流和子代理各有 Claude/API 专用分派，管家主循环只接受 Provider。首版在这些入口显示实际支持的引擎，后端对显式指定的未支持组合返回可识别错误，避免由其他引擎或付费端点代跑。[工作流入口](../../ruyi-workbench/app/backend/agent-workflow-routes.cjs) · [节点执行](../../ruyi-workbench/app/backend/subagent-runner.cjs) · [管家执行](../../ruyi-workbench/app/backend/steward-runner-lifecycle.cjs)

**贯穿各阶段的样例任务**可以用临时工作区里的两份会议记录。第一轮要求 Codex 用 Ruyi 文件工具读取记录并列出待办。第二轮要求写入 `待办.md`，先拒绝并检查文件未创建，再发起一次、批准并核对内容。重启 Ruyi，追问某条待办来自哪份记录。这个例子一次覆盖了套餐推理、工具路由、审批、写入次数和原生续聊。

## 实现时要固定的契约

1. **账号与模型。** 系统浏览器配合 `127.0.0.1` 回调，实现 PKCE S256、state、nonce 和 ID token 校验。按安装保存 host ID，按用户和 workspace 保存签发的 client ID。只有实际授予 `chatgpt.tokens.use.direct` 才启用套餐执行。凭据用现有 macOS 钥匙串保护能力独立保存，同一账号串行刷新。账号数据和登录操作走鉴权路由，开放的状态接口只给摘要。用同一授权令牌查询 `GET /v1/models`，按服务端顺序显示 `visibility:list` 条目的 `display_name`，用 `slug` 执行。app-server 的 `model/list` 可能来自内置目录，选中模型的可用性以实际回合结果为准。[登录协议](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) · [模型目录](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) · [账号生命周期](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions) · [如意路由权限](../../ruyi-workbench/app/backend/http-route-policy.cjs)
2. **令牌与进程。** 用官方套餐 provider 配置启动 `codex app-server --listen stdio://`，固定公开 Responses 端点，按官方配置关闭 WebSocket。仅向该进程提供短期 access token，refresh token 留在 Ruyi。明确过滤交给 shell 和 MCP 子进程的环境，测试日志、参数和工具输出均不带凭据。工作区或用户配置不能把这项授权重定向到自定义端点。刷新后在回合边界重启进程，用原 thread ID 恢复。建议先按活动线程归属进程，空闲或退出时回收，复用现有子进程树清理。[订阅版配置](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server) · [预览限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
3. **消息与会话。** `initialize` 成功后发送 `initialized`，以 `thread/start` 或 `thread/resume` 获得线程，以 `turn/start` 发起回合。正文增量、工具开始/结束、审批、用量、最终状态映射到如意现有聊天 NDJSON 事件。停止传 `threadId` 和 `turnId` 给 `turn/interrupt`。按线程、回合和 item ID 对齐增量与最终文本；只在 `turn/completed` 的状态为 `completed` 时记成功。把 Codex thread ID 与 Ruyi 线程、工作区和账号绑定；切账号、回退、分叉、压缩或切引擎时按有效历史断开或重建绑定。进程失联后先对账，有工具副作用的回合禁止自动重放。[App Server 协议](https://learn.chatgpt.com/docs/app-server) · [会话回退](../../ruyi-workbench/app/backend/session-rewind.cjs) · [现有聊天流](../../ruyi-workbench/app/backend/http-chat-stream.cjs)
4. **实际执行权限。** 逐档验证 `plan`、`default`、`acceptEdits`、`auto`、`bypass` 对命令、文件和额外授权的语义。Codex 沙箱内有些操作会直接执行，单接 `requestApproval` 无法证明“每步都问”。对需要逐次审批的操作，只有验证能在执行前拦截时才开放原生路径，否则通过 Ruyi 受控工具执行并关闭对应原生能力；无法兑现的组合在 UI 和后端标为不可用。审批绑定具体请求、线程和回合；拒绝、到期和断连均收尾。沿用现有 CLI 隐私门禁以及 MCP 会话范围、检查点和撤销语义。对本地文件读写与云端推理分别呈现。[权限策略](../../ruyi-workbench/app/backend/agent-role-policy.cjs) · [审批等待器](../../ruyi-workbench/app/backend/native-approval-waiters.cjs) · [隐私网关](../../ruyi-workbench/app/backend/privacy-gateway.cjs)
5. **套餐状态与记账。** 区分未授权、模型或 workspace 不可用、套餐/应用限额、服务暂不可用、协议版本不兼容。额度失败可能在正文已开始后到达，保留已输出内容并显示真实终态，由用户决定是否更换模型或计费渠道。账本按 Codex 和模型记录当回合 token，区分累计与增量、缓存与总输入，费用填 `cost:null, costTrusted:false`。额度详情按官方来源展示。[错误恢复](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery) · [会话用量](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions#tracking-usage)

6. **本地配置。** 从现有会话清单构造 Codex 接受的局部 MCP 配置，按线程传递工具包与凭据，避免回写用户的全局 `~/.codex/config.toml`。验证原生 `AGENTS.md` 与迁移记忆各自实际加载的范围。隐私网关开启时沿用现有产品行为，禁止 CLI 发送回合并在界面解释原因。[会话清单](../../ruyi-workbench/app/backend/mcp-manifests.cjs) · [指令来源](../../ruyi-workbench/app/backend/agent-instruction-imports.cjs) · [CLI 隐私检查](../../ruyi-workbench/app/backend/agent-cli-turn.cjs)

## 测试基线

**实施与验收记录（2026-11-23）**

| 验收项 | 已观察到的结果 |
| --- | --- |
| 本地开源应用授权 | 包内 Node 从公共 OIDC 发现端点核对了签发方和 RS256 签名算法，并从公布的 JWKS 端点取到了 RSA 公钥。隔离测试覆盖浏览器回调的 state、签名和 nonce 校验、套餐 scope、可见模型过滤、并发刷新与退出撤销。 |
| 正式版 Codex | 在 Apple Silicon 上，Full 和 Slim 候选包各自用包内 Node 和后端启动独立安装的 Codex 0.171.0。每包在本机 Responses 模拟端点完成四个回合、九次推理请求。每轮都重新启动 Ruyi 后端及 CLI，后续回合恢复同一个原生 thread ID。账本按各轮的增量记录输入 token。 |
| 权限与副作用 | 正式 CLI 执行如意 MCP 读取后，下一次推理请求包含了文件原文。默认档拒绝写入后文件不存在，下一次批准后写入了预期内容。对同一项写入，只做计划档阻止执行，自动接受编辑档写入成功，这两种档位都未弹出审批。 |
| 回合生命周期 | 隔离的假 CLI 验证了流式文本去重、续聊、插话落盘、停止、切换账号后隔离历史、手动压缩，以及出现配额错误时保留部分回复和失败状态。另在两个工作区同时运行独立线程，一个 CLI 意外退出后仅结算一次并保留部分输出，另一线程仍可插话和停止。启用增强隐私后，Ruyi 在读取套餐凭据和启动 CLI 之前拒绝了新回合。 |
| Mac 候选包 | 两包均已用更新后的源码构建，包清单、文件树和开发签名均通过核验。经 macOS LaunchServices 从隔离目录启动，WKWebView 加载了工作台，在临时用户目录探测到正式 CLI，显示未登录入口，退出后服务停止。两包均通过只读搬移和断网启动验收。另在隔离环境中隐藏两种 CLI 后，两个包的原生窗口均正常打开，向导将引擎标为未就绪，发起普通聊天能收到设置 Codex 路径的提示。Full 另通过内置办公工具及 Chromium 的离线测试。 |
| 真实 ChatGPT 套餐 | 11 月 24 日，Full 完成真实浏览器授权，验证身份并保存了包含套餐权限的登录。此前 macOS 拒绝后台重复读取钥匙串。新版重启后通过系统授权解锁原有登录，模型选择器使用的接口取得该账号可见的 10 个模型，包括 GPT-6.2-Sol、GPT-6.2-Astra 和 GPT-6.1 Terra。此次验收按账号持有人的选择止于模型目录，真实套餐推理、工具声明和用量仍待验证。正式版 CLI 已测 0.171.0。 |

**11 月 24 日工作台回归。** 浏览器测试依次切换 Codex CLI、Claude CLI 和自定义兼容引擎，核对三次切换均选中「高」，并在模拟服务商上验证发送参数。另以模拟工具回合验证过程收起、手动展开及刷新重建。配置迁移测试覆盖已有工作区和新线程的托管子目录。[引擎切换测试](../../dev-harness/composer-effort.browser.e2e.js) · [对话渲染测试](../../dev-harness/tool-result-render.browser.e2e.js) · [配置迁移测试](../../dev-harness/unit/config-explicit-keys.test.js)

**仓库回归。** 单元测试 2,725 项通过、3 项跳过。快速通道的 74 个静态套件中 55 个通过，19 个失败。这 19 个套件的失败已在独立的 `5bf6df62` 源码上复现。浏览器设置、构建一致性和路由清册均已通过。[本机与包内测试命令](../../CONTRIBUTING.md)

**后续回归清单。** 隔离 HOME、CODEX_HOME、RUYI_HOME；以 fake app-server 和回环 OAuth/模型端点验证半行/多行 JSON、双向请求交错、迟到或重复终态、拒绝和超时、令牌刷新竞争、工作区或账号切换、终止后无孤儿进程。沿用现有注册表一致性、CLI 探测、续接和权限测试模式。更多正式版 CLI 的兼容性仍待验证。集成时运行 `node dev-harness/syntax-gate.js`、`node ruyi-workbench/app/build.js --check`、`node dev-harness/run-all.js --fast` 及新增离线 E2E；真账号验证单独记录。[注册表一致性](../../dev-harness/unit/agent-cli-registry-frontend.test.js) · [Mac CLI 探测](../../dev-harness/macos-agent-cli-discovery.e2e.js) · [Claude 续接案例](../../dev-harness/claude-resume-recovery.e2e.js) · [发行文件清单](../../ruyi-workbench/packaging/macos/runtime-files.json)
