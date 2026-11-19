'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { json, readJsonBody, send } = require('./http-protocol.cjs');

function createWorkspaceRoutes({
  readConfig, resolveWorkspace, DesktopShell,
}) {
  async function handleWorkspaceApiRoutes(req, res, pathname) {
    // ── v0.9-S3 (C3) Workspace-by-fingerprint + native folder picker ────────────────────────────────────
    // POST /api/workspace/resolve {name, children[]} — locate the dropped folder's real absolute path by
    // fingerprint (basename + first-level child names). Token-gated (whitelisted above). Never throws.
    if (req.method === 'POST' && pathname === '/api/workspace/resolve') {
      const body = await readJsonBody(req);
      const config = await readConfig();
      try {
        const r = await resolveWorkspace({ name: body && body.name, children: body && body.children, selectedPath: body && body.selectedPath }, config);
        return send(res, json(r));
      } catch (e) {
        return send(res, json({ ok: false, error: String(e && e.message || e), matches: [] }));
      }
    }
    // POST /api/pick-folder {title?, initialDir?} — native Mac folder picker.
    if (req.method === 'POST' && pathname === '/api/pick-folder') {
      const body = await readJsonBody(req);
      return send(res, json(await DesktopShell.pickFolder({ title: body && body.title, initialDir: body && body.initialDir })));
    }
    // 体验走查 #7: POST /api/workspace/dedicated —— 默认工作文件夹是整个用户目录(读/写/执行全开)时,向导给一枚
    // 「用一个专用文件夹」:建(已有就复用)「文档\如意工作区」(没有「文档」就放在用户目录下)并回它的路径。
    // 只建这一个固定名字的目录,不收任何路径参数;设成默认工作区仍走前端既有的 setWorkspace(带护栏)。
    if (req.method === 'POST' && pathname === '/api/workspace/dedicated') {
      const docs = path.join(os.homedir(), 'Documents');
      const dir = path.join(fs.existsSync(docs) ? docs : os.homedir(), '如意工作区');
      try { await fsp.mkdir(dir, { recursive: true }); } catch (e) { return send(res, json({ ok: false, error: String(e && e.message || e) }, 500)); }
      return send(res, json({ ok: true, path: dir }));
    }
    // POST /api/pick-file — native Mac file picker.
    if (req.method === 'POST' && pathname === '/api/pick-file') {
      const body = await readJsonBody(req);
      return send(res, json(await DesktopShell.pickFile(body && body.filter)));
    }
  }

  return handleWorkspaceApiRoutes;
}

module.exports = { createWorkspaceRoutes };
