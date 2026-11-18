'use strict';
const crypto = require('node:crypto');
const path = require('node:path');

// 21-E3: 已执行动作的参数历史双视图 —— 纯函数(可 e2e 直测)。execution/audit view 保留完整 rawArgs
// (session.actionAudit + providerHistory 原消息),provider model view 投影为紧凑 envelope。
// 投影纪律:只投影 status=completed 且 sha256 与原始 arguments 可校验的动作;失败/中断/待审批不瘦身;
// 只加/换 arguments 字段,tool_call id/type/function.name 原样保留(pairing 铁律不破坏)。
const ACTION_VIEW_TOOLS = new Set(['file_write', 'file_edit', 'file_delete', 'file_move', 'file_copy', 'archive_zip', 'archive_unzip', 'http_download', 'script_run', 'shell_run', 'tool_invoke_edit', 'tool_invoke_exec']);
const ACTION_VIEW_MIN_CHARS = 512;

function actionTargetMeta(toolName, args) {
  const input = (args && typeof args === 'object') ? args : {};
  const name = String(toolName || '');
  const pathKey = input.path || input.source || input.destination || input.dest || input.output || input.output_path || input.root || '';
  if (/^(script_run|file_)/.test(name) && pathKey) {
    return { kind: 'path', basename: path.win32.basename(String(pathKey)) }; // win32:模型给的是 Windows 路径,\ 与 / 都认,非 Windows 主机上也只取尾段
  }
  if (name === 'shell_run') {
    const cmd = String(input.command || '');
    return { kind: 'cmd', basename: cmd.slice(0, 40) || (name === 'shell_run' ? 'shell' : 'powershell') };
  }
  if (/^tool_invoke_/.test(name)) {
    return { kind: 'proxy', basename: String(input.name || '') };
  }
  return { kind: 'path', basename: pathKey ? path.win32.basename(String(pathKey)) : '' };
}

function buildActionEnvelope(toolName, args, rawArgs) {
  const sha256 = crypto.createHash('sha256').update(String(rawArgs || '')).digest('hex');
  const target = actionTargetMeta(toolName, args);
  return {
    _ruyiActionRef: 'action-v1:ref', // 占位;实际 ref 由 audit 条目给出(turnSeq:toolCallId)
    target: { ...target, pathHash: crypto.createHash('sha1').update(String(target.basename || '')).digest('hex').slice(0, 12) },
    operation: String(toolName || ''),
    payload: { chars: Buffer.byteLength(String(rawArgs || ''), 'utf8'), sha256 },
    status: 'completed',
  };
}

// 返回 { history, changed } —— 浅投影:只对命中 audit 且校验通过的 assistant.tool_calls 替换 arguments。
function projectActionModelView(history, auditMap) {
  if (!Array.isArray(history) || !(auditMap instanceof Map) || auditMap.size === 0) return { history, changed: false };
  let changed = false;
  const projected = history.map(m => {
    if (!m || typeof m !== 'object' || m.role !== 'assistant' || !Array.isArray(m.tool_calls)) return m;
    let msgChanged = false;
    const toolCalls = m.tool_calls.map(tc => {
      if (!tc || tc.id == null) return tc;
      const entry = auditMap.get(String(tc.id));
      if (!entry || entry.status !== 'completed' || !entry.sha256) return tc;
      if (!ACTION_VIEW_TOOLS.has(entry.toolName)) return tc; // 防御双保险:仅投影白名单写动作
      const rawArgs = String((tc.function && tc.function.arguments) || '');
      if (Buffer.byteLength(rawArgs, 'utf8') < ACTION_VIEW_MIN_CHARS) return tc;
      if (crypto.createHash('sha256').update(rawArgs).digest('hex') !== entry.sha256) return tc; // 校验失败不投影
      let args; try { args = JSON.parse(rawArgs); } catch { return tc; } // 对抗:A4 malformed arguments 不投影(拒绝生成空 envelope)
      msgChanged = true;
      const env = buildActionEnvelope(entry.toolName, args, rawArgs);
      env._ruyiActionRef = entry.actionRef || env._ruyiActionRef;
      return { ...tc, function: { ...(tc.function || {}), arguments: JSON.stringify(env) } };
    });
    if (!msgChanged) return m;
    changed = true;
    return { ...m, tool_calls: toolCalls };
  });
  return { history: projected, changed };
}

module.exports = { ACTION_VIEW_TOOLS, ACTION_VIEW_MIN_CHARS, actionTargetMeta, projectActionModelView, buildActionEnvelope };
