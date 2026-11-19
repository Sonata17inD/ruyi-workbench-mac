'use strict';
const fsp = require('node:fs/promises');
function copyOrdinaryJsonData(value, freeze = true) {
  const ancestors = new Set();
  let nodes = 0;
  const copy = (item, depth) => {
    if (++nodes > 1000000 || depth > 128) throw new Error('execution argument snapshot exceeds capacity');
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return item;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('execution arguments require finite numbers');
      return item === 0 ? 0 : item;
    }
    if (!item || typeof item !== 'object' || (typeof JSON.isRawJSON === 'function' && JSON.isRawJSON(item)))
      throw new Error('execution arguments require ordinary JSON values');
    const array = Array.isArray(item), prototype = Object.getPrototypeOf(item);
    if (array ? prototype !== Array.prototype && prototype !== null : prototype !== Object.prototype && prototype !== null)
      throw new Error('execution arguments require ordinary JSON objects');
    if (ancestors.has(item)) throw new Error('execution arguments cannot be cyclic');
    ancestors.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    const keys = Reflect.ownKeys(descriptors);
    const result = array ? Object.setPrototypeOf([], null) : Object.create(null);
    if (array) {
      const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length) || length < 0 || length > 1000000 || keys.length !== length + 1)
        throw new Error('execution arguments require dense ordinary JSON arrays');
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[index];
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
          throw new Error('execution arguments cannot contain accessors or array holes');
        result[index] = copy(descriptor.value, depth + 1);
      }
    } else {
      for (const key of keys) {
        const descriptor = descriptors[key];
        if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
          throw new Error('execution arguments require enumerable JSON data properties');
        result[key] = copy(descriptor.value, depth + 1);
      }
    }
    ancestors.delete(item);
    return freeze ? Object.freeze(result) : result;
  };
  return copy(value, 0);
}
function safeJsonParse(raw, fallback = null) {
  try {
    return JSON.parse((typeof raw === 'string' && raw.charCodeAt(0) === 0xFEFF) ? raw.slice(1) : raw);
  } catch {
    return fallback;
  }
}

// Only an absent, blank or valid JSON object is eligible for merge. Keep unreadable
// or malformed user files untouched and give callers a diagnostic reason.
async function readUserJsonObjectForMerge(file) {
  let raw;
  try { raw = await fsp.readFile(file, 'utf8'); }
  catch (error) {
    const code = error && error.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: true, value: {}, existed: false };
    return { ok: false, reason: `read-failed:${code || (error && error.message) || 'unknown'}` };
  }
  const text = raw.replace(/^\uFEFF/, '');
  if (!text.trim()) return { ok: true, value: {}, existed: true };
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (error) { return { ok: false, reason: `invalid-json:${(error && error.message) || 'parse error'}` }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'root-not-object' };
  return { ok: true, value: parsed, existed: true };
}

module.exports = { copyOrdinaryJsonData, safeJsonParse, readUserJsonObjectForMerge };
