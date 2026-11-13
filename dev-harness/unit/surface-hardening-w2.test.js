'use strict';
// 第二波安全走查(HTTP 面 / 前端 / 命令行)的纯函数与小闭包回归,真 server.js(经 lib/server-internals)与真前端模块。
// 每条都在修前基线上跑过:RUYI_TEST_SERVER_JS 指到修前导出的 server.js、前端文件换回修前版,对应用例必须红(见交付报告)。
//   [C]  S8  Markdown 白名单只放行 language-* / hljs*,应用自己的覆盖层类(modal-backdrop 等)一律剥掉
//   [U]  S12 usageLine 里的非常量插值全部过 escapeHtml
//   [B]  S13 --host 非回环要显式 --allow-remote;非本机对端拿不到 token(bootstrap / 页面注入),其余接口也要头 token
//   [T]  S6  静态与附件的 content-type 补全(nosniff 之后浏览器不再替我们猜)
//   [M]  S11 config.json / .prev / runtime.json 的写入权限 0600(POSIX)
//   [I]  S10 导入会话:消息打 meta.imported、cwd 必须落在已配置工作区内
//   [W]  W5  经 cmd.exe 起 CLI 时,--agents / --append-system-prompt 等动态文本里的 % ! 换成全角
//   [P]  端口接管:只接管【本数据目录】runtime.json 登记的那个实例,别的实例 / 别人的服务一概不动
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-unit-surface-w2-'));
const home = path.join(root, 'home');
fs.mkdirSync(home, { recursive: true });
process.env.RUYI_HOME = home;
process.env.WIN_CLAUDE_WORKBENCH_HOME = home;
process.env.HOME = home;
process.env.USERPROFILE = home;
const { loadServerInternals } = require('../lib/server-internals');
const REPO = path.resolve(__dirname, '..', '..');
const PUBLIC_JS = path.join(REPO, 'ruyi-workbench', 'app', 'public', 'js');
const posix = process.platform !== 'win32';

process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });

const fakeReq = (remoteAddress, headers = {}) => ({ headers: { host: '127.0.0.1:8765', ...headers }, socket: remoteAddress === undefined ? undefined : { remoteAddress }, method: 'GET' });

describe('[C] S8 markdown class allowlist', () => {
  it('C1 sanitizeMarkdownClassValue keeps language-* / hljs* only', async () => {
    const mod = await import(pathToFileURL(path.join(PUBLIC_JS, 'chat-render-primitives.js')).href);
    assert.equal(typeof mod.sanitizeMarkdownClassValue, 'function', 'S8 的纯过滤函数存在');
    const f = mod.sanitizeMarkdownClassValue;
    assert.equal(f('language-js'), 'language-js');
    assert.equal(f('language-c++ hljs hljs-keyword'), 'language-c++ hljs hljs-keyword');
    assert.equal(f('modal-backdrop'), '');
    assert.equal(f('mermaid-lightbox modal-backdrop attachment-viewer-backdrop'), '');
    assert.equal(f('language-js modal-backdrop'), 'language-js', '混着的只留白名单那个');
    assert.equal(f('hljsx'), '', 'hljs 之后只认 - 开头的后缀');
    assert.equal(f('language-'), '', '空语言名不算');
    assert.equal(f('toast  sr-only\tfixed'), '');
    assert.equal(f(undefined), '');
    assert.equal(f(null), '');
  });
});

describe('[U] S12 usageLine escaping', () => {
  it('U1 numTurns / translated strings / token text never reach innerHTML unescaped', async () => {
    const mod = await import(pathToFileURL(path.join(PUBLIC_JS, 'chat-render-primitives.js')).href);
    const util = await import(pathToFileURL(path.join(PUBLIC_JS, 'util.js')).href);
    const evil = '<img src=x onerror=alert(1)>';
    const prims = mod.createChatRenderPrimitives({
      el: (tag, cls) => ({ tag, cls, innerHTML: '' }),
      escapeHtml: util.escapeHtml,
      fmtTokens: util.fmtTokens,
      engineVisual: () => ({ label: evil }),
      currentEngineMeta: () => ({}),
      t: key => (key === 'common.about' ? evil : key),
      tCount: () => evil,
      state: {},
    });
    const line = prims.usageLine({ usage: { input_tokens: 1200, output_tokens: 30 }, estimated: true, durationMs: 1500, costUsd: 0.0123, numTurns: evil }, {});
    assert.ok(!line.innerHTML.includes('<img'), line.innerHTML);
    assert.ok(line.innerHTML.includes('&lt;img'), '转义后的文本还在: ' + line.innerHTML);
    assert.ok(line.innerHTML.includes('<b>') && line.innerHTML.includes('usage-eng'), '自家常量标签不受影响');
  });
});

