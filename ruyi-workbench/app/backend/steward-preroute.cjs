'use strict';

function createStewardPreroute({ dependencies }) {
  const {
    getPretenderProjectionIndex, memoryIsExpired, prerouteText, readConfig, safeSessionId,
    stewardForeignProjection, stewardReadMemoryStore, stewardThreadDigestRows,
  } = dependencies;

  // 第 116 波 116-pre(27 号文 §8.12「递话：交给线程的交互」/ §11.1 第 3 项/ §11.3):递话预判端点。
  //
  // 装配纪律:index 的事实源与上面 stewardThreadDigestRows 完全相同(13e 投影 + 会话头 + 06i 五态判据),
  // 本节【复用同一个函数】而不是另起一份 —— 116c 交付记录已经写明「13g 不能复用 13h 的函数(前向边)」,
  // 但 preroute 端点本来就住在 13h 里,同文件内调用零边可言,是最省心的复用方式。
  //
  // 缓存(§11.3 交付物「按 13e 投影的 changeSeq 总和或最近会话 updatedAt 作为缓存键,命中则不重装配」):
  // getPretenderProjectionIndex() 内部已经是增量维护的运行时缓存(source stamp 没变就不重扫会话),
  // 它的整体 revision 已经是「本次投影所有 changeSeq 与卡片状态」的一个哈希摘要 —— 拿它当缓存键的一半,
  // 比自己重新求和一遍 changeSeq 更省一次遍历。(116-5b 补上另一半 builtAt:revision 只覆盖【有卡片的】
  // 会话,速查线程的会话头改了它不会变 —— 详见下面 stewardPrerouteIndexRows 里那段注释。)
  // 命中时跳过的是【每会话一次 stewardReadSessionHead 文件读】那一段(§11.3 的目标 p50 ≤50ms 主要靠它)。
  // 只在内存,不写盘;开关关时这段代码根本不会被调到(见路由分支)。
  const _stewardPrerouteCache = { revision: '', rows: [] };
  async function stewardPrerouteIndexRows(config) {
    const index = await getPretenderProjectionIndex().catch(() => null);
    // 116-5b:缓存键从「只看 revision」改成「revision + builtAt」。revision 只由【事项卡片】与待决行
    // 算出(见 13e finalizePretenderIndex:missionRows 过滤掉了 card 为 null 的会话),所以一条
    // 【速查线程】的会话头改了 —— 比如本波的摘要刚落盘 —— revision 一个字节都不会变,这里就会一直
    // 回一份旧行,递送候选列表于是永远显示那条速查线程的原话。而速查线程恰恰是本波最需要起名字的那种
    // (13g 建完显式清了 titleSource 就是为了让它拿到摘要)。builtAt 只在投影【真的重建过】时才变
    // (getPretenderProjectionIndex 没有脏会话时直接返回同一个对象),所以连续敲字那段快路径一次没丢,
    // 多出来的只是「投影确实重建了一次」时多装配一次行。ETag 那一侧完全不受影响:这是 13h 自己的
    // 进程内 memo 键,不是 revision 的定义。
    const revision = String((index && index.revision) || '') + '|' + String((index && index.builtAt) || '') + '|' + String(config && config.privacyModeV1 || 'off');
    if (index && revision === _stewardPrerouteCache.revision) return _stewardPrerouteCache.rows;
    const digestRows = await stewardThreadDigestRows(config);
    const rows = digestRows.map(row => ({
      sessionId: row.sessionId,
      missionId: row.missionId || row.sessionId,
      missionTitle: (row.digest && row.digest.missionTitle) || '',
      title: (row.digest && row.digest.title) || '',
      // 116-5b:显示名单独一个键。**不覆盖 title** —— prerouteText 的词法打分吃的就是 title,
      // 把它换成压过的名字等于把用户当时打的那些词从索引里抹掉(见 06i stewardPrerouteHit 处的原注释)。
      displayTitle: row.displayTitle || (row.digest && row.digest.title) || '',
      // 116-pre 交付物口径:「summary(lastAssistantText 或摘要,≤400 字)」——digest.lastSay 就是
      // head.summary(诚实纪律:原话,不经模型改写),这里只做 400 字截断,不重新中和(stewardSanitizeText
      // 在 prerouteText 内部拼 reason/title 时才需要,summary 只参与打分不进返回值)。
      summary: String(stewardForeignProjection((row.digest && row.digest.lastSay) || '')).slice(0, 400),
      state: row.state,
      updatedAt: row.updatedAt,
    }));
    if (revision) { _stewardPrerouteCache.revision = revision; _stewardPrerouteCache.rows = rows; }
    return rows;
  }

  // StewardHooks.preroute 的实现(§11.3「把 preroute(q) 挂到 StewardHooks,117 与 116f 都可能用」)。
  // config 可选:路由处已经 readConfig() 过,直接传进来省一次重读;其余调用方(117 壳层)不传时自己读一遍。
  // 128h-J03:extra.focus —— 输入区右栏那条(现在这一件)。只进纯函数的 focusSessionId,不进提示词;不在索引里的 id 在纯函数里自然作废。
  async function stewardPreroute(q, configArg, extra) {
    const config = (configArg && typeof configArg === 'object') ? configArg : await readConfig();
    const [index, memoryStore] = await Promise.all([
      stewardPrerouteIndexRows(config).catch(() => []),
      stewardReadMemoryStore().catch(() => ({ entries: [] })),
    ]);
    const nowMs = Date.now();
    const memory = (memoryStore.entries || [])
      .filter(e => e && e.state !== 'vetoed' && (e.kind === 'focus' || e.kind === 'habit'))
      // 107-M1:【过期条目不参与预判打分】。本函数是 stewardReadMemoryStore 的第二个读取口 ——
      // 44 号文 §1.2 当时写的「提示词块(13o)走的就是 13l 那一口,不必散到调用方」漏了它:上面的
      // stewardMemoryBlock 确实走 StewardHooks.memorySearch(已滤过期),但**本函数直接读库**,
      // 于是早该过期的 focus 会一直给某条线程 +memoryBonus(06i 的 stewardPrerouteScoreThread)。
      // 判据仍然只有一处:06d 的 memoryIsExpired —— 静态锁 ⑫ 明文禁止别处自己算
      // (dev-harness/steward-tools.static.e2e.js),⑫b 另外要求每个读取口都表态。
      // 同一个 nowMs 喂给整批:一次调用里两条条目不该用两个不同的「现在」。
      .filter(e => !memoryIsExpired(e, nowMs))
      // 107-M1【作用域:这里**故意**不按作用域过滤,不是漏改】。三条理由,来「修」它之前请先读:
      //   ① 管家不在任何一个项目里(126-M01 的拍板,见本文件 stewardMemoryBlock 处那段注释),
      //      而 preroute 连 cwd 都拿不到 —— 入参只有 q 与 config。要过滤就得凭空指定一个「当前
      //      项目」,而出厂 defaultWorkspace 就是主目录(见 stewardWorkspaceTableBlock 的头注),
      //      拿它当当前项目等于把几乎所有项目级记忆静默丢掉。
      //   ② 预判用记忆的方式与提示词块不同:它只把记忆文本当【词法针的来源】(06i 的
      //      stewardPrerouteMemoryHit 判的是「线程标题出现在记忆文本里」),不把记忆当成断言。
      //      项目 A 的记忆里提到某个标题,说明用户在意那件事;把这句话递给那条线程仍然是对的。
      //      而过期不同:「这两周在赶 A」两周后连「用户在意」都不成立了,所以那一条必须滤。
      //   ③ 真正更准的做法是「项目级记忆只给【同项目的线程】加分」,但那不是加一道过滤:索引行
      //      (stewardPrerouteIndexRows)今天不带 cwd,而打分在 06i,06i 够不着 13j 的
      //      stewardMemoryScopeMatches(前向边;静态锁 ⑬ 的头注记了同一个坑)。那是一刀设计改动,
      //      不在本刀内。steward-preroute.e2e 的 (F5) 把「项目级记忆照常加分」钉成了行为断言,
      //      哪天改主意要连它一起改。
      .map(e => ({ kind: e.kind, text: e.text }));
    const focus = safeSessionId(extra && extra.focus) || '';
    return prerouteText(q, index, memory, { focusSessionId: focus });
  }

  return { stewardPreroute, stewardPrerouteIndexRows };
}

module.exports = { createStewardPreroute };
