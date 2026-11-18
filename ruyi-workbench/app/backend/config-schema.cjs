'use strict';

const os = require('node:os');
const path = require('node:path');
const { AGENT_CLI_DEFAULT_TYPE, isAgentCliType, normalizeAgentCliType } = require('./agent-cli-types.cjs');
const { PERMISSION_MODE_ALIASES, PERMISSION_MODES, normalizeAgentRole } = require('./agent-role-policy.cjs');
const { configSecretValueOrCleared, configUrlOrCleared, sanitizeExternalMcpServer } = require('./config-secrets.cjs');
const { nativeToolTier } = require('./native-tool-tiers.cjs');
const { normalizePricing } = require('./provider-pricing.cjs');
const { normalizeStoragePolicy } = require('./storage-policy.cjs');
const { createConfigDefaults, THREAD_INDEX_RECENT_DEFAULT, THREAD_INDEX_RECENT_MIN, THREAD_INDEX_RECENT_MAX } =
  require('./config-defaults.cjs');
const { WORKSPACE_NOTE_MAX, WORKSPACE_TABLE_CAP } = require('./config-workspaces.cjs');

// 浏览器目标的合法模式(normalizeConfig 清洗与 mcp_configure set-browser 的入口校验共用一份,别再各抄一个数组)。
const BROWSER_AUTOMATION_MODES = ['system', 'managed', 'custom', 'cdp', 'bundled'];
const CLAUDE_THINKING_EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];

// 123-N2:config.lastUsedEngineRoute 的【形状】清洗。见 normalizeConfig 里调用点上方那段头注 ——
// 语义判据(providerId 还在不在、CLI 还检得到吗)不在这里,那是 02 读侧的事。
// 参数名 rawRoute 而不是 raw/route:纪律 12(依赖图把裸参数名当跨模块符号,撞上更早模块的顶层
// 符号会凭空生出一条前向边并把本模块拽进 SCC)。
function sanitizeLastUsedEngineRoute(rawRoute) {
  if (!rawRoute || typeof rawRoute !== 'object' || Array.isArray(rawRoute)) return null;
  const model = String(rawRoute.model || '').trim().slice(0, 256);
  if (rawRoute.engine === 'openai') {
    const providerId = String(rawRoute.providerId || '').trim().slice(0, 128);
    return providerId ? { engine: 'openai', providerId, model } : null;
  }
  if (rawRoute.engine === 'agent' || rawRoute.engine === 'claude') {
    return { engine: 'agent', agentCliType: normalizeAgentCliType(rawRoute.agentCliType), model };
  }
  return null;
}

