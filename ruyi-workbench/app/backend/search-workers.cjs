'use strict';
const WALK_PATTERN_MAX_CHARS = 1000;
const WALK_PATTERN_BUDGET_MS = 1500;
const WALK_PATTERN_BATCH = 1000;
function regexBacktrackBounded(src) {
  let quantifiers = 0;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (c === '\\') {
      const n = src[i + 1];
      if (n === undefined || /[1-9k]/.test(n)) return false;   // 反向引用 → 不判有界
      i += 1;
      continue;
    }
    if (c === '[') {   // 字符类整体是一个原子
      i += 1;
      if (src[i] === '^') i += 1;
      if (src[i] === ']') i += 1;
      while (i < src.length && src[i] !== ']') { if (src[i] === '\\') i += 1; i += 1; }
      continue;
    }
    if (c === '(' || c === ')' || c === '|') return false;
    if (c === '*' || c === '+' || c === '?') {
      quantifiers += 1;
      if (src[i + 1] === '?') i += 1;   // 惰性量词后缀
      continue;
    }
    if (c === '{') {
      const m = /^\{\d+(?:,\d*)?\}/.exec(src.slice(i));
      if (m) { quantifiers += 1; i += m[0].length - 1; if (src[i + 1] === '?') i += 1; }
    }
  }
  return quantifiers <= 1;
}
const PATH_MATCH_WORKER_SRC = `
(() => {
  const { parentPort, workerData } = require('worker_threads');
  let re;
  try { re = new RegExp(workerData.pattern, workerData.flags); } catch (e) { parentPort.postMessage({ type: 'error', error: String((e && e.message) || e) }); return; }
  parentPort.on('message', m => {
    const hits = [];
    for (let i = 0; i < m.subjects.length; i += 1) { if (re.test(m.subjects[i])) hits.push(i); }
    parentPort.postMessage({ type: 'hits', hits });
  });
})();
`;
async function closeSearchWorker(worker) {
  if (!worker) return { cleanupIncomplete: false };
  let timer;
  try {
    await Promise.race([worker.terminate(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Worker termination timed out')), 1000);
    })]);
  } catch { /* threadId below remains the exit authority */ }
  finally { clearTimeout(timer); }
  return { cleanupIncomplete: worker.threadId !== -1 };
}
// 一次遍历一个 worker;match 顺序调用且永不 reject。close() 幂等并返回退出确认。
function createBoundedPathMatcher(pattern, flags, budgetMs, signal) {
  let worker = null, dead = '', spent = 0, closing = null, pendingFinish = null;
  let aborted = signal?.aborted === true;
  const abort = () => { aborted = true; dead = 'cancelled'; void close(); };
  function close() {
    if (closing) return closing;
    signal?.removeEventListener('abort', abort);
    const current = worker; worker = null;
    closing = closeSearchWorker(current);
    if (pendingFinish) void pendingFinish({ error: dead || 'closed', ...(aborted ? { aborted: true } : {}) });
    return closing;
  }
  try {
    if (aborted) dead = 'cancelled';
    else {
      const { Worker } = require('worker_threads');
      worker = new Worker(PATH_MATCH_WORKER_SRC, { eval: true, workerData: { pattern: String(pattern), flags: String(flags || '') } });
      // A worker can fail while traversal is awaiting I/O between match batches.
      worker.on('error', error => { dead = String(error.message || error); void close(); });
      worker.on('exit', () => { if (!dead) dead = 'worker exited'; void close(); });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    }
  } catch (error) { dead = String(error.message || error) || 'worker unavailable'; }
  const match = async subjects => {
    if (dead || !worker) return { hits: [], timedOut: false, error: dead || 'closed', aborted, ...await close() };
    return new Promise(resolve => {
      const current = worker;
      const started = Date.now();
      let settled = false, timer = null;
      const onMessage = message => {
        if (message?.type === 'hits') void finish({ hits: Array.isArray(message.hits) ? message.hits : [] });
        else if (message?.type === 'error') void finish({ error: String(message.error || 'regex error') });
      };
      async function finish(result) {
        if (settled) return;
        settled = true; pendingFinish = null;
        clearTimeout(timer); current.off('message', onMessage);
        spent += Date.now() - started;
        let cleanup = {};
        if (result.timedOut || result.error || result.aborted) {
          dead = result.error || (result.aborted ? 'cancelled' : 'timed out');
          cleanup = await close();
        }
        const cancelled = aborted || signal?.aborted === true;
        resolve({ hits: [], timedOut: false, error: '', ...result, ...cleanup,
          ...(cancelled ? { aborted: true, hits: [] } : {}), ...(cleanup.cleanupIncomplete ? { hits: [] } : {}) });
      }
      pendingFinish = finish;
      current.on('message', onMessage);
      timer = setTimeout(() => { void finish({ timedOut: true }); }, Math.max(1, budgetMs - spent));
      try { current.postMessage({ subjects }); } catch (error) { void finish({ error: String(error.message || error) }); }
    });
  };
  return { match, close };
}

// ---- 遍历类工具的共用忽略清单(F2)----
// 之前 file_list/glob/file_search/project_snapshot 只忽略 node_modules/.git/.venv,docs_search/symbol_search 各自另有
// 一份「宽」名单,walk 又按 readdir 顺序先到先得地截断 —— __pycache__/venv/.claude/worktrees 之类的大目录把配额吃光,
// 真正的源码根本没被看到,而结果里往往没有 truncated。现在一份名单、一处实现:
//   · 目录名(不含 '/')逐层比对目录项名(Windows 上不分大小写);含 '/' 的项(如 `.claude/worktrees`)比对相对遍历根的路径;
//   · `.NET`:目录里有 *.csproj/*.fsproj/*.vbproj 时,其下的 bin/obj 也剪掉(单独的 bin 太常见,不能无条件剪);
//   · 调用方的 ignoreDirs 是【追加】(此前是整份覆盖,模型传一个 ignoreDirs 就把 node_modules 又放回来了);
//     includeIgnored:true 是整体退出口(仍保留 .git/.svn/.hg —— 仓库内部对话没有意义);
//   · browse:true(file_list 非递归 = 目录浏览)只用最小名单 —— 用户点开一个目录就是想看里面有什么(build/dist 也要能看)。
function assertSearchExecution(signal, scan) {
  if (scan?.cleanupIncomplete) throw Object.assign(new Error('Search worker exit has not been confirmed'), {
    code: 'worker_cleanup_incomplete', searchExecutionFailure: true, cleanupIncomplete: true, cleanupScope: 'worker',
  });
  if (signal?.aborted || scan?.aborted) throw Object.assign(new Error('Search cancelled'), { code: 'aborted', searchExecutionFailure: true });
}
function awaitSearchProbe(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(Object.assign(new Error('Search cancelled'), { code: 'aborted', searchExecutionFailure: true })); };
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

module.exports = { WALK_PATTERN_MAX_CHARS, WALK_PATTERN_BUDGET_MS, WALK_PATTERN_BATCH, regexBacktrackBounded, createBoundedPathMatcher, closeSearchWorker, assertSearchExecution, awaitSearchProbe };
