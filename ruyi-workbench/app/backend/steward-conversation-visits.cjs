'use strict';
const fsp = require('node:fs/promises');
const path = require('node:path');

function createStewardConversationVisits({
  logEvent, makeId, nowIso, readConfig, safeSessionId, stewardDir, stewardFail, stewardRunnerRuntime,
  SchedulerHooks,
  sessions, inbox, lifecycle, persistence, constants,
}) {
  const {
    loadSession, mutateSession, readSessionNotes, writeSessionNotes, stopSession, waitMissionTurnSettled,
  } = sessions;
  const {
    getPretenderProjectionIndex, stewardInboxRead, stewardPendingOneLine, stewardThreadDigestRows,
  } = inbox;
  const { clearStewardReadBudget, stewardAbortInflight, stewardScheduleInboxDrain } = lifecycle;
  const { atomicWriteJson } = persistence;
  const {
    STEWARD_DIGEST_KIND_TEXT, STEWARD_DIGEST_LIMITS, STEWARD_EVENT_KINDS, STEWARD_PENDING_LIST_MAX,
    STEWARD_PREEMPT_WAIT_MS, STEWARD_SESSION_ID, STEWARD_VISITS_DIR, STEWARD_VISITS_KEEP,
    STEWARD_VISIT_DIGEST_MAX, STEWARD_VISIT_SCHEMA,
  } = constants;

  // ────────────────────────────────────────────────────────────────────────────
  // 到访(§8.9「每次打开」/§11.1 第 7 项「一次到访 = 页面重开,或静默 60 分钟」)。
  //
  // 摘要是【确定性】的:由 inbox 自上次到访以来的事件按五类归纳,不调模型 —— 打开如意的第一屏不该
  // 等一次模型往返,也不该因为端点不通就什么都看不到。
  // ────────────────────────────────────────────────────────────────────────────
  function stewardVisitsDir() { return path.join(stewardDir(), STEWARD_VISITS_DIR); }

  // 归档文件名:ISO 时间戳里的 ':' 与 '.' 在 Windows 文件名里非法,换成 '-'(§CONTRIBUTING 第 4 条)。
  function stewardVisitFileName(at) {
    return String(at || nowIso()).replace(/[:.]/g, '-') + '.json';
  }

  async function stewardTrimVisits() {
    const dir = stewardVisitsDir();
    const files = (await fsp.readdir(dir).catch(() => [])).filter(f => f.endsWith('.json')).sort();
    if (files.length <= STEWARD_VISITS_KEEP) return;
    for (const file of files.slice(0, files.length - STEWARD_VISITS_KEEP)) {
      await fsp.unlink(path.join(dir, file)).catch(() => {});
    }
  }

  // A reset occupies the existing runner slot. Older waiters observe the generation
  // change and cancel; inbox events remain queued for the next conversation.
  async function stewardResetConversation() {
    const current = stewardRunnerRuntime.inflight;
    if (current?.kind === 'reset') return current.promise;
    stewardRunnerRuntime.conversationGeneration += 1;
    const entry = { kind: 'reset', promise: null };
    stewardRunnerRuntime.inflight = entry;
    if (stewardRunnerRuntime.debounceTimer) {
      clearTimeout(stewardRunnerRuntime.debounceTimer);
      stewardRunnerRuntime.debounceTimer = null;
      stewardRunnerRuntime.debounceMs = -1;
    }
    if (current) {
      current.cancelled = 'reset';
      if (current.kind === 'inbox') stewardRunnerRuntime.queue.push(...(current.events || []));
      stewardAbortInflight(current);
    }
    entry.promise = (async () => {
      try {
        stopSession(STEWARD_SESSION_ID, 'reset');
        if (current?.promise) {
          let timer;
          const settled = await Promise.race([
            current.promise.then(() => true),
            new Promise(resolve => { timer = setTimeout(() => resolve(false), 8000); }),
          ]).finally(() => clearTimeout(timer));
          if (!settled) {
            // Keep the old turn in its slot until its own finally releases it.
            stewardRunnerRuntime.inflight = current;
            throw new Error('上一回合仍未停止，请稍后再开始新对话');
          }
        }
        if (!await waitMissionTurnSettled(STEWARD_SESSION_ID)) throw new Error('上一回合仍未停止，请稍后再开始新对话');
        const config = await readConfig();
        const archive = await stewardArchiveConversation(config, stewardRunnerRuntime.visit.startedAt || nowIso(), { reset: true });
        await writeSessionNotes(STEWARD_SESSION_ID, '');
        stewardRunnerRuntime.lastReply = null;
        stewardRunnerRuntime.noProgress = 0;
        stewardRunnerRuntime.circuit = null;
        clearStewardReadBudget(STEWARD_SESSION_ID);
        stewardRunnerRuntime.visit.startedAt = nowIso();
        stewardRunnerRuntime.visit.lastActivityAt = stewardRunnerRuntime.visit.startedAt;
        logEvent({ kind: 'steward_conversation_reset', archived: archive.archived });
        return { ok: true, archive, startedAt: stewardRunnerRuntime.visit.startedAt };
      } catch (error) {
        return stewardFail('steward.reset_failed', String(error?.message || error));
      } finally {
        if (stewardRunnerRuntime.inflight === entry) stewardRunnerRuntime.inflight = null;
        stewardScheduleInboxDrain();
      }
    })();
    return entry.promise;
  }

  // 按 stewardConversationRetention 归档管家会话历史。
  //   visit   : 整段归档后清空(默认,§8.1 原则 8「对话不是档案」);
  //   24h     : 只归档 24 小时前的消息,近 24 小时留在会话里;
  //   forever : 不归档不清空。
  // 返回 { archived, file, kept }。
  async function stewardArchiveConversation(config, startedAt, options = {}) {
    const retention = options.reset === true ? 'visit' : String((config && config.stewardConversationRetention) || 'visit');
    if (retention === 'forever') return { archived: 0, file: '', kept: -1 };
    const session = await loadSession(STEWARD_SESSION_ID).catch(() => null);
    if (!session) return { archived: 0, file: '', kept: 0 };
    if (options.generation !== undefined && options.generation !== stewardRunnerRuntime.conversationGeneration) throw new Error('conversation changed');
    const baseGen = Number(session.rewindGen) || 0;   // 128b:归档文件与截断必须基于同一份正文
    const messages = Array.isArray(session.messages) ? session.messages : [];
    if (!messages.length && !options.reset) return { archived: 0, file: '', kept: 0 };
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const keepFrom = retention === '24h'
      ? messages.findIndex(m => {
        const at = Date.parse(String((m && m.createdAt) || ''));
        return Number.isFinite(at) && at >= cutoff;
      })
      : messages.length;
    const splitAt = keepFrom < 0 ? messages.length : keepFrom;
    const archived = messages.slice(0, splitAt);
    if (!archived.length && !options.reset) return { archived: 0, file: '', kept: messages.length };
    const at = nowIso();
    const file = path.join(stewardVisitsDir(), options.reset ? stewardVisitFileName(at).replace('.json', '-' + makeId('reset') + '.json') : stewardVisitFileName(startedAt || at));
    await fsp.mkdir(stewardVisitsDir(), { recursive: true });
    await atomicWriteJson(file, {
      schema: STEWARD_VISIT_SCHEMA,
      sessionId: STEWARD_SESSION_ID,
      startedAt: String(startedAt || ''),
      archivedAt: at,
      retention,
      messages: archived,
      ...(options.reset ? { sessionNotes: await readSessionNotes(STEWARD_SESSION_ID) } : {}),
    });
    // 正文按保留策略截断。providerHistory 与消息不是一一对应(工具轮次更多),整段清空是唯一
    // 安全的做法:留半截会让下一回合带着孤儿 tool_calls 去请求(strict provider 直接 400)。
    // 128b:修前是裸 saveSession(...).catch —— 被撤回闸丢掉时,归档文件已经写了、会话里那几条却还在(同一段对话存两份,
    // 下次拜访再归档一次)。现在截断带 expectGen 走 mutateSession:期间撤回过,或正文头部已不是刚归档的那几条,就不截断,
    // 并把刚写的归档文件删掉 —— 归档先写、截断后做的次序不变(截断之前归档一定已经在盘上,不会两头都没有)。
    let kept = messages.length - splitAt;
    let truncated = false;
    try {
      const written = await mutateSession(STEWARD_SESSION_ID, fresh => {
        if (options.generation !== undefined && options.generation !== stewardRunnerRuntime.conversationGeneration) return { abort: 'conversation_changed' };
        const now = Array.isArray(fresh.messages) ? fresh.messages : [];
        const samePrefix = now.length >= splitAt && archived.every((m, i) => now[i] && now[i].createdAt === m.createdAt && now[i].role === m.role);
        if (!samePrefix) return { abort: 'prefix_changed' };
        fresh.messages = now.slice(splitAt);
        fresh.providerHistory = [];
        fresh.providerHistoryCursor = fresh.messages.length;
        fresh.autoCompactWatermark = 0;
        if (options.reset) {
          fresh.summary = '';
          fresh.claudeSessionId = null;
          fresh.attachments = [];
          delete fresh.stewardTaint;
        }
        kept = fresh.messages.length;
        return undefined;
      }, { writer: 'steward_archive', expectGen: baseGen, saveOpts: { shrinkBody: true, ...(options.reset ? { rewindBump: true, throwIfStale: true } : {}) } });   // 有意截短:不让 saveSession 当旧副本补回
      truncated = Boolean(written && written.ok);
    } catch { truncated = false; }
    if (!truncated) {
      await fsp.unlink(file).catch(() => {});
      logEvent({ kind: 'steward_archive_rolled_back', sessionId: STEWARD_SESSION_ID, archived: archived.length });
      if (options.reset) throw new Error('conversation reset could not persist');
      return { archived: 0, file: '', kept: messages.length };
    }
    await stewardTrimVisits();
    return { archived: archived.length, file: path.basename(file), kept };
  }

  // 确定性到访摘要:自上次到访以来的收件箱事件按七类归纳成 ≤5 条人话,再加 123-M2 的【承诺三项】。
  //
  // 承诺三项(37 号文 §3.5)与上面那七类是【两本账】,不能合成一本:
  //   · 七类数的是「上次到访以来【发生过】什么」(收件箱流水,按 inboxSeq 切);
  //   · 三项里的「未来承诺」与「等你的」数的是【此刻的状态】(还没发生的下一次触发、仍然卡着的
  //     needs_you)—— 拿流水去数它们会把「同一条任务反复 needs_you」算成好几条。
  // 只有中间那一项(过期或结果未知)是流水,所以它单独用 fires 的 seq 当水位(见 13m 的 visit.fireSeq)。
  //
  // 读口经 06j 的 SchedulerHooks.commitmentsSince —— 实现住 13t-steward-schedule.js,它在 manifest 里
  // 排在本文件【之后】,直接写函数名会是前向边;调度器关着或钩子没填充时整段是无操作(三项全 0)。
  const STEWARD_COMMITMENT_TEXT = Object.freeze({
    upcoming: n => `${n} 件定时任务 24 小时内要触发`,
    missed: n => `${n} 件定时任务过期或结果未知`,
    needsYou: n => `${n} 件定时任务等你批准`,
  });
  const STEWARD_COMMITMENT_I18N = Object.freeze({
    upcoming: 'stewardShell.digest.commitment.upcoming',
    missed: 'stewardShell.digest.commitment.missed',
    needsYou: 'stewardShell.digest.commitment.needsYou',
  });
  // hunt2-steward ⑧:到访摘要逐页读完「上次到访以来」的收件箱(读口一页至多 200 行)。修前只读第一页,
  // 水位却推到全箱最大的 inboxSeq —— 离开期间攒下超过 200 行时,第 201 行往后的事件永远不进任何一次摘要。
  // 页数有帽(STEWARD_VISIT_DIGEST_PAGES);帽子到了还没读完,水位就停在【最后读到的那一行】,
  // 余下的留给下一次到访,不跳过。
  const STEWARD_VISIT_DIGEST_PAGES = 25;
  async function stewardVisitDigest(sinceSeq, sinceFireSeq) {
    const counts = {};
    for (const kind of STEWARD_EVENT_KINDS) counts[kind] = 0;
    let cursor = Math.max(0, Number(sinceSeq) || 0);
    let watermark = cursor;
    for (let page = 0; page < STEWARD_VISIT_DIGEST_PAGES; page++) {
      const read = await stewardInboxRead({ since: cursor, limit: 200 }).catch(() => null);
      if (!read) break;   // 读失败:水位不动,下一次到访重读
      const rows = Array.isArray(read.items) ? read.items : [];
      for (const row of rows) {
        if (Object.prototype.hasOwnProperty.call(counts, row && row.kind)) counts[row.kind] += Math.max(1, Number(row.count) || 1);
        cursor = Math.max(cursor, Number(row && row.inboxSeq) || 0);
      }
      watermark = cursor;
      if (!read.hasMore || !rows.length) { watermark = Math.max(cursor, Number(read.inboxSeq) || 0); break; }
    }
    const items = [];
    for (const kind of STEWARD_EVENT_KINDS) {
      if (items.length >= STEWARD_VISIT_DIGEST_MAX) break;
      if (counts[kind] > 0) items.push({ kind, text: STEWARD_DIGEST_KIND_TEXT[kind](counts[kind]), count: counts[kind] });
    }
    let commitments = { upcoming: 0, missed: 0, needsYou: 0, fireSeq: Math.max(0, Number(sinceFireSeq) || 0) };
    if (typeof SchedulerHooks.commitmentsSince === 'function') {
      // 旁路纪律:承诺读口出错只是少三行摘要,绝不让「打开管家」这件事失败。
      try { commitments = (await SchedulerHooks.commitmentsSince(sinceFireSeq, Date.now())) || commitments; }
      catch { /* 保持全 0 */ }
    }
    // 为承诺留出名额:事件类别满五种时也不能把漏跑/结果未知吞掉,同时推进 fireSeq 让它永远消失。
    const commitmentFields = ['upcoming', 'missed', 'needsYou'].filter(field => Math.max(0, Number(commitments[field]) || 0) > 0);
    items.splice(Math.max(0, STEWARD_VISIT_DIGEST_MAX - commitmentFields.length));
    for (const field of commitmentFields) {
      if (items.length >= STEWARD_VISIT_DIGEST_MAX) break;
      const n = Math.max(0, Number(commitments[field]) || 0);
      if (!n) continue;
      items.push({
        kind: 'commitment', field, count: n,
        key: STEWARD_COMMITMENT_I18N[field], params: { count: n },
        text: STEWARD_COMMITMENT_TEXT[field](n),
      });
    }
    return {
      items, counts,
      commitments: { upcoming: commitments.upcoming, missed: commitments.missed, needsYou: commitments.needsYou },
      inboxSeq: watermark,
      fireSeq: Math.max(0, Number(commitments.fireSeq) || 0),
    };
  }

  // 待决列表(来自投影,不读磁盘 —— 投影本身就是可重建物化索引)。
  async function stewardPendingList() {
    const index = await getPretenderProjectionIndex().catch(() => null);
    const out = [];
    for (const slice of (index && Array.isArray(index.sessions) ? index.sessions : [])) {
      const sid = slice && safeSessionId(slice.sessionId);
      if (!sid || sid === STEWARD_SESSION_ID) continue;
      for (const iv of (Array.isArray(slice.interventions) ? slice.interventions : [])) {
        if (!iv || iv.status !== 'pending') continue;
        if (out.length >= STEWARD_PENDING_LIST_MAX) return out;
        out.push({
          sessionId: sid,
          missionId: String(slice.missionId || sid),
          interventionId: String(iv.id || ''),
          type: String(iv.type || ''),
          summary: stewardPendingOneLine(iv),
        });
      }
    }
    return out;
  }

  async function stewardVisit(opts) {
    const generation = stewardRunnerRuntime.conversationGeneration;
    const options = (opts && typeof opts === 'object') ? opts : {};
    const config = await readConfig().catch(() => ({}));
    if (config.stewardEnabledV1 !== true) return stewardFail('steward.disabled', 'the workbench steward is disabled (stewardEnabledV1=false)');
    if (generation !== stewardRunnerRuntime.conversationGeneration || stewardRunnerRuntime.inflight?.kind === 'reset') return stewardFail('steward.busy', '正在开始新对话');
    const idleMinutes = Math.max(1, Math.round(Number(config.stewardVisitIdleMinutes) || 60));
    const lastActivity = Date.parse(String(stewardRunnerRuntime.visit.lastActivityAt || ''));
    const idle = !Number.isFinite(lastActivity) || (Date.now() - lastActivity) > idleMinutes * 60 * 1000;
    const newVisit = options.force === true || idle;
    const previousStartedAt = stewardRunnerRuntime.visit.startedAt;
    const sinceSeq = Math.max(0, Number(stewardRunnerRuntime.visit.inboxSeq) || 0);
    const sinceFireSeq = Math.max(0, Number(stewardRunnerRuntime.visit.fireSeq) || 0);   // 123-M2 承诺三项的第二个水位

    // 116-3 P0-6(对抗审查):到访归档与在途管家回合会【并发】读-改-写同一份管家会话文件。
    // saveSession 的 sessionWriteChains 只序列化「落盘」这个动作本身,不合并两个调用方各自持有的
    // 内存快照 —— 谁的 save 排在后面,谁那份快照就整份覆盖文件。后果是回合刚写的回复在归档件与活
    // 会话里【双双消失】,或者已归档的旧消息被复活,两种都不报错。
    // 修法:归档前等在途回合收尾(上限与用户抢占同一个 STEWARD_PREEMPT_WAIT_MS);等不到就
    // steward.busy —— 不归档、不重置到访,下一次打开再来(到访是可重试的,数据不是)。
    if (newVisit) {
      const inflight = stewardRunnerRuntime.inflight;
      if (inflight && inflight.promise) {
        await Promise.race([
          inflight.promise.catch(() => {}),
          new Promise(resolve => { const t = setTimeout(resolve, STEWARD_PREEMPT_WAIT_MS); if (t && t.unref) t.unref(); }),
        ]);
      }
      if (stewardRunnerRuntime.inflight) {
        return stewardFail('steward.busy', '管家正在跑一个回合,归档要等它收尾才安全;稍后再打开一次', {
          inflight: String(stewardRunnerRuntime.inflight.kind || ''),
        });
      }
    }

    let archive = { archived: 0, file: '', kept: -1 };
    // 116-3 P2-14:归档写文件失败(磁盘满、visits 目录被占用……)此前被 .catch 吞成「归档成功的新到访」——
    // 时间戳照常重置,于是基于 stewardVisitIdleMinutes(默认 60 分钟)的下一次自动到访要再等一整个
    // 静默窗口才重试,期间没有任何错误呈现给用户。修法:失败就【不推进到访状态】(下一次调用仍视为
    // 「到访还没真正开始」,可以立刻重试),并把 archive.error 带进响应体供上层如实说人话。
    let visitOpened = newVisit;
    if (newVisit) {
      archive = await stewardArchiveConversation(config, previousStartedAt || nowIso(), { generation })
        .catch(error => ({ archived: 0, file: '', kept: -1, error: String((error && error.message) || error).slice(0, 300) }));
      if (generation !== stewardRunnerRuntime.conversationGeneration) return stewardFail('steward.cancelled', 'conversation changed');
      if (archive.error) {
        visitOpened = false;
        try { logEvent({ kind: 'steward_visit_archive_failed', error: archive.error }); } catch { /* 观测绝不反噬 */ }
      } else {
        // 到访重置:读预算桶(§11.2 每回合 6 次 / 每到访 stewardReadBudgetChars)与无进展计数一起归零。
        try { clearStewardReadBudget(STEWARD_SESSION_ID); } catch { /* 桶是纯内存加速,清不掉也不影响正确性 */ }
        stewardRunnerRuntime.noProgress = 0;
        stewardRunnerRuntime.circuit = null;
        stewardRunnerRuntime.visit = {
          startedAt: nowIso(),
          lastActivityAt: nowIso(),
          inboxSeq: sinceSeq,
          fireSeq: sinceFireSeq,
          previousStartedAt: previousStartedAt || '',
        };
      }
    }
    const digest = await stewardVisitDigest(sinceSeq, sinceFireSeq);
    if (generation !== stewardRunnerRuntime.conversationGeneration) return stewardFail('steward.cancelled', 'conversation changed');
    if (visitOpened) {
      stewardRunnerRuntime.visit.inboxSeq = digest.inboxSeq;   // 下次到访从这里往后归纳
      stewardRunnerRuntime.visit.fireSeq = digest.fireSeq;     // 123-M2:fires 那本账各走各的水位
    }
    const pending = await stewardPendingList();
    // 124 还债④(40 号文 §8.5 ④):**服务端不再自己挑「现在这一件」**,只把行投影出去。
    //
    // 修前这里有自己的一条挑选式:
    //     rows.find(needs_you) || rows.find(running) || rows[0]
    // 而界面那一份(public/js/thread-facts.js 的 focusThreadFor,124 走查② 之后是「等你 > 在跑 >
    // 最近发生的那一件」)判的是同一个问题:右栏「现在这一件」挑一条,问候语那枚「打开这一件」挑
    // 另一条。两处的第三档修前本来就不一样 —— 上面 stewardThreadDigestRows 的排序把 dispatching
    // 顶在「其余」之前,于是一条排队中的线程会赢过刚刚做完的那条。同一个问题两处判,迟早各说各话。
    //
    // 收法:这里只投影事实(id / 名字 / 五态 / 最后动静),挑哪一条由前端那一份纯函数判 —— 它有
    // unit 真值表与 focus-rail B1 两道锁,而本文件里再没有第二条挑选式(steward-runner.static 钉着)。
    // 帽子复用总览那一个(STEWARD_DIGEST_LIMITS.maxThreads = 40),不另起旋钮;行序保持
    // stewardThreadDigestRows 的优先序,所以裁掉的只可能是【既不等你也不在跑】的那些。
    const rows = await stewardThreadDigestRows(config).catch(() => []);
    const threads = rows.slice(0, STEWARD_DIGEST_LIMITS.maxThreads).map(row => ({
      sessionId: row.sessionId,
      // 116-5b:名字走显示名(缺摘要时回落到原话),与修前 focus.title 逐字同源。
      title: row.displayTitle || row.digest.title,
      state: row.state,
      updatedAt: row.updatedAt,
    }));
    return {
      ok: true,
      // 116-3 P2-14:归档失败时如实说「这次到访没真正开始」—— 时间戳没推进,下一次调用会立刻再试一次。
      newVisit: visitOpened,
      since: previousStartedAt || '',
      visit: { startedAt: stewardRunnerRuntime.visit.startedAt, lastActivityAt: stewardRunnerRuntime.visit.lastActivityAt },
      archive,
      digest: { items: digest.items, counts: digest.counts, commitments: digest.commitments },
      pending,
      // 124 还债④:不再回 focus —— 挑哪一条由前端那一份 focusThreadFor 判(§8.5 ④)。
      // 行里的名字仍走显示名(116-5b),与修前 focus.title 逐字同源。
      threads,
    };
  }

  return {
    stewardResetConversation, stewardVisit, stewardVisitDigest,
  };
}

module.exports = { createStewardConversationVisits };
