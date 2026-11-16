'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { safeJsonParse } = require('./ordinary-json.cjs');
function createCodeAudits({ files, privacy }) {
  const { buildIgnoreMatcher, readIfExists, walkFiles } = files;
  const { PrivacyGateway, privacySourceActive, privacySourceFragment, privacySourceLine, privacySourceLineOffsets, privacySourceMark } = privacy;
async function dependencyInventory(root) {
  const cwd = path.resolve(root || process.cwd());
  const candidates = [
    'package.json',
    'pnpm-lock.yaml',
    'package-lock.json',
    'yarn.lock',
    'requirements.txt',
    'pyproject.toml',
    'poetry.lock',
    'Pipfile',
    'Cargo.toml',
    'go.mod',
    'pom.xml',
    'build.gradle',
    'composer.json',
    '.tool-versions',
    '.node-version',
    // 2026-10 走查补:.NET / Ruby / Python 旧式与 uv / Conda / Bun / Deno / 版本钉文件(修前 .NET 项目一个清单都认不出,回 files:[])。
    'packages.config',
    'Directory.Packages.props',
    'Directory.Build.props',
    'NuGet.config',
    'Gemfile',
    'Gemfile.lock',
    'setup.py',
    'setup.cfg',
    'uv.lock',
    'bun.lockb',
    'bun.lock',
    'environment.yml',
    'environment.yaml',
    '.nvmrc',
    '.python-version',
    'deno.json',
    'deno.jsonc',
    'deno.lock',
  ];
  // 名字带通配的清单:*.csproj / *.fsproj / *.vbproj / *.sln、requirements-*.txt / requirements/*.txt 风格的 requirements*.txt。
  const MANIFEST_PATTERN_RE = /^(?:.+\.(?:csproj|fsproj|vbproj|sln|slnx)|requirements[-_.][\w.-]+\.txt|constraints[-_.][\w.-]+\.txt)$/i;
  const files = [];
  let rootNames = [];
  try { rootNames = await fsp.readdir(cwd); } catch { rootNames = []; }
  for (const name of rootNames.slice().sort()) {
    if (MANIFEST_PATTERN_RE.test(name) && !candidates.includes(name)) {
      const full = path.join(cwd, name);
      try { if ((await fsp.stat(full)).isFile()) candidates.push(name); } catch { /* 坏链接等:不算 */ }
    }
  }
  for (const rel of candidates) {
    const full = path.join(cwd, rel);
    if (fs.existsSync(full)) {
      // F14:只有 package.json 的内容会被用到(下面解析),其余 14 个清单文件只需存在与否 —— 别再白读 8 万字符再丢掉。
      files.push({ relativePath: rel, path: full, content: rel === 'package.json' ? await readIfExists(full, 80000) : '' });
    }
  }
  const packageJson = files.find(f => f.relativePath === 'package.json');
  let npm = null;
  if (packageJson) {
    // PowerShell 5.1 写出的 package.json 带 UTF-8 BOM;内容是 null / 数组 / 坏 JSON 时如实报 parseError,
    // 修前前者静默变成「没有任何依赖」,null 直接抛 TypeError。
    const raw = String(packageJson.content || '').replace(/^\uFEFF/, '');
    const BAD = Symbol('bad-json');
    const parsed = safeJsonParse(raw, BAD);
    const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
    if (!isObj(parsed)) {
      npm = { parseError: parsed === BAD ? 'package.json 不是合法的 JSON' : 'package.json 顶层不是对象', scripts: {}, dependencies: [], devDependencies: [], engines: {} };
    } else {
      npm = {
        scripts: isObj(parsed.scripts) ? parsed.scripts : {},
        dependencies: isObj(parsed.dependencies) ? Object.keys(parsed.dependencies) : [],
        devDependencies: isObj(parsed.devDependencies) ? Object.keys(parsed.devDependencies) : [],
        engines: isObj(parsed.engines) ? parsed.engines : {},
      };
    }
  }
  const out = { ok: true, root: cwd, files: files.map(({ content, ...f }) => f), npm };
  // 只看根这一层:monorepo 的根目录常常什么清单都没有(包都在 packages/*、src/*)。根下一个都没找到时,多看一层子目录并列出,
  // 免得回 files:[] 让人以为「没有依赖」。仍只下一层、跳过 node_modules/dist 等默认忽略目录、有数量上限。
  if (!files.length) {
    const ignore = buildIgnoreMatcher({});
    const nested = [];
    let scanned = 0;
    for (const name of rootNames.slice().sort()) {
      if (nested.length >= 100 || scanned >= 200) break;
      if (name.startsWith('.') || ignore.pruneName(name, name, false)) continue;
      const dir = path.join(cwd, name);
      let kids;
      try { if (!(await fsp.stat(dir)).isDirectory()) continue; kids = await fsp.readdir(dir); } catch { continue; }
      scanned += 1;
      for (const k of kids.slice().sort()) {
        if (candidates.includes(k) || MANIFEST_PATTERN_RE.test(k)) nested.push({ relativePath: name + '/' + k, path: path.join(dir, k) });
      }
    }
    if (nested.length) {
      out.nestedManifests = nested.slice(0, 100);
      out.note = '根目录下没有依赖清单;nestedManifests 是一层子目录里找到的(monorepo/多项目)。本工具只看根这一层的内容,对子目录请把 root 指到具体项目。';
    } else {
      out.note = '根目录及一层子目录都没有认得出的依赖清单;本工具只看顶层。更深的子项目请把 root 指过去。';
    }
  }
  return out;
}

// 上限参数:0 是合法的显式值(「不要」/「只看根」),不能被 `|| 默认值` 吞成默认;缺省/非数/负数才回落默认。
function auditLimit(v, dflt) {
  if (v == null || v === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt;
}
// 测试/夹具/假件:里面的「密钥」「innerHTML」是故意写的样例,不是风险(本仓 300 条 high 里 86 条是它们)。
// 默认跳过(报 skippedTestFiles 让模型知道),includeTests:true 才扫。只按【相对 root】的路径判,root 自己叫 tests 不影响。
const AUDIT_TEST_DIR_RE = /^(?:dev-harness|tests?|__tests__|__mocks__|fixtures?|mocks?|mockups?|testdata|test-data)$/i;
const AUDIT_TEST_FILE_RE = /(?:\.(?:test|spec|e2e)\.[A-Za-z0-9]+$|[_.]test\.(?:go|py|rb|rs|php)$|(?:^|[\\/])test_[^\\/]*\.py$|(?:^|[\\/])conftest\.py$)/i;
function isAuditTestPath(relativePath) {
  const segs = String(relativePath || '').split(/[\\/]/);
  return segs.slice(0, -1).some(seg => AUDIT_TEST_DIR_RE.test(seg)) || AUDIT_TEST_FILE_RE.test(relativePath);
}
// hardcoded-secret 的「值」判据:只有像真密钥的字面量才报。修前 `/(token|…)\s*[:=]\s*['"][^'"]{8,}/` 把三元式
// `includes(token) ? token : 'not-installed'`、`modelsApiKey: 'test-key'`、i18n 里「Password must be…」都报成 high。
// 值必须:≥8 个字符、无空白(说明文字排除)、不是占位符/模板/环境变量引用、不是纯字母(+ - _ .)的标识符/短语,
// 即要有数字或其它符号,且全是可打印 ASCII。known 前缀(sk-/ghp_/AKIA/xox…)或 ≥16 位字母数字混合 → confidence high,其余 medium。
const SECRET_PLACEHOLDER_RE = /^(?:\$\{|\{\{|<.*>$|%[^%]+%$|\*+$|x+$|\.+$)|(?:example|changeme|change[-_]?me|your[-_]|placeholder|dummy|sample|redacted|xxxx|fixme|todo|fake|mock|not[-_]installed|undefined|process\.env)/i;
function judgeSecretValue(value) {
  const v = String(value || '');
  if (v.length < 8 || /\s/.test(v)) return null;
  if (/[^\x21-\x7e]/.test(v)) return null;                    // 含中文/全角等非 ASCII:是本地化文案,不是密钥
  if (SECRET_PLACEHOLDER_RE.test(v)) return null;
  const hasDigit = /\d/.test(v), hasLetter = /[A-Za-z]/.test(v), hasSym = /[^A-Za-z0-9_.\-]/.test(v);
  // 没有数字也没有 . _ - 之外的符号 = 一个词 / 标识符 / 点分 i18n 键(`provider.auth.xApiKey`、`passwordInputField`、`not-installed`),不是密钥。
  if (!hasDigit && !hasSym) return null;
  if (/^(?:sk-|ghp_|gho_|ghs_|github_pat_|AKIA|xox[bap]-|AIza|eyJ)/.test(v) || (v.length >= 16 && hasDigit && hasLetter)) return 'high';
  return 'medium';
}
async function codeReviewScan(root, opts = {}) {
  const cwd = path.resolve(root || process.cwd());
  const maxFiles = auditLimit(opts.maxFiles, 1200);
  const maxFindings = auditLimit(opts.maxFindings, 300);
  const maxFileBytes = auditLimit(opts.maxFileBytes, 1024 * 1024) || 1024 * 1024;
  const includeTests = opts.includeTests === true;
  const absolute = opts.absolute === true;
  const files = await walkFiles(cwd, {
    recursive: true,
    maxFiles,   // walkFiles 内部 Math.max(1, …):0 实际只取 1 个文件,下面照实报 truncated
    maxDepth: auditLimit(opts.maxDepth, 8),
    ignoreDirs: opts.ignoreDirs,   // F2:追加到共用清单(buildIgnoreMatcher)
    includeIgnored: opts.includeIgnored === true,
  });
  const patterns = [
    // value 取捕获组 2,由 judgeSecretValue 判;字符串字面量里不含引号/空白才算候选(`[^'"\s]`)。键名后允许跟一个引号(JSON/YAML 风格 "password": "…")。
    { id: 'hardcoded-secret', severity: 'high', re: /(api[_-]?key|secret|token|passw(?:or)?d|pwd)['"]?\s*[:=]\s*['"]([^'"\s]{8,})['"]/i, hint: 'Possible hardcoded credential',
      judge: m => judgeSecretValue(m[2]) },
    // NE-14:修前 `\bexec\s*\(` 把每一处 `regex.exec(` 都当成 shell 执行(本仓 app/src 60 处命中 51 处是正则),sql-concat 不带词界又开了 i,
    // 命中的全是 querySelector/.delete(/Update 散文。收紧:裸调用要求前面不是 `.`/字母(排除 re.exec、fooexec),对象方法只认
    // child_process/cp 这类子进程对象;SQL 要求出现在字符串字面量里、有 SELECT…FROM / INSERT INTO / UPDATE…SET / DELETE FROM 的形状且拼接了变量。
    { id: 'shell-exec', severity: 'medium', confidence: 'low', codeOnly: true, re: /(?<![.\w$])(?<!\bfunction\s+)(?:execSync|exec|shell_exec|system)\(|\bInvoke-Expression\b|\bIEX\s|\b(?:child_process|childProcess|cp)\.(?:exec|execSync)\s*\(|\brequire\(\s*['"](?:node:)?child_process['"]\s*\)\.(?:exec|execSync)\s*\(|\bos\.system\s*\(|\bshell\s*[:=]\s*(?:true|True)\b/, hint: 'Shell execution needs input validation' },
    { id: 'sql-concat', severity: 'medium', confidence: 'medium', codeOnly: true, re: /(['"`])\s*(?:SELECT\s[^'"`]{1,200}?\sFROM\s|INSERT\s+INTO\s|UPDATE\s+\w+\s+SET\s|DELETE\s+FROM\s)[^'"`]*(?:\$\{|\1\s*\+)/i, hint: 'Possible SQL string interpolation' },
    // `x.innerHTML = ''`(清空容器)不是注入面:行里去掉所有「给 innerHTML 赋空字符串」之后再没有 innerHTML/document.write 才豁免。
    { id: 'xss-html', severity: 'medium', confidence: 'low', codeOnly: true, re: /(innerHTML|dangerouslySetInnerHTML|document\.write)\b/i, hint: 'HTML injection surface',
      judge: (m, line) => (/(?:innerHTML|dangerouslySetInnerHTML|document\.write)\b/i.test(line.replace(/\binnerHTML\s*=\s*(['"`])\1/g, '')) ? 'low' : null) },
    { id: 'broad-cors', severity: 'medium', confidence: 'medium', re: /(Access-Control-Allow-Origin.{0,40}\*|cors\(\s*\))/i, hint: 'Review CORS policy' },
    { id: 'disabled-tls', severity: 'high', confidence: 'high', re: /(NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0|rejectUnauthorized\s*:\s*false)/i, hint: 'TLS verification disabled' },
    { id: 'todo-marker', severity: 'low', confidence: 'high', re: /\b(TODO|FIXME|HACK|XXX)\b/i, hint: 'Unresolved engineering note' },
  ];
  const findings = [];
  let scannedFiles = 0;
  let skippedTestFiles = 0;
  let capped = false;
  const skippedLargeFiles = [];
  outer: for (const file of files.filter(f => f.type === 'file')) {
    if (findings.length >= maxFindings) { capped = true; break; }
    if (!/\.(js|jsx|ts|tsx|py|ps1|sh|php|rb|go|rs|java|cs|html|vue|svelte|sql|env|json|yml|yaml)$/i.test(file.path)) continue;
    if (!includeTests && isAuditTestPath(file.relativePath)) { skippedTestFiles += 1; continue; }
    if (file.size > maxFileBytes) { skippedLargeFiles.push(file.relativePath); continue; }
    scannedFiles += 1;
    const raw = await readIfExists(file.path, maxFileBytes);
    let sourceView = null, sourceOffsets = null;
    const lines = raw.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (/\{\s*id:\s*['"][\w-]+['"].*\bre:\s*\//.test(lines[i])) continue;
      // codeOnly 规则不看纯注释行(//、/*、*、#、<!--):注释里提到 exec( / innerHTML 不是风险点(hardcoded-secret 与 todo-marker 照旧全行扫)。
      const commentLine = /^\s*(?:\/\/|\/\*|\*|#|<!--)/.test(lines[i]);
      for (const ptn of patterns) {
        if (ptn.codeOnly && commentLine) continue;
        const m = ptn.re.exec(lines[i]);
        if (!m) continue;
        let confidence = ptn.confidence || 'medium';
        if (ptn.judge) {
          const j = ptn.judge(m, lines[i]);
          if (!j) continue;   // 判据不过:这条规则不报,但同一行还可能命中后面的规则 → 继续而不是 break
          confidence = j;
        }
        if (privacySourceActive() && !sourceView) {
          if (typeof opts.privacyGuard === 'function') await opts.privacyGuard(file.path);
          sourceView = await PrivacyGateway.projectSource(raw); sourceOffsets = privacySourceLineOffsets(raw);
        }
        findings.push(privacySourceMark({
          id: ptn.id,
          severity: ptn.severity,
          confidence,
          relativePath: file.relativePath,
          ...(absolute ? { path: file.path } : {}),
          line: i + 1,
          text: sourceView ? privacySourceLine(sourceView, raw, sourceOffsets, i + 1, 200, true) : lines[i].trim().slice(0, 200),
          hint: ptn.hint,
        }, ['/text'], sourceView));
        break;
      }
      if (findings.length >= maxFindings) { capped = true; break outer; }
    }
  }
  const counts = findings.reduce((acc, f) => {
    acc[f.severity] = (acc[f.severity] || 0) + 1;
    return acc;
  }, {});
  // NE-14:高危排前面(稳定排序,同级保持遍历顺序);counts 在 findings 之前 —— 名单再长被下游平切,也先看得到总数。
  const sevRank = { high: 0, medium: 1, low: 2 };
  const sorted = findings.map((f, i) => [f, i]).sort((a, b) => (sevRank[a[0].severity] - sevRank[b[0].severity]) || (a[1] - b[1])).map(x => x[0]);
  const out = { ok: true, root: cwd, counts, total: sorted.length, scannedFiles, findings: sorted };
  // 截断必须说出来(修前 300 条到顶、maxFiles 太小扫不到东西都「total: N」静悄悄):findings 数到 maxFindings,或遍历撞了文件数/耗时上限。
  const hints = [];
  if (capped) hints.push(`已达 maxFindings(${maxFindings}),后面还有发现没列出;调大 maxFindings,或缩小 root`);
  if (files.truncated === true) hints.push('文件数/耗时上限已到,部分文件没扫到;缩小 root 或调大 maxFiles');
  if (maxFiles === 0 || maxFindings === 0) hints.push('maxFiles / maxFindings 为 0:几乎不会扫描任何内容');
  if (!includeTests && skippedTestFiles) hints.push(`默认跳过了 ${skippedTestFiles} 个测试/夹具文件(dev-harness、test(s)、__tests__、fixtures、mockups、*.test.*、*.spec.*);includeTests:true 才扫`);
  if (hints.length) out.hint = hints.join(';');
  if (capped || files.truncated === true || maxFiles === 0 || maxFindings === 0) out.truncated = true;
  if (!includeTests && skippedTestFiles) out.skippedTestFiles = skippedTestFiles;
  if (skippedLargeFiles.length) out.skippedLargeFiles = skippedLargeFiles.slice(0, 20);
  if (files.prunedDirs) out.prunedDirs = files.prunedDirs;
  return out;
}

// frontend_audit 的「外部资源」判据。这是离线优先产品:任何指向外部 http(s) / `//` 主机的 src / href / url() / @import 都会在断网时加载失败。
// 修前的正则 `https?://(cdn|fonts|unpkg|jsdelivr|cdnjs|googleapis|gstatic)\.` 只认【第一个】主机标签叫这几个名字,
// ajax.googleapis.com / code.jquery.com / use.fontawesome.com / stackpath.bootstrapcdn.com / googletagmanager / `//cdn.x` / 任意 https://example.com/x.png 全漏。
// 排除:本机主机(localhost / 127.x / ::1 / 0.0.0.0,断网也通)、`<a href>` 导航链接(点了才出网,不影响页面加载)、
// 模板占位(`${}` / `{{}}` 开头的主机)。
// 单段主机名(`intranet`、`e`)与私网 IP 也排除:那是内网/本机,断外网也通,不是公网 CDN。
const FRONTEND_LOCAL_HOST_RE = /^(?:localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|0\.0\.0\.0|\[::1\]|[^.:]+)(?::\d+)?$/i;
const FRONTEND_EXT_URL_RES = [
  { kind: 'attr', re: /\b(?:src|href|srcset|poster|data-src)\s*=\s*["']?((?:https?:)?\/\/[^\s"'<>)\\/?#]+)/gi },
  { kind: 'css', re: /\burl\(\s*["']?((?:https?:)?\/\/[^\s"'<>)\\/?#]+)/gi },
  { kind: 'import', re: /@import\s+(?:url\(\s*)?["']?((?:https?:)?\/\/[^\s"'<>)\\/?#]+)/gi },
];
// 一行里第一个外部资源引用的主机,没有返回 null。
function findExternalAssetHost(line) {
  for (const { kind, re } of FRONTEND_EXT_URL_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line))) {
      if (kind === 'attr' && /^href/i.test(m[0])) {
        if (/<a\b[^>]*$/i.test(line.slice(0, m.index))) continue;   // <a href> 是导航不是资源
        if (/\brel\s*=\s*["']?(?:canonical|alternate|author|license|help|dns-prefetch|bookmark|next|prev)\b/i.test(line)) continue;   // 元信息链接,不会被加载
      }
      const host = m[1].replace(/^(?:https?:)?\/\//i, '');
      if (!host || /^[$({]/.test(host) || FRONTEND_LOCAL_HOST_RE.test(host)) continue;
      return host;
    }
  }
  return null;
}
async function frontendAudit(root, opts = {}) {
  const cwd = path.resolve(root || process.cwd());
  const maxFiles = auditLimit(opts.maxFiles, 800);
  const files = await walkFiles(cwd, {
    recursive: true,
    maxFiles,   // walkFiles 内部 Math.max(1, …):0 实际只取 1 个文件
    maxDepth: auditLimit(opts.maxDepth, 6),
    ignoreDirs: opts.ignoreDirs,   // F2:追加到共用清单(buildIgnoreMatcher)
    includeIgnored: opts.includeIgnored === true,
  });
  const issues = [];
  let scannedFiles = 0;
  const skippedLargeFiles = [];
  for (const file of files.filter(f => f.type === 'file' && /\.(html|htm|css|js|jsx|ts|tsx|vue|svelte)$/i.test(f.path))) {
    if (file.size > 1024 * 1024) { skippedLargeFiles.push(file.relativePath); continue; }
    scannedFiles += 1;
    const raw = await readIfExists(file.path, 1024 * 1024);
    let sourceView = null, sourceOffsets = null;
    const allLines = raw.split(/\r?\n/);
    const checks = [
      { id: 'external-asset', host: true, hint: 'External asset (CDN/font/script/image/stylesheet) will fail offline; bundle it locally' },
      // 只对「整页」文件有意义:.js/.ts 里常有一段 `<html>…</html>` 字符串模板(邮件/报告),不是页面。给出 <html 所在行。
      { id: 'missing-viewport', pageOnly: true, hint: 'HTML page may need a viewport meta tag', custom: text => (/<html[\s\S]*<\/html>/i.test(text) && !/<meta[^>]+viewport/i.test(text) ? (text.slice(0, text.search(/<html/i)).split(/\r?\n/).length) : 0) },
      { id: 'negative-letter-spacing', re: /letter-spacing\s*:\s*-\d/i, hint: 'Negative letter spacing often hurts UI polish' },
      { id: 'viewport-font-scaling', re: /font-size\s*:\s*[^;]*(vw|vmin|vmax)/i, hint: 'Viewport-scaled font size can overflow controls' },
      { id: 'one-note-gradient', re: /(radial-gradient|linear-gradient).{0,80}(purple|violet|slate|blue)/i, hint: 'Review for generic gradient-heavy visual style' },
    ];
    for (const check of checks) {
      if (check.pageOnly && !/\.(html?|vue|svelte)$/i.test(file.path)) continue;
      // NE-14:给出首个命中行号与片段(行号按原文件,规则定义行被滤掉也不偏);external-asset 不看注释行里的 CDN 链接。
      let hitLine = 0;
      let hitText = '';
      let hitCount = 0;
      let hitHost = '';
      if (check.custom) {
        hitLine = check.custom(raw);
        if (hitLine) hitText = (allLines[hitLine - 1] || '').trim().slice(0, 160);
      } else {
        for (let li = 0; li < allLines.length; li += 1) {
          const line = allLines[li];
          if (/\{\s*id:\s*['"][\w-]+['"].*\bre:\s*\//.test(line)) continue;
          if (check.id === 'external-asset' && /^\s*(?:\/\/|\*|\/\*|<!--)/.test(line)) continue;
          let hit = false;
          if (check.host) {
            const host = findExternalAssetHost(line);
            if (host) { hit = true; if (!hitHost) hitHost = host; }
          } else {
            check.re.lastIndex = 0;
            hit = check.re.test(line);
          }
          if (hit) { hitCount += 1; if (!hitLine) { hitLine = li + 1; hitText = line.trim().slice(0, 160); } }
        }
      }
      if (hitLine > 0) {
        if (privacySourceActive() && !sourceView) {
          if (typeof opts.privacyGuard === 'function') await opts.privacyGuard(file.path);
          sourceView = await PrivacyGateway.projectSource(raw); sourceOffsets = privacySourceLineOffsets(raw);
        }
        issues.push(privacySourceMark({ id: check.id, relativePath: file.relativePath, path: file.path, line: hitLine,
        text: sourceView ? privacySourceLine(sourceView, raw, sourceOffsets, hitLine, 160, true) : hitText,
        ...(hitHost ? { host: sourceView ? privacySourceFragment(sourceView, raw, hitHost) : hitHost } : {}), ...(hitCount > 1 ? { count: hitCount } : {}), hint: check.hint }, ['/text', ...(hitHost ? ['/host'] : [])], sourceView));
      }
    }
  }
  const out = { ok: true, root: cwd, scannedFiles, issues };
  // 截断要说出来:修前 maxFiles:3 只扫到 3 个文件,回 issues:[] 像「没问题」。
  const hints = [];
  if (files.truncated === true) hints.push('文件数/耗时上限已到,部分文件没扫到;缩小 root 或调大 maxFiles');
  if (maxFiles === 0) hints.push('maxFiles 为 0:几乎不会扫描任何内容');
  if (hints.length) { out.truncated = true; out.hint = hints.join(';'); }
  if (skippedLargeFiles.length) out.skippedLargeFiles = skippedLargeFiles.slice(0, 20);
  if (files.prunedDirs) out.prunedDirs = files.prunedDirs;
  return out;
}

async function claudeMdAudit(root) {
  const cwd = path.resolve(root || process.cwd());
  const files = await walkFiles(cwd, { recursive: true, maxFiles: 400, maxDepth: 5, pattern: '(^|\\\\|/)CLAUDE\\.md$' });
  const audits = [];
  for (const f of files.filter(_ => _.type === 'file')) {
    const content = await readIfExists(f.path, 200000);
    const checks = [
      // NE-14:英文关键词加词界 —— 修前 `test` 会命中 "latest",一份「latest thoughts, nothing else here」的 CLAUDE.md 也算写了命令。
      { id: 'purpose', ok: /\b(?:purpose|overview)\b|目标|说明/i.test(content) },
      { id: 'commands', ok: /\b(?:tests?|build|builds|lint|linting|run|npm|node|make|pytest)\b|```|命令|测试|构建/i.test(content) },
      { id: 'style', ok: /\b(?:style|conventions?|patterns?)\b|规范|约定/i.test(content) },
      { id: 'safety', ok: /\b(?:permissions?|secrets?|credentials?)\b|安全|权限|密钥/i.test(content) },
      { id: 'offline', ok: /\b(?:offline|air.?gap|intranet)\b|内网|离线/i.test(content) },
    ];
    audits.push({
      path: f.path,
      relativePath: f.relativePath,
      size: content.length,
      missing: checks.filter(c => !c.ok).map(c => c.id),
    });
  }
  return {
    ok: true,
    root: cwd,
    found: audits.length,
    audits,
    // 修前只要找到了文件就一律说「Update missing sections…」,即使 missing 全是空数组 —— 没缺东西却叫人去补。
    // 现在:没找到 → 建;有缺 → 点名缺哪些章节;都不缺 → 如实说「关键词都在」。检查本身只是关键词级(不评内容质量),note 照直说。
    recommendation: audits.length === 0
      ? 'Create CLAUDE.md with project overview, commands, conventions, safety/offline notes.'
      : (() => {
        const lacking = [...new Set(audits.flatMap(a => a.missing))];
        return lacking.length
          ? `Update missing sections (${lacking.join(', ')}) before relying on long-running agent work.`
          : 'No missing sections detected (keyword-level check only; it does not judge whether the content is accurate or complete).';
      })(),
    ...(audits.length ? { note: 'keyword-level check: a section counts as present when its keywords appear anywhere in the file; content quality is not judged.' } : {}),
  };
}

// F14:docs_search 只搜「文档」。修前 roots 的第一项是整个工作区,于是 300 个 src/*.js 里的命中把文档淹没
// (且 docs/ 被二次扫描、README 被塞一条合成的 "File contains" 记录)。现在:遍历工作区,只收文档后缀,
// 优先级 = 根下 README/CHANGELOG/CONTRIBUTING 等 → docs/doc/ 目录 → 其余;返回 truncated + scannedFiles + hint。

return { dependencyInventory, codeReviewScan, frontendAudit, claudeMdAudit };
}
module.exports = { createCodeAudits };
