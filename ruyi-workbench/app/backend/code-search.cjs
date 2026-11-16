'use strict';
const path = require('node:path');
function createCodeSearch({ files, privacy }) {
  const { assertSearchExecution, normalizeSearchPattern, readIfExists, regexScanFilesBounded, searchMaxFileBytes, walkFiles } = files;
  const { PrivacyGateway, privacySourceActive, privacySourceLine, privacySourceLineOffsets, privacySourceMark, privacyProjectSearch } = privacy;
const DOCS_SEARCH_SUFFIXES = /\.(?:md|mdx|markdown|txt|rst|adoc|asciidoc|org)$/i;
async function docsSearch(root, query, opts = {}) {
  assertSearchExecution(opts.signal);
  const cwd = path.resolve(root || process.cwd());
  // 空查询(或全空白)会匹配每一行的每个文件:修前返回满额 200 条无意义命中,还当成功。
  if (String(query == null ? '' : query).trim() === '') {
    return { ok: false, error: 'query 不能为空', hint: 'docs_search 需要要找的词或正则(例如 "安装" 或 "TODO|FIXME")。', root: cwd };
  }
  // v0.8-S3fix: normalize once via the shared sanitizer(见 file_search 的 (?i) 内联标志说明)。
  const nq = normalizeSearchPattern(query);
  const maxResults = Math.max(1, Number(opts.maxResults || 200));
  const files = await walkFiles(cwd, {
    signal: opts.signal,
    recursive: true,
    maxFiles: opts.maxFiles || 3000,
    maxDepth: opts.maxDepth || 8,
    emitDirs: false,
    accept: rel => DOCS_SEARCH_SUFFIXES.test(rel),
    ignoreDirs: opts.ignoreDirs,
    includeIgnored: opts.includeIgnored === true,
  });
  const rank = f => {
    const segs = f.relativePath.split(/[\\/]/);
    if (segs.length === 1) return 0;                       // 根下的 README.md / CHANGELOG.md …
    if (/^(?:docs?|documentation)$/i.test(segs[0])) return 1;
    return 2;
  };
  // 体积上限与 file_search 同一口径(默认 20MB,maxFileBytes 可调);修前 4MB 且超限的文件悄悄丢掉、scannedFiles 也不数。
  const maxFileBytes = searchMaxFileBytes(opts);
  const skippedLargeFiles = [];
  const cands = files.filter(f => f.type === 'file')
    .filter(f => { if (f.size > maxFileBytes) { skippedLargeFiles.push(f.relativePath); return false; } return true; })
    .sort((a, b) => rank(a) - rank(b) || (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
  const scanOnce = async pattern => {
    assertSearchExecution(opts.signal);
    const scan = await regexScanFilesBounded(cands, pattern, 'gi' + (nq.extraFlags || ''), {
      maxResults: maxResults + 1, regexTimeoutMs: opts.regexTimeoutMs, autoDecode: true, signal: opts.signal,
    });
    assertSearchExecution(opts.signal, scan);
    return scan;
  };
  let scan = await scanOnce(nq.pattern);
  let literalRetryNote = '';
  // 「合法但本意不是正则」的查询(`C:\Users`、`TODO (urgent)`、`foo[bar]`)能编译、却匹配不到本意的文本,修前静悄悄返回 0 条。
  // 零命中且没超时:按字面文本再搜一遍,命中了就说明是按字面搜到的(patternNote)。
  if (!scan.results.length && !scan.timedOut && !nq.note) {
    const lit = nq.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (lit !== nq.pattern) {
      const retry = await scanOnce(lit);
      if (retry.results.length) { scan = retry; literalRetryNote = 'regex matched nothing; matches below are for the query as literal text'; }
    }
  }
  await privacyProjectSearch(scan, opts);
  assertSearchExecution(opts.signal, scan);
  const hits = scan.results;
  const truncated = hits.length > maxResults || files.truncated === true || scan.timedOut;
  const out = { ok: true, root: cwd, query, matches: hits.slice(0, maxResults), scannedFiles: cands.length };
  if (truncated) {
    out.truncated = true;
    out.hint = hits.length > maxResults ? 'docs_search: more matches exist; raise maxResults or make the query more specific'
      : scan.timedOut ? 'docs_search: regex hit its time budget; results may be incomplete'
        : 'docs_search: file limit reached before all docs were scanned; pass a narrower root or raise maxFiles';
  }
  if (nq.note || literalRetryNote) out.patternNote = nq.note || literalRetryNote;
  if (skippedLargeFiles.length) {
    out.skippedLargeFiles = skippedLargeFiles.slice(0, 20);
    out.maxFileBytes = maxFileBytes;
  }
  if (files.prunedDirs) out.prunedDirs = files.prunedDirs;
  return out;
}

// ============================================================================
// v2.6 (M5 候选 D 波): codebase_symbol_search — 符号定义/引用检索(grep/ctags 级)。
// 论文教训(07 §5):裸 LLM 会幻觉不存在的类名、按名称相似而非代码级使用证据分配。本工具把「符号 → 文件级证据」
// 落成确定性检索:给定符号名,返回它在代码库中真实存在的定义/引用位置(文件:行号),让 codebase-audit 用证据而非名称说话。
// 诚实边界:定义分类是关键词启发式(非 AST),方法定义与调用在 grep 级不可靠区分,靠返回的 note 显式声明。
// ============================================================================
function escapeRegexLiteral(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, c => '\\' + c);
}

// 后缀表:2026-10 走查补上 psm1/vb/kt/kts/swift/scala/dart/lua/bat/cmd(修前这些语言的文件根本不扫,符号永远「没找到」),
// 以及 C++ 的 cxx/hxx。
const CODE_SYMBOL_SUFFIXES = /\.(js|mjs|cjs|jsx|ts|tsx|py|go|rs|java|cs|rb|php|c|h|cc|cpp|cxx|hpp|hxx|sh|ps1|psm1|vb|kt|kts|swift|scala|dart|lua|bat|cmd|sql|vue|svelte)$/i;
// 按语言分叉的定义写法(通用 function/class/type/const 关键字之外)。键 = 后缀正则,值 = 构造该语言额外 def 规则的函数。
// 全部是行级启发式(非 AST):宁可少报,也不把调用当定义 —— 方法定义要求「行首(可带修饰符)NAME(...) {」或「至少一个修饰符/返回类型」。
const SYMBOL_JS_LIKE = /\.(?:js|mjs|cjs|jsx|ts|tsx|vue|svelte)$/i;
const SYMBOL_C_FAMILY = /\.(?:c|h|cc|cpp|cxx|hpp|hxx)$/i;
const SYMBOL_TYPED_METHOD = /\.(?:c|h|cc|cpp|cxx|hpp|hxx|cs|java|dart)$/i;
const SYMBOL_JVM_SWIFT = /\.(?:kt|kts|swift|scala)$/i;
const SYMBOL_VB = /\.vb$/i;
const SYMBOL_PS = /\.(?:ps1|psm1)$/i;
const SYMBOL_BAT = /\.(?:bat|cmd)$/i;
const SYMBOL_NOT_METHOD = 'if|for|while|switch|catch|return|function|else|do|try|with|await|yield|typeof|new|throw|delete|case|using|lock|foreach|sizeof';
// 控制流/表达式关键字开头的行不是「返回类型 NAME(」形状的定义。
const SYMBOL_TYPED_NOT_DEF = '(?!(?:return|else|new|throw|await|yield|delete|case|goto|typeof|using|namespace|if|for|while|switch|do|catch|sizeof|foreach|lock|print|echo)\\b)';
// 关键字大小写不敏感、符号本身仍按 caseSensitive 走:把 sub → [Ss][Uu][Bb](一个 i 标志会连符号一起放开,`Foo` 就会命中 `FOO`)。
const symbolCi = w => String(w).replace(/[a-z]/gi, c => '[' + c.toUpperCase() + c.toLowerCase() + ']');
function symbolLanguageDefPatterns(file, esc, b, symFlag) {
  const out = [];
  const re = (src, flags) => new RegExp(src, flags === undefined ? symFlag : flags);
  const ciAlt = words => '(?:' + words.split('|').map(symbolCi).join('|') + ')';
  if (SYMBOL_JS_LIKE.test(file)) {
    // `function* gen` / `async function* gen`(通用 `function NAME` 要求 function 后是空白,生成器的 `*` 挡住了)。
    out.push({ kind: 'function', re: re('\\bfunction\\s*\\*\\s*' + esc + b) });
    // class 方法 / 对象字面量方法:行首(可带 static/async/get/set/访问修饰符/`*`)NAME(params) [: 返回类型] {。
    // 参数括号允许一层嵌套(默认值里的调用);以 `{` 结束才算定义,`foo(x);` / `foo(bar, function() {` 这类调用不中。
    // (符号本身是 if/for/catch… 这类控制流关键字时不出方法规则,否则 `if (x) {` 全算定义。)
    if (!new RegExp('^(?:' + SYMBOL_NOT_METHOD + ')$').test(esc)) {
      out.push({ kind: 'method', re: re('^\\s*(?:(?:public|private|protected|static|async|override|abstract|readonly|get|set|declare)\\s+|\\*\\s*)*(?:#)?' + esc + '\\s*(?:<[^>()]*>)?\\s*\\([^()]*(?:\\([^()]*\\)[^()]*)*\\)\\s*(?::\\s*[^;={]+)?\\{') });
    }
    // `NAME: function(` / `NAME: async (…) =>` 对象属性写成的函数。
    out.push({ kind: 'function', re: re('^\\s*' + esc + '\\s*:\\s*(?:async\\s+)?(?:function\\b|\\([^)]*\\)\\s*=>)') });
  }
  if (/\.go$/i.test(file)) {
    // 方法:`func (s *Server) Handle()`(接收者在 func 与方法名之间,通用 `func NAME` 够不着)。
    out.push({ kind: 'method', re: re('\\bfunc\\s*\\([^)]*\\)\\s*' + esc + b) });
  }
  if (/\.cs$/i.test(file)) {
    // 属性/字段:`public string Name { get; set; }`、`public int Count = 0;`、表达式体 `public int X => 1;`(修饰符是硬要求)。
    out.push({ kind: 'property', re: re('^\\s*(?:(?:public|private|protected|internal|static|readonly|virtual|override|abstract|sealed|new|required|const|volatile)\\s+)+[\\w<>\\[\\],.?]+\\s+' + esc + '\\s*(?:\\{|=>|=|;)') });
    // record / record struct / record class / delegate / namespace
    out.push({ kind: 'class', re: re('\\b(?:record(?:\\s+(?:struct|class))?|delegate\\s+[\\w<>\\[\\].?]+|namespace)\\s+' + esc + b) });
  }
  if (SYMBOL_TYPED_METHOD.test(file)) {
    // 带返回类型/修饰符的函数与方法(C / C++ / C# / Java / Dart):`int main(void)`、`public static void Main(string[] a)`、
    // `void Foo::bar()`、构造函数 `public Foo(int x)`。要求 NAME 前至少有一个类型/修饰符词,所以单独的 `Handle(x);` 调用不中。
    out.push({ kind: 'function', re: re('^\\s*' + SYMBOL_TYPED_NOT_DEF + '(?:[\\w:<>,.?\\[\\]]+\\s*[*&]*\\s+)+[*&]*(?:\\w+::)*' + esc + '\\s*(?:<[^>()]*>)?\\s*\\(') });
  }
  if (/\.java$/i.test(file)) out.push({ kind: 'class', re: re('\\brecord\\s+' + esc + b) });
  if (SYMBOL_C_FAMILY.test(file)) {
    // `} Foo_t;`(typedef struct {…} Foo_t,含单行写法)与 `typedef … Foo_t;`:别名名字才是被定义的那个。
    out.push({ kind: 'type', re: re('\\}\\s*(?:\\w+\\s*,\\s*)*' + esc + '\\s*[,;\\[]') });
    out.push({ kind: 'type', re: re('^\\s*typedef\\b[^;{]*[\\s*]' + esc + '\\s*(?:\\[[^\\]]*\\]\\s*)*;') });
    out.push({ kind: 'macro', re: re('^\\s*#\\s*define\\s+' + esc + b) });
  }
  if (SYMBOL_JVM_SWIFT.test(file)) {
    // Kotlin `fun Type.NAME`(扩展函数)/ `object NAME`;Swift `protocol|extension|actor|typealias`;Scala `object|case class`。
    out.push({ kind: 'function', re: re('\\bfun\\s+(?:<[^>]*>\\s*)?(?:[\\w.<>?]+\\.)?' + esc + b) });
    out.push({ kind: 'class', re: re('\\b(?:object|protocol|extension|actor|typealias|mixin)\\s+' + esc + b) });
  }
  if (/\.dart$/i.test(file)) out.push({ kind: 'class', re: re('\\b(?:mixin|extension|typedef)\\s+' + esc + b) });
  if (/\.lua$/i.test(file)) {
    // `function M.NAME(` / `function M:NAME(` / `local NAME =` / `M.NAME = function`
    out.push({ kind: 'function', re: re('\\bfunction\\s+(?:[\\w.]+[.:])?' + esc + b) });
    out.push({ kind: 'variable', re: re('\\blocal\\s+' + esc + b) });
    out.push({ kind: 'function', re: re('^\\s*(?:[\\w.]+\\.)?' + esc + '\\s*=\\s*function\\b') });
  }
  if (/\.rb$/i.test(file)) {
    out.push({ kind: 'function', re: re('\\bdef\\s+(?:self\\.)?' + esc + b) });
    out.push({ kind: 'class', re: re('\\bmodule\\s+(?:\\w+::)*' + esc + b) });
  }
  if (/\.rs$/i.test(file)) out.push({ kind: 'type', re: re('\\b(?:mod|union|static|macro_rules!)\\s+' + esc + b) });
  if (SYMBOL_PS.test(file)) {
    // PowerShell 关键字大小写不敏感:`Function Get-Foo`、`FUNCTION`、`filter`、`workflow`;`function global:Name`。
    out.push({ kind: 'function', re: re('\\b' + ciAlt('function|filter|workflow|configuration') + '\\s+(?:[\\w]+:)?' + esc + b) });
    out.push({ kind: 'class', re: re('\\b' + ciAlt('class|enum') + '\\s+' + esc + b) });
  }
  if (SYMBOL_VB.test(file)) {
    // VB 关键字大小写不敏感:Sub/Function/Property/Class/Module/Structure/Interface/Enum/Delegate/Event;Dim/Const。
    out.push({ kind: 'function', re: re('\\b(?:' + ciAlt('sub|function|property|event') + '|' + symbolCi('delegate') + '\\s+' + ciAlt('sub|function') + ')\\s+' + esc + b) });
    out.push({ kind: 'class', re: re('\\b' + ciAlt('class|module|structure|interface|enum') + '\\s+' + esc + b) });
    out.push({ kind: 'variable', re: re('\\b' + ciAlt('dim|const') + '\\s+' + esc + b) });
  }
  if (SYMBOL_BAT.test(file)) {
    // 批处理:`:label` 是子程序定义(`call :label` 是引用);`set NAME=` / `set /a NAME=` 是变量赋值。
    out.push({ kind: 'function', re: re('^\\s*:' + esc + '(?:\\s|$)') });
    out.push({ kind: 'variable', re: re('^\\s*@?' + symbolCi('set') + '\\s+(?:/[AaPp]\\s+)?"?' + esc + '=') });
  }
  return out;
}
// C/C++ 里 `struct Foo` / `class Foo` 只有后面接 `{`、`;`(前置声明)、`: 基类`、行尾才是定义;`typedef struct Foo Foo_t;` /
// `struct Foo *p;` 里的 Foo 只是引用。修前 `typedef struct Foo Foo_t` 被报成 Foo 的定义。
const SYMBOL_C_TYPE_TAIL = /^\s*(?:final\s*)?(?::[^;{]*)?(?:\{.*)?;?\s*$/;


async function codebaseSymbolSearch(root, opts = {}) {
  const cwd = path.resolve(root || process.cwd());
  const symbol = String(opts.symbol || '').trim();
  if (!symbol) return { ok: false, error: 'symbol 必填(要检索的符号名)' };
  if (symbol.length > 120) return { ok: false, error: 'symbol 过长(≤120 字符)' };
  const kind = String(opts.kind || 'any');
  if (kind !== 'any' && kind !== 'definition' && kind !== 'reference') return { ok: false, error: `kind 非法: ${kind}(仅 any|definition|reference)` };
  const wantDef = kind !== 'reference';
  const wantRef = kind !== 'definition';

  const esc = escapeRegexLiteral(symbol);
  // 词边界只在 symbol 首尾都是 \w([A-Za-z0-9_])时可靠:$foo/-bar 等含非 \w 的符号用字面匹配(诚实降级)。
  const b = (/^[A-Za-z0-9_]/.test(symbol) && /[A-Za-z0-9_]$/.test(symbol)) ? '\\b' : '';
  // F14:默认区分大小写(`User` 不再命中 `user`,`const user = new User()` 也不会被当成 User 的定义、把真正的
  // new User() 引用吞掉);caseSensitive:false 才放开。关键字(function/class/const…)带首字母大写变体。
  const symFlag = opts.caseSensitive === false ? 'i' : '';
  const wordRe = new RegExp(b + esc + b, symFlag);
  // 关键字带首字母大写变体(VB 的 Sub/Function),符号本身才区分大小写。
  const kw = (words, tail) => new RegExp('(?:\\b(?:' + words.split('|').flatMap(w => [w, w[0].toUpperCase() + w.slice(1)]).join('|') + ')\\s+)' + '(?:' + esc + ')' + tail, symFlag);
  const baseDefPatterns = [
    { kind: 'function', re: kw('function|func|fn|def|sub', b) },
    { kind: 'class', re: kw('class|interface|struct|enum|trait', b), cTail: true },
    { kind: 'type', re: kw('type', b) },
    { kind: 'variable', re: kw('const|let|var|val', b) },
  ];
  const patternsByFile = new Map();
  const defPatternsFor = relativePath => {
    const key = (/\.[A-Za-z0-9]+$/.exec(relativePath) || [''])[0].toLowerCase();
    let ps = patternsByFile.get(key);
    if (!ps) { ps = [...baseDefPatterns, ...symbolLanguageDefPatterns(key, esc, b, symFlag)]; patternsByFile.set(key, ps); }
    return ps;
  };

  // F2:后缀过滤放进遍历(accept),1500 的配额只数代码文件 —— 修前对【所有】文件先截 1500 再筛后缀,
  // 前 1500 个是别的东西时符号一个都找不到,还回 truncated:false。
  const files = await walkFiles(cwd, {
    recursive: true,
    maxFiles: opts.maxFiles || 5000,
    maxDepth: opts.maxDepth || 8,
    emitDirs: false,
    accept: rel => CODE_SYMBOL_SUFFIXES.test(rel),
    ignoreDirs: opts.ignoreDirs,
    includeIgnored: opts.includeIgnored === true,
  });
  const maxResults = Math.max(1, Number(opts.maxResults || 200));
  // 结果体积:每条命中只带相对路径(root 在顶层只出现一次),absolute:true 才补回绝对 path —— 修前 path 与 relativePath 在
  // definitions / references / files 三处各出现一遍,默认调用 76KB,自己就超过模型可见上限被拦腰截断(同 file_list 的 F12)。
  const absolute = opts.absolute === true;
  const definitions = [];
  const references = [];
  const fileMap = new Map();
  let truncated = false;
  let scannedFiles = 0;
  const skippedLargeFiles = [];

  outer: for (const file of files.filter(f => f.type === 'file' && CODE_SYMBOL_SUFFIXES.test(f.path))) {
    if (file.size > 1024 * 1024) { skippedLargeFiles.push(file.relativePath); continue; }
    scannedFiles += 1;
    const raw = await readIfExists(file.path, 1024 * 1024);
    let sourceView = null, sourceOffsets = null;
    const lines = raw.split(/\r?\n/);
    const defPatterns = defPatternsFor(file.relativePath);
    const cFamily = SYMBOL_C_FAMILY.test(file.relativePath);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      let defKind = null;
      // 超长行(压缩产物/数据表)不跑定义规则:行级正则在它们上面只会白烧时间,引用照旧计。
      for (const p of (line.length > 4000 ? [] : defPatterns)) {
        const m = p.re.exec(line);
        if (!m) continue;
        if (cFamily && p.cTail && !SYMBOL_C_TYPE_TAIL.test(line.slice(m.index + m[0].length))) continue;
        defKind = p.kind; break;
      }
      if (!defKind && !wordRe.test(line)) continue;
      const isDef = !!defKind;
      // kind 过滤:与 definitions/references 数组一致 —— 被过滤的命中不计数、也不进 files[],
      // 否则 kind='definition' 时顶层 referenceCount=0 而 files[].references>0,自相矛盾。
      if (isDef ? !wantDef : !wantRef) continue;
      // 已满 maxResults → 这是第 maxResults+1 条未过滤命中,截断(hitCap 语义,恰好满时不误报 truncated)。
      if (definitions.length + references.length >= maxResults) { truncated = true; break outer; }
      if (privacySourceActive() && !sourceView) {
        if (typeof opts.privacyGuard === 'function') await opts.privacyGuard(file.path);
        sourceView = await PrivacyGateway.projectSource(raw); sourceOffsets = privacySourceLineOffsets(raw);
      }
      let rec = fileMap.get(file.relativePath);
      if (!rec) { rec = { relativePath: file.relativePath, ...(absolute ? { path: file.path } : {}), definitions: 0, references: 0 }; fileMap.set(file.relativePath, rec); }
      if (isDef) {
        definitions.push(privacySourceMark({ relativePath: file.relativePath, ...(absolute ? { path: file.path } : {}), line: i + 1,
          text: sourceView ? privacySourceLine(sourceView, raw, sourceOffsets, i + 1, 500, true) : line.trim().slice(0, 500), kind: defKind }, ['/text'], sourceView));
        rec.definitions += 1;
      } else {
        references.push(privacySourceMark({ relativePath: file.relativePath, ...(absolute ? { path: file.path } : {}), line: i + 1,
          text: sourceView ? privacySourceLine(sourceView, raw, sourceOffsets, i + 1, 500, true) : line.trim().slice(0, 500) }, ['/text'], sourceView));
        rec.references += 1;
      }
    }
  }

  // F2:遍历撞了文件数/耗时上限 —— 「没找到」可能只是「没扫到」,必须说出来。
  const walkTruncated = files.truncated === true;
  const res = {
    ok: true, root: cwd, symbol, kind,
    definitionCount: definitions.length, referenceCount: references.length, fileCount: fileMap.size, truncated: truncated || walkTruncated,
    scannedFiles,
    definitions, references, files: Array.from(fileMap.values()),
    note: 'grep-level lexical identifier scan; definition classification is keyword-pattern heuristic, not AST-accurate. Method definitions vs calls are not reliably distinguished.' + (opts.caseSensitive === false ? '' : ' Matching is case-sensitive (pass caseSensitive:false to ignore case).'),
  };
  const hints = [];
  if (walkTruncated) hints.push('codebase_symbol_search: file limit reached before all code files were scanned, so a missing symbol may just be unscanned; narrow root or raise maxFiles');
  // 截断要说出来:撞 maxResults 时模型只看到前 N 条,不知道还有没有、怎么办。
  if (truncated) hints.push(`已达 maxResults(${maxResults}),后面还有命中没列出;调大 maxResults,或缩小 root / 用 kind:'definition' 只看定义`);
  // 一条定义都没有 ≠ 符号不存在:可能全是用法,也可能该语言的定义写法不在识别范围内。
  if (wantDef && !definitions.length) {
    hints.push(references.length
      ? '没有识别到定义,下面的命中可能只是用法(或该语言的定义写法不在识别范围内:支持 JS/TS/Python/Go/Rust/Java/C#/C/C++/Kotlin/Swift/Scala/Dart/Lua/Ruby/PHP/VB/PowerShell/批处理);可对命中行 file_read 确认,或用 file_search 精确找声明'
      : '没有找到该符号的任何定义或引用:确认拼写与大小写(默认区分大小写,caseSensitive:false 放开)、root 是否正确,或该语言的文件后缀不在扫描范围内');
  }
  if (hints.length) res.hint = hints.join(';');
  if (skippedLargeFiles.length) res.skippedLargeFiles = skippedLargeFiles.slice(0, 20);
  if (files.prunedDirs) res.prunedDirs = files.prunedDirs;
  return res;
}


return { docsSearch, codebaseSymbolSearch };
}
module.exports = { createCodeSearch };
