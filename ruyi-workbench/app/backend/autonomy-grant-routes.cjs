'use strict';

const { apiSessionIdInvalid, apiSessionNotFound, json, readJsonBody, send } = require('./http-protocol.cjs');

function createAutonomyGrantRoutes({
  tokenOk, safeSessionId, loadSession, activeChildren, readConfig, logEvent, activeDriverRunOf,
  grants: { listGrantsView, normalizeGrant, dryRunGrantFiles, installGrant, revokeAllGrants, revokeGrant },
}) {
  async function handleAutonomyGrantApiRoutes(req, res, pathname) {
    // ── 第27波:自主性授权书 API。全部 header-token 白名单路由(需 needsToken 命中 + 此处再自查 tokenOk,【绝不】带
    //    body-token 兜底 —— R-P2-2 签发主权律:被注入的模型经 MCP 子进程 loopback 拿的是 body-token,永无签发/撤销能力)。──
    if (pathname === '/api/autonomy/grants') {
      if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
      const q = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
      const sessionId = safeSessionId(q.sessionId);
      if (!sessionId) return send(res, apiSessionIdInvalid());
      return send(res, json({ ok: true, grants: listGrantsView(sessionId), activeRun: activeDriverRunOf(sessionId) }));
    }
    if (req.method === 'POST' && pathname === '/api/autonomy/grant') {
      if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
      const body = await readJsonBody(req);
      const sessionId = safeSessionId(body.sessionId);
      if (!sessionId) return send(res, apiSessionIdInvalid());
      const session = await loadSession(sessionId);
      if (!session) return send(res, apiSessionNotFound());
      const config = await readConfig();
      const norm = normalizeGrant(body, session, config, Date.now());
      if (!norm.ok) return send(res, json({ ok: false, error: norm.error }, 400));
      const g = norm.grant;
      // dry-run:签发瞬间 glob 一次,展示将命中的工作区内文件(所见即所授闭环)。边界内、有限步、best-effort。
      let dryRun = { count: 0, sample: [], truncated: false };
      if (g.tier === 'read' || g.tier === 'edit') {
        try { dryRun = await dryRunGrantFiles(g, 40); } catch { /* best-effort */ }
      }
      // preview 模式:只 normalize + dry-run,【不】入 Map、不发审计/SSE —— 供 UI「预览命中」无副作用。
      if (body.preview === true) {
        return send(res, json({ ok: true, preview: true, grant: { tool: g.tool, tier: g.tier, scope: g.scope, pathGlob: g.pathGlob, cmdAllow: g.cmdAllow, netAllowed: g.netAllowed, maxUses: g.maxUses }, dropped: norm.dropped, dryRun }));
      }
      installGrant(sessionId, g);
      logEvent({ kind: 'autonomy_grant_issued', grantId: g.grantId, sessionId, tool: g.tool, tier: g.tier, scope: g.scope, pathGlob: g.pathGlob, cmdAllow: g.cmdAllow, netAllowed: g.netAllowed, maxUses: g.maxUses, ttlMs: g.ttlMs });
      const reg = activeChildren.get(sessionId);
      if (reg && reg.onEvent) { try { reg.onEvent({ type: 'autonomy_grant', grants: listGrantsView(sessionId) }); } catch { /* stream gone */ } }
      return send(res, json({ ok: true, grant: listGrantsView(sessionId).find(x => x.grantId === g.grantId) || null, dropped: norm.dropped, dryRun }));
    }
    if (req.method === 'POST' && pathname === '/api/autonomy/revoke') {
      if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
      const body = await readJsonBody(req);
      const sessionId = safeSessionId(body.sessionId);
      if (!sessionId) return send(res, apiSessionIdInvalid());
      let n = 0;
      if (body.all === true) n = revokeAllGrants(sessionId, 'ui-revoke-all');
      else if (body.grantId) n = revokeGrant(sessionId, String(body.grantId)) ? 1 : 0;
      else return send(res, json({ ok: false, error: '需提供 grantId 或 all:true' }, 400));
      const reg = activeChildren.get(sessionId);
      if (reg && reg.onEvent) { try { reg.onEvent({ type: 'autonomy_grant', grants: listGrantsView(sessionId) }); } catch { /* stream gone */ } }
      return send(res, json({ ok: true, revoked: n, grants: listGrantsView(sessionId) }));
    }
  }
  return handleAutonomyGrantApiRoutes;
}

module.exports = { createAutonomyGrantRoutes };