function createConfigSchema({ CONFIG_SCHEMA, VERSION, SKILL_ID_RE, samePathKey, sanitizeProvider, PrivacyCore,
  detectClaudePath, detectKimiPath, workspaces }) {
  const { normalizeWorkspacePathString, normalizeStewardManagedWorkspaces } = workspaces;
  const defaultConfig = createConfigDefaults({ CONFIG_SCHEMA, VERSION, detectClaudePath, detectKimiPath });

  // ── 128a(48 号文 §2):配置只落「改过的键」 ─────────────────────────────────────────────────────
  // 修前 normalizeConfig 是 { ...defaultConfig(), ...raw },而任一次写盘都把【整份合并配置】落下去 ⇒ 装过一次的
  // 机器上每个键都写着当年的默认值,此后产品改任何默认值,存量安装一个也吃不到(107-T1 只能靠一次性迁移补三个键;
  // P1 又测出降级再升级会把用户关掉的开关重新打开)。现在:
  //   · 显式键集合 configExplicitKeysV1 ＝ 被改过的键(经 mutateConfig 的写入里值变了的;读盘时盘上出现且不等于
  //     当前默认的 —— 手改 config.json 与旧版本写下的整份配置都走这条);
  //   · 落盘投影 ＝ 簿记键 ＋ 显式键 ＋ 本版不认识的键(更新的版本写下的键,降级时不能被我们抹掉);
  //   · 迁移按显式键判:用户明确设过的键,schema 号被旧版写回去之后也不会再被迁移改掉。
  // 内存视图照旧是整份(defaults ＋ 盘上),消费方零改动。
  const CONFIG_BOOKKEEPING_KEYS = Object.freeze(['configSchema', 'version', 'configExplicitKeysV1']);
  const CONFIG_EXPLICIT_KEY_MAX = 400;
  function configCanonicalJson(value) {
    if (value === undefined) return 'undefined';
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(configCanonicalJson).join(',') + ']';
    return '{' + Object.keys(value).filter(k => value[k] !== undefined).sort()
      .map(k => JSON.stringify(k) + ':' + configCanonicalJson(value[k])).join(',') + '}';
  }
  function configValueEquals(a, b) { return configCanonicalJson(a) === configCanonicalJson(b); }
  function configExplicitKeysOf(raw) {
    const list = raw && typeof raw === 'object' && Array.isArray(raw.configExplicitKeysV1) ? raw.configExplicitKeysV1 : [];
    return new Set(list.filter(k => typeof k === 'string' && k && k.length <= 120 && !CONFIG_BOOKKEEPING_KEYS.includes(k)));
  }
  function configComparableValue(config, key) {
    return config[key];
  }
  // 落盘投影:唯一的写口(readConfig 的迁移回写、writeConfig)都写它。
  function persistableConfig(config, base) {
    const explicit = new Set(Array.isArray(config.configExplicitKeysV1) ? config.configExplicitKeysV1 : []);
    const out = {};
    for (const key of Object.keys(config)) {
      if (CONFIG_BOOKKEEPING_KEYS.includes(key)) out[key] = config[key];
      else if (explicit.has(key) || !Object.prototype.hasOwnProperty.call(base, key)) out[key] = configComparableValue(config, key);
    }
    out.configSchema = CONFIG_SCHEMA;
    out.version = VERSION;
    return out;
  }
  function finalizeConfigExplicitKeys(config, explicit) {
    config.configExplicitKeysV1 = [...explicit]
      .filter(k => Object.prototype.hasOwnProperty.call(config, k) && !CONFIG_BOOKKEEPING_KEYS.includes(k))
      .sort()
      .slice(0, CONFIG_EXPLICIT_KEY_MAX);
  }

  // ── 一次性 schema 迁移表(架构还债批 2 B1) ─────────────────────────────────────────────────────────
  // normalizeConfig 里按读进来的 configSchema 判的一次性迁移,原先与字段级校验交错在同一个函数体里;现在按 to
  // 升序登记在这张表里,由 normalizeConfig 在【唯一一个固定点】调 applyConfigMigrations(对 fromSchema < to 的逐条
  // 按表序执行)。那个点的位置由迁移的输入决定,移动它之前逐条核对下面每条的「读」:
  //   · 在它之前:迁移读到的键都已做完字段级校验 —— engineMode 的 print→legacy 别名与枚举兜底、严格布尔循环
  //     (字符串 "false" 这类脏值先被压成 false 再迁)、defaultWorkspace(恒非空)与 recentWorkspaces 的清洗;
  //   · 在它之后:工作区表那一段(to:10 把种子行放进 config.workspaces,由那一段统一清洗、去重、截断、拆出
  //     如意自管文件夹),以及落盘前的显式键推断(旧格式读看全部键 —— 迁移造出的值必须在那一次落盘)。
  // 每条都守 128a 的规矩:ctx.rawExplicit 里的键是用户明确设过的,不迁 —— schema 号可能被旧版写回去过,显式键集合
  // 活得过降级。apply 只改 config,返回「动了没有」;normalizeConfig 末尾按「落盘投影 ≠ raw」重算 changed。
  // 不在表里的「迁移」:subagentBudgetMigrated / searchBackendMigrated 两条按各自的标记键判(不看 schema 号),
  // Kimi 旧模型别名与 permissionMode 别名是每读必过的幂等改写 —— 它们留在 normalizeConfig 原处。
  // unit/config-migrations.test.js 钉:to 严格升序且各出现一次、不超过 CONFIG_SCHEMA、函数体里不再有 `< N` 阶梯。
  const CONFIG_MIGRATIONS = Object.freeze([
    Object.freeze({
      to: 9,
      // Schema 9 makes interactive the effective default for upgraded installs too. Older configs could
      // indefinitely retain legacy/print even though new installs already defaulted to interactive, leaving the
      // composer advertising a steer action that the live CLI process could not accept. Migrate once; after the
      // schema stamp, a user may still explicitly switch back to legacy from Settings and that choice is retained.
      // 读:engineMode(已过校验:'print' 已折成 'legacy',野值已兜成 'interactive' —— 所以原先「raw 为 legacy/print」
      // 在这里恰好等价于「此刻为 legacy」;名单仍写两个,与迁移的原意同形)。
      apply(config, ctx) {
        if (ctx.rawExplicit.has('engineMode') || !['legacy', 'print'].includes(config.engineMode)) return false;
        config.engineMode = 'interactive';
        return true;
      },
    }),
    Object.freeze({
      to: 10,
      // v2.7 工作区权限:清洗后一条可用工作区都没有的老配置,从 defaultWorkspace + recentWorkspaces 播种,
      // 让存量安装对它已经信任的每个文件夹保持读/写/执行。读:workspaces(原始行)、defaultWorkspace、
      // recentWorkspaces(后两者已清洗)。「可用」与工作区表那一段 pushWs 的收录条件同一口径(非数组对象且
      // path 规整后非空);一条都没有时原始行本来就一条也进不了表,整张换成种子行,由那一段按原样去重、截断。
      apply(config) {
        const rows = Array.isArray(config.workspaces) ? config.workspaces : [];
        if (rows.some(r => r && typeof r === 'object' && !Array.isArray(r) && normalizeWorkspacePathString(r.path))) return false;
        const seed = [];
        if (typeof config.defaultWorkspace === 'string' && config.defaultWorkspace.trim()) seed.push(config.defaultWorkspace);
        for (const w of (Array.isArray(config.recentWorkspaces) ? config.recentWorkspaces : [])) if (typeof w === 'string') seed.push(w);
        config.workspaces = seed.map(s => ({ path: s }));
        return true;
      },
    }),
    Object.freeze({
      to: 12,
      // 107-T1(46 号文 §5): 126-111b/111d/111e 三个开关在 2.8.0 翻成默认开 —— 但【光翻 defaultConfig 没用】。
      // normalizeConfig 是 { ...defaultConfig(), ...raw },raw 永远赢;而旧版 readConfig 只要 changed 为真就把【整份
      // 合并后的配置】落盘,于是当年那批默认值被原样冻在盘上 —— 所有写过一次 config.json 的安装(= 全部
      // 存量用户)盘上都实打实写着 false,新默认一个也吃不到。故走 schema 阶梯做一次性迁移。
      // 【必须写 = true,不能 delete】:delete 之后 normalizeConfig 这一趟返回的 config 里这三个键是 undefined,
      // 而判定函数一律是 `=== true` —— 当前这条命的进程里三个开关全是关的(要等下一次读配置才生效)。
      // 判据在 unit/config-schema-12-migration.test.js 的 [A],它断的是 === true,delete 当场红。
      // 读:三个开关(已过严格布尔循环:非布尔脏值比如字符串 "false" 先被压成 false,再统一迁移)。
      // 只迁一次 —— 落盘时 configSchema 被盖成当前值,用户在 2.8.0 之后自己关掉的那些,升级不会再动。
      // 128a(Brief §4.2 第 24 条,P1 实测):降级到 2.7.0 会把 configSchema 写回 11,回来时这道迁移又跑一遍,
      // 把用户在新版里显式关掉的开关重新打开。2.7.0 保留不认识的顶层键 ⇒ configExplicitKeysV1 活过降级,schema 号
      // 活不过 —— 所以按显式键判:在集合里的键是用户明确设过的,不迁。
      apply(config, ctx) {
        let moved = false;
        for (const key of ['runtimeHistoryReadDedupV1', 'runtimeSummaryPromptI18nV1', 'runtimeReseedTailUnitsV1']) {
          if (config[key] === false && !ctx.rawExplicit.has(key)) { config[key] = true; moved = true; }
        }
        return moved;
      },
    }),
    Object.freeze({
      to: 13,
      // 体验走查 #4:killOnDisconnect 缺省翻成 false(刷新／关窗不再结束回合)。schema 13 的稀疏文件里没碰过它的
      // 用户本来就不存这个键,自动吃到新默认;只有 <13 的整份老文件盘上写着当年的默认 true,落盘前的显式键推断会把它
      // 当成「用户改过」冻住。老文件里的 true 就是当年的默认,不是选择 —— 这里按默认处理。显式键照旧不动。
      // 读:killOnDisconnect(没有字段级校验,只认 === true)。
      apply(config, ctx) {
        if (config.killOnDisconnect !== true || ctx.rawExplicit.has('killOnDisconnect')) return false;
        config.killOnDisconnect = false;
        return true;
      },
    }),
    Object.freeze({
      to: 14,
      // 2026-10 拍板:出厂权限档 'default' → 'auto'(智能自动)。新默认只给全新安装:稀疏文件(13)里没碰过档的用户
      // 本来不存这个键,光翻 defaultConfig 会让他们升级后被悄悄放成智能自动 —— 而「切到」智能自动按 01e 是要二次
      // 确认的。所以盘上已有配置、却没有 permissionMode 的,钉回当年的默认 'default';下面的显式键推断(迁移读看全部键)
      // 会因它不等于新默认把它记成显式、落盘,之后不再跑。盘上本来就写着档的(<13 整份老文件、手改)原样保留,
      // 不学 to:13 把旧默认当「没选」—— 权限只收紧不放开。全新安装(无文件 / 空文件)不动,吃到 'auto'。
      // 读:ctx.rawKeys(盘上原始键)、ctx.rawExplicit。
      apply(config, ctx) {
        if (!ctx.rawKeys.size || ctx.rawKeys.has('permissionMode') || ctx.rawExplicit.has('permissionMode')) return false;
        config.permissionMode = 'default';
        return true;
      },
    }),
  ]);
  // ctx = { fromSchema: 读进来的 configSchema(缺/坏为 0), rawExplicit: raw 里的显式键集合, rawKeys: raw 的顶层键集合
  // (无文件 / 空文件为空集) }。返回是否有迁移动过 config。
  function applyConfigMigrations(config, ctx) {
    let moved = false;
    for (const migration of CONFIG_MIGRATIONS) {
      if (ctx.fromSchema < migration.to && migration.apply(config, ctx)) moved = true;
    }
    return moved;
  }

  // Fold older config files onto the current schema. Returns { config, changed, persisted }.
  //   config    —— 整份内存视图(defaults ＋ 盘上),全部消费方读它;
  //   persisted —— 该落盘的投影(128a);changed ＝ 投影与传进来的 raw 不同(＝该写盘)。
  //   opts.inferExplicit(缺省 true):把 raw 里「不等于当前默认」的已知键记成显式 —— 读盘的语义。
  //     writeConfig 传 false:它手上是整份内存视图,显式与否由它按「这次写入里值变了没有」自己判。
  function normalizeConfig(raw, opts = {}) {
    const base = defaultConfig();
    const config = { ...base, ...(raw && typeof raw === 'object' ? raw : {}) };
    const incomingConfigSchema = Number(raw && raw.configSchema) || 0;
    const rawExplicit = configExplicitKeysOf(raw);
    let changed = !raw || raw.configSchema !== CONFIG_SCHEMA;
    if (!['off', 'basic', 'enhanced', 'strict'].includes(config.privacyModeV1)) { config.privacyModeV1 = 'off'; config.privacyPolicyRecoveryRequiredV1 = true; changed = true; }
    if (typeof config.privacyTechnicalV1 !== 'boolean') { config.privacyTechnicalV1 = false; config.privacyPolicyRecoveryRequiredV1 = true; changed = true; }
    if (!Array.isArray(config.privacyRulesV1)) { config.privacyRulesV1 = []; config.privacyPolicyRecoveryRequiredV1 = true; changed = true; }
    if (typeof config.privacyPolicyRecoveryRequiredV1 !== 'boolean') { config.privacyPolicyRecoveryRequiredV1 = true; changed = true; }
    if (typeof PrivacyCore !== 'undefined') PrivacyCore.createDetector({ rules: config.privacyRulesV1 });
    if (typeof config.credentialEncryptionV1 !== 'boolean') { config.credentialEncryptionV1 = base.credentialEncryptionV1; changed = true; }
    // Earlier defaults could omit the encryption flag while privacy was selected. Do not
    // initialize a vault without consent under the new opt-in default. Hydrated references
    // have already retained their explicit enabled state before normalization reaches here.
    if (config.privacyModeV1 !== 'off' && config.credentialEncryptionV1 !== true && config.privacyPolicyRecoveryRequiredV1 !== true) {
      config.privacyPolicyRecoveryRequiredV1 = true; changed = true;
    }
    if (!isAgentCliType(config.agentCliType)) {
      config.agentCliType = AGENT_CLI_DEFAULT_TYPE;
      changed = true;
    }
    // 123-N2:新线程缺省引擎的两个字段。
    if (!['last', 'global'].includes(config.newThreadEngine)) {
      config.newThreadEngine = 'last';
      changed = true;
    }
    {
      // 01 够不着 02 的 normalizeSessionEngineRoute(那是后面的模块,本仓是拼接单作用域但依赖图按
      // 声明序判前向边),所以这里只做【形状】清洗:非对象/野 engine/超长字符串一律回落 null。
      // 【语义】清洗仍在 02 的读侧(createSession 用 normalizeSessionEngineRoute 再过一遍),
      // 两边不一致时以 02 为准 —— 它才是回合路由的判据。写侧(02 rememberLastUsedEngineRoute)
      // 落盘前也已经过了同一个归一器,所以这一段在正常路径上是恒等的,它防的是手改配置文件。
      const clean = sanitizeLastUsedEngineRoute(config.lastUsedEngineRoute);
      if (JSON.stringify(clean) !== JSON.stringify(config.lastUsedEngineRoute ?? null)) {
        config.lastUsedEngineRoute = clean;
        changed = true;
      }
    }
    for (const key of ['kimiPath']) {
      if (typeof config[key] !== 'string') { config[key] = ''; changed = true; }
      else config[key] = config[key].trim().slice(0, 2000);
    }
    {
      const cleanDefaultWorkspace = normalizeWorkspacePathString(config.defaultWorkspace) || os.homedir();
      if (cleanDefaultWorkspace !== config.defaultWorkspace) { config.defaultWorkspace = cleanDefaultWorkspace; changed = true; }
    }
    // v2.6.0 initially exposed backend model ids copied from the old Claude endpoint history. Kimi Code's
    // native --model flag requires the configured alias key, which adds the managed-provider namespace.
    // Migrate only the four known official legacy values; arbitrary/custom aliases remain untouched.
    if (config.agentCliType === 'kimi' && ['kimi-for-coding', 'kimi-for-coding-highspeed', 'k3', 'k3-256k'].includes(config.model)) {
      config.model = `kimi-code/${config.model}`;
      changed = true;
    }
    // v1.4.3: accept CLI-native mode name 'bypassPermissions' as alias for 'bypass'
    if (PERMISSION_MODE_ALIASES[config.permissionMode]) {
      config.permissionMode = PERMISSION_MODE_ALIASES[config.permissionMode];
      changed = true;
    }
    if (!PERMISSION_MODES.includes(config.permissionMode)) {
      config.permissionMode = 'default';
      changed = true;
    }
    if (!['auto', 'zh-CN', 'en-US'].includes(config.locale)) {
      config.locale = 'auto';
      changed = true;
    }
    // engineMode 字段级校验。schema<9 的「legacy/print → interactive」一次性迁移在 CONFIG_MIGRATIONS(to:9)。
    if (config.engineMode === 'print') {
      config.engineMode = 'legacy'; // tolerate the historical internal alias
      changed = true;
    } else if (!['legacy', 'interactive'].includes(config.engineMode)) {
      config.engineMode = 'interactive';
      changed = true;
    }
    // Only string args reach cp.spawn — filter out anything else (prevents a spawn TypeError/DoS and
    // stops a config-injection from smuggling non-string payloads).
    if (!Array.isArray(config.extraClaudeArgs) || config.extraClaudeArgs.some(a => typeof a !== 'string')) {
      config.extraClaudeArgs = Array.isArray(config.extraClaudeArgs) ? config.extraClaudeArgs.filter(a => typeof a === 'string') : [];
      changed = true;
    }
    // Claude CLI owns the concrete effort semantics. Keep the workbench value to the CLI's documented
    // enum so a malformed config can never turn into an invalid spawn argument.
    if (!CLAUDE_THINKING_EFFORTS.includes(config.claudeThinkingEffort)) {
      config.claudeThinkingEffort = '';
      changed = true;
    }
    // Clamp numeric timeouts to sane ranges (a non-numeric value must never disable the watchdog).
    const pt = Number(config.permissionTimeoutMs);
    config.permissionTimeoutMs = Number.isFinite(pt) && pt > 0 ? Math.min(600000, Math.max(5000, pt)) : 0;   // 0 = 不限时
    const qt = Number(config.questionTimeoutMs);
    config.questionTimeoutMs = Number.isFinite(qt) && qt > 0 ? Math.min(3600000, Math.max(60000, qt)) : 0;   // 0 = 不限时
    const it = Number(config.turnIdleTimeoutMs);
    config.turnIdleTimeoutMs = Number.isFinite(it) ? Math.min(3600000, Math.max(60000, it)) : 600000;
    const aw = Number(config.agentNodeWrapUpMs);
    config.agentNodeWrapUpMs = Number.isFinite(aw) ? (aw <= 0 ? 0 : Math.min(7200000, Math.max(60000, aw))) : 1800000;
    // 第27f波:autonomyPauseOnTimeout 布尔(默认 false=安全默认);autonomyPauseTtlMs clamp [5min, 6h] 默认 45min。
    config.autonomyPauseOnTimeout = config.autonomyPauseOnTimeout === true;
    const apt = Number(config.autonomyPauseTtlMs);
    config.autonomyPauseTtlMs = Number.isFinite(apt) ? Math.min(6 * 3600000, Math.max(300000, apt)) : 2700000;
    // 第29波:monitorIncremental 默认 true(!==false 归一,纯传输优化);autonomyAutoResume 默认 false(===true
    // 归一,安全默认——boot 自动续跑消耗 token 且无人在场,必须显式开启)。
    config.monitorIncremental = config.monitorIncremental !== false;
    config.autonomyAutoResume = config.autonomyAutoResume === true;
    config.agentAutoModelTiering = config.agentAutoModelTiering === true; // 第30波:后端按 tier 兜底挑模型(opt-in,默认关)
    // v1.9 数据管家: 保留策略归一(逐项 clamp,见 normalizeStoragePolicy)。
    {
      const sp = normalizeStoragePolicy(config.storagePolicy);
      if (JSON.stringify(sp) !== JSON.stringify(config.storagePolicy)) { config.storagePolicy = sp; changed = true; }
      else config.storagePolicy = sp;
    }
    // Model lists must be arrays of strings; knownModels is capped so it can't grow unbounded.
    for (const k of ['knownModels', 'extraModels']) {
      if (!Array.isArray(config[k]) || config[k].some(a => typeof a !== 'string')) {
        config[k] = Array.isArray(config[k]) ? config[k].filter(a => typeof a === 'string') : [];
        changed = true;
      }
    }
    if (config.knownModels.length > 50) { config.knownModels = config.knownModels.slice(-50); changed = true; }
    if (typeof config.modelsApiBase !== 'string') { config.modelsApiBase = ''; changed = true; }
    else if (config.modelsApiBase.length > 500) { config.modelsApiBase = config.modelsApiBase.slice(0, 500); changed = true; }
    if (typeof config.modelsApiKey !== 'string') { config.modelsApiKey = ''; changed = true; }
    else if (config.modelsApiKey.length > 500) { config.modelsApiKey = config.modelsApiKey.slice(0, 500); changed = true; }
    // 107-S2 最后一道闸:走到这里还带着掩码的不是真值(能还原的 unmaskSecrets 已经还原,写口另有
    // maskedSecretConflicts 整份拒绝)。与 sanitizeProvider 的同名两个 helper 是同一条规则,清空而不是留着。
    if (configUrlOrCleared(config.modelsApiBase) !== config.modelsApiBase) { config.modelsApiBase = ''; changed = true; }
    if (configSecretValueOrCleared(config.modelsApiKey) !== config.modelsApiKey) { config.modelsApiKey = ''; changed = true; }
    if (!['auto', 'bearer', 'x-api-key'].includes(config.claudeAuthMode)) { config.claudeAuthMode = 'auto'; changed = true; }
    config.discoverModelsFromProxy = config.discoverModelsFromProxy !== false;
    config.killPortOnStart = config.killPortOnStart !== false;
    // v0.5: providers (native OpenAI-compatible engines). Sanitize each, drop malformed, dedupe by id, cap count.
    {
      const rawArr = Array.isArray(config.providers) ? config.providers : [];
      const seen = new Set();
      const clean = [];
      for (const p of rawArr) {
        const sp = sanitizeProvider(p);
        if (sp && !seen.has(sp.id)) { seen.add(sp.id); clean.push(sp); }
      }
      config.providers = clean.slice(0, 20);
      if (!Array.isArray(raw && raw.providers) || JSON.stringify(config.providers) !== JSON.stringify(raw.providers)) changed = true;
    }
    if (typeof config.activeProvider !== 'string') { config.activeProvider = ''; changed = true; }
    if (config.activeProvider && config.activeProvider !== 'claude-cli' && !config.providers.some(p => p.id === config.activeProvider)) {
      config.activeProvider = ''; changed = true;
    }
    // 114a(45 号文 §7): asrProviderId/asrModel —— 与 compactProviderId 同口径(下方 :914-925 那段):
    // 字符串形状消毒(trim + 截 400);指向的 provider 没了就清成「未配置」(两个都空 = 麦克风不可见),
    // 不静默改指别的端点。单有 asrModel 没有 asrProviderId 时保留原值(惰性,不构成「已配置」)。
    for (const key of ['asrProviderId', 'asrModel', 'asrStreamProviderId', 'asrStreamModel', 'asrFixProviderId', 'asrFixModel']) {
      const clean = typeof config[key] === 'string' ? config[key].trim().slice(0, 400) : '';
      if (clean !== config[key]) { config[key] = clean; changed = true; }
    }
    // 131b:句尾改错方式只认四个值;别的一律回 'auto'(缺省)。指着的大模型端点没了就清成「跟随主端点」。
    if (!['auto', 'audio', 'llm', 'off'].includes(config.asrFixMode)) { config.asrFixMode = 'auto'; changed = true; }
    if (config.asrFixProviderId && !config.providers.some(p => p && p.id === config.asrFixProviderId)) {
      config.asrFixProviderId = '';
      config.asrFixModel = '';
      changed = true;
    }
    if (config.asrProviderId && !config.providers.some(p => p && p.id === config.asrProviderId)) {
      config.asrProviderId = '';
      config.asrModel = '';
      changed = true;
    }
    // 130:实时识别那一对同一条清洗 —— 指着的服务商没了就清成「未配置」(麦克风退回按停顿切段那条路)。
    if (config.asrStreamProviderId && !config.providers.some(p => p && p.id === config.asrStreamProviderId)) {
      config.asrStreamProviderId = '';
      config.asrStreamModel = '';
      changed = true;
    }
    {
      const mi = Number(config.openaiMaxToolIterations);
      const clamped = Number.isFinite(mi) ? Math.min(200, Math.max(1, Math.round(mi))) : 100;
      if (clamped !== config.openaiMaxToolIterations) { config.openaiMaxToolIterations = clamped; changed = true; }
    }
    // v0.7d: desktopMcp — coerce field types; a malformed/absent value falls back to the enabled+autodetect default.
    {
      const raw0 = (config.desktopMcp && typeof config.desktopMcp === 'object') ? config.desktopMcp : {};
      const d = {
        enabled: raw0.enabled !== false,
        command: typeof raw0.command === 'string' ? raw0.command.slice(0, 1000) : '',
        args: Array.isArray(raw0.args) ? raw0.args.filter(a => typeof a === 'string').slice(0, 50) : [],
        cwd: typeof raw0.cwd === 'string' ? raw0.cwd.slice(0, 1000) : '',
        autodetect: raw0.autodetect !== false,
      };
      if (JSON.stringify(d) !== JSON.stringify(config.desktopMcp)) { config.desktopMcp = d; changed = true; }
      else config.desktopMcp = d;
    }
    {
      const raw0 = (config.browserAutomation && typeof config.browserAutomation === 'object' && !Array.isArray(config.browserAutomation)) ? config.browserAutomation : {};
      const b = {
        mode: BROWSER_AUTOMATION_MODES.includes(raw0.mode) ? raw0.mode : 'system',
        executable: typeof raw0.executable === 'string' ? raw0.executable.trim().slice(0, 1000) : '',
        cdpUrl: typeof raw0.cdpUrl === 'string' && raw0.cdpUrl.trim() ? raw0.cdpUrl.trim().slice(0, 1000) : 'http://127.0.0.1:9222',
      };
      if (JSON.stringify(b) !== JSON.stringify(config.browserAutomation)) { config.browserAutomation = b; changed = true; }
      else config.browserAutomation = b;
    }
    // v0.7d: externalMcpServers — sanitize each, drop malformed, dedupe by id, cap 10.
    {
      const rawArr = Array.isArray(config.externalMcpServers) ? config.externalMcpServers : [];
      const seen = new Set();
      const clean = [];
      for (const s of rawArr) {
        const ss = sanitizeExternalMcpServer(s);
        if (ss && !seen.has(ss.id)) { seen.add(ss.id); clean.push(ss); }
      }
      config.externalMcpServers = clean.slice(0, 10);
      if (!Array.isArray(raw && raw.externalMcpServers) || JSON.stringify(config.externalMcpServers) !== JSON.stringify(raw.externalMcpServers)) changed = true;
    }
    // autoImportClaudeCodeMcp: 布尔,默认 true(显式 !== false 才为 true)。dismissedMcpIds: 字符串数组,去重 + 截 50。
    {
      const b = config.autoImportClaudeCodeMcp !== false;
      if (b !== config.autoImportClaudeCodeMcp) { config.autoImportClaudeCodeMcp = b; changed = true; }
      const rawArr = Array.isArray(config.dismissedMcpIds) ? config.dismissedMcpIds : [];
      const seen = new Set(); const cleanIds = [];
      for (const x of rawArr) {
        const s = String(typeof x === 'string' ? x : (x && x.id) || '').trim().slice(0, 64);
        if (s && !seen.has(s)) { seen.add(s); cleanIds.push(s); }
      }
      config.dismissedMcpIds = cleanIds.slice(0, 50);
      if (!Array.isArray(raw && raw.dismissedMcpIds) || JSON.stringify(config.dismissedMcpIds) !== JSON.stringify(raw.dismissedMcpIds)) changed = true;
    }
    // W2 迁移中心:importAgentInstructions 布尔(显式 !== false 才为 true);migrationSeenKeys 字符串数组,去重 + 每条截 200 + 留最新 300。
    {
      const b = config.importAgentInstructions !== false;
      if (b !== config.importAgentInstructions) { config.importAgentInstructions = b; changed = true; }
      const rawArr = Array.isArray(config.migrationSeenKeys) ? config.migrationSeenKeys : [];
      const seen = new Set(); const cleanKeys = [];
      for (const x of rawArr) {
        const s = String(typeof x === 'string' ? x : '').trim().slice(0, 200);
        if (s && !seen.has(s)) { seen.add(s); cleanKeys.push(s); }
      }
      config.migrationSeenKeys = cleanKeys.slice(-300);
      if (!Array.isArray(raw && raw.migrationSeenKeys) || JSON.stringify(config.migrationSeenKeys) !== JSON.stringify(raw.migrationSeenKeys)) changed = true;
    }
    if (config.bridgeExternalToolsToProvider !== false) config.bridgeExternalToolsToProvider = true;
    else config.bridgeExternalToolsToProvider = false;
    if (!['auto', 'full'].includes(config.toolLoadingMode)) { config.toolLoadingMode = 'auto'; changed = true; }
    // Runtime-optimization flags accept only JSON booleans. A truthy string such as "true" must not silently
    // enable either shadow telemetry or active behavior in a hand-edited config file.
    for (const key of ['runtimeOptimizationShadowV1', 'runtimeToolRetrievalV1', 'runtimeObservationReducerV1', 'runtimeEvaporateBudgetBoundaryV1', 'runtimeHistoryReadDedupV1', 'runtimeSummaryPromptI18nV1', 'runtimeReseedTailUnitsV1', 'runtimeReseedReattachFilesV1', 'runtimeObservationRecallV1', 'runtimeSessionNotesV1', 'runtimeSummaryEntityCheckV1', 'runtimeSessionNotesInjectV1', 'runtimeSessionNotesMergeV1', 'runtimeEstimateBucketsV1', 'runtimeSummarySingleShotV1', 'runtimeSummaryFactTableV1', 'runtimeSummaryRefineV1', 'runtimeBudgetGuardV1', 'runtimeToolTimeBudgetShadowV1', 'runtimeToolTimeBudgetV1', 'runtimeVolatileTailLayoutV1', 'runtimeAppendOnlyToolSchemasV1', 'runtimeExecResultCacheV1', 'runtimeFailureTelemetryV1', 'runtimeMemoryVectorRecallV1', 'sessionSearchIndexV1', 'boundedReadSchedulerV1', 'metaToolHintsV1', 'actionArgumentModelViewV1']) {
      const b = config[key] === true;
      if (b !== config[key]) { config[key] = b; changed = true; }
    }
    // schema<12 的三开关翻开(107-T1)与 schema<13 的 killOnDisconnect 翻关在 CONFIG_MIGRATIONS(to:12 / to:13),
    // 它们在上面这个严格布尔循环【之后】跑(脏值先压成 false 再迁),见 applyConfigMigrations 的调用点。
    { // 105f: 单发估算上限 —— JSON number,clamp [8192, 131072],缺省 32768(与 rules singleShotCap 同界)。
      const n = Number(config.summarySingleShotMaxTokensV1);
      const clamped = Number.isFinite(n) ? Math.min(131072, Math.max(8192, Math.round(n))) : 32768;
      if (clamped !== config.summarySingleShotMaxTokensV1) { config.summarySingleShotMaxTokensV1 = clamped; changed = true; }
      // 覆盖表:{ "providerId" | "providerId/model" | "style:chat|responses" → tokens };非法键/值整条丢弃,
      // 坏覆盖绝不静默放宽上限。
      const rawOv = (config.summarySingleShotMaxOverridesV1 && typeof config.summarySingleShotMaxOverridesV1 === 'object' && !Array.isArray(config.summarySingleShotMaxOverridesV1)) ? config.summarySingleShotMaxOverridesV1 : {};
      const cleanOv = {};
      for (const [k, v] of Object.entries(rawOv)) {
        const key = String(k || '').trim().slice(0, 160);
        const val = Number(v);
        if (key && Number.isFinite(val)) cleanOv[key] = Math.min(131072, Math.max(8192, Math.round(val)));
      }
      if (JSON.stringify(cleanOv) !== JSON.stringify(config.summarySingleShotMaxOverridesV1)) { config.summarySingleShotMaxOverridesV1 = cleanOv; changed = true; }
    }
    { // 105g: 事实表条数上限 —— JSON number,clamp [4,64],缺省 64;坏值不放宽请求体。
      const n = Number(config.summaryFactTableMaxSamplesV1);
      const clamped = Number.isFinite(n) ? Math.min(64, Math.max(4, Math.round(n))) : 64;
      if (clamped !== config.summaryFactTableMaxSamplesV1) { config.summaryFactTableMaxSamplesV1 = clamped; changed = true; }
    }
    { // 106 #13a: 回合 token 预算 —— 0 = 不设(不开门);非零钳位 [1, 10000000];坏值落回 0(关门),
      // 绝不因手抖配置静默放宽。warn 比例钳位 [0.1, 0.99],缺省 0.8。
      const n = Number(config.budgetGuardTurnTokensV1);
      const clamped = Number.isFinite(n) ? (n <= 0 ? 0 : Math.min(10000000, Math.round(n))) : 0;
      if (clamped !== config.budgetGuardTurnTokensV1) { config.budgetGuardTurnTokensV1 = clamped; changed = true; }
      const r = Number(config.budgetGuardWarnRatioV1);
      const rc = Number.isFinite(r) ? Math.min(0.99, Math.max(0.1, r)) : 0.8;
      if (rc !== config.budgetGuardWarnRatioV1) { config.budgetGuardWarnRatioV1 = rc; changed = true; }
    }
    { // 106 #13a-t: 工具时间预算毫秒 —— 0 = 该级关闭;非零时 warn 钳位 [1000, 3600000]、
      // hard 钳位 [5000, 7200000];坏值落回 0(该级关闭)。字节计数阈值 0 = 不计数,上限 100MB。
      const w = Number(config.toolTimeBudgetWarnMsV1);
      const wc = Number.isFinite(w) ? (w <= 0 ? 0 : Math.min(3600000, Math.max(1000, Math.round(w)))) : 0;
      if (wc !== config.toolTimeBudgetWarnMsV1) { config.toolTimeBudgetWarnMsV1 = wc; changed = true; }
      const h = Number(config.toolTimeBudgetHardMsV1);
      const hc = Number.isFinite(h) ? (h <= 0 ? 0 : Math.min(7200000, Math.max(5000, Math.round(h)))) : 0;
      if (hc !== config.toolTimeBudgetHardMsV1) { config.toolTimeBudgetHardMsV1 = hc; changed = true; }
      const b = Number(config.toolByteBudgetShadowBytesV1);
      const bc = Number.isFinite(b) ? (b <= 0 ? 0 : Math.min(104857600, Math.round(b))) : 0;
      if (bc !== config.toolByteBudgetShadowBytesV1) { config.toolByteBudgetShadowBytesV1 = bc; changed = true; }
    }
    { // 113a-后续(2026-09-04 用户拍板): 记忆容量五旋钮统一钳位。坏值/非数字一律落回默认。
      const clampInt = (value, lo, hi, fallback) => {
        const n = Number(value);
        return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback;
      };
      for (const [key, lo, hi, fallback] of [
        ['coreMemoryMaxItemsV1', 0, 2000, 200],
        ['coreMemoryCharBudgetV1', 0, 200000, 16000],
        ['memoryRelevanceMaxV1', 0, 64, 8],
        ['memoryFixedSelectionMaxV1', 1, 1024, 64],
        ['memoryIndexCharCapV1', 500, 100000, 6000],
      ]) {
        const next = clampInt(config[key], lo, hi, fallback);
        if (next !== config[key]) { config[key] = next; changed = true; }
      }
    }
    { // 106 #2a: 执行结果缓存每会话条数上限 —— 0 = 不缓存;钳位 [0, 2000],坏值落回默认 200。
      const n = Number(config.execResultCacheMaxEntriesV1);
      const nc = Number.isFinite(n) ? (n <= 0 ? 0 : Math.min(2000, Math.round(n))) : 200;
      if (nc !== config.execResultCacheMaxEntriesV1) { config.execResultCacheMaxEntriesV1 = nc; changed = true; }
    }
    { // 21-E2: bounded read concurrency — JSON number, clamp 1..8.
      const n = Number(config.boundedReadConcurrencyV1);
      const clamped = Number.isFinite(n) ? Math.min(8, Math.max(1, Math.round(n))) : 4;
      if (clamped !== config.boundedReadConcurrencyV1) { config.boundedReadConcurrencyV1 = clamped; changed = true; }
    }
    {
      const ttl = Number(config.toolCatalogCacheTtlMs);
      const clamped = Number.isFinite(ttl) ? Math.min(600000, Math.max(5000, Math.round(ttl))) : 60000;
      if (clamped !== config.toolCatalogCacheTtlMs) { config.toolCatalogCacheTtlMs = clamped; changed = true; }
    }
    // toolbox:形状清洗。id 只认登记约定里的那个字符集,各自去重、封顶 50。
    {
      const raw0 = (config.toolbox && typeof config.toolbox === 'object' && !Array.isArray(config.toolbox)) ? config.toolbox : {};
      const ids = v => [...new Set((Array.isArray(v) ? v : []).map(x => String(x || '')).filter(x => /^[a-z0-9][a-z0-9-]{0,39}$/.test(x)))].slice(0, 50);
      const tb = { autoDiscover: raw0.autoDiscover !== false, disabled: ids(raw0.disabled), seen: ids(raw0.seen) };
      if (JSON.stringify(tb) !== JSON.stringify(config.toolbox)) { config.toolbox = tb; changed = true; }
      else config.toolbox = tb;
    }
    // v1.1-W2 (T2): enableMcpDropIn — boolean, default true unless explicitly false (mirror bridge switch).
    { const b = config.enableMcpDropIn !== false; if (b !== config.enableMcpDropIn) { config.enableMcpDropIn = b; changed = true; } }
    // v0.8-S0: bridgedToolTiers — object of {unprefixedToolName: 'read'|'edit'|'exec'}. Drop any non-object
    // input and any entry whose value isn't a valid tier (a bad override must never widen permissions silently).
    {
      const raw0 = (config.bridgedToolTiers && typeof config.bridgedToolTiers === 'object' && !Array.isArray(config.bridgedToolTiers)) ? config.bridgedToolTiers : {};
      const clean = {};
      for (const [k, v] of Object.entries(raw0)) {
        if (typeof k === 'string' && k && (v === 'read' || v === 'edit' || v === 'exec')) clean[k] = v;
      }
      if (JSON.stringify(clean) !== JSON.stringify(config.bridgedToolTiers)) { config.bridgedToolTiers = clean; changed = true; }
      else config.bridgedToolTiers = clean;
    }
    // v0.8-S2: shellSessionMax — concurrency cap for persistent shell sessions. Clamp 1..8; a non-numeric
    // value must never disable the cap (defaults to 3).
    {
      const sm = Number(config.shellSessionMax);
      const clamped = Number.isFinite(sm) ? Math.min(8, Math.max(1, Math.round(sm))) : 3;
      if (clamped !== config.shellSessionMax) { config.shellSessionMax = clamped; changed = true; }
    }
    // v0.8-S4b: toolAllowRules — {nativeToolName:'allow'} persistent fine-grained allowlist. HARD cleanse:
    //  - value must be exactly 'allow';
    //  - the tool's NATIVE tier must be 'read' or 'edit' — exec/desktop tools are NEVER persistable (a
    //    persistent auto-allow on shell_run / a desktop action is exactly the class of blanket grant
    //    this feature must not enable; those get session-scoped allow in the front-end only).
    // Any entry failing either check is dropped silently (a bad rule must never widen permissions).
    {
      const raw0 = (config.toolAllowRules && typeof config.toolAllowRules === 'object' && !Array.isArray(config.toolAllowRules)) ? config.toolAllowRules : {};
      const clean = {};
      for (const [k, v] of Object.entries(raw0)) {
        if (typeof k !== 'string' || !k || v !== 'allow') continue;
        const tier = nativeToolTier(k);
        if (tier === 'read' || tier === 'edit') clean[k] = 'allow';
      }
      if (JSON.stringify(clean) !== JSON.stringify(config.toolAllowRules)) { config.toolAllowRules = clean; changed = true; }
      else config.toolAllowRules = clean;
    }
    // v0.8-S5: autoCompactThreshold — fraction of the context window that triggers auto-compaction. Clamp
    // 0.5..0.95; a non-numeric value must never disable compaction (defaults to 0.8).
    {
      const at = Number(config.autoCompactThreshold);
      const clamped = Number.isFinite(at) ? Math.min(0.95, Math.max(0.5, at)) : 0.8;
      if (clamped !== config.autoCompactThreshold) { config.autoCompactThreshold = clamped; changed = true; }
    }
    // Persist the meter's manual limits for server-side auto-compaction. Zero explicitly selects Auto.
    {
      const raw = config.contextWindowOverrides;
      const clean = {};
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [key, value] of Object.entries(raw).slice(-200)) {
          let route; try { route = JSON.parse(key); } catch { continue; }
          if (!Array.isArray(route) || route.length !== 3 || !['agent', 'openai'].includes(route[0])
            || route.some(v => typeof v !== 'string' || v.length > 400) || !route[1]) continue;
          if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;
          clean[JSON.stringify(route)] = value === 0 ? 0 : Math.round(Math.min(2000000, Math.max(8000, value)));
        }
      }
      if (JSON.stringify(raw) !== JSON.stringify(clean)) changed = true;
      config.contextWindowOverrides = clean;
    }
    // The selected compactor is deliberately independent from activeProvider/model so switching chat
    // engines does not silently change a user's preferred local summarizer. Missing providers are retained
    // as an empty/default selection instead of guessing another endpoint.
    for (const key of ['compactProviderId', 'compactModel']) {
      const clean = typeof config[key] === 'string' ? config[key].trim().slice(0, 400) : '';
      if (clean !== config[key]) { config[key] = clean; changed = true; }
    }
    if (config.compactProviderId && !(config.providers || []).some(p => p && p.id === config.compactProviderId)) {
      config.compactProviderId = '';
      config.compactModel = '';
      changed = true;
    }
    // v0.8-S6: capabilityProbeUrl — string; trim + cap length. A non-string coerces to '' (probe the active
    // provider's baseUrl instead). No scheme validation here: getCapabilities guards the HEAD fetch itself.
    {
      const raw0 = typeof config.capabilityProbeUrl === 'string' ? config.capabilityProbeUrl.trim().slice(0, 400) : '';
      if (raw0 !== config.capabilityProbeUrl) { config.capabilityProbeUrl = raw0; changed = true; }
    }
    { const b = config.enableToolRequiresProbe === true; if (b !== config.enableToolRequiresProbe) { config.enableToolRequiresProbe = b; changed = true; } }
    // v0.9-S1 (C1): uiMode / outputStyle — cleanse to their enums. An unknown value falls back to the
    // default ('simple' / 'detailed') so a corrupt config can never leave the UI in an undefined density/style.
    // 第36波(v1.7): uiMode 回退值与 defaultConfig 对齐('simple' = 人人可用面是产品默认;此前回退 'pro' 与
    // defaultConfig 的 'simple' 两处默认不一致,损坏配置会把普通用户扔进开发者面)。
    { const v = (config.uiMode === 'simple' || config.uiMode === 'pro') ? config.uiMode : 'simple'; if (v !== config.uiMode) { config.uiMode = v; changed = true; } }
    { const v = (config.outputStyle === 'concise' || config.outputStyle === 'detailed') ? config.outputStyle : 'detailed'; if (v !== config.outputStyle) { config.outputStyle = v; changed = true; } }
    // Resident skills are a small, source-locked global set. Existence and capability are checked against
    // the current workspace registry at use time; normalization only protects the config shape.
    {
      const rawArr = Array.isArray(config.residentSkills) ? config.residentSkills : [];
      const seen = new Set(), clean = [];
      for (const rawSkill of rawArr) {
        const id = String(typeof rawSkill === 'string' ? rawSkill : (rawSkill && rawSkill.id) || '').trim();
        const source = String(typeof rawSkill === 'object' && rawSkill ? rawSkill.source || '' : '').trim();
        if (!SKILL_ID_RE.test(id) || seen.has(id)) continue;
        seen.add(id); clean.push({ id, source: ['builtin', 'user', 'project'].includes(source) ? source : '' });
        if (clean.length >= 8) break;
      }
      if (JSON.stringify(clean) !== JSON.stringify(config.residentSkills)) { config.residentSkills = clean; changed = true; }
      else config.residentSkills = clean;
    }
    // v0.9-S3 (C3): recentWorkspaces — de-duped array of non-empty absolute-path strings, ≤10 (LRU: the
    // front is most-recent). Drop non-strings/empties; a duplicate (case-insensitive on Windows) keeps only the first
    // occurrence (so the front-inserted entry wins). A non-array coerces to []. Never widens anything.
    {
      const rawArr = Array.isArray(config.recentWorkspaces) ? config.recentWorkspaces : [];
      const seen = new Set();
      const clean = [];
      for (const w of rawArr) {
        if (typeof w !== 'string') continue;
        const s = normalizeWorkspacePathString(w);
        if (!s) continue;
        // Preserve the stored spelling on Windows, where resolving '/' depends on the current drive.
        const key = samePathKey(s);
        if (seen.has(key)) continue;
        seen.add(key);
        clean.push(s);
        if (clean.length >= 10) break;
      }
      if (JSON.stringify(clean) !== JSON.stringify(config.recentWorkspaces)) { config.recentWorkspaces = clean; changed = true; }
      else config.recentWorkspaces = clean;
    }
    // 118a: onboarding, the welcome-wizard completion record. Additive default null; any non-object (or array)
    // collapses back to null. A written record is cleansed to exactly three fields so a hand-edited config
    // cannot smuggle extra keys into the UI. Fields: completedAt (trimmed ISO-ish string or null), version (integer
    // 0..1000) and skipped (strict boolean). Nothing here widens behavior: the record only decides whether
    // the wizard offers itself again.
    {
      const rawOnboarding = config.onboarding;
      let clean = null;
      if (rawOnboarding && typeof rawOnboarding === 'object' && !Array.isArray(rawOnboarding)) {
        const completedAtRaw = typeof rawOnboarding.completedAt === 'string' ? rawOnboarding.completedAt.trim() : '';
        const versionNumber = Number(rawOnboarding.version);
        clean = {
          completedAt: completedAtRaw ? completedAtRaw.slice(0, 64) : null,
          version: Number.isFinite(versionNumber) ? Math.max(0, Math.min(1000, Math.round(versionNumber))) : 0,
          skipped: rawOnboarding.skipped === true,
        };
      }
      if (JSON.stringify(clean) !== JSON.stringify(config.onboarding)) { config.onboarding = clean; changed = true; }
      else config.onboarding = clean;
    }
    // 一次性 schema 迁移的唯一调用点(见 CONFIG_MIGRATIONS 头注):被迁移读到的键到这里都已完成字段级校验,
    // 而下面的工作区表那一段要消费 to:10 播进来的种子。
    const rawKeys = new Set(raw && typeof raw === 'object' && !Array.isArray(raw) ? Object.keys(raw) : []);
    if (applyConfigMigrations(config, { fromSchema: incomingConfigSchema, rawExplicit, rawKeys })) changed = true;
    // v2.7 (workspace permissions): workspaces — priority-ordered array of {path, read, write, execute}; all
    // flags default true (read !== false / write !== false / execute !== false). One-time seed (schema < 10)
    // from defaultWorkspace + recentWorkspaces lives in CONFIG_MIGRATIONS (to:10), which runs just above and
    // leaves the seed rows in config.workspaces for this block to cleanse. Cleanse: trimmed string path (≤1000), boolean flags, platform-aware de-dupe,
    // capped at WORKSPACE_TABLE_CAP rows (117w-W1④ raised it 20 -> 64; see that constant for why).
    // defaultWorkspace is kept in sync with the highest-priority (first) workspace for backward compat.
    {
      const rawArr = Array.isArray(config.workspaces) ? config.workspaces : [];
      const seen = new Set();
      const clean = [];
      const pushWs = (raw) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
        const p = normalizeWorkspacePathString(raw.path);
        if (!p) return;
        const key = samePathKey(p);
        if (seen.has(key)) return;
        seen.add(key);
        const entry = { path: p, read: raw.read !== false, write: raw.write !== false, execute: raw.execute !== false };
        // 117w-W1 提交②(§11.19.2):可选备注 —— 用户在设置里给工作区写一句「股票资料」之类,管家的
        // 候选表投影按「末段名 + 备注」渲染(见 13o stewardWorkspaceTableBlock)。空/非字符串一律【不写字段】
        // (缺省不写而不是写空串:老配置逐字节不变,JSON.stringify 比较不会因为多一个 "" 就判成 changed)。
        const note = typeof raw.note === 'string' ? raw.note.trim().slice(0, WORKSPACE_NOTE_MAX) : '';
        if (note) entry.note = note;
        clean.push(entry);
      };
      for (const e of rawArr) { pushWs(e); if (clean.length >= WORKSPACE_TABLE_CAP) break; }
      // W7:如意自己开的文件夹不留在常用工作区里(迁出),用户亲手加回去的算他的(收编)。见 normalizeStewardManagedWorkspaces。
      {
        const split = normalizeStewardManagedWorkspaces(config, clean);
        clean.splice(0, clean.length, ...split.kept);
        if (JSON.stringify(split.managed) !== JSON.stringify(config.stewardManagedWorkspaces)) { config.stewardManagedWorkspaces = split.managed; changed = true; }
        else config.stewardManagedWorkspaces = split.managed;
      }
      if (JSON.stringify(clean) !== JSON.stringify(config.workspaces)) { config.workspaces = clean; changed = true; }
      else config.workspaces = clean;
      const primary = clean.length ? clean[0].path : (typeof config.defaultWorkspace === 'string' && config.defaultWorkspace.trim() ? config.defaultWorkspace : os.homedir());
      if (config.defaultWorkspace !== primary) { config.defaultWorkspace = primary; changed = true; }
      const ab = config.allowOutsideWorkspace === true;
      if (ab !== config.allowOutsideWorkspace) { config.allowOutsideWorkspace = ab; changed = true; }
      // 117w-W1 提交②(§11.19.2):Ruyi 根。清洗与 defaultWorkspace 同一口径(剥「复制为路径」的引号 +
      // trim + 截 1000),外加两条:必须是【绝对路径】(相对路径会被 path.resolve 按服务进程的 cwd 补全,
      // 那是一条无声的越权路),空/非绝对一律回落出厂默认 ~/Ruyi。这里【不】做 path.resolve —— 与
      // normalizeWorkspacePathString 处理 workspaces[].path 时同形(表里存的就是用户敲进去的原样),
      // resolve 由消费侧(13k stewardCanonWorkspacePath)统一补。
      const rootRaw = normalizeWorkspacePathString(config.stewardWorkspaceRoot);
      const root = (rootRaw && path.isAbsolute(rootRaw)) ? rootRaw : path.join(os.homedir(), 'Ruyi');
      if (root !== config.stewardWorkspaceRoot) { config.stewardWorkspaceRoot = root; changed = true; }
    }
    // Sub-agent limits: concurrency is configurable but bounded; total 0 disables the feature.
    // v1.4.4: fallback defaults raised to the top of each range (8 / 32) — see defaultConfig() note.
    {
      // 后台代理完成自动唤醒:只有显式 false 才关(缺省 / 非布尔一律按开)。
      const aw = config.agentAutoWake !== false;
      if (aw !== config.agentAutoWake) { config.agentAutoWake = aw; changed = true; }
    }
    {
      const sc = Number(config.subagentMaxConcurrent);
      const clamped = Number.isFinite(sc) ? Math.min(8, Math.max(1, Math.round(sc))) : 8;
      if (clamped !== config.subagentMaxConcurrent) { config.subagentMaxConcurrent = clamped; changed = true; }
    }
    {
      let sm = Number(config.subagentMaxPerTurn);
      // 第23波: 一次性迁移旧默认 4 → 新默认 32(v1.4.4 已把默认调到 32,但存量配置里的 4 从不被上调,导致回合内多代理
      // 扇出/编排被卡在 4)。仅迁移【恰为旧默认 4】的值;显式设成别的低值(1/2/3)视为用户有意,不动。flag 防重复迁移
      // (置位后用户再设 4 会被尊重)。上限从 32 放宽到 64。
      if (config.subagentBudgetMigrated !== true && sm === 4) sm = 32;
      const clamped = Number.isFinite(sm) ? Math.min(64, Math.max(0, Math.round(sm))) : 32;
      if (clamped !== config.subagentMaxPerTurn) { config.subagentMaxPerTurn = clamped; changed = true; }
    }
    if (config.subagentBudgetMigrated !== true) { config.subagentBudgetMigrated = true; changed = true; }
    // 52x: 子 agent 优先端点+模型规范化(字符串 trim + 长度截断,与 UI 保存口径一致)
    {
      const sp = String(config.subagentPreferredProvider || '').trim().slice(0, 120);
      if (sp !== config.subagentPreferredProvider) { config.subagentPreferredProvider = sp; changed = true; }
      const sm = String(config.subagentPreferredModel || '').trim().slice(0, 160);
      if (sm !== config.subagentPreferredModel) { config.subagentPreferredModel = sm; changed = true; }
    }
    // 第 116 波 116a(27 号文 §11.3):管家总开关,严格布尔(=== true),防手改配置文件把垃圾值当成开(121 波 K0 只改默认值,不改这条归一)。
    {
      const b = config.stewardEnabledV1 === true;
      if (b !== config.stewardEnabledV1) { config.stewardEnabledV1 = b; changed = true; }
    }
    // 第 116 波 116a(27 号文 §11.3):管家专用端点/模型,规范化口径与 subagentPreferredProvider/Model 一致
    // (trim + 截断),空值="跟随主端点"。
    {
      const sp = String(config.stewardProviderId || '').trim().slice(0, 120);
      if (sp !== config.stewardProviderId) { config.stewardProviderId = sp; changed = true; }
      const sm = String(config.stewardModel || '').trim().slice(0, 160);
      if (sm !== config.stewardModel) { config.stewardModel = sm; changed = true; }
    }
    // 第 116 波 116-5a(27 号文 §11.8):线程自动摘要开关。它一直默认【开】(121 波 K0 后总开关也默认开,
    // 但两者的严格布尔方向仍相反):只有显式写 false 才算关(!== false),别的垃圾值一律归一成 true ——
    // 这样手改坏了配置文件不会静默丢掉一个默认开的能力。
    {
      const b = config.stewardThreadBriefV1 !== false;
      if (b !== config.stewardThreadBriefV1) { config.stewardThreadBriefV1 = b; changed = true; }
    }
    // 第 127 波 2-quater B2:代批开关。默认开,与 stewardThreadBriefV1 同方向的严格布尔(!== false):只有显式写
    // false 才算关,垃圾值一律归一成 true —— 规范化之后恒为布尔,13l 那一侧按 === true 判(读到非布尔就当关,fail-closed)。
    {
      const b = config.stewardExemptDelegationV1 !== false;
      if (b !== config.stewardExemptDelegationV1) { config.stewardExemptDelegationV1 = b; changed = true; }
    }
    // 第 117 波 117l(27 号文 §11.9 D7):新开线程的两档端点/模型。形状归一 —— 缺键补空、非对象整体回默认、
    // 未知键丢弃;providerId ≤120、model ≤160(与 stewardProviderId/stewardModel 同一口径),两者都 trim。
    // 这里【不】校验 provider 是否真的存在:设置页可能先配 id 后建端点,存在性由 06i 的
    // stewardThreadEngineRoute 在用的那一刻判(不存在就回落全局并记一条审计),不在这里静默清空用户输入。
    {
      const DEF_TM = { strong: { providerId: '', model: '' }, fast: { providerId: '', model: '' } };
      const rawTm = (config.stewardThreadModels && typeof config.stewardThreadModels === 'object' && !Array.isArray(config.stewardThreadModels)) ? config.stewardThreadModels : null;
      const slot = raw => {
        const s = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
        return { providerId: String(s.providerId || '').trim().slice(0, 120), model: String(s.model || '').trim().slice(0, 160) };
      };
      const tm = rawTm ? { strong: slot(rawTm.strong), fast: slot(rawTm.fast) } : { ...DEF_TM };
      if (JSON.stringify(tm) !== JSON.stringify(config.stewardThreadModels)) { config.stewardThreadModels = tm; changed = true; }
      else config.stewardThreadModels = tm;
    }
    // 第 116 波 116a(27 号文 §11.3):管家收件箱轮询间隔(ms),非法值回默认 60000;保留 UI 断连重试的 [5000,120000] 配置范围,收件箱一致性检查另设 60 秒下限。
    {
      const n = Number(config.stewardPollMs);
      const clamped = Number.isFinite(n) ? Math.min(120000, Math.max(5000, Math.round(n))) : 60000;
      if (clamped !== config.stewardPollMs) { config.stewardPollMs = clamped; changed = true; }
    }
    // 第 121 波 K3(34 号文 §4.1):任务索引「最近 N 条」窗口,非法值(非有限数)回默认 30,
    // clamp [10,200]。三个数都取自上面那组常量,不在这里重写字面量。
    {
      const n = Number(config.threadIndexRecent);
      const clamped = Number.isFinite(n)
        ? Math.min(THREAD_INDEX_RECENT_MAX, Math.max(THREAD_INDEX_RECENT_MIN, Math.round(n)))
        : THREAD_INDEX_RECENT_DEFAULT;
      if (clamped !== config.threadIndexRecent) { config.threadIndexRecent = clamped; changed = true; }
    }
    // 第 116 波 116a(27 号文 §11.3):管家每小时最多替用户执行的回合数,clamp [1,120],非法回默认 30
    // (117m-A1 把默认值 12 → 30,这里的兜底值与默认表同步;clamp 区间一字未动)。
    {
      const n = Number(config.stewardMaxTurnsPerHour);
      const clamped = Number.isFinite(n) ? Math.min(120, Math.max(1, Math.round(n))) : 30;
      if (clamped !== config.stewardMaxTurnsPerHour) { config.stewardMaxTurnsPerHour = clamped; changed = true; }
    }
    // 第 116 波 116a(27 号文 §11.3):管家自身每日花费上限(USD),clamp [0,1000],非法回默认 5(允许小数,不取整)。
    {
      const n = Number(config.stewardMaxCostPerDay);
      const clamped = Number.isFinite(n) ? Math.min(1000, Math.max(0, n)) : 5;
      if (clamped !== config.stewardMaxCostPerDay) { config.stewardMaxCostPerDay = clamped; changed = true; }
    }
    // 第 116 波 116a(27 号文 §11.3):管家「可以自己做的事」自理清单——retry/relay/newThread/answer 严格布尔
    // (非布尔值回该键自身默认);resume 三态 true/false/null(null=跟随 autonomyAutoResume,非三态值回 null);
    // 未知键丢弃;整体非对象回全部默认。
    // 129g(31 号文 §2.5):answer =「线程停下来问用户话时,管家替他答」。**默认关**,而且是独立一格 ——
    // 修前它搭在 relay 上:用户勾「事项内自动交接」是要让上一条线程的结论流到下一条,顺带却把
    // 「替我回答」也给了出去。一格两权,用户按的时候看不出第二个。
    {
      const DEF_AA = { retry: true, resume: null, relay: true, newThread: true, answer: false, continueUnfinished: true };   // 136:relay 默认开,与默认表同值(两处必须同值,否则缺省与填垃圾落到不同行为)
      const raw0 = (config.stewardAutoActions && typeof config.stewardAutoActions === 'object' && !Array.isArray(config.stewardAutoActions)) ? config.stewardAutoActions : null;
      const aa = raw0 ? {
        retry: typeof raw0.retry === 'boolean' ? raw0.retry : DEF_AA.retry,
        resume: (raw0.resume === true || raw0.resume === false || raw0.resume === null) ? raw0.resume : DEF_AA.resume,
        relay: typeof raw0.relay === 'boolean' ? raw0.relay : DEF_AA.relay,
        newThread: typeof raw0.newThread === 'boolean' ? raw0.newThread : DEF_AA.newThread,
        answer: typeof raw0.answer === 'boolean' ? raw0.answer : DEF_AA.answer,
        continueUnfinished: typeof raw0.continueUnfinished === 'boolean' ? raw0.continueUnfinished : DEF_AA.continueUnfinished,
      } : { ...DEF_AA };
      if (JSON.stringify(aa) !== JSON.stringify(config.stewardAutoActions)) { config.stewardAutoActions = aa; changed = true; }
      else config.stewardAutoActions = aa;
    }
    // 第 116 波 116a(27 号文 §11.3):一次到访内管家上下文预算(token),clamp [16000,2000000],非法回默认 200000。
    {
      const n = Number(config.stewardContextBudgetTokens);
      const clamped = Number.isFinite(n) ? Math.min(2000000, Math.max(16000, Math.round(n))) : 200000;
      if (clamped !== config.stewardContextBudgetTokens) { config.stewardContextBudgetTokens = clamped; changed = true; }
    }
    // 136(用户 2026-09-23「上下文太紧」):压缩触发线系数,clamp [0.3,0.95],非法回默认 0.6
    // (允许小数、不取整 —— 0.65 是合法值;与 stewardMaxCostPerDay 同一口径)。
    {
      const n = Number(config.stewardContextBudgetRatio);
      const clamped = Number.isFinite(n) ? Math.min(0.95, Math.max(0.3, n)) : 0.6;
      if (clamped !== config.stewardContextBudgetRatio) { config.stewardContextBudgetRatio = clamped; changed = true; }
    }
    // 第 116 波 116a(27 号文 §11.3):管家按需深读(steward_thread_read 等)单次到访合计字符预算,clamp [4000,400000],
    // 非法回默认 48000。
    {
      const n = Number(config.stewardReadBudgetChars);
      const clamped = Number.isFinite(n) ? Math.min(400000, Math.max(4000, Math.round(n))) : 48000;
      if (clamped !== config.stewardReadBudgetChars) { config.stewardReadBudgetChars = clamped; changed = true; }
    }
    {
      // 129f:一小时叫人次数上限。1..60 —— 0 不是「不叫」(那是通知总开关的事),下限 1 才讲得通。
      const n = Number(config.stewardNotifyPerHour);
      const clamped = Number.isFinite(n) ? Math.min(60, Math.max(1, Math.round(n))) : 6;
      if (clamped !== config.stewardNotifyPerHour) { config.stewardNotifyPerHour = clamped; changed = true; }
    }
    // 第 116 波 116a(27 号文 §11.3):判定「一次到访」结束的静默分钟数,clamp [5,1440],非法回默认 60。
    {
      const n = Number(config.stewardVisitIdleMinutes);
      const clamped = Number.isFinite(n) ? Math.min(1440, Math.max(5, Math.round(n))) : 60;
      if (clamped !== config.stewardVisitIdleMinutes) { config.stewardVisitIdleMinutes = clamped; changed = true; }
    }
    // 第 123 波 M2(37 号文 §3.5):安静卡「稍后」的推迟分钟数,clamp [1,1440],非法回默认 30。
    {
      const n = Number(config.quietCardSnoozeMinutes);
      const clamped = Number.isFinite(n) ? Math.min(1440, Math.max(1, Math.round(n))) : 30;
      if (clamped !== config.quietCardSnoozeMinutes) { config.quietCardSnoozeMinutes = clamped; changed = true; }
    }
    // 第 116 波 116a(27 号文 §11.3):管家会话历史保留策略,枚举 visit|24h|forever,非法回默认。
    // 136:默认 visit → 24h,兜底同步改(两处必须同一个值,否则缺省与填垃圾落到不同策略)。
    {
      const norm = ['visit', '24h', 'forever'].includes(config.stewardConversationRetention) ? config.stewardConversationRetention : '24h';
      if (norm !== config.stewardConversationRetention) { config.stewardConversationRetention = norm; changed = true; }
    }
    // 136(用户 2026-09-23「言行不够拟人」):管家人设两个字符串键 —— trim + 上限截断(名字 20 字 /
    // 口吻 200 字),与 stewardModel 同一口径(非字符串先 String(),未知类型不留原值)。
    {
      const name = String(config.stewardPersonaName || '').trim().slice(0, 20);
      if (name !== config.stewardPersonaName) { config.stewardPersonaName = name; changed = true; }
      const style = String(config.stewardPersonaStyle || '').trim().slice(0, 200);
      if (style !== config.stewardPersonaStyle) { config.stewardPersonaStyle = style; changed = true; }
    }
    // 第 116 波 116h(27 号文 §3.1 116h 行 / §8.10):线程间仲裁的三个全局闸。夹取口径与上面 116a 的
    // 各键一致(非有限数回该键自身默认;整数键取整,金额键保留小数)。
    {
      const n = Number(config.stewardMaxParallelThreads);
      const clamped = Number.isFinite(n) ? Math.min(32, Math.max(1, Math.round(n))) : 5;
      if (clamped !== config.stewardMaxParallelThreads) { config.stewardMaxParallelThreads = clamped; changed = true; }
    }
    {
      const n = Number(config.stewardGlobalMaxTurnsPerHour);
      const clamped = Number.isFinite(n) ? Math.min(2000, Math.max(1, Math.round(n))) : 120;
      if (clamped !== config.stewardGlobalMaxTurnsPerHour) { config.stewardGlobalMaxTurnsPerHour = clamped; changed = true; }
    }
    {
      const n = Number(config.stewardGlobalMaxCostPerDay);
      const clamped = Number.isFinite(n) ? Math.min(10000, Math.max(0, n)) : 50;
      if (clamped !== config.stewardGlobalMaxCostPerDay) { config.stewardGlobalMaxCostPerDay = clamped; changed = true; }
    }
    // 第 123 波 M1:调度器总开关。与 stewardThreadBriefV1 同方向的严格布尔(!== false)——
    // 它默认【开】,只有显式写 false 才算关;别的垃圾值一律归一成 true,这样手改坏了配置文件
    // 不会静默丢掉一个默认开的能力。(stewardEnabledV1 那条是 === true 方向,两者刻意不同,见各自注释。)
    {
      const b = config.schedulerEnabledV1 !== false;
      if (b !== config.schedulerEnabledV1) { config.schedulerEnabledV1 = b; changed = true; }
    }
    // 第 123 波 M1 §3.2:无人值守 ask 的等待窗口(分钟),clamp [1,240],非法回默认 30。
    // 区间上下界与默认值的单一事实源是 06j 的 SCHEDULER_LIMITS —— 但 06j 拼在 01 【之后】,
    // 这里引用它会是一条前向边,所以这三个数在这里写成字面量,并由 unit/scheduler-core.test.js
    // 与 scheduler-api.e2e.js 两头对账(任何一边改了数,另一边当场红)。
    {
      const n = Number(config.schedulerAskWaitMinutes);
      const clamped = Number.isFinite(n) ? Math.min(240, Math.max(1, Math.round(n))) : 30;
      if (clamped !== config.schedulerAskWaitMinutes) { config.schedulerAskWaitMinutes = clamped; changed = true; }
    }
    // v1.4.4: agentWorkflowMaxNodes — persisted Agent 工作流 DAG node-count ceiling (see defaultConfig())。第23波上限 32→64。
    {
      const am = Number(config.agentWorkflowMaxNodes);
      const clamped = Number.isFinite(am) ? Math.min(64, Math.max(1, Math.round(am))) : 48;
      if (clamped !== config.agentWorkflowMaxNodes) { config.agentWorkflowMaxNodes = clamped; changed = true; }
    }
    {
      // 团队模式 v2 (A2): 清洗任务池策略与 auto cap。
      const pp = String(config.agentTaskPoolPolicy || '').trim();
      const normPp = ['manual', 'auto-capped', 'off'].includes(pp) ? pp : 'manual';
      if (normPp !== config.agentTaskPoolPolicy) { config.agentTaskPoolPolicy = normPp; changed = true; }
      const cap = Number(config.agentTaskPoolAutoCap);
      const capN = Number.isFinite(cap) ? Math.min(16, Math.max(0, Math.round(cap))) : 3;
      if (capN !== config.agentTaskPoolAutoCap) { config.agentTaskPoolAutoCap = capN; changed = true; }
    }
    {
      const rawRoles = Array.isArray(config.agentRoleOverrides) ? config.agentRoleOverrides : [];
      const seen = new Set(), clean = [];
      for (const rawRole of rawRoles) {
        const role = normalizeAgentRole(rawRole, { source: 'global' });
        if (!role || seen.has(role.id)) continue;
        seen.add(role.id); clean.push(role);
        if (clean.length >= 32) break;
      }
      if (JSON.stringify(clean) !== JSON.stringify(config.agentRoleOverrides)) { config.agentRoleOverrides = clean; changed = true; }
      else config.agentRoleOverrides = clean;
    }
    // v0.9-S9 (D6): searchBackend — {type,baseUrl,apiKey}. Cleanse type to the enum (unknown → 'none'), and
    // baseUrl/apiKey to length-capped strings. An unknown/absent value falls back to a disabled backend so a
    // corrupt config can never leave web_search pointing at garbage. apiKey is masked on the way OUT (see
    // maskSecrets) and unmasked on SAVE (unmaskSecrets), same as providers[].apiKey.
    {
      const raw0 = (config.searchBackend && typeof config.searchBackend === 'object' && !Array.isArray(config.searchBackend)) ? config.searchBackend : {};
      // v1.0-S6 (A): +tavily +bocha. v1.1-W1a (T3): +builtin. New枚举 values are OPTIONAL/缺省安全 — an
      // absent/unknown type still falls back to 'builtin' (the zero-config default), so configSchema stays 7.
      let type = ['none', 'builtin', 'searxng', 'bing', 'brave', 'tavily', 'bocha', 'deepseek', 'custom'].includes(raw0.type) ? raw0.type : 'builtin';
      // v1.1-W1a (T3): MIGRATE存量 'none' → 'builtin'. Rationale: 'none' was the *historical default* (nobody
      // ever actively chose "disable search" — the old default just left web_search off). Folding it to the new
      // zero-config backend turns search ON for every upgraded install, matching the 开箱即用 decision.
      // 审计 P2 (修 v1.1-W1a 的过度折叠): 旧版【无条件】折叠 'none'→'builtin' → UI 新增的「不启用」选项永不生效(每次
      // load 又被折回 builtin),对气隙产品是「联网关不掉」的合规缺陷。改为【一次性】迁移:仅当从未迁移过
      // (searchBackendMigrated 缺失,即老配置/新装首读)才折叠;置位后用户显式选择的 'none' 正常持久化。只折 'none',
      // 其它 backend 从不改动。迁移标记随 readConfig 首次即写回磁盘,并经 POST /api/config 的 {...current,...body}
      // 合并稳定存活(current 恒含 true),故保存往返不会重新折叠。
      if (raw0.type === 'none' && config.searchBackendMigrated !== true) { type = 'builtin'; }
      if (config.searchBackendMigrated !== true) { config.searchBackendMigrated = true; changed = true; }
      const sb = {
        type,
        // 107-S2 最后一道闸(同 sanitizeProvider):掩码永不落盘。
        baseUrl: typeof raw0.baseUrl === 'string' ? configUrlOrCleared(raw0.baseUrl.trim().slice(0, 1000)) : '',
        apiKey: typeof raw0.apiKey === 'string' ? configSecretValueOrCleared(raw0.apiKey.slice(0, 2048)) : '',
        // 配置的 API-key 后端失败时是否回退到公网内置搜索(会外发查询词)。缺省 = 关;只在为 true 时落盘,老配置字节不变。
        ...(raw0.fallbackToBuiltin === true ? { fallbackToBuiltin: true } : {}),
      };
      if (JSON.stringify(sb) !== JSON.stringify(config.searchBackend)) { config.searchBackend = sb; changed = true; }
      else config.searchBackend = sb;
    }
    config.configSchema = CONFIG_SCHEMA;
    config.version = VERSION;
    // v1.4.3: sanitize new config fields
    if (typeof config.appendSystemPrompt !== 'string') { config.appendSystemPrompt = ''; changed = true; }
    else if (config.appendSystemPrompt.length > 8000) { config.appendSystemPrompt = config.appendSystemPrompt.slice(0, 8000); changed = true; }
    if (!Array.isArray(config.additionalDirectories) || config.additionalDirectories.some(a => typeof a !== 'string')) {
      config.additionalDirectories = Array.isArray(config.additionalDirectories) ? config.additionalDirectories.filter(a => typeof a === 'string').slice(0, 20) : [];
      changed = true;
    }
    // v1.4-OSS 用量看板: usageBudget — optional {monthly:Number>0, currency:short string} soft budget, else null.
    // A malformed value coerces to null (never leaves a garbage budget in config). ADDITIVE/optional field.
    {
      const raw0 = (config.usageBudget && typeof config.usageBudget === 'object' && !Array.isArray(config.usageBudget)) ? config.usageBudget : null;
      let ub = null;
      if (raw0) {
        const monthly = Number(raw0.monthly);
        const currency = (typeof raw0.currency === 'string') ? raw0.currency.trim().slice(0, 8) : '';
        if (Number.isFinite(monthly) && monthly > 0 && currency) ub = { monthly, currency };
      }
      if (JSON.stringify(ub) !== JSON.stringify(config.usageBudget)) { config.usageBudget = ub; changed = true; }
      else config.usageBudget = ub;
    }
    // v1.4-OSS 用量看板: claudePricing — optional {inputPerM, outputPerM, currency} for Claude cost estimation
    // (see defaultConfig). Validated via the shared normalizePricing; a malformed value coerces to null.
    {
      const cp = normalizePricing(config.claudePricing);
      if (JSON.stringify(cp) !== JSON.stringify(config.claudePricing)) { config.claudePricing = cp; changed = true; }
      else config.claudePricing = cp;
    }
    // 128a:显式键集合与落盘投影。读盘语义下,raw 里出现、归一化后不等于当前默认的已知键 = 显式
    // (手改 config.json、旧版本写下的整份配置)。等于默认又不在集合里的键不落盘 —— 而且第一次读就清掉,
    // 否则下次默认一变,它们会被这条规则误认成「手改」、又冻住。
    // 旧格式(schema < 当前,含全新安装与降级往返)那一次读要看【全部】键,不只看 raw 里出现过的:上面那些
    // CONFIG_MIGRATIONS 里的一次性迁移会给 raw 里【没有】的键造出值(例如 to:10 从 defaultWorkspace 给工作区表
    // 播种),而 schema 一抬到当前,它们再也不会跑 —— 这一次不落盘,造出来的值就永远丢了(128a 第一轮全量逮到:
    // 工作区表被清空,管家开线程一律 invalid_request)。当前格式的文件只看 raw 里的键(手改)。
    const explicit = new Set(rawExplicit);
    if (opts.inferExplicit !== false) {
      const migrationRead = incomingConfigSchema < CONFIG_SCHEMA;
      const candidates = migrationRead ? Object.keys(config) : (raw && typeof raw === 'object' ? Object.keys(raw) : []);
      for (const key of candidates) {
        if (CONFIG_BOOKKEEPING_KEYS.includes(key) || !Object.prototype.hasOwnProperty.call(base, key)) continue;
        if (!configValueEquals(configComparableValue(config, key), base[key])) explicit.add(key);
      }
    }
    finalizeConfigExplicitKeys(config, explicit);
    const persisted = persistableConfig(config, base);
    // 是否写盘 = 投影与盘上内容是否不同(不再看归一化途中的内部标记):派生值(比如没设工作区时 defaultWorkspace
    // 取家目录)每次读都重算、但不在投影里,不会造成每读必写。
    changed = !raw || typeof raw !== 'object' || !configValueEquals(persisted, raw);
    return { config, changed, persisted };
  }

  return {
    defaultConfig, normalizeConfig, CONFIG_MIGRATIONS,
    CONFIG_BOOKKEEPING_KEYS, configExplicitKeysOf, configValueEquals,
    configComparableValue, persistableConfig, finalizeConfigExplicitKeys,
  };
}

module.exports = { createConfigSchema, BROWSER_AUTOMATION_MODES };
