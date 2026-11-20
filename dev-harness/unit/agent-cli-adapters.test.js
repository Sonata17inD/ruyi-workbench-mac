'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-cli-adapters-'));
process.env.RUYI_HOME = root;
for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL', 'MAX_THINKING_TOKENS', 'WCW_CLAUDE_CMDLINE_BUDGET']) delete process.env[k];
const app = path.resolve(__dirname, '../../ruyi-workbench/app');
const srv = require(path.join(app, 'server.js'));
const { AGENT_CLI_ADAPTERS } = srv;
const claude = AGENT_CLI_ADAPTERS.claude;
const plain = v => JSON.parse(JSON.stringify(v));   // 解析结果里的 undefined 字段(如缺 arguments 的 tool_use.input)按线上 JSON 口径比

const HEAD = ['-p', '--output-format', 'stream-json', '--verbose'];
const BRIDGE = ['--permission-prompt-tool', 'mcp__ruyi__permission_prompt'];
const noMcp = extra => ({ includeWorkbenchMcp: false, ...extra });

test('[A] Claude buildArgs 金样', async () => {
  const session = { id: 'sess_unitargs0001' };
  const build = (config, interactive = false) => claude.buildArgs({ config, session, basePrompt: 'hello', attachments: [], interactive });
  assert.deepEqual(await build(noMcp({ permissionMode: 'default', permissionBridge: true })),
    [...HEAD, ...BRIDGE, '--permission-mode', 'default']);
  assert.deepEqual(await build(noMcp({
    permissionMode: 'bypass', permissionBridge: true, includePartialMessages: true, betaInterleavedThinking: true,
    model: 'test-model-a', claudeThinkingEffort: 'high', maxTurns: 7,
  }), true), [...HEAD, '--input-format', 'stream-json', '--include-partial-messages', '--betas', 'interleaved-thinking',
    '--permission-mode', 'bypassPermissions', '--model', 'test-model-a', '--effort', 'high', '--max-turns', '7']);
  // 权限模式 × 权限桥:auto / bypass 不挂桥;内部名经 CLAUDE_PERMISSION_MODE_MAP 映射;空模式不传 --permission-mode。
  const MODES = { default: 'default', acceptEdits: 'acceptEdits', plan: 'plan', auto: 'auto', bypass: 'bypassPermissions', dontAsk: 'dontAsk', '': null };
  for (const [mode, cliMode] of Object.entries(MODES)) {
    for (const bridge of [true, false]) {
      const bridged = bridge && mode !== 'bypass' && mode !== 'auto';
      const want = [...HEAD, ...(bridged ? BRIDGE : []), ...(cliMode ? ['--permission-mode', cliMode] : [])];
      assert.deepEqual(await build(noMcp({ permissionMode: mode, permissionBridge: bridge })), want, `mode=${mode} bridge=${bridge}`);
    }
  }
  // 工作台 MCP:按会话落一份 MCP 配置;交互模式另禁原生 AskUserQuestion。
  const withMcp = await build({ includeWorkbenchMcp: true, permissionMode: 'plan', permissionBridge: false }, true);
  assert.deepEqual(withMcp.slice(0, 6), [...HEAD, '--input-format', 'stream-json']);
  assert.equal(withMcp[6], '--mcp-config');
  assert.match(withMcp[7], /workbench\.mcp\.sess_unitargs0001\.json$/);
  assert.ok(fs.existsSync(withMcp[7]), 'MCP 配置已落盘');
  assert.deepEqual(withMcp.slice(8), ['--disallowedTools', 'AskUserQuestion', '--permission-mode', 'plan']);
  const printMcp = await build({ includeWorkbenchMcp: true, permissionMode: 'plan', permissionBridge: false }, false);
  assert.deepEqual([...printMcp.slice(0, 5), ...printMcp.slice(6)], [...HEAD, '--mcp-config', '--permission-mode', 'plan']);
});

