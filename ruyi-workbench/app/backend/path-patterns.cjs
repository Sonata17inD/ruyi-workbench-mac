'use strict';
const path = require('node:path');
function globToRegExp(glob) {
  // 返回一个只有 test(str) 的匹配器(调用点只用 .test)。修前把 glob 译成正则:每个 `*` 是 `[^\\/]*`,
  // 模型给的 `*a*a*a*a*a*b` 这类 glob 在长文件名上是多项式回溯(星号越多次方越高),卡死主线程。
  // 这里把 glob 切成记号,按 NFA 同时推进所有可能位置:每个字符 O(记号数),整条 O(路径长 × 记号数),与 glob 形状无关。
  // 语义:`**/` = 零个或多个【完整】目录段(修前是「任意字符 + 可省分隔符」,`**/test.py` 连 `mytest.py` 也配上,
  // `**/.*` 配上所有带点的文件);结尾或段中的 `**` 跨分隔符任意长;`*` 段内任意长;`?` 段内一个字符;
  // `[a-z]` / `[!x]` 字符类(段内一个字符);`{a,b}` 花括号展开(可嵌套);`/` 与 `\` 互认;其余字面、
  // 大小写不敏感;整串锚定。修前花括号与字符类按字面配,`**/*.{js,py}` 静默配不到任何文件。
  // 自包含(不引用本文件别处的名字):autonomy-grant.e2e 从源码切出这个函数单独求值。
  const expand = (pat, depth) => {
    const open = pat.indexOf('{');
    if (open < 0 || depth > 8) return [pat];
    let level = 0, close = -1;
    const commas = [];
    for (let i = open; i < pat.length; i += 1) {
      if (pat[i] === '{') level += 1;
      else if (pat[i] === '}') { level -= 1; if (level === 0) { close = i; break; } }
      else if (pat[i] === ',' && level === 1) commas.push(i);
    }
    if (close < 0 || !commas.length) {
      // 没有配对或没有逗号:这一对花括号按字面,继续展开后面的
      if (close < 0) return [pat];
      return expand(pat.slice(close + 1), depth + 1).map(rest => pat.slice(0, close + 1) + rest);
    }
    const head = pat.slice(0, open), tail = pat.slice(close + 1);
    const parts = [];
    let from = open + 1;
    for (const c of [...commas, close]) { parts.push(pat.slice(from, c)); from = c + 1; }
    const out = [];
    for (const part of parts) for (const e of expand(head + part + tail, depth + 1)) { if (out.length < 64) out.push(e); }
    return out;
  };
  const compile = g => {
    const toks = [];
    for (let i = 0; i < g.length; i += 1) {
      const c = g[i];
      if (c === '*') {
        if (g[i + 1] === '*') {
          i += 1;
          const atSegStart = toks.length === 0 || toks[toks.length - 1].t === 'sep' || toks[toks.length - 1].t === 'dirs';
          if (atSegStart && (g[i + 1] === '/' || g[i + 1] === '\\')) { toks.push({ t: 'dirs' }); i += 1; }
          else toks.push({ t: 'any' });
        } else toks.push({ t: 'star' });
      } else if (c === '?') toks.push({ t: 'one' });
      else if (c === '/' || c === '\\') toks.push({ t: 'sep' });
      else if (c === '[') {
        const endAt = g.indexOf(']', i + 2);
        if (endAt < 0) { toks.push({ t: 'lit', c: '[', u: '[' }); continue; }
        let body = g.slice(i + 1, endAt);
        const neg = body[0] === '!' || body[0] === '^';
        if (neg) body = body.slice(1);
        const ranges = [];
        for (let k = 0; k < body.length; k += 1) {
          if (body[k + 1] === '-' && k + 2 < body.length) { ranges.push([body[k].toLowerCase(), body[k + 2].toLowerCase()]); k += 2; }
          else ranges.push([body[k].toLowerCase(), body[k].toLowerCase()]);
        }
        toks.push({ t: 'cls', neg, ranges });
        i = endAt;
      } else toks.push({ t: 'lit', c: c.toLowerCase(), u: c.toUpperCase() });
    }
    return toks;
  };
  const isSep = ch => ch === '/' || ch === '\\';
  const inClass = (tk, ch) => {
    const lo = ch.toLowerCase();
    const hit = tk.ranges.some(([a, b]) => lo >= a && lo <= b);
    return tk.neg ? !hit : hit;
  };
  const makeMatcher = toks => {
    const m = toks.length;
    // 可空记号(`*`、`**`、零个目录段)可以直接跳过:从 i 出发能到的位置集合写进 on(去重)。
    const close = (on, i) => {
      while (i <= m && !on[i]) {
        on[i] = 1;
        const tk = toks[i];
        if (!tk || !(tk.t === 'star' || tk.t === 'any' || tk.t === 'dirs')) break;
        i += 1;
      }
    };
    return str => {
      const s = String(str == null ? '' : str);
      let cur = new Uint8Array(m + 1);
      let curIn = new Uint8Array(m + 1);   // 'dirs' 记号的段内态:已经吃进了一个目录段的若干字符,等它的分隔符
      close(cur, 0);
      for (let k = 0; k < s.length; k += 1) {
        const ch = s[k];
        const lo = ch.toLowerCase();
        const next = new Uint8Array(m + 1);
        const nextIn = new Uint8Array(m + 1);
        let any = false;
        for (let i = 0; i < m; i += 1) {
          const tk = toks[i];
          if (curIn[i]) {
            if (isSep(ch)) { close(next, i); any = true; } else { nextIn[i] = 1; any = true; }
          }
          if (!cur[i]) continue;
          let to = -1;
          if (tk.t === 'lit') { if (lo === tk.c || ch === tk.u) to = i + 1; }
          else if (tk.t === 'one') { if (!isSep(ch)) to = i + 1; }
          else if (tk.t === 'cls') { if (!isSep(ch) && inClass(tk, ch)) to = i + 1; }
          else if (tk.t === 'sep') { if (isSep(ch)) to = i + 1; }
          else if (tk.t === 'star') { if (!isSep(ch)) to = i; }
          else if (tk.t === 'any') to = i;
          else if (tk.t === 'dirs') { if (!isSep(ch)) { nextIn[i] = 1; any = true; } }
          if (to >= 0) { close(next, to); any = true; }
        }
        if (!any) return false;
        cur = next;
        curIn = nextIn;
      }
      return cur[m] === 1;
    };
  };
  const g = String(glob || '');
  const matchers = expand(g, 0).map(p => makeMatcher(compile(p)));
  return {
    source: g,
    test(str) { return matchers.some(fn => fn(str)); },
  };
}

