'use strict';

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

function configRecoveryCredentialChoice(raw, lastChoice, hasNonemptyVault) {
  if (raw?.credentialRefsV1) return true;
  if (typeof raw?.credentialEncryptionV1 === 'boolean') return raw.credentialEncryptionV1;
  if (typeof lastChoice === 'boolean') return lastChoice;
  return hasNonemptyVault ? true : null;
}

function createConfigStore({
  paths, ensureDirs, safeJsonParse, atomicWriteJson, normalizeConfig, prepareConfigWrite, privacyHooks,
  detectClaudePath, detectKimiPath, waitForConfigCliProbes, logEvent, onWritten,
}) {
  function invalidateConfigRecoveryState() {
    configReadCache = null;
    lastGoodConfig = null;
  }

  async function configSourceStillCurrent(source) {
    if (paths.config !== source.path) return false;
    let text = null;
    try { text = await fsp.readFile(source.path, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return paths.config === source.path && text === source.text;
  }

  // v1.4.1 (audit #4): config.json 原子写 —— 此前用裸 fsp.writeFile,崩溃/断电中途会留下截断文件,下次读
  // safeJsonParse→null → normalizeConfig 把【整份用户配置静默重置为默认】(密钥/服务商/工作区全丢)。
  // 第25波 25.1: 写体收编进 atomicWriteJson;对抗轮修: 全局写链串行化并发 config 写(同 saveSession 理由——
  // 重试窗口下旧载荷不得迟到覆写新载荷)。
  let configWriteChain = Promise.resolve();
  async function writeConfigAtomic(data, options = {}) {
    configReadCache = null;   // 进程内写:读缓存立刻作废(写完后再作废一次,见下)。文件戳本来也会变,这是显式的第二道保险
    const thisWrite = configWriteChain.catch(() => {}).then(async () => {
      // A read-triggered migration can wait behind a newer settings write. Check its source
      // inside the physical write queue before touching the config, backup, or credential vault.
      if (options.expectedSource && !await configSourceStillCurrent(options.expectedSource)) return false;
      // 81-P1: encrypt a serialized persistence copy; never pass runtime plaintext to the disk writer.
      if (privacyHooks.protectConfig) {
        let previous; try { previous = safeJsonParse(await fsp.readFile(paths.config, 'utf8'), null); } catch { /* The existing backup/read recovery path remains authoritative. */ }
        const alreadyPlaintext = previous && typeof previous === 'object' && !Array.isArray(previous) && !previous.credentialRefsV1 && previous.credentialEncryptionV1 !== true;
        data = await privacyHooks.protectConfig(data, { allowPlaintext: options.credentialEncryptionDisable === true || !!alreadyPlaintext });
      }
      // 2026-09-06 对抗审查 P2-1：覆盖前把即将被替换的那份原样留成 config.json.prev（只留最近一份）。
      // 这是 readConfig 在文件丢失/写坏时的第一恢复源；首次写入或旧文件不可读时跳过，失败不阻塞。
      // hunt2-P7:只在当前那份【读得出、是 JSON 对象】时才刷新 .prev。修前无条件拷:config.json 被写坏时
      // readConfig 从 .prev 恢复、随即经本函数落盘 —— 第一步就把坏文件拷到 .prev 上,唯一的好备份被坏文件盖掉。
      try {
        const current = safeJsonParse(await fsp.readFile(paths.config, 'utf8'), null);   // safeJsonParse 认带 BOM 的文件(与 readConfig 同口径)
        if (current && typeof current === 'object' && !Array.isArray(current)) {
          if (privacyHooks.protectBackup) {
            const backup = await privacyHooks.protectBackup(JSON.stringify(current), data);
            await atomicWriteJson(`${paths.config}.prev`, backup, { mode: 0o600 });
          } else await fsp.copyFile(paths.config, `${paths.config}.prev`);
          // 安全走查 S11:.prev 是 readConfig 的第一恢复源,里面是真 apiKey,不能脱敏;只收紧权限。copyFile 带的是【旧】config.json 的权限位
          // (升级前的文件可能是 0644)，所以复制后显式收紧权限。
          await fsp.chmod(`${paths.config}.prev`, 0o600).catch(() => {});
        }
      } catch (error) {
        if (String(error?.code || '').startsWith('credential_vault.')) throw error;
        if (error?.code !== 'ENOENT' && safeJsonParse(data, null)?.credentialRefsV1) throw Object.assign(new Error('credential_vault.backup_unavailable'), { code: 'credential_vault.backup_unavailable' });
      }
      if (privacyHooks.migrateBackups) await privacyHooks.migrateBackups(data);
      return atomicWriteJson(paths.config, data, { mode: 0o600 });   // 安全走查 S11:密钥落盘文件只给属主读写
    });
    configWriteChain = thisWrite;
    try { return await thisWrite; }
    finally { configReadCache = null; }   // 写在飞的这段时间里别的读者可能按旧戳填过缓存:落盘之后再清一次
  }
  async function readConfigPrev() {
    try {
      const parsed = safeJsonParse(await fsp.readFile(`${paths.config}.prev`, 'utf8'), null);
      return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
    } catch { return null; }
  }
  // 2026-09-06 对抗审查 P0-2：此前 readConfig 把「任何读失败」都当「全新安装」并立刻把默认配置写回磁盘——
  // 杀毒/备份软件短暂锁文件、瞬时 I/O 错误、外部写坏 JSON，任何一次背景 GET /api/status 都能把用户的密钥/
  // 服务商/工作区静默冲成默认值。现在：只有 ENOENT（文件确实不存在）且没有 .prev 可恢复时才算全新安装；
  // 其它读失败与 JSON 损坏一律不写盘，先用上一次读成功的内存副本，没有就进入【降级】：读到默认值只用于
  // 本次请求，writeConfig 在降级期间拒绝落盘（config.read_degraded），直到某次读成功为止。
  let configDegraded = false;
  let lastGoodConfig = null;
  // Do not let a caller holding the mutable last-good object forge a committed choice.
  let lastGoodCredentialEncryptionV1 = null;
  // 48b(P1) readConfig 内存缓存 -- 经对抗验证【回退】。根因:5 件 e2e(usage-ledger/skills-registry/
  // workbench-memory/vision-loop/subagent)直接 fs 写 config.json 切换 provider/配置,依赖 readConfig 每次
  // 读盘拾取(usage-ledger:137 注释明述"readConfig is uncached -> picked up");缓存让这些直接写不可见。
  // 生产环境 config 变更走 POST /api/config(writeConfig 可失效缓存)故缓存对生产正确,但测试直接写是合法
  // 提速捷径,且 mutate 别名隐患(structuredClone 仅治标),perf 收益(小 config + OS 已缓存磁盘读)不抵
  // 5 件回归 + 风险。05 方案 P1 留作后续:若重做须先把 e2e 改用 POST /api/config(镜像生产)或加 mtime 失效。
  // (后续:已按上面「加 mtime 失效」重做,见下方 configReadCache —— 文件戳失效 + 近期改动不入缓存 + 命中给深拷贝。)
  // hunt2-P10:readConfig 全仓 ~135 处调用,修前每一次都 ensureDirs()(14 个 mkdir)。目录只需在每个数据根上
  // 建一次:按 paths.data 记一笔,换根(测试 / 迁移)时重建。只省 readConfig 这一处 —— saveSession、writeConfig
  // 等写口仍然各自 ensureDirs(),运行中目录被删也能在下一次写时补回来。建目录失败不记,下次再试。
  let configDirsEnsuredFor = '';
  async function ensureDirsForConfigRead() {
    const root = String(paths.data || '');
    if (root && configDirsEnsuredFor === root) return;
    await ensureDirs();
    configDirsEnsuredFor = root;
  }
  // readConfig 读缓存(perf):~45 个调用点、85 KB 的配置每次 ~10 ms(parse + normalizeConfig 占大头,读盘本身很快),
  // 而配置几乎从不变。【上一版缓存被回退】的原因见上面 48b 那段:e2e 直接写 config.json 拿不到、别名被调用方改脏。
  // 这一版把两条根因都堵上,而不是绕开:
  //   · 失效靠【文件戳】而不是「只有 writeConfig 才失效」:key = 路径 + size + mtimeNs + ino(+ 家目录,归一化会用到)。
  //     e2e 或用户手改 config.json → 戳变 → 下一次读就重读重归一化;进程内写(writeConfigAtomic)前后再显式清一次。
  //   · 文件系统时间戳有粗粒度(Windows/FAT 十几 ms 到 2 s),同尺寸的原地改写可能撞戳 —— 所以【刚改过的文件不入缓存】
  //     (git 的 racy-timestamp 同款):读的这一刻 mtime 距今不足 CONFIG_CACHE_MIN_AGE_MS 就只读不存。配置在这段窗口里
  //     照旧每次重读(与修前逐字节同),窗口过后才开始命中;窗口之后再发生的改写,mtime 必然比戳老的那一刻新,不会撞。
  //   · 戳要在读盘【之前】取:取戳与读之间文件被换掉,存下的是「旧戳 + 新内容」,下次戳对不上 → 只会多读一次;反过来取会
  //     存成「新戳 + 旧内容」= 陈旧命中。
  //   · 归一化的输出里还有【运行时输入】不在文件里:detectClaudePath/detectKimiPath 的探测结果(60 s 过期后台重探)、
  //     (顺带保住「每次读配置都会碰一下探测记忆、过期则触发后台重探」这个旧副作用)。
  //   · 调用方会就地改返回值(mutateConfig 的 mutator 就是),所以缓存里只放一份没人拿过的快照,每次命中给一份深拷贝
  //   · 只缓存「干净读」:读盘成功、JSON 合法、不是从 .prev 恢复、归一化没有要回写的迁移(changed=false)。降级/恢复/迁移
  //     路径全部照旧走完整流程(它们有写盘或降级状态副作用)。
  const CONFIG_CACHE_MIN_AGE_MS = 2500;
  let configReadCache = null;   // { key, claudeProbe, kimiProbe, snapshot }
  async function configFileStamp() {
    try {
      const st = await fsp.stat(paths.config, { bigint: true });
      const vaultStamp = privacyHooks.stateStamp ? await privacyHooks.stateStamp() : '';
      // ctimeNs:任何内容写入都会推它、utimes 改不回去 —— 「同尺寸改写后把 mtime 还原」(cp -p、rsync -t、robocopy /COPY:DAT)也认得出(审查轮)
      return { key: `${paths.config}|${os.homedir()}|${st.size}|${st.mtimeNs}|${st.ctimeNs}|${st.ino}|${vaultStamp}`, mtimeMs: Number(st.mtimeMs) };
    } catch { return null; }
  }
  function configReadCacheLookup(stamp) {
    const cache = configReadCache;
    if (!cache || !stamp || cache.key !== stamp.key) return null;
    try {
      if (detectClaudePath() !== cache.claudeProbe || detectKimiPath() !== cache.kimiProbe) return null;
      return structuredClone(cache.snapshot);
    } catch { configReadCache = null; return null; }
  }
  function configReadCacheStore(stamp, config) {
    configReadCache = null;
    if (!stamp || (Date.now() - stamp.mtimeMs) < CONFIG_CACHE_MIN_AGE_MS) return;   // 刚改过(或时钟在未来):不信戳
    try {
      configReadCache = { key: stamp.key, claudeProbe: detectClaudePath(), kimiProbe: detectKimiPath(), snapshot: structuredClone(config) };
    } catch { configReadCache = null; }
  }
  async function readConfig() {
    try {
      // Boot may use provisional discovery defaults before listen; API/turn callers must
      // observe the completed first CLI checks, without blocking /health's event loop.
      const pendingCliProbes = waitForConfigCliProbes();
      if (pendingCliProbes) await pendingCliProbes;
      await ensureDirsForConfigRead();
      if (privacyHooks.recoverPending && await privacyHooks.recoverPending()) invalidateConfigRecoveryState();
      const stamp = await configFileStamp();   // 必须在读盘之前取(见 configReadCache 头注)
      const cached = configReadCacheLookup(stamp);
      if (cached) { configDegraded = false; privacyHooks.configurePrivacy?.(cached); return cached; }
      const sourcePath = paths.config;
      let text = null; let readError = null;
      try { text = await fsp.readFile(sourcePath, 'utf8'); } catch (e) { readError = e; }
      let raw = null; let recoveredFrom = '';
      const degrade = code => {
        privacyHooks.markPrivacyUnavailable?.();
        try { logEvent({ kind: 'config_read_failed', code, degraded: !lastGoodConfig }); } catch { /* 日志是旁路 */ }
        if (lastGoodConfig) return { ...lastGoodConfig, privacyPolicyRecoveryRequiredV1: true };
        configDegraded = true;
        // 只供本次请求使用，绝不落盘。权限档钉最保守的 'default':读不出用户配置时不该按出厂的智能自动放权。
        return { ...normalizeConfig(null).config, permissionMode: 'default', privacyPolicyRecoveryRequiredV1: true };
      };
      if (readError) {
        if (readError.code !== 'ENOENT') return degrade(String(readError.code || 'EREAD'));
        // 文件确实不存在：有上一版就恢复它，没有才是全新安装。
        const prev = await readConfigPrev();
        if (prev) { raw = prev; recoveredFrom = 'prev'; }
      } else {
        raw = safeJsonParse(text, null);
        if (raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) raw = null;
        // 3.0 收口走查(第四波):0 字节 / 全空白的 config.json 同样先从 .prev 恢复。修前只有「文件不存在」与「非空但不是合法 JSON」
        // 两支读 .prev,空文件被当成全新安装 —— 断电后 rename 已落盘而数据没落盘就是这个样子(全仓无 fsync);用户随后存一次设置写下
        // 无服务商的新配置,再存一次 writeConfigAtomic 就把它拷进 .prev,含密钥的唯一好备份被覆盖,服务商与 key 永久丢失。
        // 空文件里没有任何东西可留底,不另存 .corrupt;没有 .prev 时行为不变(下面 rawEmpty 那一支照旧判断是不是用过的安装)。
        if (raw === null && !String(text).replace(/^﻿/, '').trim()) {
          const prev = await readConfigPrev();
          if (prev) { raw = prev; recoveredFrom = 'prev'; }
        } else if (raw === null && String(text).trim()) {
          // 文件在但不是合法 JSON（截断/被外部写坏）：不覆盖它；能从 .prev 恢复就恢复，否则降级。
          // (UTF-8 BOM 已由 safeJsonParse 剥掉,记事本另存的合法 JSON 不会走到这里。)
          const prev = await readConfigPrev();
          if (prev) {
            raw = prev; recoveredFrom = 'prev';
            // 恢复会把 .prev 落盘覆盖掉这份坏文件(用户可能是手改写坏的):覆盖前把原文件另存成 config.json.corrupt 留底。
            if (privacyHooks.protectCorrupt) {
              const enabled = !!prev.credentialRefsV1 || prev.credentialEncryptionV1 === true;
              const backup = await privacyHooks.protectCorrupt(text, 'config.json.corrupt', enabled);
              await atomicWriteJson(`${paths.config}.corrupt`, backup, { mode: 0o600 });
            } else await fsp.copyFile(paths.config, `${paths.config}.corrupt`).catch(() => {});
            await fsp.chmod(`${paths.config}.corrupt`, 0o600).catch(() => {});   // S11:坏文件的留底里同样可能有真 key
          }
          else return degrade('EJSON');
        }
      }
      // 2026-10:没有可用配置(文件缺失 / 空文件 / {},且没有 .prev)不一定是全新安装 —— 数据目录里已经有会话,说明是一份
      // 用过的安装丢了配置。这时不给出厂的智能自动,钉回最保守的 'default'(显式键,落盘后不再走这里)。
      const rawEmpty = !raw || (typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length === 0);
      const recoveringSource = rawEmpty || recoveredFrom === 'prev';
      const vaultStat = recoveringSource ? await fsp.lstat(path.join(paths.data, 'credential-vault-v1.json')).catch(() => null) : null;
      const hasNonemptyVault = !!vaultStat && vaultStat.isFile() && !vaultStat.isSymbolicLink() && vaultStat.size > 0;
      const recoveryChoice = recoveringSource ? configRecoveryCredentialChoice(raw, lastGoodConfig ? lastGoodCredentialEncryptionV1 : null, hasNonemptyVault) : null;
      // Only an actual off choice from a committed recovery source/snapshot preserves plaintext.
      // Defaults do not grant this exception; unknown nonempty vaults remain encrypted and paused.
      const preserveKnownPlaintext = recoveringSource && recoveryChoice === false && !raw?.credentialRefsV1;
      if (rawEmpty && (lastGoodConfig || (await fsp.readdir(paths.sessions).catch(() => [])).length > 0 || vaultStat || await fsp.stat(path.join(paths.data, 'privacy-scopes')).then(() => true, () => false))) {
        raw = { permissionMode: 'default', privacyPolicyRecoveryRequiredV1: true,
          ...(recoveryChoice !== null ? { credentialEncryptionV1: recoveryChoice } : {}),
          configExplicitKeysV1: ['permissionMode', 'privacyPolicyRecoveryRequiredV1', ...(recoveryChoice !== null ? ['credentialEncryptionV1'] : [])] };
      } else if (recoveredFrom === 'prev' && recoveryChoice !== null) {
        raw = { ...raw, credentialEncryptionV1: recoveryChoice,
          ...(Array.isArray(raw.configExplicitKeysV1) ? { configExplicitKeysV1: [...new Set([...raw.configExplicitKeysV1, 'credentialEncryptionV1'])] } : {}) };
      }
      const credentialChoiceTrusted = typeof raw?.credentialEncryptionV1 === 'boolean' || !!raw?.credentialRefsV1;
      if (recoveredFrom) raw = { ...raw, privacyPolicyRecoveryRequiredV1: true };
      if (raw?.privacyPolicyRecoveryRequiredV1 === true) privacyHooks.markPrivacyUnavailable?.();
      let credentialsNeedMigration = false;
      let normalized;
      try {
        if (privacyHooks.hydrateConfig) {
          const hydrated = await privacyHooks.hydrateConfig(raw);
          raw = hydrated.raw; credentialsNeedMigration = hydrated.needsMigration;
        }
          normalized = normalizeConfig(raw);
      } catch (error) { privacyHooks.markPrivacyUnavailable?.(); throw error; }
      const { config, changed, persisted } = normalized;
      configDegraded = false;
      if (recoveredFrom) { try { logEvent({ kind: 'config_recovered', from: recoveredFrom }); } catch { /* 日志是旁路 */ } }
      // Only rewrite when a migration actually mutated the file (avoid racy write-on-every-read)；恢复自 .prev 时也落盘。
      // 128a:写的是投影(显式键 ＋ 簿记键 ＋ 不认识的键),不是整份内存视图。
      if (changed || recoveredFrom || credentialsNeedMigration) {
        const written = await writeConfigAtomic(JSON.stringify(persisted, null, 2), {
          credentialEncryptionDisable: preserveKnownPlaintext,
          expectedSource: { path: sourcePath, text },
        }).catch(error => {
          if (config.privacyPolicyRecoveryRequiredV1 === true || String(error?.code || '').startsWith('credential_vault.')) throw error;
        });
        if (written === false) return readConfig();
      } else if (!readError) configReadCacheStore(stamp, config);   // 干净读才缓存;存的是深拷贝,返回给调用方的 config 仍归调用方
      privacyHooks.configurePrivacy?.(config);
      lastGoodConfig = config; // Do not advertise a successful encrypted state after a failed credential migration.
      lastGoodCredentialEncryptionV1 = credentialChoiceTrusted ? config.credentialEncryptionV1 : null;
      return config;
    } catch (error) { privacyHooks.markPrivacyUnavailable?.(); throw error; }
  }

  // 配置落盘之后在进程内总线(00-boot 的 RUYI_EVENTS)上派一声 'config.written'。载荷只带订阅者要的开关位,
  // 【不带整份配置】(里面有服务商密钥;总线纪律③:它只是一条线,不承载正文;13r 只转发它认得的名字,这一声不出进程)。
  // 订阅者:13s 的调度器 —— 启动那一刻 schedulerEnabledV1 关着就没起(红线⑤:关着零开销、零写入),修前用户之后在设置里
  // 打开要重启才生效;现在听到这一声当场补起。零订阅者时 emit 是 no-op。
  function configEmitWritten(config) {
    if (privacyHooks.deferConfigWritten?.(config)) return;
    if (typeof config?.credentialEncryptionV1 === 'boolean') lastGoodCredentialEncryptionV1 = config.credentialEncryptionV1;
    privacyHooks.configurePrivacy?.(config);
    onWritten({ schedulerEnabledV1: !!(config && config.schedulerEnabledV1 === true) });
  }

  // 128a:before ＝ 这次写入之前的内存视图(mutateConfig 在 mutator 动手前拍的快照)。next 里归一化后值与它
  // 不同的键记成显式 —— 「被改过」的唯一口径,设置页、API、管家改设置、产品代用户记的状态一视同仁。
  // 没有 before 的调用(只剩单测)退回读盘语义:next 里不等于默认的键都算显式。
  async function writeConfig(next, before = null, options = {}) {
    await ensureDirs();
    if (configDegraded) {
      // 读失败/JSON 损坏期间拿到的「当前配置」是默认值：在它上面合并再落盘 = 把用户配置冲成默认。拒绝。
      const err = new Error('config.read_degraded: config.json 当前读不出来，拒绝在默认值之上落盘');
      err.code = 'config.read_degraded';
      throw err;
    }
    const { config, persisted } = prepareConfigWrite(next, before);
    await writeConfigAtomic(JSON.stringify(persisted, null, 2), options);
    configEmitWritten(config);
    return config;
  }

  // ── 117n-M2:配置「读-改-写」的唯一临界区 ────────────────────────────────────────────────────
  // writeConfigAtomic 的 configWriteChain(上面)只串行化【物理写】,不保护「读-改」:两个并发请求
  // 各自 readConfig() 读到同一份旧值、各自 merge 后 writeConfig,后写者会静默吞掉先写者的字段
  // (真机形态:一边保存设置一边启停连接器,其中一次的改动凭空消失)。此前有 9 处这样的裸
  // read-modify-write 绕过了 applyConfigPatch;mutateConfig 把「读 -> mutator -> writeConfig」整段
  // 占住一条队列,丢失更新在这里根除。
  // 为什么另开 configMutateChain 而不复用 configWriteChain:readConfig 自己在迁移/从 .prev 恢复时会
  // 调 writeConfigAtomic,复用同一条队列会自锁。两条队列职责不同,物理写仍由 configWriteChain 串行。
  //
  // mutator(current) 在锁内执行,current 是刚从盘上读到并归一化的配置(可就地改)。返回值形状:
  //   undefined / {}   -> 落盘 current
  //   { next }         -> 落盘 next(调用方自己拼了新对象,而不是就地改)
  //   { value }        -> 随行数据,原样回给调用方
  //   { abort: X }     -> 不落盘(校验没过/没什么可写),结果 { ok:false, config: current, value: X }
  // 结果统一为 { ok, config, value }:ok=true 时 config 是 writeConfig 之后已归一化的 next。
  // mutator 抛出的异常照常向调用方冒泡(与此前直接 await writeConfig 抛出等价),且不毒化队列。
  let configMutateChain = Promise.resolve();
  function mutateConfig(mutator, options = {}) {
    const run = configMutateChain.catch(() => {}).then(async () => {
      const current = await readConfig();
      // 128a:mutator 可以就地改 current,所以「改之前」必须先深拷一份(Symbol 键 structuredClone 不带,手补)。
      const before = structuredClone(current);
      const decision = await mutator(current);
      const d = (decision && typeof decision === 'object') ? decision : {};
      if (Object.prototype.hasOwnProperty.call(d, 'abort')) return { ok: false, config: current, value: d.abort };
      const next = await writeConfig(Object.prototype.hasOwnProperty.call(d, 'next') ? d.next : current, before, options);
      return { ok: true, config: next, value: d.value };
    });
    configMutateChain = run.then(() => {}, () => {});
    return run;
  }

  return { readConfig, writeConfig, writeConfigAtomic, mutateConfig, configEmitWritten, invalidateConfigRecoveryState };
}

module.exports = { createConfigStore, configRecoveryCredentialChoice };
