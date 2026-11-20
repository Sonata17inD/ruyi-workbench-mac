require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）
(async () => {
// Observe dispatch, pause/resume, cycle detection and finalization through the live service.
'use strict';
const { killOwnTree } = require('./lib/kill-own-tree');
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const FAKE_PORT = await getFreePort(), WB_PORT = await getFreePort();
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-ready-queue-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
function kill(p) { if (p && p.pid) try { killOwnTree(p); } catch { /* ignore */ } }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function httpReq(port, method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'content-type': 'application/json', ...(data ? { 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, res => {
      let buf = ''; res.on('data', c => (buf += c));
      res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch { /* raw */ } resolve({ status: res.statusCode, json: j, text: buf }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
async function up(port) { // 117q:预算 60×150ms=9s 小于本机冷启动实测 4.6-6.3s 且余量过窄,是「FAIL workbench up」假红的根(30 号文 P1-31)
  for (let i = 0; i < 300; i++) { try { const r = await httpReq(port, 'GET', '/health'); if (r.status === 200) return true; } catch { /* not yet */ } await sleep(150); } return false; }
// 117q-P1-33:up() 返回不蕴含 runtime.json 已写好(server.listen 让 /health 答 200 在先,token 生成+落盘在后——
// 13-http-router.js:1619 vs :1777)——单次直读可能抢跑读到空串。第一次启动没有旧值可比,判据是非空即可;预算与 up() 同量级(300×150ms)。
async function waitToken() {
  for (let i = 0; i < 300; i++) { const t = (readJson(path.join(HOME, 'runtime.json')) || {}).token || ''; if (t) return t; await sleep(150); }
  return (readJson(path.join(HOME, 'runtime.json')) || {}).token || '';
}

// Hold the two model responses until the test releases them.
const fastStarted = Promise.withResolvers();
const releaseFast = Promise.withResolvers();
const releaseSlow = Promise.withResolvers();
const fake = http.createServer((req, res) => {
  let body = ''; req.on('data', c => (body += c));
  req.on('end', async () => {
    if (req.method === 'GET' && (req.url || '').includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model' }] }));
    }
    if (req.method === 'POST' && (req.url || '').includes('/chat/completions')) {
      if (body.includes('PAUSEMARK')) {
        fastStarted.resolve();
        await releaseFast.promise;
      }
      if (body.includes('SLOWMARK')) await releaseSlow.promise;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const id = 'chatcmpl-rq';
      const sse = o => res.write('data: ' + JSON.stringify(o) + '\n\n');
      sse({ id, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
      sse({ id, choices: [{ index: 0, delta: { content: '节点完成:' + (body.includes('SLOWMARK') ? '慢任务' : '快任务') }, finish_reason: null }] });
      sse({ id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      sse({ id, choices: [], usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 } });
      res.write('data: [DONE]\n\n'); res.end();
      return;
    }
    res.writeHead(404); res.end('nope');
  });
});

(async () => {

  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 7, permissionMode: 'bypass', defaultWorkspace: HOME, subagentMaxConcurrent: 2,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + FAKE_PORT, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
    activeProvider: 'fake',
  }, null, 2));
  await new Promise(r => fake.listen(FAKE_PORT, '127.0.0.1', r));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, RUYI_HOME: HOME } });
  wb.stdout.on('data', () => {}); wb.stderr.on('data', () => {});
  try {
    ok(await up(WB_PORT), 'workbench up on :' + WB_PORT);
    // 117q-P1-33:见 waitToken 头注——单次直读可能在 runtime.json 落盘前抢跑,读到空串。
    const token = await waitToken();
    const H = { 'x-wcw-token': token };
    const sid = ((await httpReq(WB_PORT, 'POST', '/api/sessions', { title: 'rq', cwd: HOME }, H)).json || {}).session.id;
    ok(!!sid, '会话已建');

    // ── A) 快下游不等慢兄弟 ──
    const t0 = Date.now();
    const launch = (await httpReq(WB_PORT, 'POST', '/api/agent-workflow/launch', {
      token, sessionId: sid, async: true,
      nodes: [
        { id: 'slowA', task: '慢任务 SLOWMARK:研究一个大问题', toolTier: 'read', maxIters: 3 },
        { id: 'fastB', task: 'PAUSEMARK 快任务:先导小步骤', toolTier: 'read', maxIters: 3 },
        { id: 'fastC', task: '快任务:基于 fastB 的下游', toolTier: 'read', maxIters: 3, dependsOn: ['fastB'] },
      ],
    }, H)).json;
    const runId = launch && launch.runId;
    ok(!!(launch && launch.ok && runId), '异步 launch 接受 ' + runId);
    const runFile = path.join(HOME, 'agent-runs', sid, runId + '.json');
    const started = await Promise.race([fastStarted.promise.then(() => true), sleep(5000).then(() => false)]);
    ok(started, 'A fastB 已进入模型调用');
    const control = action => httpReq(WB_PORT, 'POST', '/api/agent-runs/' + runId, { sessionId: sid, action }, H);
    ok((await control('pause')).json?.ok, 'A 在节点仍运行时暂停派发');
    releaseFast.resolve();
    let pausedState;
    for (let i = 0; i < 100; i++) {
      pausedState = Object.fromEntries((readJson(runFile)?.nodes || []).map(n => [n.id, n.status]));
      if (pausedState.fastB === 'succeeded') break;
      await sleep(20);
    }
    ok(pausedState.fastC === 'queued' && pausedState.fastB === 'succeeded' && pausedState.slowA === 'running',
      'A 暂停期间 fastB 可完成，下游仍排队');
    ok((await control('resume')).json?.ok, 'A 慢节点仍在运行时恢复');
    let sawOverlap = false, done = false, finalRun = null;
    while (!done && Date.now() - t0 < 30000) {
      await sleep(100);
      const run = readJson(runFile);
      if (!run) continue;
      const st = Object.fromEntries((run.nodes || []).map(n => [n.id, n.status]));
      if (st.fastC === 'succeeded' && st.slowA === 'running') {
        sawOverlap = true;
        releaseSlow.resolve();
      }
      if (['succeeded', 'partial', 'failed', 'stopped'].includes(run.status)) { done = true; finalRun = run; }
    }
    ok(!!finalRun && finalRun.status === 'succeeded', 'A run 最终 succeeded(实 ' + (finalRun && finalRun.status) + ')');
    ok(sawOverlap, 'A 观测到「fastC 已完成而 slowA 仍在跑」—— 批次屏障下不可能出现的中间态');
    releaseSlow.resolve();

    // ── B) 环检测 ──
    const launch2 = (await httpReq(WB_PORT, 'POST', '/api/agent-workflow/launch', {
      token, sessionId: sid, async: true,
      nodes: [
        { id: 'a', task: '快任务 甲', toolTier: 'read', maxIters: 2, dependsOn: ['b'] },
        { id: 'b', task: '快任务 乙', toolTier: 'read', maxIters: 2, dependsOn: ['a'] },
      ],
    }, H)).json;
    const runId2 = launch2 && launch2.runId;
    ok(!!(launch2 && launch2.ok && runId2), 'B 环 DAG launch 接受');
    let r2 = null;
    for (let i = 0; i < 60; i++) { await sleep(150); r2 = readJson(path.join(HOME, 'agent-runs', sid, runId2 + '.json')); if (r2 && ['failed', 'partial', 'succeeded'].includes(r2.status)) break; }
    ok(r2 && r2.status === 'failed', 'B 环 run=failed(实 ' + (r2 && r2.status) + ')');
    ok(r2 && (r2.nodes || []).every(n => /依赖图存在环/.test(String(n.error || ''))), 'B 节点 error 含「依赖图存在环」');

    // ── D) P1-1 确定性反例:a,b → v(vote 门,同步 settle)→ d ──
    const launch3 = (await httpReq(WB_PORT, 'POST', '/api/agent-workflow/launch', {
      token, sessionId: sid, async: true,
      nodes: [
        { id: 'a', task: '快任务 甲:给出正面观点', toolTier: 'read', maxIters: 2 },
        { id: 'b', task: '快任务 乙:给出反面观点', toolTier: 'read', maxIters: 2 },
        // dedupe 门 = 确定性同步节点(无模型调用,首个 await 即尾部落盘)—— P1-1 的精确形态:
        // 它单独在飞时,flight 在派发器自己的 save await 期间 settle 清空 inFlight。
        { id: 'v', task: '发现去重聚合', toolTier: 'read', dependsOn: ['a', 'b'], gate: { mode: 'dedupe' } },
        { id: 'd', task: '快任务 丁:基于聚合的下游', toolTier: 'read', maxIters: 2, dependsOn: ['v'] },
      ],
    }, H)).json;
    ok(!!(launch3 && launch3.ok && launch3.runId), 'D vote-DAG launch 接受');
    let r3 = null;
    for (let i = 0; i < 100; i++) { await sleep(150); r3 = readJson(path.join(HOME, 'agent-runs', sid, launch3.runId + '.json')); if (r3 && ['failed', 'partial', 'succeeded', 'stopped'].includes(r3.status)) break; }
    const st3 = Object.fromEntries(((r3 && r3.nodes) || []).map(n => [n.id, n.status]));
    ok(r3 && ['succeeded', 'partial'].includes(r3.status) && st3.d && st3.d !== 'failed' && !/依赖图存在环/.test(String(((r3.nodes || []).find(n => n.id === 'd') || {}).error || '')),
      'D 同步 vote 节点 fast-settle 后下游未被误诊为环(d=' + st3.d + ', run=' + (r3 && r3.status) + ')');

    // ── E) 收尾封口:run1 完成后快照冻结 + 事件配对 ──
    const evFile = path.join(HOME, 'agent-runs', sid, runId + '.events.ndjson');
    const snapBefore = fs.statSync(runFile).mtimeMs + ':' + (readJson(runFile) || {}).eventSeq;
    await sleep(1800);   // > 1.5s 节流窗,若有 detached 尾巴写入必被观测
    const snapAfter = fs.statSync(runFile).mtimeMs + ':' + (readJson(runFile) || {}).eventSeq;
    ok(snapBefore === snapAfter, 'E run 完成后快照冻结(无 run_end 后写)');
    const evts = fs.readFileSync(evFile, 'utf8').split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    ok(evts.length && evts[evts.length - 1].type === 'run_end', 'E 事件日志末条 = run_end(实 ' + (evts.length && evts[evts.length - 1].type) + ')');
    const starts = evts.filter(e => e.type === 'node_start').map(e => e.nodeId + '#' + e.attemptId);
    const settles = evts.filter(e => e.type === 'node_settled' || e.type === 'node_requeued').map(e => e.nodeId + '#' + e.attemptId);
    ok(starts.length && starts.every(k => settles.includes(k)), 'E node_start 与 settle/requeue 按 attemptId 配对(' + starts.length + ' 对)');
  } catch (e) { console.log('ERROR ' + (e && e.stack || e)); fail++; }
  finally {
    releaseFast.resolve();
    releaseSlow.resolve();
    kill(wb); try { fake.close(); } catch { /* ignore */ }
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nSCHEDULER-READY-QUEUE E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
  }
})();

})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
