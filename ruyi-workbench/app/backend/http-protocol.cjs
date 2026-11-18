'use strict';
const path = require('node:path');
const MAX_BODY_BYTES = 128 * 1024 * 1024;

const LEGACY_API_ERROR_CODES = new Map([
  ['missing or invalid workbench token', 'auth.token_invalid'],
  ['bad token', 'auth.token_invalid'],
  ['invalid sessionId', 'session.id_invalid'],
  ['sessionId required', 'session.id_required'],
  ['session not found', 'session.not_found'],
  ['method not allowed', 'api.method_not_allowed'],
  ['host not allowed', 'api.host_rejected'],
  ['unknown action', 'request.action_unknown'],
  // 128b:撤回相关的三句裸串给稳定码(否则一律落成 api.request_failed,前端只能把原串 'rewind_superseded' 摆给用户看)。
  ['rewind_superseded', 'session.rewind_superseded'],
  ['session.rewound_during_write', 'session.rewound_during_write'],
  ['session.history_changed_during_compact', 'session.history_changed_during_compact'],
]);

// Keep the legacy message as an optional diagnostic while ensuring every HTTP error has a stable,
// language-neutral machine code. Individual routes can still use apiFailure() for a richer code/params.
function normalizeApiErrorPayload(data) {
  if (!data || data.ok !== false || typeof data.error !== 'string') return data;
  const message = data.error;
  const { error, ...rest } = data;
  return {
    ...rest,
    error: {
      code: LEGACY_API_ERROR_CODES.get(message) || 'api.request_failed',
      params: {},
      message,
    },
  };
}

function json(data, status = 200, headers = {}) {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
    body: JSON.stringify(normalizeApiErrorPayload(data), null, 2),
  };
}

// P2 API error contract. Error codes and params are stable/localization-friendly; message remains a
// diagnostic fallback for older callers while the front end migrates away from sentence matching.
function apiFailure(code, params = {}, message = '', status = 400) {
  return json({
    ok: false,
    error: {
      code: String(code || 'api.unknown'),
      params: params && typeof params === 'object' && !Array.isArray(params) ? params : {},
      ...(message ? { message: String(message) } : {}),
    },
  }, status);
}

// 架构还债批 1 #7:按 sessionId 操作的路由最常见的两句失败。修前 40 余处各自手写裸串
// json({ ok:false, error:'invalid sessionId' }, 400) / 'session not found' 404,靠上面那张遗留映射表
// 兜底翻成稳定码 —— 拼错一个字就悄悄落成 api.request_failed。出参与遗留写法逐字节相同(code/params/message 同序)。
function apiSessionIdInvalid() { return apiFailure('session.id_invalid', {}, 'invalid sessionId', 400); }
function apiSessionNotFound() { return apiFailure('session.not_found', {}, 'session not found', 404); }

function text(data, status = 200, headers = {}) {
  return {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...headers },
    body: data,
  };
}

async function readBody(req) {
  // 声明长度已超总闸就不必先缓冲 128 MB 再拒(同 readAudioBody 的预检);提前回 413 后客户端可能还在续传,
  // 连接随即被拆,req 上迟到的 error/aborted 挂空接吞掉。apiCode 让 413 不再被 sendError 报成 api.internal_error。
  req.on('error', () => {});
  if (Number(req.headers && req.headers['content-length'] || 0) > MAX_BODY_BYTES) {
    throw Object.assign(new Error('Request body too large'), { statusCode: 413, apiCode: 'api.body_too_large' });
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      const err = new Error('Request body too large');
      err.statusCode = 413;
      err.apiCode = 'api.body_too_large';
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  let value;
  try { value = JSON.parse(raw); }
  catch { throw Object.assign(new Error('request body is not valid JSON'), { statusCode: 400, apiCode: 'api.bad_json' }); }   // C17:客户端的错,回 400 不回 500
  // 合法 JSON 但不是对象(null / 数组 / 字符串 / 数字):按空体处理。约 30 个 handler 直接读 body.xxx,
  // 请求体是 `null` 时就是 TypeError → 500 + http_unhandled 日志;没有任何路由收顶层数组或标量。
  return (value && typeof value === 'object' && !Array.isArray(value)) ? value : {};
}

function send(res, response) {
  res.writeHead(response.status || 200, response.headers || {});
  res.end(response.body || '');
}

function sendError(res, err) {
  const status = err.statusCode || 500;
  send(res, apiFailure(err.apiCode || 'api.internal_error', {}, err.message || String(err), status));
}

function contentTypeFor(file) {
  const ext = path.extname(file).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml',
  }[ext] || 'application/octet-stream';
}

// 路径段解码:decodeURIComponent 遇到坏的百分号编码(如 `%zz`)会抛 URIError,落到顶层就是 500 + http_unhandled。
// 路由拿到 null 按「这个 id 不存在/不合法」回 4xx(先例:/api/missions/:id/interventions/:iv/decision)。
function safeDecodeURIComponent(segment) {
  try { return decodeURIComponent(String(segment == null ? '' : segment)); } catch { return null; }
}

module.exports = { safeDecodeURIComponent, MAX_BODY_BYTES, normalizeApiErrorPayload, json, apiFailure, apiSessionIdInvalid, apiSessionNotFound, text, readBody, readJsonBody, send, sendError, contentTypeFor };
