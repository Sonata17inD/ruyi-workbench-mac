# Ruyi for Mac 专用架构审查

Ruyi 已具备可保留的 Mac 原生宿主、自动化后端和 Agent 业务核心，适合在现有实现上收敛成 Mac 专用产品。优先工作是修正能力判断、降低原生进程监督开销、移除 Windows 发行与执行链路，再逐步拆开后端模块。没有证据支持把全部业务重写为 Swift 所需的成本。

删除 Windows 代码主要减少维护、构建和分发负担；能效改善主要取决于原生监督、工具进程生命周期、轮询和图片传输。当前最明确的持续 CPU 开销来自 Mac 新增的监督实现。

审查基线为 2026 年 11 月 13 日的 `931f9fa21972d8722ad027ca631877f2623ba462`，Node `v24.15.0`，本机 darwin arm64。审查前工作树干净；本轮只增加报告与证据，未修改产品代码、依赖、用户配置或安装包。

## 审查范围

全仓遍历 10,239 个 Git 跟踪文件；对产品、MCP 和 CI 的 493 个文件建立逐文件大小、指纹及平台线索清单，其中 346 个为排除生成后端与 vendored JS 后的源码文件。检查覆盖后端 93 个拼接模块、前端与宿主桥、4 个 Swift 宿主源文件、原生 helpers、ACC Python、依赖声明、资源模板、构建发行、测试和历史验收记录。关键调用链进行了人工追踪，重点问题补了隔离复现。

全仓静态遍历不等同于逐行形式化验证。Windows 关键词命中包括注释、测试数据和外部文件名，不能据此直接判定可删除。前端完整实机交互、真实模型、麦克风、录屏、权限撤回、最低 macOS 版本和正式发行包未在本轮重跑；已有验收记录仅对它们各自的冻结产物有效。

[逐文件清单](/Users/jiming/Documents/ruyi-workbench-mac/docs/audits/2026-11-13-mac-only/inventory.json)覆盖全部 493 个产品及 CI 文件，包含 93 个后端模块的建议处置；它是审查清单，不是自动删除脚本。

## 优先迭代项

| 优先级 | 问题 | 影响和下一步 |
| --- | --- | --- |
| P1 | Mac 监督器为每个托管进程运行两层约 20 ms 的进程表扫描 | 已实测空任务也有持续 CPU 消耗。先优化监督机制和常驻数量，并保留停止、身份校验和父进程丢失后的清理保证。 |
| P1 | Mac 桌面与 OCR 能力在上层仍被标为不支持 | 已用隔离合成输入复现模板被禁用；统一 native diagnostics、能力模型、模板和模型提示。 |
| P1 | Windows 发行体系仍是仓库默认，Mac 包还整目录复制旧资源 | 删除旧壳、安装器、打包器、依赖和资源入口，把 Mac 构建与产物检查设为主路径。 |
| P1 | 工程静态门当前失败 | 80 件中 79 通过，EOL 检查被 Git 输出撑爆缓冲。先修复测试设施，建立真实可用的 Mac 基线。 |
| P1 发行前 | 正式签名、公证、最低系统及干净安装仍有未验门槛 | 内部试用状态不能直接升级为正式发行完成；保持权限身份稳定，补全目标环境验收。 |
| P2 | 93 个后端文件共享拼接作用域，31 个模块处于同一依赖环 | 分阶段形成显式模块接口，移除跨域全局状态；保留现有 Agent 行为与数据契约。 |
| P2 | 原生能力和共享 Python 工具经过多条重叠调用路径 | 统一桌面适配接口，保留 Python Office／浏览器价值；先减少重复探测和进程创建。 |
| P2 | 前后端存在多个定时器，部分空闲回调仍运行 | 按可见性、工作量和连接状态启停，改为事件驱动及下一次到期唤醒。 |
| P2 | Windows 与 POSIX 路径、shell、编码处理混在业务中 | 收敛为 Mac 系统契约；保留外部文件编码与旧数据识别，不把它们误删成平台运行支持。 |
| P2 | 默认关闭的执行回执尚未覆盖全部入口 | 列为独立可靠性工作包，既不当死代码删掉，也不直接默认开启。 |

