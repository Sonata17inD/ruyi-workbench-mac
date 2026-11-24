'use strict';
// Run with the absolute path to an installed Codex binary. Only synthetic local data is sent.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const binary = process.argv[2];
if (!binary || !path.isAbsolute(binary)) throw new Error('Pass the absolute path to codex');
const childTurn = Number(process.argv[3]);
const root = childTurn ? process.argv[4] : fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-codex-native-'));
const workspace = path.join(root, 'work');
if (!childTurn) fs.mkdirSync(workspace);
Object.assign(process.env, {
  HOME: root,
  CODEX_HOME: path.join(root, 'codex'),
  CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
  RUYI_HOME: path.join(root, 'ruyi'),
});

const { createRunner } = require('./lib/harness');
const test = createRunner('CODEX APP SERVER');
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let count = 0;
const resultFile = path.join(workspace, 'result.txt');
const policyFile = path.join(workspace, 'policy.txt');

async function respond(req, res) {
  if (req.url !== '/v1/responses') return res.writeHead(404).end();
  let body = '';
  for await (const part of req) body += part;
  const request = JSON.parse(body);
  assert.equal(req.headers.authorization, 'Bearer fixture-only');
  assert.equal(request.store, false);
  assert.equal(request.stream, true);
  const id = 'resp_' + ++count;
  assert.ok(count <= 9, 'unexpected extra Responses request');
  const text = { 4: 'fixture 1', 5: 'fixture 2', 7: 'fixture 3', 9: 'fixture 4' }[count];
  const output = (callId) =>
    JSON.stringify(
      request.input.find((item) => item.type === 'function_call_output' && item.call_id === callId)?.output || '',
    );
  if (count === 1) {
    const namespace = request.tools.find((tool) => tool.name === 'mcp__ruyi');
    assert.ok(namespace.tools.some((tool) => tool.name === 'tool_invoke_read'));
  }
  if (count === 2) {
    assert.match(output('fixture_1'), /meeting note/);
    test.ok(true, 'a model-issued MCP read returns the file content to the following inference step');
  }
  if (count === 3) {
    assert.match(output('fixture_2'), /denied/i);
    assert.equal(fs.existsSync(resultFile), false);
  }
  if (count === 4) {
    assert.match(output('fixture_3'), /create/);
    assert.equal(fs.readFileSync(resultFile, 'utf8'), 'approved');
    test.ok(true, 'a model-issued write is denied, then a fresh request succeeds after approval');
  }
  if (count === 7) {
    assert.match(output('fixture_6'), /blocked by permission mode/i);
    assert.equal(fs.existsSync(policyFile), false);
    test.ok(true, 'plan mode blocks a model-issued Ruyi file write without a prompt');
  }
  if (count === 9) {
    assert.match(output('fixture_8'), /create/);
    assert.equal(fs.readFileSync(policyFile, 'utf8'), 'approved');
    test.ok(true, 'acceptEdits executes the same Ruyi file write without a prompt');
  }
  const toolCall = !text;
  const tool =
    count === 1
      ? { name: 'file_read', arguments: { path: path.join(workspace, 'note.txt') } }
      : { name: 'file_write', arguments: { path: count < 4 ? resultFile : policyFile, content: 'approved' } };
  const item = toolCall
    ? {
        type: 'function_call',
        id: 'fc_' + count,
        call_id: 'fixture_' + count,
        namespace: 'mcp__ruyi',
        name: count === 1 ? 'tool_invoke_read' : 'tool_invoke_edit',
        arguments: JSON.stringify(tool),
        status: 'completed',
      }
    : {
        id: 'msg_' + count,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      };
  const frames = [
    { type: 'response.created', response: { id, status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    ...(!toolCall
      ? [{ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: text }]
      : []),
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: {
        id,
        status: 'completed',
        output: [item],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    },
  ];
  res
    .writeHead(200, { 'Content-Type': 'text/event-stream' })
    .end(frames.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join(''));
}
const service = http.createServer((req, res) =>
  respond(req, res).catch((error) => {
    test.fail(error.message);
    res.writeHead(400).end();
  }),
);

async function runTurn(turn, port) {
  const { COMPOSITION_FILE, resolveRuntimeComposition } = require('./src-reader');
  const entry = resolveRuntimeComposition(process.env.RUYI_TEST_SERVER_JS || COMPOSITION_FILE);
  const transport = require(path.join(path.dirname(entry), 'backend/codex-app-server.cjs'));
  // Point the selected runtime at this fixture before the turn driver imports the transport.
  const args = transport.appServerArgs;
  transport.appServerArgs = () => [
    ...args(),
    '-c',
    'model_providers.ruyi_chatgpt_plan.base_url="http://127.0.0.1:' + port + '/v1"',
  ];
  const runtime = require('./lib/server-internals').loadServerInternals([
    'CodexAccount',
    'runSessionTurn',
    'createSession',
    'loadSession',
    'mutateConfig',
    'readUsageRows',
    'RUNTIME',
    'handleApi',
    'pendingPermissions',
  ]);
  const bridge = http.createServer((req, res) => runtime.handleApi(req, res, new URL(req.url, 'http://127.0.0.1').pathname));
  await listen(bridge);
  try {
    runtime.RUNTIME.port = bridge.address().port;
    runtime.RUNTIME.token = 'fixture-workbench';
    runtime.CodexAccount.access = async () => ({ id: 'fixture-account', token: 'fixture-only' });
    const bindingFile = path.join(root, 'first-turn.json');
    let sessionId, firstThread;
    if (turn === 1) {
      fs.writeFileSync(path.join(workspace, 'note.txt'), 'meeting note');
      await runtime.mutateConfig(async (config) => {
        Object.assign(config, {
          codexPath: binary,
          defaultWorkspace: workspace,
          includeWorkbenchMcp: true,
          permissionMode: 'default',
        });
      });
      const session = await runtime.createSession({
        cwd: workspace,
        engineRoute: { engine: 'agent', agentCliType: 'codex', model: 'fixture-model' },
      });
      sessionId = session.id;
    } else {
      ({ sessionId, firstThread } = JSON.parse(fs.readFileSync(bindingFile, 'utf8')));
      if (turn > 2) {
        await runtime.mutateConfig(async (config) => {
          config.permissionMode = turn === 3 ? 'plan' : 'acceptEdits';
        });
      }
    }
    const events = [];
    const decisions = turn === 1 ? ['deny', 'allow'] : [];
    await runtime.runSessionTurn({
      sessionId,
      message: 'test ' + turn,
      source: 'http',
      onEvent(event) {
        events.push(event);
        if (event.type === 'permission_request') {
          const behavior = decisions.shift() || 'deny';
          setImmediate(() => runtime.pendingPermissions.get(event.requestId).resolve({ behavior }));
        }
      },
    });
    const saved = await runtime.loadSession(sessionId);
    assert.equal(events.find((e) => e.type === 'result')?.ok, true, JSON.stringify(events.at(-1)));
    const message = saved.messages.at(-1);
    assert.equal(message.content, 'fixture ' + turn);
    const expectedInput = [40, 10, 20, 20][turn - 1];
    assert.equal(message.usage.usage.input_tokens, expectedInput);
    assert.equal(message.usage.contextTokens, 15);
    const ledger = (await runtime.readUsageRows(0)).filter(row => row.sessionId === sessionId);
    assert.equal(ledger.length, turn);
    const { engine, provider, inTok, cost, costTrusted } = ledger.at(-1);
    assert.deepEqual({ engine, provider, inTok, cost, costTrusted },
      { engine: 'codex', provider: 'chatgpt-plan', inTok: expectedInput, cost: null, costTrusted: false });
    assert.deepEqual(decisions, []);
    assert.equal(events.filter(e => e.type === 'permission_request').length, turn === 1 ? 2 : 0);
    if (turn === 1) fs.writeFileSync(bindingFile, JSON.stringify({ sessionId, firstThread: saved.codexThread.id }));
    else assert.equal(saved.codexThread.id, firstThread);
  } finally {
    bridge.close();
  }
}

async function runSmoke() {
  const execFile = require('node:util').promisify(require('node:child_process').execFile);
  await listen(service);
  try {
    for (const turn of [1, 2, 3, 4]) {
      await execFile(process.execPath, [__filename, binary, String(turn), root, String(service.address().port)]);
    }
    assert.equal(count, 9);
    test.ok(true, 'a fresh Ruyi process resumes the persisted Codex thread and records only the new usage');
  } finally {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (childTurn) {
  runTurn(childTurn, Number(process.argv[5])).catch((error) => { console.error(error); process.exitCode = 1; });
} else {
  runSmoke().catch((error) => test.fail(error.stack)).finally(() => test.done());
}
