'use strict';

const path = require('node:path');
const { apiSessionIdInvalid, json, readJsonBody, send } = require('./http-protocol.cjs');
const { matchServiceEntry } = require('./playbook-policy.cjs');

function createPlaybookRoutes({
  safeSessionId, readConfig, listPlaybooksWithAvailability, normalizePlaybook,
  saveUserPlaybook, deleteUserPlaybook, playbookReuseSources, draftPlaybookFromSession,
}) {
  async function handlePlaybookApiRoutes(req, res, pathname) {
    // ── v0.9-S2 Playbooks (§7.8 / §4 C2) ──────────────────────────────────────────────────────────────
    // GET: 内置 ∪ 用户 playbook,每项经能力矩阵评 available + unavailableReason(read-only, same-origin only).
    if (req.method === 'GET' && pathname === '/api/playbooks') {
      const config = await readConfig();
      const playbooks = await listPlaybooksWithAvailability(config);
      return send(res, json({ ok: true, playbooks }));
    }
    // 127-A-S02(41 号文 §5.9):自然语言 → 服务入口匹配。read-only 计算(评既有清单,零持久化),
    // 鉴权在 ROUTE_AUTH 按 token-browser 档(与 GET 同);匹配逻辑与引导上限全在 06 的 matchServiceEntry。
    if (req.method === 'POST' && pathname === '/api/playbooks/service-match') {
      const body = await readJsonBody(req);
      const config = await readConfig();
      const playbooks = await listPlaybooksWithAvailability(config);
      return send(res, json({ ok: true, match: matchServiceEntry(body && body.query, playbooks) }));
    }
    // POST /api/playbooks/draft {sessionId} — 让当前引擎从会话起草一个 playbook 草稿(token-gated above).
    // Must come BEFORE the generic POST /api/playbooks handler so the /draft suffix isn't swallowed.
    if (req.method === 'POST' && pathname === '/api/playbooks/draft') {
      const body = await readJsonBody(req);
      const sessionId = safeSessionId(body && body.sessionId);
      if (!sessionId) return send(res, apiSessionIdInvalid());
      return send(res, json(body.mode === 'sources' ? await playbookReuseSources(sessionId) : await draftPlaybookFromSession(sessionId, { selection: body.selection })));
    }
    // POST /api/playbooks — save a user playbook (normalized; token-gated). Body = the playbook object.
    if (req.method === 'POST' && pathname === '/api/playbooks') {
      const body = await readJsonBody(req);
      const pb = normalizePlaybook(body && body.playbook ? body.playbook : body);
      if (!pb) return send(res, json({ ok: false, error: '无效的 playbook(缺 id/title/promptTemplate)' }, 400));
      const saved = await saveUserPlaybook(pb);
      return send(res, json({ ok: true, playbook: saved }));
    }
    // DELETE user playbook via POST /api/playbooks/<id> + x-http-method:DELETE (sessions convention).
    // Built-in ids (no user override file) → 403. A user override CAN be deleted (reverts to built-in).
    if (pathname.startsWith('/api/playbooks/') && (req.method === 'DELETE' || (req.method === 'POST' && req.headers['x-http-method'] === 'DELETE'))) {
      const id = path.basename(pathname); // guards traversal
      const r = await deleteUserPlaybook(id);
      if (r.ok) return send(res, json(r));
      return send(res, json(r, r.builtin ? 403 : 404));
    }
  }
  return handlePlaybookApiRoutes;
}

module.exports = { createPlaybookRoutes };
