'use strict';

const crypto = require('node:crypto');

const RUNTIME_TELEMETRY_KEY = crypto.randomBytes(32); // process-scoped HMAC key; raw queries/errors are never logged

function hashRuntimeToolEvidence(value) {
  return crypto.createHmac('sha256', RUNTIME_TELEMETRY_KEY).update(value).digest('hex').slice(0, 16);
}

// 20-F1 data gate: deterministic, read-only failure taxonomy. The caller may emit/log this result, but this
// function intentionally contains no retry or repair path. That keeps telemetry deployable before the local
// sample proves a bounded recovery loop is worth building.
//
// v2 is driven by real shadow shapes, not synthetic wording alone. Native process tools report failures through
// structured fields (`timedOut`, `interrupted`, `code`, `stderr`) while guards often use `hint`; v1 only read
// error/message/detail, which collapsed almost every real process failure into `unknown`. These fields are used
// in-memory for deterministic classification and the HMAC evidence fingerprint only. Raw stderr/hints are never
// returned or logged by this function.
//
// v3 (2026-10) closes the network/policy gap v2 left. A real-machine replay of 52 failures still had 28 (54%) in
// `unknown` because v2 never read the STRUCTURED envelope the tools actually emit: `failClass` (web_fetch /
// http_request / http_download / web_search: dns|connect|proxy|reset|tls|timeout|aborted|http|network…), a numeric
// `statusCode`, `blocked` (SSRF / redirect guard), `argsInvalid` (truncated model arguments), `disposition`
// (plan_refused / args_invalid) and identifier-shaped codes carried in `code` or — for steward tools — in `error`
// (`not_found`, `budget_exceeded`…). It also had one false positive: web_fetch's "网站拒绝了请求(HTTP 403,可能反爬)"
// matched /拒绝/ and became permission_denied/request_authority although no user grant can help (a remote refusal is
// remote_blocked). v3 reads those fields first and keeps the text rules as the fallback. Rules are anchored to exact
// tokens / numeric statuses / error-or-message text — never to stderr or hints — so unrelated output that merely
// mentions "blocked" or "captcha" is not reclassified. The mutating-tool safety branch below still runs before every
// other rule, and nothing here retries or repairs anything.
const RUNTIME_FAILURE_CLASSIFIER_VERSION = 'deterministic-v3';
// failClass values (11-native-tools classifyFetchError / httpGetGuarded / web_search) that describe a broken
// transport: the request may or may not have reached the remote end. A mutating tool is therefore
// side_effect_unknown; a read tool is transient. (`dns` and `tls` fail before any request byte is sent and are
// handled separately; `aborted` is a user/steer interrupt, not a fault.)
const RUNTIME_FAILCLASS_TRANSPORT = new Set(['reset', 'connect', 'proxy', 'timeout', 'network']);
// Exact code / error tokens (lower-case) emitted by the native, proxy and steward tools. Equality only, no substring.
const RUNTIME_CODE_INVALID_ARGUMENTS = new Set(['invalid-arguments', 'invalid_args', 'invalid_request', 'invalid_target', 'invalid_ref', 'bad_path', 'bad_pattern', 'tier-mismatch']);
const RUNTIME_CODE_NOT_FOUND = new Set(['not_found', 'not_in_artifacts']);
const RUNTIME_CODE_BUDGET = new Set(['budget_exceeded', 'quota_exceeded']);
function classifyRuntimeToolFailure(toolName, result, meta) {
  if (!result || typeof result !== 'object' || result.ok === true || (result.ok !== false && !result.error)) return null;
  const disposition = String(meta && meta.disposition || 'executed');
  const tier = String(meta && meta.tier || 'read');
  const code = String(result.code == null ? '' : result.code).trim();
  const text = [result.errorClass, code, result.statusCode, result.error, result.message, result.detail, result.hint, result.stderr]
    .map(value => String(value == null ? '' : value).slice(0, 4000)).join(' ').slice(0, 12000);
  // v3 structured signals. `primary` is the tool's own error wording only (never stderr/hint), used by the anchored
  // text rules; the steward tools put their identifier-shaped code in `error` (`{ok:false, error:'not_found', message}`).
  const primary = [result.error, result.message, result.detail].map(value => String(value == null ? '' : value).slice(0, 2000)).join(' ');
  const failClass = String(result.failClass == null ? '' : result.failClass).trim().toLowerCase().slice(0, 24);
  const statusNum = Number(result.statusCode);
  const httpStatus = Number.isInteger(statusNum) ? statusNum : 0;
  const errToken = typeof result.error === 'string' && /^[a-z][a-z0-9_-]{2,40}$/i.test(result.error.trim()) ? result.error.trim().toLowerCase() : '';
  const tokenIs = tokens => tokens.has(code.toLowerCase()) || tokens.has(errToken);
  const mutating = tier !== 'read';
  const timedOut = result.timedOut === true || /timeout|timed out|etimedout|连接.{0,6}超时|超时/i.test(text);
  const interrupted = result.interrupted === true || result.steerInterrupted === true || failClass === 'aborted' || /interrupted by user steer|用户插话中断|因用户.{0,8}中断/i.test(text);
  // `request error` / `response error` is the fallback Node socket error with an empty message (11-native-tools): a
  // connection-level failure whose cause the tool could not name.
  const bareSocketError = /^(?:request|response) error$/i.test(String(result.error == null ? '' : result.error).trim());
  const transportFailure = RUNTIME_FAILCLASS_TRANSPORT.has(failClass) || (failClass === 'dns' && /当前疑似离线/.test(text)) || bareSocketError
    || httpStatus === 408 || httpStatus === 500;   // 429/502/503/504 are already matched by the text rule below (v2)
  const transientTransport = timedOut || transportFailure || /econnreset|eai_again|econnrefused|enotfound|socket hang up|network error|connection (?:error|reset|refused|timeout)|remote host closed|\b429\b|\b50[234]\b|temporar|连接.{0,6}(重置|断开)|临时.{0,6}(错误|不可用)/i.test(text);
  const mutatingAmbiguity = transientTransport || interrupted || /operation aborted|effect unknown|outcome unknown|执行结果未知|副作用未知/i.test(text);
  const nonzeroExit = /^-?\d+$/.test(code) && Number(code) !== 0;
  // A process result (non-zero exit or stderr) is the program's own output: its text must not be mistaken for a
  // tool-level HTTP/ENOENT/captcha signal.
  const processResult = nonzeroExit || (typeof result.stderr === 'string' && result.stderr.trim() !== '');
  const urlShapeRejected = /URL 无法解析|仅允许 http\/https 协议|url must start with http/i.test(primary);
  const planRefused = disposition === 'plan_refused' || /计划模式.{0,8}请先提交|请先提交\s*PLAN\s*:/i.test(primary);
  const budgetExhausted = tokenIs(RUNTIME_CODE_BUDGET) || /read budget exhausted|quota exhausted for this/i.test(primary);
  const guardBlocked = (typeof result.blocked === 'string' && result.blocked.trim() !== '') || failClass === 'blocked';
  const remoteRefused = !processResult && ((httpStatus === 401 || httpStatus === 403 || httpStatus === 451) || failClass === 'tls'
    || (guardBlocked && !urlShapeRejected)
    || /网站拒绝了请求|反爬|人机验证|验证码|\bcaptcha\b|\bcloudflare\b|just a moment|are you (?:a )?(?:human|robot)|bot (?:detection|protection|challenge)/i.test(primary));
  const pageOrHostMissing = !processResult && (httpStatus === 404 || httpStatus === 410 || failClass === 'dns' || /\benoent\b|no such file or directory/i.test(text));
  let failureClass = 'unknown', recoverableHint = false, allowedRepair = 'diagnose_only';
  // A mutating call that timed out/lost transport/was interrupted may already have changed state. This safety
  // branch intentionally precedes every "repairable" text rule: never turn an ambiguous edit/exec into retry_once.
  if (mutating && (mutatingAmbiguity || disposition === 'steer_skipped')) {
    failureClass = 'side_effect_unknown'; allowedRepair = 'stop_for_effect_check';
  } else if (!mutating && transientTransport) {
    failureClass = 'transient_read'; recoverableHint = true; allowedRepair = 'retry_once';
  } else if (code === 'not-allowed' || /应用内部数据|已禁止文件工具访问|检测到脚本.{0,50}office|office.{0,40}工具层强制|请改用现成工具|use (?:a )?supported tool/i.test(text)) {
    failureClass = 'policy_blocked'; recoverableHint = true; allowedRepair = 'use_supported_tool';
  } else if (planRefused) {
    // Plan mode refuses every non-discovery tool until a `PLAN:` message is submitted: the way out is to plan, not to retry.
    failureClass = 'policy_blocked'; recoverableHint = true; allowedRepair = 'replan';
  } else if (budgetExhausted) {
    // Per-visit / per-turn read budgets and quotas say "answer from what you have instead of retrying": nothing to repair.
    failureClass = 'policy_blocked';
  } else if (remoteRefused) {
    // Must precede permission_denied: "网站拒绝了请求(HTTP 403)" contains 拒绝 but no user grant can help. 401/403/451,
    // anti-bot/captcha wording, TLS failure, and the SSRF / redirect guard are all "this source is unusable for us".
    failureClass = 'remote_blocked'; recoverableHint = true; allowedRepair = 'use_alternative_source';
  } else if (/permission|denied|拒绝|拒绝授权|无权限|not allowed|blocked by permission/i.test(text)) {
    failureClass = 'permission_denied'; allowedRepair = 'request_authority';
  } else if (/old[_ ]?text.{0,24}(not found|missing|匹配.{0,8}(?:0|不到)|未找到)|找不到.{0,16}old[_ ]?text|expected text.{0,16}not found/i.test(text) || code === 'ambiguous') {
    // `ambiguous` = file_edit's oldText matches several places: re-read and give a longer, unique anchor.
    failureClass = 'edit_conflict'; recoverableHint = true; allowedRepair = 'refresh_then_modify';
  } else if (result.argsInvalid === true || disposition === 'args_invalid' || tokenIs(RUNTIME_CODE_INVALID_ARGUMENTS) || urlShapeRejected
    || /参数不是完整的 JSON 对象|工具调用参数被截断|control-plane tools cannot be invoked through a proxy|risk tier mismatch|tier mismatch \(bridged recheck\)/i.test(primary)
    || /invalid.{0,20}(argument|parameter|input)|schema.{0,20}(fail|invalid)|required.{0,20}(property|field)|\b[a-z_][\w.-]*\s+is\s+required\b|参数.{0,12}(错误|无效|缺少)|缺少.{0,8}(参数|字段)|unexpected.{0,8}(argument|field)/i.test(text)) {
    failureClass = 'invalid_arguments'; recoverableHint = true; allowedRepair = 'modify_arguments';
  } else if (/unknown\s+(?:shell|session|resource)(?:id)?|(?:shell|session|resource).{0,20}(?:not found|missing|不存在|已结束)|未知\s*(?:shellid|会话|资源)/i.test(text)
    || tokenIs(RUNTIME_CODE_NOT_FOUND) || pageOrHostMissing) {
    // Handles that expired, files/artifacts/observations that are gone (`not_found`, `not_in_artifacts`, ENOENT),
    // HTTP 404/410 and a DNS name that does not resolve. (A DNS failure that looks transient — EAI_AGAIN or the
    // "疑似离线" probe hint — was already taken by the transport branches above.)
    failureClass = 'resource_not_found'; recoverableHint = true; allowedRepair = 'reacquire_resource';
  } else if (/unknown tool|tool not found|connector.{0,16}(offline|unavailable)|mcp server.{0,20}not available|工具.{0,8}(不存在|不可用)/i.test(text)) {
    failureClass = 'tool_unavailable'; recoverableHint = true; allowedRepair = 'retrieve_alternative_tool';
  } else if (result.loopAborted || disposition === 'loop_refused' || /no.?progress|semantic.?stall|死循环|无新(信息|进展)|相同工具调用/i.test(text)) {
    failureClass = 'no_progress'; recoverableHint = true; allowedRepair = 'replan';
  } else if (/verification|quality gate|coverage|evidence_missing|gate_(rejected|uncovered|unverified)|校验失败|验证失败|质量门/i.test(text)) {
    failureClass = 'verification_failed'; recoverableHint = true; allowedRepair = 'repair_then_verify';
  } else if (nonzeroExit || /traceback \(most recent call last\)|syntaxerror|parsererror|commandnotfoundexception|referenceerror|typeerror|uncaught exception/i.test(text)) {
    failureClass = 'execution_failed'; recoverableHint = true; allowedRepair = 'inspect_error_then_modify';
  }
  return {
    classifierVersion: RUNTIME_FAILURE_CLASSIFIER_VERSION,
    failureClass, recoverableHint, allowedRepair, deterministic: true,
    tier, disposition,
    evidenceHash: hashRuntimeToolEvidence(String(toolName || '') + '\0' + text),
  };
}

module.exports = { classifyRuntimeToolFailure, hashRuntimeToolEvidence };
