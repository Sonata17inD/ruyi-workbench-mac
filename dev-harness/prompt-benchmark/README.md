# 提示词行为评测

`run.js` 用隔离的工作台目录和本地模拟服务商执行 `seeds.json` 中的场景，记录工具调用顺序和结果。场景覆盖文件查找、写前读取、独立读取合批、Office 工具选择、重复工具调用和高风险操作的审批。读取工具连击时检查提醒，编辑工具连击时检查中止。

在仓库根目录执行以下命令。更新基线前先确认预期行为已经变更。

```sh
node dev-harness/prompt-benchmark/run.js --after
node dev-harness/prompt-benchmark/run.js --before
```

`--after` 与现有的 `baseline.json` 比对，`--before` 会重写该文件。输出会分别列出已评估和跳过的场景。需要比较真实模型时使用 [分级模型评测](../model-tier-probe.js)。