P1 表示应进入第一批迭代，P2 表示随后按依赖推进；不表示本轮发现了正在发生的数据破坏。

## 进程监督的实际开销

[macos-process-helper.c:62](/Users/jiming/Documents/ruyi-workbench-mac/ruyi-workbench/resources/macos-process-helper.c:62) 的 `snapshot()` 每次枚举系统 PID，再逐个读取进程信息。`supervise()` 和 `supervise_guarded()` 都调用它，随后分别等待 20 ms：[macos-process-helper.c:375](/Users/jiming/Documents/ruyi-workbench-mac/ruyi-workbench/resources/macos-process-helper.c:375)、[macos-process-helper.c:446](/Users/jiming/Documents/ruyi-workbench-mac/ruyi-workbench/resources/macos-process-helper.c:446)。所以一次受托管执行除了目标进程，还附带 primary 和 guardian 两个进程；轮询频率受扫描耗时影响，约以每层 50 次每秒为上限。

[01h-process-runtime.js:139](/Users/jiming/Documents/ruyi-workbench-mac/ruyi-workbench/app/src/01h-process-runtime.js:139) 将 Mac 的普通托管启动导向这套机制，[04-permission-runtime.js:1160](/Users/jiming/Documents/ruyi-workbench-mac/ruyi-workbench/app/src/04-permission-runtime.js:1160) 的 MCP stdio 客户端也使用它。长寿命 MCP、CLI 和 shell 都可能把扫描变成长寿命开销。

以当前源码按项目的 `-O2` 参数编译 helper，在隔离目录运行 `/bin/sleep 14`，预热约 1 秒后读取约 10 秒的进程累计 CPU 增量：

| 试验 | 测量窗口 | 总 CPU 时间增量 | 折合单核占用 |
| --- | --- | --- | --- |
| 直接 sleep 对照 | 10.04 秒 | 0.00 秒 | 采样精度内为零 |
| 两层监督 sleep 第一次 | 10.04 秒 | 0.86 秒 | 约 8.6% |
| 两层监督 sleep 第二次 | 10.03 秒 | 0.61 秒 | 约 6.1% |

CPU 来自两个 helper，目标 sleep 在采样精度内为零。三次均正常退出，所观察自有 PID 无残留。测量时机器还有其他任务，审查测试亦在运行；该结果定位的是监督成本，不能当作整机静置基线、功率或续航结论，也不能直接线性外推多个 Agent 的总开销。[原始结果](/Users/jiming/Documents/ruyi-workbench-mac/docs/audits/2026-11-13-mac-only/process-cost.json)附测量脚本和源码提交。

建议保留 execution handle、PID 出生身份、私有控制通道、终局清理回执与 `observed-only` 能力边界；探索一个统一监督服务、已知进程的 kqueue／DispatchSource 退出通知、阻塞等待以及为后代发现保留的有界补偿扫描。不能直接移除 guardian 或仅用进程组代替全部身份验证。对明确不会产生子进程的自有叶子 helper，可以继续使用已有的有界直接启动方式。

第二个开销点是 [01h-process-runtime.js:30](/Users/jiming/Documents/ruyi-workbench-mac/ruyi-workbench/app/src/01h-process-runtime.js:30) 的 helper 能力缓存仅 1 秒，而同步 `start()` 会调用 `spawnSync --capabilities`，因此超过缓存期的下一次启动可能再次同步创建进程。应以二进制身份和协议握手为缓存基础，提供明确失效机制，并把启动准入改成异步；TCC 权限与锁屏状态仍需在相关操作前核验，不能套用永久缓存。

## Mac 能力在上层被错误否定

[06-provider-engine.js:233](/Users/jiming/Documents/ruyi-workbench-mac/ruyi-workbench/app/src/06-provider-engine.js:233) 的 `probeDesktopMcp()` 把 `desktopAutomation.supported` 和 `ocr.supported` 初始化为 `process.platform === 'win32'`。后续只更新安装状态和可选依赖，未将 Mac diagnostics 中的支持、授权与 readiness 映射回来。[06-provider-engine.js:1084](/Users/jiming/Documents/ruyi-workbench-mac/ruyi-workbench/app/src/06-provider-engine.js:1084) 的模板判断又把 `supported:false` 当作“平台尚未实现”。

