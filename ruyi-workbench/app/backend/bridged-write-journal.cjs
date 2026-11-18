'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { collectBridgedWriteTargets } = require('./bridged-write-targets.cjs');

function createBridgedWriteJournal({ journalSessionCtx, guardWorkspacePath, journalRecord }) {
  // v1.5-W1.5 (T3): 在 bridged 写族工具「分发执行之前」存一份 before 快照进 journal —— 让「本轮变更」卡里
  // 该文件可撤销、journalRollback 能恢复。全部失败静默吞掉(快照失败绝不阻断工具执行,与内建文件工具的
  // journalRecord 同一安全网纪律)。走既有 journal 条目格式 → 与内建工具「本轮变更」卡/rollback API 零前端改动。
  //   op 判定:目标已存在 → modify(存 before 内容);不存在 → create(回滚=删除)。
  //   delete 语义:存 before(op:delete,回滚=写回);目标不存在 → 不快照(没什么可回退)。
  //   安全:用与文件工具同一路径护栏(guardWorkspacePath)判定;越界 → 不快照(工具照常执行,ACC 有自己
  //   的 protected_path 护栏兜底)。
  async function journalBridgedWrite(bridgedName, args, session, config, ctx) {
    try {
      const targets = collectBridgedWriteTargets(bridgedName, args);
      if (!targets.length) return; // 非写族 / 无路径 / 非绝对路径 → 不快照
      const jctx = await journalSessionCtx(ctx);
      if (!jctx.sessionId || !Number.isFinite(jctx.turnSeq)) return; // 无会话上下文 → 无处锚定
      // v1.2-B 多目标:逐个目标独立护栏 + 快照。任一失败(越界/读不到/journalRecord 抛)静默跳过【该目标】,
      //   不阻断工具、不阻断其它目标。move_file 的两条(source delete + destination write)按此表顺序落 journal;
      //   journalRollback 整回合逆序展开(后写的 dest 先撤 → 删掉新文件;再撤 src → 把源写回原处),净效果=移动前状态。
      for (const target of targets) {
        try {
          // 路径护栏:必须落在允许的工作区内;越界不快照(工具照常执行,ACC 有自己的 protected_path 兜底)。
          const guard = await guardWorkspacePath(target.path, session, config);
          if (!guard.ok) continue;
          const p = guard.absPath;
          // 读 before:存在→取字节;不存在→null。读失败(权限/目录)按「无 before」处理,不阻断。
          let before = null, exists = false;
          try { before = await fsp.readFile(p); exists = true; } catch { before = null; exists = false; }
          if (target.mode === 'delete') {
            if (!exists) continue; // 删/移一个不存在(或读不到)的源 → 没什么可回退
            await journalRecord(jctx.sessionId, jctx.turnSeq, bridgedName, path.resolve(target.path), 'delete', before);
          } else {
            // write:存在→modify(存 before);不存在→create(无 before,回滚=删除)。
            await journalRecord(jctx.sessionId, jctx.turnSeq, bridgedName, path.resolve(target.path), exists ? 'modify' : 'create', exists ? before : null);
          }
        } catch {
          // 单目标安全网:该目标本回合不可撤销,但工具与其它目标照常。
        }
      }
    } catch {
      // 安全网:快照失败绝不阻断工具执行。吞掉即可(该文件本轮不可撤销,但工具照常运行)。
    }
  }

  return journalBridgedWrite;
}

module.exports = { createBridgedWriteJournal };
