'use strict';

const path = require('node:path');

function createFileToolMutations() {

  // hunt2 #17:检查点结果 → 模型可见的警告。此前只有 file_write 看 journalRecord 的返回值,file_edit/file_move/
  // file_copy/archive_*/http_download 在检查点没写进去(>5MB 被标 skipped、写盘失败)时照样回 ok:true 且一字不提,
  // UI 徽章按工具名显示「可撤销」,真去撤销时才报 before content was not stored。与 file_write 同一口径。
  function journalCheckpointWarn(jr) {
    if (jr && jr.ok === false) return `回滚检查点未写入(${jr.reason});本写入不可一键撤销`;
    if (jr && jr.skipped) return '文件超过检查点快照上限;本写入不可一键撤销';
    return '';
  }

  const FileMutationQueue = require('./file-mutation-queue.cjs').createFileMutationQueue();
  function fileToolWriteLockKey(filePath) { return path.resolve(String(filePath || '')); }
  function withFileToolWriteLock(filePaths, signal, work) { return FileMutationQueue.run(signal, work); }

  return { fileToolWriteLockKey, journalCheckpointWarn, withFileToolWriteLock };
}

module.exports = { createFileToolMutations };