隔离复现给生产函数注入已注册的 Mac 截图、键鼠、OCR 工具及 granted／ready 的合成诊断；输出为 `present:true`、`installed:true`，但两个 `supported` 都是 false，桌面与 OCR 模板均返回 unavailable。[复现结果](/Users/jiming/Documents/ruyi-workbench-mac/docs/audits/2026-11-13-mac-only/capability-repro.json)。这证明的是能力聚合逻辑缺陷，不是本轮真实系统权限验证。

同一处的 [06-provider-engine.js:1668](/Users/jiming/Documents/ruyi-workbench-mac/ruyi-workbench/app/src/06-provider-engine.js:1668) 仍向模型声明 Mac 截图、UIA、OCR、键盘未实现。以下随包资源也保留 P3 阶段描述：

- [desktop-open-app.json:10](/Users/jiming/Documents/ruyi-workbench-mac/ruyi-workbench/resources/playbooks/desktop-open-app.json:10)：Mac 没有窗口、键鼠、截图与 AX。
- [ocr-scan.json:11](/Users/jiming/Documents/ruyi-workbench-mac/ruyi-workbench/resources/playbooks/ocr-scan.json:11)：OCR 只支持 Windows。
- [web-form-fill.json:10](/Users/jiming/Documents/ruyi-workbench-mac/ruyi-workbench/resources/playbooks/web-form-fill.json:10)：Mac 没有桌面键鼠／OCR 后端。
- [06b-prompt-registry.js:170](/Users/jiming/Documents/ruyi-workbench-mac/ruyi-workbench/app/src/06b-prompt-registry.js:170) 与英文对应提示仍以共享子集为中心。

应建立一份 Mac 能力定义，分别表示 supported、installed、authorization、ready，再由 UI、Agent 提示和模板共同消费。系统浏览器 URL 交接不等于 DOM 已连接，这条语义应保留；桌面后端已实现也不意味着可以跳过真实权限、目标窗口和工作区校验。

## Windows 清理范围

### 可以删除的独立实现

以下项目在 Mac 专用产品中没有保留 Windows 运行能力的必要，删除时同步调整调用、manifest、测试和 notices：

| 类别 | 文件或目录 | 关联处理 |
| --- | --- | --- |
| Windows 桌面壳 | `ruyi-workbench/desktop/`，含 C#、WebView2 DLL、manifest、ico 与构建脚本 | Mac 当前构建使用 `desktop-macos/`。确认品牌图像是否需要迁移后移除旧目录。 |
| Windows 启动安装 | `Start-Workbench.cmd`、`resources/scripts/install-workbench.ps1`、`launch-workbench.ps1`、`tools/dev-serve.cmd` | 文档和帮助入口改为 Mac App／开发启动命令。 |
| Windows 离线发行与覆盖升级 | `tools/package-offline.ps1`、`Manage-Overlay.cmd`、`Manage-Overlay.ps1`、Windows overlay 专用工具与说明 | `build-overlay.js`、`gen-manifest.js` 中若有可复用哈希逻辑，先迁到 Mac 打包库再删除旧入口。 |
| Windows 二进制 | `app/vendor-bin/rg.exe` | 保留 Mac 打包时装入的 arm64 `rg` 和许可。 |
| Windows ACC 安装器 | `mcp/ai-computer-control/installer/` 的 Windows 安装与离线构建链 | Mac 有独立离线装配链；其中 Python 脚本也依赖 `python.exe`、LOCALAPPDATA、WinSDK，不应因扩展名是 `.py` 而保留。 |
| Windows 平台命令封装 | `app/src/01d-win-cmdline.js` 的 cmd quoting、`.cmd/.bat` 包装、8191／32767 字符预算 | 先将 Mac 调用点改为 literal argv，再移除整个模块；保留合理的输入大小／execve 错误处理。 |
| Windows 覆盖更新 API | `app/src/13c-overlay-routes.js` 的 PS1 编排与相关 UI | Mac 已显式拒绝旧 overlay；改为 Mac 发行版本／升级信息。`OVERLAY_ID` 同时承担进程重启身份，不能按名称一起删除。 |
| Windows 内容资源 | `windows-operator.md`、`skills/windows-control/` 以及 Windows 专用安装说明 | 重建 Mac 桌面操作技能与模板，清理 `skills-memory.js` 等索引引用。 |

