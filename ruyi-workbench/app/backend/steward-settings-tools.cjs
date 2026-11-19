'use strict';

function createStewardSettingsTools({
  safeSessionId, stewardAppendDecision, stewardBasisOf, stewardFail, stewardPermissionLabel,
  configPolicy, evidence, privacy,
}) {
  const {
    ConfigPatchHooks, KEY_MASK_PREFIX, PERMISSION_MODES_REQUIRING_CONFIRM, maskProviders,
    maskedSecretConflictMessage, maskedSecretConflicts, normalizeConfig, stewardConfigHelpFor,
    stewardConfigTierFor, unmaskSecrets,
  } = configPolicy;
  const { stewardQuoteInSource, stewardSourceUserTexts } = evidence;
  const { PrivacyCore } = privacy;

  // ════════════════════════════════════════════════════════════════════════════
  // 设置族(tier exec)—— §3.5「如意设置」行的三级分级。判据唯一来源是 06i 的 stewardConfigTierFor。
  // ════════════════════════════════════════════════════════════════════════════

  // 22) steward_config_get —— 掩码复用 POST /api/config 回包用的同一个 maskProviders(不另写一套)。
  //     forbidden 级的键【连掩码值都不回】,只在 omitted[] 里列键名 —— 给出掩码值等于承认它存在
  //     并暗示它的形状,而 forbidden 的意思是「这一族根本不经管家」。
  // 只描述可证明的时机。未列出的参数不承诺即时改变在途回合；相关功能下次读取配置时使用。
  function stewardSettingScope(key) {
    if (key === 'permissionMode') return { scope: 'defaults', effective: 'next_turn' };
    if (['activeProvider', 'agentCliType', 'model', 'newThreadEngine'].includes(key)) return { scope: 'new_threads', effective: 'new_threads' };
    if (['stewardProviderId', 'stewardModel'].includes(key)) return { scope: 'steward', effective: 'next_turn' };
    if (key === 'turnIdleTimeoutMs') return { scope: 'application', effective: 'next_turn' };
    if (['questionTimeoutMs', 'permissionTimeoutMs'].includes(key)) return { scope: 'application', effective: 'next_wait', note: '读取新配置后创建的等待使用；已有等待不重新计时，在途回合可能沿用原配置。' };
    return { scope: key.startsWith('steward') ? 'steward' : 'application', effective: 'next_read' };
  }
  function stewardSettingsReceipt(keys, previous, next) {
    const before = maskProviders(previous), after = maskProviders(next);
    const lang = String(next.locale || '').startsWith('en') ? 'en' : 'zh';
    return { kind: 'settings', object: 'ruyi', changes: keys.map(key => ({ key, help: stewardConfigHelpFor(key, lang), before: before[key], value: after[key], ...stewardSettingScope(key) })) };
  }
  async function stewardImplConfigGet(args, ctx, config) {
    if (args.privacy === true) return PrivacyCore.configHooks.stewardPrivacy({ op: 'inspect' }, { sessionId: ctx.session?.id });
    const masked = maskProviders(config);
    // 第二轮工具走查(F11):maskProviders 是给设置页回显用的 —— 外部 MCP 的 env / headers 值掩成「••••<末 4 位>」,
    // 那 4 位是给用户认「是不是我填的那把」的。管家这条面不需要认,steward_providers 刻意只给 hasKey 布尔
    // 正是因为掩码串会暴露长度与前缀形状;这里同一个口径:只留掩码前缀,末位字符一个都不给(值非空才有前缀,空值仍是空串)。
    if (Array.isArray(masked.externalMcpServers)) {
      const bare = valueMap => {
        if (!valueMap || typeof valueMap !== 'object' || Array.isArray(valueMap)) return valueMap;
        const out = {};
        for (const [name, value] of Object.entries(valueMap)) out[name] = (typeof value === 'string' && value.startsWith(KEY_MASK_PREFIX)) ? KEY_MASK_PREFIX : value;
        return out;
      };
      masked.externalMcpServers = masked.externalMcpServers.map(entry => (entry && typeof entry === 'object')
        ? { ...entry, ...(entry.env ? { env: bare(entry.env) } : {}), ...(entry.headers ? { headers: bare(entry.headers) } : {}) } : entry);
    }
    const requested = Array.isArray(args.keys)
      ? args.keys.map(k => String(k || '').trim()).filter(Boolean).slice(0, 64)
      : Object.keys(masked);
    const values = {};
    const tiers = {};
    const help = {};
    const omitted = [];
    // 132b(53 号文 §2.4):每个可读键随值回一句人话(单位、范围、改了会怎样)—— 放开一百多个运行参数之后,
    // 模型得知道 turnIdleTimeoutMs 是「回合多久没动静算卡住」才改得对。语言跟界面语言走。
    const lang = String(config.locale || '').toLowerCase().startsWith('en') ? 'en' : 'zh';
    for (const key of requested) {
      const tier = stewardConfigTierFor(key);
      if (tier === 'forbidden') { omitted.push(key); continue; }
      if (!Object.prototype.hasOwnProperty.call(masked, key)) { omitted.push(key); continue; }
      values[key] = masked[key];
      tiers[key] = tier;
      const line = stewardConfigHelpFor(key, lang);
      if (line) help[key] = line;
    }
    return { ok: true, values, tiers, help, omitted, settings: Object.fromEntries(Object.keys(values).map(key => [key, stewardSettingScope(key)])) };
  }

  // 23) steward_config_set —— 整份原子:任一键 forbidden 就整份拒绝(零写入),任一键 confirm 且用户
  //     没亲手按就整份 propose_required。不做「能写的写、不能写的跳过」—— 半份生效的配置是最难解释
  //     的那种状态,用户按下按钮时看到的也必须是他刚才看到的那一整份。
  async function stewardImplConfigSet(args, ctx, config) {
    if (args.privacy != null) {
      // The narrow privacy operation does not grant generic access to forbidden
      // config, key material, recovery/export, or arbitrary patch keys.
      if (args.patch == null || typeof args.patch !== 'object' || Array.isArray(args.patch) || Object.keys(args.patch).length || args.undo || args.expected || (args.scope && args.scope !== 'application') || args.sessionId) return stewardFail('invalid_request', 'privacy operations require an empty patch and application scope');
      if (!args.privacy || typeof args.privacy !== 'object' || Array.isArray(args.privacy)) return stewardFail('invalid_request', 'privacy must be an operation object');
      const allowed = new Set(['op', 'expectedRuleVersion', 'mode', 'technical', 'upsert', 'remove', 'tests', 'sourceRef']);
      if (Object.keys(args.privacy).some(key => !allowed.has(key)) || !['preview', 'update'].includes(args.privacy.op)) return stewardFail('invalid_request', 'unsupported privacy operation');
      if (args.privacy.op === 'update') {
        // Only this local user's current message can authorize an update, never a
        // prior user quote, a delegated task, an inbox event or tool/web contents.
        const source = args.privacy.sourceRef;
        if (ctx.trigger !== 'user' || !source || source.sessionId !== ctx.session?.id || source.turnSeq !== ctx.session?.turnSeq) return stewardFail('source_not_user', 'privacy updates require the current local user message');
        const own = await stewardSourceUserTexts(source);
        if (!own) return stewardFail('source_not_user', 'external content cannot authorize privacy changes');
        const quoted = stewardQuoteInSource(source.quote, own);
        if (!quoted.ok) return stewardFail(quoted.code, quoted.message);
      }
      try { return await PrivacyCore.configHooks.stewardPrivacy(args.privacy, { sessionId: ctx.session?.id, turnSeq: ctx.session?.turnSeq }); }
      catch (error) { return stewardFail(/^(?:privacy|credential_vault)\.[a-z_]+$/.test(error.code || '') ? error.code : 'privacy.request_failed', '隐私规则未保存；检查操作、规则版本和试验结果后再继续。'); }
    }
    // 配置工具没有线程写权限。明确的线程意图只能导航到那一条的既有模型/权限入口。
    if (args.scope === 'thread' || args.sessionId) {
      return stewardFail('scope_requires_thread', '仅修改这条任务请打开该任务顶部的模型/权限菜单；不要改全局默认。模型从下一回合使用，当前执行不切换。', { sessionId: safeSessionId(args.sessionId) || '', entry: 'thread_settings' });
    }
    const rawPatch = (args.patch && typeof args.patch === 'object' && !Array.isArray(args.patch)) ? args.patch : null;
    if (!rawPatch) return stewardFail('invalid_request', 'patch must be an object of {key: value}');
    const patch = { ...rawPatch };   // 本地副本:下面要往里塞一个请求级信号(confirm),不该改模型给的对象
    const keys = Object.keys(patch);
    if (!keys.length) return stewardFail('invalid_request', 'patch is empty');
    if (keys.length > 32) return stewardFail('invalid_request', 'patch carries too many keys (max 32)');
    if (args.scope === 'new_threads' && keys.some(key => stewardSettingScope(key).scope !== 'new_threads')) return stewardFail('invalid_request', 'new_threads scope only accepts new-thread defaults');
    const expected = args.expected;
    if (expected != null && (typeof expected !== 'object' || Array.isArray(expected) || Object.keys(expected).length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(expected, key)))) return stewardFail('invalid_request', 'expected must contain exactly the patch keys');
    // 撤销入口可能从导入的旧历史渲染，不能靠客户端伪造的 action 绕过 confirm 分档。
    if (args.undo === true && (!expected || keys.some(key => stewardConfigTierFor(key) !== 'free'))) return stewardFail('steward.forbidden', 'receipt undo only accepts free settings with expected current values');
    const targetDefaultProvider = patch.activeProvider ?? config.activeProvider;
    if (Object.prototype.hasOwnProperty.call(patch, 'model') && targetDefaultProvider && targetDefaultProvider !== 'claude-cli') return stewardFail('invalid_request', 'model 是命令行引擎的默认模型。当前使用服务商时，请在模型菜单选择模型并显式设为新任务默认，不能声称改 model 就切换了服务商模型。');

    const forbidden = keys.filter(k => stewardConfigTierFor(k) === 'forbidden');
    if (forbidden.length) {
      return stewardFail('steward.forbidden', `these keys can never be changed through the steward: ${forbidden.join(', ')}`, { keys: forbidden });
    }
    // 116-3 P2-12(§8.6):把全局默认权限切到「全自动」是一条【专门】要求二次确认的动作,不是任意
    // confirm 键共用的通用按钮语义。判定与错误口径与 13d 的线程级 PATCH、06k 的 applyConfigPatch 共用
    // 同一张 PERMISSION_MODES_REQUIRING_CONFIRM 与同一个 `permission.confirm_required` 码。
    // 外层信封仍是 propose_required —— 13h 只对这个码做「降级成一个按钮」,换成别的码用户就再也
    // 按不到那个按钮了;专门口径放在 reason 与人话里(界面按 reason 取 §8.6 那五条文案)。
    // 只读一次 ctx.userPressed:06i 的契约与 steward-tools.static ⑦ 把「13g 里读它的地方」钉成两处
    //(config_set / skill_toggle 各一处),下面两道门共用这一个局部量。
    const pressed = ctx.userPressed === true;
    if (Object.prototype.hasOwnProperty.call(patch, 'permissionMode') && !pressed) {
      const requested = patch.permissionMode == null ? '' : String(patch.permissionMode);
      if (PERMISSION_MODES_REQUIRING_CONFIRM.includes(requested)) {
        return stewardFail('propose_required',
          `把【新线程的默认权限】切到「${stewardPermissionLabel(requested)}」要你亲手确认:那之后线程可以在你不在的时候改文件、跑命令、装东西、联网发东西。把它作为提议交给用户按,不要重试`,
          { reason: 'permission.confirm_required', keys: ['permissionMode'], permissionMode: requested });
      }
    }
    const confirmKeys = keys.filter(k => stewardConfigTierFor(k) === 'confirm');
    if (confirmKeys.length && !pressed) {
      // 13h 既有的降级路径会把 propose_required 变成一个按钮;用户按下那个按钮走 POST /api/steward/act,
      // 只有那条路径会置 ctx.userPressed = true(06i 的契约注释里写死了唯一来源)。
      return stewardFail('propose_required', `changing ${confirmKeys.join(', ')} needs the user to press the button`, { reason: 'confirm_required', keys: confirmKeys });
    }

    // 校验整份 patch 走【与 POST /api/config 同一条】normalize/sanitize:先合进当前配置跑一遍
    // normalizeConfig,再逐键比对 —— 被 sanitize 清洗掉(非法值静默回落)的键当场拒绝,而不是写进去
    // 之后让用户在设置页里发现「我改的没生效」。
    // 107-S0b:steward_config_get 下发的 externalMcpServers 是掩码过的,管家原样回传很正常 —— 先按落盘路径
    // (applyConfigPatch → unmaskSecrets)同一条规则还原再探:sanitize 那道闸会清空残留掩码,拿原样 patch 比就会把
    // 「原样回传」误判成「没活过 sanitize」。
    // 107-S2:与 POST /api/config 同一道启动向量闸。providers／searchBackend／modelsApiKey 在 06i 的分档表里
    // 是 forbidden(上面 forbidden 那道门已经整份拒了),所以管家这条路能命中的只剩「远程 MCP 的 url 还带着
    // 脱敏形、又对不回真值」这一种;给它一句人话,免得掉进下面 sanitize 那条泛化的 invalid_request 里。
    const secretConflicts = maskedSecretConflicts(patch, config);
    if (secretConflicts.length) {
      return stewardFail('invalid_request', maskedSecretConflictMessage(secretConflicts), { keys: secretConflicts.map(c => c.id) });
    }
    const restoredPatch = unmaskSecrets(patch, config);
    const probe = normalizeConfig({ ...config, ...restoredPatch }).config;
    const rejected = keys.filter(k => JSON.stringify(probe[k]) !== JSON.stringify(restoredPatch[k]));
    if (rejected.length) {
      return stewardFail('invalid_request', `these values did not survive config sanitize (illegal value or out of range): ${rejected.join(', ')}`, { keys: rejected });
    }
    // sanitize 只钳它认识的键;它原样放过的那些「自由键」再补两道最要命的:①类型要与出厂值同类(开关只收
    // true/false —— 修前 killOnDisconnect:'maybe' 原样落盘);②stewardProviderId 必须是已配置的服务商
    // (修前写一个不存在的 id,管家自己当场再也醒不过来,只能用户去设置页救)。
    const defaults = normalizeConfig(null).config;
    const typeMismatch = keys.filter(k => {
      const d = defaults[k];
      const v = restoredPatch[k];
      if (typeof d === 'boolean') return typeof v !== 'boolean';
      if (typeof d === 'number') return typeof v !== 'number' || !Number.isFinite(v);
      if (typeof d === 'string') return typeof v !== 'string';
      if (Array.isArray(d)) return !Array.isArray(v);
      return false;
    });
    if (typeMismatch.length) {
      const expect = typeMismatch.map(k => `${k}: ${Array.isArray(defaults[k]) ? 'array' : typeof defaults[k]}`).join(', ');
      return stewardFail('invalid_request', `these values have the wrong type (expected ${expect})`, { keys: typeMismatch });
    }
    if (Object.prototype.hasOwnProperty.call(restoredPatch, 'stewardProviderId') && String(restoredPatch.stewardProviderId || '')) {
      const ids = (Array.isArray(config.providers) ? config.providers : []).map(p => String((p && p.id) || ''));
      if (!ids.includes(String(restoredPatch.stewardProviderId))) {
        return stewardFail('invalid_request', `stewardProviderId must be one of the configured providers (${ids.filter(Boolean).join(', ') || 'none'}), or "" to follow the active provider`, { keys: ['stewardProviderId'] });
      }
    }
    if (restoredPatch.activeProvider && restoredPatch.activeProvider !== 'claude-cli' && !(config.providers || []).some(provider => provider.id === restoredPatch.activeProvider)) return stewardFail('invalid_request', 'activeProvider must be a configured provider');

    // 107-S0b:before／applied 会落进决策日志(磁盘、GET /api/steward/decisions、steward_audit_tail)并回给模型 ——
    // 与 steward_config_get 同一个掩码,修前改 externalMcpServers 一次就把全部连接器密钥明文写进这三处。
    // 落盘走与 POST /api/config 同一个 applyConfigPatch:116h 的 arbiterRefresh、CLI settings 同步、
    // MCP 同步全在那条路径上,管家另开一条就会静默漏掉它们。
    // 116-3 B1:applyConfigPatch 顶部新加了「切全局默认权限到全自动须 confirm:true」的服务端门。
    // 走到这一行时 confirm 档的判定已经过了(permissionMode 本来就在 STEWARD_CONFIG_TIER_CONFIRM 里,
    // 所以想改它必须 ctx.userPressed === true = 用户在界面上亲手按下了那个按钮),这个事实如实带过去。
    // 它是请求级信号不是配置键:applyConfigPatch 判完就把它剥掉,绝不会进 config.json;放在
    // keys/probe/before 三处算完【之后】才塞,免得它被当成一个待写的配置键。
    patch.confirm = true;
    let saved;
    try { saved = await ConfigPatchHooks.applyConfigPatch(patch, { capture: true, expected }); }
    catch (error) { if (error && error.code === 'config.conflict') return stewardFail('config.conflict', error.message); throw error; }
    const next = saved.config;
    const before = Object.fromEntries(keys.map(key => [key, maskProviders(saved.previous)[key]]));
    const maskedNext = maskProviders(next);
    const applied = {};
    for (const key of keys) applied[key] = maskedNext[key];
    // undoRef 内联在决策日志行里({kind:'config', before:{key:oldValue}}),不新增任何持久化面。
    // 只有 free 标量提供一键撤销，其他值仍可从设置页查看；不把连接器/秘密配置复制进撤销按钮。
    const canUndo = keys.every(key => stewardConfigTierFor(key) === 'free' && ['string', 'number', 'boolean'].includes(typeof before[key]) && ['string', 'number', 'boolean'].includes(typeof applied[key])) && keys.some(key => JSON.stringify(before[key]) !== JSON.stringify(applied[key]));
    const receipt = stewardSettingsReceipt(keys, saved.previous, next);
    const undoRef = { kind: 'config', before, after: applied, receipt, ...(canUndo ? { action: { tool: 'steward_config_set', args: { patch: before, expected: applied, scope: 'application', undo: true } } } : {}) };
    stewardAppendDecision({
      tool: 'steward_config_set',
      args: { keys, confirmed: confirmKeys.length > 0 },
      targetSessionId: '',
      permissionMode: '',
      mayAct: confirmKeys.length ? 'user' : 'auto',
      undoRef,
      basis: stewardBasisOf(args),
    });
    return { ok: true, applied, receipt, tiers: Object.fromEntries(keys.map(k => [k, stewardConfigTierFor(k)])), undoRef };
  }

  return {
    stewardImplConfigGet, stewardImplConfigSet,
  };
}

module.exports = { createStewardSettingsTools };
