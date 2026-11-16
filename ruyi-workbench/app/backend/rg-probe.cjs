'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createRgExecution } = require('./rg-execution.cjs');
function createRgProbe({ ProcessRuntime, vendorBinDir, pathBeforeVendor, env = process.env, candidates }) {
const { runRgOwned } = createRgExecution({ ProcessRuntime });
const candidatesForProbe = candidates || defaultCandidates;
// v0.8-S1: ripgrep fast-path probe. Prefer an explicit override / vendored binary, then accept a
// normal system `rg` on PATH. Earlier builds only checked vendor-bin, so a perfectly usable ripgrep
// installation was incorrectly shown as "missing". Cached for the process lifetime; absence still
// falls back to the built-in JS scanner, so project search never becomes unavailable.
// 145-W3:探测结果带【来源】(env=RUYI_RG_PATH / bundled=随包 vendor-bin / system=系统 PATH),体检与
// 引擎说明都读它。另记一个 shell 位:模型在终端里敲裸 rg 能不能找到 —— 00-boot 已把 vendor-bin 前置进
// 进程 PATH,所以随包在就是 bundled,否则看前置之前的系统 PATH;RUYI_RG_PATH 只服务 file_search,不进 PATH。
// 系统候选按【前置之前】的 PATH 逐目录找 rg 可执行文件(不用裸名 'rg':PATH 前置后裸名先解析到随包那份,
// 分不出来源)。服务在跑时一律走异步探测(probeRgAsync),同步版只剩冷缓存兜底;/api/status 与能力矩阵
// 修前每进程第一次都 spawnSync 一发 rg --version,把事件循环钉住。
let _rgProbe;            // undefined = 没探过;否则 { path, source, shell } 或 null
let _rgProbeInflight = null;
function defaultCandidates() {
  const out = [];
  const override = String(env.RUYI_RG_PATH || '').trim();
  if (override) out.push({ command: override, source: 'env' });
  const vendorDir = vendorBinDir();
  if (vendorDir) out.push({ command: path.join(vendorDir, 'rg'), source: 'bundled' });
  for (const raw of pathBeforeVendor.split(path.delimiter)) {
    const dir = String(raw || '').trim().replace(/^"|"$/g, '');
    if (!dir || !path.isAbsolute(dir) || (vendorDir && path.resolve(dir) === path.resolve(vendorDir))) continue;
    out.push({ command: path.join(dir, 'rg'), source: 'system' });
  }
  return out;
}
function rgProbeResolve(candidates, runs) {
  const hit = source => candidates.find((c, i) => c.source === source && runs[i]);
  const first = candidates.find((c, i) => runs[i]) || null;
  const shellHit = hit('bundled') || hit('system');
  return first ? { path: first.command, source: first.source, shell: shellHit ? shellHit.source : '' } : null;
}
async function probeRgAsync() {
  if (!(await ProcessRuntime.helperCapabilityAsync()).ready) return null;
  if (_rgProbe !== undefined) return _rgProbe;
  if (_rgProbeInflight) return _rgProbeInflight;
  _rgProbeInflight = (async () => {
    const candidates = candidatesForProbe();
    const runs = [];
    let systemSeen = false;
    for (const c of candidates) {
      // 系统候选只认 PATH 上【第一个】存在的 rg(与 shell 的解析顺序一致),后面的不再探。
      if (c.source === 'system' && systemSeen) { runs.push(false); continue; }
      let exists = false;
      try { exists = (await fsp.stat(c.command)).isFile(); } catch { exists = false; }
      if (c.source === 'system' && exists) systemSeen = true;
      if (exists) {
        const result = await runRgOwned(c.command, ['--version'], process.cwd(), 4000, 65536, null,
          { kind: 'capability-probe', capabilityId: 'rg' });
        runs.push(!!result && result.code === 0);
      } else runs.push(false);
    }
    _rgProbe = rgProbeResolve(candidates, runs);
    return _rgProbe;
  })().finally(() => { _rgProbeInflight = null; });
  return _rgProbeInflight;
}
// 冷缓存兜底(启动期/CLI 子命令)。服务在跑的请求路径请用 probeRgAsync / hasRgAsync。
function probeRgInfoSync() {
  const capability = ProcessRuntime.helperCapability();
  if (!capability.ready || !capability.deadline) return null;
  if (_rgProbe !== undefined) return _rgProbe;
  const candidates = candidatesForProbe();
  const runs = [];
  let systemSeen = false;
  for (const c of candidates) {
    if (c.source === 'system' && systemSeen) { runs.push(false); continue; }
    let exists = false;
    try { exists = fs.statSync(c.command).isFile(); } catch { /* missing candidate */ }
    if (c.source === 'system' && exists) systemSeen = true;
    let ok = false;
    if (exists) {
      const result = ProcessRuntime.probeSync(c.command, ['--version'], { stdio: 'ignore', timeout: 6000 });
      if (result.cleanupIncomplete) throw Object.assign(result.error || new Error('Ripgrep probe cleanup incomplete'), { cleanupIncomplete: true, cleanupScope: result.cleanupScope, cleanupUnconfirmed: result.cleanupUnconfirmed });
      ok = !result.error && result.status === 0;
    }
    runs.push(ok);
  }
  _rgProbe = rgProbeResolve(candidates, runs);
  return _rgProbe;
}
// 只读缓存,绝不触发探测:undefined = 还没探过(调用方按「未知」处理)。
function peekRgProbe() { return _rgProbe; }
function probeRg() { const info = probeRgInfoSync(); return info ? info.path : null; }
function hasRg() { return !!probeRg(); }
async function hasRgAsync() { return !!(await probeRgAsync()); }

return { probeRgAsync, probeRgInfoSync, peekRgProbe, probeRg, hasRg, hasRgAsync, rgProbeCandidates: candidatesForProbe };
}
module.exports = { createRgProbe };
