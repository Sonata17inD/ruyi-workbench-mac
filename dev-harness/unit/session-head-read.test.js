'use strict';
const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-session-head-read-'));
process.env.RUYI_HOME = root;
const repo = path.resolve(__dirname, '../..');
const srv = require(path.join(repo, 'ruyi-workbench', 'app', 'server.js'));

const { readSessionHeadResilient } = srv;
const sessionsDir = path.join(root, 'sessions');
const headPath = id => path.join(sessionsDir, id + '.json');
const writeHead = (id, extra = {}) => {
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(headPath(id), JSON.stringify({ id, storageVersion: 2, title: 't', ...extra }, null, 2), 'utf8');
};

describe('readSessionHeadResilient', () => {
  it('① 正常会话原样读回', async () => {
    writeHead('sess_plain', { title: '正常' });
    const head = await readSessionHeadResilient('sess_plain');
    assert.equal(head && head.id, 'sess_plain');
    assert.equal(head && head.title, '正常');
  });

  it('reads a missing head once and propagates filesystem errors', async () => {
    const readFile = fsp.readFile;
    let reads = 0;
    fsp.readFile = async (...args) => {
      reads++;
      return readFile(...args);
    };
    try {
      assert.equal(await readSessionHeadResilient('absent'), null);
      assert.equal(reads, 1);
      fs.mkdirSync(headPath('directory'));
      await assert.rejects(readSessionHeadResilient('directory'), { code: 'EISDIR' });
    } finally {
      fsp.readFile = readFile;
    }
  });

  it('④ 内容坏掉不重试（那是隔离路径的事，重试只会把坏内容读四遍）', async () => {
    const id = 'sess_corrupt';
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(headPath(id), '{ this is not json', 'utf8');
    assert.equal(await readSessionHeadResilient(id), null);
  });
});

describe('loadSession：并发写盘时绝不做破坏性动作', () => {
  // 这一组钉的是同一条 bug 的另一半，也是更严重的那一半：
  // loadSession 的两个破坏性动作（截断「未提交尾巴」、把会话隔离成 .corrupt）判据是
  // 「头声明的行数 vs 正文实际行数」，而头与正文是**先后两次**读进来的。saveSession 的写链里
  // 正文先落、头后落 —— 一次并发的 loadSession 正好落在中间，就会拿【旧头】去量【新正文】，
  // 把刚写进去的那一行当成崩溃残留**物理截断**；下一次 load 再看到「头说 1、正文 0」，
  // 整条会话被隔离成 .corrupt。实证打点：`TRUNCATE from=1 to=0` 紧跟着 `QUARANTINE headMsg=1 body=0`。
  //
  // ⚠ 诚实说明：下面这条【不是】那条竞态的可靠复现 —— 实测把写链守卫关掉它照样绿（要精确卡进
  // saveSession 内部「正文已落、头未落」那一格，从外部 API 命不中）。它断言的是那条不变量本身
  // （并发读回来的会话必须完整），有价值但没牙。真正的证据是带打点的 e2e 连跑：修前
  // TRUNCATE/QUARANTINE 必现、修后 5 连跑一次都没有。守卫本身由下面那一组【源码锁】机械看住。
  it('并发 save 期间读同一条会话：结果必须完整（不变量断言，不是竞态复现）', async () => {
    const created = await srv.createSession({ title: '并发', cwd: root });
    created.messages = [{ role: 'user', content: '第一句', createdAt: new Date().toISOString() }];
    created.providerHistory = [{ role: 'user', content: '第一句' }];
    await srv.saveSession(created);

    created.messages.push({ role: 'assistant', content: '第二句', createdAt: new Date().toISOString() });
    created.providerHistory.push({ role: 'assistant', content: '第二句' });
    const saving = srv.saveSession(created);          // 故意不 await
    const racing = await srv.loadSession(created.id); // 与它抢同一条会话
    await saving;

    assert.ok(racing, '并发读不得把一条好端端的会话判成损坏（修前这里会拿到 null）');
    const after = await srv.loadSession(created.id);
    assert.ok(after, '会话必须还在（修前它会被隔离成 .corrupt）');
    assert.equal(after.messages.length, 2, '正文一行都不许被截掉');
    assert.equal(after.providerHistory.length, 2);
    assert.ok(!fs.existsSync(path.join(sessionsDir, created.id + '.json.corrupt')), '不得留下隔离文件');
  });
});

