'use strict';
const fsp = require('node:fs/promises'), path = require('node:path');
async function dirStat(dir, cap = 100000) {
  const out = { bytes: 0, files: 0, truncated: false };
  async function walk(d) {
    if (out.files >= cap) { out.truncated = true; return; }
    const ents = await fsp.readdir(d, { withFileTypes: true }).catch(() => []);
    for (const ent of ents) {
      if (out.files >= cap) { out.truncated = true; return; }
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) await walk(p);
      else { const st = await fsp.stat(p).catch(() => null); if (st) { out.bytes += st.size; out.files++; } }
    }
  }
  await walk(dir);
  return out;
}
module.exports = { dirStat };
