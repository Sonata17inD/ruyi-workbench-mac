'use strict';

const path = require('node:path');
const ACC_MEMORY_IMPORT_SCHEMA = 1;

function createAccMemoryImportMarker({ DurableJsonStore, paths }) {
  const accMemoryImportMarker = () => path.join(paths.memory, '.acc-memory-import-v1.json');
  // 架构还债批 2 B3:完成标记走 DurableJsonStore(01),盘上字节与恢复口径与手写版逐字节相同:
  //   · 缺失 / 读不动 / 不是 JSON / 根不是对象 / schema 不是 1(含缺 schema)= 「还没做完」,幂等导入下次重跑;
  //     坏文件原样留着、不复制成 .corrupt(quarantine:false),不记事件 —— 与手写版一样安静;
  //   · 不缓存(cache:false):MCP 装配每次同步重读标记(测试与迁移中心会删它);
  //   · 写:mkdir memory 目录 + atomicWriteJson(pretty JSON),键序就是调用方给的那份。
  const accMemoryImportStore = DurableJsonStore.create({
    id: 'acc-memory-import-marker',
    file: accMemoryImportMarker,
    schemaVersion: ACC_MEMORY_IMPORT_SCHEMA,
    cache: false,
    quarantine: false,
    defaultValue: () => ({ schema: ACC_MEMORY_IMPORT_SCHEMA }),
    // 缺 schema 的也不认(prepare 只拒「有且不等」,缺的这一半在这里拒)—— 手写版判的是 marker.schema === 1。
    sanitize: value => (value.schema === ACC_MEMORY_IMPORT_SCHEMA ? value : { schema: ACC_MEMORY_IMPORT_SCHEMA }),
  });
  function legacyAccMemoryMigrationComplete() {
    try { return accMemoryImportStore.readSync().status === 'complete'; } catch { return false; }
  }

  return { ACC_MEMORY_IMPORT_SCHEMA, accMemoryImportStore, legacyAccMemoryMigrationComplete };
}

module.exports = { createAccMemoryImportMarker };
