#!/usr/bin/env node
'use strict';
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
if (process.argv.includes('--version')) {
  console.log('codex-cli 0.test');
  process.exit(0);
}

const send = (frame) => process.stdout.write(JSON.stringify(frame) + '\n');
let threadId,
  turnId = 'turn-test';
function event(method, params) {
  send({ method, params: { threadId, turnId, ...params } });
}
function end(status = 'completed') {
  event('turn/completed', { turn: { id: turnId, status } });
}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params, result } = JSON.parse(line);
  if (method === 'initialized') return;
  if (!method) {
    if (id === 'approval') {
      event('item/completed', { item: { id: 'reply', type: 'agentMessage', text: result.decision } });
      end();
      return;
    }
    throw new Error('Unexpected RPC response');
  }
  const reply = (result) => send({ id, result });
  if (method === 'initialize') return reply({});
  if (method === 'thread/compact/start') {
    assert.equal(params.threadId, threadId);
    reply({});
    event('turn/started', { turn: { id: turnId } });
    end();
    return;
  }
  if (method.startsWith('thread/')) {
    assert.equal(params.modelProvider, 'ruyi_chatgpt_plan');
    threadId = params.threadId || require('node:crypto').randomUUID();
    fs.appendFileSync(
      path.join(process.cwd(), 'calls.jsonl'),
      JSON.stringify({ method, model: params.model, threadId }) + '\n',
    );
    return reply({ thread: { id: threadId }, model: params.model });
  }
  if (method === 'turn/interrupt') {
    reply({});
    end('interrupted');
    return;
  }
  if (method === 'turn/steer') {
    assert.equal(params.threadId, threadId);
    assert.equal(params.expectedTurnId, turnId);
    assert.deepEqual(params.input, [{ type: 'text', text: 'use a shorter answer' }]);
    return reply({ turnId });
  }
  assert.equal(method, 'turn/start');
  reply({ turn: { id: turnId } });
  const content = params.input[0].text;
  fs.appendFileSync(path.join(process.cwd(), 'inputs.jsonl'), JSON.stringify(content) + '\n');
  if (content.endsWith('crash')) {
    event('item/agentMessage/delta', { itemId: 'reply', delta: 'before disconnect' });
    process.stderr.write('fixture process interrupted\n', () => process.exit(23));
    return;
  }
  if (content.endsWith('quota')) {
    event('item/agentMessage/delta', { itemId: 'reply', delta: 'partial' });
    event('turn/completed', { turn: { id: turnId, status: 'failed', error: { message: 'ChatGPT quota exceeded' } } });
    return;
  }
  if (content.endsWith('wait')) {
    event('item/agentMessage/delta', { itemId: 'reply', delta: 'waiting' });
    return;
  }
  if (content.endsWith('approve')) {
    send({
      id: 'approval',
      method: 'item/commandExecution/requestApproval',
      params: { threadId, turnId, itemId: 'cmd', command: 'echo fixture', cwd: process.cwd() },
    });
    return;
  }
  event('item/agentMessage/delta', { itemId: 'reply', delta: '你好' });
  event('item/completed', { item: { id: 'reply', type: 'agentMessage', text: '你好，Ruyi' } });
  event('thread/tokenUsage/updated', {
    tokenUsage: {
      last: { totalTokens: 15 },
      modelContextWindow: 200000,
      total: { inputTokens: 10, cachedInputTokens: 3, outputTokens: 5 },
    },
  });
  end();
});
