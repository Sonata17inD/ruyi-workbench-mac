# Ruyi Mac 专用改造进度

基线：931f9fa21972d8722ad027ca631877f2623ba462。分支：codex/mac-native-workbench。
用户已确定保留 Node／Web／Python 核心、Mac 数据迁移、arm64 Full／Slim；本轮主执行自查，不使用子 agent。

| 阶段 | 状态 | 完成门槛 |
| --- | --- | --- |
| 1 能力与基线 | 已完成 | EOL、能力聚合、模板与 UI、Mac 主 CI、工程门通过 |
| 2 Windows 产品链清理 | 进行中 | 活跃实现与发行载荷无 Windows 运行链，Mac 数据与共享功能保持 |
| 3 监督与空闲能效 | 待实施 | 可靠停止与身份清理通过，独占基准 CPU 降幅至少 80% |
| 4 模块边界与重复工作 | 待实施 | 显式 CommonJS、无生产依赖环、共享附件、性能无超预算回退 |
| 5 集成发行 | 待实施 | 同源码 Full／Slim、完整 Mac 适用回归、隔离升级回退与归档 |

原完整计划见本次聊天中用户确认的五阶段计划；审查依据见 ../audits/2026-11-13-mac-only/REPORT.md。
每批实现后记录自查、实际测试和未验边界，独立提交。不将已完成切片当作整体验收。
最低 macOS 实机、正式签名／公证、默认关闭执行回执扩展仍为后续范围。

开发策略：按用户最新要求，只做必要定向验证和工程门；不重复备份、归档或打包，最终集成一次构建 Full／Slim。允许连同调用点清理过时架构和测试。

## 工作包 1：Mac 能力与工程基线

- EOL 改为 Git NUL 流读取，覆盖超缓冲清单、中文／空格／换行／制表符文件名及未提交删除。
- 显式 CommonJS 能力投影统一截图、输入、AX、本地 OCR、屏幕 OCR；未知、拒权、锁屏、缺依赖分别处理。修复原生 IPC 失败误报缺依赖，模板／提示／UI 同步。
- Mac 主 CI、Python Mac 协议子集、默认 Mac 构建命令与贡献规范；产品首页删除 Windows 安装宣传。旧 Windows 实现仍待工作包 2 清理。
- 主执行自查发现并修复：语言镜像漏同步、`.cjs` 未被语法门覆盖、Git 删除记录空字段、诊断失败状态、旧 Windows CI 注册数断言。
- 验证：语法 1205 文件通过；生成物新鲜；全量单元 2662 通过、18 跳过、0 失败；80 个静态件首次 76 通过，4 个修复后定向复验均通过；Mac 能力聚合 E2E 6 项通过；ACC Mac CI 14 件通过（含 capture 14 个合成用例）。
- 未验：模板实浏览器部分因 `RUYI_BROWSER_CACHE_SOURCE` 未配置跳过；未进行真实桌面授权、最低 macOS、打包或能效验收。CI 配置已本地验证对应命令，尚未运行托管 CI。

## 工作包 2a：ACC 原生注册与依赖裁剪

- 注册器直接列出 Mac／共享模块，删除 19 个 Windows 工具模块及 wincap／geometry；共享图像模块只保留编码与空帧判断。
- 移除 Python Windows dependencies/extras、COM 初始化、注册表浏览器解析、PowerShell 编码注入、taskkill 与系统代码页探测；显式文件编码、BOM／UTF-16／GB18030、shell 输出预算和超时行为保留。
- 删除 npm exe 打包依赖和配置，重生成零依赖锁（减少 2077 行），更新 Python 第三方依赖说明。
- 验证：Python 58 个源文件语法通过；Mac CI 子集首次 11／14 通过，3 件旧 Windows 结构断言修订后定向全部通过（browser 8、AX 8、Office read）；真实 stdio 共享 ACC E2E 通过；新增共享文件编码／shell 失败和超时用例通过；Mac 包依赖静态门、facts 对账通过。
- 自查修复：旧 AX 注册映射断言、浏览器“不支持”提示、Office 测试依赖系统代码页内部函数。没有执行打包。
- 尚未完成：Windows 壳／安装／覆盖链、Node 混合分支、Python 其余混合工具和历史 Windows 测试清理、发行白名单；因此阶段 2 未验收。

## 工作包 2b：发行白名单与 Windows 桌面／更新链退役