// v0.8-S1: minimal Levenshtein edit distance (zero-dep) for file_edit `closest` ranking. Lines longer
// than `cap` are truncated first (edit distance is O(m*n); pathological long lines would be quadratic).
function levenshtein(a, b, cap = 500) {
  const s = String(a || '').slice(0, cap);
  const t = String(b || '').slice(0, cap);
  const m = s.length, n = t.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;
  for (let i = 1; i <= m; i += 1) {
    let cur = [i];
    for (let j = 1; j <= n; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

// 2026-10 走查(R2):glob 的 pattern 是【相对 root】的。模型常写 `./src/*.js`(前导 ./ 或 .\\ 让整条配不上任何东西)或把绝对路径当 pattern
// (`C:\\ws\\src\\*.js`)—— 修前都是静默 ok:true + 空表。这里:剥掉前导 ./ 与 .\\;绝对路径落在 root 之内的改成相对 root 的写法,
// 在 root 之外的不匹配任何东西并明说。返回 { pattern, note, outside }(note 非空 = 做过改写/有话要说)。纯函数(只用 path)。
function normalizeGlobPatternForRoot(raw, root) {
  let p = String(raw == null ? '' : raw);
  const notes = [];
  if (/^\.[\\/]+/.test(p)) { p = p.replace(/^(?:\.[\\/]+)+/, ''); notes.push('the leading "./" was ignored (patterns are relative to root)'); }
  const winAbs = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(p);
  if (winAbs || path.isAbsolute(p)) {
    const base = path.resolve(String(root || '.'));
    // 跨平台:Windows 形绝对路径在非 Windows 宿主上 path.resolve 不认,用 win32 解析;宿主形的用宿主 path。
    const useWin = winAbs && !path.isAbsolute(p);
    const rel = useWin ? path.win32.relative(path.win32.resolve(base), path.win32.resolve(p)) : path.relative(base, path.resolve(p));
    if (rel && !/^\.\.(?:[\\/]|$)/.test(rel) && !path.isAbsolute(rel) && !path.win32.isAbsolute(rel)) {
      p = rel.replace(/\\/g, '/');
      notes.push('the absolute pattern lies inside root and was applied relative to it');
    } else {
      return { pattern: p, outside: true, note: 'the pattern is an absolute path outside root, so it matches nothing; use a pattern relative to root, or set root to that directory' };
    }
  }
  return { pattern: p, outside: false, note: notes.join('; ') };
}

// v0.8-S1: image/binary suffixes that file_read refuses (routes user to the vision channel instead).
// NOTE: 'svg' is deliberately NOT here — SVG is XML text with real read/edit workflows.
const HARD_IGNORE_DIRS = Object.freeze(['.git', '.svn', '.hg']);
const BROWSE_IGNORE_DIRS = Object.freeze(['node_modules', '.git', '.venv']);
const DEFAULT_IGNORE_DIRS = Object.freeze([
  'node_modules', '.git', '.svn', '.hg', '.venv', 'venv', '__pycache__', 'site-packages',
  '.mypy_cache', '.pytest_cache', '.ruff_cache', '.tox', '.idea', '.gradle',
  'dist', 'build', 'out', 'target', 'coverage', '.next', '.nuxt', '.cache',
  '.claude/worktrees',
]);
const DOTNET_PROJECT_RE = /\.(?:csproj|fsproj|vbproj)$/i;
// 调用方【显式点名】的目录不剪(审计 native-files #1):glob / 正则 / root 里以字面段出现的名字(`dist/**/*.js`、root=…/build)。
// 只豁免默认清单(DEFAULT_IGNORE_DIRS)里的项;.git/.svn/.hg 与调用方自己传的 ignoreDirs 照剪。
// 不是字面段的(`*`、`{a,b}`、含通配的段)不算点名 —— 宁可保守地剪,剪掉的会在 prunedDirs 里说出来。
function explicitSegmentsOfGlob(glob) {
  return String(glob == null ? '' : glob).replace(/\\/g, '/').split('/').map(x => x.trim()).filter(x => x && !/[*?[\]{}]/.test(x));
}
// file_list.pattern 是正则:去掉转义的点与首尾锚,按 '/' 切,只认 [\w.-]+ 的整段。
function explicitSegmentsOfRegex(src) {
  return String(src == null ? '' : src).replace(/\\\./g, '.').replace(/\\\//g, '/').replace(/^\^/, '').replace(/\$$/, '')
    .split('/').map(x => x.trim()).filter(x => /^[\w.-]+$/.test(x));
}
function buildIgnoreMatcher(opts = {}) {
  const fold = s => (String(s));
  const base = opts.includeIgnored === true ? HARD_IGNORE_DIRS : (opts.browse === true ? BROWSE_IGNORE_DIRS : DEFAULT_IGNORE_DIRS);
  const extra = Array.isArray(opts.ignoreDirs) ? opts.ignoreDirs : [];
  const allow = new Set((Array.isArray(opts.allowDirs) ? opts.allowDirs : []).map(x => fold(String(x || '').trim())).filter(Boolean));
  const hard = new Set(HARD_IGNORE_DIRS.map(fold));
  const names = new Set();
  const paths = new Set();
  const norm1 = raw => String(raw || '').trim().replace(/\\/g, '/').replace(/^\.?\/+/, '').replace(/\/+$/, '');
  for (const raw of base) {
    const s = norm1(raw);
    if (!s) continue;
    const f = fold(s);
    if (s.includes('/')) { if (!s.split('/').every(seg => allow.has(fold(seg)))) paths.add(f); }
    else if (hard.has(f) || !allow.has(f)) names.add(f);
  }
  for (const raw of extra) {
    const s = norm1(raw);
    if (!s) continue;
    (s.includes('/') ? paths : names).add(fold(s));
  }
  const dotnet = opts.includeIgnored !== true && opts.browse !== true && !(allow.has('bin') || allow.has('obj'));
  // dirEntries:该目录的 Dirent 列表(判 .NET 用);relSlash:相对遍历根、以 '/' 分隔的路径。
  return {
    dotnet, names, paths,
    pruneName(name, relSlash, dotnetDir) {
      const n = fold(name);
      if (names.has(n)) return true;
      if (dotnetDir && (n === 'bin' || n === 'obj')) return true;
      return paths.size > 0 && paths.has(fold(relSlash));
    },
  };
}

// walkFiles opts:
//   maxFiles      结果条数上限(默认 500);只数【发出的】条目(见 accept / emitDirs)
//   maxDepth      最深下钻层数(默认 8)         recursive:false → 只列 base 一层
//   pattern       相对路径正则(file_list;回溯失控的交给 worker,见上)   ignoreCase:false → 区分大小写
//   accept(rel,isDir)   谓词:不接受的条目不发出、不占配额(目录照样下钻)—— glob / 内容搜索 / 符号搜索把自己的过滤放这里,
//                       修前是先按遍历顺序截 N 条再事后过滤,前 N 条全是无关文件时一个都找不到
//   emitDirs      false → 目录不进结果(仍下钻);内容类工具用,目录不再吃文件配额
//   bfs           true → 广度优先(先把浅层列全再往下;project_snapshot / 递归 file_list 用)
//   maxVisited    最多检视这么多目录项(默认 300000),兜住「几乎没有命中的超大树」的耗时
//   ignoreDirs / includeIgnored / browse / allowDirs   见 buildIgnoreMatcher(allowDirs = 调用方显式点名、不剪的目录名)
//   skipHidden    true → 跳过 '.' 开头的文件/目录(内容搜索默认;file_list/glob 不用,.github/ 之类要看得见);
//                 allowHidden:[名字] 是显式点名的例外(其子树内的隐藏项一并放行)
//   pattern 对【以 '/' 分隔】的相对路径求值(Windows 上也是,否则文档里的 ^src/.*\.ts$ 永远配不上)
// 返回数组,另挂:truncated / truncatedReason('maxFiles'|'maxVisited'|'patternTimeout')/ patternTimedOut / visited / prunedDirs。
function classifyListPattern(raw, root) {
  const p = String(raw == null ? '' : raw);
  if (!p) return { kind: 'none' };
  let compiles = true;
  try { new RegExp(p, 'i'); } catch { compiles = false; }
  // `.*` / `.?` 在能编译时按正则理解(`src/.*` 是正则);编译不过的(以 `*` 开头,如 `*.*`)只可能是 glob。
  // 绝对路径(`C:\\ws\\src\\*.js` / `/ws/src/*.js`)带 `*` 只可能是 glob:正则是拿【相对】路径去配的,绝对路径当正则什么也配不上;
  // 而 Windows 形绝对路径满是反斜杠,下面的「不含正则专属字符」判据会把它挡在 glob 之外(Windows CI 实测 file_list 空表)。
  const absLike = path.win32.isAbsolute(p) || path.isAbsolute(p);
  const globish = p.includes('*') && (absLike || (!/[\^$()|\\+{}[\]]/.test(p) && (!compiles || !/\.[*?]/.test(p))));
  if (globish) {
    // 前导 ./、落在 root 里的绝对路径 → 相对 root 的写法;root 之外的绝对路径什么也配不上(明说)。
    const gp = normalizeGlobPatternForRoot(p, root);
    const baseNote = 'pattern looks like a glob and was applied as one (no "/" in it → matches the file name at any depth); pass a regular expression such as \\.js$ to use regex matching';
    if (gp.outside) return { kind: 'glob', accept: () => false, note: gp.note };
    const g = gp.pattern;
    const re = globToRegExp(/[\\/]/.test(g) ? g : '**/' + g);
    return { kind: 'glob', accept: rel => re.test(rel), note: baseNote + (gp.note ? '; ' + gp.note : '') };
  }
  if (compiles) return { kind: 'regex' };
  {
    let msg = '';
    try { new RegExp(p, 'i'); } catch (e) { msg = (e && e.message) || String(e); }
    return { kind: 'invalid', error: `pattern is not a valid regular expression: ${msg}`, hint: 'file_list.pattern is a regular expression tested against the relative path (e.g. \\.js$ or ^src/.*\\.ts$); for glob patterns use the glob tool, or write a glob such as **/*.js' };
  }
}

// v0.8-S1: grep v2. Backward compatible — with no new params the returned records are byte-identical
// to the S0 shape ({path, relativePath, line, text}). New optional params:
//   context(0-5): include N lines before/after each match; each result gains `context:[{line,text,match}]`
//                 (`match:true` marks the hit line; `>` markers are rendered by the caller display).
//   glob:         relative-path glob filter (reuses globToRegExp) restricting which files are scanned.
//   group:true:   results grouped by file as [{path, relativePath, matches:[...]}].
// When a vendored rg.exe is present (probeRg), file_search routes through `spawn rg --json` (NDJSON),
// mapping results back to this exact shape; on rg failure/timeout it silently falls back to this JS scan.
// v0.8-S2 fix (F2): normalize an LLM-supplied pattern once, for BOTH the JS and rg paths. Models very
// commonly emit PCRE inline-flag prefixes like `(?i)pass` — rg's Rust regex accepts them natively but
// JS `new RegExp` throws "Invalid group", which used to fail the whole tool. Steps:
//  1) strip a leading inline-flag group `(?…)` — `i` is already the scanner default; `m`/`s` are merged
//     into the JS flags (extraFlags); the rg path just gets the stripped pattern (unaffected semantics);
//  2) if the stripped pattern STILL doesn't compile, escape every metacharacter and search it as literal
//     text, reporting note:'invalid regex; searched as literal text' (surfaced as `patternNote`).
// Returns { pattern, extraFlags, note }.
function normalizeSearchPattern(rawPattern) {
  let pattern = String(rawPattern || '');
  let extraFlags = '';
  const m = pattern.match(/^\(\?([a-z]*)(?:-[a-z]+)?\)/);
  if (m) {
    pattern = pattern.slice(m[0].length);
    if (m[1].includes('m')) extraFlags += 'm';
    if (m[1].includes('s')) extraFlags += 's';
  }
  try { new RegExp(pattern); return { pattern, extraFlags, note: null }; }
  catch {
    return {
      pattern: pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      extraFlags,
      note: 'invalid regex; searched as literal text',
    };
  }
}


module.exports = { globToRegExp, levenshtein, normalizeGlobPatternForRoot, buildIgnoreMatcher, explicitSegmentsOfGlob, explicitSegmentsOfRegex, DOTNET_PROJECT_RE, DEFAULT_IGNORE_DIRS, classifyListPattern, normalizeSearchPattern };
