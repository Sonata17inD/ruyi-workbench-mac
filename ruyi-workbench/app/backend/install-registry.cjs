'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { safeJsonParse } = require('./ordinary-json.cjs');

function createInstallRegistry({ paths, externalRoot, samePathKey, nowIso, version, atomicWriteJson }) {
  // 安装登记表 <data>/install-registry.json:每个启动过的包一行
  //   { packageRoot, version, launchMode, firstSeenAt, lastLaunchedAt, pid }
  // 所有包共用同一个数据根(dataRoot()),所以「本机都有哪些包启动过」只能记在这里。只记账、不做决定。
  const INSTALL_REGISTRY_SCHEMA = 1;
  const INSTALL_REGISTRY_MAX = 64;
  const registryPath = () => path.join(paths.data, 'install-registry.json');

  function writeInstallRegistry(packages, updatedAt = nowIso()) {
    return atomicWriteJson(registryPath(), { schema: INSTALL_REGISTRY_SCHEMA, updatedAt, packages });
  }
  function readInstallRegistry() {
    try {
      const raw = safeJsonParse(fs.readFileSync(registryPath(), 'utf8'), null);
      const rows = raw && Array.isArray(raw.packages) ? raw.packages : [];
      const packages = [];
      const seen = new Set();
      for (const r of rows) {
        if (!r || typeof r.packageRoot !== 'string' || !path.isAbsolute(r.packageRoot)) continue;
        const key = samePathKey(r.packageRoot);
        if (seen.has(key)) continue;
        seen.add(key);
        packages.push({
          packageRoot: path.resolve(r.packageRoot),
          version: typeof r.version === 'string' ? r.version.slice(0, 40) : '',
          launchMode: typeof r.launchMode === 'string' ? r.launchMode.slice(0, 16) : '',
          firstSeenAt: typeof r.firstSeenAt === 'string' ? r.firstSeenAt.slice(0, 40) : '',
          lastLaunchedAt: typeof r.lastLaunchedAt === 'string' ? r.lastLaunchedAt.slice(0, 40) : '',
          pid: Number.isInteger(r.pid) && r.pid > 0 ? r.pid : 0,
        });
      }
      return { schema: INSTALL_REGISTRY_SCHEMA, packages };
    } catch { return { schema: INSTALL_REGISTRY_SCHEMA, packages: [] }; }
  }
  // 本包这次启动:登记(或刷新)一行。失败只吞掉 —— 登记表是旁路账,绝不挡启动。
  async function recordInstallLaunch(launchMode) {
    try {
      const reg = readInstallRegistry();
      const root = path.resolve(externalRoot());
      const key = samePathKey(root);
      const now = nowIso();
      let row = reg.packages.find(r => samePathKey(r.packageRoot) === key);
      if (!row) { row = { packageRoot: root, firstSeenAt: now }; reg.packages.push(row); }
      row.version = version;
      row.launchMode = String(launchMode || '').slice(0, 16);
      row.lastLaunchedAt = now;
      row.pid = process.pid;
      // 目录已不在的行顺手剔掉(老包被用户手动删了);按最近启动倒序,封顶。
      const packages = reg.packages
        .filter(r => samePathKey(r.packageRoot) === key || fs.existsSync(r.packageRoot))
        .sort((a, b) => String(b.lastLaunchedAt || '').localeCompare(String(a.lastLaunchedAt || '')))
        .slice(0, INSTALL_REGISTRY_MAX);
      await fsp.mkdir(paths.data, { recursive: true });
      await writeInstallRegistry(packages, now);
      return { ok: true, packageRoot: root };
    } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
  }

  return Object.freeze({ readInstallRegistry, writeInstallRegistry, recordInstallLaunch });
}

module.exports = { createInstallRegistry };
