'use strict';
const fsp = require('node:fs/promises');
const path = require('node:path');

const STEWARD_MEMORY_FILE = 'memory-v1.json';
const STEWARD_MEMORY_SCHEMA = 1;
const STEWARD_MEMORY_MERGED_FROM_MAX = 5;

function createStewardMemoryStore({
  stewardDir, nowIso, safeJsonParse, atomicWriteJson, projectKeyForCwd, cleanMemoryDate,
  STEWARD_MEMORY_KINDS, STEWARD_MEMORY_LIMITS, stewardSanitizeText,
}) {
  // ── 126-M01(44 号文 §1.2 / §6 ①):记忆的作用域 ──────────────────────────────────────
  // 取值两态:空串 = 全局;`project:<16 位十六进制>` = 只在那个项目里成立。键复用工作台库的
  // projectKeyForCwd(06d,后向边)—— **两库同一口径**,与 M02 复用 memoryIsExpired 是同一条理由。
  //
  // **键永远由服务端从一条真实会话的 cwd 推出来,模型只说「这条是不是项目级的」**。这一条是故意的:
  // 31 号文 §2.6 的红线要的是「用户自己说的稳定事实」,让模型自己填一个项目键 = 让它推断
  // 「这条管得着谁」,正是那条红线禁止的事。
  //
  // 非法值一律回落全局 —— **绝不静默当成某个项目**(那会让一条本该到处成立的偏好凭空消失一半)。
  const STEWARD_SCOPE_PROJECT_PREFIX = 'project:';
  function stewardMemoryScopeOf(cwd) {
    const key = cwd ? projectKeyForCwd(cwd) : '';
    return key ? STEWARD_SCOPE_PROJECT_PREFIX + key : '';
  }
  function stewardNormalizeMemoryScope(raw) {
    const value = String(raw || '');
    if (!value.startsWith(STEWARD_SCOPE_PROJECT_PREFIX)) return '';
    const key = value.slice(STEWARD_SCOPE_PROJECT_PREFIX.length);
    return /^[0-9a-f]{16}$/.test(key) ? value : '';
  }
  // 「这条记忆在这个作用域里算不算数」的**唯一判据口**。全局条目到处算数;项目条目只在同一个
  // 项目里算数。scope 传空 = 不按作用域筛(管家本来就是跨项目的看护者,见 §7 ④ 的拍板)。
  function stewardMemoryScopeMatches(entry, scope) {
    const own = stewardNormalizeMemoryScope(entry && entry.scope);
    if (!own) return true;
    const want = stewardNormalizeMemoryScope(scope);
    return !want ? true : own === want;
  }
  // 126-M01:把作用域键翻成人看得懂的项目名。**纯展示派生,不是第二套判据** —— 判据在 06i 的
  // stewardMemoryScopeMatches,本函数只负责「这一条该怎么说出来」。配置里的工作区表能对上就报名字,
  // 对不上就报键的前 8 位(绝不编一个名字出来)。
  function stewardMemoryScopeLabel(scope, config) {
    const normalized = stewardNormalizeMemoryScope(scope);
    if (!normalized) return '';
    const rows = [...(Array.isArray(config && config.workspaces) ? config.workspaces : []),
      ...(Array.isArray(config && config.recentWorkspaces) ? config.recentWorkspaces : [])];
    for (const row of rows) {
      const cwd = typeof row === 'string' ? row : String((row && row.cwd) || '');
      if (cwd && stewardMemoryScopeOf(cwd) === normalized) {
        return `,只在「${stewardSanitizeText(cwd.split(/[\\/]/).filter(Boolean).pop() || cwd)}」里成立`;
      }
    }
    return `,只在某个项目里成立(${normalized.slice('project:'.length, 'project:'.length + 8)})`;
  }

  // ── 管家记忆存储(§4)────────────────────────────────────────────────────────────────────
  const stewardMemoryPath = () => path.join(stewardDir(), STEWARD_MEMORY_FILE);
  let stewardMemoryChain = Promise.resolve();
  function stewardEmptyMemoryStore() { return { schema: STEWARD_MEMORY_SCHEMA, updatedAt: '', entries: [] }; }
  function stewardNormalizeMemoryEntry(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = String(raw.id || '');
    const kind = String(raw.kind || '');
    const text = String(raw.text || '');
    if (!id || !STEWARD_MEMORY_KINDS.includes(kind) || !text) return null;
    const confidence = Number(raw.confidence);
    return {
      id,
      kind,
      text: text.slice(0, STEWARD_MEMORY_LIMITS.textChars),
      confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.6,
      sourceSessionId: String(raw.sourceSessionId || ''),
      sourceSeq: Math.max(0, Number(raw.sourceSeq) || 0),
      // 走查 #14:凭哪句用户原话记的(steward_memory_write 的 sourceRef.quote,服务端已逐字核对过)。老条目没有 -> 空串,存量零迁移。
      sourceQuote: String(raw.sourceQuote || '').slice(0, STEWARD_MEMORY_LIMITS.quoteChars),
      ...(raw.basis === 'activity' ? { basis: 'activity', sourceToolCallId: String(raw.sourceToolCallId || '').slice(0, 200) } : {}),
      createdAt: String(raw.createdAt || ''),
      updatedAt: String(raw.updatedAt || ''),
      lastUsedAt: String(raw.lastUsedAt || ''),
      useCount: Math.max(0, Number(raw.useCount) || 0),
      state: raw.state === 'vetoed' ? 'vetoed' : 'active',
      // 126-M02(44 号文 §1.2):条目的时效。清洗与判据【都不在这儿】—— 复用工作台库
      // (06d)已有的 cleanMemoryDate / memoryIsExpired,那两个原语只读 .expiresAt,与条目形状无关。
      // 这就是本波说的「两库职责划分」:两套存储,一套「什么叫过期」的判据。
      // 老条目没有这个字段 -> 读成空串 -> 永不过期,与今天逐字节同义(存量零迁移,同 mergedFrom 的模具)。
      expiresAt: cleanMemoryDate(raw.expiresAt),
      // 126-M01:作用域。空串 = 全局;非法值一律回落全局(绝不静默当成某个项目)。判据与归一都在 06i,
      // 本文件不自己解析 —— 与 expiresAt 同一条纪律。老条目没有这个字段 -> 读成空串 = 全局,存量零迁移。
      scope: stewardNormalizeMemoryScope(raw.scope),
      // 128h-J12:这条曾被用户否决、又经用户在某个回合里明说而复活(steward_memory_write 带
      // supersedesVetoed)。只留一个标记,面板与决策日志据此能说清「它回来过」。空串 = 没发生过,
      // 老条目读成空串 —— 存量零迁移,与 mergedFrom / expiresAt 同一个模具。
      revivedFrom: raw.revivedFrom === 'vetoed' ? 'vetoed' : '',
      // 116-2e(§4 ⑥ 去重合并):被并进本条的来源 ref,最多 5 个(先进先出)。老条目没有这个字段,
      // 读成空数组 —— 存量零迁移。
      mergedFrom: Array.isArray(raw.mergedFrom)
        ? raw.mergedFrom
          .filter(r => r && typeof r === 'object')
          .slice(-STEWARD_MEMORY_MERGED_FROM_MAX)
          .map(r => ({ sessionId: String(r.sessionId || ''), turnSeq: Math.max(0, Number(r.turnSeq) || 0), at: String(r.at || ''),
            ...(r.toolCallId ? { toolCallId: String(r.toolCallId).slice(0, 200) } : {}) }))
        : [],
    };
  }
  async function stewardReadMemoryStore() {
    let raw = null;
    try { raw = safeJsonParse(await fsp.readFile(stewardMemoryPath(), 'utf8'), null); } catch { raw = null; }
    // 损坏/缺失/错 schema = 空库(不抢救、不 mkdir):记忆是旁路增强,坏了不该拖住任何回合。
    if (!raw || raw.schema !== STEWARD_MEMORY_SCHEMA || !Array.isArray(raw.entries)) return stewardEmptyMemoryStore();
    // 生效条与被否决条【各自】封顶 maxEntries:写入闸只数生效条(13l),修前读库却把【总条数】截在 maxEntries ——
    // 200 条生效 + 否决过 1 条后再写,新条落在第 201 位,写入回 ok:true、读回来却没了,下一次写盘就永久丢掉。
    // 被否决条要留着(去重闸靠它挡「否决过的话换个说法再写回来」),超出时留最近的那些。原顺序不变。
    const normalized = [];
    for (const item of raw.entries) {
      const entry = stewardNormalizeMemoryEntry(item);
      if (entry) normalized.push(entry);
    }
    const cap = STEWARD_MEMORY_LIMITS.maxEntries;
    let activeLeft = cap;
    let vetoedSkip = Math.max(0, normalized.filter(e => e.state === 'vetoed').length - cap);
    const entries = normalized.filter(e => {
      if (e.state === 'vetoed') { if (vetoedSkip > 0) { vetoedSkip -= 1; return false; } return true; }
      if (activeLeft <= 0) return false;
      activeLeft -= 1;
      return true;
    });
    return { schema: STEWARD_MEMORY_SCHEMA, updatedAt: String(raw.updatedAt || ''), entries };
  }
  // 读-改-写全程串在一条 per-process 链上(同 usage/inbox 纪律),两次并发写不会互相盖掉。
  function stewardMutateMemory(mutator) {
    const next = stewardMemoryChain.then(async () => {
      const store = await stewardReadMemoryStore();
      const outcome = await mutator(store);
      if (outcome && outcome.persist) {
        store.updatedAt = nowIso();
        await fsp.mkdir(stewardDir(), { recursive: true });
        await atomicWriteJson(stewardMemoryPath(), store);
      }
      return outcome ? outcome.result : null;
    });
    stewardMemoryChain = next.catch(() => {});
    return next;
  }

  return {
    stewardMemoryScopeOf, stewardNormalizeMemoryScope, stewardMemoryScopeMatches, stewardMemoryScopeLabel,
    stewardReadMemoryStore, stewardMutateMemory,
  };
}

module.exports = { createStewardMemoryStore, STEWARD_MEMORY_SCHEMA, STEWARD_MEMORY_MERGED_FROM_MAX };
