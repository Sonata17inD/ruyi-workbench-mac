'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { apiFailure, json, send, readJsonBody } = require('./http-protocol.cjs');
const { createLocalSupport } = require('./local-support.cjs');
const { pathWithinAnyRoot } = require('./path-containment.cjs');
const { readFilePreview } = require('./file-preview.cjs');

function createLocalSupportRoutes({
  externalRoot, manualsDirectory, paths, tokenOk, safeSessionId, readConfig, loadSession,
  DesktopShell, logEvent, fileAllowedRoots, remoteUncDenialResolved, ensureDataRootReal, isSensitiveDataPath,
  isSensitiveHardlinkAlias, guardWorkspacePath, buildRevealSpawn, process = globalThis.process,
}) {
  const { HELP_DOC_FILES, HELP_DOC_LANGS, HELP_DOC_MAX_BYTES, helpDocsDir, helpDocTitle, OPEN_PATH_TARGETS,
    LOG_TAIL_MAX_LINES, LOG_TAIL_DEFAULT_LINES, LOG_TAIL_MAX_BYTES, openPathTargetDir, latestLogFile, tailLinesFromBuffer } =
    createLocalSupport({ externalRoot, manualsDirectory, paths });

  async function handleLocalSupportApiRoutes(req, res, pathname) {
    // 118a-fix: 应用内手册阅读器的取文端点。GET /api/help/doc?id=<docId>&lang=<zh-CN|en-US>
    // 只吐 markdown 原文,渲染在前端走既有 marked + sanitizeNode 白名单管线(help-viewer.js)。
    // 鉴权:ROUTE_AUTH 记 token 级(同 /api/file/preview),这里再自查一遍(GET 不过上面的变更类鉴权块)。
    // 第二道闸不是路径包含校验而是【查表】:id 与 lang 都只能命中 HELP_DOC_FILES 里写死的键,命不中即 404;
    // 真正拼进 path.join 的只有常量文件名,请求里的任何字符串都到不了文件系统,穿越面为零。
    // 降级:Slim 包可能不带 docs/ -> 200 {ok:false,error:'help.doc_missing'},前端在应用内解释,
    // 绝不回退成「自己去某个路径打开文件」。
    if (req.method === 'GET' && pathname === '/api/help/doc') {
      if (!tokenOk(req)) return send(res, apiFailure('auth.token_invalid', {}, 'missing or invalid workbench token', 403));
      const q = new URL(req.url, 'http://x').searchParams;
      const id = String(q.get('id') || '');
      const variants = Object.prototype.hasOwnProperty.call(HELP_DOC_FILES, id) ? HELP_DOC_FILES[id] : null;
      if (!variants) return send(res, apiFailure('help.doc_unknown', {}, 'unknown help document id', 404));
      let lang = String(q.get('lang') || '');
      if (!HELP_DOC_LANGS.includes(lang)) {
        // 没显式指定语言就跟随配置;config.locale 可能是 'auto' 或非法值,一律回落中文。
        const config = await readConfig().catch(() => null);
        const configured = config ? String(config.locale || '') : '';
        lang = HELP_DOC_LANGS.includes(configured) ? configured : 'zh-CN';
      }
      const fileName = variants[lang];
      const target = path.join(helpDocsDir(), fileName); // fileName 来自白名单常量,不是请求数据
      let raw = null;
      try { raw = await fsp.readFile(target); } catch { raw = null; }
      if (!raw) return send(res, json({ ok: false, error: 'help.doc_missing', id, lang }));
      const truncated = raw.length > HELP_DOC_MAX_BYTES;
      let markdown = (truncated ? raw.subarray(0, HELP_DOC_MAX_BYTES) : raw).toString('utf8');
      // 截断按整行收口:按字节切可能把一个多字节字符劈开,丢掉尾行比留半个字符干净。
      if (truncated) markdown = markdown.slice(0, Math.max(0, markdown.lastIndexOf('\n')));
      const available = HELP_DOC_LANGS.filter(l => variants[l]);
      return send(res, json({ ok: true, id, lang, available, title: helpDocTitle(markdown, fileName),
        markdown, bytes: raw.length, truncated }));
    }
    // 118d: POST /api/open-path {target}. 帮助菜单的「打开数据目录 / 日志目录 / 工作文件夹 / 手册目录」。
    // 鉴权:ROUTE_AUTH 记 token 级(同 /api/file/reveal),这里再自查一遍作纵深。
    // 校验:target 必须命中 OPEN_PATH_TARGETS 这张源码枚举 -- 客户端【不能传路径】,所以既没有穿越面,
    // 也没有「target:'data;calc'」这类注入面(枚举外的值在拼路径之前就 400 掉了)。
    if (req.method === 'POST' && pathname === '/api/open-path') {
      if (!tokenOk(req)) return send(res, apiFailure('auth.token_invalid', {}, 'missing or invalid workbench token', 403));
      const body = await readJsonBody(req).catch(() => ({}));
      const target = typeof (body && body.target) === 'string' ? body.target : '';
      if (!OPEN_PATH_TARGETS.includes(target)) {
        return send(res, apiFailure('openPath.target_unknown', {}, '只能打开如意自己的几个固定位置,不接受任意路径', 400));
      }
      if (process.platform !== 'darwin') return send(res, json({ ok: false, error: '仅支持 macOS' }));
      const sessionId = safeSessionId(body && body.sessionId);
      const session = sessionId ? await loadSession(sessionId) : null;
      const dir = openPathTargetDir(target, session);
      if (!dir) {
        // 只可能是 workspace:当前会话还没有工作文件夹。给人话,不给路径。
        return send(res, apiFailure('openPath.workspace_missing', {}, '这个会话还没有选工作文件夹,先在上方选一个再打开', 400));
      }
      const realDirectory = await fsp.realpath(dir).catch(() => null);
      const directoryStat = realDirectory ? await fsp.stat(realDirectory).catch(() => null) : null;
      if (!directoryStat || !directoryStat.isDirectory()) {
        return send(res, apiFailure('openPath.missing', { target }, '这个位置不存在或不是文件夹，请选择有效的工作文件夹', 404));
      }
      const started = await DesktopShell.revealInFinder(realDirectory, 'open');
      if (!started) return send(res, json({ ok: false, error: '无法打开文件管理器，请检查系统默认打开程序' }));
      logEvent({ kind: 'open_path', target, pathLen: dir.length });
      return send(res, json({ ok: true, target }));
    }
    // 118d: GET /api/logs/tail?lines=N. 应用内看日志(等宽只读面板 + 「复制全部」发给支持人员)。
    // 鉴权:ROUTE_AUTH 记 token 级;GET 不过变更类鉴权块,这里必须自查(与 /api/audit 同一纪律)。
    // 只读服务端自己的日志:文件名由 latestLogFile() 在已知目录里按固定正则挑,请求里只有一个数字 lines,
    // 上限 LOG_TAIL_MAX_LINES;没有日志文件时 200 降级(前端在应用内解释),不 500 也不回退成给路径。
    if (req.method === 'GET' && pathname === '/api/logs/tail') {
      if (!tokenOk(req)) return send(res, apiFailure('auth.token_invalid', {}, 'missing or invalid workbench token', 403));
      const q = new URL(req.url, 'http://x').searchParams;
      const asked = Number.parseInt(q.get('lines') || '', 10);
      const wanted = Number.isFinite(asked) ? Math.min(Math.max(asked, 1), LOG_TAIL_MAX_LINES) : LOG_TAIL_DEFAULT_LINES;
      const file = latestLogFile();
      if (!file) return send(res, json({ ok: false, error: 'logs.none', maxLines: LOG_TAIL_MAX_LINES }));
      let handle = null;
      try {
        const st = await fsp.stat(file);
        const size = Math.min(st.size, LOG_TAIL_MAX_BYTES);
        const start = Math.max(0, st.size - size);
        const buf = Buffer.alloc(size);
        handle = await fsp.open(file, 'r');
        if (size > 0) await handle.read(buf, 0, size, start);
        const { lines, more } = tailLinesFromBuffer(buf, start > 0, wanted);
        // 只回文件名不回目录:面板抬头要能说清这是哪一天的日志,但界面上不出现任何可以「照着去找」的路径。
        return send(res, json({ ok: true, file: path.basename(file), lines, count: lines.length,
          requested: wanted, maxLines: LOG_TAIL_MAX_LINES, more }));
      } catch (e) {
        // 只回一个机器码,【不回 e.message】:Node 的 ENOENT/EPERM 文本里带着日志文件的绝对路径,
        // 回给前端就等于又把路径印到界面上了(本波要消灭的正是这类出口)。原因进结构化日志。
        logEvent({ kind: 'logs_tail_failed', error: String(e && e.message || e) });
        return send(res, json({ ok: false, error: 'logs.read_failed', maxLines: LOG_TAIL_MAX_LINES }));
      } finally {
        if (handle) await handle.close().catch(() => {});
      }
    }
    // v0.9-S4 (C4): local file PREVIEW. GET /api/file/preview?path=&sessionId= — returns file content for the
    // 「产物」gallery + file tree. Token-gated (needsToken whitelist above) AND re-checked here (GETs never run
    // through the mutating auth block). SECOND闸: `path` must be absolute and resolve INSIDE one of the session's
    // allowed roots (cwd ∪ defaultWorkspace ∪ recentWorkspaces ∪ dataRoot) — else 403. This prevents a
    // token-holding page from reading arbitrary files (C:\Windows\win.ini etc.). See fileAllowedRoots.
    if (req.method === 'GET' && pathname === '/api/file/preview') {
      if (!tokenOk(req)) return send(res, apiFailure('auth.token_invalid', {}, 'missing or invalid workbench token', 403));
      const q = new URL(req.url, 'http://x').searchParams;
      const rawPath = q.get('path') || '';
      if (!rawPath) return send(res, apiFailure('file.path_required', {}, 'path is required', 400));
      if (!path.isAbsolute(rawPath)) return send(res, apiFailure('file.path_not_absolute', {}, 'path must be absolute', 400));
      const target = path.resolve(rawPath);
      const sessionId = safeSessionId(q.get('sessionId')); // may be null (session-less preview still allowed if in a global root)
      const session = sessionId ? await loadSession(sessionId) : null;
      const config = await readConfig();
      const roots = fileAllowedRoots(session, config);
      // 安全走查 W1:非本机 UNC 在 realpath(会去连对方主机)之前拒,除非落在用户配置的 UNC 工作区里。
      if (await remoteUncDenialResolved([rawPath, target], session, config)) return send(res, apiFailure('file.not_in_workspace', {}, 'path not in an allowed workspace', 403));
      // v0.9 F3: check the REALPATH (symlink-resolved) target, not the lexical path. A symlink living inside an
      // allowed root but pointing OUTSIDE it would otherwise pass the lexical containment check and leak an
      // arbitrary file. ENOENT/EPERM (missing/unresolvable) → fall back to `target` so readFilePreview surfaces a
      // normal "not found". Resolve the roots too so a root that is itself a symlink still matches.
      const real = await fsp.realpath(target).catch(() => target);
      // 审计 P1(对抗轮补漏): preview 端点原来只做 fileAllowedRoots+realpath 包含校验,不查敏感表 —— 「file_read
      // runtime.json 拿 token → 用 token 打 preview 读 config.json」的链由此成立。这里与文件工具同源拒绝敏感控制面文件。
      await ensureDataRootReal();
      if (isSensitiveDataPath(target) || isSensitiveDataPath(real)) {
        return send(res, json({ ok: false, error: '该路径属于应用内部数据(配置/会话/记忆等),已禁止预览' }, 403));
      }
      if (await isSensitiveHardlinkAlias(real)) {   // 安全走查 S7:config.json / runtime.json 的硬链接别名
        return send(res, apiFailure('file.internal_data', {}, '该路径属于应用内部数据(配置/会话/记忆等),已禁止预览', 403));
      }
      const realRoots = await Promise.all(roots.map(r => fsp.realpath(r).catch(() => r)));
      if (!pathWithinAnyRoot(real, realRoots)) {
        // 防任意文件读取:第二道闸(GET-token 之外)。不在任何允许根下 → 403。
        return send(res, json({ ok: false, error: 'path not in an allowed workspace' }, 403));
      }
      try {
        return send(res, json(await readFilePreview(target)));
      } catch (e) {
        return send(res, json({ ok: false, error: String(e && e.message || e) }, 500));
      }
    }
    // v1.0.2-S3: 在资源管理器中打开/定位文件。POST /api/file/reveal {sessionId, path, mode:'open'|'select'}.
    // 先验证真实路径位于允许的根内，再由 Finder 前台助手打开或定位。
    if (req.method === 'POST' && pathname === '/api/file/reveal') {
      if (process.platform !== 'darwin') return send(res, json({ ok: false, error: '仅支持 macOS' }));
      const body = await readJsonBody(req);
      const mode = (body && body.mode === 'select') ? 'select' : 'open';
      const rawPath = body && typeof body.path === 'string' ? body.path : '';
      const sessionId = safeSessionId(body && body.sessionId);
      const session = sessionId ? await loadSession(sessionId) : null;
      const config = await readConfig();
      const guard = await guardWorkspacePath(rawPath, session, config);
      if (!guard.ok) return send(res, json({ ok: false, error: guard.error }, guard.code === 'bad-path' ? 400 : 403));
      // 文件必须存在(realpath 已解析符号链接;此处确认目标本身在盘上)。
      let stat = null;
      try { stat = await fsp.stat(guard.absPath); } catch { /* missing */ }
      if (!stat) return send(res, json({ ok: false, error: '文件不存在' }, 404));
      // buildRevealSpawn 仍是「模式决策」的权威:决定 open vs select + 对可执行/脚本扩展名把 open 降级为 select。
      // 通过前台 Finder 助手执行。
      const spawnSpec = buildRevealSpawn(mode, guard.absPath);
      const okStarted = await DesktopShell.revealInFinder(guard.absPath, spawnSpec.mode);
      if (!okStarted) return send(res, json({ ok: false, error: '无法打开文件管理器，请检查系统默认打开程序' }));
      logEvent({ kind: 'file_reveal', sessionId: sessionId || '', mode: spawnSpec.mode, degraded: !!spawnSpec.degraded, pathLen: guard.absPath.length });
      // 把关加固:可执行/脚本类「打开」被降级为「定位」时明确告知前端(前端可提示用户)。
      return send(res, json(spawnSpec.degraded
        ? { ok: true, degradedTo: 'select', note: '出于安全考虑,可执行/脚本文件不会直接打开,已改为在资源管理器中定位。' }
        : { ok: true }));
    }
  }

  return handleLocalSupportApiRoutes;
}

module.exports = { createLocalSupportRoutes };
