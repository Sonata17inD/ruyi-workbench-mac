'use strict';
const fsp = require('node:fs/promises');
const path = require('node:path');

function createStewardWorkspaceOverview({ sessions, workspaces }) {
  const { listSessions, readMissionContainer, sessionDisplayTitle, sessionMetaIsSteward } = sessions;
  const {
    STEWARD_KNOWN_WORKSPACE_LIMITS, STEWARD_WORKSPACE_TABLE_MAX, redact, stewardCanonWorkspacePath,
    stewardKnownWorkspaces, stewardSanitizeText,
  } = workspaces;

  async function stewardKnownWorkspaceRows(config) {
    const known = stewardKnownWorkspaces(config);
    if (!known.length) return [];
    const metas = await listSessions().catch(() => []);
    const byPath = new Map(known.map(row => [row.path, { ...row, threads: [], lastActive: '' }]));
    for (const meta of (Array.isArray(metas) ? metas : [])) {
      if (!meta || sessionMetaIsSteward(meta)) continue;
      let directory = stewardCanonWorkspacePath(meta.cwd);
      while (directory) {
        const owner = byPath.get(directory);
        if (owner) {
          owner.threads.push(meta);
          break;
        }
        const parent = path.dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
    }
    const missionTitles = new Map();
    const missionTitleOf = async (missionId, sessionId) => {
      if (!missionId || missionId === sessionId) return '';     // 未归类事项的标题就是线程标题,不重复说
      if (!missionTitles.has(missionId)) {
        const container = await readMissionContainer(missionId).catch(() => null);
        missionTitles.set(missionId, container ? String(container.title || '') : '');
      }
      return missionTitles.get(missionId);
    };
    const rows = [];
    for (const row of byPath.values()) {
      row.threads.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
      row.lastActive = row.threads.length ? String(row.threads[0].updatedAt || '') : '';
      if (row.owned && !row.threads.length) {
        const alive = await fsp.stat(row.path).then(stat => stat.isDirectory(), () => false);
        if (!alive) continue;
      }
      const shown = [];
      for (const meta of row.threads.slice(0, STEWARD_KNOWN_WORKSPACE_LIMITS.threadsPerRow)) {
        shown.push({ title: sessionDisplayTitle(meta) || meta.title || '', missionTitle: await missionTitleOf(meta.missionId, meta.id), recentUserRequest: meta.recentUserRequest, summary: meta.summary || '' });
      }
      rows.push({ label: row.label, isDefault: row.isDefault, write: row.write, note: row.note, owned: row.owned, user: row.user, lastActive: row.lastActive, threads: shown });
    }
    const tail = row => (row.user ? 0 : 1);
    rows.sort((a, b) => (Number(b.isDefault) - Number(a.isDefault))
      || (Number(Boolean(b.lastActive)) - Number(Boolean(a.lastActive)))
      || String(b.lastActive).localeCompare(String(a.lastActive))
      || (tail(a) - tail(b)));
    return rows;
  }

  function stewardWorkspaceTableBlock(stewardWorkspaceRows, pack) {
    const rows = Array.isArray(stewardWorkspaceRows) ? stewardWorkspaceRows : [];
    const limits = STEWARD_KNOWN_WORKSPACE_LIMITS;
    const clip = (value, max) => {
      const s = stewardSanitizeText(String(value == null ? '' : value), true).trim();
      return s.length > max ? s.slice(0, max - 1) + '…' : s;
    };
    const lines = [];
    let used = 0;
    let folded = 0;
    for (const row of rows) {
      const name = stewardSanitizeText(String((row && row.label) || ''), true).trim();
      if (!name) continue;
      if (lines.length >= STEWARD_WORKSPACE_TABLE_MAX) { folded += 1; continue; }
      const tags = [];
      if (row.isDefault === true) tags.push(pack.steward.workspaceTagDefault);
      if (row.write === false) tags.push(pack.steward.workspaceTagReadOnly);
      if (row.owned === true) tags.push(pack.steward.workspaceTagMine);
      const note = clip(row.note, 40);
      if (note) tags.push(note);
      const threads = (Array.isArray(row.threads) ? row.threads : [])
        .slice(0, limits.threadsPerRow)
        .map(t => pack.steward.workspaceThread({ title: clip(t && t.title, limits.threadTitleChars), missionTitle: clip(t && t.missionTitle, limits.threadTitleChars) }) + (t && t.recentUserRequest ? ' ' + pack.steward.activityRequest + clip(redact(t.recentUserRequest.text), 48) : '') + (t && t.summary ? ' ' + pack.steward.activityReply + clip(t.summary, 36) : ''))
        .filter(Boolean);
      // 一行太长就先少带几条线程(话题砍整条,不砍半句);连一条都不带还超,才截名字之外的尾巴。
      let line = pack.steward.workspaceRow({ name, tags, threads });
      while (line.length > limits.lineChars && threads.length) { threads.pop(); line = pack.steward.workspaceRow({ name, tags, threads }); }
      if (line.length > limits.lineChars) line = line.slice(0, limits.lineChars - 1) + '…';
      if (used + line.length + 1 > limits.totalChars) { folded += 1; continue; }
      lines.push(line);
      used += line.length + 1;
    }
    const out = [pack.steward.workspaceHeader, ...(lines.length ? lines : [pack.steward.workspaceEmpty])];
    if (folded > 0) out.push(pack.steward.workspaceFolded({ workspaces: folded }));
    out.push(pack.steward.workspaceMore);
    return out.join('\n');
  }

  return { stewardKnownWorkspaceRows, stewardWorkspaceTableBlock };
}

module.exports = { createStewardWorkspaceOverview };
