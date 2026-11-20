'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');

function createWorkflowWait({
  guardWorkspacePath, httpGetGuarded, ssrfCheck,
}) {

  async function evalWaitCondition(node, ctx) {
    const w = node && node.wait; if (!w) return { done: false, failed: false };
    const now = Date.now();
    try {
      if (w.mode === 'timer') {
        const started = Date.parse(node.waitStartedAt || '') || now;
        return { done: now >= started + (Number(w.durationMs) || 0), failed: false, detail: '定时等待' };
      }
      if (w.mode === 'file') {
        // 对抗轮 P3:相对路径按【工作区 cwd】解析(而非服务器进程 cwd)。ctx.cwd 已是 normalizeCwd 后的绝对路径;绝对 w.path 仍覆盖 base。
        const g = await guardWorkspacePath(path.resolve(String(ctx.cwd || ''), String(w.path || '')), ctx.session, ctx.config);
        if (!g.ok) return { done: false, failed: true, detail: '文件等待路径越界或属敏感数据面: ' + (g.error || '') };
        const exists = await fsp.access(g.absPath).then(() => true).catch(() => false);
        return { done: exists === !!w.exists, failed: false, detail: exists ? '文件已存在' : '文件不存在' };
      }
      if (w.mode === 'process') {
        let alive = false;
        try { process.kill(w.pid, 0); alive = true; } catch (e) { alive = !!(e && e.code === 'EPERM'); } // 信号0:ESRCH=不存在,EPERM=存在但无权
        return { done: alive === (w.state !== 'exit'), failed: false, detail: alive ? '进程存活' : '进程不存在' };
      }
      if (w.mode === 'url') {
        const chk = ssrfCheck(String(w.url || ''));
        if (!chk || chk.allowed === false) return { done: false, failed: true, detail: 'URL 被 SSRF 护栏拒绝: ' + ((chk && chk.reason) || '') };
        const r = await httpGetGuarded(String(w.url || ''), { timeoutMs: 4000, maxBytes: 1024, maxRedirects: 1 }); // 对抗轮 P3:收紧探测(单跳内最坏≈8s<abort 竞速 9s,改善 Stop 时延)
        if (r && r.failClass === 'blocked') return { done: false, failed: true, detail: 'URL 探测被护栏拦截(SSRF/重绑定)' };
        if (r && r.ok === true) return { done: true, failed: false, detail: 'URL 可达(HTTP ' + (r.status || 'ok') + ')' };
        return { done: false, failed: false, detail: '暂不可达,继续等待' }; // connect/reset/timeout/非2xx → 维持 waiting
      }
    } catch (e) { return { done: false, failed: false, detail: '检查异常(维持等待): ' + String((e && e.message) || e) }; }
    return { done: false, failed: false };
  }

  return { evalWaitCondition };
}

// Timer nodes have one deadline. External conditions need a fresh probe at their own cadence.
function nextWaitCheckAt(node, now) {
  const w = node.wait;
  const start = Date.parse(node.waitStartedAt) || now;
  const probe = w.mode === 'timer' ? start + w.durationMs
    : node.lastWaitPollAt ? node.lastWaitPollAt + w.pollMs : now;
  return Math.min(start + w.timeoutMs, probe);
}

module.exports = { createWorkflowWait, nextWaitCheckAt };
