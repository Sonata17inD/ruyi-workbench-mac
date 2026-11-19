'use strict';

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');

function createHistorySnapshotStore({ journalDir, journalBytesAdjust, withJournalWriteLock, journalGc }) {
  // v0.8-S5 checkpoint SAFETY NET (not a gate): snapshot providerHistory BEFORE a compaction to
  // dataRoot/checkpoints/<sessionId>/history-<turnSeq>[<-contentHash>].json.gz (built-in zlib; S4a dir
  // convention). The hash suffix is used only by 20-C1 so repeated compactions in one turn cannot overwrite
  // a raw observation referenced by an earlier compacted model view. A
  // failure here MUST NOT block the compaction or the turn — it is a recovery aid, not a precondition.
  async function writeHistorySnapshot(sessionId, turnSeq, history, stableRef = false) {
    try {
      if (!sessionId || !Array.isArray(history)) return '';
      const dir = journalDir(sessionId);
      await fsp.mkdir(dir, { recursive: true });
      const raw = JSON.stringify(history);
      const snapshotHash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
      const gz = zlib.gzipSync(Buffer.from(raw, 'utf8'));
      const turn = Number(turnSeq) || 0;
      const file = stableRef ? `history-${turn}-${snapshotHash}.json.gz` : `history-${turn}.json.gz`;
      const target = path.join(dir, file);
      const previousSize = await fsp.stat(target).then(st => st.size).catch(() => 0);
      await fsp.writeFile(target, gz);
      // PF1 fix: these history snapshots land in the SAME checkpoints/<id>/ tree the global size cap governs, but
      // only journalRecord used to keep the byte cache current. A compaction-heavy / edit-light session (each
      // auto-compact can write several MB here, and per-session GC never prunes these files) grew the real tree
      // WITHOUT moving the cache, so needSweep stayed false and the hard cap silently became a soft one.
      // (a) account the net snapshot-byte delta (content-hashed C1 snapshots are often reused across repeated
      //     threshold checks; counting every overwrite as a new file would trigger needless global sweeps);
      // (b) give the sweep a chance to run: journalGc is otherwise only called on file writes, which are rare in a
      //     compaction-heavy load. Run it UNDER the per-session write lock so its index read-modify-write can't
      //     race a concurrent journalRecord (the v1.4.1 audit #8 lost-write hazard). Fire-and-forget: a recovery
      //     aid must never block or fail the compaction.
      journalBytesAdjust(gz.length - previousSize);
      withJournalWriteLock(sessionId, () => journalGc(sessionId)).catch(() => {});
      return stableRef ? `history:${turn}:${snapshotHash}` : `history:${turn}`;
    } catch { return ''; /* safety net, never fatal */ }
  }

  // Resolve a content-addressed observation within the current session journal and verify its content hash.
  async function rehydrateObservation(sessionId, rawRef) {
    try {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(sessionId || ''))) return { ok: false, error: 'invalid session id' };
      const m = /^history:(\d+):([a-f0-9]{16}):(\d+):([a-f0-9]{16})$/.exec(String(rawRef || ''));
      if (!m) return { ok: false, error: 'invalid rawRef' };
      const file = path.join(journalDir(sessionId), `history-${m[1]}-${m[2]}.json.gz`);
      const history = JSON.parse(zlib.gunzipSync(await fsp.readFile(file)).toString('utf8'));
      const item = Array.isArray(history) ? history[Number(m[3])] : null;
      if (!item || item.role !== 'tool' || typeof item.content !== 'string') return { ok: false, error: 'observation not found' };
      const actual = crypto.createHash('sha256').update(item.content).digest('hex').slice(0, 16);
      if (actual !== m[4]) return { ok: false, error: 'observation hash mismatch' };
      return { ok: true, content: item.content, toolCallId: item.tool_call_id || '', rawRef: String(rawRef) };
    } catch (e) { return { ok: false, error: (e && e.code) || 'rehydrate failed' }; }
  }

  return { writeHistorySnapshot, rehydrateObservation };
}

module.exports = { createHistorySnapshotStore };
