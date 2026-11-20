'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-cli-gate-'));
const home = path.join(root, 'home');
const data = path.join(root, 'data');
const work = path.join(root, 'work');
for (const d of [home, data, work]) fs.mkdirSync(d, { recursive: true });
process.env.RUYI_HOME = data;
process.env.HOME = home;
for (const k of ['WCW_FAKE_CLAUDE', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL']) delete process.env[k];

const writeConfig = patch => fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({
  configSchema: 11, defaultWorkspace: work, includeWorkbenchMcp: false, autoResumeClaudeSessions: true, autoImportClaudeCodeMcp: false,
  killPortOnStart: false, permissionMode: 'default', engineMode: 'legacy', providers: [], activeProvider: '', ...patch,
}, null, 2));
writeConfig({});

const { loadServerInternals } = require('../lib/server-internals');
const { agentCliLauncherUsable, agentCliProbeVerdict, invalidateAgentCliPathCaches, runSessionTurn, createSession, loadSession, mutateSession } = loadServerInternals([
  'agentCliLauncherUsable', 'agentCliProbeVerdict', 'invalidateAgentCliPathCaches', 'runSessionTurn', 'createSession', 'loadSession', 'mutateSession',
]);

const collect = () => { const events = []; return { events, onEvent: e => events.push(e) }; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ───────────── [L] ─────────────
// .cjs 启动器:agentCliProbeSpawn 对它用 process.execPath 跑「<script> --version」,跨平台、不依赖 .cmd / 可执行位。
const launcher = (name, body) => { const file = path.join(root, name); fs.writeFileSync(file, body); return file; };

test('[L1] 三态判定:启动不起来 / 非 0 退出 = missing,超时被杀(status=null 无 error)与 ETIMEDOUT = slow,0 = ok', () => {
  assert.equal(agentCliProbeVerdict({ error: null, status: 0 }), 'ok');
  assert.equal(agentCliProbeVerdict({ error: null, status: null }), 'slow', '超时被杀:不算缺失');
  assert.equal(agentCliProbeVerdict({ error: { code: 'ETIMEDOUT' }, status: null }), 'slow');
  assert.equal(agentCliProbeVerdict({ error: { code: 'ENOENT' }, status: null }), 'missing');
  assert.equal(agentCliProbeVerdict({ error: { code: 'EACCES' }, status: null }), 'missing');
  assert.equal(agentCliProbeVerdict({ error: null, status: 1 }), 'missing', '退出码非 0 = 装坏了');
  assert.equal(agentCliProbeVerdict(null), 'missing');
});

test('[L2] 缺失不放行、不记忆;装好后立刻可用;「在」按 60 s 记忆', async () => {
  invalidateAgentCliPathCaches();
  const file = path.join(root, 'late-claude.cjs');
  assert.equal(await agentCliLauncherUsable(file), false, '启动器不存在 → 缺失');
  assert.equal(await agentCliLauncherUsable(''), false, '空路径 → 缺失');
  fs.writeFileSync(file, 'process.exit(0)');   // 「刚装好」
  assert.equal(await agentCliLauncherUsable(file), true, '缺失结果不记忆:装好后下一次立刻可用');
  fs.rmSync(file);
  assert.equal(await agentCliLauncherUsable(file), true, '「在」的结果记忆期内不再重探(文件删了仍答在)');
  invalidateAgentCliPathCaches();
  assert.equal(await agentCliLauncherUsable(file), false, '设置保存 / 重新检测作废记忆后重新探');
  const broken = launcher('broken-claude.cjs', 'process.exit(3)');
  assert.equal(await agentCliLauncherUsable(broken), false, '退出码非 0 → 缺失');
});

test('[L3] 慢启动器(--version 超过 4 s 探测上限):算「在」放行,且探测期间事件循环照常转', async () => {
  invalidateAgentCliPathCaches();
  const slow = launcher('slow-claude.cjs', 'setTimeout(() => process.exit(0), 9000);');
  let maxGap = 0, last = Date.now();
  const ticker = setInterval(() => { const now = Date.now(); maxGap = Math.max(maxGap, now - last); last = now; }, 25);
  const t0 = Date.now();
  let usable;
  try { usable = await agentCliLauncherUsable(slow); } finally { clearInterval(ticker); }
  const took = Date.now() - t0;
  assert.equal(usable, true, '超时不再被误判成「未检测到 CLI」');
  assert.ok(took >= 3500 && took < 8500, `探测在 4 s 上限处结束(实际 ${took}ms)`);
  assert.ok(maxGap < 1000, `探测期间事件循环没被钉住(最长一次停顿 ${maxGap}ms;修前同步 spawnSync 会停满 4 s)`);
  const t1 = Date.now();
  assert.equal(await agentCliLauncherUsable(slow), true);
  assert.ok(Date.now() - t1 < 500, '慢启动器的「在」同样记忆,下一回合不再付 4 s');
});

test('[L4] 回合入口:CLI 真缺失仍走引导卡(code cli-missing);超时慢的不会挡回合', async () => {
  invalidateAgentCliPathCaches();
  writeConfig({ agentCliType: 'claude', claudePath: path.join(root, 'no-such-claude.cjs') });
  const session = await createSession({ title: 'missing', cwd: work });
  const sink = collect();
  await runSessionTurn({ sessionId: session.id, message: 'hello', cwd: work, onEvent: sink.onEvent });
  const result = sink.events.find(e => e.type === 'result');
  assert.ok(result && result.ok === false && result.code === 'cli-missing', `缺失:引导卡(实际 ${JSON.stringify(result)})`);
  assert.ok(sink.events.some(e => e.type === 'assistant_delta' && /未检测到/.test(e.text)), '给出可操作的中文说明');
});

process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });
