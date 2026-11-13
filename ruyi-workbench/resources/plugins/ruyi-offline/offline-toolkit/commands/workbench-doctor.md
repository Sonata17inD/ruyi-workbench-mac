---
name: 工作台体检
description: 运行本地工作台体检命令并总结结果
---

Run Ruyi diagnostics using an isolated RUYI_HOME.

From a source checkout in ruyi-workbench:

```sh
node app/server.js doctor --human
```

From the staged Mac App resources directory:

```sh
./runtime/node/bin/node ./app/server.js doctor --human
```

Report actual readiness, missing dependencies and denied permissions separately. Do not overwrite user configuration or credentials to make a check pass.
