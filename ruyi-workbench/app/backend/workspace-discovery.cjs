'use strict';
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

function createWorkspaceDiscovery({ paths }) {
  const { samePathKey } = paths;

  // v0.8-S0 cwd guardrail: a resolved working dir sitting AT the user's home or its Desktop/Documents/
  // Downloads root is the highest-risk "tidy this folder" target (it acts on everything the user owns).
  // Returns { path, reason } to attach to the turn's meta event, or null when the dir is task-specific.
  function cwdWarning(resolvedDir) {
    if (!resolvedDir) return null;
    const norm = p => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
    const home = os.homedir();
    const roots = new Set([home, path.join(home, 'Desktop'), path.join(home, 'Documents'), path.join(home, 'Downloads')].map(norm));
    if (roots.has(norm(resolvedDir))) {
      return { path: resolvedDir, reason: 'working-dir-is-user-root' };
    }
    return null;
  }

  // ===================================================================================================
  // v0.9-S3 (C3) — folder-drag → workspace by FINGERPRINT.
  // The browser sandbox never exposes a dropped folder's absolute path (webkitGetAsEntry gives name +
  // first-level child names only). So we locate the real directory by fingerprint: given {name, children}
  // (children = the folder's first-level entry names, ≤50), search a bounded set of CANDIDATE roots for a
  // directory whose basename matches `name` (case-insensitive) AND whose own first-level entry names overlap
  // the supplied children by ≥ MATCH_THRESHOLD (Jaccard: |intersect| / |union|). Returns matches sorted by
  // score DESC, ≤5. Purely READ-ONLY (readdir); never mutates anything.
  //
  // Candidate roots (one directory level scanned under each):
  //   • each existing drive root (A:\ .. Z:\)     — one level of dirs only
  //   • home dir and its first level              — home itself + one level
  //   • the current defaultWorkspace's parent      — one level (sibling projects)
  //   • config.recentWorkspaces                    — the exact dirs (their basenames can match directly)
  //
  // PERFORMANCE GUARDRAILS: every readdir is try/catch (a permission-denied root is skipped, never fatal);
  // candidate directory total is capped at CANDIDATE_CAP (truncated:true when exceeded); a wall-clock budget
  // (RESOLVE_BUDGET_MS) stops the scan early (truncated:true). A huge child list is clamped to CHILDREN_CAP.
  // ===================================================================================================
  const WORKSPACE_MATCH_THRESHOLD = 0.8;   // Jaccard overlap of child-name sets required to count as a hit
  const WORKSPACE_CANDIDATE_CAP = 2000;    // hard cap on candidate directories scanned
  const WORKSPACE_RESOLVE_BUDGET_MS = 3000; // overall wall-clock budget for the scan (now covers candidate BUILD too)
  const WORKSPACE_CHILDREN_CAP = 50;       // clamp on the incoming child-name list
  // PF3: a single dead/offline mapped network drive used to block the WHOLE process, because the resolver
  // enumerated drives with fs.readdirSync/existsSync. Every directory listing now goes through fsp.readdir
  // (async, yields the event loop) wrapped in a HARD per-directory timeout so one slow root can never stall
  // the scan (or the chat stream sharing the loop). On timeout/error the root is simply skipped.
  // PF3 fix: 600ms was too tight — a slow-but-ALIVE network drive (700-900ms to list) was routinely misjudged as
  // dead and its real workspaces dropped. Widened to 1000ms; the overall RESOLVE_BUDGET_MS still bounds the worst
  // case so a genuinely dead drive can never block indefinitely.
  const WORKSPACE_DIR_TIMEOUT_MS = 1000;   // hard per-directory readdir/stat timeout (dead network drive can't block)
  // PF3 fix: distinguish a TIMEOUT from a real empty/absent/denied directory. The old readdirTimed collapsed both
  // to null, so a slow-but-alive dir looked identical to a non-existent one — a real workspace on a laggy drive
  // scored 0 (empty child set) and was silently dropped, with no way to flag the result as incomplete. These
  // sentinels let callers tell "slow, unknown" (mark truncated / fall back to a bounded stat) apart from "known
  // empty/absent" (skip). A readdir that resolves AFTER we've timed out is simply discarded. Never throws.
  const READDIR_TIMEOUT = Symbol('readdir-timeout');
  const STAT_TIMEOUT = Symbol('stat-timeout');
  function readdirTimed(dir, opts, timeoutMs) {
    return Promise.race([
      fsp.readdir(dir, opts).catch(() => null),                                      // null = error (ENOENT / denied / not a dir)
      new Promise(resolve => setTimeout(() => resolve(READDIR_TIMEOUT), timeoutMs)), // sentinel = timed out (alive but slow)
    ]);
  }
  // PF3 fix: bounded existence probe for an EXPLICITLY-KNOWN candidate path (a recentWorkspace). Confirms the dir
  // is still there WITHOUT listing it, so a known workspace on a slow drive isn't dropped just because its own
  // readdir timed out. Resolves to a Stats, null (error/absent), or STAT_TIMEOUT. Never throws.
  function statTimed(p, timeoutMs, options) {
    return Promise.race([
      fsp.stat(p, options).catch(() => null),
      new Promise(resolve => setTimeout(() => resolve(STAT_TIMEOUT), timeoutMs)),
    ]);
  }
  // Jaccard similarity of two name Sets: |A ∩ B| / |A ∪ B|. Empty-vs-empty → 1 (both truly empty folders
  // fingerprint-match); one-empty → 0.
  function nameSetJaccard(a, b) {
    if (!a.size && !b.size) return 1;
    if (!a.size || !b.size) return 0;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    const union = a.size + b.size - inter;
    return union === 0 ? 0 : inter / union;
  }
  // List first-level SUBDIRECTORIES of `root` (absolute paths). Bounded; never throws. Returns { dirs, timedOut }:
  // timedOut:true means the listing was ABANDONED at the per-dir timeout (alive but slow) so the caller can mark
  // the overall result truncated (a partial candidate set must not be mistaken for the authoritative one). An
  // error/absent root yields { dirs:[], timedOut:false } — nothing to discover, and it's not "slow".
  async function listChildDirs(root) {
    // PF3: async + hard timeout. A non-existent drive letter rejects fast (ENOENT → null → []); a live-but-slow
    // network root times out instead of blocking the event loop. Replaces the old existsSync gate: attempting the
    // timed readdir directly both tests existence AND lists in one non-blocking call.
    const ents = await readdirTimed(root, { withFileTypes: true }, WORKSPACE_DIR_TIMEOUT_MS);
    if (ents === READDIR_TIMEOUT) return { dirs: [], timedOut: true };
    if (!ents) return { dirs: [], timedOut: false };
    const out = [];
    for (const e of ents) {
      // isDirectory() can throw on a broken symlink entry on some FS — guard it.
      let isDir = false;
      try { isDir = e.isDirectory(); } catch { isDir = false; }
      if (isDir) out.push(path.join(root, e.name));
      if (out.length >= 4096) break; // sanity guard for a pathological root
    }
    return { dirs: out, timedOut: false };
  }

  // Core resolver (pure-ish: reads the FS, takes config for candidate roots). Exposed for e2e unit testing.
  // Returns { ok:true, matches:[{path, score}], truncated }.
  async function resolveWorkspace({ name, children, selectedPath }, config) {
    // Native macOS pickers resolve aliases such as /var -> /private/var. Preserve
    // an existing favorite's spelling and permissions when it names the same directory.
    if (process.platform === 'darwin' && typeof selectedPath === 'string') {
      if (!path.isAbsolute(selectedPath)) throw new Error('selectedPath must be absolute');
      let timer;
      const canonical = await Promise.race([fsp.realpath(selectedPath).catch(() => null),
        new Promise(resolve => { timer = setTimeout(() => resolve(null), WORKSPACE_DIR_TIMEOUT_MS); }),
      ]).finally(() => clearTimeout(timer));
      if (!canonical) throw new Error('selectedPath could not be resolved');
      const selected = await statTimed(canonical, WORKSPACE_DIR_TIMEOUT_MS, { bigint: true });
      if (!selected || selected === STAT_TIMEOUT || !selected.isDirectory()) throw new Error('selectedPath must identify a directory');
      const known = Array.isArray(config.workspaces) ? config.workspaces : [];
      const resolved = await Promise.all(known.map(async favorite => ({ favorite,
        stat: typeof favorite.path === 'string' && path.isAbsolute(favorite.path) ? await statTimed(favorite.path, WORKSPACE_DIR_TIMEOUT_MS, { bigint: true }) : null,
      })));
      const matching = resolved.filter(row => row.stat && row.stat !== STAT_TIMEOUT && row.stat.dev === selected.dev && row.stat.ino === selected.ino);
      const favorite = matching[0]?.favorite;
      return { ok: true, path: favorite?.path || canonical, ...(favorite ? { favorite } : {}),
        aliases: Array.from(new Set([canonical, selectedPath, ...matching.map(row => row.favorite.path)])), matches: [] };
    }
    const wantName = String(name || '').trim().toLowerCase();
    if (!wantName) return { ok: false, error: 'name is required', matches: [] };
    const wantChildren = new Set(
      (Array.isArray(children) ? children : [])
        .slice(0, WORKSPACE_CHILDREN_CAP)
        .filter(c => typeof c === 'string' && c)
        .map(c => c.toLowerCase())
    );

    const started = Date.now();
    let truncated = false;

    // ── build the candidate-directory list ──────────────────────────────────────────────────────────
    const candidates = [];        // absolute dir paths to test
    const candSeen = new Set();    // de-dupe by lowercased path
    const pushCand = p => {
      if (candidates.length >= WORKSPACE_CANDIDATE_CAP) { truncated = true; return; }
      const key = samePathKey(p);
      if (candSeen.has(key)) return;
      candSeen.add(key);
      candidates.push(p);
    };

    // PF3: the wall-clock budget now guards candidate BUILD (drive/home/parent enumeration), not just scoring,
    // so a slow root can't blow past it. Every listChildDirs() is async + per-directory timed (see WORKSPACE_DIR_TIMEOUT_MS).
    const overBudget = () => Date.now() - started > WORKSPACE_RESOLVE_BUDGET_MS;
    // (a) each existing drive root, one directory level. Enumerate A:..Z: that exist.
    // PF3 fix: a timed-out root enumeration marks the result truncated (its children weren't discovered — the
    // candidate set is incomplete, not authoritative).
    const addChildren = r => { if (r.timedOut) truncated = true; for (const d of r.dirs) pushCand(d); };
    addChildren(await listChildDirs('/'));
    // (b) home dir and its first level.
    const home = os.homedir();
    pushCand(home);
    if (!overBudget()) addChildren(await listChildDirs(home));
    // (c) the current defaultWorkspace's parent, one level (sibling projects).
    const dw = (config && typeof config.defaultWorkspace === 'string' && config.defaultWorkspace) ? config.defaultWorkspace : home;
    const dwParent = path.dirname(path.resolve(dw));
    if (!overBudget()) addChildren(await listChildDirs(dwParent));
    // (d) recentWorkspaces — the exact dirs (their basenames can match directly). PF3 fix: track these as KNOWN
    // paths so a timeout on their own listing falls back to a bounded stat instead of dropping a real workspace.
    const knownPaths = new Set(); // platform-aware resolved paths explicitly used by the user
    for (const w of (config && Array.isArray(config.recentWorkspaces) ? config.recentWorkspaces : [])) {
      if (typeof w === 'string' && w) { const rp = path.resolve(w); pushCand(rp); knownPaths.add(samePathKey(rp)); }
    }

    // ── score candidates whose basename matches the wanted name ─────────────────────────────────────
    const matches = [];
    for (const dir of candidates) {
      if (Date.now() - started > WORKSPACE_RESOLVE_BUDGET_MS) { truncated = true; break; }
      if (path.basename(dir).toLowerCase() !== wantName) continue;
      const names = await readdirTimed(dir, undefined, WORKSPACE_DIR_TIMEOUT_MS);
      if (names === READDIR_TIMEOUT) {
        // PF3 fix: this candidate's fingerprint is unknowable (slow drive) → the result is INCOMPLETE, flag it.
        truncated = true;
        // Preserve the old "unreadable dir → empty fingerprint" scoring so an empty dropped folder still name-matches.
        const emptyScore = nameSetJaccard(wantChildren, new Set()); // 1 iff wantChildren is also empty, else 0
        if (emptyScore >= WORKSPACE_MATCH_THRESHOLD) {
          matches.push({ path: path.resolve(dir), score: Math.round(emptyScore * 1000) / 1000 });
        } else if (knownPaths.has(samePathKey(dir))) {
          // A KNOWN path (recentWorkspaces) with a non-empty fingerprint we couldn't read must NOT be dropped just
          // because its listing timed out. Confirm it still exists via a bounded stat and select it on the name
          // match alone (a workspace the user has actually used, basename == wanted name, is a real hit). Score at
          // the threshold so it surfaces yet never outranks a genuine fingerprint match (which scores on real overlap).
          const st = await statTimed(dir, WORKSPACE_DIR_TIMEOUT_MS);
          let isDir = false; try { isDir = !!(st && st !== STAT_TIMEOUT && st.isDirectory && st.isDirectory()); } catch { isDir = false; }
          if (isDir) matches.push({ path: path.resolve(dir), score: WORKSPACE_MATCH_THRESHOLD });
        }
        continue;
      }
      const have = names ? new Set(names.slice(0, 500).map(n => String(n).toLowerCase())) : new Set(); // null (error) → empty, as before
      const score = nameSetJaccard(wantChildren, have);
      if (score >= WORKSPACE_MATCH_THRESHOLD) matches.push({ path: path.resolve(dir), score: Math.round(score * 1000) / 1000 });
    }
    // De-dupe by resolved path (a dir can appear via two roots), keep the higher score; sort DESC; ≤5.
    const bestByPath = new Map();
    for (const m of matches) {
      const k = samePathKey(m.path);
      if (!bestByPath.has(k) || bestByPath.get(k).score < m.score) bestByPath.set(k, m);
    }
    const sorted = [...bestByPath.values()].sort((a, b) => b.score - a.score).slice(0, 5);
    return { ok: true, matches: sorted, truncated };
  }

  return { cwdWarning, resolveWorkspace };
}

module.exports = { createWorkspaceDiscovery };
