'use strict';
const fsp = require('node:fs/promises');
const path = require('node:path');

function createStewardWorkspaces({
  dataRoot, dataRootAliases, nowIso, sanitizeFsSegmentName, safeSessionId, mutateConfig, normalizeWorkspacePathString,
  sessions, missions, rules,
}) {
  const { listSessions, sessionMetaIsSteward, stewardRawKind, stewardReadSessionHead } = sessions;
  const { readMissionContainer, withMissionContainerLock, writeMissionContainer } = missions;
  const { STEWARD_WORKSPACE_TABLE_MAX, stewardRuyiOwnedPath, stewardWorkspaceLabels, stewardFail } = rules;

  // ── 117w-W1 提交①(27 号文 §11.19.4):cwd 校验先行 ──────────────────────────────────────
  // 病灶:thread_new / quick_ask 原先把 args.cwd 【原样透传】给 createSession(零校验),而 createSession
  // 的回落链是 `cwd || config.defaultWorkspace || os.homedir()`。校验先行:表外一律拒,不静默回落。
  //
  // W7(用户 2026-09-24:「如果是如意自己开的工作区,默认不显示在常用工作区中,不要让用户自己感知到;
  // 然后管家需要把工作区和任务联系起来,有时候很多任务应该在特定工作区开的,管家会新开工作区」)
  // 把这一节从「三态」改成【一条选择顺序】,并把「表」扩成【已知工作区】。根因三条,如实记:
  //   ① 管家上下文里的候选表只给末段名(全路径是围栏信息),而这里的校验【只收绝对路径】—— 模型照表
  //      填回来的名字一律被当成相对路径拒掉,拒绝文案又教它「不确定就省掉 cwd」。于是它从来填不对任何
  //      一个 cwd,每件事都走省略 → 在 Ruyi 根下按标题新开一个文件夹(真机两条股票线程各开了一个)。
  //   ② 省略 cwd 时没有任何「沿用」:同一事项、接着某条线程的活,也照样按标题新开。
  //   ③ 新开的文件夹被追加进 workspaces[] —— 那张表就是界面上的「常用工作区」,用户于是看见一串
  //      自己没开过的文件夹。
  // 改法:
  //   · 已知工作区 = 用户的常用工作区(config.workspaces,第一行是默认)∪ 如意自己开的文件夹
  //     (config.stewardManagedWorkspaces)。每行有一个【名字】(06i stewardWorkspaceLabels:末段名,撞名
  //     往上多带一段),上下文里给的是名字,这里收名字,也收绝对路径。recentWorkspaces 仍不进(打开过 ≠ 授权过)。
  //   · 选择顺序(stewardResolveThreadCwd):① 明确给了 cwd → 用它;② 带了 missionId 且事项容器记着
  //     工作区 → 沿用;③ 带了 relatedSessionId → 沿用那条线程的目录;带了 missionId → 沿用同事项里最近一条
  //     线程的目录;④ 都没有 → 在 Ruyi 根下按标题新开一个文件夹,登记进如意自己那张表(不进常用工作区)。
  //     派生失败才落到 createSession 的回落链(用户默认工作区)。
  //   · 为什么第 ④ 步不是「用户默认工作区」(派单稿的写法):真机的默认工作区就是主目录根 —— 03 的
  //     cwdWarning 把它判成最高风险目标,13n 的同目录写锁又会让所有落在那儿的线程排成一队(40 号文 §8
  //     那次灌水 409 就是这么来的)。默认工作区仍在清单第一行、标着「默认」,活属于它就由管家点名。
  //
  // 归一化用仓里既有的那一份:01-config 清洗 workspaces 时用的 normalizeWorkspacePathString(剥
  // Windows「复制为路径」带的引号 + trim + 截 1000),外加 path.resolve 收斜杠与尾斜杠。两侧【同一个
  // 函数、同一个顺序】,否则表里的 `C:\a\` 与传入的 `C:/a` 会被判成两个东西。
  // 候选上限【读 06i 的 STEWARD_WORKSPACE_TABLE_MAX】,与 13o 的清单投影同一个数字(§11.19.7 裁决)。

  // 把一个工作区路径字符串折成可逐字比较的规范形;非绝对路径一律折成 ''(相对路径会被 path.resolve
  // 按【服务进程的 cwd】补全,那是一条无声的越权路,所以在这里就掐掉)。
  function stewardCanonWorkspacePath(stewardWsPathRaw) {
    const cleaned = normalizeWorkspacePathString(stewardWsPathRaw);
    if (!cleaned || !path.isAbsolute(cleaned)) return '';
    return path.resolve(cleaned);
  }

  // 目录比较沿用配置表中的规范路径，保留路径大小写。
  function stewardFoldWorkspacePath(stewardWsPathCanon) {
    return String(stewardWsPathCanon);
  }

  // W7:已知工作区(同步、纯读配置)。用户的常用工作区在前(顺序即优先级),如意自己开的在后(新开的在前)。
  // 每行 { path(规范形), label, user, isDefault, write, note, owned }:owned = 如意自己开的、用户还没收编。
  // 管家上下文里的清单(13o)、这里的 cwd 校验、thread_status 等读模型的 workspace 名字,三处读同一份。
  function stewardKnownWorkspaces(stewardKnownConfig) {
    const out = [];
    const seen = new Set();
    const defaultKey = stewardFoldWorkspacePath(stewardCanonWorkspacePath(stewardKnownConfig && stewardKnownConfig.defaultWorkspace));
    const push = (row, extra) => {
      const canon = stewardCanonWorkspacePath(row && row.path);
      if (!canon) return;
      const key = stewardFoldWorkspacePath(canon);
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ path: canon, ...extra, isDefault: extra.user === true && key === defaultKey });
    };
    for (const row of (Array.isArray(stewardKnownConfig && stewardKnownConfig.workspaces) ? stewardKnownConfig.workspaces : [])) {
      push(row, { user: true, write: !(row && row.write === false), note: String((row && row.note) || ''), owned: false });
    }
    const managed = Array.isArray(stewardKnownConfig && stewardKnownConfig.stewardManagedWorkspaces) ? stewardKnownConfig.stewardManagedWorkspaces : [];
    for (let i = managed.length - 1; i >= 0; i--) {
      const row = managed[i];
      push(row, { user: false, write: true, note: '', owned: !(row && row.adopted === true) });
    }
    const labels = stewardWorkspaceLabels(out.map(row => row.path));
    out.forEach((row, i) => { row.label = labels[i]; });
    return out;
  }

  // 名字或绝对路径 → 已知工作区那一行(没有就 null)。名字按不分大小写比:06i 造名字时就是按不分大小写
  // 去撞车的,所以同一份清单里不会有两个只差大小写的名字。
  function stewardMatchKnownWorkspace(stewardMatchRaw, stewardMatchKnown) {
    const raw = String(stewardMatchRaw == null ? '' : stewardMatchRaw).trim();
    if (!raw) return null;
    const known = Array.isArray(stewardMatchKnown) ? stewardMatchKnown : [];
    const canon = stewardCanonWorkspacePath(raw);
    if (canon) {
      const key = stewardFoldWorkspacePath(canon);
      return known.find(row => stewardFoldWorkspacePath(row.path) === key) || null;
    }
    const wanted = normalizeWorkspacePathString(raw).replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
    return wanted ? (known.find(row => String(row.label).toLowerCase() === wanted) || null) : null;
  }

  // 一条路径的【名字】(给读模型用):落在哪个已知工作区里就报那个工作区的名字(子目录也归它),
  // 不在任何一个里报末段名。owned 与 06i 的 stewardRuyiOwnedPath 同一口径(数据根里的也算如意的)。
  function stewardWorkspaceNameOf(stewardNameCwd, stewardNameConfig, stewardNameKnown) {
    const canon = stewardCanonWorkspacePath(stewardNameCwd);
    if (!canon) return null;
    const known = Array.isArray(stewardNameKnown) ? stewardNameKnown : stewardKnownWorkspaces(stewardNameConfig);
    const key = stewardFoldWorkspacePath(canon);
    let best = null;
    for (const row of known) {
      const rowKey = stewardFoldWorkspacePath(row.path);
      if (key === rowKey || key.startsWith(rowKey + path.sep) || key.startsWith(rowKey + '/')) {
        if (!best || row.path.length > best.path.length) best = row;
      }
    }
    return {
      name: best ? best.label : (path.basename(canon) || canon),
      ruyiOwned: stewardRuyiOwnedPath(canon, stewardNameConfig, dataRoot(), dataRootAliases()),
    };
  }

  // 返回 { ok:true, cwd, label, owned } —— cwd 为 undefined 表示「没给」;或 { ok:false, fail } —— fail 是现成的稳定信封。
  // thread_new 与 quick_ask 两处【共用这一份】,不许各抄一遍(静态锁钉着出现次数)。13t 的定时任务也用它复核 workdir。
  function stewardValidateCwd(stewardCwdRaw, stewardCwdConfig) {
    const given = stewardCwdRaw == null ? '' : String(stewardCwdRaw);
    if (!given.trim()) return { ok: true, cwd: undefined };          // 没给 → 交给选择顺序的后几步
    const known = stewardKnownWorkspaces(stewardCwdConfig);
    const hit = stewardMatchKnownWorkspace(given, known);
    if (hit) return { ok: true, cwd: hit.path, label: hit.label, owned: hit.owned };   // 名字或路径命中 → 用那一行的规范值
    // 其它 → 拒。人话说清「不在已知工作区里」并列出名字(名字足够让模型改对,又不泄露全路径)。
    const names = known.slice(0, STEWARD_WORKSPACE_TABLE_MAX).map(row => row.label);
    const more = known.length > STEWARD_WORKSPACE_TABLE_MAX ? `,另有 ${known.length - STEWARD_WORKSPACE_TABLE_MAX} 个未列出` : '';
    const message = names.length
      ? `cwd 不在已知工作区里(不要自己编路径)。现有:${names.join('、')}${more}。cwd 填其中一个的名字;要用别处请先请用户在设置里把那个文件夹加成工作区;跟哪个都不沾边就【省掉 cwd】,不要重试同一个值。`
      : 'cwd 不在已知工作区里,而且现在一个工作区都没有登记。请【省掉 cwd】,不要重试同一个值。';
    return { ok: false, fail: stewardFail('invalid_request', message, { reason: 'cwd_not_in_workspaces' }) };
  }

  // W7:能不能【沿用】一条线程或一个事项的目录。三条:目录还在(沿用一个被删掉的目录,线程的工具会全部
  // 失败);不在数据根里(管家会话自己的 cwd 就是数据根 —— 落进去会和管家抢 13n 的同目录写锁;子代理
  // worktree 也在那儿,用完即删);是绝对路径。沿用【不要求】在已知工作区里:那个目录是用户或管家早先
  // 给那条线程定下的,03 已经把它当成那条线程的写根,新线程接着同一件事,只是站到同一块地上。
  async function stewardInheritableCwd(stewardInheritRaw) {
    const canon = stewardCanonWorkspacePath(stewardInheritRaw);
    if (!canon) return '';
    const dataKey = stewardFoldWorkspacePath(stewardCanonWorkspacePath(dataRoot()));
    const key = stewardFoldWorkspacePath(canon);
    if (dataKey && (key === dataKey || key.startsWith(dataKey + path.sep) || key.startsWith(dataKey + '/'))) return '';
    try {
      const stat = await fsp.stat(canon);
      if (!stat.isDirectory()) return '';
    } catch { return ''; }
    return canon;
  }

  // W7:cwd 的选择顺序(thread_new / quick_ask 共用;见本节头注)。返回
  //   { ok:true, cwd, source } —— source ∈ explicit / mission / related / mission_thread / new;
  //   cwd 为 undefined 时 source === 'new':调用方在 createSession 之后派生(要真线程 id 兜 slug)。
  //   { ok:false, fail } —— 给了但不合法的参数(表外 cwd、不存在的 relatedSessionId),不静默回落。
  async function stewardResolveThreadCwd(stewardResolveArgs, stewardResolveConfig, stewardResolveMissionId) {
    const args = (stewardResolveArgs && typeof stewardResolveArgs === 'object') ? stewardResolveArgs : {};
    const relatedRaw = args.relatedSessionId == null ? '' : String(args.relatedSessionId).trim();
    const relatedId = relatedRaw ? safeSessionId(relatedRaw) : '';
    if (relatedRaw && !relatedId) return { ok: false, fail: stewardFail('invalid_request', 'invalid relatedSessionId') };
    let relatedHead = null;
    if (relatedId) {
      relatedHead = await stewardReadSessionHead(relatedId);
      if (!relatedHead || !relatedHead.id || stewardRawKind(relatedHead) === 'steward') {
        return { ok: false, fail: stewardFail('not_found', `relatedSessionId ${relatedId} 不是一条线程;不确定就省掉它,不要重试同一个值`, { reason: 'related_not_found' }) };
      }
    }
    // ① 明确给了。
    const cwdCheck = stewardValidateCwd(args.cwd, stewardResolveConfig);
    if (!cwdCheck.ok) return cwdCheck;
    if (cwdCheck.cwd !== undefined) {
      // 如意自己开的那个文件夹被人删了:原地建回来(路径是工作台自己派生、自己登记的;13t 的定时任务同一做法)。
      // 用户的工作区不替他建 —— 那是他的地盘,修前也不查。
      if (cwdCheck.owned) await fsp.mkdir(cwdCheck.cwd, { recursive: true }).catch(() => {});
      return { ok: true, cwd: cwdCheck.cwd, source: 'explicit', relatedSessionId: relatedId };
    }
    // ② 事项容器记着的工作区。
    if (stewardResolveMissionId) {
      const container = await readMissionContainer(stewardResolveMissionId).catch(() => null);
      const fromMission = container ? await stewardInheritableCwd(container.cwd) : '';
      if (fromMission) return { ok: true, cwd: fromMission, source: 'mission', relatedSessionId: relatedId };
    }
    // ③ 相关线程:点名的那一条优先,其次同事项里最近动过的那一条。
    if (relatedHead) {
      const fromRelated = await stewardInheritableCwd(relatedHead.cwd);
      if (fromRelated) return { ok: true, cwd: fromRelated, source: 'related', relatedSessionId: relatedId };
    }
    if (stewardResolveMissionId) {
      const metas = await listSessions().catch(() => []);
      const siblings = metas
        .filter(meta => meta && !sessionMetaIsSteward(meta) && (meta.missionId || meta.id) === stewardResolveMissionId)
        .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
      for (const meta of siblings) {
        const fromSibling = await stewardInheritableCwd(meta.cwd);
        if (fromSibling) return { ok: true, cwd: fromSibling, source: 'mission_thread', relatedSessionId: relatedId };
      }
    }
    // ④ 都没有 → 新开(调用方派生)。
    return { ok: true, cwd: undefined, source: 'new', relatedSessionId: relatedId };
  }

  // W7:事项容器第一次有了工作区,就记下来(之后这个事项里新开的线程走选择顺序第 ② 步)。
  // 只在容器存在、且还没记过时写 —— 用户或早先那条线程定下的,不覆盖。失败吞掉:这是旁路记账,
  // 线程已经开成了,不能因为记不下事项的工作区就让整次调用失败。
  async function stewardRecordMissionWorkspace(stewardRecordMissionId, stewardRecordCwd) {
    const id = safeSessionId(stewardRecordMissionId);
    const cwd = stewardCanonWorkspacePath(stewardRecordCwd);
    if (!id || !cwd) return false;
    try {
      return await withMissionContainerLock(id, async () => {
        const current = await readMissionContainer(id);
        if (!current || String(current.cwd || '').trim()) return false;
        await writeMissionContainer(Object.assign({}, current, { cwd }));
        return true;
      });
    } catch { return false; }
  }

  // ── 117w-W1 提交②(27 号文 §11.19.2「子工作区派生」)────────────────────────────────────────
  // 选择顺序第 ④ 步:在 Ruyi 根下派生一条属于这条线程自己的子工作区。病灶是用户看到的那句「同一个
  // 文件夹被占着」:出厂 defaultWorkspace 就是主目录,十几条线程全挤在主目录根上 —— 而仓里自己的
  // 03 cwdWarning 恰恰把「cwd 落在主目录根」判成最高风险目标。
  // W7:派生出来的目录登记进如意自己那张表(stewardManagedWorkspaces),不再进常用工作区。
  const STEWARD_WORKSPACE_SLUG_MAX = 64;          // 目录名截到 64 字符(保留中文,只做文件系统安全处理)
  const STEWARD_WORKSPACE_DERIVE_TRIES = 50;      // 撞名后缀上限:slug、slug-2 … slug-50

  // 标题 → 目录名。非法字符表【复用 04 的 sanitizeFsSegmentName】(提交② 把 makeAttachmentRecord 里
  // 那条内联正则抽成了函数),这里不另写第二份 —— 两处分叉的后果是「附件名安全、目录名不安全」。
  function stewardWorkspaceSlug(stewardSlugTitle, stewardSlugSessionId) {
    const safe = sanitizeFsSegmentName(stewardSlugTitle)
      .replace(/\s+/g, ' ')                        // 制表/换行已被上面的控制字符档换成 '_',这里只并空格
      .replace(/_+/g, '_')                         // 连续替身并成一个:`<>:"` 不该变成四道下划线
      .slice(0, STEWARD_WORKSPACE_SLUG_MAX)
      // 首尾的替身/点/空格全剥掉。两个理由:Windows 目录名不许以点或空格【结尾】;而「"报告"」这种
      // 带引号的标题被替换后是 `_报告_`,首尾那两道下划线只是噪声。剥完为空 = 这条标题里没有任何
      // 可用作目录名的字符(整条都是非法字符),走下面的 id 回落。
      .replace(/^[_.\s]+/, '')
      .replace(/[_.\s]+$/, '');
    if (safe) return safe;
    // 标题为空,或整条被非法字符替换后只剩替身/点/空格 → 回落到线程 id。
    // 【与设计页的一处出入,如实记】§11.19.2 写「thread-<id 前 8 位>」,而 id 形如 sess_+16 位十六进制,
    // 直接切前 8 位得到的是 'sess_' + 3 位,几乎必然撞名;这里按【去掉 sess_ 前缀之后】的 8 位取。
    const short = String(stewardSlugSessionId || '').replace(/^sess_/, '').slice(0, 8);
    return 'thread-' + (short || 'unnamed');
  }

  // 撞名规则(§11.19.2):不存在 → 建它;已存在且【空】→ 直接复用(同一件事重开线程不该长出第二个
  // 空壳);已存在且【非空】→ 试 -2、-3…。同名的是文件、或读不动 → 换下一个后缀(开线程不该因为
  // 用户在 Ruyi 根下放了个同名文件就失败)。试满上限返回 dir:'' = 「没派生成」,调用方保持修前的回落链。
  // 返回值带 created(117w-W1④ 小刀):建目录在 mutateConfig 的串行段里,失败回滚时只许删【本次新建】
  // 的那个目录 —— 复用来的空目录可能是用户自己建的,删它就是删用户的东西。
  async function stewardDeriveWorkspaceDir(stewardDeriveRoot, stewardDeriveSlug) {
    for (let attempt = 1; attempt <= STEWARD_WORKSPACE_DERIVE_TRIES; attempt++) {
      const dir = path.join(stewardDeriveRoot, attempt === 1 ? stewardDeriveSlug : `${stewardDeriveSlug}-${attempt}`);
      let entries = null;
      try {
        entries = await fsp.readdir(dir);
      } catch (error) {
        if (error && error.code === 'ENOENT') {
          try { await fsp.mkdir(dir, { recursive: true }); return { dir, created: true }; } catch { continue; }
        }
        continue;
      }
      if (entries.length === 0) return { dir, created: false };
    }
    return { dir: '', created: false };
  }

  // 回滚:只删【本次新建】的空目录(stewardDeriveWorkspaceDir 的 created 那一支)。非空就留着 ——
  // 说明已经有别的东西写进去了,强删会毁用户数据。失败吞掉:回滚是尽力而为,它自己再抛出去会把
  // 「派生没成」这件正事盖掉。
  async function stewardDiscardDerivedWorkspaceDir(stewardDiscardDir) {
    if (!stewardDiscardDir) return;
    try { await fsp.rmdir(stewardDiscardDir); } catch { /* 非空,或已经被别人删了 */ }
  }

  // 把派生出来的目录【建目录 + 登记】做成一件事,整件坐在 mutateConfig 的串行段里(01-config 的
  // mutateConfig 是「读 -> mutator -> 写」的唯一临界区),口径只有一句:【要么行落盘,要么不算派生成】。
  // 为什么把文件 I/O 放进配置临界区:目录就一个,readdir/mkdir 是本地快操作;换来的是「占位与建目录
  // 之间不存在窗口」这一条不变量。
  // W7:登记的是 stewardManagedWorkspaces(如意自己那张表),不再往 workspaces[] 追加 —— 那张表就是
  // 用户的常用工作区。因此 117w-W1④ 那道「常用工作区表满了就拒开线程」的帽检查也一并退役:派生从此
  // 不占常用工作区的行;如意那张表满了由 01-config 从最老的一行起丢(STEWARD_MANAGED_WORKSPACES_CAP),
  // 新登记的这一行永远在尾部,不会被丢。
  // 返回:派生好的绝对路径,或 ''(撞名试满/写失败)。返回 '' 时调用方保持修前的回落链。
  async function stewardClaimDerivedWorkspace(stewardClaimRoot, stewardClaimSlug) {
    let builtDir = '';       // 本次 mkdir 出来的目录(回滚目标);复用已有空目录时永远留空
    let claimedDir = '';
    let claimedKey = '';
    let outcome = null;
    const keyOf = row => stewardFoldWorkspacePath(stewardCanonWorkspacePath(row && row.path));
    try {
      outcome = await mutateConfig(async current => {
        // ① 占目录。占不到(撞名试满)= 不派生,不留任何东西。
        const claimed = await stewardDeriveWorkspaceDir(stewardClaimRoot, stewardClaimSlug);
        if (!claimed.dir) return { abort: 'no_dir' };
        claimedDir = claimed.dir;
        if (claimed.created) builtDir = claimed.dir;
        claimedKey = stewardFoldWorkspacePath(stewardCanonWorkspacePath(claimed.dir));
        if (!claimedKey) return { abort: 'no_dir' };
        // ② 已经登记过(同一件事重开线程复用了空目录;或用户早把它加进了常用)-> 不写盘,那一行在盘上。
        const userRows = Array.isArray(current.workspaces) ? current.workspaces : [];
        const managed = Array.isArray(current.stewardManagedWorkspaces) ? current.stewardManagedWorkspaces : [];
        if (userRows.some(row => keyOf(row) === claimedKey) || managed.some(row => keyOf(row) === claimedKey)) return { abort: 'exists' };
        // ③ 追加在如意那张表的【末尾】(= 最新;01-config 满员时从头部丢)。
        // 这是工作台写自己的配置,不经 steward_config_set,所以不违反这张表的 forbidden 档。
        current.stewardManagedWorkspaces = managed.concat([{ path: claimed.dir, at: nowIso() }]);
        return {};
      });
    } catch {
      // ④ 落盘抛了(磁盘满/文件只读/降级期):行没落盘 —— 删掉本次新建的目录,不算派生成。
      await stewardDiscardDerivedWorkspaceDir(builtDir);
      return '';
    }
    // 成功判据是【写完之后那份配置里真有这一行】(两张表任一),不是 mutator 说了什么。
    const cfg = outcome && outcome.config;
    const landed = !!(cfg && claimedKey && [
      ...(Array.isArray(cfg.workspaces) ? cfg.workspaces : []),
      ...(Array.isArray(cfg.stewardManagedWorkspaces) ? cfg.stewardManagedWorkspaces : []),
    ].some(row => keyOf(row) === claimedKey));
    if (!landed) {
      await stewardDiscardDerivedWorkspaceDir(builtDir);
      return '';
    }
    return claimedDir;
  }

  // 选择顺序第 ④ 步的入口。返回派生好的绝对路径,或 ''(根不可用/撞名试满/写失败)—— 返回 '' 时调用方
  // 保持修前的回落链(createSession 的 `cwd || defaultWorkspace || homedir`),绝不拿一个假路径去跑。
  async function stewardDeriveThreadCwd(stewardDeriveTitle, stewardDeriveSessionId, stewardDeriveConfig) {
    const root = stewardCanonWorkspacePath(stewardDeriveConfig && stewardDeriveConfig.stewardWorkspaceRoot);
    if (!root) return '';
    // 建目录与登记是【一件事】(见 stewardClaimDerivedWorkspace):中间任何一步没成,都不会留下
    // 「目录建了、行没了」。这两件事不再拆成两次调用 —— 拆开就又把窗口打开了。
    return await stewardClaimDerivedWorkspace(root, stewardWorkspaceSlug(stewardDeriveTitle, stewardDeriveSessionId));
  }

  return {
    stewardCanonWorkspacePath, stewardFoldWorkspacePath, stewardKnownWorkspaces, stewardMatchKnownWorkspace,
    stewardWorkspaceNameOf, stewardValidateCwd, stewardResolveThreadCwd, stewardRecordMissionWorkspace, stewardDeriveThreadCwd,
  };
}

module.exports = { createStewardWorkspaces };