ACC 中已有 Mac 替代实现的 Windows 模块包括 `screen.py`、`mouse.py`、`keyboard.py`、`clipboard.py`、`window.py`、`application.py`、`uia.py`、`ocr.py`、`vision.py`、`capture.py`、`record.py`、`observe.py`、`act_and_verify.py` 和 `utils/wincap.py`。注册映射在 [server.py:360](/Users/jiming/Documents/ruyi-workbench-mac/mcp/ai-computer-control/src/ai_computer_control/server.py:360)，应直接改为 Mac 工具表再删除旧模块。

`audio.py`、`dialog.py`、`desktop_extra.py`、`sync.py` 当前也被 Mac 注册策略排除，应移除 Windows 专属实现，按产品需要另建原生能力。`system.py` 含可移植系统信息函数，不能仅因被同组过滤就全删；应判断是否并入现有自检能力。

### 混合文件必须先拆分

[04-desktop-shell.js:1](/Users/jiming/Documents/ruyi-workbench-mac/ruyi-workbench/app/src/04-desktop-shell.js:1) 同时装有跨平台执行结果整形、Mac 启动／Finder reveal 和 Windows PowerShell／WinForms。直接删除整文件会破坏 Mac 运行。保留有界输出、取消、超时、literal argv 与 Mac open；移除 PowerShell 模板、Explorer 前台激活、WinForms picker、CLIXML 处理等 Windows 路径。

其余主要拆分落点如下：

| 文件族 | 保留 | 移除或重写 |
| --- | --- | --- |
| `00-boot`、`00-platform-runtime`、`01-config`、`01f-agent-cli-types` | Mac PATH、配置缓存、CLI 注册、明确的路径覆盖 | AppData、Program Files、`.exe/.cmd` 搜索、注册表探测、Windows launcher 分支。 |
| `01j-local-crypto` | Keychain 与版本化 AES-GCM 密文、明确的解密失败 | DPAPI PowerShell 脚本和 Win32 provider 运行实现。 |
| `03-bridge-guard` | realpath、符号链接、APFS 大小写、系统目录与 managed-location 护栏 | NTFS ADS、UNC／盘符、注册表、Windows 可执行关联的运行分支。外部历史数据的路径识别可集中到导入层。 |
| `04-permission-runtime`、`11-native-tools`、`12-tool-dispatch`、`13f-native-tool-schemas` | MCP、权限、Mac shell、git、文件工具、停止语义 | Windows 树杀、PowerShell 会话、Windows 工具 schema、别名与 dispatcher 分支。 |
| `13-http-router`、`13u-migration-center` | 鉴权路由、Mac open／编辑器、已安装 Mac 数据迁移 | Windows 端口进程查询、路径关联、旧 Windows 发行包操作。 |
| `public/js/quiet-card` 等 | Mac host bridge、通知状态、WKWebView 行为 | `chrome.webview`／WebView2 发送分支和 Windows 操作提示。WebKit API 前缀仍属于 Mac 所需能力。 |
| ACC `safety`、`shell`、`paths`、`office_io`、`utils/image`、`utils/text_input`、`diagnostics` | Mac 安全规则、POSIX 执行、原子保存、图像编码、Mac 按键解析 | WinError 重试、Win32 抓屏、OEM 控制台探测、Windows 安装发现和兼容注册判断。 |

`utils/image.py` 的 `encode_with_budget` 仍被 Mac clipboard 使用；`utils/text_input.py` 仍被 Mac 输入、录制和组合工具使用。GB18030／BOM／CRLF 文档读取属于用户文件格式支持，不能与 Windows 控制台兼容混为一谈。`.win-claude-workbench`、`WIN_CLAUDE_WORKBENCH_HOME` 与旧 MCP ID 还涉及已存在的 Mac 数据：应集中为有限版本迁移入口，迁移验证后退役，避免让旧用户“丢失”历史。

## 依赖与发行包

