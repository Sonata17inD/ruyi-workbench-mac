'use strict';

const { json, readJsonBody, send } = require('./http-protocol.cjs');

function createMigrationRoutes({ migration }) {
  // ── W2 迁移中心:/api/migration/scan|apply|undo|recycle(W8 加 skills/copy)──────────────────────────────────────
  // 五条端点都要 token。
  // (01b-route-auth):scan 回的是本机各处配置里的路径与指令文件摘要,apply/undo 会改写外部配置文件,
  // recycle 会把一个目录移进回收站(另要 body.confirm === body.root),skills/copy 往 dataRoot/skills 写技能副本。命中返回 true,否则 false。
  async function handleMigrationApiRoutes(req, res, pathname) {
    const reply = result => {
      const r = result && typeof result === 'object' ? { ...result } : { ok: false, error: 'no-result' };
      const status = Number.isInteger(r.status) ? r.status : (r.ok === false ? 400 : 200);
      delete r.status;
      // 失败一律给稳定码 migration.<原因>(与 apiFailure 同形 {code, params, message}),前端按码分支不按句子。
      if (r.ok === false && typeof r.error === 'string') r.error = { code: 'migration.' + r.error.replace(/-/g, '_'), params: {}, message: r.error };
      send(res, json(r, status));
      return true;
    };
    const hook = name => (typeof migration[name] === 'function' ? migration[name] : null);
    const unavailable = () => reply({ ok: false, error: 'migration center unavailable', status: 503 });
    if (req.method === 'GET' && pathname === '/api/migration/scan') {
      const fn = hook('scan'); if (!fn) return unavailable();
      return reply(await fn());
    }
    if (req.method === 'POST' && pathname === '/api/migration/apply') {
      const fn = hook('apply'); if (!fn) return unavailable();
      return reply(await fn((await readJsonBody(req)) || {}));
    }
    if (req.method === 'POST' && pathname === '/api/migration/undo') {
      const fn = hook('undo'); if (!fn) return unavailable();
      return reply(await fn((await readJsonBody(req)) || {}));
    }
    if (req.method === 'POST' && pathname === '/api/migration/recycle') {
      const fn = hook('recycle'); if (!fn) return unavailable();
      return reply(await fn((await readJsonBody(req)) || {}));
    }
    // W8:外部技能「复制到如意」(整目录拷进 dataRoot/skills/<id>/,附来源记录;撤销走上面的 /undo)。
    if (req.method === 'POST' && pathname === '/api/migration/skills/copy') {
      const fn = hook('copySkills'); if (!fn) return unavailable();
      return reply(await fn((await readJsonBody(req)) || {}));
    }
    return false;
  }

  return handleMigrationApiRoutes;
}

module.exports = { createMigrationRoutes };
