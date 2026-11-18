'use strict';

function createStewardMemoryPanel({ policy, store, runtime }) {
  const { STEWARD_MEMORY_KINDS, STEWARD_MEMORY_LIMITS, STEWARD_MEMORY_NEW_WINDOW_MS, STEWARD_MEMORY_SCHEMA, memoryIsExpired, memoryProposalLooksSensitive } = policy;
  const { stewardMemoryScopeLabel, stewardMutateMemory, stewardReadMemoryStore } = store;
  const { nowIso, readConfig, stewardAppendDecision, stewardFail, stewardSanitizeText } = runtime;

  // ── 记忆面板(六条 token 级路由的域实现;不是工具,模型碰不到)─────────────────────────────
  // 「新」标 isNew 是【纯派生】:createdAt 距今 < 24 小时。不落任何新字段 —— 否则 24 小时后还得有人
  // 回来把它擦掉,而那个「有人」在真实系统里从来不存在。
  function stewardMemoryPanelRow(entry, now, panelConfig) {
    const createdMs = Date.parse(String(entry.createdAt || ''));
    return {
      ...entry,
      isNew: Number.isFinite(createdMs) && (now - createdMs) < STEWARD_MEMORY_NEW_WINDOW_MS,
      // 126-M02:面板【照常列出】过期条目,只是带上标记 —— 时效是过滤不是删除(44 号文 §6 ②)。
      // 判据仍然只有一处:06d 的 memoryIsExpired,本文件不自己解析日期。
      expired: memoryIsExpired(entry, now),
      // 126-M01:作用域的人话标签(纯派生;scope 本身随 ...entry 已经带出)。
      scopeLabel: stewardMemoryScopeLabel(entry.scope, panelConfig).replace(/^,/, ''),
    };
  }

  async function stewardMemoryPanelList(kindArg) {
    const kind = String(kindArg || '');
    if (kind && !STEWARD_MEMORY_KINDS.includes(kind)) {
      return stewardFail('invalid_request', `kind must be one of ${STEWARD_MEMORY_KINDS.join('/')}`);
    }
    const store = await stewardReadMemoryStore();
    // 126-M01:作用域标签要认工作区表。面板是冷路径,读一次配置不心疼。
    const panelConfig = await readConfig().catch(() => ({}));
    const now = Date.now();
    const groups = {};
    for (const k of STEWARD_MEMORY_KINDS) if (!kind || k === kind) groups[k] = [];
    let total = 0, active = 0, vetoed = 0, isNewCount = 0;
    for (const entry of store.entries) {
      total += 1;
      if (entry.state === 'vetoed') vetoed += 1; else active += 1;
      if (kind && entry.kind !== kind) continue;
      if (!Object.prototype.hasOwnProperty.call(groups, entry.kind)) continue;
      const row = stewardMemoryPanelRow(entry, now, panelConfig);
      if (row.isNew) isNewCount += 1;
      groups[entry.kind].push(row);
    }
    for (const k of Object.keys(groups)) {
      groups[k].sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
    }
    return { ok: true, kind: kind || '', groups, counts: { total, active, vetoed, isNew: isNewCount }, updatedAt: store.updatedAt };
  }

  // 面板改的条目:置信度拉满(用户亲手写的比管家推断的准),来源标 user_panel。version 是乐观锁 ——
  // 传 updatedAt 原值,与库里对不上就 version_conflict(面板开着的时候管家可能刚合并过同一条)。
  async function stewardMemoryPanelEdit(body) {
    const id = String((body && body.id) || '');
    if (!id) return stewardFail('invalid_request', 'id is required');
    const text = stewardSanitizeText(body && body.text).trim();
    if (!text) return stewardFail('invalid_request', 'text is required');
    if (text.length > STEWARD_MEMORY_LIMITS.textChars) {
      return stewardFail('invalid_request', `text must be at most ${STEWARD_MEMORY_LIMITS.textChars} characters`);
    }
    const kind = body && body.kind ? String(body.kind) : '';
    if (kind && !STEWARD_MEMORY_KINDS.includes(kind)) {
      return stewardFail('invalid_request', `kind must be one of ${STEWARD_MEMORY_KINDS.join('/')}`);
    }
    // 用户亲手写的也过敏感过滤:面板不是绕过密钥拒收的后门。
    if (memoryProposalLooksSensitive({ body: text })) {
      return stewardFail('sensitive_rejected', 'the text looks like a credential/secret and will never be stored in steward memory');
    }
    const version = body && body.version != null ? String(body.version) : '';
    return stewardMutateMemory(async store => {
      const entry = store.entries.find(e => e.id === id);
      if (!entry) return { persist: false, result: stewardFail('not_found', `memory ${stewardSanitizeText(id)} not found`) };
      if (version && String(entry.updatedAt || '') !== version) {
        return { persist: false, result: stewardFail('version_conflict', 'this entry changed since you loaded it; reload the panel and edit again', { version: entry.updatedAt }) };
      }
      entry.text = text;
      if (kind) entry.kind = kind;
      entry.confidence = 1;
      entry.sourceSessionId = 'user_panel';
      delete entry.basis; delete entry.sourceToolCallId;
      entry.sourceSeq = 0;
      entry.sourceQuote = ''; // 用户在面板里亲手改的:出处就是用户本人,不再挂着改前那句引文
      entry.updatedAt = nowIso();
      stewardAppendDecision({ tool: 'steward_memory_panel_edit', args: { id, chars: text.length, kind: entry.kind }, targetSessionId: '', permissionMode: '', mayAct: 'user', undoRef: { kind: 'memory', id, prev: null }, basis: { memoryIds: [id] } });
      return { persist: true, result: { ok: true, entry: stewardMemoryPanelRow(entry, Date.now(), await readConfig().catch(() => ({}))) } };
    });
  }

  async function stewardMemoryPanelRestore(idArg) {
    const id = String(idArg || '');
    if (!id) return stewardFail('invalid_request', 'id is required');
    return stewardMutateMemory(async store => {
      const entry = store.entries.find(e => e.id === id);
      if (!entry) return { persist: false, result: stewardFail('not_found', `memory ${stewardSanitizeText(id)} not found`) };
      if (entry.state === 'active') return { persist: false, result: { ok: true, id, state: 'active', restored: false } };
      entry.state = 'active';
      entry.updatedAt = nowIso();
      stewardAppendDecision({ tool: 'steward_memory_panel_restore', args: { id }, targetSessionId: '', permissionMode: '', mayAct: 'user', undoRef: { kind: 'memory', id, prev: 'vetoed' }, basis: { memoryIds: [id] } });
      return { persist: true, result: { ok: true, id, state: 'active', restored: true } };
    });
  }

  // 清空:confirm 必须【逐字】等于 'clear'(同 DELETE /api/skills 的「输入 id 才解锁」摩擦)。
  async function stewardMemoryPanelClear(confirm) {
    if (String(confirm) !== 'clear') return stewardFail('invalid_request', "confirm must be exactly 'clear'");
    return stewardMutateMemory(async store => {
      const removed = store.entries.length;
      store.entries = [];
      stewardAppendDecision({ tool: 'steward_memory_panel_clear', args: { removed }, targetSessionId: '', permissionMode: '', mayAct: 'user', undoRef: null, basis: {} });
      return { persist: true, result: { ok: true, removed } };
    });
  }

  // 导出:只含 active,字段就是条目本身那几个(不含 isNew 这类派生视图字段,也不含任何别处的东西)。
  async function stewardMemoryPanelExport() {
    const store = await stewardReadMemoryStore();
    return {
      ok: true,
      schema: STEWARD_MEMORY_SCHEMA,
      exportedAt: nowIso(),
      entries: store.entries.filter(e => e.state === 'active'),
    };
  }

  return { stewardMemoryPanelList, stewardMemoryPanelEdit, stewardMemoryPanelRestore, stewardMemoryPanelClear, stewardMemoryPanelExport };
}

module.exports = { createStewardMemoryPanel };
