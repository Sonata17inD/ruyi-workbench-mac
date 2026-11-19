'use strict';

function createStewardPromptMemory({ policy, dependencies }) {
  const {
    STEWARD_MEMORY_BLOCK_CHARS, STEWARD_MEMORY_KINDS, STEWARD_MEMORY_LIMITS, STEWARD_MEMORY_VETOED_BLOCK_CHARS,
    STEWARD_MEMORY_VETOED_MAX,
  } = policy;
  const { StewardHooks, memoryIsExpired, stewardMemoryScopeLabel, stewardSanitizeText } = dependencies;

  // ============================================================================
  // 第 117 波 T2(32 号文 §5「13h-steward-runner.js 2522 行」):管家回合的提示词装配与输出契约解析。
  //
  // 落点(transport 层,manifest 中位于 13n-steward-arbiter.js 之后、13p-steward-runner-actions.js 之前)。
  // T2 拆分:原 13h-steward-runner.js 已 2522 行 —— 比 T1 拆之前的 13g 还长,而 31 号文七轴的
  // 回合层改动(污染打标、代答/代批、通知)全要往它里面加。按「谁被谁引用」把它拆成六个
  // 文件,拼接顺序即依赖方向,零新增前向边:
  //   · 13m-steward-runner-base.js —— 六个文件都要用的共享面:落盘面常量、回合层数值口径、
  //     自理动作与到访摘要的文本表、可由 actions 执行的写工具白名单、运行时内存态
  //     stewardRunnerRuntime、停机/唤醒/中止,以及管家会话单例(引擎解析 + 懒创建);
  //   · 13n-steward-arbiter.js —— 116h 线程间仲裁(并发位 / 同 cwd 写锁 / 预算 / 可解释的排队 / 饥饿提升)。
  //     它排在提示词之前,因为总览行与递话通道都要读它的等待原因(stewardArbiterWait);
  //   · 13o-steward-runner-prompt.js —— 提示词装配(记忆块 / 线程摘要 / 递话预判 / 总览 /
  //     两个分叉入口)与 {say,acts,actions,why} 输出契约解析;
  //   · 13p-steward-runner-actions.js —— actions 执行与降级、116-2b 确定性自理动作、id 人话化、
  //     熔断、收件箱消息装配、输入区预判归一;
  //   · 13q-steward-runner-turn.js —— 回合入口 runStewardTurn、收件箱去抖驱动、到访与归档、
  //     117l D2 递话通道、117l D7 线程分档落盘、acts 落定;
  //   · 13h-steward-runner.js —— 两个「够不着才落在这里」的工具实现(thread_prioritize /
  //     thread_stop)、三条路由、运行器状态与 StewardHooks 注册表(排在最后:注册表要引用
  //     上面五个文件里的实现,排在后面才是后向边)。
  // 本次拆分是【纯搬家】:所有函数体逐字节不变,新写的只有各文件的头部注释。
  //
  // 依赖纪律(§11.3「不得新增前向边」):本文件只引用拼接顺序在它之前的模块符号
  // (00/01/02/04/06b/06i/08/09/10/13e/13g 族 …),全部后向边;它自己的符号只被排在它之后的
  // 管家运行器族文件与 14-main.js 的 e2e 导出面引用,同样是后向边。
  // ============================================================================
  // ────────────────────────────────────────────────────────────────────────────
  // 提示词装配(§11.2 分层):稳定层 = 06b steward.stable;易变层 = 记忆块 + 线程总览 + 尾句。
  // ────────────────────────────────────────────────────────────────────────────

  // 记忆块:直接用 116c 的门控工具实现(同一份读取与同一道门),按 kind 分组,整块 ≤3000 字符。
  async function stewardMemoryBlock(session, config, pack) {
    let entries = [];
    try {
      // 128h-J12:这一口现在**连被否决的条目一起取**,取回来在本函数里分成两半 ——
      //   · 生效清单:口径与修前逐字相同(active 且没过期);
      //   · 否决清单:【不看过期】。否决与到期是两件事,而 13l 那道写回闸拦 vetoed 时也不看 expiresAt ——
      //     两处口径必须一致,否则会出现「闸拦得住、提示词里却没有它」的那种查不明白的场面。
      // 代价照实记:返回条数仍被 searchLimit(50)封顶,否决条目会占掉几个名额。库里生效条目本来就已经
      // 被 3000 字的块预算截在 50 行上下,影响是几行的量级,不值得为它多读一次盘(两次读 = 两个快照,
      // 中间有写就会自相矛盾)。
      const found = await StewardHooks.memorySearch(
        { limit: STEWARD_MEMORY_LIMITS.searchLimit, includeVetoed: true, includeExpired: true },
        { session, config });
      entries = (found && Array.isArray(found.entries)) ? found.entries : [];
    } catch { entries = []; }
    // 一次装配只用一个「现在」(同 107-M1:一次调用里两条条目不该用两个不同的 now)。判据仍是 06d 的
    // memoryIsExpired —— 本文件不自己解析 expiresAt(静态锁 ⑫)。
    const nowMs = Date.now();
    const live = entries.filter(e => e && e.state === 'active' && !memoryIsExpired(e, nowMs));
    const vetoedBlock = stewardMemoryVetoedBlock(entries, pack);
    if (!live.length) return pack.steward.memoryHeader + '\n' + pack.steward.memoryEmpty + vetoedBlock;
    const lines = [];
    for (const kind of STEWARD_MEMORY_KINDS) {
      const rows = live.filter(e => e.kind === kind);
      for (const row of rows) {
        const source = row.sourceSessionId ? `来源 ${stewardSanitizeText(row.sourceSessionId)}` : '来源未记';
        // 126-M01(44 号文 §7 ④ 的拍板):管家**不在**任何一个项目里 —— 它是跨项目的看护者,
        // 所以这里【不按作用域过滤】,而是把项目条目**标出来**。把它们整个藏掉是信息损失;
        // 把它们当成到处成立才是今天的 bug。标出项目名,两头都不占。
        const scopeNote = stewardMemoryScopeLabel(row.scope, config);
        const evidence = row.basis === 'activity' ? `,行动推断 confidence=${row.confidence};非用户确认,不能代答或授权` : '';
        lines.push(`- [${kind}#${stewardSanitizeText(row.id)}] ${stewardSanitizeText(row.text)}(${source},用过 ${Math.max(0, Number(row.useCount) || 0)} 次${scopeNote}${evidence})`);
      }
    }
    if (!lines.length) return pack.steward.memoryHeader + '\n' + pack.steward.memoryEmpty + vetoedBlock;
    const out = [];
    let used = 0;
    for (const line of lines) {
      if (used + line.length + 1 > STEWARD_MEMORY_BLOCK_CHARS) break;
      out.push(line);
      used += line.length + 1;
    }
    // 128h-J13:「本次显式要求优先」紧跟在条目后面 —— 放在清单【之后】是有意的:模型读完这些偏好,
    // 下一句就看到「用户这次说的更大」。没有任何生效条目时不出这句(没有偏好可被盖过)。
    return pack.steward.memoryHeader + '\n' + out.join('\n') + '\n' + pack.steward.memoryPrecedence + vetoedBlock;
  }

  // 128h-J12:被否决条目的清单(自带预算,永远排在生效清单之后)。
  // 为什么必须让模型看见:「旧条目不换说法复活」在修前只有服务端那道**词面**闸(Jaccard ≥0.8)在挡,而
  // 本刀实测(48 号文 128h 那一节的三类对照)表明词面重合度在「换说法」这个距离上与无关内容不可分 ——
  // 换说法中位 0.176、无关中位 0.059、**相反的偏好中位 0.556 最高**,序都是反的,任何中间阈值都是错判据。
  // 语义只有模型有,于是「谁被否决过」必须送到模型面前,这条纪律才有人能执行。
  // 预算独立(600 字 / 8 条)且排在后面:这是一份「别做什么」的清单,不该去挤生效偏好的 3000 字。
  function stewardMemoryVetoedBlock(entries, pack) {
    const rows = entries
      .filter(e => e && e.state === 'vetoed')
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    if (!rows.length) return '';
    const lines = [];
    let used = 0;
    let shown = 0;
    for (const row of rows.slice(0, STEWARD_MEMORY_VETOED_MAX)) {
      const line = `- [${stewardSanitizeText(row.kind)}#${stewardSanitizeText(row.id)}] ${stewardSanitizeText(row.text)}`;
      if (used + line.length + 1 > STEWARD_MEMORY_VETOED_BLOCK_CHARS) break;
      lines.push(line);
      used += line.length + 1;
      shown += 1;
    }
    if (!lines.length) return '';
    const more = rows.length - shown;
    const folded = more > 0 ? '\n' + pack.steward.memoryVetoedFolded({ more }) : '';
    return '\n' + pack.steward.memoryVetoedHeader + '\n' + lines.join('\n') + folded;
  }

  return { stewardMemoryBlock };
}

module.exports = { createStewardPromptMemory };
