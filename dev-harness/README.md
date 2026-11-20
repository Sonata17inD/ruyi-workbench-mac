# dev-harness —— 如意 Ruyi 后端契约验证脚手架

本目录维护工作台(`ruyi-workbench`)与桌面控制(`ai-computer-control`)的**离线 e2e** 与假件(fake)。
纯 Node、零 npm;路径已改为 `__dirname` 相对解析(dev-harness 与两子项目同级),**无需手改 WB 路径**。

当前总数以根目录 [facts.json](../facts.json) 为准，测试范围和维护约定见 [CONTRIBUTING.md](../CONTRIBUTING.md)。执行入口、端口分桶和跳过项以 `run-all.js` 及对应测试源码为准。

## 怎么跑

```sh
# 单件
node dev-harness/run-all.js openai-engine.e2e.js
# 静态快通道（先运行单测）
node dev-harness/run-all.js --fast --parallel 4
# 全量回归由 runner 检查端口并分桶执行
node dev-harness/run-all.js --parallel 4
```

### macOS 候选包与内测验收

按离线构建说明用同一源码构建 arm64 Full 和 Slim，并分别运行包体验收。用内测包装器制作 DMG 后，分别验证安装，再用两份实际 DMG 做隔离升级与回退。 [离线构建和包体校验](../ruyi-workbench/desktop-macos/OFFLINE-PACKAGING.md) · [内测 DMG 制作和验收](../ruyi-workbench/desktop-macos/INTERNAL-TRIAL.md)

```sh
RUYI_UPGRADE_OLD_DISTRIBUTION=/path/to/old-trial \
RUYI_UPGRADE_NEW_DISTRIBUTION=/path/to/new-trial \
RUYI_UPGRADE_REQUIRED=1 node dev-harness/macos-upgrade-rollback.e2e.js
```

### 浏览器与专项回归

隐私规则另有按需真实输入框验证：`node dev-harness/privacy-31/browser-input-validation.js --output=ruyi-workbench/dist/privacy-validation`。它在独立 home 启动真实浏览器，通过聊天与管家输入框填写、点击发送 45 条目录及对抗语料，检查四档位／技术开关、公开负例、未保存草稿和工具代号读写闭环；另用三代自然段验证整段输入、实际文件返回及代号回填，最新一代含 27 个敏感正例、25 个公开或已打码负例，并审计递归 JSON 解码后的完整模型请求。使用本地假模型，不连接用户实例或真实模型。标题截断与策略切换另由 `unit/privacy-thread-brief-boundary.test.js` 验证；用户显示与 HTTP／历史隔离由 `unit/privacy-display.test.js` 和 `unit/privacy-display-http.test.js` 验证。真实端点矩阵为 `privacy-31/live-matrix.js --live --report=<path>`，含 28 个场景（包括第二／三轮六场景正反例、管家自然语言规则管理和类型异常历史续跑），须显式启用并使用合成材料。

浏览器夹具可通过 `RUYI_E2E_BROWSER` 指定 Chrome 或 Chromium 的可执行文件。需要 `realhist-fixtures/` 的测试会在夹具缺失时记录 `SKIP`，跳过项单独计数。 [浏览器查找规则](lib/browser-path.js)

运行 `engine-env-runtime.e2e.js` 时，将 `RUYI_MACOS_OFFLINE_ASSETS` 指向离线打包准备器的输出目录。夹具使用当前资产锁校验并复制随包的 ripgrep。 [离线构建说明](../ruyi-workbench/desktop-macos/OFFLINE-PACKAGING.md)

第54波的回合叙事视觉门禁可单独运行 `node dev-harness/dom-screenshot.e2e.js`；它调用系统 Edge/Chrome 截取明暗主题，并与 `visual-baselines/workbench-shell-v2.json` 的低分辨率感知网格比较。只有确认视觉变更是预期行为时才使用 `--update` 更新基线。

