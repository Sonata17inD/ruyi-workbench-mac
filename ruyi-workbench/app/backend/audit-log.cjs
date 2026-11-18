'use strict';

const fs = require('node:fs');
const path = require('node:path');

function createAuditLog({ logsDirectory, nowIso }) {
  // --- Structured NDJSON logging: record lengths/metadata, never raw content. ---
  let logStream = null;
  let logStreamDay = '';
  function logEvent(record) {
    try {
      const day = nowIso().slice(0, 10);
      if (day !== logStreamDay && logStream) {
        logStream.end();
        logStream = null;
      }
      if (!logStream) {
        logStreamDay = day;
        logStream = fs.createWriteStream(path.join(logsDirectory, `workbench-${day}.ndjson`), { flags: 'a' });
        const stream = logStream;
        stream.on('error', () => { if (logStream === stream) logStream = null; });
      }
      logStream.write(`${JSON.stringify({ ts: nowIso(), ...record })}\n`);
    } catch {
      // logging must never break a turn
    }
  }

  return logEvent;
}

module.exports = { createAuditLog };
