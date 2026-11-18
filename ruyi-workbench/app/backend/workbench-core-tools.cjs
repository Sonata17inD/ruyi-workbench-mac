'use strict';

function createWorkbenchCoreTools({
  RUNTIME, httpRequest, loadSession, logEvent, nowIso, readConfig, safeJsonParse, safeSessionId,
  buildWorkbenchSelfStatus, memory, context, journal, catalog,
}) {
  const {
    listWorkbenchMemories, proposeMemoryRelationRevoke, proposeMemoryRelationTool, proposeMemoryRevision,
    proposeWorkbenchMemory, readWorkbenchMemory,
  } = memory;
  const {
    SESSION_SCRATCHPAD_LIMITS, boundedReadPage, normalizeScratchpadKey, normalizeScratchpadText,
    normalizeTodoItems, observationRecallEnabled, providerTurnQuotaKey, readSessionScratchpad,
    rehydrateObservation, scratchpadTotalChars, updateAutomaticThreadTitle, updateSessionScratchpad,
  } = context;
  const { JOURNAL_KEEP_TURNS, journalReadIndex, journalRevertLogRead } = journal;
  const {
    adaptiveCatalogForMcp, compareToolRetrievalShadow, invokeAdaptiveMcpTool, listCompactTools,
    policyDesktopOverrideFor, searchToolCatalog,
  } = catalog;

  // 105a: observation_recall 每回合配额。回合键见 10 providerTurnQuotaKey(优先 turnSeq —— 修前用 user 消息数,
  // L2 重播种一改条数配额就清零);每会话只保留最近 4 个桶,全局最多 64 个会话,先进先出。
  const OBSERVATION_RECALL_QUOTA = 8;
  const OBSERVATION_RECALL_MAX_CHARS = { min: 1000, max: 60000, dflt: 8000 };
  const _recallQuota = new Map(); // sessionId -> Map(turnKey -> used)
  function observationRecallQuotaTake(sessionId, turnKey) {
    let buckets = _recallQuota.get(sessionId);
    if (!buckets) { buckets = new Map(); _recallQuota.set(sessionId, buckets); }
    while (_recallQuota.size > 64) _recallQuota.delete(_recallQuota.keys().next().value);
    if (!buckets.has(turnKey)) {
      buckets.set(turnKey, 0);
      while (buckets.size > 4) buckets.delete(buckets.keys().next().value);
    }
    const used = buckets.get(turnKey);
    if (used >= OBSERVATION_RECALL_QUOTA) return false;
    buckets.set(turnKey, used + 1);
    return true;
  }
  function observationRecallError(err) {
    const s = String(err || '');
    if (s === 'invalid rawRef' || s === 'invalid session id') return 'invalid_ref';
    if (s === 'observation hash mismatch') return 'hash_mismatch';
    return 'not_found'; // 'observation not found' / ENOENT(快照已被 GC) / 其它读取失败
  }

  // C4(61 号文):checkpoint_list —— 当前会话文件改动检查点的【只读】视图。数据 = 02 的检查点索引(index.json:还能撤销的)
  // + 撤销记录(reverts.json:用户已经在界面撤销的,journalRevertLogRead)。按 (turnSeq, tool, op) 分组成行 ——
  // 一次解压几千个文件也只是一行(path 取主路径、files 给个数、paths 给至多 5 个样例)。不给模型回滚能力:二次写盘会覆盖用户之后的手改、
  // 与活回合抢写、绕过用户的决定;撤销只能由用户在界面做,模型能做的是告诉用户「第几回合的哪次修改可以撤销」。
  const CHECKPOINT_LIST_LIMIT = Object.freeze({ dflt: 20, max: 50 });
  const CHECKPOINT_LIST_PATHS_MAX = 5;
  async function checkpointListResult(sessionId, args) {
    const rawTurn = args && args.turnSeq;
    const turnFilter = (rawTurn === undefined || rawTurn === null || rawTurn === '') ? null : Number(rawTurn);
    if (turnFilter !== null && !(Number.isSafeInteger(turnFilter) && turnFilter >= 0)) {
      return { ok: false, error: 'invalid_turnSeq', message: 'turnSeq must be a non-negative integer (a turn number as shown in the checkpoint rows)' };
    }
    const rawLimit = Number(args && args.limit);
    const limit = Number.isFinite(rawLimit) ? Math.min(CHECKPOINT_LIST_LIMIT.max, Math.max(1, Math.floor(rawLimit))) : CHECKPOINT_LIST_LIMIT.dflt;
    const [index, reverts] = await Promise.all([journalReadIndex(sessionId), journalRevertLogRead(sessionId)]);
    const opOf = v => (v === 'create' || v === 'delete' ? v : 'modify');
    const live = new Map();
    for (const e of index) {
      if (!e || !Number.isSafeInteger(Number(e.turnSeq)) || !Number.isSafeInteger(Number(e.entrySeq)) || typeof e.path !== 'string' || !e.path) continue;
      if (turnFilter !== null && Number(e.turnSeq) !== turnFilter) continue;
      const op = opOf(e.op), tool = typeof e.tool === 'string' ? e.tool : '';
      const key = `${Number(e.turnSeq)}|${tool}|${op}`;
      let g = live.get(key);
      if (!g) { g = { turnSeq: Number(e.turnSeq), entrySeq: Number(e.entrySeq), lastSeq: Number(e.entrySeq), tool, op, entries: [], at: '', skipped: new Set() }; live.set(key, g); }
      g.entries.push({ entrySeq: Number(e.entrySeq), path: e.path });
      if (Number(e.entrySeq) < g.entrySeq) g.entrySeq = Number(e.entrySeq);
      if (Number(e.entrySeq) > g.lastSeq) g.lastSeq = Number(e.entrySeq);   // 排序按本组最新一条
      if (typeof e.ts === 'string' && e.ts > g.at) g.at = e.ts;
      if (e.skipped) g.skipped.add(e.path);   // 改动前的内容没存下来(超 5MB):这一条撤销不了
    }
    const rows = [];
    for (const g of live.values()) {
      const paths = [...new Set(g.entries.sort((a, b) => a.entrySeq - b.entrySeq).map(x => x.path))];
      rows.push({ sortSeq: g.lastSeq, row: { turnSeq: g.turnSeq, entrySeq: g.entrySeq, tool: g.tool, op: g.op, path: paths[0],
        ...(paths.length > 1 ? { files: paths.length, paths: paths.slice(0, CHECKPOINT_LIST_PATHS_MAX) } : {}),
        at: g.at, undoable: g.skipped.size === 0, ...(g.skipped.size ? { notUndoable: g.skipped.size } : {}), reverted: false } });
    }
    const gone = new Map();
    for (const r of reverts) {
      if (turnFilter !== null && r.turnSeq !== turnFilter) continue;
      const key = `${r.turnSeq}|${r.tool}|${r.op}`;
      let g = gone.get(key);
      if (!g) { g = { turnSeq: r.turnSeq, entrySeq: r.entrySeq, tool: r.tool, op: r.op, paths: [], files: 0, at: '', revertedAt: '' }; gone.set(key, g); }
      g.files += r.files;
      for (const p of r.paths) if (g.paths.length < CHECKPOINT_LIST_PATHS_MAX && !g.paths.includes(p)) g.paths.push(p);
      if (r.entrySeq >= 0 && (g.entrySeq < 0 || r.entrySeq < g.entrySeq)) g.entrySeq = r.entrySeq;
      if (r.at > g.at) g.at = r.at;
      if (r.revertedAt > g.revertedAt) g.revertedAt = r.revertedAt;
    }
    for (const g of gone.values()) {
      rows.push({ sortSeq: g.entrySeq, row: { turnSeq: g.turnSeq, entrySeq: g.entrySeq, tool: g.tool, op: g.op, path: g.paths[0] || '',
        ...(g.files > 1 ? { files: g.files, paths: g.paths } : {}),
        at: g.at || g.revertedAt, undoable: false, reverted: true, revertedAt: g.revertedAt } });
    }
    rows.sort((a, b) => b.row.turnSeq - a.row.turnSeq || (a.row.reverted === b.row.reverted ? 0 : a.row.reverted ? 1 : -1) || b.sortSeq - a.sortSeq);
    const shown = rows.slice(0, limit).map(x => x.row);
    return {
      ok: true, total: rows.length, shown: shown.length, ...(rows.length > shown.length ? { truncated: true } : {}), checkpoints: shown,
      note: `Read-only; newest turn first; only the last ${JOURNAL_KEEP_TURNS} turns are kept. You cannot roll back: only the user can undo, in the UI (the turn's change card). Tell them which turn's change is undoable. reverted:true = the user already undid it and the file is back to its pre-change state, so re-read it before relying on it.`,
    };
  }

  // C2(61 号文):会话草稿本(存储与限额在 02,回注在 09/10)。授权:会话【只】取 ctx,且只认会话自己的主回合 ——
  // 09 在主回合的 toolCall ctx 上带 mainTurn:true。08 子代理的 ctx 也带着父会话的 session 却不带这个标记,MCP 子进程 ctx 为空,
  // /api/tools 直调的 ctx 只有 sessionId/session —— 一律拒:草稿本只属于这条对话的主线,子代理写进去就成了绕过主线的持久回注。
  // 管家会话:07 不发、09 的闸只放 steward_*,这里是第三道。参数里永远不接受会话 id。
  const SCRATCHPAD_WRITE_NOTE = 'Saved. The scratchpad is re-shown after the latest user message from the next turn on and survives context compaction; within this turn, this result is the current state.';
  async function scratchpadWriteTool(args, ctx) {
    const session = ctx && ctx.mainTurn === true ? ctx.session : null;
    if (RUNTIME.isMcpChild || !session || !safeSessionId(session.id) || session.kind === 'steward') {
      return { ok: false, code: 'scratchpad-unavailable', error: 'scratchpad_write is only available in the main turn of a model-provider conversation (not in sub-agents, the steward or CLI engines)' };
    }
    const L = SESSION_SCRATCHPAD_LIMITS;
    const limits = { maxNotes: L.maxEntries, maxCharsPerNote: L.maxTextChars, maxTotalChars: L.maxTotalChars };
    const op = String(args.op == null || args.op === '' ? 'write' : args.op).trim().toLowerCase();
    if (op === 'list') {
      const entries = await readSessionScratchpad(session.id);
      return { ok: true, op: 'list', count: entries.length, totalChars: scratchpadTotalChars(entries), limits, entries: entries.map(e => ({ key: e.key, text: e.text, at: e.at })) };
    }
    const invalid = (error, hint) => ({ ok: false, code: 'invalid-arguments', tool: 'scratchpad_write', error: `scratchpad_write: ${error}`, hint });
    if (op !== 'write') return invalid(`op must be "write" or "list" (got ${JSON.stringify(op)})`, 'omit op to write; op:"list" returns every note');
    const key = normalizeScratchpadKey(args.key);
    if (!key) return invalid('key is required', 'pass {key, text}; text "" deletes the note');
    if (key.length > L.maxKeyChars) return invalid(`key is ${key.length} chars; keys are limited to ${L.maxKeyChars}`, 'use a short name such as "plan" or "facts"');
    if (args.text == null) return invalid('text is required (pass "" to delete the note)', 'pass {key, text}');
    const text = normalizeScratchpadText(args.text);
    if (text.length > L.maxTextChars) {
      return { ok: false, code: 'scratchpad-limit', limit: 'note', error: `the note is ${text.length} chars; each note is limited to ${L.maxTextChars}`, hint: 'shorten it, or split it across several keys', limits };
    }
    const r = await updateSessionScratchpad(session, entries => {
      const i = entries.findIndex(e => e.key === key);
      if (!text) {
        if (i < 0) return { entries, changed: false, action: 'absent' };
        entries.splice(i, 1);
        return { entries, changed: true, action: 'deleted' };
      }
      if (i >= 0 && entries[i].text === text) return { entries, changed: false, action: 'unchanged' };
      if (i < 0 && entries.length >= L.maxEntries) return { refused: 'notes' };
      const note = { key, text, at: nowIso() };
      const next = i >= 0 ? entries.map((e, j) => (j === i ? note : e)) : entries.concat([note]);
      const total = scratchpadTotalChars(next);
      if (total > L.maxTotalChars) return { refused: 'total', total };
      return { entries: next, changed: true, action: i >= 0 ? 'updated' : 'created' };
    });
    const entries = Array.isArray(r.entries) ? r.entries : [];
    const state = { count: entries.length, totalChars: scratchpadTotalChars(entries), keys: entries.map(e => e.key) };
    if (r.refused === 'session-deleted') return { ok: false, code: 'scratchpad-unavailable', error: 'this conversation has been deleted' };
    if (r.refused === 'notes') {
      return { ok: false, code: 'scratchpad-limit', limit: 'notes', error: `the scratchpad already holds ${entries.length} notes (limit ${L.maxEntries})`, hint: 'delete a note you no longer need (text ""), or merge into an existing key', limits, ...state };
    }
    if (r.refused === 'total') {
      return { ok: false, code: 'scratchpad-limit', limit: 'total', error: `this write would bring the scratchpad to ${r.total} chars (limit ${L.maxTotalChars} in total)`, hint: 'shorten notes or delete ones you no longer need, then write again', limits, ...state };
    }
    const note = r.action === 'absent' ? 'no note with this key; nothing was deleted'
      : r.action === 'unchanged' ? 'same text as the existing note; nothing changed'
      : r.action === 'deleted' ? 'Deleted. ' + SCRATCHPAD_WRITE_NOTE.slice('Saved. '.length)
      : SCRATCHPAD_WRITE_NOTE;
    return { ok: true, op: 'write', key, action: r.action, ...state, note };
  }

  // 第41波(V2.0「立柱」41a): toolCall() 50 分支 switch → 分组表驱动注册表。
  // 每个工具声明 { paths, guardNote, handler }:
  //   paths: 'read'|'write'|'both' → handler 内必须对模型给定路径过 guardFileToolPath(read=读闸/write=写闸/both=双闸);
  //          'conditional' → 仅当模型给定路径参数时过闸(缺省落应用自选目录,录在案);
  //          null → 不触文件路径,guardNote 必须录理由(exec 权限门/纯网络/loopback/设计豁免)。
  // 41b 行为锁(dev-harness/tool-dispatch.e2e.js): edit/exec 级且 paths 非 null 的条目,handler 源必须含 guard
  // 调用;paths:null 必须有非空 guardNote;注册表键集 === NATIVE_TOOL_PACKS 键集(目录漂移=锁红)。
  // 新工具忘了声明 = 锁红 —— archive 漏 guard(第27波)、desktop_screenshot 越界写(第36波)这类漏审整类收口。
  async function workbenchMemoryReadLoopback(name, args) {
    const sessionId = safeSessionId(process.env.WCW_SESSION_ID || '');
    const session = sessionId ? await loadSession(sessionId).catch(() => null) : null;
    if (!session) return { ok: false, error: 'memory session unavailable' };
    try {
      const response = await httpRequest({ url: `http://${process.env.WCW_HOST || '127.0.0.1'}:${process.env.WCW_PORT}/api/tools/${name}`,
        method: 'POST', headers: { 'content-type': 'application/json', 'x-wcw-token': process.env.WCW_TOKEN }, timeoutMs: 15000, maxBodyChars: 300000,
        body: JSON.stringify({ ...args, sessionId, turnSeq: session.turnSeq, memoryLiveRead: true }) });
      const data = safeJsonParse(response.body, null);
      return data && data.ok && data.result || { ok: false, error: 'memory parent read unavailable' };
    } catch { return { ok: false, error: 'memory parent read unavailable' }; }
  }

  const CORE_TOOL_HANDLERS = {
    workbench_memory_list: { paths: null, guardNote: "工作台自有记忆元数据检索,范围固定在 dataRoot/memory", handler: async (args, ctx) => {
        if (RUNTIME.isMcpChild && process.env.WCW_PORT && process.env.WCW_TOKEN) return workbenchMemoryReadLoopback('workbench_memory_list', args);
        return listWorkbenchMemories(args, ctx);
    } },
    workbench_memory_read: { paths: null, guardNote: "按受校验 id 读取 dataRoot/memory 内工作台记忆,不接受任意路径", handler: async (args, ctx) => {
        if (RUNTIME.isMcpChild && process.env.WCW_PORT && process.env.WCW_TOKEN) return workbenchMemoryReadLoopback('workbench_memory_read', args);
        return readWorkbenchMemory(args, ctx);
    } },
    workbench_memory_propose: { paths: null, guardNote: "仅写待用户确认的候选元数据,不直接写入记忆库", handler: async (args, ctx) => {
        return proposeWorkbenchMemory(args, ctx);
    } },
    workbench_memory_relation_propose: { paths: null, guardNote: "仅写待用户确认的关系候选,不直接写入关系边", handler: async (args, ctx) => {
        return proposeMemoryRelationTool(args, ctx);
    } },
    workbench_memory_revise: { paths: null, guardNote: "仅写待用户确认的修改建议,不直接覆盖记忆", handler: async (args, ctx) => {
        return proposeMemoryRevision(args, ctx);
    } },
    workbench_memory_relation_revoke: { paths: null, guardNote: "仅写待用户确认的撤销建议,不直接删除关系边", handler: async (args, ctx) => {
        return proposeMemoryRelationRevoke(args, ctx);
    } },
    observation_recall: { paths: null, guardNote: "105a: 只读当前会话 checkpoints 快照还原内核(rehydrateObservation 自带格式+内容 hash 校验);sessionId 取自 ctx/WCW_SESSION_ID 而非参数,不触文件路径;双开关 fail-closed", handler: async (args, ctx) => {
        const config = await readConfig();
        if (!observationRecallEnabled(config)) {
          return { ok: false, error: 'disabled', message: 'observation_recall is disabled (requires runtimeObservationRecallV1 + runtimeObservationReducerV1)' };
        }
        // 授权:会话归属只取 ctx / 桥 env,绝不接受 args 传入 —— rawRef 只能解析当前会话的快照。
        const session = (ctx && ctx.session) || null;
        const sessionId = String((session && session.id) || process.env.WCW_SESSION_ID || '');
        if (!sessionId) return { ok: false, error: 'not_found', message: 'no current session to resolve rawRef against' };
        // 精简视图里印的是 `rawRef=history:…`,模型常连前缀、引号、换行一起抄回来:先剥掉再认。形状不对的直接回
        // invalid_ref,【不】扣本回合配额(修前先扣后判,8 次抄错之后正确的 ref 也只能拿到 quota_exceeded)。
        const rawRef = String(args && args.rawRef || '').trim().replace(/^["'`]+|["'`]+$/g, '').replace(/^rawRef\s*[=:]\s*/i, '').trim();
        if (!/^history:\d+:[a-f0-9]{16}:\d+:[a-f0-9]{16}$/.test(rawRef)) {
          return { ok: false, error: 'invalid_ref', message: 'rawRef must look like history:<turn>:<hash16>:<index>:<hash16> (copy it exactly from the reduced observation, without the "rawRef=" label)' };
        }
        const turnKey = providerTurnQuotaKey(session);
        if (!observationRecallQuotaTake(sessionId, turnKey)) {
          return { ok: false, error: 'quota_exceeded', message: `observation_recall quota exhausted for this turn (${OBSERVATION_RECALL_QUOTA}); do not retry the same ref` };
        }
        const result = await rehydrateObservation(sessionId, rawRef);
        if (!result.ok) {
          const code = observationRecallError(result.error);
          // 快照文件不在了(ENOENT)时,裸「ENOENT」对模型没有可行动信息(它会以为是引擎故障、反复重试同一个 rawRef)。
          // 点明:原件已不可取回、视图里的头尾是仅存的内容、该怎么办(重跑当初那次工具调用)、别重试同一 rawRef。信封 error 码不变。
          const gone = result.error === 'ENOENT'
            ? ' — the raw snapshot is no longer on disk (removed by the checkpoint size cap or the session folder was moved/deleted), so this original cannot be recovered; do not retry the same rawRef. Re-run the original tool call (same query/url/path) to get the content again.'
            : '';
          return { ok: false, error: code, message: `observation recall failed: ${result.error}${gone}` };
        }
        const raw = Number(args && args.maxChars);
        const maxChars = Number.isFinite(raw) ? Math.min(OBSERVATION_RECALL_MAX_CHARS.max, Math.max(OBSERVATION_RECALL_MAX_CHARS.min, Math.round(raw))) : OBSERVATION_RECALL_MAX_CHARS.dflt;
        const original = String(result.content || '');
        return boundedReadPage(original, args && args.offset, maxChars, (content, end, offset) => ({
          ok: true, content, toolCallId: result.toolCallId, rawRef: result.rawRef,
          originalChars: original.length, totalChars: original.length, offset, truncated: end < original.length,
          ...(end < original.length ? { nextOffset: end } : {}),
        }));
    } },
    checkpoint_list: { paths: null, guardNote: "C4: 只读当前会话的检查点索引与撤销记录(index.json + reverts.json),不触文件路径、不回滚;sessionId 取自 ctx/WCW_SESSION_ID 而非参数,拿不到别的会话的检查点", handler: async (args, ctx) => {
        // 授权:会话归属只取 ctx / 桥 env,绝不接受 args 传入(与 observation_recall 同一做法)。
        const session = (ctx && ctx.session) || null;
        const sessionId = safeSessionId(String((session && session.id) || (ctx && ctx.sessionId) || process.env.WCW_SESSION_ID || ''));
        if (!sessionId) return { ok: false, error: 'not_found', message: 'no current session to list checkpoints for' };
        return checkpointListResult(sessionId, args);
    } },
    scratchpad_write: { paths: null, guardNote: "C2: 只读写本会话旁车 sessions/<id>.scratchpad.json(工作台自有,DurableJsonStore,路径由受校验的会话 id 拼出);会话只取主回合 ctx(mainTurn),不接受参数传 id;子代理/MCP 子进程/HTTP 直调/管家会话 fail-closed", handler: async (args, ctx) => {
        return scratchpadWriteTool(args, ctx);
    } },
    thread_title_update: { paths: null, guardNote: '仅当前普通provider主回合的自动标题；sessionId由ctx绑定，子代理与CLI不可调用', handler: async (args, ctx) => {
      if (!ctx || ctx.mainTurn !== true || !ctx.session || ctx.session.kind === 'steward') return { ok: false, error: 'thread_title_update 仅在普通会话主回合可用。' };
      return updateAutomaticThreadTitle({ sessionId: ctx.session.id, title: args.title, gist: args.gist });
    } },
    list_tools: { paths: null, guardNote: "紧凑工具目录控制面,不触文件路径", handler: async (args, ctx) => {
        const config = await readConfig();
        const { catalog } = await adaptiveCatalogForMcp(config, { desktopOverride: await policyDesktopOverrideFor(ctx) });   // 被能力总闸关掉的桥接工具不进目录
        return listCompactTools(catalog, args);
    } },
    tool_search: { paths: null, guardNote: "目录检索控制面,不触文件路径", handler: async (args, ctx) => {
        const config = await readConfig();
        const { catalog } = await adaptiveCatalogForMcp(config, { desktopOverride: await policyDesktopOverrideFor(ctx) });   // 同上
        const result = searchToolCatalog(catalog, args, config, { legacyNameBoost: 3 });   // 与引擎路径同一档名字加权(修前 1 = 不加权,read file 排不出 file_read)
        if (config.runtimeOptimizationShadowV1 === true && config.runtimeToolRetrievalV1 !== true) {
          try {
            const candidate = searchToolCatalog(catalog, args, config, { forceV1: true, legacyNameBoost: 3 });
            const comparison = compareToolRetrievalShadow(result, candidate);
            const sessionId = (ctx && ctx.session && ctx.session.id) || process.env.WCW_SESSION_ID || '';
            logEvent({ kind: 'tool_retrieval_shadow', engine: 'mcp', sessionId, ...comparison });
          } catch { /* shadow comparison must never affect the MCP result */ }
        }
        // 61-A4:零命中时 searchToolCatalog 已给 note,不再叫它「调用找到的工具」。
        if (!Array.isArray(result.matches) || !result.matches.length) return result;
        return { ...result, next: 'Call the concrete tool if visible; otherwise use tool_invoke_read/edit/exec with the matching tier.' };
    } },
    tool_load: { paths: null, guardNote: "元工具提示,不触文件路径", handler: async (args, ctx) => {
        return { ok: true, note: 'Claude CLI schemas are fixed for this process. Use tool_search then tool_invoke_read/edit/exec. OpenAI-compatible turns load concrete schemas on the next iteration.' };
    } },
    tool_invoke_read: { paths: null, guardNote: "代理分发:桥接工具经 bridgedWriteRelativePathArg/journalBridgedWrite;原生目标递归回本注册表走各自 guard", handler: async (args, ctx) => {
        return invokeAdaptiveMcpTool('read', String(args.name || ''), args.arguments || {}, ctx);
    } },
    tool_invoke_edit: { paths: null, guardNote: "代理分发:同 tool_invoke_read", handler: async (args, ctx) => {
        return invokeAdaptiveMcpTool('edit', String(args.name || ''), args.arguments || {}, ctx);
    } },
    tool_invoke_exec: { paths: null, guardNote: "代理分发:同 tool_invoke_read", handler: async (args, ctx) => {
        return invokeAdaptiveMcpTool('exec', String(args.name || ''), args.arguments || {}, ctx);
    } },
    permission_prompt: { paths: null, guardNote: "CLI 权限桥 loopback,不触文件路径(fail-closed)", handler: async (args, ctx) => {
        // Bridge: the CLI (via --permission-prompt-tool) asks us to approve a tool call. We run inside
        // the MCP child, so we call back to the web server's loopback, which prompts the UI.
        const port = process.env.WCW_PORT, host = process.env.WCW_HOST || '127.0.0.1';
        const token = process.env.WCW_TOKEN, sessionId = process.env.WCW_SESSION_ID || '';
        // Fail CLOSED: without the per-session bridge env we cannot prompt the user, so deny.
        if (!port || !token) return { behavior: 'deny', message: 'permission bridge not configured' };
        // Arg names from the CLI are underdocumented — accept the common variants.
        const toolName = args.tool_name || args.toolName || args.name || 'unknown';
        const input = args.input || args.tool_input || args.arguments || {};
        const budget = Number(process.env.WCW_PERMISSION_TIMEOUT_MS || 120000) + 10000; // outlive the server auto-deny
        try {
          const resp = await httpRequest({
            url: `http://${host}:${port}/api/permission/request`, method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token, sessionId, toolName, input }), timeoutMs: budget,
          });
          return safeJsonParse(resp.body, { behavior: 'deny', message: 'invalid bridge response' });
        } catch (e) {
          return { behavior: 'deny', message: `permission bridge error: ${e.message}` };
        }
    } },
    request_user_input: { paths: null, guardNote: "loopback 提问,不触文件路径", handler: async (args, ctx) => {
        // Provider turns intercept this in their live closure. Claude reaches it through the per-session MCP
        // child, which loops back to the serve process so the visible chat stream owns the modal and answer.
        if (RUNTIME.isMcpChild) {
          const port = process.env.WCW_PORT, host = process.env.WCW_HOST || '127.0.0.1';
          const token = process.env.WCW_TOKEN, sessionId = process.env.WCW_SESSION_ID || '';
          if (!port || !token || !sessionId) return { ok: false, error: 'request_user_input requires a live workbench session' };
          const timeoutMs = Math.max(5000, Number(process.env.WCW_PERMISSION_TIMEOUT_MS) || 120000);
          try {
            const resp = await httpRequest({
              url: `http://${host}:${port}/api/question/request`, method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ token, sessionId, questions: args.questions }), timeoutMs: timeoutMs + 10000,
            });
            return safeJsonParse(resp.body, { ok: false, error: 'invalid /api/question/request response' });
          } catch (e) { return { ok: false, error: `question loopback error: ${(e && e.message) || String(e)}` }; }
        }
        return { ok: false, error: 'request_user_input requires a live turn' };
    } },
    todo_write: { paths: null, guardNote: "任务清单经 loopback /api/todo 落会话,不触任意文件路径", handler: async (args, ctx) => {
        // v0.8-S3: FULL-REPLACE task list. Two execution contexts:
        //  - serve process (provider engine): the runOpenAiTurn tool loop special-cases todo_write BEFORE
        //    dispatching here (it holds the session + onEvent to persist session.todos and emit the `todo`
        //    event). This generic branch is the fallback used by /api/tools/todo_write and any caller that
        //    lacks that turn context — it only validates + returns {ok,count}, touching no session file.
        //  - MCP child (Claude engine): the child must NOT write session files (races the serve process's
        //    saveSession). Detect isMcpChild and loop back to POST /api/todo with the injected session env.
        const items = normalizeTodoItems(args.items);
        if (RUNTIME.isMcpChild) {
          const port = process.env.WCW_PORT, host = process.env.WCW_HOST || '127.0.0.1';
          const token = process.env.WCW_TOKEN, sessionId = process.env.WCW_SESSION_ID || '';
          if (!port || !token || !sessionId) {
            return { ok: false, error: 'todo 需要工作台会话上下文', hint: '独立 MCP 模式不支持' };
          }
          try {
            const resp = await httpRequest({
              url: `http://${host}:${port}/api/todo`, method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ token, sessionId, items }), timeoutMs: 5000,
            });
            return safeJsonParse(resp.body, { ok: false, error: 'invalid /api/todo response' });
          } catch (e) {
            return { ok: false, error: `todo loopback error: ${(e && e.message) || String(e)}` };
          }
        }
        // 非 MCP 子进程且走到这里 = 没有活的 provider 回合(回合内的 todo_write 由 09 的回合闭包特判,先于 toolCall):
        // 没有会话可落盘、也没有 UI 事件。有会话上下文(/api/tools 带 sessionId、直调)时只能算「校验通过、未落盘」,
        // 明说 persisted:false;连会话都没有则 ok:false(修前一律 ok:true,模型以为清单已更新)。
        const hasSession = !!((ctx && (ctx.session || ctx.sessionId)) || process.env.WCW_SESSION_ID);
        if (!hasSession) return { ok: false, error: 'todo_write 需要工作台会话上下文(没有会话可保存任务清单)', hint: '在对话回合中直接调用 todo_write' };
        return { ok: true, count: items.length, persisted: false, note: '仅校验通过,未写入会话(当前不在对话回合内)' };
    } },
    mission_update: { paths: null, guardNote: "任务账本经 loopback /api/mission 落会话,不触任意文件路径", handler: async (args, ctx) => {
        // 第26波b: 与 todo_write 同款双路径。serve 进程(provider)由 runOpenAiTurn 特例拦截(持 session);
        // 此处是 MCP 子进程(Claude)与无回合上下文的兜底:子进程 loopback POST /api/mission(不写会话文件)。
        if (RUNTIME.isMcpChild) {
          const port = process.env.WCW_PORT, host = process.env.WCW_HOST || '127.0.0.1';
          const token = process.env.WCW_TOKEN, sessionId = process.env.WCW_SESSION_ID || '';
          if (!port || !token || !sessionId) return { ok: false, error: 'mission 需要工作台会话上下文', hint: '独立 MCP 模式不支持' };
          try {
            const resp = await httpRequest({
              url: `http://${host}:${port}/api/mission`, method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ token, sessionId, action: 'update', milestones: args.milestones, goal: args.goal }), timeoutMs: 5000,
            });
            const r = safeJsonParse(resp.body, { ok: false, error: 'invalid /api/mission response' });
            return r && r.ok ? { ok: true, mission: r.mission } : r;
          } catch (e) { return { ok: false, error: `mission loopback error: ${(e && e.message) || String(e)}` }; }
        }
        const hasSession = !!((ctx && (ctx.session || ctx.sessionId)) || process.env.WCW_SESSION_ID);
        if (!hasSession) return { ok: false, error: 'mission_update 需要工作台会话上下文(没有会话可更新任务账本)', hint: '在对话回合中直接调用 mission_update' };
        return { ok: true, persisted: false, note: '账本更新需在对话回合内生效(当前仅校验,未写入)' };
    } },
    // 108c: 只读原生工具 —— 自身运行时详情(第 49 波「新工具入库全部门」纪律)。复用 108a
    // buildRuntimeIdentityFacts() 与 /api/status 同源装配(computeHealth/getCapabilities/loadSkillRegistry/
    // getAgentWorkflows),不新造事实源。config 段只回显白名单标量字段,绝不回显 provider/apiKey/token 等
    // 密钥材料(e2e 断言:序列化结果不含 apiKey/token/sk- 子串)。section 参数控制输出体量。
    workbench_self_status: { paths: null, guardNote: '只读自状态(版本/位置/端口/健康/计数/设置掩码),不触任何文件路径', handler: async (args, ctx) => {
        return buildWorkbenchSelfStatus(args, ctx);
    } },
  };

  return { CORE_TOOL_HANDLERS };
}

module.exports = { createWorkbenchCoreTools };