运行时优化 shadow 有两层无外部依赖测试：`node dev-harness/runtime-shadow-benchmark.js` 用真实 native catalog 跑基础 60 条工具查询、20 条长 observation 与 30 条失败分类样本；`node dev-harness/runtime-shadow-adversarial.js` 再扩为检索误召回/歧义/typo/顺序确定性/1,000 项 catalog 压测、observation 保护误判/非法 JSON/幂等/5 MiB 载荷，以及写操作 transport ambiguity/指纹碰撞。结果分别写到被 git 忽略的 `dev-harness/ab-results/runtime-shadow-latest.json` 与 `runtime-shadow-adversarial-latest.json`。两件都不代表批准主动检索、主动 observation reducer 或自动重试；后者发现产品阻断项时仍可 exit 0，只有 shadow 行为等价、隐私或 fail-safe 不变量破坏才 exit 非零。F1 真实数据用 `node dev-harness/runtime-failure-report.js <RUYI_HOME>` 按最新分类器版本单独过门；分类器升级时可先运行 `node dev-harness/runtime-failure-replay.js <RUYI_HOME>`，它只输出新旧类别聚合和安全计数，不输出或改写原始工具结果。

**离线件应 ALL PASS**(不含需真端点/真 Python 的 live 件)。每件文件头部注释都列了它断言的边界。
需外部条件的件:`deepseek-live`/`deepseek-tools`(真 DeepSeek 密钥)、`desktop-bridge-live`(真 python 桌面 MCP)、
`desktop-mcp-smoke`(`AI_COMPUTER_CONTROL_HOME` 指向 ACC 仓库)。
`model-tier-probe.js` 是**实弹评测件**(非回归、无 `.e2e.js` 后缀、判定行 DONE 而非 ALL PASS,不进离线回归 grep;见下「实弹/探针」)。

## fake 家族 env 契约

### fake-openai.js —— 假 OpenAI 兼容 SSE 端点

