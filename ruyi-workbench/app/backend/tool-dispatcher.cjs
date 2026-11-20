'use strict';

// Tool registration and execution gates. Host supplies policy and lifecycle ports.
function createToolDispatcher({ groups, levenshtein, isStewardToolName, nativeToolSchema, DesktopExecutionHooks, PrivacyGateway, readConfig, NATIVE_COMMAND_TOOL_NAMES, NATIVE_DESKTOP_TOOL_NAMES, policySessionFor, nativeToolDisabledByPolicy, sessionDesktopToolsOf, toolDisabledResult, normalizeToolInvokeArgs, toolInvokeMissingNameResult, normalizeMetaToolArgs, ProcessRuntime, makeId, FileTextIo }) {
  const TOOL_HANDLERS = Object.create(null);
  for (const group of groups) {
    for (const [name, entry] of Object.entries(group)) {
      if (Object.hasOwn(TOOL_HANDLERS, name)) throw new Error('TOOL_HANDLERS: duplicate tool: ' + name);
      TOOL_HANDLERS[name] = entry;
    }
  }
  Object.freeze(TOOL_HANDLERS);
// ── 审计 N5:分发前的两道公共闸(未知名 did-you-mean / 入参按工具自己的 JSON schema 校验) ─────────────────────
// 校验只认 13f schema 实际用到的子集:type(object/array/string/number/integer/boolean)、required、enum、items、minLength。
// 标量宽松强转(handler 本来就 String()/Number() 它们):string 收 string/number/boolean,number/integer 收数字与可解析的
// 数字串,boolean 收布尔与 'true'/'false'。目的只是把「缺必填 / 类型明显不对」变成点名字段的可行动错误,不是收紧协议。
// 未知键不拒(HTTP /api/tools 路由把整个 body 当 args,里面带 sessionId/turnSeq)。
function isControlPlaneToolName(n) {
  return n === 'permission_prompt' || n === 'list_tools' || n === 'tool_search' || n === 'tool_load' || String(n).startsWith('tool_invoke_');
}
const TOOL_NAME_ALIASES = {
  list_directory: 'file_list', list_dir: 'file_list', ls: 'file_list', read_file: 'file_read', cat: 'file_read',
  write_file: 'file_write', create_file: 'file_write', edit_file: 'file_edit', replace_in_file: 'file_edit',
  delete_file: 'file_delete', grep: 'file_search', search_files: 'file_search', find_files: 'glob',
  run_command: 'shell_run', shell: 'shell_run', bash: 'shell_run', run_script: 'script_run',
  // 61-A6:取网页正文是 web_fetch 的事(http_request 是原始 HTTP、exec 档);web_fetch 本身缺席时才退到 http_request。
  fetch: 'web_fetch', web_fetch: 'http_request', screenshot: 'desktop_screenshot',
};
function suggestToolNames(name, candidates, limit = 3) {
  const target = String(name || '').toLowerCase();
  const pool = [...new Set((Array.isArray(candidates) ? candidates : []).map(String))];
  if (!target || !pool.length) return [];
  const tokens = str => new Set(str.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const tt = tokens(target);
  const out = [];
  const alias = TOOL_NAME_ALIASES[target];
  if (alias && pool.includes(alias)) out.push(alias);
  const scored = pool.filter(n => !out.includes(n)).map(n => {
    const lower = n.toLowerCase();
    let shared = 0;
    for (const t of tokens(lower)) if (tt.has(t)) shared += 1;
    const contains = lower.includes(target) || target.includes(lower) ? 1 : 0;
    // 编辑距离为主;共享 token(list_directory ↔ file_list 共享 list)与互相包含各抵掉几步,让语义近的名字排到前面。
    return { n, score: levenshtein(target, lower, 80) - 3 * shared - 4 * contains };
  });
  scored.sort((a, b) => a.score - b.score || a.n.localeCompare(b.n));
  for (const x of scored) { if (out.length >= limit) break; out.push(x.n); }
  return out.slice(0, limit);
}
function unknownToolError(name, offered) {
  const own = Object.keys(TOOL_HANDLERS).filter(n => !isControlPlaneToolName(n) && !isStewardToolName(n));
  const didYouMean = suggestToolNames(name, own.concat(Array.isArray(offered) ? offered : []));
  // message 保持 `Unknown tool: X`(tool-dispatch.e2e B1 逐字断言);建议走属性,由 toolFailureResult 摊进结果。
  const err = new Error(`Unknown tool: ${name}`);
  err.toolFailure = { code: 'unknown-tool', didYouMean, hint: 'use tool_search {query} to find tools by capability; only exact tool names can be called' };
  return err;
}
// catch 点统一把工具抛出的错误变成 {ok:false,...} 结果:普通 Error 只带 error 文本(与修前逐字一致),未知工具附 did-you-mean。
function toolFailureResult(e, offered) {
  const msg = (e && e.message) ? e.message : String(e);
  const tf = e && e.toolFailure;
  if (!tf) return { ok: false, error: msg };
  let didYouMean = tf.didYouMean || [];
  if (tf.code === 'unknown-tool' && Array.isArray(offered) && offered.length) {
    const m = /^Unknown tool: (.*)$/.exec(msg);
    if (m) didYouMean = suggestToolNames(m[1], offered.concat(didYouMean));
  }
  return { ok: false, code: tf.code, error: didYouMean.length ? `${msg}. Did you mean: ${didYouMean.join(', ')}?` : msg, didYouMean, hint: tf.hint };
}
function jsonSchemaTypeName(v) { return v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v; }
function jsonSchemaValueProblems(schema, value, at) {
  if (!schema || typeof schema !== 'object') return [];
  const t = schema.type;
  const here = at || 'value';
  if (Array.isArray(schema.enum) && schema.enum.length && !schema.enum.some(x => x === value || (typeof x === 'string' && typeof value !== 'object' && String(value) === x))) {
    return [`'${here}' must be one of ${schema.enum.map(x => JSON.stringify(x)).join(' | ')} (got ${JSON.stringify(value)})`];
  }
  if (t === 'string') {
    if (typeof value === 'string') return (schema.minLength > 0 && value.length < schema.minLength) ? [`'${here}' must not be empty (string)`] : [];
    return (typeof value === 'number' || typeof value === 'boolean') ? [] : [`'${here}' must be a string (got ${jsonSchemaTypeName(value)})`];
  }
  if (t === 'number' || t === 'integer') {
    const ok = (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)));
    return ok ? [] : [`'${here}' must be a ${t} (got ${typeof value === 'string' ? JSON.stringify(value) : jsonSchemaTypeName(value)})`];
  }
  if (t === 'boolean') {
    return (typeof value === 'boolean' || value === 'true' || value === 'false') ? [] : [`'${here}' must be a boolean (got ${typeof value === 'string' ? JSON.stringify(value) : jsonSchemaTypeName(value)})`];
  }
  if (t === 'array') {
    if (!Array.isArray(value)) return [`'${here}' must be an array (got ${jsonSchemaTypeName(value)})`];
    if (!schema.items) return [];
    const bad = [];
    for (let i = 0; i < value.length && bad.length < 3; i += 1) bad.push(...jsonSchemaValueProblems(schema.items, value[i], `${here}[${i}]`));
    return bad;
  }
  if (t === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return [`'${here}' must be an object (got ${jsonSchemaTypeName(value)})`];
    return jsonSchemaObjectProblems(schema, value, at);
  }
  return [];
}
function jsonSchemaObjectProblems(schema, obj, at) {
  const problems = [];
  const props = (schema && schema.properties) || {};
  const prefix = at ? `${at}.` : '';
  for (const key of Array.isArray(schema && schema.required) ? schema.required : []) {
    if (obj[key] === undefined || obj[key] === null) {
      const sub = props[key];
      problems.push(`missing required '${prefix}${key}'${sub && sub.type ? ` (${sub.type})` : ''}`);
    }
  }
  for (const key of Object.keys(props)) {
    if (obj[key] === undefined || obj[key] === null) continue;
    problems.push(...jsonSchemaValueProblems(props[key], obj[key], `${prefix}${key}`));
  }
  return problems;
}
// 宽进:校验之前把「语义明确、处理器本来就容忍」的写法规范成 schema 的正统值(就地改 args,处理器看到的是规范值)——
//   · 字符串枚举大小写不敏感('BASH' → 'bash');可选枚举字段传 '' 视为没传(处理器自带缺省);
//   · boolean 接受 0/1、'0'/'1' 与大小写不同的 'True'/'FALSE';
//   · 元素是字符串的数组接受逗号分隔的字符串('a, b' → ['a','b'])。
// 真正不合法的值(不在枚举里、乱字符串当布尔)原样留给 jsonSchemaValueProblems 报错并点名字段。
function jsonSchemaCoerceValue(schema, value) {
  if (!schema || typeof schema !== 'object' || value === undefined || value === null) return value;
  const t = schema.type;
  if (Array.isArray(schema.enum) && schema.enum.length && typeof value === 'string' && !schema.enum.includes(value)) {
    const lower = value.trim().toLowerCase();
    const hit = schema.enum.find(x => typeof x === 'string' && x.toLowerCase() === lower);
    if (hit !== undefined) return hit;
  }
  if (t === 'boolean') {
    if (value === 1 || value === '1') return true;
    if (value === 0 || value === '0') return false;
    if (typeof value === 'string') { const l = value.trim().toLowerCase(); if (l === 'true') return true; if (l === 'false') return false; }
    return value;
  }
  if (t === 'array') {
    if (typeof value === 'string' && schema.items && schema.items.type === 'string') return value.split(',').map(x => x.trim()).filter(Boolean);
    if (Array.isArray(value) && schema.items) for (let i = 0; i < value.length; i += 1) value[i] = jsonSchemaCoerceValue(schema.items, value[i]);
    return value;
  }
  if (t === 'object' && typeof value === 'object' && !Array.isArray(value)) { jsonSchemaCoerceObject(schema, value); return value; }
  return value;
}
// 少数可选枚举字段的处理器本就约定「不认识的值回落默认」(e2e 钉着,如 workbench_self_status 的 section → 'all')。
// 这些字段上的非法值在公共闸里直接去掉、交给处理器的默认,而不是拒绝;其余枚举(如 script_run.language)照旧拒绝 ——
// 不支持的脚本语言必须明确拒绝。
const LENIENT_ENUM_FALLBACK_FIELDS = Object.freeze({ workbench_self_status: Object.freeze(['section']) });
function jsonSchemaCoerceObject(schema, obj, lenientKeys) {
  const props = (schema && schema.properties) || {};
  const required = new Set(Array.isArray(schema && schema.required) ? schema.required : []);
  for (const key of Object.keys(props)) {
    if (obj[key] === undefined || obj[key] === null) continue;
    const sub = props[key];
    if (obj[key] === '' && Array.isArray(sub && sub.enum) && !required.has(key) && !sub.enum.includes('')) { delete obj[key]; continue; }
    obj[key] = jsonSchemaCoerceValue(sub, obj[key]);
    if (lenientKeys && lenientKeys.includes(key) && !required.has(key) && Array.isArray(sub && sub.enum) && !sub.enum.includes(obj[key])) delete obj[key];
  }
}
// 返回 null = 通过;否则是可直接回给模型的 {ok:false, code:'invalid-arguments', ...}。
function validateNativeToolArgs(name, args) {
  // 管家工具族自带逐字段校验与专属错误码(invalid_request / no_agent_run …,steward e2e 逐字钉着)—— 不在公共闸里二次判。
  if (isStewardToolName(name)) return null;
  const schema = nativeToolSchema(name);
  if (!schema) return null;
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, code: 'invalid-arguments', tool: name, error: `${name}: arguments must be a JSON object (got ${jsonSchemaTypeName(args)})`, hint: 'pass arguments as an object of named fields' };
  }
  jsonSchemaCoerceObject(schema, args, LENIENT_ENUM_FALLBACK_FIELDS[name]);
  const problems = jsonSchemaObjectProblems(schema, args, '');
  if (!problems.length) return null;
  const props = schema.properties || {};
  const expected = {};
  for (const k of Array.isArray(schema.required) ? schema.required : []) expected[k] = (props[k] && props[k].type) || 'any';
  return { ok: false, code: 'invalid-arguments', tool: name, error: `${name}: ${problems.join('; ')}`, expected, hint: `fix the argument(s) and call ${name} again; required fields: ${Object.keys(expected).join(', ') || '(none)'}` };
}

