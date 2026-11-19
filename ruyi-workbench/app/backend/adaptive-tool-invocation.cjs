'use strict';

function createAdaptiveToolInvocation({
  DesktopExecutionHooks, loadSession, readConfig, catalog, dispatch, bridge, policy,
}) {
  const { adaptiveCatalogForMcp, nativeToolsAcceptingArgKeys, toolArgsSkeleton } = catalog;
  const { isControlPlaneToolName, suggestToolNames, toolCall, toolFailureResult } = dispatch;
  const {
    bridgedOfficeScriptGate, bridgedReadPathGate, bridgedServerUnavailableMessage, bridgedToolTier,
    bridgedWriteRelativePathArg, getBridgedClient, journalBridgedWrite, resolveBridge,
  } = bridge;
  const {
    TOOL_TIER_RANK, isStewardToolName, policyDesktopOverrideFor, runtimeToolRequirementsMet,
    toolDisabledByPolicy, toolDisabledResult,
  } = policy;

  // 未知档一律按 exec 算(与 nativeToolTier 的 unknown → exec 同口径);代理档本身只会是 read/edit/exec。
  function toolInvokeTierCovers(proxyTier, targetTier) {
    const rank = t => (Object.prototype.hasOwnProperty.call(TOOL_TIER_RANK, t) ? TOOL_TIER_RANK[t] : TOOL_TIER_RANK.exec);
    return rank(proxyTier) >= rank(targetTier);
  }
  // 代理漏写目标名({arguments:{query:'…'}} 这种,真机 4 次)时的错误:修前只回「missing required 'name'」,模型照字面把 name
  // 塞进 arguments 里,再撞同一句(真机连撞 4 次)。这里给出【用它自己这份参数】拼好的正统形状,外加按参数键猜的候选目标
  // (只做提示,不替它执行 —— 猜错一个写/执行工具代价太大)。args 已过 normalizeToolInvokeArgs;有 name 时返回 null。
  function toolInvokeMissingNameResult(proxyName, args) {
    if (typeof args.name === 'string' && args.name.trim()) return null;
    const proxyTier = proxyName.slice('tool_invoke_'.length);
    const given = (args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments)) ? args.arguments : {};
    const keys = Object.keys(given);
    const didYouMean = nativeToolsAcceptingArgKeys(keys)
      .filter(c => !isControlPlaneToolName(c.name) && !isStewardToolName(c.name) && toolInvokeTierCovers(proxyTier, c.tier))
      .sort((a, b) => (b.tier === proxyTier) - (a.tier === proxyTier) || b.required - a.required || a.name.localeCompare(b.name))
      .slice(0, 3).map(c => c.name);
    const shown = {};   // 示例里只回显键和截短的值:参数可能是十几 KB 的文件内容
    for (const k of keys.slice(0, 6)) {
      const v = given[k];
      shown[k] = typeof v === 'string' ? (v.length > 40 ? v.slice(0, 40) + '…' : v) : (v && typeof v === 'object' ? '…' : v);
    }
    // 示例里的名字只在候选唯一时填:{query} 同时配得上 web_search / docs_search,填第一个会把模型带去错的工具。
    const example = { name: didYouMean.length === 1 ? didYouMean[0] : '<exact tool name from tool_search>', arguments: shown };
    return {
      ok: false, code: 'invalid-arguments', tool: proxyName,
      error: `${proxyName}: missing required 'name' — the target tool's exact name goes at the TOP level next to 'arguments', not inside it. Correct shape: ${JSON.stringify(example)}`,
      expected: { name: 'string', arguments: 'object' }, example,
      ...(didYouMean.length ? { didYouMean } : {}),
      hint: `call ${proxyName} again with {"name": "<tool>", "arguments": {...}}${didYouMean.length ? `; tools at or below ${proxyTier} tier that take these arguments: ${didYouMean.join(', ')}` : ''}`,
    };
  }

  async function invokeAdaptiveMcpTool(proxyTier, targetName, targetArgs, ctx) {
    // 控制面工具(含内部的 permission_prompt、tool_load)不能经代理调:先于目录查找判,给明确的拒绝而不是「tool not found」。
    // 注意作用面:模型服务商回合里,代理到 list_tools / tool_search / tool_load / todo_write / mission_update / 代理工具族的调用
    // 在 09 入批处就被 unwrapProxiedControlCall 【有意】解开成直调(它们要活的回合闭包,经这里会是静默空操作),到不了这一行;
    // 这道闸拦的是 MCP / CLI 路径,以及没被解开的 permission_prompt 与 tool_invoke_* 自指(壳还原最多剥两层,剩下的在这里拒)。
    if (isControlPlaneToolName(targetName)) return { ok: false, error: 'control-plane tools cannot be invoked through a proxy' };
    const config = await readConfig();
    const desktopOverride = await policyDesktopOverrideFor(ctx);
    const { bridged, catalog, runtime } = await adaptiveCatalogForMcp(config, { desktopOverride });
    const runtimeRequirement = runtimeToolRequirementsMet(targetName, runtime);
    if (!runtimeRequirement.met) return { ok: false, code: runtimeRequirement.code || runtime.capabilities['process.supervisor'].code || 'runtime-unavailable', error: runtimeRequirement.reason };
    // 2026-10 能力总闸补桥接面:内置桌面 MCP 里被设置关掉的目标在【目录查找之前】拒,回与原生一致的 tool-disabled ——
    // 目录里已经没有它(11 adaptiveCatalogForMcp 滤掉了),先查目录只会得到一句误导的 unknown-tool。判据与 09 / 08 同一个
    // toolDisabledByPolicy;配置优先用回合 ctx 里那份(主循环),MCP 子进程里没有就用盘上的。原生与桥接目标在查目录前统一判。
    const policyBridge = resolveBridge(bridged.route, targetName);
    const off = toolDisabledByPolicy(targetName, (ctx && ctx.config) || config, desktopOverride, policyBridge);
    if (off) return toolDisabledResult(targetName, off);
    const item = catalog.find(x => x.name === targetName);
    if (!item) {
      const didYouMean = suggestToolNames(targetName, catalog.map(x => x.name).filter(n => !isControlPlaneToolName(n)));
      return { ok: false, code: 'unknown-tool', error: `tool not found: ${targetName}. Call tool_search first.${didYouMean.length ? ` Did you mean: ${didYouMean.join(', ')}?` : ''}`, didYouMean, hint: 'use tool_search {query} to find the exact tool name and its tier' };
    }
    const bridge = resolveBridge(bridged.route, targetName);
    // 审计 A③:桥接目标的档按【本次入参】判(get_clipboard_image 带 save_path 是写,目录里无参的档是 read)——
    // 目录档与入参档不一致时以入参档为准,否则带落盘参数的这一次既过不了 _read(抬档)也过不了 _edit(目录说 read)。
    // 2026-10:代理档【不低于】目标档就放行 —— 权限闸按代理档判,用 edit/exec 档的代理调 read 工具只会多问、不会少问;
    // 只拒「低档代理调高档目标」(read 代理调 file_write 是越权,tool-loading e2e 钉着)。修前要求严格相等,
    // tool_invoke_edit{file_read} 这种无害的高报被拒,模型白跑一轮。
    if (!bridge && !toolInvokeTierCovers(proxyTier, item.tier)) return { ok: false, code: 'tier-mismatch', error: `risk tier mismatch: ${targetName} is '${item.tier}', higher than '${proxyTier}'`, hint: `call tool_invoke_${item.tier} for this tool` };
    if (bridge) {  // B1:resolveBridge 后强制重校 tier(不依赖 catalog 单一来源,防 drop-in/override 声明与实际不符)
      const actualTier = bridgedToolTier(bridge.toolName, config, targetArgs || {});
      if (!toolInvokeTierCovers(proxyTier, actualTier)) return { ok: false, code: 'tier-mismatch', error: `tier mismatch (bridged recheck): ${bridge.toolName} is '${actualTier}' for these arguments, higher than '${proxyTier}'`, hint: `call tool_invoke_${actualTier} for this tool with these arguments` };
    }
    const targetSchema = item.tool && item.tool.function ? item.tool.function.parameters : null;
    // 审计 N1:原生目标必须带着 ctx(session/turnSeq/config/workingDir/signal)进 toolCall —— 修前 ctx=null:写文件没有检查点
    // (checkpointWarn: no_session_context)、根目录回落数据目录默认工作区、steer/stop 的中止信号到不了 script_run。
    // MCP 子进程里 ctx 本就为空(按 WCW_SESSION_ID 兜底,见 journalSessionCtx),行为不变。
    if (!bridge) {
      try { return withToolArgsGuide(await toolCall(targetName, targetArgs || {}, ctx || null), targetSchema, false); }
      catch (e) { return toolFailureResult(e); }
    }
    // 2026-10:桥接目标在发给它自己的服务之前,先在本地对一遍【必填】(只查缺没缺,不改值、不判类型 —— 类型 / 取值留给服务端
    // 自己的校验,免得我们这套子集校验误伤)。缺了直接退回并递上参数骨架,省一次进程往返,也不会带着残参数去动桌面。
    const missingArgs = toolArgsMissingRequired(targetSchema, targetArgs);
    if (missingArgs.length) {
      return withToolArgsGuide({ ok: false, code: 'invalid-arguments', tool: targetName, error: `${targetName}: missing required ${missingArgs.map(k => `'${k}'`).join(', ')}` }, targetSchema, true);
    }
    const client = await getBridgedClient(bridge.serverId, config); // 47b:死/缺自动重连(超时杀后自愈)
    if (!client) return { ok: false, error: bridgedServerUnavailableMessage(bridge.serverId) };
    const gateRefusal = bridgedOfficeScriptGate(targetName, targetArgs || {});
    if (gateRefusal) return gateRefusal;
    const relArg = bridgedWriteRelativePathArg(targetName, targetArgs || {});
    if (relArg) return { ok: false, error: `desktop/document writes require an absolute path; '${relArg}' is relative` };
    try {
      const sid = process.env.WCW_SESSION_ID || '';
      const sidSession = sid ? await loadSession(sid).catch(() => null) : null;
      const session = (ctx && ctx.session) || sidSession;
      // 审计 A②:桥接读文件过读边界(与 09/08 两个分发点同一个函数)。MCP 子进程里 ctx 为空 → 按 WCW_SESSION_ID 装会话。
      const readRefusal = await bridgedReadPathGate(targetName, targetArgs || {}, { ...(ctx || {}), session, config: (ctx && ctx.config) || config });
      if (readRefusal) return readRefusal;
      // Provider proxies carry their live session/turn in ctx; CLI MCP children use the loaded fallback.
      if (session) await journalBridgedWrite(targetName, targetArgs || {}, session, config, ctx || { sessionId: sid, turnSeq: sidSession.turnSeq });
      // Provider audit observes only the local MCP invocation attempt. Never treat this as
      // acknowledgement from ACC/the native helper. Local policy/argument refusals never reach it.
      if (typeof ctx?.onBridgedInvocationAttempt === 'function') ctx.onBridgedInvocationAttempt();
      const res = await DesktopExecutionHooks.invoke(client, bridge.toolName, targetArgs || {}, ctx && ctx.signal ? { signal: ctx.signal } : {}, ctx?.desktopExecution);   // 审计 N1:中止信号一路带到桥接目标
      return withToolArgsGuide(res, targetSchema, true);
    } catch (e) {
      return withToolArgsGuide({ ok: false, error: (e && e.message) || String(e) }, targetSchema, true);
    }
  }

  // 2026-10 代叫「叫得对」:代叫不带完整说明书,第一次可能叫错 —— 叫错时(而且只在叫错时)把这个工具的完整参数骨架
  // (07 toolArgsSkeleton 'full')随错误递回(argsGuide),模型下一次照着改。只在出错时花这点 token,不破坏「说明书不进门」。
  // 判「参数错」:我们自己的 invalid-arguments 信封;桥接目标(bridged=true)且结果【没有自带 code】时,另认服务端参数校验
  // 的标志性报错 —— pydantic「N validation error(s) for XArguments」/「Field required」/「Input should be」、MCP JSON-RPC
  // 「Invalid params」(-32602)、「Invalid arguments for tool」。只认这几句锚定的说法:裸的 missing required / invalid
  // argument 会撞上业务报错(「Sheet 缺少 required 列」、Windows「[Errno 22] Invalid argument」)。自带 code 的结果
  // (mcp-child-exited 之类、数字退出码)一律不动 —— 那个 code 有它自己的意思,不能被一段 stderr 改写成「参数错」。
  // 原生工具的报错各有自己的意思(命令的 stderr、网页的 404),不按文字猜。正确的调用、其它失败一律原样返回(同一引用)。
  // schema 压不成骨架(toolArgsSkeleton 回 '')时只校正 code、不递 argsGuide。
  const TOOL_ARGS_ERROR_TEXT = /\b\d+ validation errors? for \w+|\bfield required\b|\binput should be\b|\binvalid params\b|-32602\b|\binvalid arguments? for tool\b/i;
  function withToolArgsGuide(result, schema, bridged) {
    if (!result || typeof result !== 'object' || Array.isArray(result) || result.ok !== false || result.argsGuide !== undefined) return result;
    const noOwnCode = result.code === undefined || result.code === null;
    const isArgsError = result.code === 'invalid-arguments'
      || (bridged && noOwnCode && TOOL_ARGS_ERROR_TEXT.test([result.error, result.text, result.message].filter(v => typeof v === 'string').join(' ')));
    if (!isArgsError) return result;
    const guide = toolArgsSkeleton(schema, 'full');
    return { ...result, code: 'invalid-arguments', ...(guide ? { argsGuide: guide } : {}) };
  }
  // schema 声明的必填里,这次入参缺了哪几个。只算「值为 undefined」且服务端也不会替它补的:属性带 default、或允许 null
  // (type 含 'null' / anyOf 里有 null / nullable:true)的不算缺 —— 有些 schema 把所有键都列进 required、可选的靠
  // default / 可空表达,本地按字面判会误拒一条服务端照收的调用。入参不是对象:按空对象算。
  function toolArgPropertyLenient(p) {
    if (!p || typeof p !== 'object') return false;
    if (Object.prototype.hasOwnProperty.call(p, 'default') || p.nullable === true) return true;
    if (p.type === 'null' || (Array.isArray(p.type) && p.type.includes('null'))) return true;
    const alts = Array.isArray(p.anyOf) ? p.anyOf : (Array.isArray(p.oneOf) ? p.oneOf : []);
    return alts.some(a => a && typeof a === 'object' && a.type === 'null');
  }
  function toolArgsMissingRequired(schema, args) {
    const props = (schema && schema.properties && typeof schema.properties === 'object') ? schema.properties : {};
    const required = Array.isArray(schema && schema.required) ? schema.required : [];
    const obj = (args && typeof args === 'object' && !Array.isArray(args)) ? args : {};
    return required.filter(k => typeof k === 'string' && Object.prototype.hasOwnProperty.call(props, k)
      && obj[k] === undefined && !toolArgPropertyLenient(props[k]));
  }

  return { invokeAdaptiveMcpTool, toolArgsMissingRequired, toolInvokeMissingNameResult, withToolArgsGuide };
}

module.exports = { createAdaptiveToolInvocation };