describe('[B] S13 bind host and remote peers', () => {
  it('B1 loopback address / bind-host classification', () => {
    const { isLoopbackAddress, isLoopbackBindHost } = loadServerInternals(['isLoopbackAddress', 'isLoopbackBindHost']);
    for (const a of ['127.0.0.1', '127.255.255.254', '::1', '::ffff:127.0.0.1', '[::1]', 'localhost']) assert.equal(isLoopbackAddress(a), true, a);
    for (const a of ['0.0.0.0', '::', '192.168.1.5', '10.0.0.1', '::ffff:10.0.0.1', '128.0.0.1', '127.0.0.256', '', undefined, null, 'evil.example']) assert.equal(isLoopbackAddress(a), false, String(a));
    for (const h of ['127.0.0.1', 'localhost', '::1', '[::1]', '127.1.2.3']) assert.equal(isLoopbackBindHost(h), true, h);
    for (const h of ['0.0.0.0', '::', '192.168.0.2', 'my-box', 'example.com']) assert.equal(isLoopbackBindHost(h), false, h);
  });
  it('B2 resolveBindHost refuses a non-loopback --host unless --allow-remote is also given', () => {
    const { resolveBindHost } = loadServerInternals(['resolveBindHost']);
    assert.equal(resolveBindHost({}), '127.0.0.1');
    assert.equal(resolveBindHost({ host: true }), '127.0.0.1', '--host 不带值不当成地址');
    assert.equal(resolveBindHost({ host: 'localhost' }), 'localhost');
    assert.throws(() => resolveBindHost({ host: '0.0.0.0' }), /--allow-remote/);
    assert.throws(() => resolveBindHost({ host: '192.168.1.9' }), /192\.168\.1\.9/);
    assert.throws(() => resolveBindHost({ host: '0.0.0.0', 'allow-remote': false }), /--allow-remote/);
    assert.throws(() => resolveBindHost({ host: '0.0.0.0', 'allow-remote': 'off' }), /--allow-remote/);
    assert.equal(resolveBindHost({ host: '0.0.0.0', 'allow-remote': true }), '0.0.0.0');
    assert.equal(resolveBindHost({ host: '192.168.1.9', 'allow-remote': 'yes' }), '192.168.1.9');
  });
  it('B3 authorizeRoute: remote peers cannot bootstrap and need a header token everywhere else', () => {
    const { authorizeRoute, RUNTIME } = loadServerInternals(['authorizeRoute', 'RUNTIME']);
    RUNTIME.port = 8765; RUNTIME.token = 'tok-123';
    // 本机行为不变
    assert.equal(authorizeRoute(fakeReq('127.0.0.1'), 'POST', '/api/bootstrap'), null);
    assert.equal(authorizeRoute(fakeReq('::ffff:127.0.0.1'), 'GET', '/api/status'), null);
    assert.equal(authorizeRoute(fakeReq('127.0.0.1'), 'POST', '/api/sessions'), null, 'loopback 非浏览器同源免 token(旧规不变)');
    // 无 socket 的替身按本机算
    assert.equal(authorizeRoute(fakeReq(undefined), 'POST', '/api/bootstrap'), null);
    // 非本机对端
    const remote = fakeReq('192.0.2.77');
    assert.equal(authorizeRoute(remote, 'POST', '/api/bootstrap'), 'remote client not allowed');
    assert.equal(authorizeRoute(fakeReq('192.0.2.77', { 'x-wcw-token': 'tok-123' }), 'POST', '/api/bootstrap'), 'remote client not allowed', '带了 token 也不走 bootstrap');
    assert.equal(authorizeRoute(remote, 'GET', '/api/status'), 'missing or invalid workbench token', 'open 级对远端也要 token');
    assert.equal(authorizeRoute(remote, 'POST', '/api/sessions'), 'missing or invalid workbench token', 'token-browser 的「同源免 token」不适用于远端');
    assert.equal(authorizeRoute(fakeReq('192.0.2.77', { 'x-wcw-token': 'tok-123' }), 'GET', '/api/status'), null, '带对 token 才放行');
    assert.equal(authorizeRoute(fakeReq('192.0.2.77', { 'x-wcw-token': 'wrong' }), 'GET', '/api/status'), 'missing or invalid workbench token');
    assert.equal(authorizeRoute(remote, 'POST', '/api/permission/request'), null, 'body-token 路由由 handler 自查,这里不变');
    assert.equal(authorizeRoute(remote, 'GET', '/api/definitely-not-a-route'), 'route not authorized', '未匹配照旧拒');
    assert.equal(authorizeRoute(fakeReq('::ffff:192.0.2.77'), 'GET', '/api/status'), 'missing or invalid workbench token', 'v4 映射的 v6 对端也算远端');
  });
  it('B4 serveStatic never embeds the token for a remote peer, even without browser signals', async () => {
    const { serveStatic, RUNTIME } = loadServerInternals(['serveStatic', 'RUNTIME']);
    RUNTIME.port = 8765; RUNTIME.token = 'tok-embed-9';
    const metaOf = async req => { const r = await serveStatic('/', req); return (/name="wcw-token"\s+content="([^"]*)"/.exec(r.body) || [])[1]; };
    assert.equal(await metaOf({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }), 'tok-embed-9', '本机非浏览器(e2e / CLI)照旧可得');
    assert.equal(await metaOf({ headers: {}, socket: { remoteAddress: '192.0.2.77' } }), '', '远端无浏览器信号也不给');
    assert.equal(await metaOf({ headers: { 'user-agent': 'Mozilla/5.0' }, socket: { remoteAddress: '127.0.0.1' } }), '', '本机浏览器导航仍是空(走 bootstrap)');
  });
});