[package.json:1](/Users/jiming/Documents/ruyi-workbench-mac/ruyi-workbench/package.json:1) 仍描述 Windows 产品，默认 `build:exe`、`build:desktop`、`package:offline` 指向 Windows，唯一 npm 开发依赖 `@yao-pkg/pkg` 用于 Windows exe。移除其 scripts、pkg 配置和依赖树，重新生成 lockfile；保留 Node runtime 与 Mac 构建工具。无 npm 运行依赖的后端是可以继续利用的轻量基础，不必为了删除 pkg 而引入另一套大型桌面框架。

[pyproject.toml:1](/Users/jiming/Documents/ruyi-workbench-mac/mcp/ai-computer-control/pyproject.toml:1) 和 `requirements_offline.txt` 中的 pyautogui、pywin32、uiautomation、comtypes、winsdk、pynput 应从 Mac 产品声明及 extras 中移除。当前已有 `sys_platform == 'win32'` 标记，所以这些条目不等于 Mac 正在安装或加载它们；其主要负担是维护和测试，不应虚报删除后的运行节能。

继续保留 Python 3.12、MCP server、Pillow、python-docx、openpyxl、python-pptx、pdfplumber、reportlab 等实际文档能力。Playwright／Chromium 对网页 DOM 自动化有独立价值，WKWebView 并不自动提供等价工具协议。OpenCV／NumPy 用于模板匹配，Apple Vision 已用于 OCR，不能直接把它们视为重复依赖。

可进一步裁剪的候选是 pyperclip、psutil 和 `mcp[cli]` 的 CLI extras：前两者的直接业务 import 主要落在旧 Windows 工具，CLI extras 是否需要取决于发行时是否仍使用对应命令。须在移除旧模块后检查完整传递依赖和运行冒烟，不能只搜到“无直接 import”就删锁文件。`requirements_offline.txt` 与 Mac Full 精确锁的内容并不完全相同，实际 Mac 发行闭包以 `MACOS-PORTING/dependencies/` 的锁和打包清单为准。

[package-macos-offline.js:55](/Users/jiming/Documents/ruyi-workbench-mac/ruyi-workbench/tools/package-macos-offline.js:55) 对 `resources`、`config`、`docs` 整目录复制，Full 又把 ACC 全部源码装成 wheel，因而会把 Windows scripts、技能和 Python 后端带进 Mac 候选。应改为明确的 Mac 产物白名单，加入 PE／DLL／exe、PowerShell、Windows 后端和错误模板的产物检查。资源文本中的外部历史数据示例需要单独归类，不能简单以字符串零命中代替正确性。

Full 装配还同时保留 wheels 和已安装 Python site-packages，适合离线修复但增加体积。可以拆成主 App 与可选离线维修资产；先明确离线维修要求，再测量真实节省。这里的重复主要占磁盘，不能直接计作常驻内存或耗电。

现有 Mac 资产版本与 hash 锁、Mach-O 依赖审计、搬移测试、不可覆盖的候选输出和来源指纹应保留。正式发行还需 Developer ID／公证、稳定 bundle 与权限身份、最低 macOS 14 实机及干净标准用户安装。当前 arm64 构建是现有交付范围；Intel 支持不是“Mac 专用”的必然要求。

## 能保留的架构与能力

