'use strict';

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { START_ERROR_KINDS } = require('./server-start-notices.cjs');
const { createWorkbenchHttpServer } = require('./workbench-http-server.cjs');

function createOwnedServerStartup({
  paths, process, resolveBindHost, defaultDataRoots, lstatOrNull, isDirectServeInvocation, migrateLegacyDataRoot,
  ServerOwnership, DesktopExecutionHooks, finishBootCliPathProbes, startServerInner, startupGuidance, writeStartError,
}) {
  // 118c: 启动失败必须在【应用里】看得见,而不是只打在一个用户根本没打开的终端上。
  // 这层薄包装把三类致命失败落成 <data>/last-start-error.json(人话 + 下一步),
  // 下一次成功启动由 startServerInner 读出来交给前端顶部条;console 输出与退出码一字未改。
  async function startServer(opts) {
    // S13:绑定地址的合法性是命令行用法问题,不是「启动失败」—— 在 try 之外判,拒绝时不落 last-start-error.json(否则下次成功启动
    // 顶部条会冒出一条「再启动一次通常就好」的误导文字),也不碰数据目录。
    const bindHost = resolveBindHost(opts);
    // Acquire before any recovery, imports, index invalidation, or startup error writes.
    // Only the real pending legacy migration also owns its destination; mkdir(next) here
    // would disable migration, so canonicalRoot resolves absent leaves via their real ancestor.
    const roots = [paths.data];
    const defaults = defaultDataRoots();
    const old = lstatOrNull(defaults.legacy);
    const migrate = isDirectServeInvocation() && !process.env.RUYI_HOME
      && !lstatOrNull(defaults.next) && old && old.isDirectory() && !old.isSymbolicLink();
    if (migrate) roots.push(defaults.legacy, defaults.next);
    const ownership = await ServerOwnership.acquire(roots); // Refusal must not touch the owner's files.
    try {
      let migration = null;
      if (isDirectServeInvocation()) {
        migration = migrateLegacyDataRoot();
        if (migration.moved) {
          // Rebase shared paths before recovering stores and starting runtime writers.
          // Keep the same object for every consumer even if the legacy link cannot be created.
          const from = paths.data;
          const to = migration.to;
          for (const key of Object.keys(paths)) paths[key] = path.join(to, path.relative(from, paths[key]));
          await ownership.confirmRoot(to, migration.from);
        }
      }
      // Initialize execution recovery under the OS gate, before any engine/client or startup recovery.
      await DesktopExecutionHooks.initialize(ownership);
      const result = await startServerInner(opts, bindHost, migration);
      await ownership.releaseStartup();
      return result;
    } catch (error) {
      const kind = error && START_ERROR_KINDS.includes(error.ruyiStartErrorKind) ? error.ruyiStartErrorKind : 'startup-failed';
      const recoveryHelp = startupGuidance(error);
      const message = String(recoveryHelp || (error && error.message) || error || '').slice(0, 800)
        || '如意启动时出错了,没能开起来。';
      await writeStartError(kind, message);
      // Boot may already have started asynchronous writers. Keep ownership until process exit,
      // including a programmatic caller's failed boot; same-process restart is not supported.
      throw error;
    } finally {
      finishBootCliPathProbes();
    }
  }

  return startServer;
}