| env | 语义 |
|---|---|
| `FAKE_OPENAI_PORT` | 监听端口(默认 8911;也可 argv[2])。 |
| `FAKE_TOOL_PATH` | 首个带 `tools` 的回合吐 `file_read {path: 此值}` 的单 tool_call;下一回合 echo 该工具结果内容。 |
| `FAKE_TOOL_NAME` | 首个 tools 回合调用此(可带桥接前缀)工具名,args 取 `FAKE_TOOL_ARGS`;下一回合 echo。 |
| `FAKE_TOOL_ARGS` | 配合 `FAKE_TOOL_NAME` 的 JSON 参数对象。 |
| `FAKE_TOOL_SEQUENCE` | JSON 数组 `[{name,args}]`。第 N 个带 tools 请求按 history 里 `role:'tool'` 数吐第 N 个**单** tool_call(id `call_1..call_N`,args 分两 SSE 片段);耗尽后 echo 收尾。**优先于** `FAKE_TOOL_PATH/NAME`。 |
| `FAKE_PARALLEL_TOOLS` | JSON 数组 `[{name,args}]`。首个 tools 请求在**一条** assistant 消息里吐全部 N 个 tool_call(index `0..N-1`);下一请求 echo。 |
| `FAKE_REJECT_TOOLS` | `=1`:**首个**带 tools 的请求回 400(消息含 `tool/function` 命中工作台 tools-rejected 嗅探、但避开 stream_options 正则);后续**无** tools 请求正常流式。驱动 `runOpenAiTurn` 去 tools 重试分支。一次性(首拒后翻标志)。 |
| `FAKE_STREAM_DELAY_MS` | `=N`:每个 SSE 数据帧之间 sleep N ms,把 turn 拉长(≈N×帧数),给 steering/loop 测试留插话窗口。作用于 tool-sequence 与 echo 路径。0=瞬时,零行为变化。 |
| `FAKE_CAPTURE_DIR` | 每个请求体落盘 `<dir>/req-<n>.json`(n 从 1、零填充)。供断言注入的 `system` 消息(身份钉死/项目记忆围栏/「当前不可用」)。 |
| `FAKE_REJECT_TOOLS_WORDING` | (v0.9-S0)覆盖 `FAKE_REJECT_TOOLS` 的 400 文案(默认沿用现文案 `this model does not accept the tools / function calling parameter`)。供注入**旧误判形状**——同时命中 `/tool\|function/i` 与 `/…not\s*support…/i` 的措辞(如 `tools are not supported here`),验证 v0.9-S0 归因收紧后仍走 tools-rejected(因请求带 tools)。 |
| `FAKE_VISION` | (v0.9-S0)`=1`:image-echo 模式。任一请求消息的 `content` 为**数组**且含 `image_url` part → 流式回答文本回显 `SEEN_IMAGE:<hash>`(hash = data URI 的 `<长度>-<前8字符>` 简单指纹);无 image part 时正常聊天/工具应答(该模式无 image 即惰性)。S7 视觉回路测试地基。 |
| `FAKE_DRAFT_JSON` | (v0.9-S2)当设置且请求为**非流式**(`stream:false`)时,fake 扮演「存为 playbook」起草器——直接把该 JSON 字符串作为 assistant 消息 `content` 返回(不做校验)。`draftPlaybookFromSession` 正是发这样一个非流式调用,故此契约让 draft 往返(模型输出→`parsePlaybookDraft`→`normalizePlaybook`)可离线确定性断言。优先级:接管 `stream:false` 分支(否则该分支回定长句)。 |
| `FAKE_PLAN_FIRST` | (v0.9-S5)`=1`:计划模式真流程测试地基。**首个**请求(history 里**无** assistant 消息)流式返回以 `PLAN:` 开头、**不带** tool_call 的纯文本(finish_reason `stop`)——正是 `runOpenAiTurn` 的 plan 暂停所识别的形状;**后续**请求(history 已有 assistant,如工作台记录的计划文本)落到下方普通分支,故可与 `FAKE_TOOL_SEQUENCE` 组合驱动批准后的执行阶段。优先级高于 tool/echo 分支。 |
| `FAKE_PLAN_TEXT` | (v0.9-S5)覆盖 `FAKE_PLAN_FIRST` 的计划正文(默认 `PLAN:\n1. 读取文件\n2. 修改配置`)。 |
| `FAKE_SUBAGENT_SCRIPT` | (v0.9-S6)子代理 `spawn_agent` 测试地基。JSON `{parent:[…],sub:[…],subText?,parentText?}`——按请求 `system` 是否含子代理身份标记「子任务执行体」(`runSubAgent` 前置)**分流**:命中→走 `sub` 剧本(被交办的子回合,可含 `file_write` 等)、否则→ `parent` 剧本(顶层回合,可含 `spawn_agent` tool_call)。每份剧本按请求 role:'tool' 数步进(仿 `FAKE_TOOL_SEQUENCE`):步为 `{name,args}`(吐**一个** tool_call)或 `{text}`(吐最终文本收尾);耗尽 → 吐 `subText`/`parentText`(默认定长句)。子回合工具消息在子的**独立** history,故父的 role:'tool' 计数只反映父的 spawn_agent 结果,互不干扰。优先级高于 tool/echo 分支。 |
| `FAKE_SUBAGENT_PARALLEL` | (v0.9-S6)JSON 数组 `[{name,args}]`(通常 N 个 `spawn_agent`)。**父的首个请求**(history 无 role:'tool'、非子请求)在**一条** assistant 消息里吐全部 N 个 tool_call(单批次扇出上限测试);父的后续请求落 `parent` 剧本收尾。子请求永不走此分支。 |
| `FAKE_SEQUENCE_PRIORITY` | (v0.9-S7)`=1`:令**未耗尽**的 `FAKE_TOOL_SEQUENCE` 优先于 image-echo 分支。默认 image-echo 一见 history 里有 image part 就回显 `SEEN_IMAGE:` 停手;保图≤2 测试需在图片累积后仍连开截图,故此标志让序列跑完再让 image-echo 恢复(耗尽后最终答仍回显最后一张图,证图到达)。仅在同时设 `FAKE_TOOL_SEQUENCE` 时有意义。 |

### fake-mcp.js —— 假 stdio JSON-RPC MCP server(MCP 2024-11-05)

- `tools/list` 固定 4 工具:`echo{message}`、`add{a,b}`、`screenshot_full`(名字命中桥接 **read** tier,供 default 模式免弹断言)、`diagnostics`(供能力矩阵桌面可选依赖探测)。
- `FAKE_MCP_OPTIONAL`:JSON 覆盖 `diagnostics` 返回的可选模块可用性,如 `{"ocr":true,"uia":true,"cv2":false,"playwright":false}`。