test('[A] Claude 参数、续接与启动路径', async () => {
  assert.deepEqual(claude.resumeArgs('sid-1'), ['--resume', 'sid-1']);
  assert.deepEqual(claude.extraArgs({ extraClaudeArgs: ['--foo', 'bar'] }), ['--foo', 'bar']);
  assert.deepEqual(claude.extraArgs({ extraClaudeArgs: '--foo' }), []);
  assert.deepEqual(claude.extraArgs({}), []);
  assert.equal(claude.appendSystemPromptFlag, '--append-system-prompt');
  const args = ['-p', 'x y'];
  assert.deepEqual(claude.prepareSpawn('/opt/homebrew/bin/claude', args), { command: '/opt/homebrew/bin/claude', args, opts: {} });
});

test('[E] 子进程环境金样', () => {
  const saved = { CLAUDE_CODE_USE_BEDROCK: process.env.CLAUDE_CODE_USE_BEDROCK, CLAUDE_CODE_USE_VERTEX: process.env.CLAUDE_CODE_USE_VERTEX };
  process.env.CLAUDE_CODE_USE_BEDROCK = '1';
  process.env.CLAUDE_CODE_USE_VERTEX = '1';
  try {
    const common = { RUYI_HOME: '/tmp/data' };
    const pick = (env, keys) => Object.fromEntries(keys.map(k => [k, env[k]]));
    const KEYS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'MAX_THINKING_TOKENS', 'RUYI_HOME', 'CLAUDE_CODE_SUBAGENT_MODEL'];
    const bearer = claude.buildEnv({ modelsApiBase: 'https://proxy.example.test/v1', modelsApiKey: 'sk-1', claudeAuthMode: 'bearer', model: 'test-model-a', thinkingBudget: 2048 }, common);
    assert.deepEqual(pick(bearer, KEYS), {
      ANTHROPIC_BASE_URL: 'https://proxy.example.test/v1', ANTHROPIC_AUTH_TOKEN: 'sk-1', ANTHROPIC_API_KEY: '', ANTHROPIC_MODEL: 'test-model-a',
      CLAUDE_CODE_USE_BEDROCK: '', CLAUDE_CODE_USE_VERTEX: '', MAX_THINKING_TOKENS: '2048', RUYI_HOME: '/tmp/data', CLAUDE_CODE_SUBAGENT_MODEL: undefined,
    });
    assert.equal(bearer.PATH, process.env.PATH);
    const xkey = claude.buildEnv({ modelsApiBase: 'https://gw.example.test', modelsApiKey: 'sk-2', claudeAuthMode: 'x-api-key', model: 'm-2' }, common);
    assert.deepEqual(pick(xkey, KEYS.slice(0, 7)), {
      ANTHROPIC_BASE_URL: 'https://gw.example.test', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_API_KEY: 'sk-2', ANTHROPIC_MODEL: 'm-2',
      CLAUDE_CODE_USE_BEDROCK: '', CLAUDE_CODE_USE_VERTEX: '', MAX_THINKING_TOKENS: undefined,
    });
    const auto = claude.buildEnv({ modelsApiBase: 'https://gw.example.test', modelsApiKey: 'sk-3', claudeAuthMode: 'auto' }, common);
    assert.deepEqual(pick(auto, KEYS.slice(0, 4)), { ANTHROPIC_BASE_URL: 'https://gw.example.test', ANTHROPIC_AUTH_TOKEN: 'sk-3', ANTHROPIC_API_KEY: 'sk-3', ANTHROPIC_MODEL: undefined });
    // 没配第三方端点:Bedrock/Vertex 不动,不凭空添 ANTHROPIC_*;thinkingBudget 为 0 不写 MAX_THINKING_TOKENS。
    const direct = claude.buildEnv({ thinkingBudget: 0 }, common);
    assert.deepEqual(pick(direct, KEYS.slice(0, 7)), {
      ANTHROPIC_BASE_URL: undefined, ANTHROPIC_AUTH_TOKEN: undefined, ANTHROPIC_API_KEY: undefined, ANTHROPIC_MODEL: undefined,
      CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', MAX_THINKING_TOKENS: undefined,
    });
    // 先后:骨架共有项盖过继承值;MAX_THINKING_TOKENS 在共有项之后写(共有项里同名也以配置为准)。
    const order = claude.buildEnv({ thinkingBudget: 10 }, { MAX_THINKING_TOKENS: 'common', RUYI_HOME: 'X' });
    assert.equal(order.MAX_THINKING_TOKENS, '10');
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

// ---- [P] 事件解析:输入行 → 期望的内部事件(基线 parseAgentCliEvent 的输出) ----
const CLAUDE_ROWS = [
  [{ type: 'system', subtype: 'init', session_id: 'sid-A', tools: [], model: 'm' }, [{ kind: 'init', sessionId: 'sid-A', subtype: 'init' }]],
  [{ type: 'system', subtype: 'compact_boundary' }, [{ kind: 'unknown', raw: { type: 'system', subtype: 'compact_boundary' } }]],
  [{ type: 'stream_event', session_id: 'sid-A', event: { type: 'message_start', message: { usage: { input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 10, output_tokens: 1 } } } },
    [{ kind: 'msg_usage', usage: { input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 10, output_tokens: 1 } }]],
  [{ type: 'stream_event', session_id: 'sid-A', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'plan: ' } } },
    [{ kind: 'thinking', text: 'plan: ', partial: true, index: 0 }]],
  [{ type: 'stream_event', session_id: 'sid-A', event: { type: 'content_block_delta', index: 0, delta: { type: 'reasoning_delta', reasoning: 'r' } } },
    [{ kind: 'thinking', text: 'r', partial: true, index: 0 }]],
  [{ type: 'stream_event', session_id: 'sid-A', event: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'xx' } } },
    [{ kind: 'unknown', raw: { type: 'stream_event', session_id: 'sid-A', event: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'xx' } } } }]],
  [{ type: 'stream_event', session_id: 'sid-A', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hel' } } },
    [{ kind: 'text', text: 'Hel', partial: true, index: 1 }]],
  [{ type: 'stream_event', session_id: 'sid-A', event: { type: 'message_delta', usage: { output_tokens: 33 } } }, [{ kind: 'msg_usage', usage: { output_tokens: 33 } }]],
  [{ type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'bare' } }, [{ kind: 'text', text: 'bare', partial: true, index: 2 }]],
  [{ type: 'assistant', session_id: 'sid-A', message: { role: 'assistant', usage: { input_tokens: 120, output_tokens: 40 }, content: [
    { type: 'thinking', thinking: 'plan: ' }, { type: 'redacted_thinking', data: 'zz' }, { type: 'text', text: 'Hello' }, { type: 'reasoning', text: 'why' },
    { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }, { type: 'image' }, null] } }, [
    { kind: 'msg_usage', usage: { input_tokens: 120, output_tokens: 40 } }, { kind: 'thinking', text: 'plan: ', partial: false },
    { kind: 'thinking', text: '[redacted thinking]', partial: false, redacted: true }, { kind: 'text', text: 'Hello', partial: false },
    { kind: 'thinking', text: 'why', partial: false }, { kind: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }]],
  [{ type: 'assistant', session_id: 'sid-A', message: { role: 'assistant', content: [] } },
    [{ kind: 'unknown', raw: { type: 'assistant', session_id: 'sid-A', message: { role: 'assistant', content: [] } } }]],
  [{ type: 'user', session_id: 'sid-A', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'toolu_1', is_error: false, content: 'a\nb' },
    { type: 'tool_result', tool_use_id: 'toolu_2', is_error: true, content: [{ type: 'text', text: 'boom' }] }, { type: 'text', text: 'x' }] } }, [
    { kind: 'tool_result', id: 'toolu_1', content: 'a\nb', isError: false },
    { kind: 'tool_result', id: 'toolu_2', content: [{ type: 'text', text: 'boom' }], isError: true }]],
  [{ type: 'user', session_id: 'sid-A', message: { role: 'user', content: '<task-notification>\n<task-id>x1</task-id>\n<tool-use-id>toolu_ag</tool-use-id>\n<output-file>C:\\fake\\x1.output</output-file>\n<status>completed</status>\n<summary>s</summary>\n<result>r &amp; done</result>\n</task-notification>' } },
    [{ kind: 'subagent_notification', taskId: 'x1', toolUseId: 'toolu_ag', outputFile: 'C:\\fake\\x1.output', status: 'completed', summary: 's', note: '', result: 'r & done', resultChars: 8, resultTruncated: false, failed: false }]],
  [{ type: 'user', session_id: 'sid-A', message: { role: 'user', content: 'plain user text' } },
    [{ kind: 'unknown', raw: { type: 'user', session_id: 'sid-A', message: { role: 'user', content: 'plain user text' } } }]],
  [{ type: 'result', subtype: 'success', is_error: false, result: 'Hello world', session_id: 'sid-A', duration_ms: 1234, num_turns: 3, total_cost_usd: 0.0456,
    usage: { input_tokens: 812, output_tokens: 214, cache_read_input_tokens: 500, cache_creation_input_tokens: 100 } },
  [{ kind: 'result', sessionId: 'sid-A', ok: true, subtype: 'success', result: 'Hello world',
    usage: { input_tokens: 812, output_tokens: 214, cache_read_input_tokens: 500, cache_creation_input_tokens: 100 }, costUsd: 0.0456, durationMs: 1234, numTurns: 3 }]],
  [{ type: 'result', subtype: 'error_during_execution', is_error: true, sessionId: 'sid-B', cost_usd: 0.01 },
    [{ kind: 'result', sessionId: 'sid-B', ok: false, subtype: 'error_during_execution', costUsd: 0.01 }]],
  [{ type: 'something_else', foo: 1 }, [{ kind: 'unknown', raw: { type: 'something_else', foo: 1 } }]],
  [{}, [{ kind: 'unknown', raw: {} }]],
  [null, [{ kind: 'unknown', raw: null }]],
  [42, [{ kind: 'unknown', raw: 42 }]],
  ['text', [{ kind: 'unknown', raw: 'text' }]],
];
test('[P] 事件解析金样(Claude stream-json),适配器与兼容出口同步', () => {
  for (const [row, want] of CLAUDE_ROWS) {
    assert.deepEqual(plain(claude.parseEvent(row)), want, `claude ${JSON.stringify(row).slice(0, 80)}`);
  }
  // 夹具 fixtures/fake-claude-long-process.jsonl(真 CLI 线上形状)逐行可解析,且不产生 unknown。
  const fixture = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'fake-claude-long-process.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));
  assert.ok(fixture.length > 10);
  for (const row of fixture) {
    const out = claude.parseEvent(row);
    assert.ok(out.length && out.every(e => e.kind !== 'unknown'), `fixture row ${row.type} 解析为已知事件`);
  }
});