function createServerStartup({
  paths, RUNTIME, process, identity: { APP_NAME, VERSION, OVERLAY_ID, DEFAULT_PORT, externalServerJs },
  notices: { START_NOTICE, consumeStartError, listenWithFallback },
  network: { isLoopbackBindHost, recordRequestMetric, hostAllowed, handleApi, serveStatic },
  storage: { ensureDirs, mutateSession, safeJsonParse, invalidateSessionIndex, flushSessionIndexSync,
    flushUsageLedgerSync, atomicWriteJson, storageSweep, sweepStaleScriptFiles },
  recovery: { markInterruptedAgentRuns, markInterruptedInterventions, scheduleAgentWakesAtBoot,
    warmPretenderProjectionIndex, autoResumeInterruptedRuns, migrateLegacyAccMemory },
  config: { readConfig, syncClaudeCliSettings, syncAgentRolesToClaude, autoImportClaudeCodeMcp,
    recordInstallLaunch, syncAgentInstructionImports, syncMcpServersToClaude,
    getCapabilities, generateMcpConfig },
  probes: { beginBootCliPathProbes, waitForBootCliPathProbes, finishBootCliPathProbes, ensureDesktopMcpWarm },
  runtime: { activeChildren, stopSession, startScheduler, stopScheduler, killAllMcpClients, killAllShellSessions,
    EventStreamHooks, ExternalBotHooks, StewardHooks, ToolboxHooks, platformOpenSpawn, spawnDetachedChecked },
  nowIso, logEvent,
}) {
  // hunt2-steward ⑤:启动清扫。until-done 驱动器只活在拉起它的那一次 runSessionTurn 里 —— 进程一重启,
  // 磁盘上仍写着 autoMode:'until-done' 的账本就再也没人推,线程五态却按它判成 running,永远不落地。
  // 与 markInterruptedAgentRuns / markInterruptedInterventions 同一立场:重启 = 上次生命周期结束,不自动续跑
  // (那要重新起回合、重新烧 token,得用户点头),而是诚实地降成 supervised,「继续」按钮随之可点。
  // 已收工(result.status === 'complete')的账本保留原值:五态先按 complete 判 done,改它只是白写一次盘。
  // 成本:只读会话头(正文在 .messages.ndjson 里,不碰),先按子串筛,命中才解析、才整份装载改写。
  // 在 listen 之前 await:此刻没有任何回合在跑。改写走 mutateSession(后台读-改-写的唯一原语)。
  async function resetOrphanedMissionDrivers() {
    let files = [];
    try { files = await fsp.readdir(paths.sessions); } catch { return 0; }
    let reset = 0;
    for (const f of files) {
      const hit = /^(sess_[A-Za-z0-9_-]+)\.json$/.exec(f);
      if (!hit) continue;
      const text = await fsp.readFile(path.join(paths.sessions, f), 'utf8').catch(() => '');
      if (!/"autoMode"\s*:\s*"until-done"/.test(text)) continue;
      const head = safeJsonParse(text, null);
      const hm = head && head.mission;
      if (!hm || hm.autoMode !== 'until-done' || (hm.result && hm.result.status === 'complete')) continue;
      const r = await mutateSession(hit[1], session => {
        if (!session.mission || session.mission.autoMode !== 'until-done') return { abort: 'not_armed' };
        session.mission.autoMode = 'supervised';
        session.mission.updatedAt = nowIso();
        return null;
      }, { writer: 'mission_driver_boot_reset' }).catch(() => null);
      if (r && r.ok) reset += 1;
    }
    if (reset) logEvent({ kind: 'mission_driver_boot_reset', sessions: reset });
    return reset;
  }

  // 安全走查 S13:--host 能绑非回环地址(0.0.0.0 / 局域网 IP / 主机名),而 Host 头是对端自己写的,
  // 页面 token 的下发又只看 Host 头 —— 绑出去等于把接口令牌送给局域网上任何人。所以非回环绑定必须【显式再加】
  // --allow-remote,否则启动即拒绝并说明原因;放行之后也只是「允许监听」:非本机对端拿不到 token(见 01 的 requestIsLoopback)。
  // 返回实际要绑的地址;纯函数(不碰盘、不碰全局),单测直调。
  function resolveBindHost(opts) {
    const raw = opts && opts.host;
    const host = typeof raw === 'string' && raw.trim() ? raw.trim() : '127.0.0.1';
    if (isLoopbackBindHost(host)) return host;
    const flag = opts && opts['allow-remote'];
    const allowed = flag === true || (typeof flag === 'string' && !/^(0|false|off|no)$/i.test(flag.trim()));
    if (allowed) return host;
    const error = new Error(`拒绝绑定非回环地址 ${host}:如意只应监听本机(127.0.0.1),页面与接口令牌的保护都以「对端在本机」为前提。`
      + ' 确需让别的机器访问,请显式追加 --allow-remote(并自行用防火墙限制来源;不要用同机反向代理转发 —— 经它进来的请求对端地址是 127.0.0.1,会被当成本机而拿到页面 token;非本机对端拿不到页面 token,须自带头 token)。'
      + ` / Refusing to bind non-loopback address ${host}: Ruyi is a local single-user tool. Pass --allow-remote explicitly if you really need it.`);
    throw error;
  }

  function stopAllActiveTurnsSync(reason = 'shutdown') {
    let stopped = 0;
    for (const id of [...activeChildren.keys()]) {
      try { if (stopSession(id, reason)) stopped += 1; } catch { /* 收尾绝不抛 */ }
    }
    return stopped;
  }

  async function startServerInner(opts, bindHost, migration) {
    beginBootCliPathProbes();
    try {
      await ensureDirs();
    } catch (error) {
      // 数据目录建不出来/写不进去(磁盘满、权限、被安全软件锁)。标类型后原样上抛,由 startServer 落盘。
      if (error && !error.ruyiStartErrorKind) error.ruyiStartErrorKind = 'data-dir-unwritable';
      throw error;
    }
    // 118c: 上一次启动失败的人话记录 -- 读出来挂进 START_NOTICE 并把文件删掉(一次性提示,不反复骚扰)。
    // 【必须在 listen 之前做】:listen 之后到 RUNTIME.port/host/token 赋值之间【不许有任何 await】。
    // 服务一旦开始监听,健康探针立刻就能通,而握手常量还没写好 -- 那段窗口里进来的请求会看到空 token,
    // 桥接子进程的回调、能力探测因此偶发失败。这是本刀第一版真实踩到的坑(capabilities e2e 稳定复现)。
    START_NOTICE.lastError = await consumeStartError();
    if (START_NOTICE.lastError) console.log(`[start] previous launch failed (${START_NOTICE.lastError.kind}): ${START_NOTICE.lastError.message}`);
    // 3.0 数据目录改名(00-boot migrateLegacyDataRoot):搬了、或该搬没搬成,都在启动行与日志里留一笔。
    if (migration && (migration.moved || !['next-exists', 'no-legacy', 'env'].includes(migration.reason))) {
      console.log(`[start] data dir ${migration.moved ? `migrated ${migration.from} -> ${migration.to}${migration.junction ? ' (old path kept as a symbolic link)' : ''}` : `migration skipped (${migration.reason}); still using ${paths.data}`}`);
      try { logEvent({ kind: 'data_root_migration', ...migration }); } catch { /* 日志绝不阻断启动 */ }
    }
    await markInterruptedAgentRuns();
    await markInterruptedInterventions(); // 第71波:重启终态化 pending Intervention(与 markInterruptedAgentRuns 对称,不重挂)
    await resetOrphanedMissionDrivers().catch(() => 0); // hunt2-steward ⑤:重启后没有驱动器了,until-done 账本降成 supervised(见 resetOrphanedMissionDrivers 头注)
    void scheduleAgentWakesAtBoot(); // 后台代理信封已落账、唤醒没起成就重启了 → 补排(10;异步不 await,按 mtime 预筛账本,启动不等它;防抖到点时服务早已在监听)
    // Wave 80: start warming after crash/intervention reconciliation and overlap it with configuration sync
    // plus the default classic-shell hydration. It never delays listen; the empty-directory guard keeps later
    // external-import discovery authoritative.
    void warmPretenderProjectionIndex().catch(() => {});
    // 第29波(§29b): boot 自动恢复分级(opt-in,默认 false=零行为变化)。放在诚实标死【之后】、fire-and-forget:
    // 恢复失败/慢盘绝不阻塞 boot;真正的续跑在 runAgentWorkflow 内自走调度环。
    void waitForBootCliPathProbes().then(() => autoResumeInterruptedRuns()).catch(() => {});
    // PF2 fix: a hard crash (SIGKILL / power loss, where no exit handler ran to flush) can leave sessions/index.json
    // stale while its id-set still MATCHES the session files on disk — listSessions' fast path would then trust that
    // stale index FOREVER (renames / pins / messageCounts / summaries never re-surface until some OTHER session is
    // added or removed). Invalidate once at boot so the first listSessions rebuilds from the authoritative session
    // files. One full scan, boot-only (the pre-PF2 behavior); every read after that uses the incremental index.
    await invalidateSessionIndex();
    RUNTIME.launchMode = 'node';
    let config = await readConfig(); // let: autoImportClaudeCodeMcp 写回后需重绑到最新引用
    // v2 工作台记忆接管 ACC Memory：启动期一次性、幂等导入。失败只记审计且保留 ACC memory 工具，
    // 不阻断工作台；成功标记会让后续生成/桥接的 ACC 进程隐藏旧工具面。
    const accMemoryMigration = await migrateLegacyAccMemory().catch(e => ({ ok: false, error: (e && e.message) || String(e) }));
    if (!accMemoryMigration.ok) logEvent({ kind: 'acc_memory_import_failed', error: accMemoryMigration.error || 'unknown error' });
    // v1.4.3: sync settings, agent roles, and MCP servers to Claude CLI's own config on startup
    await syncClaudeCliSettings(config);
    await syncAgentRolesToClaude(config.defaultWorkspace || os.homedir(), config);
    {
      const imp = await autoImportClaudeCodeMcp(config).catch(() => null);
      if (imp && imp.config) config = imp.config;
      if (imp && imp.added) console.log(`Auto-imported ${imp.added} MCP server(s) from ${(imp.bySource || []).map(r => r.origin).join('/') || 'Claude Code'}: ${(imp.ids || []).join(', ')}`);
    }
    // W2 迁移中心:① 本包登记进安装登记表(老版本识别的账,所有包共用一个数据根,只能记在这里);
    // ② 本机其它 Agent CLI 的全局指令文件同步成工作台核心记忆(只读几个小文件 + 哈希比对,幂等)。
    // 都是旁路:失败只吞,不挡启动。
    await recordInstallLaunch(RUNTIME.launchMode);
    if (config.importAgentInstructions !== false) await syncAgentInstructionImports({ auto: true }).catch(() => null);
    // v1.9 数据管家: boot sweep(fire-and-forget —— 慢盘/清理失败绝不阻塞 boot;结果落审计账 storage_sweep)。
    void storageSweep(config.storagePolicy).catch(() => {});
    void sweepStaleScriptFiles().catch(() => {});   // 走查 W1·F10:script_run 遗留的脚本明文(强杀 / 杀毒占着没删成的)按龄清掉
    const requestedPort = Number(opts.port || process.env.PORT || DEFAULT_PORT);
    const host = bindHost;
    if (!isLoopbackBindHost(host)) console.log(`[warn] --allow-remote:正在监听非回环地址 ${host}。非本机对端拿不到页面 token(须自带头 token);请用防火墙限制来源,不要用同机反向代理转发(转发来的请求会被当成本机)。`);
    const server = createWorkbenchHttpServer({
      APP_NAME, VERSION, OVERLAY_ID, getLaunchMode: () => RUNTIME.launchMode,
      recordRequestMetric, hostAllowed, handleApi, serveStatic, logEvent,
    });
    // 118c: 实际监听端口可能不是请求的那个(原端口被别的程序占着时自动往后找)。下面的 runtime.json、
    // 控制台 URL 与 --open 全部用【实际】端口,前端顶部条另有 START_NOTICE.portFallback 说明改用了谁。
    const port = await listenWithFallback(server, requestedPort, host);
    finishBootCliPathProbes(); // No await before the runtime token handshake below.
    const url = `http://${host}:${port}/`;
    // Port+token handshake file for the permission-bridge MCP child; also useful for tooling.
    const runtimeToken = crypto.randomBytes(16).toString('hex');
    RUNTIME.port = port; RUNTIME.host = host; RUNTIME.token = runtimeToken;
    await atomicWriteJson(path.join(paths.data, 'runtime.json'),
      { port, host, pid: process.pid, token: runtimeToken, overlayId: OVERLAY_ID, version: VERSION, launchMode: RUNTIME.launchMode, startedAt: nowIso() },
      { mode: 0o600 }).catch(() => {});   // 安全走查 S11:里面是接口令牌,只给属主读写(POSIX;Windows 靠用户目录 ACL)
    console.log(`${APP_NAME} ${VERSION}  (launch: ${RUNTIME.launchMode}, overlay ${OVERLAY_ID})`);
    console.log(`UI: ${url}`);
    console.log(`Data: ${paths.data}`);
    console.log(`Server source: ${externalServerJs() || '(baked exe)'}`);
    // /health and the token handshake are live already. Boot consumers must now use
    // the real discovered CLI paths, including verified shim-to-exe upgrades.
    config = await readConfig();
    logEvent({ kind: 'server_start', port, launchMode: RUNTIME.launchMode, version: VERSION });
    if (typeof ExternalBotHooks.start === 'function') ExternalBotHooks.start();
    const BOOT_PROBE_WARMUP_MS = 500;
    setTimeout(() => setImmediate(() => {
      // 第123波 M1(37 号文 §3.2「启动恢复」):调度器起在这一段的【最前面】,不在 listen 之后的
      // 关键路径上。理由是实测出来的:第一版把 `await startScheduler(config)` 直接写在 server_start
      // 那一行之后,walkthrough-round2 的 B1(「全新 HOME 启动落管家视角」)从 0/6 红变成 3/10 红 ——
      // 那一件量的正是「首屏 bind 期 config 到没到」,startScheduler 里那一次 readConfig 与两次落空的
      // 文件读把最初那一两个请求往后挤了。本段的存在理由就是「把起跑那一刻让出去」(见上面的头注),
      // 调度器与 MCP 同步、能力矩阵预热是同一类活:都该等首屏拿到东西之后再做。
      // 排在本段最前而不是最后:它比下面三件都轻,而且恢复那一步可能要立刻补跑一个回合,
      // 不该排在 detectDesktopMcp 那 2 s 同步探针后面。schedulerEnabledV1 显式 false 时它立即返回,
      // 不建目录、不读盘、不起 interval、零写入;开着但零任务时同样不起 interval(29 号文 §4「开关」)。
      // fire-and-forget:调度器是旁路,失败绝不阻断已经开起来的服务。
      void startScheduler(config).catch(() => {});
      // v2.7.1 (boot fix): claude add-json 串行慢,await 拖死 boot(10 MCP x <=10s)。fire-and-forget:
      // 后台同步最多 15s 预算,超预算余量丢弃(add-json 幂等,下次 boot 补齐)。
      // 39 号文:下面四件的【同步前缀】都要走 resolveExternalMcpServers -> detectDesktopMcp -> pickPython。
      // 先用 ensureDesktopMcpWarm() 异步探一趟(execFile,不占事件循环),两张缓存热了再放它们跑,
      // 于是这一整段里一发 spawnSync 都不会有。预热失败也照跑(它自己 catch 成 null),最坏退回旧行为。
      // ruyi-toolbox:登记过的服务类组件在这里拉起并接成能力端点(04f)。void —— 绝不挡启动,失败只记日志与状态。
      if (typeof ToolboxHooks.reconcile === 'function') void ToolboxHooks.reconcile().catch(() => {});
      void ensureDesktopMcpWarm(config).then(() => {
        void syncMcpServersToClaude(config).catch(() => {});
        // G1: 预热能力矩阵。首个用户回合或子代理调用 getCapabilities 时命中 60s 缓存,冷启动不再吃满探测耗时。
        void getCapabilities(config).catch(() => {});
        void generateMcpConfig(config.mcpCommandMode).then(p => { console.log(`MCP config: ${p}`); }).catch(() => {});
      });
    }), BOOT_PROBE_WARMUP_MS).unref();
    // v0.7d: reap any bridged desktop/external MCP children on shutdown so they aren't orphaned.
    let cleanedUp = false;
    // 第116波116b: 关服收尾一并停掉管家收件箱轮询(clearInterval + 代际自增,在途 tick 尽快退出)。
    // 同样经 StewardHooks 调用,不直接引用 13g(禁止前向边);开关关时该钩子从未起过 timer,调用是无操作。
    // 第123波 M1:关服收尾一并停掉调度器 tick(clearInterval + 代际自增,在途 tick 尽快退出)——
    // 与上面那条管家收件箱同款。直调(前向边 13 → 13s 已登记);开关关时它从未起过 timer,调用是无操作。
    // 走查 2026-10-08:在途的 Agent CLI 回合子进程一并收掉(stopAllActiveTurnsSync,见其头注),修前它们在这条路上变孤儿。
    const cleanupMcp = () => { if (cleanedUp) return; cleanedUp = true; try { EventStreamHooks.close?.(); } catch { /* ignore */ } try { if (typeof ExternalBotHooks.stop === 'function') ExternalBotHooks.stop(); } catch { /* ignore */ } try { if (typeof StewardHooks.stopInbox === 'function') StewardHooks.stopInbox(); } catch { /* ignore */ } try { stopScheduler(); } catch { /* ignore */ } try { stopAllActiveTurnsSync('shutdown'); } catch { /* ignore */ } try { killAllMcpClients(); } catch { /* ignore */ } try { killAllShellSessions(); } catch { /* ignore */ } try { if (typeof ToolboxHooks.stopAllSync === 'function') ToolboxHooks.stopAllSync(); } catch { /* ignore */ } };
    // PF2 fix: flush the pending session-index batch synchronously on the way out. 'exit' runs for a normal exit,
    // for the SIGINT/SIGTERM handlers below (they call process.exit), and for the uncaughtException handler — so a
    // single registration here covers every graceful termination path.
    // 128f-⑥:用量账本还没轮到的那几行也在这里同步补写(Brief §4.2 第 5 条「账本即发即忘」)。
    process.on('exit', () => { try { flushSessionIndexSync(); } catch { /* ignore */ } try { flushUsageLedgerSync(); } catch { /* ignore */ } cleanupMcp(); });
    process.once('SIGINT', () => { cleanupMcp(); process.exit(0); });
    process.once('SIGTERM', () => { cleanupMcp(); process.exit(0); });
    // v1.4.6-S5: top-level crash safety net (serve mode only — registered here, not at module load, so a
    // require()'d unit test keeps Node's default handling). Before this, an uncaught exception left no journal
    // trace and an unhandled rejection could die silently. Policy: a stray REJECTION is logged and the process
    // CONTINUES (one orphaned promise must not kill a live turn); an uncaught EXCEPTION is logged, then we run
    // the existing MCP/shell cleanup and exit(1) — a process in an unknown state is not safe to keep serving.
    // No auto-restart loop (a supervisor / the user restarts) — avoids a crash-loop that hammers the machine.
    process.on('unhandledRejection', (reason) => {
      try { logEvent({ kind: 'unhandled_rejection', error: (reason && reason.stack) || (reason && reason.message) || String(reason) }); } catch { /* logging must never re-throw */ }
      try { console.error('unhandledRejection:', (reason && reason.stack) || reason); } catch { /* ignore */ }
    });
    process.on('uncaughtException', (err) => {
      try { logEvent({ kind: 'uncaught_exception', error: (err && err.stack) || (err && err.message) || String(err) }); } catch { /* logging must never re-throw */ }
      try { console.error('uncaughtException (exiting):', (err && err.stack) || err); } catch { /* ignore */ }
      try { cleanupMcp(); } catch { /* ignore */ }
      process.exit(1);
    });
    if (opts.open) {
      const opener = platformOpenSpawn(url, 'browser');
      spawnDetachedChecked(opener.command, opener.args, { detached: true, stdio: 'ignore' })
        .then(started => { if (!started.ok) { try { console.error(`--open: 无法自动打开浏览器(${started.error}),请手动访问 ${url}`); } catch { /* ignore */ } } });
    }
  }

  return { startServerInner, resolveBindHost, stopAllActiveTurnsSync };
}

module.exports = { createOwnedServerStartup, createServerStartup };