| 领域 | 判定 | 保留依据与边界 |
| --- | --- | --- |
| AppKit 与 WKWebView 宿主 | 保留并继续原生化 | 已实现私有服务租约、窗口生命周期、睡眠唤醒、受信任 origin 和 host bridge；没有必要重建成 Electron。 |
| Node Agent 核心 | 保留行为，拆接口 | Provider、Claude CLI、Kimi ACP、流式结果、工具调度、上下文管理、子 Agent、预算和停止语义是工作台主体资产。 |
| 多 provider 协议 | 保留 | chat／responses／Anthropic 适配解决服务商差异，属于产品能力。Kimi ACP compat loader 也不能归为 Windows 兼容层删除。 |
| 会话与任务状态 | 保留 | head＋NDJSON、checkpoint、原子写、恢复／unknown 状态、串行写链已有广泛回归。是否换 SQLite 应由大历史读取与写放大基准决定。 |
| 权限与边界 | 保留 | workspace、不可逆操作账、审批、resource leases、身份化停止和 TCC 校验不会因单平台而失去作用。 |
| Keychain 与隐私机制 | 保留 | Mac 凭据保护、隐私规则、恢复事务应保留；删除 DPAPI 不等于删除 vault。 |
| 原生自动化 | 保留并收敛接口 | ScreenCaptureKit、AX、CGEvent、Vision OCR、目标窗口身份、剪贴板恢复和事件录制是 Mac 专用核心。 |
| Python 文档工具 | 保留，按需加载 | Office、PDF、图片、图表能力已有价值；把它们重写为 Swift 不会自动带来更低成本。 |
| 浏览器自动化 | 保留 | system／managed／custom／CDP／bundled 区分与实际 ready 校验有效；Chromium 生命周期独立治理。 |
| 前端与 SSE | 保留并优化更新范围 | 原生 JS、离线资源、SSE 游标补发、流式文本与延迟 Mermaid 渲染已有基础；Loopback 自身不能未经测量判为主要能耗。 |
| Steward、调度、机器人 | 保留业务，按需运行 | 这些功能与 Windows 无关；需要控制空闲定时器和工作进程存活。 |
| 测试与工程清册 | 保留机制，更新目标 | 语法、freshness、行为测试、路由／持久状态／依赖图等能保护重构；迁移绑定 Windows 实现形状的断言。 |

[DesktopService.swift:154](/Users/jiming/Documents/ruyi-workbench-mac/ruyi-workbench/desktop-macos/DesktopService.swift:154) 的 200 ms 轮询仅用于启动及唤醒就绪确认，成功后会 invalidate；[RuyiDesktop.swift:491](/Users/jiming/Documents/ruyi-workbench-mac/ruyi-workbench/desktop-macos/RuyiDesktop.swift:491) 的页面观察定时器有 acceptance report 门控。不能把这两处当作正常运行时永久轮询。

前端已有 `createPollLifecycle`、visibility 判断、SSE 降频；调度器也在零任务时不建 interval。应在这些机制上收敛，而非全部重做。`office_chart.py` 已延迟加载 matplotlib，Mermaid 也已按需加载，这些节省启动成本的设计应保留。

## 后续架构迭代

### 拆开后端共享作用域

[build.js:1](/Users/jiming/Documents/ruyi-workbench-mac/ruyi-workbench/app/build.js:1) 将 93 个源文件拼成约 6.6 MiB、94,403 行的 `server.js`。现有依赖图登记 656 条模块边、67 条前向边以及一个含 31 个模块的强连通分量。拆文件已经改善导航，但运行时仍共享作用域，核心模块没有真正独立。

建议以 Mac 系统服务、凭据、会话仓库、Agent 引擎、工具注册与调度、HTTP／SSE 为边界建立显式接口，优先抽取无环的纯函数和系统适配层，再迁移状态持有者。产物是否保留单文件可以由构建器决定，开发期模块边界应真实。模块化主要改善维护与可测性；启动、RSS、解析耗时需要另测，不能从行数直接推算收益。

### 统一 Mac 系统服务边界

现有请求路径包括 Node 直接调 automation helper，以及 Node → Python ACC → automation helper；Python 还为输入／回执维护 session，为视觉计算创建 worker。多语言本身不是冗余，问题是能力映射、探测、取消与图像传输规则重复维护。

近期统一协议、readiness 与 ownership，保留隔离；中期可以让 Mac 桌面工具使用同一个受生命周期控制的原生服务接口，Python 聚焦文档、浏览器和确有需要的计算。XPC 或 Unix socket 是候选，须验证签名、TCC、身份、崩溃恢复后再定，不作为仅凭静态审查确定的迁移结论。

[macos_vision.py:13](/Users/jiming/Documents/ruyi-workbench-mac/mcp/ai-computer-control/src/ai_computer_control/tools/macos_vision.py:13) 在模块注册时 import cv2／numpy，而实际计算另有视觉 worker，存在父进程提前加载重库的候选开销。应改为轻量 availability 探测与首次计算加载，并测量冷启动和 RSS。

截图路径先 PNG／base64，再经过 Node／Python JSON、Pillow、模型与历史存储；[01n-desktop-automation.js:47](/Users/jiming/Documents/ruyi-workbench-mac/ruyi-workbench/app/src/01n-desktop-automation.js:47) 允许最高 68 MiB 输出。建议原生侧按目标用途缩放／编码，使用内容寻址图片附件，避免同一帧多次大字符串复制。调整必须保留帧身份、坐标映射和视觉历史证据，不应为省内存丢失工具图片。

