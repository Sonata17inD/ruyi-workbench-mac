'use strict';

function createStewardStatusTools({
  safeSessionId, redact, buildWorkbenchSelfStatus, collectAudit, computeHealth,
  stewardInboxState, runs, projection, usage, catalog, threads, rules, limits,
}) {
  const { activeAgentRuns, listAgentRuns, missionRunDigest } = runs;
  const { getPretenderProjectionIndex, buildMissionAggregateRows } = projection;
  const { forEachUsageRow, usageDayKey, usageDayKeyMemo } = usage;
  const { loadSkillRegistry, listPlaybooksWithAvailability } = catalog;
  const { stewardRawKind, stewardReadSessionHead, stewardKnownWorkspaces, stewardWorkspaceNameOf } = threads;
  const {
    stewardClampInt, stewardFail, stewardSanitizeText, stewardStateLabel,
  } = rules;
  const {
    STEWARD_AUDIT_LIMIT_DEFAULT, STEWARD_AUDIT_LIMIT_MAX, STEWARD_RUNS_MAX, STEWARD_MISSIONS_LIMIT_DEFAULT,
    STEWARD_MISSIONS_LIMIT_MAX, STEWARD_CATALOG_DESC_CHARS, STEWARD_CATALOG_ROWS,
  } = limits;

  // 1) steward_self_status —— 复用 108c 的装配函数(12-tool-dispatch 的 buildWorkbenchSelfStatus),
  //    再追加一个 steward 段(管家设置掩码 + 收件箱状态)。不新造任何事实源。
  const STEWARD_CONFIG_KEYS = Object.freeze([
    'stewardEnabledV1', 'stewardProviderId', 'stewardModel', 'stewardPollMs', 'stewardMaxTurnsPerHour',
    'stewardMaxCostPerDay', 'stewardAutoActions', 'stewardContextBudgetTokens', 'stewardReadBudgetChars',
    'stewardVisitIdleMinutes', 'stewardConversationRetention',
    // 136:人设两键与触发线系数 —— 管家读得到自己的人设与预算口径(问「你现在叫什么/预算多少」不用猜)。
    'stewardPersonaName', 'stewardPersonaStyle', 'stewardContextBudgetRatio',
  ]);
  async function stewardImplSelfStatus(args, ctx, config) {
    const wantSteward = !args.section || args.section === 'all' || args.section === 'steward';
    // section:'steward' 只要身份 + 管家段(省上下文);其余 section 原样透传给 108c 的装配函数。
    const base = await buildWorkbenchSelfStatus({ section: args.section === 'steward' ? 'identity' : args.section }, ctx);
    if (!wantSteward) return base;
    const stewardConfig = {};
    // 全部是标量/小对象开关,天生不含 apiKey/token;仍按白名单逐键回显,防将来新增敏感键被顺带带出。
    for (const key of STEWARD_CONFIG_KEYS) stewardConfig[key] = config[key];
    return { ...base, steward: { config: stewardConfig, inbox: await stewardInboxState(config) } };
  }

  // 5) steward_runs_status —— 复用 08 的 listAgentRuns + 13d 的 missionRunDigest(不另造 digest)。
  async function stewardImplRunsStatus(args, ctx, config) {
    const explicit = args.sessionId ? safeSessionId(args.sessionId) : '';
    if (args.sessionId && !explicit) return stewardFail('not_found', 'invalid sessionId');
    let sessionIds = [];
    if (explicit) sessionIds = [explicit];
    else {
      const index = await getPretenderProjectionIndex().catch(() => null);
      sessionIds = ((index && index.sessions) || []).filter(row => row.card).map(row => row.sessionId);
    }
    const runs = [];
    for (const sid of sessionIds) {
      if (runs.length >= STEWARD_RUNS_MAX) break;
      const head = await stewardReadSessionHead(sid);
      if (stewardRawKind(head) === 'steward') continue;
      for (const run of await listAgentRuns(sid).catch(() => [])) {
        if (runs.length >= STEWARD_RUNS_MAX) break;
        const live = activeAgentRuns.get(run.id);
        const mem = live && live.run ? live.run : run;
        const nodes = Array.isArray(mem.nodes) ? mem.nodes : [];
        runs.push({
          sessionId: sid,
          runId: String(run.id || ''),
          status: String(mem.status || ''),
          live: !!live,
          paused: !!(live && live.paused),
          ...(mem.kind === 'steward_delegation' ? { steps: nodes.slice(0, 8).map(node => ({ id: node.id, task: stewardSanitizeText(redact(String(node.task || ''))).slice(0, 180), status: node.status, waitingPermission: !!live?.permissionWaits?.has(node.id), dependsOn: node.dependsOn, error: stewardSanitizeText(redact(String(node.error || ''))).slice(0, 240) })) } : {}),
          // done 数的是成功态:09 工作流里节点的成功终态叫 'succeeded'(没有 'done' 这个值)。修前统计 status === 'done',
          // 恒为 0 —— 一个全部跑完的 run 也报「0 个节点完成」。键名 done 不动(模型与测试已经按它读)。
          nodes: { total: nodes.length, done: nodes.filter(n => n && n.status === 'succeeded').length, failed: nodes.filter(n => n && n.status === 'failed').length, running: nodes.filter(n => n && (n.status === 'running' || n.status === 'waiting_resource')).length },
          // 等待原因单一化:优先「等你」(池提案待批),其次「等锁」(资源),再次「已暂停」。
          waitReason: (Array.isArray(mem.taskPool) ? mem.taskPool : []).some(p => p && p.status === 'proposed') ? '等你批任务池提案'
            : nodes.some(n => n && n.status === 'waiting_resource') ? '等资源锁'
              : (live && live.paused) ? '已暂停' : '',
          resumeTier: String(mem.resumeTier || ''),
          digest: missionRunDigest(mem, !!live),
        });
      }
    }
    return { ok: true, runs, truncated: runs.length >= STEWARD_RUNS_MAX };
  }

  // 7) steward_usage —— 用量台账按会话/按日汇总;管家自身开销(kind:'aux', note:'steward')单列。
  function stewardEmptyUsageBucket() { return { turns: 0, inTok: 0, outTok: 0, cachedInTok: 0, costsByCurrency: {} }; }
  function stewardAddUsageRow(bucket, row) {
    bucket.turns += 1;
    bucket.inTok += Number(row.inTok) || 0;
    bucket.outTok += Number(row.outTok) || 0;
    bucket.cachedInTok += Number(row.cachedInTok) || 0;
    const cost = Number(row.cost);
    const currency = typeof row.currency === 'string' ? row.currency : '';
    // costTrusted === false 的行(套餐制的名义金额)不进真实费用合计 —— 与 13e 的 addMissionUsageRow 同口径。
    if (row.costTrusted !== false && currency && Number.isFinite(cost)) {
      bucket.costsByCurrency[currency] = Math.round(((bucket.costsByCurrency[currency] || 0) + cost) * 1e6) / 1e6;
    }
  }
  async function stewardImplUsage(args) {
    const sessionId = args.sessionId ? safeSessionId(args.sessionId) : '';
    if (args.sessionId && !sessionId) return stewardFail('not_found', 'invalid sessionId');
    // 第二轮工具走查(F8):修前非法的 day('yesterday' / '2026/10/01')被静默当成「没给」,回的是全期累计,
    // 调用方还以为是那一天的数。现在只认 YYYY-MM-DD(本地日历日)与 today / yesterday 两个口语写法,其余明确拒。
    let day = '';
    if (args.day !== undefined && args.day !== null && String(args.day).trim() !== '') {
      const wantDay = String(args.day).trim().toLowerCase();
      if (/^\d{4}-\d{2}-\d{2}$/.test(wantDay)) day = wantDay;
      else if (wantDay === 'today') day = usageDayKey(Date.now());
      else if (wantDay === 'yesterday') { const t = new Date(); day = usageDayKey(new Date(t.getFullYear(), t.getMonth(), t.getDate() - 1, 12).getTime()); }   // 取昨天正午:避开午夜跳 DST 的 0 点不存在
      else return stewardFail('invalid_request', `day must be YYYY-MM-DD (local calendar day), "today" or "yesterday" (got ${JSON.stringify(stewardSanitizeText(String(args.day)).slice(0, 40))}); omit it for all-time totals`);
    }
    const total = stewardEmptyUsageBucket();
    const steward = stewardEmptyUsageBucket();
    const bySession = new Map();
    const byDay = new Map();
    const dayKeyOf = usageDayKeyMemo();
    const absorb = row => {
      if (!row || typeof row !== 'object') return;
      if (sessionId && String(row.sessionId || '') !== sessionId) return;
      const rowDay = dayKeyOf(row.tsMs);
      if (day && rowDay !== day) return;
      stewardAddUsageRow(total, row);
      if (row.kind === 'aux' && row.note === 'steward') stewardAddUsageRow(steward, row);
      const sid = String(row.sessionId || '');
      if (!bySession.has(sid)) bySession.set(sid, stewardEmptyUsageBucket());
      stewardAddUsageRow(bySession.get(sid), row);
      if (!byDay.has(rowDay)) byDay.set(rowDay, stewardEmptyUsageBucket());
      stewardAddUsageRow(byDay.get(rowDay), row);
    };
    await forEachUsageRow(0, absorb, sessionId ? { sessionIds: new Set([sessionId]) } : {});
    const topSessions = [...bySession.entries()]
      .sort((a, b) => (b[1].inTok + b[1].outTok) - (a[1].inTok + a[1].outTok))
      .slice(0, 20)
      .map(([sid, bucket]) => ({ sessionId: sid, ...bucket }));
    const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-31).map(([d, bucket]) => ({ day: d, ...bucket }));
    return { ok: true, scope: { sessionId: sessionId || '', day: day || '' }, total, steward, bySession: topSessions, byDay: days };
  }

  // 8) steward_health —— computeHealth 的原始项(人话映射留给前端/管家自己说)。
  async function stewardImplHealth(args, ctx, config) {
    const { health } = await computeHealth(config);
    return { ok: true, health: (Array.isArray(health) ? health : []).map(h => ({ id: h.id, ok: h.ok, detail: h.detail })) };
  }

  // 9) steward_audit_tail —— 既有 collectAudit(内部已过 redact 脱敏),只取 workbench 源(桌面 MCP 审计
  //    要起桥,管家的「刚才发生了什么」不该为此拉起一个子进程)。
  // 第二轮工具走查(F6):修前 type 过滤被硬编码成 null、也没有任何过滤参数 —— 返回的 20 条几乎全是模型调用遥测
  // (model_call_*、layout_shadow、econ_call_totals……两个回合就把 20 条占满),「我批准过什么」那类 intervention /
  // 授权书事件被挤得拿不到。现在:
  //   · kinds:[…] 只要这些 kind(精确匹配,最多 12 个);给了就【不再】默认排除遥测(明确要什么就给什么);
  //   · 没给 kinds:默认排除纯遥测 kind(STEWARD_AUDIT_TELEMETRY_KINDS),includeTelemetry:true 才放回来;
  //   · 过滤发生在【取尾之前】(06 readWorkbenchAudit),limit 数的是过滤后的条数;最近日志文件不够时往前读至 3 天。
  const STEWARD_AUDIT_TELEMETRY_KINDS = Object.freeze([
    'model_call_started', 'model_call_completed', 'model_call_retry', 'assistant_tool_batch', 'tool_call_completed',
    'tool_phase_completed', 'layout_shadow', 'econ_call_totals', 'tool_schema_freeze', 'tool_retrieval_shadow',
    'tool_retrieval_ranked', 'tool_byte_budget_shadow', 'observation_reduction_shadow', 'observation_reduced',
    'session_notes_inject', 'iter_timing', 'exec_result_cache', 'summary_entity_check', 'compaction_refetch',
  ]);
  async function stewardImplAuditTail(args, ctx, config) {
    const limit = stewardClampInt(args.limit, 1, STEWARD_AUDIT_LIMIT_MAX, STEWARD_AUDIT_LIMIT_DEFAULT);
    // kinds 接数组,也容忍单个字符串(模型常把「一个 kind」写成字符串);其余形状当没给。
    const rawKinds = Array.isArray(args.kinds) ? args.kinds : (typeof args.kinds === 'string' ? [args.kinds] : []);
    const kinds = new Set(rawKinds.map(k => String(k == null ? '' : k).trim()).filter(k => /^[a-z0-9_.:-]{1,64}$/i.test(k)).slice(0, 12));
    const wantTelemetry = args.includeTelemetry === true;
    const audit = await collectAudit(config, {
      limit, sourceFilter: 'workbench', typeFilter: null,
      kinds, excludeKinds: kinds.size || wantTelemetry ? null : new Set(STEWARD_AUDIT_TELEMETRY_KINDS), maxFiles: 3,
    });
    return {
      ok: true, entries: (audit && audit.entries) || [], truncated: !!(audit && audit.truncated),
      filter: { kinds: [...kinds], excludedTelemetry: !(kinds.size || wantTelemetry) },
    };
  }

  async function stewardImplMissions(args, ctx, config) {
    const includeArchived = !!(args && args.includeArchived === true);
    const aggregate = await buildMissionAggregateRows({ includeArchived, config }).catch(() => ({ rows: [] }));
    // W7:事项与线程都带上【工作区名字】(已知工作区清单里的那个名字,可以原样填回 steward_thread_new
    // 的 cwd)。全路径照旧不给(围栏信息);显式白名单投影,不是把 13d 的行整份转出去。
    const knownForNames = stewardKnownWorkspaces(config);
    const nameOf = cwd => { const hit = stewardWorkspaceNameOf(cwd, config, knownForNames); return hit ? hit.name : ''; };
    const missions = aggregate.rows.map(row => {
      const mission = {
        missionId: row.missionId,
        title: stewardSanitizeText(row.title),
        workspace: stewardSanitizeText(nameOf(row.workspace && row.workspace.path)),
        goal: stewardSanitizeText(row.goal).slice(0, 400),
        aggregateState: row.aggregateState,
        aggregateStateLabel: stewardStateLabel(row.aggregateState),
        acceptance: {
          done: row.acceptance.done,
          total: row.acceptance.total,
          items: row.acceptance.items.map(item => ({ id: item.id, text: stewardSanitizeText(item.text), done: item.done === true })),
        },
        budget: row.budget,
        cost: row.cost,
        derived: row.derived,
        threads: row.threads.map(thread => ({
          sessionId: thread.sessionId,
          title: thread.title,
          state: thread.state,
          stateLabel: thread.stateLabel,
          workspace: stewardSanitizeText(nameOf(thread.cwd)),   // W7:同上
          permissionMode: thread.permissionMode,
          lastAssistantText: thread.lastAssistantText,   // 13d 已按 §11.2 截到 120 字
          ...(thread.brief ? { brief: thread.brief } : {}),   // 116-5b:同 threads_search —— title 仍是原话,brief 多给的
          wait: thread.wait || null,                     // 116h:等待原因原样透传(13d 已经过 waitReasonFor)
        })),
      };
      if (row.archivedAt) mission.archivedAt = row.archivedAt;
      return mission;
    });
    // 第二轮工具走查(F7):修前一次返回全部事项(151 个 = 77KB,约 2~3 万 token,管家一次调用就把上下文吃掉)。
    // 现在与 steward_threads_search 同一个纪律:limit(默认 50,夹取 1..200)+ total + truncated。
    // 取的是 buildMissionAggregateRows 已经排好的前 N 行(它的顺序就是看板顺序),count 保持「本次返回条数」的旧语义,
    // total 才是库里一共有多少。
    const limit = stewardClampInt(args && args.limit, 1, STEWARD_MISSIONS_LIMIT_MAX, STEWARD_MISSIONS_LIMIT_DEFAULT);
    const shown = missions.slice(0, limit);
    return { ok: true, missions: shown, count: shown.length, total: missions.length, truncated: missions.length > shown.length, limit };
  }

  // ════════════════════════════════════════════════════════════════════════════
  // 129b「能写不能读」的三张清单(tier read)—— 49 号文 §3。
  //
  // 病灶是同一个形状:**管家能改的东西,它看不见有哪些可选**。
  //   · steward_skill_toggle 能整份替换一条线程的技能,却没有工具能列出技能注册表 ——
  //     它自己的 schema 写着「不存在的 id 会被静默丢掉」,于是模型只能猜;
  //   · activeProvider / model / compactProviderId / compactModel / asrProviderId / asrModel /
  //     subagentPreferred* 八个键都是 confirm 档可改,而 providers 在 forbidden 档读不到
  //     (清单和 apiKey 装在同一个对象里),于是它能提「换成 X 模型」这枚按钮却不知道有哪些模型;
  //   · steward_playbook_draft 能起草 playbook,用户问「有哪些预置流程」它答不上来。
  //
  // 三张清单读的都是【如意自己的状态】,不含任何外部内容,所以不碰 31 号文红线 4(污染规则),
  // 安全面为零 —— 这也是它们与「眼睛」那四件(129d)的分界线。
  //
  // **投影一律用显式白名单,不是「删掉敏感字段」**:后者的失败方向是「以后谁给 provider 加一个
  // 新字段,它就默认泄漏出去」。这里只挑名字写出来的那几个字段,新字段默认不出现(fail-closed,
  // 与管家记忆导出字段白名单那把锁同一个模具)。key 与 baseUrl 一个字都不给:前者是密钥本身,
  // 后者是围栏信息(31 号文红线 2),而管家要的只是「有哪些可选」。
  // ════════════════════════════════════════════════════════════════════════════

  // 24) steward_skills —— 技能注册表的只读清单(给 steward_skill_toggle 用的那份 id)。
  async function stewardImplSkills(args, ctx, config) {
    // 项目技能来自 <cwd>/.ruyi/skills,所以「有哪些技能」是【跟着线程的工作目录】变的。
    // 给了 sessionId 就按那条线程的 cwd 取(问的本来就是「这条线程能开哪些」),否则按默认工作区。
    const sid = args && args.sessionId ? safeSessionId(args.sessionId) : '';
    let cwd = String((config && config.defaultWorkspace) || '');
    if (sid) {
      const head = await stewardReadSessionHead(sid);
      if (!head || !head.id) return stewardFail('not_found', `thread ${stewardSanitizeText(sid)} not found`);
      if (head.cwd) cwd = String(head.cwd);
    }
    const registry = await loadSkillRegistry(cwd, config).catch(() => []);
    const q = stewardSanitizeText(String((args && args.q) || '')).trim().toLowerCase();
    const rows = (Array.isArray(registry) ? registry : [])
      .filter(e => e && e.kind === 'skill')
      .filter(e => !q || `${e.id} ${e.name} ${e.description}`.toLowerCase().includes(q))
      .slice(0, STEWARD_CATALOG_ROWS)
      .map(e => ({
        id: stewardSanitizeText(String(e.id || '')),
        name: stewardSanitizeText(String(e.name || '')).slice(0, 60),
        description: stewardSanitizeText(String(e.description || '')).slice(0, STEWARD_CATALOG_DESC_CHARS),
        source: stewardSanitizeText(String(e.source || '')),
        // 能不能用是既有结论(requires + 能力矩阵),原样转述;**目录绝对路径不出现**。
        available: e.available !== false,
        unavailableReason: e.available === false ? stewardSanitizeText(String(e.unavailableReason || '')).slice(0, 120) : '',
      }));
    return { ok: true, sessionId: sid, total: rows.length, skills: rows };
  }

  // 25) steward_providers —— 端点与模型的只读目录(掩码:不给 key、不给 baseUrl)。
  async function stewardImplProviders(args, ctx, config) {
    const list = Array.isArray(config && config.providers) ? config.providers : [];
    const providers = list.slice(0, STEWARD_CATALOG_ROWS).map(p => {
      const models = Array.isArray(p && p.models) ? p.models : [];
      const hidden = new Set((Array.isArray(p && p.hiddenModels) ? p.hiddenModels : []).map(x => String(x || '')));
      return {
        id: stewardSanitizeText(String((p && p.id) || '')),
        label: stewardSanitizeText(String((p && p.label) || '')).slice(0, 60),
        type: stewardSanitizeText(String((p && p.type) || '')),
        // 有没有配好 key 是管家该知道的(「这个端点还没配」是它能说的一句有用的话),
        // 但**只给布尔**:掩码串同样会暴露长度与前缀形状。
        hasKey: Boolean(p && typeof p.apiKey === 'string' && p.apiKey),
        models: models
          .filter(m => m && !hidden.has(String(m.id || '')))
          .slice(0, STEWARD_CATALOG_ROWS)
          .map(m => ({
            id: stewardSanitizeText(String((m && m.id) || '')),
            label: stewardSanitizeText(String((m && m.label) || '')).slice(0, 60),
            // caps 是【模型能力标签】(asr / embedding,白名单在 05),与 getCapabilities 那张
            // 【运行环境能力矩阵】(network/desktopMcp/vision)是两个正交取值域、只是同名。
            // 这里原样转述已经清洗过的那一份,不做任何解释 —— 两处白名单不许互相引用(有锁)。
            caps: Array.isArray(m && m.caps) ? m.caps.map(c => stewardSanitizeText(String(c || ''))).slice(0, 8) : [],
          })),
      };
    });
    // 「现在用的是哪个」本来就能从 steward_config_get 读到,这里一并给出省一次往返;
    // 它们是 confirm 档的值,不是 forbidden。
    return {
      ok: true,
      active: {
        provider: stewardSanitizeText(String((config && config.activeProvider) || '')),
        model: stewardSanitizeText(String((config && config.model) || '')),
      },
      total: providers.length,
      providers,
    };
  }

  // 26) steward_playbooks —— 预置流程的只读清单(用户问「有哪些流程」时答得上来)。
  async function stewardImplPlaybooks(args, ctx, config) {
    const list = await listPlaybooksWithAvailability(config).catch(() => []);
    const q = stewardSanitizeText(String((args && args.q) || '')).trim().toLowerCase();
    const rows = (Array.isArray(list) ? list : [])
      // 字段名是 desc 不是 description(normalizePlaybook 的口径)—— 第一版写错,冒烟时整列全空捞出来的。
      .filter(pb => pb && (!q || `${pb.id} ${pb.title} ${pb.desc}`.toLowerCase().includes(q)))
      .slice(0, STEWARD_CATALOG_ROWS)
      .map(pb => ({
        id: stewardSanitizeText(String((pb && pb.id) || '')),
        title: stewardSanitizeText(String((pb && pb.title) || '')).slice(0, 60),
        description: stewardSanitizeText(String((pb && pb.desc) || '')).slice(0, STEWARD_CATALOG_DESC_CHARS),
        service: stewardSanitizeText(String((pb && pb.service) || '')),
        available: !(pb && pb.available === false),
        missingCaps: Array.isArray(pb && pb.missingCaps) ? pb.missingCaps.map(c => stewardSanitizeText(String(c || ''))).slice(0, 6) : [],
        // 129h:要跑它就得先知道它问哪几个参数 —— 没有这一列,管家只能空手去调 thread_new,
        // 然后吃一个 playbook_inputs_missing 才知道缺什么(白跑一轮,还得再问一次用户)。
        // 仍然是【显式字段白名单】(129b 那条纪律):只出 key/label/type 三样作者自己写的界面元数据,
        // promptTemplate 一个字都不出 —— 模板正文不该占管家的上下文,它由服务端在开线程时直接附上。
        inputs: (Array.isArray(pb && pb.inputs) ? pb.inputs : []).slice(0, 12).map(inp => ({
          key: stewardSanitizeText(String((inp && inp.key) || '')),
          label: stewardSanitizeText(String((inp && inp.label) || '')).slice(0, 60),
          type: stewardSanitizeText(String((inp && inp.type) || 'text')),
        })),
      }));
    return { ok: true, total: rows.length, playbooks: rows };
  }

  return {
    stewardImplAuditTail, stewardImplHealth, stewardImplMissions, stewardImplPlaybooks,
    stewardImplProviders, stewardImplRunsStatus, stewardImplSelfStatus, stewardImplSkills, stewardImplUsage,
  };
}

module.exports = { createStewardStatusTools };