async function toolCall(name, args = {}, ctx = null) {
  const executionSessionId = ctx?.sessionId || process.env.WCW_SESSION_ID;
  if (DesktopExecutionHooks.enabled() && executionSessionId) await DesktopExecutionHooks.guard(executionSessionId);
  if (typeof PrivacyGateway !== 'undefined') {
    // MCP processes can outlive a settings change; consult persisted policy before every unscoped call.
    if (!PrivacyGateway.active() && typeof readConfig === 'function') PrivacyGateway.assertSupported((ctx && ctx.config) || await readConfig(), 'external-tool');
    PrivacyGateway.assertToolChannel();
  }
  const entry = Object.prototype.hasOwnProperty.call(TOOL_HANDLERS, name) ? TOOL_HANDLERS[name] : null;
  if (!entry) throw unknownToolError(name);
  // 审计 N4:设置里关掉的命令/桌面工具在【分发点】也拒绝(offer 面只是藏 schema;bypass/auto 下 gate 恒放行)。
  // ctx 带 config 的调用(主循环 / 子代理 / tool_invoke_* 转发)才判;MCP 子进程与 HTTP 回环不带 config,由 offer 面把关。
  // 不带 config 的调用面(MCP 子进程 / HTTP 回环)修前直接放行 —— allowCommandTools:false 时 script_run、shell_start
  // 经这条路照样跑得起来,与设置页「关掉后模型只能读写文件、不能跑命令」不符。现在没带就读一次盘上配置,同一判据。
  {
    let policyConfig = ctx && ctx.config ? ctx.config : null;
    if (!policyConfig && (NATIVE_COMMAND_TOOL_NAMES.has(name) || NATIVE_DESKTOP_TOOL_NAMES.has(name))) {
      try { policyConfig = await readConfig(); } catch { policyConfig = null; }
    }
    if (policyConfig) {
      const policySession = (ctx && ctx.session) || (NATIVE_DESKTOP_TOOL_NAMES.has(name) ? await policySessionFor(ctx) : null);
      const disabled = nativeToolDisabledByPolicy(name, policyConfig, policySession ? sessionDesktopToolsOf(policySession) : null);
      if (disabled) return toolDisabledResult(name, disabled);
    }
  }
  // 审计 N5:必填/类型校验(按工具自己的 13f schema)。修前 file_read {} 得到 EISDIR、file_search {} 命中 61 条垃圾。
  // 参数整个是 null / 非对象:统一回 invalid-arguments 信封。没有 13f schema 的工具(skill_read 等)修前在 handler 里
  // `args.id` 抛 TypeError;有 schema 的工具下面的校验本来就给同一句话。
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, code: 'invalid-arguments', tool: name, error: `${name}: arguments must be a JSON object (got ${jsonSchemaTypeName(args)})`, hint: 'pass arguments as an object of named fields' };
  }
  if (name.startsWith('tool_invoke_')) {
    args = normalizeToolInvokeArgs(args);   // 还原写歪的壳 / name 去空白 / arguments 给成 JSON 字符串时解析
    const missingName = toolInvokeMissingNameResult(name, args);
    if (missingName) return missingName;
  }
  args = normalizeMetaToolArgs(name, args);   // todo_write/mission_update:content/completed 等同义词先归一,再校验
  const invalid = validateNativeToolArgs(name, args);
  if (invalid) return invalid;
  try {
    return await ProcessRuntime.withOwner({
      toolName: name, sessionId: ctx?.sessionId || ctx?.session?.id || '',
      turnSeq: ctx?.turnSeq ?? ctx?.session?.turnSeq, toolCallId: ctx?.toolCallId || '', invocationId: makeId('process_call'),
    }, () => entry.handler(args, ctx));
  }
  catch (e) {
    if (e && e.searchExecutionFailure) return { ok: false, code: e.code, error: e.message,
      cleanupIncomplete: e.cleanupIncomplete, cleanupScope: e.cleanupScope };
    // 路径里混进 NUL(\0):Node 在 stat/open 上抛 ERR_INVALID_ARG_VALUE,修前是裸 TypeError 一路抛给模型。
    // 只认这一类(fsErrorEnvelope 给 bad_path),其余异常照旧向上抛。
    if (e && e.code === 'ERR_INVALID_ARG_VALUE') {
      const f = FileTextIo.fsErrorEnvelope(e, String((args && (args.path || args.from || args.src || args.dest || args.root || args.outputPath)) || ''));
      if (f && f.code === 'bad_path') return f;
    }
    throw e;
  }
}

  return { TOOL_HANDLERS, isControlPlaneToolName, suggestToolNames, unknownToolError, toolFailureResult, jsonSchemaTypeName, jsonSchemaValueProblems, jsonSchemaObjectProblems, jsonSchemaCoerceValue, jsonSchemaCoerceObject, validateNativeToolArgs, toolCall };
}

module.exports = { createToolDispatcher };