### 让空闲状态真正减少工作

[13i-steward-inbox.js:1380](/Users/jiming/Documents/ruyi-workbench-mac/ruyi-workbench/app/src/13i-steward-inbox.js:1380) 的 Steward 默认 5 秒 tick，默认开关开启；它已有事件唤醒机制，可逐步让变更事件承担主触发，仅保留低频一致性核对。[13s-scheduler.js:878](/Users/jiming/Documents/ruyi-workbench-mac/ruyi-workbench/app/src/13s-scheduler.js:878) 的任务 timer 判断是任务表非空，并不等于存在下一条可执行任务；可改为下一触发时刻安排单次 timer，并在任务变更和系统唤醒后重算。

[background-tray.js:327](/Users/jiming/Documents/ruyi-workbench-mac/ruyi-workbench/app/public/js/background-tray.js:327) 常驻 1 秒 ticker；[navigation-controls.js:733](/Users/jiming/Documents/ruyi-workbench-mac/ruyi-workbench/app/public/js/navigation-controls.js:733) 能力面板有 60 秒周期；Steward shell／board／drawer 即使 SSE 已连接仍维持周期检查。部分回调已有 hidden 早退，下一步应连计时器一起停掉，并合并重复请求。shell idle reaper 在无 shell 时也存在，可按会话数和最早过期点启停。

语音采集、活动任务 watchdog、请求超时和取消 deadline 有业务用途，应按生命周期审查，不能将所有 `setInterval` 机械替换为“没有计时器”。后台正在运行 Agent、定时任务或机器人时，也不能为了 App Nap 直接暂停所需工作。

### 继续完成执行回执

[13ac-desktop-execution-runtime.js:10](/Users/jiming/Documents/ruyi-workbench-mac/ruyi-workbench/app/src/13ac-desktop-execution-runtime.js:10) 的 `RUYI_DESKTOP_EXECUTION_RECEIPTS=1` 是默认关闭的 Mac 功能。它包含已实现的真实派发／结果／持久历史关联，不属于无引用死代码。已有交付记录仍保留后台、恢复、CLI、部分入口、retention 和未确认终局等后续范围。

应把这些开放项单列为可靠性工作，逐个入口完成一致的 admission、结果持久化、unknown 屏障和重启不重放；保持已验路径及默认状态，不能借平台清理顺手开启全部能力。

## 仓库与测试治理

`MACOS-PORTING/` 有 8,436 个跟踪文件，原始文件字节合计约 248 MiB，占全仓跟踪文件数约 82%。这里大部分是阶段日志、JSON、截图和冻结证据；它们增加克隆、遍历和审阅成本，但不是运行时耗电来源。

本次 [eol-policy.static.e2e.js:40](/Users/jiming/Documents/ruyi-workbench-mac/dev-harness/eol-policy.static.e2e.js:40) 的 `execFileSync('git', ['ls-files', '--eol'])` 未设置较大输出上限，已经以 `ENOBUFS` 失败。应使用流式读取或有界分批读取；也应把完整历史证据转移到发行／审计归档，仅保留可追溯索引、hash、必要夹具和当前验收摘要。先迁移取证地址，不能静默销毁历史。

`MACOS-PORTING/dependencies/` 是当前 Mac 打包器的真实依赖，不能随着“移植文档清理”一起删掉。建议迁入长期维护的 `packaging/macos/` 一类目录，再归档旧阶段计划。

[e2e.yml:1](/Users/jiming/Documents/ruyi-workbench-mac/.github/workflows/e2e.yml:1) 的主回归、ACC smoke、release dryrun 仍在 Windows；[macos-p0.yml:1](/Users/jiming/Documents/ruyi-workbench-mac/.github/workflows/macos-p0.yml:1) 仍是 P0 子集与 Windows matrix。应改为 Mac 主 CI：静态／单元、进程与文件边界、ACC 无 UI、宿主集成、离线装配；TCC、真人输入与多屏验收保持专用流程，准确标记 SKIP 与未验项。Linux 的纯静态 runner 如有速度或成本价值可以保留为开发设施，不代表 Linux 产品支持。

