'use strict';

const { activeOpenAiProvider } = require('./provider-config.cjs');

const CAP_UNKNOWN_TTL_MS = 5000;

function createCapabilityService({
  readConfig, nowIso, providerBaseIsLocalOrLan, providerBaseWithV1,
  probeDesktopMcp, probeRgAsync, existsExecutableAsync, probeGitCliAsync, runtimeCapabilitySnapshot,
  platform = process.platform,
}) {
  let _capCache = null;
  let _capInflight = null; // Share the current probe across callers with the same configuration.
  let _capRequestedKey = null;
  const CAP_CACHE_MS = 60000;
  const CAP_PROBE_TIMEOUT_MS = 3000;
  // 用户首启走查（2026-09-19）＋ Brief §4.2 第 6 条「启动探针偶发把机器判成离线并缓存 60 s（机制未证）」—— 机制已证：
  // 探测进行中事件循环若被一段同步活占住（启动期 detectDesktopMcp → pickPython 的 spawnSync，Full 包冷缓存要好几秒），
  // 循环回来时【计时器阶段先于 I/O 阶段】，中止计时器先到期，早已到达的响应还没读就被判超时 —— 在线的机器被判离线，
  // 并缓存 60 s：这 60 s 里能力矩阵写「离线」、要联网的工具被滤掉、提示词告诉模型「当前离线」。
  // 判别实验（本地秒回的对端 ＋ 探测中同步忙等 800 ms、超时 300 ms）：修前 5/5 判离线；对照（不阻塞 5/5 在线、
  // 对端不回话 5/5 离线）照常。修法：中止比约定晚到一个余量以上 ⇒ 这一发量不准 ⇒ 记 null（未知）而不是 false；
  // 未知只缓存 CAP_UNKNOWN_TTL_MS，下一次调用就重新探。unit/capability-probe-stall 钉这几条。
  const CAP_PROBE_STALL_SLACK_MS = 250;

  // HEAD a URL with a hard timeout. Returns true/false/null(unknown — no URL to probe).
  async function probeNetwork(url, timeoutMs) {
    const target = String(url || '').trim();
    if (!target || typeof fetch !== 'function') return null;
    const budget = timeoutMs || CAP_PROBE_TIMEOUT_MS;
    const startedAt = Date.now();
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch { /* ignore */ } }, budget) : null;
    try {
      // HEAD is cheapest; a reachable endpoint returns *some* HTTP status (even 401/404) → online. Only a
      // transport-level failure (DNS/refused/timeout) means offline. We therefore treat ANY response as online.
      await fetch(target, { method: 'HEAD', signal: ctrl ? ctrl.signal : undefined });
      return true;
    } catch {
      // 失败来得比约定晚一个余量以上 ⇒ 事件循环在这期间被占住过（见 CAP_PROBE_STALL_SLACK_MS 头注）⇒ 量不准，记未知。
      if (Date.now() - startedAt > budget + CAP_PROBE_STALL_SLACK_MS) return null;
      return false; // network/DNS/timeout → offline
    } finally { if (timer) clearTimeout(timer); }
  }

  // v1.1-W1a (T2):固定国内可达锚点 — probed alongside the provider/config target so a single flaky endpoint
  // can't fake a global offline reading. Exported (via networkAnchors) so an e2e can point everything local.
  const NETWORK_ANCHORS = ['https://www.baidu.com', 'https://cn.bing.com'];
  // The multi-target probe list for a given config. Two modes:
  //   (1) EXPLICIT override — capabilityProbeUrl is set → it is the SOLE authoritative target. Rationale: this
  //       field exists precisely for an air-gapped/intranet health endpoint (see defaultConfig); the operator
  //       who sets it wants THAT endpoint (not a public baidu/bing) to decide online status. So we honor it
  //       exactly, without diluting it with anchors or the provider.
  //   (2) DEFAULT (no probe URL) — union of [active provider baseUrl (如有)] + 固定国内可达锚点 (baidu/cn.bing),
  //       so a single flaky target can't fake a 60s global offline reading (the T2 goal).
  //       provider baseUrl 是本机 / 局域网地址(回环、RFC1918、链路本地、*.local、单标签主机名)时【不当锚点】:它能应答只说明
  //       本机/内网通,真断网时照样应答 —— 修前能力矩阵写「在线」、web_search / web_fetch 照常提供、提示词告诉模型「当前在线」。
  //       纯内网部署要声明在线状态,用 capabilityProbeUrl(上面 (1))。
  // Deduped, empties dropped. Exported so an e2e can drive it deterministically.
  // TEST HOOK: env WCW_TEST_NO_NET_ANCHORS=1 suppresses the fixed live anchors in the DEFAULT mode so an
  // offline-simulation e2e is not rescued by a real baidu/cn.bing on the test box. Zero production effect.
  // TEST HOOK: env WCW_TEST_LOCAL_PROVIDER_ANCHOR=1 让本机/局域网 provider 照旧当锚点 —— 离线跑的 e2e 靠本机假 provider 充当
  // 「网络在线」(假 provider 就在 127.0.0.1)。默认关,生产零影响;验证新判据的件把它清掉。
  function networkAnchors(config) {
    config = config || {};
    const cp = String(config.capabilityProbeUrl || '').trim();
    if (cp) return [cp]; // explicit override → sole target
    const list = [];
    const provider = activeOpenAiProvider(config);
    if (provider && provider.baseUrl && !(providerBaseIsLocalOrLan(provider.baseUrl) && process.env.WCW_TEST_LOCAL_PROVIDER_ANCHOR !== '1')) list.push(providerBaseWithV1(provider.baseUrl));
    if (process.env.WCW_TEST_NO_NET_ANCHORS !== '1') { for (const a of NETWORK_ANCHORS) list.push(a); }
    return [...new Set(list.filter(Boolean))];
  }
  // v1.1-W1a (T2): probe MANY targets concurrently; resolve true the instant ANY one answers (Promise.any
  // semantics, self-implemented so a late rejection never becomes an unhandled rejection). Returns:
  //   true  — at least one target answered;
  //   false — every target failed;
  //   null  — nothing probeable (empty list / no fetch).
  function probeAny(urls, timeoutMs) {
    const targets = (Array.isArray(urls) ? urls : []).map(u => String(u || '').trim()).filter(Boolean);
    if (!targets.length || typeof fetch !== 'function') return Promise.resolve(null);
    return new Promise(resolve => {
      let pending = targets.length, settled = false, unknown = false;
      // 任一 true 即 true;没有 true 时,只要有一发是「量不准」(null)就整体记未知,全是真失败才记离线。
      const finish = () => { if (--pending === 0 && !settled) { settled = true; resolve(unknown ? null : false); } };
      for (const t of targets) {
        // Each probe swallows its own rejection (probeNetwork already returns false, never throws) so no probe
        // can surface as an unhandled rejection even after we've resolved.
        Promise.resolve(probeNetwork(t, timeoutMs)).then(hit => {
          if (settled) return;
          if (hit === true) { settled = true; resolve(true); return; }
          if (hit === null) unknown = true;
          finish();
        }, () => { if (!settled) finish(); });
      }
    });
  }
  // v1.1-W1a (T2): mark the capability cache's network.online true after a real successful fetch/search — a
  // free freshness update. No-op when the cache is cold (nothing to correct; the next getCapabilities re-probes).
  function markNetworkOnline() {
    try {
      if (_capCache && _capCache.value && _capCache.value.network) {
        _capCache.value.network.online = true;
        _capCache.value.network.checkedAt = nowIso();
      }
    } catch { /* best-effort */ }
  }

  // The full capability matrix (§7.2). 60s cache. `force` (or a probe-URL change) busts it. Never throws.
  async function withRuntimeCapabilities(caps) {
    if (platform !== 'darwin') return caps;
    return { ...caps, runtime: await runtimeCapabilitySnapshot() };
  }

  async function getCapabilities(config, force) {
    config = config || await readConfig();
    const now = Date.now();
    const provider = activeOpenAiProvider(config);
    const targets = networkAnchors(config);
    const configKey = JSON.stringify([
      config.browserAutomation, config.desktopMcp, config.allowDesktopTools, config.allowCommandTools,
      targets, provider?.id, provider?.vision === true, provider?.reasoning === true,
    ]);
    _capRequestedKey = configKey;
    if (!force && _capCache?.configKey === configKey && (now - _capCache.at) < (_capCache.ttl || CAP_CACHE_MS)) return withRuntimeCapabilities(_capCache.value);
    // G1: in-flight 去重 —— 冷调用并发时(多子代理节点同时启动)共享同一个探测 Promise,避免各自全量探测。
    // 缓存有效期内直接命中;探测中则复用;探测完成后清空(下次冷调用重新探测,不跨周期复用 stale Promise)。
    if (!force && _capInflight?.configKey === configKey) return _capInflight.then(withRuntimeCapabilities);
    const inflight = (async () => {
      const engine = provider ? 'openai' : 'claude';
      // v1.1-W1a (T2): probe a MULTI-target list — [capabilityProbeUrl?]+[provider baseUrl?]+固定国内锚点
      // (baidu/cn.bing). ANY one answering → online:true. A single flaky endpoint can no longer fake a global
      // 60s offline reading. null = unknown only when there is literally nothing to probe.
      const online = targets.length ? await probeAny(targets, CAP_PROBE_TIMEOUT_MS) : null;

      const desktop = await probeDesktopMcp(config);
      // 145-W3:rg 与 git 同一条纪律 —— 异步探测(进程级缓存),修前 hasRg() 冷缓存时在回合入口 spawnSync。
      const rgInfo = await probeRgAsync().catch(() => null);

      const value = {
        network: { online, checkedAt: nowIso() },
        provider: provider ? { id: provider.id, vision: provider.vision === true, reasoning: provider.reasoning === true } : null,
        // 128f-⑬:两发 git 探测改异步 —— 能力矩阵 60 s 一过期就在回合入口重算,同步那两发会钉住事件循环。
        // rgSource(加法字段):env / bundled / system;rgShell:模型在终端里敲裸 rg 找得到的那一份(bundled/system/'')。
        binaries: { git: await existsExecutableAsync('git'), rg: !!rgInfo, rgSource: rgInfo ? rgInfo.source : null, rgShell: rgInfo ? rgInfo.shell : '' },
        // v1.0-S4: gitCli — a dedicated `git --version` probe (own 60s cache) that TOOL_REQUIRES reads to gate the
        // git tools. Kept separate from binaries.git (whose consumers/e2e shape must not change).
        gitCli: await probeGitCliAsync(),
        desktopMcp: desktop,
        engine,
      };
      // 有目标可探、却量出「未知」（探测撞上了同步阻塞）⇒ 只缓存几秒，下一次调用重新探；其余照旧 60 s。
      // Start the TTL when the complete result is published; slow probes must not consume it.
      // An older configuration may finish after the current probe or after a cache hit
      // for another target. Never publish it to peekCapabilities' unkeyed hot snapshot.
      if (_capInflight === inflight && _capRequestedKey === configKey)
        _capCache = { at: Date.now(), configKey, value, ttl: (online === null && targets.length) ? CAP_UNKNOWN_TTL_MS : CAP_CACHE_MS };
      return value;
    })().finally(() => { if (_capInflight === inflight) _capInflight = null; });
    inflight.configKey = configKey;
    _capInflight = inflight;
    return inflight.then(withRuntimeCapabilities);
  }
  // Test/维护 aid: drop the capability cache so the next getCapabilities re-probes immediately.
  function invalidateCapabilityCache() {
    _capCache = null;
    _capInflight = null;
    _capRequestedKey = null;
  }
  // 108b-fix2 非阻塞读取:只看能力缓存,绝不触发探测。冷缓存时返回 null(能力未知),
  // 由调用方 fail-open。供对延迟敏感的热路径(如 Claude CLI 启动前的提示词装配)使用:
  // getCapabilities 冷调用会做网络锚点探测(CAP_PROBE_TIMEOUT_MS=3000)+桌面 MCP 探测,
  // 把 CLI 进程的 spawn 推后数秒,会让回合注册晚于客户端的插话请求(steering-claude A 段)。
  function peekCapabilities() { return _capCache ? _capCache.value : null; }

  return { getCapabilities, peekCapabilities, invalidateCapabilityCache, markNetworkOnline, networkAnchors, probeAny };
}

module.exports = { CAP_UNKNOWN_TTL_MS, createCapabilityService };
