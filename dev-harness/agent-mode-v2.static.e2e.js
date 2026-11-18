require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离(本件 require server.js 走进程内白盒,不 spawn)
'use strict';
// 静态源锁 + 进程内白盒:代理模式 v2(2026-09-24)。
//  ① 单一入口:13f MCP_TOOLS 无 spawn_agent、有 orchestrate_agents/wait_agents/agent_result;buildOpenAiTools 三个工具同门
//     (subagentMaxPerTurn>0 offer、0 或 noAgentTools 全部不 offer);provider 与 MCP 两面同一份 schema。
//  ② 信封:buildAgentRunEnvelope 有界(单节点 summary ≤1500 按句截断、总量有上限、不带 result/toolEvidence/progressLog、
//     structuredResult 限长);cutAtSentence 按句截;agent_result 切片有界(默认 12000,上限 40000)。
//  ③ 后台解耦:09 后台分支不传 ctrl、事件打 background:true;02c finalizeAll 对 background 段不标 cancelled;
//     一次投递的三个登记点(drainBackgroundJobs 同一张 seen 表 / markAgentEnvelopeDelivered / notifyAgentRunEnvelope)。
//  ④ 界面零泄漏:04 appendLiveTail 对 subagentId 早退;chat-stream-runtime 的 compact 分支先判 subagentId、tool_use 无子卡
//     不画到顶层;turn-activity 的 compact/subagent/agent_workflow 三处过滤;静态重绘有 narrativeWorkflowCard(信封摘要)。
//  ⑤ 账本:recordCompactUsage 带 subagentId/runId 归属;usage-ledger 保留 runId。
//  ⑥ 窗口一致:agentNodeContextWindow —— Claude 节点未知模型 1M(不再 200K)、手填优先;09 runNode 不再出现 `|| 200000`。
//  ⑦ 旧会话兼容:interaction-prompts 工具动词表仍认 spawn_agent;两份 locale 保留 tools.verb.spawn_agent 且新增 agent_result。
//  ⑧ 提示词:06b 四段子代理文字(zh/en)不再提 spawn_agent;09 volatile 规则提 background:true / agent_result。
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-agent-mode-v2-static-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const repo = path.resolve(__dirname, '..');
const app = path.join(repo, 'ruyi-workbench', 'app');
const src = f => fs.readFileSync(path.join(app, 'src', f), 'utf8');
const workflowRunner = src('../backend/agent-workflow.cjs');
const workflowRoutes = src('../backend/agent-workflow-routes.cjs');
const pub = f => fs.readFileSync(path.join(app, 'public', f), 'utf8');
const srv = require(path.join(app, 'server.js'));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