function ledgerRows() {
  const dir = path.join(root, 'usage');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).flatMap(f => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)));
}
async function waitRows(n) {
  for (let i = 0; i < 100 && ledgerRows().length < n; i++) await new Promise(r => setTimeout(r, 20));
  await new Promise(r => setTimeout(r, 60));
  return ledgerRows();
}

test('[U] 用量记账金样', async () => {
  const strip = r => { const { ts, ...rest } = r; assert.match(ts, /^\d{4}-\d{2}-\d{2}T/); return rest; };
  claude.recordTurnUsage({ session: { id: 'sess_u1', turnSeq: 3 }, config: { model: 'test-model-u' }, billInMax: 1, billOutMax: 1,
    usage: { usage: { input_tokens: 812, output_tokens: 214, cache_read_input_tokens: 500, cache_creation_input_tokens: 100 }, costUsd: 0.0456 } });
  claude.recordTurnUsage({ session: { id: 'sess_u2', turnSeq: 1 }, config: { model: 'test-model-n', modelsApiBase: '' }, usage: null, billInMax: 300, billOutMax: 55 });
  claude.recordTurnUsage({ session: { id: 'sess_u3', turnSeq: 1 }, config: { modelsApiBase: 'https://proxy.example.test/v1' }, billInMax: 0, billOutMax: 0,
    usage: { usage: { input_tokens: 10, output_tokens: 2 }, costUsd: 0.5 } });
  claude.recordTurnUsage({ session: { id: 'sess_u4', turnSeq: 1 }, config: {}, usage: null, billInMax: 0, billOutMax: 0 });
  claude.recordTurnUsage({ session: { id: 'sess_u5', turnSeq: 1 }, config: {}, usage: { costUsd: 1 }, billInMax: 0, billOutMax: 0 });
  // hunt2-engines#2:Claude 的 input_tokens 不含缓存;重缓存回合(3 vs 5 万)修前被 appendUsageLedger 的 min 夹成 cachedInTok 3。
  // claudePricing 在场:定价仍按原始 input_tokens(3×1 + 500×2)/1e6,不因归一多算。
  claude.recordTurnUsage({ session: { id: 'sess_u7', turnSeq: 2 }, config: { model: 'test-model-h', claudePricing: { inputPerM: 1, outputPerM: 2, currency: 'USD' } }, billInMax: 0, billOutMax: 0,
    usage: { usage: { input_tokens: 3, output_tokens: 500, cache_read_input_tokens: 48000, cache_creation_input_tokens: 2000 }, costUsd: 0.1 } });
  const rows = (await waitRows(4)).map(strip);
  assert.deepEqual(rows, [
    { sessionId: 'sess_u1', engine: 'claude', provider: 'claude-cli', model: 'test-model-u', inTok: 1412, outTok: 214, cachedInTok: 600, cost: 0.0456, currency: 'USD', costTrusted: true, estimated: false, turnSeq: 3, kind: 'turn' },
    { sessionId: 'sess_u2', engine: 'claude', provider: 'claude-cli', model: 'test-model-n', inTok: 300, outTok: 55, cachedInTok: 0, cost: null, currency: null, costTrusted: true, estimated: true, turnSeq: 1, kind: 'turn' },
    { sessionId: 'sess_u3', engine: 'claude', provider: 'claude-endpoint:proxy.example.test', model: '', inTok: 10, outTok: 2, cachedInTok: 0, cost: null, currency: null, costTrusted: false, estimated: false, turnSeq: 1, kind: 'turn' },
    { sessionId: 'sess_u7', engine: 'claude', provider: 'claude-cli', model: 'test-model-h', inTok: 50003, outTok: 500, cachedInTok: 50000, cost: 0.001003, currency: 'USD', costTrusted: true, estimated: false, turnSeq: 2, kind: 'turn' },
  ], '有结果帧记真实行、无结果帧有计费下限记估算行、都没有不记');
});

test('[M] 其余逐 CLI 决定', async () => {
  assert.equal(claude.interactive({ engineMode: 'interactive' }), true);
  assert.equal(claude.interactive({ engineMode: 'legacy' }), false);
  assert.equal(claude.thinkingEffortLabel({ claudeThinkingEffort: 'xhigh' }), 'xhigh');
  assert.equal(claude.thinkingEffortLabel({ claudeThinkingEffort: '' }), 'default');
  for (const name of ['TaskOutput', 'Bash', '', undefined]) assert.equal(claude.isNativeAgentTool(name), false);
  const miss = 'No conversation found with session ID: abc';
  assert.equal(claude.isResumeMissingError(miss), true);
  assert.equal(claude.isResumeMissingError('Error: session ID abc does not exist'), true);
  assert.equal(claude.isResumeMissingError('auth failed: bad key'), false);
  const cfg = srv.normalizeConfig({ defaultWorkspace: root }).config;
  assert.deepEqual(await claude.buildAgentDefinitions(root, cfg, 6000), await srv.buildClaudeAgentDefinitions(root, cfg, 6000));
});

test.after(() => { try { srv.flushUsageLedgerSync(); } catch { /* ignore */ } fs.rmSync(root, { recursive: true, force: true }); });
