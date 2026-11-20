# Mac 产品中的历史名称与外来格式边界

本轮删除 Windows 执行后端；以下引用不提供 Windows 运行能力，不应简单按字符串删除。

| 范围 | 保留原因 | 约束 |
| --- | --- | --- |
| `backend/workbench-data-roots.cjs` 旧数据根、`backend/migration-center.cjs`、`backend/product-identity.cjs` 旧 MCP 标识 | 识别已有 Ruyi 数据与旧安装引用 | 仅供迁移和历史识别 |
| `01l-credential-recovery.js` 的 DPAPI 说明 | 解释旧密文为何不能在 Mac 解密 | 不含 DPAPI 执行实现；无法解密不覆盖旧库 |
| `backend/workspace-unc-policy.cjs` 与工作区路径护栏中的 UNC／设备路径和 `path.win32`，`backend/bridged-tool-guards.cjs` 的 Office 写入签名 | 识别外来输入、历史路径及潜在绕过 | 这些判据仅用于路径与工具安全检查 |
| `backend/attachment-store.cjs`、下载／ZIP 的双分隔符文件名解析 | 用户文件可能带外来路径；剥除目录防止越界 | 只是格式识别；原文件编码／BOM／CRLF 保留 |
| `backend/skill-registry.cjs` 的旧 offline-toolkit 插件 ID | 识别旧安装副本，防止覆盖随包新技能 | 仅历史去重，不执行旧插件后端 |
| 前端历史 `powershell_run` 显示名称、旧工具事实分类 | 老线程的工具记录仍可展示 | 不重新注册到工具目录，不用于新模板与调度入口 |
| Python 文件解码、错误匹配中的 Windows 格式名称 | 用户文档、导入历史或外部进程错误可带旧格式 | 仅解码或错误解释；恢复建议指向 Mac 能力 |
| Git 历史、审查报告、历史测试说明、第三方许可 | 可追溯证据与法律声明 | 不进入运行时执行路径；发行内容受白名单约束 |
