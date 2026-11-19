'use strict';
const crypto = require('node:crypto');
const { copyOrdinaryJsonData } = require('./ordinary-json.cjs');

// Expected SDK-decoded JSON value fingerprint shared with ACC execution_arguments.py.
// Integer JSON.stringify tokens retain every decimal digit; decimal/exponent tokens use binary64.
// The caller must pass its immutable JSON snapshot, not a mutable pre-serialization object.
// This binds decoded values, not original wire spelling, and never authorizes an action.
function executionArgumentsDigest(value) {
  const digest = crypto.createHash('sha256');
  const ancestors = new Set();
  let nodes = 0, bytes = 0;
  const put = data => {
    bytes += typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : data.length;
    if (bytes > 64 * 1024 * 1024) throw new Error('execution argument fingerprint exceeds capacity');
    digest.update(data);
  };
  const utf8 = value => {
    for (let i = 0; i < value.length; i += 1) {
      const code = value.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('execution arguments contain invalid Unicode');
      } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error('execution arguments contain invalid Unicode');
    }
    return Buffer.from(value, 'utf8');
  };
  const visit = (item, depth) => {
    nodes += 1;
    if (nodes > 1000000 || depth > 128) throw new Error('execution argument fingerprint exceeds capacity');
    if (item === null) { put('n;'); return; }
    if (typeof item === 'boolean') { put(item ? 't;' : 'f;'); return; }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('execution arguments require finite numbers');
      const token = JSON.stringify(item);
      if (/^-?\d+$/.test(token)) { put('i' + token + ';'); return; }
      const number = Buffer.allocUnsafe(8); number.writeDoubleBE(item === 0 ? 0 : item);
      put('d'); put(number); put(';'); return;
    }
    if (typeof item === 'string') { const text = utf8(item); put('s' + text.length + ':'); put(text); put(';'); return; }
    if (!item || typeof item !== 'object' || (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null))
      throw new Error('execution arguments require JSON values');
    if (ancestors.has(item)) throw new Error('execution arguments cannot be cyclic');
    ancestors.add(item);
    if (Array.isArray(item)) {
      put('a' + item.length + ':');
      for (let index = 0; index < item.length; index += 1) visit(item[index], depth + 1);
    } else {
      const keys = Object.keys(item).map(key => ({ key, bytes: utf8(key) })).sort((a, b) => Buffer.compare(a.bytes, b.bytes));
      put('o' + keys.length + ':');
      for (const { key } of keys) { visit(key, depth + 1); visit(item[key], depth + 1); }
    }
    ancestors.delete(item); put(';');
  };
  put(Buffer.from('ruyi-sdk-json-v1\0', 'utf8'));
  visit(value, 0);
  return digest.digest('hex');
}

// P2-16(30号文§3 总表): argsHash 指纹算法两份字面相同 —— 06f-autonomy-grants.js::consumeGrant(用量事件,
// 收对象 args)与 09b-replan-ledger.js::recordNodeContinuation(节点续点 pending 步骤,收预先算好的
// argsStr 字符串)各自手写一遍 sha1+hex 截 12 位。收拢两处 best-effort 语义:入参已经是字符串就直接用,
// 否则 JSON.stringify(args || {});任何异常兜底返回空串(与两处原有 try/catch 兜底行为一致,不让指纹计算
// 炸调用方主流程)。纯函数,只吃入参、无 IO。
function hashArgs(args) {
  try {
    const str = typeof args === 'string' ? args : JSON.stringify(args || {});
    return crypto.createHash('sha1').update(str).digest('hex').slice(0, 12);
  } catch {
    return '';
  }
}

// Prepare once at the final host dispatch boundary. Reject values whose implicit JSON conversion
// could change approved data; copy property descriptors without invoking getters or toJSON hooks.
// The returned bytes, decoded-value fingerprint and frozen outgoing object describe the same JSON.
function prepareDesktopExecutionArguments(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('tool arguments must be a JSON object');
  const snapshot = copyOrdinaryJsonData(value);
  const semanticSha256 = executionArgumentsDigest(snapshot);
  const json = JSON.stringify(snapshot);
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > 8 * 1024 * 1024) throw new Error('execution argument snapshot exceeds capacity');
  return Object.freeze(Object.assign(Object.create(null), { snapshot, json, bytes, sha256: crypto.createHash('sha256').update(json, 'utf8').digest('hex'),
    codec: 'javascript-json-utf8-v1', semanticSha256, semanticCodec: 'ruyi-sdk-json-v1' }));
}

module.exports = { executionArgumentsDigest, hashArgs, prepareDesktopExecutionArguments };