describe('loadSession：装载那一眼之后有人写过盘，就不许拿旧副本做任何写动作（确定性复现）', () => {
  // 上面那条「不变量断言」没有牙；Windows CI 上它偶发红（after.messages 1 vs 2），根因是另外两条路：
  //   ① 新会话第一次被装载时 normalizeSession 会补默认字段（todos/skills/memories…）→ 装载拿【读到的旧副本】
  //      回写一次。回写若排在并发 save 之后入链，就把刚落盘的消息整份盖回去；
  //   ② 读正文时见到「无换行结尾的尾行」就地截断 —— 可 Windows 上并发读能看到 append 写了一半的行，
  //      截掉的正是正在落盘的那一条。
  // 这里用注入的延迟把两条竞态卡到必现，修前两条都红。
  const freshTwoTurnSession = async () => {
    const s = await srv.createSession({ title: '竞态', cwd: root });
    s.messages = [{ role: 'user', content: '1', createdAt: new Date().toISOString() }];
    s.providerHistory = [{ role: 'user', content: '1' }];
    await srv.saveSession(s);
    s.messages.push({ role: 'assistant', content: '2', createdAt: new Date().toISOString() });
    s.providerHistory.push({ role: 'assistant', content: '2' });
    return s;
  };
  const diskCount = id => JSON.parse(fs.readFileSync(headPath(id), 'utf8')).messageCount;
  const bodyLines = id => fs.readFileSync(path.join(sessionsDir, id + '.messages.ndjson'), 'utf8').split('\n').length - 1;

  it('⑤ 装载的补字段回写排在并发 save 之后 → 被丢弃，不把第 2 条盖掉', async () => {
    const s = await freshTwoTurnSession();
    const orig = fsp.unlink;
    let armed = true;
    // 装载读完头与正文后会先清 .v1bak 再回写：在这里停 150ms，让并发 save 整个跑完。
    fsp.unlink = async function (p) {
      if (armed && String(p).endsWith(s.id + '.json.v1bak')) { armed = false; await new Promise(r => setTimeout(r, 150)); }
      return orig.apply(this, arguments);
    };
    try {
      const racing = srv.loadSession(s.id);
      await new Promise(r => setTimeout(r, 20));
      await srv.saveSession(s);
      await racing;
    } finally { fsp.unlink = orig; }
    assert.equal(diskCount(s.id), 2, '头上的计数被装载回写成了旧的 1');
    assert.equal(bodyLines(s.id), 2, '正文被装载回写重写成了 1 行');
    const after = await srv.loadSession(s.id);
    assert.equal(after && after.messages.length, 2);
    // 再存一轮：装载若把旧 hash 交给了 sessionBodyState，这一存会按旧前缀 append（重复/丢行）。
    after.messages.push({ role: 'user', content: '3', createdAt: new Date().toISOString() });
    after.providerHistory.push({ role: 'user', content: '3' });
    await srv.saveSession(after);
    const again = await srv.loadSession(s.id);
    assert.deepEqual(again.messages.map(m => m.content), ['1', '2', '3']);
  });

  it('⑥ 读到 append 写了一半的行（Windows 上会发生）→ 不截断，等写完再读', async () => {
    const s = await freshTwoTurnSession();
    await srv.loadSession(s.id);                 // 先让补字段回写跑掉，这一条只测截断
    const orig = fsp.appendFile;
    let armed = true, racing = null;
    // 把正文 append 拆成两半、中间停 100ms 并在这一刻发起一次装载 —— 它读到的正是半行。
    fsp.appendFile = async function (p, data) {
      if (armed && String(p).endsWith(s.id + '.messages.ndjson')) {
        armed = false;
        const text = String(data), cut = Math.floor(text.length / 2);
        await orig.call(this, p, text.slice(0, cut), 'utf8');
        racing = srv.loadSession(s.id);
        await new Promise(r => setTimeout(r, 100));
        return orig.call(this, p, text.slice(cut), 'utf8');
      }
      return orig.apply(this, arguments);
    };
    try { await srv.saveSession(s); await racing; }
    finally { fsp.appendFile = orig; }
    assert.ok(racing, '注入没有触发（快路径没有 append？）');
    assert.equal(bodyLines(s.id), 2, '正在 append 的那一行被当成撕裂尾行截掉了');
    const after = await srv.loadSession(s.id);
    assert.ok(after, '会话不得被判损坏隔离');
    assert.deepEqual(after.messages.map(m => m.content), ['1', '2']);
  });

  it('⑦ 真正的崩溃残留（没有写者时的半行）仍然截断', async () => {
    const s = await freshTwoTurnSession();
    await srv.saveSession(s);
    fs.appendFileSync(path.join(sessionsDir, s.id + '.messages.ndjson'), '{"role":"user","cont', 'utf8');
    const after = await srv.loadSession(s.id);
    assert.equal(after && after.messages.length, 2);
    assert.equal(bodyLines(s.id), 2);
    assert.ok(fs.readFileSync(path.join(sessionsDir, s.id + '.messages.ndjson'), 'utf8').endsWith('\n'), '半行应被截掉');
  });

  // ⑧⑨：截断本身失败（Windows 上杀软/索引器持锁的 EPERM）。修前 .catch 吞掉失败、仍交出 bodiesOk:true，
  // 下次快路径接在残留后面 append：⑧ 新行焊进半行，整条会话被判损坏隔离；⑨ 旧的未提交尾巴留在
  // 真消息前面，下一次截断按行数量出来的位置正好截掉用户那条真消息。
  const withTruncateFailing = async (file, fn) => {
    const orig = fsp.truncate;
    fsp.truncate = async (p, len) => {
      if (String(p) === file) { const e = new Error('EPERM: simulated lock'); e.code = 'EPERM'; throw e; }
      return orig(p, len);
    };
    try { return await fn(); } finally { fsp.truncate = orig; }
  };

  it('⑧ 撕裂尾行截不掉 → 下一次保存全量重写，会话不被隔离', async () => {
    const s = await freshTwoTurnSession();
    await srv.saveSession(s);
    const file = path.join(sessionsDir, s.id + '.messages.ndjson');
    fs.appendFileSync(file, '{"role":"assistant","content":"CRASHED-MID-WR', 'utf8');
    const loaded = await withTruncateFailing(file, () => srv.loadSession(s.id));
    assert.equal(loaded && loaded.messages.length, 2);
    loaded.messages.push({ role: 'user', content: '3' });
    await srv.saveSession(loaded);
    const after = await srv.loadSession(s.id);
    assert.ok(after, '会话被判损坏隔离了（新行焊进了没截掉的半行）');
    assert.deepEqual(after.messages.map(m => m.content), ['1', '2', '3']);
    assert.ok(!fs.readFileSync(file, 'utf8').includes('CRASHED'), '残留半行应随全量重写消失');
  });

  it('⑨ 未提交尾巴截不掉 → 下一次保存全量重写，真消息不被截掉', async () => {
    const s = await freshTwoTurnSession();
    await srv.saveSession(s);
    const file = path.join(sessionsDir, s.id + '.messages.ndjson');
    fs.appendFileSync(file, JSON.stringify({ role: 'user', content: 'STALE-UNCOMMITTED' }) + '\n', 'utf8');
    const loaded = await withTruncateFailing(file, () => srv.loadSession(s.id));
    assert.deepEqual(loaded.messages.map(m => m.content), ['1', '2']);
    loaded.messages.push({ role: 'user', content: 'REAL-NEW' });
    await srv.saveSession(loaded);
    const after = await srv.loadSession(s.id);
    assert.deepEqual(after.messages.map(m => m.content), ['1', '2', 'REAL-NEW']);
    assert.ok(!fs.readFileSync(file, 'utf8').includes('STALE-UNCOMMITTED'));
  });
});

process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });

it('turn completion reads editable metadata from the head and preserves provider-owned todos', async () => {
  const { createSessionPersistence } = require('../../ruyi-workbench/app/backend/session-persistence.cjs');
  const { reconcileTurnMetadata } = createSessionPersistence({
    files: { sessionPath: headPath },
    model: { mergeMissionBeforeSave: (session, head) => { session.mission = head.mission; } },
    coordination: {},
    safeJsonParse: JSON.parse,
  });
  const id = 'turn-metadata';
  writeHead(id, {
    skills: [], todos: ['disk'], memories: ['selected'], memoriesExplicit: false,
    memoryExclusions: ['excluded'], mission: { changeSeq: 4 },
  });
  for (const includeTodos of [true, false]) {
    const session = { id, todos: ['in-flight'], skills: ['old'], memoriesExplicit: true, messages: ['current'] };
    await reconcileTurnMetadata(session, { includeTodos });
    assert.deepEqual(session, {
      id, todos: includeTodos ? ['disk'] : ['in-flight'], skills: [], memoriesExplicit: false,
      memories: ['selected'], memoryExclusions: ['excluded'], mission: { changeSeq: 4 }, messages: ['current'],
    });
  }
});
