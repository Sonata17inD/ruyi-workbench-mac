'use strict';

const fs = require('node:fs');
const path = require('node:path');

function createAuditLog({ paths, nowIso }) {
  // --- Structured NDJSON logging: record lengths/metadata, never raw content. ---
  let logStream = null;
  let logStreamPath = '';
  function logEvent(record) {
    try {
      const day = nowIso().slice(0, 10);
      const file = path.join(paths.logs, `workbench-${day}.ndjson`);
      if (file !== logStreamPath && logStream) {
        logStream.end();
        logStream = null;
      }
      if (!logStream) {
        logStreamPath = file;
        logStream = fs.createWriteStream(file, { flags: 'a' });
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