`CLAUDE.md`、`CONTRIBUTING.md`、README、帮助、技能和 THIRD-PARTY-NOTICES 都需要更新到 Mac 专用契约。当前开发规则还明确“Windows 为一等目标”和“模型路径按 Windows 形处理”，会持续把新实现拉回旧架构。应同步更新规则与相关源码锁测试，保留离线可用、可复现构建、行为验证及 clean-room 等仍有效约束。

## 本轮验证结果

| 检查 | 结果 |
| --- | --- |
| `node app/build.js --check` | 生成后端与源码及 manifest 一致。 |
| `node dev-harness/syntax-gate.js` | 1,196 文件检查，0 失败。 |
| Python AST 语法检查 | 产品与 MCP 的 130 个 Python 文件，0 失败；不等同于依赖导入或运行验证。 |
| `node --test dev-harness/unit/*.test.js` | 2,671 tests，2,653 pass，18 skip，0 fail。 |
| `run-all.js --fast` | 80 件执行，79 pass、1 fail；runner 另标 14 个 live 排除项。 |
| EOL 定点复现 | 再次以 `spawnSync git ENOBUFS` 退出 1。 |
| `macos-process-runtime.e2e.js` | 62 个 PASS，正常退出。 |
| `macos-file-policy.e2e.js` | 48 个 PASS，包含大小写敏感卷和写入边界，正常退出。 |
| `macos-agent-cli-discovery.e2e.js` | 6 个 PASS，正常退出。 |
| 监督开销实验 | 当前源码编译 helper，1 次对照、2 次监督实验；均退出，无所观察 PID 残留。 |
| 能力模型复现 | 合成 ready 输入经过生产函数仍得 Mac desktop／OCR unsupported。 |

[验证索引](/Users/jiming/Documents/ruyi-workbench-mac/docs/audits/2026-11-13-mac-only/verification.json)及同目录证据保留了命令、结果和方法。三组 Mac E2E 使用工作区已有 process helper；微基准使用本轮由源码编译的 helper，二者 hash 分别登记，未声称字节等价或同一发行产物验收。没有把本轮静态门写成全绿，也没有把历史“594 件逐件合并成功”当作当前提交的全量 E2E 结果。

## 推荐执行顺序与验收条件

1. **建立 Mac 专用基线。** 修复 EOL 工程门，调整主 CI、开发规范、产品元数据；修复 capability aggregation、提示词与模板。验收要求：Mac 已就绪／缺 helper／拒权／锁屏各自显示正确状态，模板与实际可调用工具一致。
2. **移除 Windows 产品链。** 删除独立壳、二进制、安装器、pkg 和 Windows Python extras；抽取混合文件中的 Mac 实现，重建 manifest、facts、路由与依赖图。验收要求：源码与发行产物都没有可执行的 Windows 支持链，旧 Mac 数据可读，Office／MCP／CLI 能力未丢失。
3. **降低持续运行成本。** 优先改双层高频全表扫描，其次合并能力探测、收敛常驻 MCP／CLI／浏览器生命周期，停掉无工作时的定时器。验收要求：相同工作负载下进程数、CPU 时间、唤醒、RSS 和延迟有对照改善，原停止与孤儿清理测试继续通过。
4. **拆后端与桌面接口。** 渐进移除共享作用域依赖环，原生系统能力形成明确接口，按需加载重工具与附件。验收要求：每个接口可独立测试，主 Agent、子 Agent、恢复、权限、视觉历史及错误语义保持一致。
5. **完成正式发行与可靠性开放项。** 稳定签名身份、最低系统、安装／升级／回滚及执行回执分入口验收；把完整历史证据迁入可追溯归档。

能效验收应覆盖空窗口、隐藏／关窗后台、单个空闲 MCP、单个 CLI、多个并行任务、截图／OCR、浏览器自动化以及睡眠唤醒。使用固定硬件、数据、任务和等待窗口，对比 CPU 时间、进程／线程数、wakeups、RSS、启动耗时、请求 P95、退出残留及 macOS Energy Log／功率采样。先取得正式基线再设预算，不能把本次 sleep 微基准当成最终节能承诺。