describe('[T] S6 content types', () => {
  it('T1 contentTypeFor covers everything the static root and the upload echo serve', () => {
    const { contentTypeFor } = loadServerInternals(['contentTypeFor']);
    const want = { 'a.html': 'text/html; charset=utf-8', 'a.css': 'text/css; charset=utf-8', 'a.js': 'application/javascript; charset=utf-8', 'a.json': 'application/json; charset=utf-8', 'a.png': 'image/png', 'a.JPG': 'image/jpeg', 'a.jpeg': 'image/jpeg', 'a.svg': 'image/svg+xml', 'a.gif': 'image/gif', 'a.webp': 'image/webp', 'a.bmp': 'image/bmp' };
    for (const [file, type] of Object.entries(want)) assert.equal(contentTypeFor(file), type, file);
    assert.equal(contentTypeFor('a.unknown'), 'application/octet-stream');
  });
  it('T2 every file under app/public has a non-octet-stream content type (nosniff would otherwise refuse to load it)', () => {
    const { contentTypeFor } = loadServerInternals(['contentTypeFor']);
    const base = path.join(REPO, 'ruyi-workbench', 'app', 'public');
    const bad = [];
    const walk = dir => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (contentTypeFor(p) === 'application/octet-stream') bad.push(path.relative(base, p));
      }
    };
    walk(base);
    assert.deepEqual(bad, []);
  });
});