- 删除 Windows C# 桌面壳、WebView2 DLL、rg.exe、启动安装脚本、ACC Windows installer、覆盖升级打包与执行脚本。
- 删除 overlay 后端模块及四条 API；更新页只提供 Mac 安装／回退说明。删除 WebView2 通知发送分支，保留 Mac 原生通知和普通浏览器通知。
- 引入 `packaging/macos/runtime-files.json`：Mac 本体与 ACC 源码逐文件登记；复制拒绝未登记载荷，wheel 校验拒绝额外模块。同步前端资产覆盖断言到这份清单。
- 收紧 ACC 模型权限目录，去掉已不存在的 9 个 Windows 工具名称；保留 Mac 现有工具权限门。Windows 专用技能／角色删除。
- 自查与验证：75 个静态件初次 57 通过，18 个因退役链与文案／生成物失败，修复后定向 18 件全部通过；全量单元初次 2652 通过／7 失败／17 跳过，修复后受影响的 58 项为 57 通过／1 跳过；发行清单与现有 Mac 包完整性单元 9 项通过。移除 API 的真服务 E2E 通过；生成物、EOL 通过。未重复全量、未构建发行包。
- 阶段 2 仍未完成：Node 混合运行分支、历史名称迁移隔离、剩余 Python 混合能力与 Windows 测试清理尚在队列。性能监督与模块化工作尚未实施。

## 工作包 2c：Node 原生执行与凭据链裁剪

- 删除 DPAPI、PowerShell 一次性执行、SendKeys、WinForms 文件选择与 Explorer 运行实现；保留 Keychain/AES-GCM、Finder、Mac 宿主选择器和受管 bash。旧未知密文明确 provider_mismatch，不覆盖原数据。
- 命令授权目录与执行字段同步迁至 shell_run；历史 PowerShell 工具不再恢复进可调用目录。桌面 ACC 输入继续按真实工具身份获取资源租约。
- shell_send 只走私有完成协议；删除旧输出静默轮询与 UTF-8 解码路径上的无效 150ms 刷新定时器。
- 验证：Mac Keychain 和原生进程真实 E2E 通过。全量单元首次 2635 通过／20 失败／15 跳过，失败涉及退役工具、平台夹具及静态断言；修复后定向 83 项最后 1 项失败，再修正 ACC 测试身份后受影响 18 项全部通过。75 个静态件 74 通过，工具数量断言修正后剩余一件通过。没有再重复全量或打包。
- 未完成：cmd.exe 包装／预算、CLI 探测与其他混合分支仍需删除；阶段 2、能效和模块化未验收。

## 工作包 2d：CLI 直启与 Windows 命令行层退役

- 删除 `01d-win-cmdline.js`、cmd 包装、字符替换、8191／32767 预算与主／子 Agent 降级阶梯。所有进程调用直接传 argv，授权工具清单不再因 Windows 预算被裁剪。
- 删除 Claude shim→exe 探测和双路径 Symbol 状态；Mac Kimi npm 入口按实际符号链接身份识别，拒绝用旁边的旧包替换原生启动器。
- 保留提示围栏／技能 stdin 注入回归，将旧 cmd 集成件改为 Mac argv 集成件；更新 Kimi 假件为 Mac 符号链接。
- 验证：最新完整单元 2646 通过／14 跳过／0 失败。CLI 真服务 argv 与 Agent 工作流（权限档、长角色、缺失启动器）两件 E2E 全部通过。75 静态件首次 72 通过，夹具计数和路由生成物更新后 3 件定向全通过。生成物新鲜、EOL 和 diff 空白检查通过。
- 拼接模块 92→91，依赖边 649→641；仍有生产 SCC，不能视为模块化完成。下一包继续清理 pkg／Python／MCP 的 Windows 运行分支。

## 工作包 2e：Mac 运行时发现与文档写入简化

- 移除 pkg/exe 自启动回退，self MCP 始终采用 Node + server.js；删除 Windows Python／ACC 安装路径、控制台 exe/cmd/bat 扫描。
- Office 图表／PDF 仅探测 Mac 字体；删除 Windows sharing-violation 重试函数及全部调用点，直接原子替换。错误继续保留原文件并清理临时文件；安全路径基线直接采用 Mac 系统树和根目录。
- 验证：Python 探测 E2E（超时、后代、输出预算、缓存）通过；CLI 自动发现、真实 ACC stdio 和 MCP 配置 E2E 通过；发现缓存单元 6 项通过；Office 生成／读取 smoke 通过（读取件旧 WinError 重试断言改为立即失败后复验）。Mac shared/composed smoke 通过。真实桌面 OCR／发行 Full 闭包未计入验收。
- 自查更正：上一包为两份带 shebang 的静态件补注释时放在了首行前，导致复验实际未运行。本包修正位置并分别确认 fixture-home／process-safety 全部通过；本次 75 静态其余 73 件通过。此前记录“3 件全通过”不应作为当时证据，以本次实际结果为准。
- 阶段 2 仍剩混合进程收尾、浏览器／编辑器、路径与模型文案清理；未构建发行包。