### 其它假件/探针(非 e2e)

- `deepseek-probe.js` —— 对真 DeepSeek 端点的探针(需密钥)。
- `model-tier-probe.js` —— **实弹分级模型评测件**(v1.0-S6b,**非回归**:无 `.e2e.js` 后缀、不进离线回归 grep、判定行 DONE)。`node model-tier-probe.js <API_KEY> <MODEL> [BASE_URL]`,同一套 agentic 场景(A 多步工具链 / B todo 纪律 / C 抗幻觉 / D 并行格式)打不同档位模型量化对比,为「是否做小模型针对性优化」提供数据;每场景独立临时 HOME + 独立 server,key 只经命令行入进程、finally 连同 HOME 删除、输出不回显 key。留作新模型接入时的验收探针。
- `free-port.js` —— `getFreePort()`/`getFreePorts(n)`(v0.8-S8;见下「端口段」)。

## e2e 模板范式

每个离线 e2e 遵循同一骨架:

1. **临时 HOME**:`HOME = path.join(os.tmpdir(), 'wcw-<slice>-e2e')`,开跑前 `rmSync` 清空重建;spawn workbench 时 env 带 `RUYI_HOME: HOME`(数据隔离,不污染真实数据目录 `~/.ruyi-workbench`)。旧变量名 `WIN_CLAUDE_WORKBENCH_HOME` 服务端仍认(RUYI_HOME 优先),存量件两个都设,不必改。
2. **写 config.json**:`configSchema: 6`、`version: '0.8.0'`、`providers[{...fake...}]`、`activeProvider: 'fake'`,视需要预置 `permissionMode`/`toolAllowRules`/`contextWindow` 等。**注**:范式示例种子里的旧 schema/version 是**有意测试迁移路径**；当前代码基线是 `configSchema 8` / `VERSION 1.6.1`。新写 e2e 若不测试迁移，应直接用当前值；若旧用例需要验证“所有工具常驻”，请显式设 `toolLoadingMode:'full'`。
3. **健康轮询**:`for (i<40) { sleep(150); h = await health(port) }`,`GET /health` 返回 JSON 即视为起来。
4. **token 抓取**(需要 UI-token 门的路由):从 `<HOME>/runtime.json` 读 `token`,或走 body-token 端点(`/api/todo`、`/api/permission/request`)。
5. **taskkill 清理**:`finally { cp.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F']) }`;spawn fake 与 workbench 都要杀(树杀避免孤儿 powershell 子进程)。
6. `exit(fail ? 1 : 0)`;逐条 `PASS/FAIL <label>`。

## 测试端口

新测试使用 `free-port.js` 分配临时端口。既有固定端口由 `run-all.js` 在运行前扫描；跨文件占用相同的固定端口会在启动前报错。测试源文件是固定端口的登记位置。

## 新 e2e 检查单

- [ ] 端口取**空闲段**(可用 `node -e` 小脚本或 run-all 审计确认未占用;占用即声明,无需登记)。
- [ ] 临时 `HOME`(tmpdir),开跑清空;spawn env 带数据目录变量。
- [ ] 健康轮询起服务,别裸 sleep 猜时间。
- [ ] 需要 mutating 路由的 UI-token → 从 `runtime.json` 读;body-token 端点走 body。
- [ ] `finally` 里用 `lib/kill-own-tree.js` 的 `killOwnTree` 清理本件 fake + workbench，自有进程身份须可核对，不能按进程名批量终止。
- [ ] 逐条 `PASS/FAIL <label>`;`process.exit(fail?1:0)`。
- [ ] 断言只加不改语义(事件协议纪律);新字段可断言,别断言旧字段被删。
- [ ] 跑两遍确认无端口/临时目录残留导致的偶发。
- [ ] `node dev-harness/run-all.js` 启动时的端口唯一性审计会自动覆盖新件(撞车即红,无需手工登记);端口角色有描述价值时可在上表补一行。
