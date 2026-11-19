'use strict';

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { memoryProposalLooksSensitive } = require('./memory-sensitivity.cjs');

const AGENT_INSTRUCTION_NATIVE_CLI = Object.freeze({ 'claude-md': 'claude', 'kimi-agents': 'kimi' });
function agentInstructionSourceKeyOf(id) {
  const m = /^agentmd-([a-z]+-[a-z]+)-\d+$/.exec(String(id || ''));
  return m ? m[1] : '';
}
// 某个 CLI 自己原生会读的那份导入条目,从该 CLI 回合的注入清单里拿掉。cliType 空 = 不过滤(provider 引擎)。
function filterMemoryForNativeCli(entries, cliType) {
  const list = Array.isArray(entries) ? entries : [];
  const cli = String(cliType || '');
  if (!cli) return list.slice();
  return list.filter(e => !(e && e.scope === 'global' && AGENT_INSTRUCTION_NATIVE_CLI[agentInstructionSourceKeyOf(e.id)] === cli));
}

function createAgentInstructionImports({ paths, DurableJsonStore, agentCliHomes, tildePath, nowIso, logEvent, atomicWriteJson,
  store: { memoryGlobalDir, deleteMemory, fmVal }, summaryCap: CORE_MEMORY_SUMMARY_CAP }) {
  // ============================================================================
  // W2 迁移中心 · 指令文件 → 核心记忆。本机其它 Agent CLI 的【全局】指令文件导成工作台全局记忆
  // (core:true、type convention),换到如意的用户不必把「我的规矩」再说一遍。
  //   · 来源:agentInstructionSources();每个来源取第一个非空文件(Codex 的 AGENTS.override.md 优先于
  //     AGENTS.md,与 Codex 自己的读取次序一致)。Kimi Code 的全局指令位置取自它自己的二进制里的读取逻辑
  //     ($KIMI_CODE_HOME/AGENTS.md,缺省 ~/.kimi-code/AGENTS.md)。
  //   · 拆分:核心胶囊每轮只放每条的摘要(≤520 字),所以按标题/段落把全文切成 ≤480 字的块,一块一条;每个来源
  //     最多 12 块进核心(约 6K 字,不挤占用户自己的核心席位),余下合成一条 core:false 的「其余部分」,并在
  //     第 12 条的摘要末尾注明去哪读。
  //   · 同步:sidecar <data>/memory/.agent-instructions-import-v1.json 记来源哈希与我们写下的每条文件哈希。
  //     来源变了:我们写的条目一字未动 → 自动重导;用户改过(文件哈希变了)→ 不覆盖,只标 sourceChanged。
  //     用户删掉任何一条(或在迁移中心点「移除」)→ 记 dismissed,不再自动导回(显式「导入」才解除)。
  //   · 去重:CLI 原生会读的那份(claude-md ↔ Claude Code、kimi-agents ↔ Kimi Code)在该 CLI 的回合不注入
  //     (filterMemoryForNativeCli,05 调用);provider 引擎照常注入。
  // ============================================================================
  const AGENT_INSTRUCTION_IMPORT_SCHEMA = 1;
  const AGENT_INSTRUCTION_MAX_BYTES = 200 * 1024;
  const AGENT_INSTRUCTION_CORE_PARTS = 12;
  const AGENT_INSTRUCTION_CHUNK_CHARS = 480;
  const AGENT_INSTRUCTION_SCAN_VERSION = 1; // 记录里带这个章 = 导入时已过敏感扫描(没有的是扫描上线前的旧记录,见 sync 的补扫)
  let agentInstructionChain = Promise.resolve();

  function agentInstructionSources() {
    const homes = agentCliHomes();
    return [
      { key: 'claude-md', tool: 'claude-code', label: 'Claude Code', nativeCli: 'claude', files: [path.join(homes.claude, 'CLAUDE.md')] },
      { key: 'codex-agents', tool: 'codex', label: 'Codex', nativeCli: '', files: [path.join(homes.codex, 'AGENTS.override.md'), path.join(homes.codex, 'AGENTS.md')] },
      { key: 'kimi-agents', tool: 'kimi', label: 'Kimi Code', nativeCli: 'kimi', files: [path.join(homes.kimi, 'AGENTS.md')] },
      // Gemini 不在用户点名的三家里(派单:可选):只列出、不在启动期自动导入;用户在迁移中心点「导入」才进核心记忆。
      { key: 'gemini-md', tool: 'gemini', label: 'Gemini CLI', nativeCli: '', autoImport: false, files: [path.join(homes.gemini, 'GEMINI.md')] },
    ];
  }
  function agentInstructionImportFile() { return path.join(paths.memory, '.agent-instructions-import-v1.json'); }
  // 架构还债批 2 B3:所有权 sidecar 走 DurableJsonStore(01),盘上字节与恢复口径与手写版逐字节相同:
  //   · 缺失 / 读不动 / 不是 JSON / 根不是对象 / schema 不是 1(含缺 schema)/ sources 不是普通对象 = 空表
  //     { schema:1, sources:{} };坏文件原样留着、不复制成 .corrupt(quarantine:false),不记事件;
  //   · 合格的文件原样读回(含 updatedAt 与任何多余的键),不缓存(每次同步都重读盘);
  //   · 写:mkdir memory 目录 + atomicWriteJson,形状固定 { schema, updatedAt, sources }。
  //   读-改-写的串行仍由 agentInstructionChain 负责(整段同步是一个临界区),store 自己的写链只是再串一层。
  const agentInstructionImportStore = DurableJsonStore.create({
    id: 'agent-instructions-import',
    file: () => agentInstructionImportFile(),
    schemaVersion: AGENT_INSTRUCTION_IMPORT_SCHEMA,
    cache: false,
    quarantine: false,
    defaultValue: () => ({ schema: AGENT_INSTRUCTION_IMPORT_SCHEMA, sources: {} }),
    sanitize: value => (value.schema === AGENT_INSTRUCTION_IMPORT_SCHEMA && value.sources && typeof value.sources === 'object' && !Array.isArray(value.sources)
      ? value : { schema: AGENT_INSTRUCTION_IMPORT_SCHEMA, sources: {} }),
  });
  function agentInstructionMemoryId(key, n) { return 'agentmd-' + key + '-' + n; }
  function sha256Hex(text) { return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex'); }

  async function readAgentInstructionState() {
    return agentInstructionImportStore.read();
  }
  async function writeAgentInstructionState(state) {
    await agentInstructionImportStore.write({ schema: AGENT_INSTRUCTION_IMPORT_SCHEMA, updatedAt: nowIso(), sources: state.sources });
  }

  // 取来源的第一个非空文件。返回 null(没有)/{ file, error }(过大、读不了)/{ file, text, hash }。
  async function readAgentInstructionSource(src) {
    for (const file of src.files) {
      let st;
      try { st = await fsp.stat(file); } catch { continue; }
      if (!st.isFile()) continue;
      if (st.size > AGENT_INSTRUCTION_MAX_BYTES) return { file, error: 'too-large', size: st.size };
      let text = '';
      try { text = await fsp.readFile(file, 'utf8'); } catch { return { file, error: 'unreadable' }; }
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
      text = text.replace(/\r\n?/g, '\n');
      if (!text.trim()) continue; // 空文件不算(Codex:override 空 → 看 AGENTS.md)
      return { file, text, hash: sha256Hex(text).slice(0, 32) };
    }
    return null;
  }

  // 全文 → 块。先按 #/##/### 标题切段(代码围栏里的 # 不算),相邻的小段合并到 ≤480 字(压平后),
  // 超长段再按空行切段落,段落还超长就按字数硬切。每块带所属标题,摘要里给续段补上下文。
  // sensitive(heading, body) 非空时做敏感剔除【在合并/硬切之前、按原文单元】做:小段整段查(命中整段不进任何块,不连累被合并在一起的
  // 干净小段);超长段逐段落查,段落整段查(一个「key=value」横跨硬切接缝时,整段落是连续的,照样命中);段落之间的「key:\n\nvalue」
  // 单段查不出来,所以超长段另查一遍整段,命中而没有哪个段落命中就整段剔。剔掉的单元数记在返回数组的 skippedSensitive 上。
  function splitAgentInstructionText(text, sensitive) {
    const CHUNK = AGENT_INSTRUCTION_CHUNK_CHARS;
    const sens = typeof sensitive === 'function' ? sensitive : null;
    let skippedSensitive = 0;
    const flat = s => String(s || '').replace(/\s+/g, ' ').trim();
    const sections = [];
    let cur = { heading: '', lines: [] };
    let inFence = false;
    for (const line of String(text || '').split('\n')) {
      if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
      const isHeading = !inFence && /^#{1,3}\s+\S/.test(line);
      if (isHeading && cur.lines.some(l => l.trim())) { sections.push(cur); cur = { heading: '', lines: [] }; }
      if (isHeading && !cur.heading) cur.heading = line.replace(/^#+\s+/, '').trim().slice(0, 60);
      cur.lines.push(line);
    }
    if (cur.lines.some(l => l.trim())) sections.push(cur);
    const chunks = [];
    let acc = null;
    const flush = () => { if (acc && acc.flat) chunks.push(acc); acc = null; };
    for (const sec of sections) {
      const body = sec.lines.join('\n').trim();
      const f = flat(body);
      if (!f) continue;
      if (f.length <= CHUNK) {
        if (sens && sens(sec.heading, body)) { skippedSensitive++; continue; }
        if (acc && acc.flat.length + 1 + f.length <= CHUNK) { acc.body += '\n\n' + body; acc.flat += ' ' + f; }
        else { flush(); acc = { heading: sec.heading, body, flat: f }; }
        continue;
      }
      flush();
      const paras = body.split(/\n\s*\n/);
      const paraHits = sens ? paras.map(para => sens(sec.heading, para)) : [];
      if (sens && !paraHits.some(Boolean) && sens(sec.heading, body)) { skippedSensitive++; continue; }
      let p = null;
      for (let pi = 0; pi < paras.length; pi++) {
        const para = paras[pi];
        const pf = flat(para);
        if (!pf) continue;
        if (paraHits[pi]) { skippedSensitive++; continue; }
        if (pf.length > CHUNK) {
          if (p) { chunks.push(p); p = null; }
          const raw = para.trim();
          for (let i = 0; i < raw.length; i += CHUNK) {
            const piece = raw.slice(i, i + CHUNK);
            if (flat(piece)) chunks.push({ heading: sec.heading, body: piece.trim(), flat: flat(piece) });
          }
          continue;
        }
        if (p && p.flat.length + 1 + pf.length <= CHUNK) { p.body += '\n\n' + para.trim(); p.flat += ' ' + pf; }
        else { if (p) chunks.push(p); p = { heading: sec.heading, body: para.trim(), flat: pf }; }
      }
      if (p) chunks.push(p);
    }
    flush();
    chunks.skippedSensitive = skippedSensitive;
    return chunks;
  }

  // 敏感扫描(与其余写入路径同一道闸 memoryProposalLooksSensitive):指令文件里常有人顺手写下的口令/密钥/连接串,
  // 核心记忆每轮都会随提示词发往第三方模型服务商,所以导入前必须过。命中的原文单元不导入(切分时按小段/段落剔,见 splitAgentInstructionText)。
  function agentInstructionLooksSensitive(heading, body) {
    return memoryProposalLooksSensitive({ name: heading, description: '', body });
  }

  // 一个来源 → 待写条目清单(纯函数:不落盘)。最多 12 条 core,余下合一条 core:false。
  // 命中敏感扫描的单元被剔除、不进条目清单;剔了几处记在返回数组的 skippedSensitive 上(给迁移中心如实标出)。
  function planAgentInstructionEntries(src, read, displayPath) {
    const chunks = splitAgentInstructionText(read.text, agentInstructionLooksSensitive);
    const coreChunks = chunks.slice(0, AGENT_INSTRUCTION_CORE_PARTS);
    const rest = chunks.slice(AGENT_INSTRUCTION_CORE_PARTS);
    const total = coreChunks.length + (rest.length ? 1 : 0);
    const out = [];
    out.skippedSensitive = chunks.skippedSensitive || 0;
    coreChunks.forEach((c, i) => {
      const n = i + 1;
      let summary = (c.heading && !c.flat.startsWith('#') ? '〔' + c.heading + '〕' : '') + c.flat;
      if (rest.length && n === coreChunks.length) summary = summary.slice(0, CORE_MEMORY_SUMMARY_CAP - 60) + ' …(余下部分见记忆 ' + agentInstructionMemoryId(src.key, total) + ')';
      out.push({
        id: agentInstructionMemoryId(src.key, n), core: true, part: n + '/' + total,
        name: (src.label + ' 全局指令 · ' + (c.heading || ('第 ' + n + ' 段'))).slice(0, 120),
        description: ('从 ' + displayPath + ' 导入的全局指令(第 ' + n + '/' + total + ' 段)').slice(0, 400),
        coreSummary: summary.slice(0, CORE_MEMORY_SUMMARY_CAP), body: c.body,
      });
    });
    if (rest.length) {
      out.push({
        id: agentInstructionMemoryId(src.key, total), core: false, part: total + '/' + total,
        name: (src.label + ' 全局指令 · 其余部分').slice(0, 120),
        description: ('从 ' + displayPath + ' 导入的全局指令(第 ' + total + '/' + total + ' 段,超出核心席位的其余部分)').slice(0, 400),
        coreSummary: '', body: rest.map(c => c.body).join('\n\n'),
      });
    }
    return out;
  }

  function renderAgentInstructionMemory(entry, src, read, importedAt) {
    const lines = ['---', 'name: ' + fmVal(entry.name), 'description: ' + fmVal(entry.description), 'type: convention',
      'createdAt: ' + importedAt, 'updatedAt: ' + importedAt, 'core: ' + String(entry.core), 'importance: normal',
      'coreSummary: ' + fmVal(entry.coreSummary).slice(0, CORE_MEMORY_SUMMARY_CAP), 'sourceRunId: agent-instructions-import-v1',
      'importSource: ' + src.key, 'importSourcePath: ' + fmVal(read.file), 'importSourceHash: ' + read.hash,
      'importedAt: ' + importedAt, 'importPart: ' + entry.part, '---', '', String(entry.body || '').trim(), ''];
    return lines.join('\n');
  }

  async function removeAgentInstructionEntries(key, record) {
    const ids = new Set((record && Array.isArray(record.entries) ? record.entries : []).map(e => String(e && e.id || '')).filter(Boolean));
    // 兜底:按 id 前缀把同来源的残留(上次写到一半的)也清掉。只动 agentmd-<key>- 开头的全局条目。
    try { for (const f of await fsp.readdir(memoryGlobalDir())) { const id = f.replace(/\.md$/i, ''); if (f.toLowerCase().endsWith('.md') && agentInstructionSourceKeyOf(id) === key) ids.add(id); } } catch { /* 目录还没有 */ }
    for (const id of ids) await deleteMemory(id, 'global', '').catch(() => {});
    return ids.size;
  }

  async function writeAgentInstructionEntries(src, read, displayPath) {
    const importedAt = nowIso();
    const plan = planAgentInstructionEntries(src, read, displayPath);
    await fsp.mkdir(memoryGlobalDir(), { recursive: true });
    const entries = [];
    for (const entry of plan) {
      const content = renderAgentInstructionMemory(entry, src, read, importedAt);
      await atomicWriteJson(path.join(memoryGlobalDir(), entry.id + '.md'), content);
      entries.push({ id: entry.id, hash: sha256Hex(content).slice(0, 32), core: entry.core });
    }
    return { importedAt, entries, skippedSensitive: plan.skippedSensitive || 0 };
  }

  // 我们写下的条目现在怎样:missing(被删了几条)/ modified(被改了几条)。
  async function inspectAgentInstructionEntries(record) {
    let missing = 0, modified = 0;
    for (const e of (record && Array.isArray(record.entries) ? record.entries : [])) {
      let content = null;
      try { content = await fsp.readFile(path.join(memoryGlobalDir(), String(e.id) + '.md'), 'utf8'); } catch { missing++; continue; }
      if (sha256Hex(content).slice(0, 32) !== e.hash) modified++;
    }
    return { missing, modified };
  }

  // 同步入口(启动期、迁移中心 scan/apply 共用;整段串行化)。
  //   opts.auto     true = 按配置开关自动导入/自动重导(启动期与 scan);false = 只看不写(除非 import/dismiss 点名)
  //   opts.importKeys  显式导入(解除 dismissed、覆盖用户改动)
  //   opts.dismissKeys 显式移除(删条目 + 记 dismissed)
  // 返回 { ok, sources: [{ key, tool, label, file, displayPath, status, entries, coreEntries, importedAt, userModified, sourceChanged }] }
  //   status: absent | too-large | importable | imported | source-updated | dismissed
  function syncAgentInstructionImports(opts = {}) {
    const job = agentInstructionChain.then(() => syncAgentInstructionImportsUnlocked(opts));
    agentInstructionChain = job.catch(() => {});
    return job;
  }
  async function syncAgentInstructionImportsUnlocked(opts) {
    const auto = opts.auto === true;
    const importKeys = new Set(Array.isArray(opts.importKeys) ? opts.importKeys.map(String) : []);
    const dismissKeys = new Set(Array.isArray(opts.dismissKeys) ? opts.dismissKeys.map(String) : []);
    const state = await readAgentInstructionState();
    let dirty = false;
    const out = [];
    for (const src of agentInstructionSources()) {
      let record = state.sources[src.key] || null;
      const read = await readAgentInstructionSource(src);
      const file = read ? read.file : src.files[src.files.length - 1];
      const displayPath = tildePath(file);
      const row = { key: src.key, tool: src.tool, label: src.label, nativeCli: src.nativeCli, file, displayPath, status: 'absent', entries: 0, coreEntries: 0, importedAt: '', userModified: false, sourceChanged: false };
      if (dismissKeys.has(src.key)) {
        await removeAgentInstructionEntries(src.key, record);
        state.sources[src.key] = { key: src.key, file, sourceHash: read && read.hash ? read.hash : '', entries: [], dismissed: true, dismissedAt: nowIso() };
        dirty = true;
        logEvent({ kind: 'agent_instructions_dismiss', source: src.key });
        out.push({ ...row, status: 'dismissed' });
        continue;
      }
      if (read && read.error) {
        out.push({ ...row, status: read.error === 'too-large' ? 'too-large' : 'absent', error: read.error });
        continue;
      }
      const forced = importKeys.has(src.key);
      if (record && record.dismissed && !forced) { out.push({ ...row, status: read ? 'dismissed' : 'absent' }); continue; }
      if (record && !record.dismissed && Array.isArray(record.entries) && record.entries.length && !forced) {
        const inspect = await inspectAgentInstructionEntries(record);
        if (inspect.missing) {
          // 用户在记忆面板里删了我们导入的条目 = 不要它了。记 dismissed,余下的条目留给用户自己处置。
          state.sources[src.key] = { ...record, dismissed: true, dismissedAt: nowIso(), entries: [] };
          dirty = true;
          logEvent({ kind: 'agent_instructions_dismiss', source: src.key, reason: 'entry-deleted' });
          out.push({ ...row, status: read ? 'dismissed' : 'absent' });
          continue;
        }
        const userModified = inspect.modified > 0;
        const sourceChanged = Boolean(read && read.hash !== record.sourceHash);
        // 敏感扫描上线之前导入的记录没有 scanVersion:源文件没变也要补扫一次 —— 里面若有口令/密钥,旧条目早已在每轮发给服务商了,
        // 没改过(userModified=false)就按「来源更新」同款流程清掉重导(重导时那几块被剔除);扫干净了就盖个章,以后不再重算。
        let needsRescan = false;
        if (read && record.scanVersion !== AGENT_INSTRUCTION_SCAN_VERSION) {
          needsRescan = planAgentInstructionEntries(src, read, displayPath).skippedSensitive > 0;
          if (!needsRescan) { record = { ...record, scanVersion: AGENT_INSTRUCTION_SCAN_VERSION }; state.sources[src.key] = record; dirty = true; }
        }
        if ((sourceChanged || needsRescan) && !userModified && auto) {
          await removeAgentInstructionEntries(src.key, record);
          const written = await writeAgentInstructionEntries(src, read, displayPath);
          state.sources[src.key] = { key: src.key, file: read.file, sourceHash: read.hash, importedAt: written.importedAt, entries: written.entries, dismissed: false, skippedSensitive: written.skippedSensitive, scanVersion: AGENT_INSTRUCTION_SCAN_VERSION };
          dirty = true;
          logEvent({ kind: 'agent_instructions_import', source: src.key, entries: written.entries.length, reason: sourceChanged ? 'source-updated' : 'sensitive-rescan', skippedSensitive: written.skippedSensitive });
          out.push({ ...row, status: 'imported', entries: written.entries.length, coreEntries: written.entries.filter(e => e.core).length, importedAt: written.importedAt, sensitiveSkipped: written.skippedSensitive });
          continue;
        }
        if (Boolean(record.sourceChanged) !== sourceChanged || Boolean(record.userModified) !== userModified) {
          state.sources[src.key] = { ...record, sourceChanged, userModified };
          dirty = true;
        }
        out.push({ ...row, status: sourceChanged ? 'source-updated' : 'imported', entries: record.entries.length,
          coreEntries: record.entries.filter(e => e && e.core).length, importedAt: record.importedAt || '', userModified, sourceChanged, sourceMissing: !read,
          sensitiveSkipped: Math.max(0, Math.floor(Number(record.skippedSensitive) || 0)) });
        continue;
      }
      if (!read) { out.push(row); continue; }
      if ((!auto || src.autoImport === false) && !forced) { out.push({ ...row, status: 'importable', sensitiveSkipped: planAgentInstructionEntries(src, read, displayPath).skippedSensitive }); continue; }
      await removeAgentInstructionEntries(src.key, record);
      const written = await writeAgentInstructionEntries(src, read, displayPath);
      state.sources[src.key] = { key: src.key, file: read.file, sourceHash: read.hash, importedAt: written.importedAt, entries: written.entries, dismissed: false, skippedSensitive: written.skippedSensitive, scanVersion: AGENT_INSTRUCTION_SCAN_VERSION };
      dirty = true;
      logEvent({ kind: 'agent_instructions_import', source: src.key, entries: written.entries.length, reason: forced ? 'explicit' : 'auto', skippedSensitive: written.skippedSensitive });
      out.push({ ...row, status: 'imported', entries: written.entries.length, coreEntries: written.entries.filter(e => e.core).length, importedAt: written.importedAt, sensitiveSkipped: written.skippedSensitive });
    }
    if (dirty) await writeAgentInstructionState(state);
    return { ok: true, sources: out };
  }

  return {
    syncAgentInstructionImports, planAgentInstructionEntries, agentInstructionSources, readAgentInstructionSource,
    splitAgentInstructionText, renderAgentInstructionMemory, agentInstructionMemoryId, agentInstructionImportFile, sha256Hex,
  };
}

module.exports = { createAgentInstructionImports, filterMemoryForNativeCli };