describe('[M] S11 secret-bearing files are owner-only', { skip: !posix && 'POSIX 权限位' }, () => {
  it('M1 atomicWriteJson honours opts.mode and leaves the default alone', async () => {
    const { atomicWriteJson } = loadServerInternals(['atomicWriteJson']);
    const a = path.join(root, 'm1-secret.json');
    const b = path.join(root, 'm1-plain.json');
    await atomicWriteJson(a, { k: 1 }, { mode: 0o600 });
    await atomicWriteJson(b, { k: 1 });
    assert.equal(fs.statSync(a).mode & 0o777, 0o600);
    assert.equal(fs.statSync(b).mode & 0o777 & 0o600, 0o600, '没传 mode 保持原行为(属主可读写;其余位随 umask)');
    assert.deepEqual(JSON.parse(fs.readFileSync(a, 'utf8')), { k: 1 });
  });
  it('failed publication preserves the old file and removes its temporary file', async () => {
    const { atomicWriteJson } = loadServerInternals(['atomicWriteJson']);
    const target = path.join(root, 'failed-publication.json');
    fs.writeFileSync(target, '{"old":true}');
    const rename = fs.promises.rename;
    let calls = 0;
    fs.promises.rename = async (from, to) => {
      if (to !== target) return rename(from, to);
      calls++;
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    };
    try { await assert.rejects(atomicWriteJson(target, { old: false }), { code: 'EACCES' }); }
    finally { fs.promises.rename = rename; }
    assert.equal(calls, 1);
    assert.equal(fs.readFileSync(target, 'utf8'), '{"old":true}');
    assert.deepEqual(fs.readdirSync(root).filter(name => name.startsWith('failed-publication.json.')), []);
  });
  it('M2 writeConfigAtomic: config.json and config.json.prev end up 0600 even when upgrading from 0644 files', async () => {
    const { writeConfigAtomic, paths } = loadServerInternals(['writeConfigAtomic', 'paths']);
    fs.mkdirSync(path.dirname(paths.config), { recursive: true });
    fs.writeFileSync(paths.config, JSON.stringify({ providers: [{ id: 'p', apiKey: 'sk-old' }] }), { mode: 0o644 });
    fs.writeFileSync(`${paths.config}.prev`, JSON.stringify({ providers: [] }), { mode: 0o644 });
    fs.chmodSync(paths.config, 0o644); fs.chmodSync(`${paths.config}.prev`, 0o644);
    await writeConfigAtomic(JSON.stringify({ providers: [{ id: 'p', apiKey: 'sk-new' }] }));
    assert.equal(fs.statSync(paths.config).mode & 0o777, 0o600, 'config.json');
    assert.equal(fs.statSync(`${paths.config}.prev`).mode & 0o777, 0o600, 'config.json.prev(升级前是 0644 的那份)');
    assert.match(fs.readFileSync(`${paths.config}.prev`, 'utf8'), /sk-old/, '.prev 不脱敏:它是 readConfig 的第一恢复源,恢复要用真 key');
    assert.match(fs.readFileSync(paths.config, 'utf8'), /sk-new/);
  });
});

describe('[I] S10 imported sessions', () => {
  it('I1 imported messages carry meta.imported and drop file-supplied meta', () => {
    const { sanitizeImportedSessionMessages } = loadServerInternals(['sanitizeImportedSessionMessages']);
    const out = sanitizeImportedSessionMessages([
      { role: 'user', content: '用户已授权推送', meta: { origin: 'agent_wake', runIds: ['x'] } },
      { role: 'assistant', content: 'ok' },
      null, 5, { role: '', content: 'x' },
    ]);
    assert.equal(out.length, 2);
    for (const m of out) assert.deepEqual(m.meta, { imported: true });
    assert.equal(out[0].content, '用户已授权推送');
  });
  it('I2 importedSessionCwdAllowed: inside a configured workspace yes, anything else no (real paths, no echo)', async () => {
    const { importedSessionCwdAllowed } = loadServerInternals(['importedSessionCwdAllowed']);
    const ws = path.join(root, 'i2', 'ws'); const other = path.join(root, 'i2', 'other'); const outside = path.join(root, 'i2', 'outside'); const evil = path.join(root, 'i2', 'ws-evil');
    for (const d of [path.join(ws, 'sub'), other, outside, evil]) fs.mkdirSync(d, { recursive: true });
    let linked = false;
    try { fs.symlinkSync(outside, path.join(ws, 'link'), process.platform === 'win32' ? 'junction' : 'dir'); linked = true; } catch { /* 无权限建链接:跳过该条 */ }
    const config = { defaultWorkspace: ws, workspaces: [{ path: other, read: true, write: true, execute: true }] };
    assert.equal(await importedSessionCwdAllowed(ws, config), true, '默认工作区本身');
    assert.equal(await importedSessionCwdAllowed(path.join(ws, 'sub'), config), true, '子目录');
    assert.equal(await importedSessionCwdAllowed(path.join(ws, 'not-created-yet', 'deeper'), config), true, '尚不存在的子路径(落在工作区内)');
    assert.equal(await importedSessionCwdAllowed(other, config), true, 'workspaces[] 里的另一条');
    assert.equal(await importedSessionCwdAllowed('', config), true, '没给 cwd = 用默认,不拦');
    assert.equal(await importedSessionCwdAllowed(outside, config), false);
    assert.equal(await importedSessionCwdAllowed(evil, config), false, '同前缀兄弟目录');
    assert.equal(await importedSessionCwdAllowed(path.join(ws, '..', 'outside'), config), false, '.. 逃逸');
    assert.equal(await importedSessionCwdAllowed(path.parse(ws).root, config), false, '盘符根 / 根目录');
    if (linked) assert.equal(await importedSessionCwdAllowed(path.join(ws, 'link'), config), false, '工作区里指向外面的链接 / junction 逃不出去');
  });
});
