'use strict';
const fs = require('node:fs');
const path = require('node:path');

function createLocalSupport({ externalRoot, manualsDirectory, paths }) {
// 118a-fix: 应用内手册阅读器的服务端事实源。
// 反模式治理:118a 的完成页只给了一行相对路径 + 「复制路径」,等于把用户推到文件管理器里自己找手册。
// 产品口径是「每件事都能在如意里做完」,所以手册改为应用内直接读:本端点只吐 markdown 原文,
// 前端用既有 marked + sanitizeNode 白名单管线渲染,不新增第二套解析器。
// 安全口径:docId 与 lang 都只在下面这张【源码写死】的白名单里查表,客户端字符串永不参与路径拼接,
// 因此不存在目录穿越面(id=../../.. 只会查不到表 -> 404)。
const HELP_DOC_FILES = Object.freeze({
  'user-guide': Object.freeze({ 'zh-CN': 'USER-GUIDE_CN.md', 'en-US': 'USER-GUIDE_EN.md' }),
  'admin-guide': Object.freeze({ 'zh-CN': 'ADMIN-GUIDE_CN.md', 'en-US': 'ADMIN-GUIDE_EN.md' }),
});
const HELP_DOC_LANGS = Object.freeze(['zh-CN', 'en-US']);
// 手册体量在 30~60KB 量级;512KB 上限只是防止有人把巨型文件放进 docs/manuals 后一次性灌进浏览器。
const HELP_DOC_MAX_BYTES = 512 * 1024;

// 手册目录。发布件把 docs/ 放在运行资源根目录(externalRoot),源码运行时是 <repo>/ruyi-workbench/docs。
// 与 staticBase() 同一口径:先看外部目录,不存在则回落打包内相对路径。
function helpDocsDir() {
  const ext = path.join(externalRoot(), 'docs', 'manuals');
  try { if (fs.existsSync(ext)) return ext; } catch { /* 探测失败按不存在处理 */ }
  return manualsDirectory;
}

// 标题取正文第一个一级标题;取不到就用文件名兜底(阅读器抬头永远有字)。
function helpDocTitle(markdown, fallback) {
  const line = String(markdown || '').split(/\r?\n/).find(l => /^#\s+\S/.test(l));
  return line ? line.replace(/^#\s+/, '').trim() : String(fallback || '');
}

// 118d: 「如意替你打开」的真动作通道。产品红线是不给路径让用户自己去文件管理器里找,
// 所以「打开数据目录 / 日志目录 / 工作文件夹 / 手册目录」由服务端直接把资源管理器开出来。
// 安全口径:请求只能传下面这张【源码写死】的枚举 key。绝对路径全部由服务端常量(paths.*)、
// 手册目录解析或当前会话的 cwd 推导,客户端字符串永不参与拼路径、也永不进 spawn 的 argv;
// 执行由 DesktopShell.revealInFinder 交接给 Mac Finder。
const OPEN_PATH_TARGETS = Object.freeze(['data', 'logs', 'workspace', 'manuals']);

// 118d: 应用内看日志。不是所有环境都有图形外壳(远程桌面/受控终端/精简部署),「打开日志目录」不能是
// 唯一出路,所以再给一条只读的尾部读取通道。日志文件名由服务端按当天日期自己生成,请求只能给行数。
const LOG_TAIL_MAX_LINES = 2000;
const LOG_TAIL_DEFAULT_LINES = 200;
// 只读文件尾部这么多字节再切行:日志按天滚动,单份也可能到几十 MB,整份读进内存没有必要。
const LOG_TAIL_MAX_BYTES = 2 * 1024 * 1024;

// 枚举 -> 绝对目录。data/logs 是 00-boot 的 paths 常量,manuals 复用手册阅读器的同一份目录解析,
// workspace 取当前会话 cwd;取不到就让调用方报 400,绝不去猜一个目录打开。
function openPathTargetDir(target, session) {
  if (target === 'data') return paths.data;
  if (target === 'logs') return paths.logs;
  if (target === 'manuals') return helpDocsDir();
  if (target === 'workspace') return String((session && session.cwd) || '');
  return '';
}

// 最近一份工作台日志(04-permission-runtime 的 logEvent 按天写 workbench-YYYY-MM-DD.ndjson)。
// 只在【服务端已知目录】里按【固定正则】筛文件名,不接受任何外部路径入参。
function latestLogFile() {
  let names = [];
  try { names = fs.readdirSync(paths.logs); } catch { return ''; }
  const hits = names.filter(n => /^workbench-\d{4}-\d{2}-\d{2}\.ndjson$/.test(n)).sort();
  return hits.length ? path.join(paths.logs, hits[hits.length - 1]) : '';
}

// 尾部若干行。startedMidFile 时首行大概率被切断(字节偏移不是行/字符边界),直接丢掉半行。
function tailLinesFromBuffer(buf, startedMidFile, wanted) {
  let text = buf.toString('utf8');
  if (startedMidFile) {
    const nl = text.indexOf('\n');
    text = nl >= 0 ? text.slice(nl + 1) : '';
  }
  const all = text.split(/\r?\n/).filter(line => line.length > 0);
  const lines = all.slice(Math.max(0, all.length - wanted));
  return { lines, more: all.length > lines.length };
}

  return { HELP_DOC_FILES, HELP_DOC_LANGS, HELP_DOC_MAX_BYTES, helpDocsDir, helpDocTitle, OPEN_PATH_TARGETS, LOG_TAIL_MAX_LINES, LOG_TAIL_DEFAULT_LINES, LOG_TAIL_MAX_BYTES, openPathTargetDir, latestLogFile, tailLinesFromBuffer };
}

module.exports = { createLocalSupport };
