# Ruyi for Mac 平台状态

Full 与 Slim 的内部试用运行验收以本机 Apple Silicon、macOS 27.0.1 为准。构建时检查各 arm64 组件的最低部署版本，允许的上限为 macOS 14.0。开发入口、检查和打包命令见[项目首页](../../README.md)。

当前 Full 与 Slim 的 DMG 均已在本机安装、启动、离线使用并完成升级回退。两款均通过同一次真实睡眠唤醒验收，页面恢复了原服务上的消息流。Full 安装副本另已通过真实截图、中文输入、点击与滚动验收。各项结果、适用制品与跳过项见[本轮验收记录](../audits/2026-11-19-mac-slim/REPORT.md)。

提交 `1ece927e` 的 Full 与 Slim 已在 macOS 27.0.1 上验证实际输入、截图与睡眠唤醒。该历史基线对应当时的签名和制品。新的版本分别验证各自的权限与安装状态。[桌面验证](physical-desktop.json) · [唤醒验证](physical-wake.json)

当前内部试用的安装、配置、升级和恢复见 [Mac 部署说明](../../ruyi-workbench/docs/MACOS-RELEASE_CN.md)。