// ① 单一入口
{
  const s13f = src('../backend/native-tool-schemas.cjs');
  ok(!/name: 'spawn_agent'/.test(s13f), '① 13f MCP_TOOLS 无 spawn_agent schema');
  ok(/name: 'orchestrate_agents'/.test(s13f) && /name: 'wait_agents'/.test(s13f) && /name: 'agent_result'/.test(s13f), '① 13f 有 orchestrate_agents / wait_agents / agent_result');
  ok(/background: \{ type: 'boolean'/.test(s13f) && /task: \{ type: 'string', description: 'single-agent shorthand/.test(s13f), '① orchestrate_agents schema 含顶层单代理简写与 background');
  const offered = srv.buildOpenAiTools({ subagentMaxPerTurn: 4, allowDesktopTools: false }, null, {}).map(t => t.function.name);
  ok(['orchestrate_agents', 'wait_agents', 'agent_result'].every(n => offered.includes(n)) && !offered.includes('spawn_agent'), '① buildOpenAiTools:三个代理工具同门 offer,无 spawn_agent');
  const off = srv.buildOpenAiTools({ subagentMaxPerTurn: 0 }, null, {}).map(t => t.function.name);
  ok(!off.some(n => /agent/.test(n)), '① subagentMaxPerTurn:0 → 三个代理工具都不 offer');
  const sub = srv.buildOpenAiTools({ subagentMaxPerTurn: 4 }, null, { noAgentTools: true }).map(t => t.function.name);
  ok(!sub.some(n => ['orchestrate_agents', 'wait_agents', 'agent_result'].includes(n)), '① noAgentTools(子回合)→ 三个代理工具都不 offer(禁嵌套)');
  const catalog = src('../backend/tool-catalog.cjs');
  const tiers = src('../backend/native-tool-tiers.cjs');
  // 137 集成重钉:spawn_agent 的兼容口(旧模型调它 → 翻译成单节点 orchestrate)仍在 TOOL_HANDLERS 里,而 tool-dispatch L4
  // 的安全不变量要求「每个注册工具都有 tier 与 pack 声明」—— 缺声明会让兼容口落到默认低档。「不 offer」由上面 ① 第一条钉。
  ok(/spawn_agent: 'exec'/.test(tiers) && /agent_result: 'read'/.test(tiers) && /agent_result: 'agents'/.test(catalog),
    '① 原生工具档位表把 spawn_agent 保留为 exec、agent_result 定为 read 并归入 agents 包');
  ok(!/if \(t\.name === 'spawn_agent'\) return false;/.test(src('../backend/mcp-server.cjs')), '① MCP tools/list 无需过滤 spawn_agent');
  ok(/pathname === '\/api\/agent-workflow\/wait'\) return agentWorkflowLoopbackRoute\(req, res, 'wait'\)/.test(workflowRoutes) && /pathname === '\/api\/agent-workflow\/result'\) return agentWorkflowLoopbackRoute\(req, res, 'result'\)/.test(workflowRoutes) && /async function agentWorkflowLoopbackRoute\(req, res, kind\)/.test(workflowRoutes), '① 工作流路由持有 wait/result 回环');
  ok(/\{ m: 'POST', p: '\/api\/agent-workflow\/wait', auth: 'body-token' \}/.test(src('../backend/http-route-policy.cjs')) && /\{ m: 'POST', p: '\/api\/agent-workflow\/result', auth: 'body-token' \}/.test(src('../backend/http-route-policy.cjs')), '① 01b 两条回环路由登记 body-token 门(同 launch)');
  const agentTools = src('../backend/agent-tool-handlers.cjs');
  ok(/function agentToolLoopback\(route, payload\)/.test(agentTools) && /'\/api\/agent-workflow\/wait'/.test(agentTools) && /'\/api\/agent-workflow\/result'/.test(agentTools) && /envelope: true/.test(agentTools), '① MCP 子进程:launch(envelope:true)/wait/result 三路回环');
  ok(/spawn_agent 已并入 orchestrate_agents/.test(agentTools), '① 旧 spawn_agent:MCP 子进程翻译成单节点、直调清晰拒绝');
  const short = srv.singleAgentShorthandNode({ task: 't', role: 'Worker', toolTier: 'edit', agentKey: 'k-1' });
  ok(short && short.id === 'k-1' && short.role === 'worker' && short.toolTier === 'edit', '① singleAgentShorthandNode:顶层简写 → 单节点');
  ok(srv.singleAgentShorthandNode({}) === null && srv.singleAgentShorthandNode({ task: 'x', agentKey: 'bad key!' }).id === 'agent', '① 简写:无 task 为 null;非法 agentKey 回落 agent');
  const legacy = srv.legacySpawnToOrchestrateArgs({ task: 't', dependsOn: ['a'], background: true, toolTier: 'read' });
  ok(legacy.task === 't' && legacy.background === true && legacy.toolTier === 'read' && !('dependsOn' in legacy), '① legacySpawnToOrchestrateArgs:参数面平移,dependsOn 丢弃');
}

// ② 信封
{
  const big = { id: 'run_env', status: 'succeeded', createdAt: '2026-09-24T00:00:00.000Z', completedAt: '2026-09-24T00:00:08.500Z', usageTotals: { inTok: 100, outTok: 50 }, costUsd: 0.01,
    nodes: Array.from({ length: 12 }, (_, i) => ({ id: 'n' + i, status: 'succeeded', result: ('第' + i + '段结论。').repeat(4000), toolCalls: 2, toolEvidence: { x: 1 }, progressLog: [{ text: 'p' }], artifacts: [{ tool: 'file_write', ref: 'C:/out/' + i + '.txt' }], structuredResult: { summary: 'S'.repeat(5000) } })) };
  const env = srv.buildAgentRunEnvelope(big);
  const total = env.nodes.reduce((n, r) => n + r.summary.length, 0);
  ok(env.kind === 'agent_envelope' && env.ok === true && env.runId === 'run_env' && env.nodes.length === 12, '② 信封基本形状');
  ok(env.nodes.every(r => r.summary.length <= 1501) && total <= 9 * 1000 + 12, '② 单节点 summary ≤1500 且总量 ≤9k(按节点均摊)');
  ok(env.nodes.every(r => !('result' in r) && !('toolEvidence' in r) && !('progressLog' in r)), '② 信封不带 result/toolEvidence/progressLog');
  ok(env.nodes.every(r => r.structuredResult && r.structuredResult.truncated === true && r.structuredResult.preview.length <= 2000), '② structuredResult 超长 → 截断预览');
  ok(env.nodes[0].artifacts[0] === 'C:/out/0.txt' && env.usage.toolCalls === 24 && env.usage.tokens.input === 100 && env.usage.costUsd === 0.01 && env.usage.durationMs === 8500, '② artifacts/usage 齐全');
  ok(/agent_result\(\{runId, nodeId\}\)/.test(env.more), '② more 指向 agent_result(多节点带 nodeId)');
  ok(JSON.stringify(env).length < 16000, '② 12 节点 × 40k 字全文的信封 < 16KB');
  const cut = srv.cutAtSentence('一句话。第二句话很长很长很长很长很长很长很长。第三句。', 25); // 27 字原文,25 上限 → 在第 23 字的句号后截
  ok(cut === '一句话。第二句话很长很长很长很长很长很长很长。…', '② cutAtSentence 在句末截 + 省略号(' + cut + ')');
  ok(srv.cutAtSentence('一句话。' + '长'.repeat(40), 30).length === 31 && srv.cutAtSentence('一句话。' + '长'.repeat(40), 30).endsWith('…'), '② 句末切点太靠前(<60%)时硬切 + 省略号');
  ok(srv.cutAtSentence('短句。', 100) === '短句。', '② 不超长原样返回');
  const envelopeSource = src('../backend/agent-run-envelope.cjs');
  ok(/const AGENT_RESULT_DEFAULT_CHARS = 12000;/.test(envelopeSource) && /const AGENT_RESULT_MAX_CHARS = 40000;/.test(envelopeSource), '② agent_result 默认 12000、上限 40000');
}

// ③ 后台解耦 + 一次投递
{
  const s09 = src('../backend/provider-turn.cjs') + src('../backend/agent-results.cjs');
  ok(/onEvent: detachedOnEvent, ctrl: null, onComplete: run => deliverAgentRunEnvelope\(session\.id, run\)/.test(s09), '③ 09 后台分支:不传 ctrl(回合结束不杀)、完成走信封投递');
  ok(/onEvent = evt => baseOnEvent\(evt && typeof evt === 'object' && !evt\.background \? \{ \.\.\.evt, background: true \} : evt\);/.test(workflowRunner), '③ runAgentWorkflow 后台 run 的事件打 background:true');
  ok(/background: isBackgroundRun,/.test(workflowRunner), '③ run 记录 background 字段');
  ok(/const AGENT_RUN_TERMINAL = new Set\(\['succeeded', 'failed', 'partial', 'stopped', 'interrupted', 'cancelled'\]\);/.test(s09), '③ 09 终态集');
  ok(/if \(subagentTurnCap > 0 && subagentTotal \+ nodeCount > subagentTurnCap\)/.test(s09), '③ 09 subagentMaxPerTurn 语义平移:本回合累计节点数上限');
  ok(![s09, workflowRunner].some(code => /spawnDispatches|subagentFanoutMax|reservedSubagentKeys/.test(code)), '③ 旧 spawn 批处理旁路已删');
  const s02c = src('../backend/turn-segments.cjs');
  ok(/if \(seg\.background === true && \(seg\.type === 'subagent' \|\| seg\.type === 'workflow'\)\) \{\s*if \(seg\.status === 'running' \|\| seg\.status === 'paused'\) seg\.status = 'background';\s*continue;/.test(s02c), '③ 02c finalizeAll:后台段标 background 不标 cancelled');
  const s11 = src('11-native-tools.js');
  const jobs = src('../backend/background-jobs.cjs');
  const jobBindings = ['markAgentEnvelopeDelivered', 'notifyAgentRunEnvelope', 'drainAgentEnvelopesText'];
  ok(jobBindings.every(name => s11.includes(`EventStreamHooks.${name} = BackgroundJobs.${name};`) && jobs.includes(`const ${name} =`)),
    '③ 后台账本连接一次投递三件套(登记已读 / 完成入账 / Claude 侧文本 drain)');
  // wave137 集成期竞态:通知先到、wait 后到 → wait 只回短回执;wait 先到 → 登记已读。两种先后顺序都恰好一次。
  ok(s11.includes('EventStreamHooks.isAgentEnvelopeDelivered = BackgroundJobs.isAgentEnvelopeDelivered;') && /const isAgentEnvelopeDelivered = \(session, runId\)/.test(jobs),
    '③ 后台账本连接已读查询钩子 isAgentEnvelopeDelivered');
  ok(/function settleWaitEnvelopes\(session, out\)/.test(s09) && /kind: 'agent_envelope_receipt', runId: env\.runId, status: env\.status, delivered: 'already'/.test(s09) && /resultObj = settleWaitEnvelopes\(session, await waitForAgentRunResults\(session\.id, requestedRunIds/.test(s09), '③ 09 wait_agents 经 settleWaitEnvelopes 结算:已送达 → 短回执,否则登记已读');
  ok(/if \(liveReg && liveReg\.session\) settleWaitEnvelopes\(liveReg\.session, out\);/.test(workflowRoutes) && /settleWaitEnvelopes\(snapshot, out\);/.test(workflowRoutes), '③ MCP 回环 wait 同一套结算(活回合内存会话 / 无活回合读快照 + mutateSession 落已读)');
  ok(!/function markDeliveredEnvelopes\(/.test(s09), '③ 09 旧的单向登记 markDeliveredEnvelopes 已被结算函数取代');
  ok(/const prefix = job\.kind === 'agent'/.test(jobs) && /\[代理完成通知；以下是交付信封/.test(jobs), '③ 后台账本 drainBackgroundJobs 对代理 job 用信封口径');
  const s05 = src('05-claude-engine.js');
  ok(/EventStreamHooks\.drainAgentEnvelopesText\(session\)/.test(s05) && /\[recoveryHistory, indexInjection, agentDeliveries, turnMemoryEnvelope\]/.test(s05), '③ 05 Claude/Kimi 下一回合开头拼入未读信封(同一张已读表)');
  ok(/const completion = run => deliverAgentRunEnvelope\(session\.id, run\);/.test(workflowRoutes) && !/appendAgentWorkflowSummaryToSession\(session\.id, run, \{ title/.test(workflowRoutes), '③ launch 完成投递信封(不追加整份助手摘要消息)');
}

// ④ 界面零泄漏
{
  const s04 = src('04-permission-runtime.js');
  ok(/function appendLiveTail\(reg, evt\) \{\s*if \(!reg \|\| !evt\) return;\s*\/\/[^\n]*\n\s*if \(evt\.subagentId\) return;/.test(s04), '④ 04 appendLiveTail 对 subagentId 事件早退');
  const csr = pub('js/chat-stream-runtime.js');
  ok(/case 'compact': \{\s*\/\/[^\n]*\n\s*if \(evt\.subagentId\) \{/.test(csr), '④ chat-stream-runtime:compact 先判 subagentId(不改父电量表/不进父叙事)');
  ok(/\} else if \(!evt\.subagentId\) \{\s*registerNarrativeTool\(live, evt, card\);/.test(csr), '④ chat-stream-runtime:带 subagentId 又没子卡的 tool_use 不画到顶层');
  ok(/if \(evt\.background === true\) \{\s*\/\/[^\n]*\n\s*d\.classList\.add\('sa-background'\);/.test(csr), '④ chat-stream-runtime:后台节点子卡标后台样式');
  const ta = pub('js/turn-activity.js');
  ok(/case 'compact': \{\s*if \(evt\.subagentId\) break;/.test(ta) && /case 'subagent': \{\s*if \(evt\.background === true\) break;/.test(ta) && /case 'agent_workflow': \{\s*if \(evt\.background === true\) break;/.test(ta), '④ turn-activity:子代理压缩/后台 run 事件不进父活动条');
  const ip = pub('js/interaction-prompts.js');
  ok(/const background = evt\.background === true;/.test(ip) && /t\('workflow\.run\.background'/.test(ip), '④ interaction-prompts:工作流卡后台样式');
  const csrS = pub('js/chat-static-renderer.js');
  ok(/function narrativeWorkflowCard\(segment, tools\)/.test(csrS) && /r\.kind === 'agent_envelope'/.test(csrS) && /background: 'narrative\.status\.background'/.test(csrS), '④ chat-static-renderer:静态重绘工作流卡 + 信封摘要;background 状态词');
  ok(!/Spawn Agent|Orchestrate Agent\b/.test(pub('locales/zh-CN.json')) && !/Spawn Agent|Orchestrate Agent\b/.test(pub('locales/en-US.json')), '④ 界面文案不再出现 Spawn Agent / Orchestrate Agent');
}

// ⑤ 账本归属
{
  const s10 = src('../backend/session-compaction.cjs');
  const compactRecords = src('../backend/compaction-records.cjs');
  ok(/function recordCompactUsage\(session, provider, sc, attribution\)/.test(compactRecords) && /attr && attr\.subagentId \? \{ subagentId/.test(compactRecords) && /attr && attr\.runId \? \{ runId/.test(compactRecords), '⑤ recordCompactUsage 带 subagentId/runId 归属');
  ok(/recordCompactUsage\(parentSession, r\.summaryProvider, r\.sc, \{ subagentId, runId \}\)/.test(s10), '⑤ 子代理自动压缩记账带归属');
  ok(/recordCompactUsage\(parentSession, provider, forced\.sc, \{ subagentId, runId \}\)/.test(src('../backend/subagent-runner.cjs')), '⑤ 子代理 forced_400 压缩记账带归属');
  ok(/rec\.runId = String\(entry\.runId\)\.slice\(0, 120\)/.test(src('../backend/usage-ledger.cjs')), '⑤ usage-ledger 保留 runId');
  ok(/kind: 'subagent', agentKey, subagentId, runId,/.test(src('../backend/subagent-runner.cjs')), '⑤ 子代理主行也带 runId');
}

// ⑥ 窗口一致
{
  ok(srv.agentNodeContextWindow({ engine: 'claude', model: 'no-such-model-zz' }, null, {}) === srv.CONTEXT_WINDOW_FALLBACK && srv.CONTEXT_WINDOW_FALLBACK === 1000000, '⑥ Claude 节点未知模型 → 1M 兜底(与主会话一致,不再 200K)');
  const key = srv.contextWindowOverrideKey('agent', 'claude', 'm-x');
  ok(srv.agentNodeContextWindow({ engine: 'claude', model: 'm-x' }, null, { contextWindowOverrides: { [key]: 300000 } }) === 300000, '⑥ Claude 节点手填窗口优先');
  ok(srv.agentNodeContextWindow({ engine: 'openai', model: 'm' }, { id: 'p', contextWindow: 64000 }, {}) === 64000, '⑥ openai 节点走 providerContextWindow(手填)');
  ok(!/contextWindowFromTable\(node\.model\) \|\| 200000/.test(workflowRunner) && /const dsWindow = agentNodeContextWindow\(node, provider, config\);/.test(workflowRunner), '⑥ runNode 用同一条链,200K 兜底已删');
}

// ⑦ 旧会话兼容
{
  ok(/spawn_agent: 'tools\.verb\.spawn_agent'/.test(pub('js/interaction-prompts.js')), '⑦ interaction-prompts 动词表仍认 spawn_agent(旧会话历史照常渲染)');
  for (const loc of ['zh-CN', 'en-US']) {
    const o = JSON.parse(pub('locales/' + loc + '.json'));
    ok(o['tools.verb.spawn_agent'] && o['tools.verb.agent_result'] && o['chat.agentBackground'] && o['workflow.run.background'] && o['narrative.status.background'] && o['chat.agentEnvelopeSummary'] && /\{\{list\}\}/.test(o['chat.agentEnvelopeArtifacts']), '⑦ ' + loc + ':保留 tools.verb.spawn_agent,新增 agent_result/后台/信封键');
  }
}

// ⑧ 提示词
{
  const s06b = src('../backend/prompt-registry.cjs');
  ok(!/spawn_agent/.test(s06b), '⑧ 06b 不再提 spawn_agent');
  ok(/orchestrate_agents\(\{task, background:true\}\)/.test(s06b) && /agent_result\(\{runId, nodeId\?\}\)/.test(s06b), '⑧ 06b asyncWork 讲 background:true 与 agent_result');
  const s09 = src('../backend/provider-turn.cjs') + src('../backend/agent-results.cjs');
  ok(/代理并行规则：当主线还有不依赖代理结果的工作可做时，orchestrate_agents 设置 background:true/.test(s09), '⑧ 09 volatile 后台规则');
  const providerPrompt = src('../backend/provider-prompt.cjs');
  ok(providerPrompt.includes("offeredNames.has('orchestrate_agents')") && !/offeredNames\.has\('spawn_agent'\)/.test(providerPrompt),
    '⑧ Provider 能力层按 orchestrate_agents 门控');
}

console.log('\nAGENT MODE V2 STATIC: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
process.exit(fail ? 1 : 0);
