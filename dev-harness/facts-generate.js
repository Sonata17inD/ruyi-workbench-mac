#!/usr/bin/env node
// Regenerate the project facts from the runtime registries and test inventory.
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FACTS_PATH = path.join(ROOT, 'facts.json');

function computeStatic() {
  // 工作台版本:package.json 与 00-boot.js VERSION 必须一致(不一致直接炸,先修再生成)。
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'ruyi-workbench', 'package.json'), 'utf8'));
  const boot = fs.readFileSync(path.join(ROOT, 'ruyi-workbench', 'app', 'src', '00-boot.js'), 'utf8');
  const bootV = (boot.match(/const VERSION = '([^']+)'/) || [])[1];
  if (pkg.version !== bootV) throw new Error(`版本不一致: package.json=${pkg.version} vs 00-boot.js=${bootV}`);
  // 原生工具:TOOL_HANDLERS 派发注册表键数(模型可经 toolCall 到达的工具全集,require 真身产物)。
  const srv = require(path.join(ROOT, 'ruyi-workbench', 'app', 'server.js'));
  const nativeTools = Object.keys(srv.TOOL_HANDLERS || {}).length;
  if (!nativeTools) throw new Error('TOOL_HANDLERS 计数为 0 —— 产物异常');
  // ACC 版本:pyproject.toml。
  const pyproj = fs.readFileSync(path.join(ROOT, 'mcp', 'ai-computer-control', 'pyproject.toml'), 'utf8');
  const accVersion = (pyproj.match(/^version = "([^"]+)"/m) || [])[1] || '';
  // e2e 件数与 live 跳过数。
  const e2eCount = fs.readdirSync(__dirname).filter(f => f.endsWith('.e2e.js')).length;
  const runall = fs.readFileSync(path.join(__dirname, 'run-all.js'), 'utf8');
  const skipBlock = (runall.match(/const SKIP = new Set\(\[([\s\S]*?)\]\)/) || [])[1] || '';
  const e2eLiveSkipped = (skipBlock.match(/'[^']+\.e2e\.js'/g) || []).length;
  const unitSuites = fs.readdirSync(path.join(__dirname, 'unit')).filter(f => f.endsWith('.test.js')).length;
  const accSmokes = fs.readdirSync(path.join(ROOT, 'mcp', 'ai-computer-control', 'tests')).filter(f => /^smoke_.*\.py$/.test(f)).length;
  // EC-A 真实基线:默认端口(00-boot.js DEFAULT_PORT 常量)。
  const defaultPort = parseInt((boot.match(/const DEFAULT_PORT = (\d+)/) || [])[1], 10);
  if (!Number.isInteger(defaultPort) || defaultPort <= 0) throw new Error('DEFAULT_PORT 未在 00-boot.js 找到 -- 产物异常');
  // EC-A:token 获取方式语义标记(47c S1) -- 浏览器经 POST /api/bootstrap 拿 token,HTML 不再明文下发。
  const tokenBootstrap = 'api-bootstrap';
  // EC-A:live probe 数 = SKIP 集大小(独立字段,语义是"live probe"非"跳过件";当前数值与 e2eLiveSkipped 相同)。
  const liveProbes = e2eLiveSkipped;
  return { workbenchVersion: pkg.version, accVersion, nativeTools, e2eCount, e2eLiveSkipped, unitSuites, accSmokes, defaultPort, tokenBootstrap, liveProbes };
}

// ACC 工具数:唯一权威来源 = 活注册表(FastMCP list_tools)。需要本机 venv;不在则保留旧值。
function probeAccTools() {
  const venvPy = path.join(ROOT, 'mcp', 'ai-computer-control', '.venv', 'bin', 'python');
  if (!fs.existsSync(venvPy)) return null;
  const r = cp.spawnSync(venvPy, ['-X', 'utf8', '-c',
    "import sys; sys.path.insert(0, r'mcp/ai-computer-control/src'); import ai_computer_control.server as s; print(len(s.mcp._tool_manager.list_tools()))"],
    { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  const n = parseInt(String(r.stdout || '').trim().split(/\r?\n/).pop(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const static_ = computeStatic();
const prev = (() => { try { return JSON.parse(fs.readFileSync(FACTS_PATH, 'utf8')); } catch { return {}; } })();
const accLive = probeAccTools();
const accTools = accLive != null ? accLive : (prev.accTools || null);
if (accLive == null) console.log('# 注意: 本机无 ACC venv,accTools 保留旧值 ' + accTools + '(CI acc-smoke 会做活注册表对账)');

const facts = {
  schema: 1,
  _comment: '由 dev-harness/facts-generate.js 生成，facts.static.e2e.js 校验。',
  _axes: {
    nativeTools: 'TOOL_HANDLERS 注册的工具数，含按需注册项。',
    accTools: 'ACC 活注册表 list_tools 数(venv 探针;CI acc-smoke 对账)。',
    e2eCount: 'dev-harness/*.e2e.js 总件数(含 live 跳过件)。',
    defaultPort: '00-boot.js DEFAULT_PORT 常量(默认监听端口;文档与实现各写各的防漂移)。',
    tokenBootstrap: '浏览器通过 POST /api/bootstrap 取得 UI token。',
    liveProbes: 'run-all.js SKIP 集中真 live probe 件数(需真实外部依赖;每条文件名须含 live 或在白名单)。',
  },
  generatedAt: new Date().toISOString(),
  workbenchVersion: static_.workbenchVersion,
  accVersion: static_.accVersion,
  nativeTools: static_.nativeTools,
  accTools,
  e2eCount: static_.e2eCount,
  e2eLiveSkipped: static_.e2eLiveSkipped,
  unitSuites: static_.unitSuites,
  accSmokes: static_.accSmokes,
  defaultPort: static_.defaultPort,
  tokenBootstrap: static_.tokenBootstrap,
  liveProbes: static_.liveProbes,
};
// 除 generatedAt 外与旧文件逐字段一致时沿用旧时间戳:重跑生成器不产生纯时间戳噪声(架构还债批 2)。
const withoutStamp = obj => JSON.stringify({ ...obj, generatedAt: null });
if (typeof prev.generatedAt === 'string' && withoutStamp(prev) === withoutStamp(facts)) facts.generatedAt = prev.generatedAt;
fs.writeFileSync(FACTS_PATH, JSON.stringify(facts, null, 2) + '\n');
console.log('# facts.json 已生成:');
for (const [k, v] of Object.entries(facts)) if (!k.startsWith('_')) console.log(`#   ${k}: ${v}`);
