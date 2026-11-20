'use strict';
const { readServerSource } = require('./src-reader');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'ruyi-workbench', 'app', 'server.js');
const RUNALL = path.join(ROOT, 'dev-harness', 'run-all.js');
const ACC = path.join(ROOT, 'mcp', 'ai-computer-control');

let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

const server = readServerSource();
const claudeSync = fs.readFileSync(path.join(ROOT, 'ruyi-workbench/app/backend/claude-config-sync.cjs'), 'utf8');
const configSchema = fs.readFileSync(path.join(ROOT, 'ruyi-workbench/app/backend/config-schema.cjs'), 'utf8');
const runall = fs.readFileSync(RUNALL, 'utf8');

// ── S1: serveStatic 用段比较,startsWith 前缀判定绝迹 ─────────────────────────
const serveStaticBody = fs.readFileSync(path.join(__dirname, '../ruyi-workbench/app/backend/static-assets.cjs'), 'utf8');
ok(/pathWithinRoot\(full,/.test(serveStaticBody), 'S1: serveStatic 用 pathWithinRoot 段比较');
ok(!/full\.startsWith\(path\.normalize\(base\)\)/.test(serveStaticBody), 'S1: startsWith 前缀判定已移除');

// ── S2: settings.model 权属 sidecar;无条件 delete 绝迹 ──────────────────────
ok(claudeSync.includes('claude-settings-sync.json'), 'S2: 权属 sidecar 文件存在');
ok(/prevSyncedModel/.test(claudeSync), 'S2: 上次同步值追踪(prevSyncedModel)');
ok(!/else delete settings\.model;/.test(claudeSync), 'S2: 无条件 else delete settings.model 绝迹');
ok(/else if \(prevSyncedModel && settings\.model === prevSyncedModel\) delete settings\.model;/.test(claudeSync), 'S2: 仅权属可证时才删除');

const startNotices = fs.readFileSync(path.join(ROOT, 'ruyi-workbench/app/backend/server-start-notices.cjs'), 'utf8');
ok(!server.includes('function freeStalePort(') && !startNotices.includes('function freeStalePort(')
  && startNotices.includes('return await listenOnNextFreePort('), 'occupied ports use fallback without killing another process');

// ── S4: desktop_screenshot 输出路径写闸 ─────────────────────────────────────
const desktopTools = fs.readFileSync(path.join(ROOT, 'ruyi-workbench/app/backend/desktop-tool-handlers.cjs'), 'utf8');
ok(/guardFileToolPath\(outPathRaw, ctx, \{ tool: 'desktop_screenshot', write: true \}\)/.test(desktopTools), 'S4: 模型给定 outputPath 过 guardFileToolPath 写闸');

// ── S5: uiMode 回退 'simple' ────────────────────────────────────────────────
ok(/config\.uiMode : 'simple'/.test(configSchema), "S5: uiMode 非法值回退 'simple'");
ok(!/config\.uiMode : 'pro'/.test(configSchema), "S5: 回退 'pro' 绝迹");

// ── S6: orchestrate maxItems 三方对齐 64 ────────────────────────────────────
const toolSchemas = fs.readFileSync(path.join(ROOT, 'ruyi-workbench/app/backend/native-tool-schemas.cjs'), 'utf8');
ok(/type: 'array', minItems: 1, maxItems: 64,/.test(toolSchemas), 'S6: orchestrate_agents schema maxItems=64');
ok(!/maxItems: 32/.test(toolSchemas), 'S6: schema maxItems:32 绝迹');

// ── S7: D6 目录可用口径 ─────────────────────────────────────────────────────
const providerPrompt = fs.readFileSync(path.join(ROOT, 'ruyi-workbench/app/backend/provider-prompt.cjs'), 'utf8');
ok(/toolRequirementsMet\('web_search', caps, false, config\)/.test(providerPrompt), 'S7: D6 按 TOOL_REQUIRES 目录可用判定');

// ── S8: ACC 侧修复(静态)─────────────────────────────────────────────────────
const accAudit = fs.readFileSync(path.join(ACC, 'src', 'ai_computer_control', 'tools', 'audit.py'), 'utf8');
const accFs = fs.readFileSync(path.join(ACC, 'src', 'ai_computer_control', 'tools', 'filesystem.py'), 'utf8');
ok(/_SECRET_VALUE_PATTERNS/.test(accAudit) && /_scrub_value/.test(accAudit), 'S8: audit values remain redacted');
ok(/open\(path, "rb"\)/.test(accFs), 'S8: file reads use byte budgets');
// Native capture, clipboard paths and OCR are covered by the Mac protocol suites.

// ── S9: 端口审计在 + capabilities 毕业 ──────────────────────────────────────
const portAuditLib = (() => { try { return fs.readFileSync(path.join(__dirname, 'lib', 'port-audit.js'), 'utf8'); } catch { return ''; } })();
ok(/require\('\.\/lib\/port-audit'\)/.test(runall) && /function portAuditFromDir\(/.test(portAuditLib) && /function stripJsComments\(/.test(portAuditLib), 'S9: 端口唯一性审计真身在(lib/port-audit.js)且 run-all 引用');

// ── 单元矩阵: pathWithinRoot(prefix bug 的核心判定,导出直测)─────────────────
const mod = require(SERVER);
const root = '/ws';
const evil = '/ws-evil/x.txt';
const inner = path.join(root, 'sub', 'x.txt');
ok(mod.pathWithinRoot(inner, root) === true, 'U: 根内子路径 → true');
ok(mod.pathWithinRoot(root, root) === true, 'U: 根自身 → true');
ok(mod.pathWithinRoot(evil, root) === false, 'U: 兄弟前缀目录(public-evil 形) → false(prefix bug 核心)');
ok(mod.pathWithinRoot(path.join(root, '..', 'escape.txt'), root) === false, 'U: .. 逃逸 → false');

console.log('\nV17-REVIEW-FIXES STATIC E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
process.exitCode = fail ? 1 : 0;
