#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(服务启动会导入真机 MCP 配置,见 lib 头注)
const { killOwnTree } = require('./lib/kill-own-tree'); // 128c:只杀自己的树(核创建时间)
// Measure health and status responsiveness while a slow CLI probe refreshes its cached result.
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { getFreePort } = require('./free-port.js');
const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'ruyi-workbench', 'app', 'server.js');
const SLOW_MS = 1500;   // 每支合成 CLI 睡多久;修前过期那一发同步探两支 = 至少 3 s
const TTL_MS = 1000;    // 测试口:记忆期(产品里是 60 s)
let fail = 0;
const ok = (c, label) => { if (c) console.log('PASS ' + label); else { fail++; console.log('FAIL ' + label); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-128f13-'));
const HOME = path.join(WORK, 'home');
const BIN = path.join(WORK, 'bin');
for (const dir of [HOME, BIN]) fs.mkdirSync(dir, { recursive: true });
const CLAUDE_CLI = path.join(BIN, 'initial-cli');
fs.writeFileSync(CLAUDE_CLI, '#!' + process.execPath + '\nsetTimeout(() => process.exit(0), ' + SLOW_MS + ');\n', { mode: 0o755 });
fs.writeFileSync(path.join(BIN, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: 13, includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false,
  desktopMcp: { enabled: false, command: '', args: [], cwd: '', autodetect: false },
}, null, 2));

const get = (port, p) => new Promise(resolve => {
  const t0 = Date.now();
  const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 30000 }, res => {
    let body = '';
    res.on('data', d => { body += d; });
    res.on('end', () => { let json = null; try { json = JSON.parse(body); } catch { /* 非 JSON */ } resolve({ status: res.statusCode, json, ms: Date.now() - t0 }); });
  });
  req.on('error', () => resolve({ status: 0, json: null, ms: Date.now() - t0 }));
  req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null, ms: Date.now() - t0 }); });
});

(async () => {
  const port = await getFreePort();
  const child = cp.spawn(process.execPath, [SERVER, 'serve', '--port', String(port)], {
    cwd: path.join(ROOT, 'ruyi-workbench', 'app'),
    env: { ...process.env, RUYI_HOME: HOME, HOME,
      PATH: BIN + path.delimiter + '/usr/bin:/bin',
      CLAUDE_CLI_PATH: CLAUDE_CLI, WCW_TEST_CLI_PROBE_TTL_MS: String(TTL_MS) },
    stdio: 'ignore',
  });
  try {
    let health = null;
    for (let i = 0; i < 300 && !(health && health.status === 200); i++) { await sleep(100); health = await get(port, '/health'); }
    ok(Boolean(health) && health.status === 200, 'C0 服务起来了');
    let s1;
    for (let i = 0; i < 80; i++) {
      s1 = await get(port, '/api/status');
      if (s1.json?.detectedClaudePath === CLAUDE_CLI) break;
      await sleep(100);
    }
    ok(s1.json?.detectedClaudePath === CLAUDE_CLI, 'C1 startup discovers the synthetic CLI');

    // 过期:之后第一发读配置就是修前被钉住的那一发。同时每 50 ms 打一发 /health,量事件循环有没有被占住。
    await sleep(TTL_MS + 500);
    let pinging = true;
    const pings = [];
    const pinger = (async () => { while (pinging) { pings.push((await get(port, '/health')).ms); await sleep(50); } })();
    const s2 = await get(port, '/api/status');
    await sleep(SLOW_MS + 300);
    pinging = false;
    await pinger;
    const worst = Math.max(0, ...pings);
    // 墙钟上界豁免：判的是「没被同步探测钉住」—— 钉住时至少 2×SLOW_MS（3 s），修后单跑几十毫秒，界取 SLOW_MS 的 2/3
    ok(s2.status === 200 && s2.ms < SLOW_MS * 2 / 3, `C2 过期之后那一发 /api/status 秒回(${s2.ms} ms;修前 ≥ ${SLOW_MS * 2} ms)`);
    ok(pings.length >= 5 && worst < SLOW_MS * 2 / 3, `C2b 同一时段 /health 也没被钉住(${pings.length} 发,最慢 ${worst} ms)`);
    ok(s2.json?.detectedClaudePath === CLAUDE_CLI, 'C3 the stale value is available during refresh');

    fs.unlinkSync(CLAUDE_CLI);
    let s3;
    for (let i = 0; i < 40; i++) {
      await sleep(400);
      s3 = await get(port, '/api/status');
      if (s3.json?.detectedClaudePath === 'claude') break;
    }
    ok(s3.json?.detectedClaudePath === 'claude', 'C4 refresh selects the replacement executable on PATH');
  } catch (error) {
    fail++;
    console.log('FAIL 未捕获异常:' + (error && error.stack || error));
  } finally {
    const exited = new Promise(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('exit', resolve); });
    const cleanup = killOwnTree(child);
    await Promise.race([exited, sleep(5000)]);
    ok((child.exitCode !== null || child.signalCode !== null) && !cleanup.skipped
      && (process.platform !== 'darwin' || (cleanup.incomplete === false && cleanup.scope === 'observed-tree')),
      'owned CLI-probe service process tree cleanup is confirmed');
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* Windows 句柄 */ }
  }
  console.log(fail === 0 ? 'CLI PROBE STALL E2E: ALL PASS' : `CLI PROBE STALL E2E: FAILURES ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
