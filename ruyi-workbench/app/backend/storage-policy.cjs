'use strict';

function normalizeStoragePolicy(raw) {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const clampInt = (v, lo, hi, dflt) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt; };
  return {
    logsKeepDays: clampInt(r.logsKeepDays, 7, 365, 30),
    agentRunEventsCompressDays: clampInt(r.agentRunEventsCompressDays, 0, 365, 14),
    webcacheMaxEntries: clampInt(r.webcacheMaxEntries, 0, 100000, 0),
    engineTranscriptDays: clampInt(r.engineTranscriptDays, 0, 365, 30), // 0=关(不自动清转录);默认 30 天
  };
}

module.exports = { normalizeStoragePolicy };
