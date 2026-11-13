'use strict';
const { createHash } = require('node:crypto');

// Only pixel payloads are shared. Frame identity, timestamps and coordinate maps
// remain on their original envelopes. Eviction releases cache ownership, never
// invalidates references already held by a request/history entry.
function createImageContentStore({ maxBytes = 8 * 1024 * 1024, maxEntries = 32 } = {}) {
  const entries = new Map();
  let bytes = 0;
  function intern(buffer, mime) {
    const hash = createHash('sha256').update(buffer).digest('hex');
    const key = mime + ':' + hash;
    const existing = entries.get(key);
    if (existing) { entries.delete(key); entries.set(key, existing); return existing; }
    const value = Object.freeze({ hash, mime, bytes: buffer.length,
      uri: `data:${mime};base64,${buffer.toString('base64')}` });
    const cost = value.uri.length * 2; // Conservative UTF-16 bound, including data-URI overhead.
    if (cost <= maxBytes && maxEntries > 0) {
      while (entries.size && (bytes + cost > maxBytes || entries.size >= maxEntries)) {
        const [oldKey, old] = entries.entries().next().value;
        entries.delete(oldKey); bytes -= old.uri.length * 2;
      }
      entries.set(key, value); bytes += cost;
    }
    return value;
  }
  return Object.freeze({ intern, clear() { entries.clear(); bytes = 0; },
    stats: () => ({ entries: entries.size, bytes, maxBytes }) });
}
module.exports = { createImageContentStore };
