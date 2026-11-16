'use strict';
const path = require('node:path');
const { PLAYBOOK_REQUIRES, evalPlaybookAvailability } = require('./playbook-policy.cjs');
const fsp = require('node:fs/promises');
const { parseFrontmatter, docMeta, docBody, commandPrompt } = require('./document-metadata.cjs');
const SKILL_IMPORT_RECORD = '.ruyi-import.json';
const SKILL_IMPORT_SOURCES = Object.freeze(['claude-code', 'codex', 'kimi', 'claude-plugin']);
function effectiveSkillSelection(session, config) {
  const resident = Array.isArray(config && config.residentSkills) ? config.residentSkills : [];
  const sessionOnly = Array.isArray(session && session.skills) ? session.skills : [];
  const out = [], seen = new Set();
  // Session selection wins on duplicate ids: it reflects the workspace in which the user most recently
  // enabled the skill, while the resident copy remains available in other sessions/workspaces.
  for (const raw of [...sessionOnly, ...resident]) {
    const id = String(typeof raw === 'string' ? raw : (raw && raw.id) || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id); out.push(raw);
  }
  return out;
}

function createSkillRegistry({ SKILL_ID_RE, agentCliHomes, externalRoot, paths, getCapabilities, loadAllPlaybooks, readIfExists, safeJsonParse }) {
// v1 技能体系: 解析 SKILL.md frontmatter 的 requires 字段为能力键数组(取值同 PLAYBOOK_REQUIRES)。
// parseFrontmatter 把整行值当字符串,故支持「requires: network, vision」与「requires: [network, vision]」两写法。
function parseSkillRequires(val) {
  if (val == null) return [];
  const s = String(val).trim().replace(/^\[|\]$/g, '');
  return [...new Set(s.split(',').map(x => x.trim().replace(/^['"]|['"]$/g, '')).filter(r => PLAYBOOK_REQUIRES.includes(r)))];
}

// W8 迁移中心「复制到如意」:从外部 CLI 复制进 dataRoot/skills/<id>/ 的技能,目录里带一份来源记录
// (schema 1:source / sourcePath / plugin / importedAt / sourceTreeHash / copyTreeHash,由 13u 写)。
// 这里只负责读:坏的、超大的、来源不认识的一律当没有(副本照常是 user 技能,只是不显示「复制自」)。
async function readSkillImportRecord(dir) {
  let rec = null;
  try {
    const file = path.join(dir, SKILL_IMPORT_RECORD);
    const st = await fsp.lstat(file);
    if (!st.isFile() || st.size > 16 * 1024) return null;
    rec = safeJsonParse(await fsp.readFile(file, 'utf8'), null);
  } catch { return null; }
  if (!rec || typeof rec !== 'object' || rec.schema !== 1 || !SKILL_IMPORT_SOURCES.includes(rec.source)) return null;
  const str = v => (typeof v === 'string' ? v : '');
  return { schema: 1, source: rec.source, plugin: str(rec.plugin).slice(0, 120), sourcePath: str(rec.sourcePath), importedAt: str(rec.importedAt),
    sourceTreeHash: str(rec.sourceTreeHash), copyTreeHash: str(rec.copyTreeHash) };
}

// v1 技能体系: 扫描一个 base 目录下的 <id>/SKILL.md,解析成技能条目 Map<id, entry>。用户/项目技能共用。
// frontmatter 范式仿 readClaudeProjectAgentRoles(name/description/requires);id=目录名,须过 SKILL_ID_RE(防穿越)。
// 无 frontmatter 时 name 回退目录名、description 回退首个正文段(firstParaDesc)——与内置技能同回退策略。
async function readSkillDir(baseDir, source, caps) {
  const out = new Map();
  let ents = [];
  try { ents = await fsp.readdir(baseDir, { withFileTypes: true }); } catch { return out; } // 目录不存在 → 空
  for (const d of ents) {
    const id = d.name;
    if (!SKILL_ID_RE.test(id)) continue; // 非法/穿越名跳过
    const dir = path.join(baseDir, id);
    // hunt2-mcp:符号链接 / 目录联接(Windows junction)指向的技能目录也认 —— 「把技能仓链进 skills/」是常见装法,
    // 修前 Dirent.isDirectory() 对链接恒为 false,整个技能静默消失。stat 跟随链接判是不是目录。
    if (!d.isDirectory()) {
      if (!d.isSymbolicLink()) continue;
      try { if (!(await fsp.stat(dir)).isDirectory()) continue; } catch { continue; }
    }
    const file = path.join(dir, 'SKILL.md');
    let raw = '';
    try { const st = await fsp.stat(file); if (!st.isFile() || st.size > 256 * 1024) continue; raw = await fsp.readFile(file, 'utf8'); } catch { continue; }
    const meta = docMeta(raw); // { name, description(含 firstParaDesc 回退) }
    const requires = parseSkillRequires(parseFrontmatter(raw).requires);
    const avail = evalPlaybookAvailability({ requires }, caps); // 复用 playbook 能力矩阵门控
    // W8:user 源的技能若是从外部复制来的,带上「复制自哪里」(只读显示用,不影响优先级与任何判定)。
    const copied = source === 'user' ? await readSkillImportRecord(dir) : null;
    out.set(id, {
      id, name: (meta.name || id).slice(0, 120), description: (meta.description || '').slice(0, 400), detail: docBody(raw),
      kind: 'skill', source, dir, insert: '/' + id, requires,
      available: avail.available, unavailableReason: avail.unavailableReason,
      ...(copied ? { copiedFrom: copied.source, copiedFromPlugin: copied.plugin } : {}),
    });
  }
  return out;
}

// v1 技能体系: 统一技能注册表。合并四源为一个数组,每项:
//   { id, name, description, kind:'skill'|'command'|'playbook', source:'builtin'|'user'|'project',
//     dir(kind=skill: SKILL.md 所在目录绝对路径,否则 ''), insert(kind=command: '/'+name),
//     requires:[], available:bool, unavailableReason:string }
// 技能同 id 优先级 project > user > claude-code > builtin;命令/Playbook 各自命名空间(Playbook id 加 'pb:' 前缀防撞)。
// requires 门控复用 evalPlaybookAvailability 的能力矩阵逻辑(getCapabilities 60s 缓存)。caps 可预传避免重复探测。
// claude-code 源只读直连 ~/.claude/skills(本机 Claude Code 个人技能),不复制;删除仅允许 user 源(见 DELETE /api/skills)。
// W2 迁移中心:Claude Code 已安装插件的技能目录。只认 Claude Code 自己的安装账
// ~/.claude/plugins/installed_plugins.json(v1:{plugins:{"名@市场":{installPath}}};v2:值是安装数组)——
// marketplaces/ 下是「可装」的全集,不是已装的,不扫。~/.claude/settings.json 的 enabledPlugins 里显式 false 的跳过。
// 只读、从不抛;每个插件取 <installPath>/skills。
// 随包的 offline-toolkit(市场 ruyi-offline,3.0 前叫 win-workbench-offline)不算外来插件:它的技能就是 builtin 那一份,
// 装进 Claude Code 后缓存的是安装时的旧副本。照常读会按优先级把 20 个内置技能顶成 source='claude-plugin' —— 译名丢失、
// 已启用的 {id, source:'builtin'} 因来源对不上被静默跳过注入、内容停在安装那一刻。所以跳过,内置技能永远活读 resources/。
const BUNDLED_PLUGIN_IDS = ['offline-toolkit@ruyi-offline', 'offline-toolkit@win-workbench-offline'];
async function claudePluginSkillDirs() {
  const claudeDir = agentCliHomes().claude;
  const installed = safeJsonParse(await readIfExists(path.join(claudeDir, 'plugins', 'installed_plugins.json'), 512 * 1024), null);
  const plugins = installed && installed.plugins && typeof installed.plugins === 'object' ? installed.plugins : null;
  if (!plugins) return [];
  const settings = safeJsonParse(await readIfExists(path.join(claudeDir, 'settings.json'), 512 * 1024), null);
  const enabled = settings && settings.enabledPlugins && typeof settings.enabledPlugins === 'object' ? settings.enabledPlugins : {};
  const out = [];
  for (const [name, value] of Object.entries(plugins)) {
    if (enabled[name] === false) continue;
    if (BUNDLED_PLUGIN_IDS.includes(String(name))) continue;
    const installs = Array.isArray(value) ? value : [value];
    for (const inst of installs) {
      const installPath = inst && typeof inst.installPath === 'string' ? inst.installPath : '';
      if (!installPath || !path.isAbsolute(installPath)) continue;
      out.push({ plugin: String(name).slice(0, 120), skillsDir: path.join(installPath, 'skills') });
      break; // 同一插件多份安装(不同 scope)只取第一份
    }
    if (out.length >= 64) break;
  }
  return out;
}
async function loadSkillRegistry(cwd, config, caps) {
  if (caps === undefined) caps = await getCapabilities(config).catch(() => null);
  const out = [];
  const tk = path.join(externalRoot(), 'resources', 'plugins', 'ruyi-offline', 'offline-toolkit');
  // ---- 技能: builtin(toolkit)→ user(dataRoot/skills)→ project(<cwd>/.ruyi/skills),后写覆盖同 id ----
  const skillMap = new Map();
  {
    const skillDir = path.join(tk, 'skills');
    for (const d of (await fsp.readdir(skillDir, { withFileTypes: true }).catch(() => []))) {
      if (!d.isDirectory() || !SKILL_ID_RE.test(d.name)) continue;
      const dir = path.join(skillDir, d.name);
      const raw = await readIfExists(path.join(dir, 'SKILL.md'), 16000);
      const meta = docMeta(raw);
      const requires = parseSkillRequires(parseFrontmatter(raw).requires);
      const avail = evalPlaybookAvailability({ requires }, caps);
      skillMap.set(d.name, {
        id: d.name, name: (meta.name || d.name).slice(0, 120), description: (meta.description || '').slice(0, 400), detail: docBody(raw),
        kind: 'skill', source: 'builtin', dir, insert: '/' + d.name, requires,
        available: avail.available, unavailableReason: avail.unavailableReason,
      });
    }
  }
  // W2 迁移中心:其它 Agent CLI 的技能同样只读直连(活读,不复制),优先级从低到高:
  //   builtin < claude-plugin(Claude Code 已安装插件自带的技能)< kimi(~/.kimi-code/skills)< codex(~/.codex/skills)
  //   < claude-code(~/.claude/skills)< user < project。同名时高优先级那份生效,来源标签随条目走(技能库里看得见)。
  for (const dir of await claudePluginSkillDirs()) {
    for (const [id, e] of await readSkillDir(dir.skillsDir, 'claude-plugin', caps)) skillMap.set(id, { ...e, plugin: dir.plugin });
  }
  const cliHomes = agentCliHomes();
  for (const [id, e] of await readSkillDir(path.join(cliHomes.kimi, 'skills'), 'kimi', caps)) skillMap.set(id, e);
  for (const [id, e] of await readSkillDir(path.join(cliHomes.codex, 'skills'), 'codex', caps)) skillMap.set(id, e);
  // 本机 Claude Code 个人技能(~/.claude/skills/<id>/SKILL.md)作为第 4 源映射进来(只读直连,不复制)。
  // 优先级:builtin < claude-code < user < project -- 放在 user 之前,让 Ruyi 自己的 user 技能可覆盖同名 Claude Code 技能。
  // 目录缺失时 readSkillDir 返回空 Map(优雅 no-op),与 ~/.claude/commands 的读取同精神。
  for (const [id, e] of await readSkillDir(path.join(cliHomes.claude, 'skills'), 'claude-code', caps)) skillMap.set(id, e);
  for (const [id, e] of await readSkillDir(paths.skills, 'user', caps)) skillMap.set(id, e);
  if (cwd) for (const [id, e] of await readSkillDir(path.join(path.resolve(String(cwd)), '.ruyi', 'skills'), 'project', caps)) skillMap.set(id, e);
  for (const e of skillMap.values()) out.push(e);

  // ---- 命令: builtin(toolkit commands)+ user(~/.claude/commands),沿用旧 scanSkills 的 '/'+name 语义 ----
  const seenCmd = new Set();
  const addCmd = (name, raw, src) => {
    if (!name || seenCmd.has(name)) return; seenCmd.add(name);
    const meta = docMeta(raw);
    out.push({ id: name, name: meta.name || name, description: meta.description || '', detail: docBody(raw), prompt: commandPrompt(raw), kind: 'command', source: src, dir: '', insert: '/' + name, requires: [], available: true, unavailableReason: '' });
  };
  const cmdDir = path.join(tk, 'commands');
  for (const f of (await fsp.readdir(cmdDir).catch(() => [])).filter(x => x.endsWith('.md'))) addCmd(path.basename(f, '.md'), await readIfExists(path.join(cmdDir, f), 12000), 'builtin');
  const userCmd = path.join(cliHomes.claude, 'commands');
  for (const f of (await fsp.readdir(userCmd).catch(() => [])).filter(x => x.endsWith('.md'))) addCmd(path.basename(f, '.md'), await readIfExists(path.join(userCmd, f), 12000), 'user');

  // ---- Playbook: loadAllPlaybooks + evalPlaybookAvailability 映射(id 加 'pb:' 前缀防与技能/命令撞) ----
  for (const pb of (await loadAllPlaybooks().catch(() => []))) {
    const avail = evalPlaybookAvailability(pb, caps);
    out.push({
      id: 'pb:' + pb.id, name: pb.title || pb.id, description: pb.desc || '', kind: 'playbook',
      source: pb.builtin ? 'builtin' : 'user', dir: '', insert: '', requires: Array.isArray(pb.requires) ? pb.requires : [],
      // 127-⑧:status(可用/需配置/不可用/未知)随行拷过去 —— 技能库行靠它说「未知」,available 仍管能不能点。
      available: avail.available, unavailableReason: avail.unavailableReason, status: avail.status, playbook: pb,
    });
  }
  // 稳定排序: kind(skill<command<playbook) 再 name,供 UI 与断言确定性。
  const kindRank = { skill: 0, command: 1, playbook: 2 };
  out.sort((a, b) => (kindRank[a.kind] - kindRank[b.kind]) || String(a.name).localeCompare(String(b.name)));
  return out;
}

// v1 技能体系: 把会话启用的技能条目解析成注册表条目(仅 kind==='skill' 且 available)。供两个引擎注入用。
// P2-2: session.skills 元素为 {id, source}(或旧裸字符串)。source 非空时要求注册表条目 source 一致 —— 换 cwd
// 后同 id 项目技能顶替已启用的内置/用户技能(调包)会被此校验拦下:跳过注入,并通过 onSourceMismatch 通知一次。
async function resolveEnabledSkillEntries(session, config, cwd, caps, onSourceMismatch) {
  const enabled = effectiveSkillSelection(session, config);
  if (!enabled.length) return [];
  let registry = [];
  try { registry = await loadSkillRegistry(cwd, config, caps); } catch { return []; }
  const byId = new Map(registry.filter(e => e.kind === 'skill').map(e => [e.id, e]));
  const out = [];
  for (const raw of enabled) {
    const id = typeof raw === 'string' ? raw : String((raw && raw.id) || '');
    const source = typeof raw === 'string' ? '' : String((raw && raw.source) || '');
    const e = byId.get(id);
    if (!e || e.available === false) continue; // 缺失/不可用 → 不注入
    if (source && e.source !== source) { // 来源被调包 → 跳过注入 + 通知一次(该回合)
      if (typeof onSourceMismatch === 'function') { try { onSourceMismatch(id, source, e.source); } catch { /* 通知失败不阻断 */ } }
      continue;
    }
    out.push(e);
  }
  return out;
}

// v1 技能体系: 旧 scanSkills(仅命令/技能字面量 + '/'+name)已被 loadSkillRegistry 取代(四源统一 + dir + 能力
// 门控 + Playbook)。GET /api/skills 现走 loadSkillRegistry;命令扫描逻辑照搬进了 loadSkillRegistry 的命令段。

return { loadSkillRegistry, resolveEnabledSkillEntries, readSkillDir, readSkillImportRecord, claudePluginSkillDirs };
}
module.exports = { createSkillRegistry, effectiveSkillSelection, SKILL_IMPORT_RECORD };
