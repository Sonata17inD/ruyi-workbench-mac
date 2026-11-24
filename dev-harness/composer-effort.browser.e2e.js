#!/usr/bin/env node
'use strict';

require('./lib/self-isolate-home.js');
const assert = require('node:assert/strict');
const { startBrowserFixture } = require('./lib/browser-fixture');

async function run() {
  const requests = [];
  let sessionId;
  const fx = await startBrowserFixture({
    isolatedKeychain: true,
    prefix: 'ruyi-composer-effort-',
    provider(ctx) {
      requests.push(ctx.body);
      ctx.text('Received.');
      ctx.stop();
    },
    async prepare(fixture) {
      const status = await fixture.request('GET', '/api/status');
      const existing = status.json.config.providers[0];
      const added = { ...existing, id: 'new-provider', apiKey: 'fixture-only' };
      delete added.reasoningEffort;
      const saved = await fixture.request('POST', '/api/config', {
        providers: [existing, added], activeProvider: added.id,
      });
      assert.equal(saved.status, 200);
      const result = await fixture.request('POST', '/api/sessions', { title: 'Reasoning', cwd: fixture.work });
      sessionId = result.json.session.id;
    },
  });
  try {
    assert.ok(await fx.waitForEval("document.querySelector('#composerEffort button[data-effort=high][aria-pressed=true]:enabled')"));
    for (const key of ['agent:codex', 'agent:claude', 'openai:new-provider']) {
      await fx.evaluate("document.querySelector('button[data-chip=engine]').click()");
      const selector = '[data-engine-key="' + key + '"]';
      assert.ok(await fx.waitForEval('document.querySelector(' + JSON.stringify(selector) + ')'));
      await fx.evaluate('document.querySelector(' + JSON.stringify(selector) + ').click()');
      assert.ok(await fx.waitForEval(`(() => {
        const route = window.state.currentSession.engineRoute;
        return (route.engine === 'agent' ? 'agent:' + route.agentCliType : 'openai:' + route.providerId) === ${JSON.stringify(key)}
          && route.reasoningEffort === 'high' && !!document.querySelector('#composerEffort [data-effort=high][aria-pressed=true]:enabled');
      })()`));
    }
    await fx.evaluate(`(() => {
      const input = document.querySelector('#promptInput');
      input.value = 'Check the engine switch.';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#sendBtn').click();
    })()`);
    assert.ok(await fx.waitForEval("document.getElementById('messages').textContent.includes('Received.') && !document.querySelector('#sendBtn').disabled"));
    assert.equal(requests[0].reasoning_effort, 'high');
    let releasePatch;
    const held = new Promise(resolve => { releasePatch = resolve; });
    fx.cdp.on('Fetch.requestPaused', event => {
      if (event.request.method === 'PATCH') releasePatch(event.requestId);
      else void fx.cdp.send('Fetch.continueRequest', { requestId: event.requestId });
    });
    await fx.cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/sessions/' + sessionId }] });
    await fx.evaluate(`(() => {
      const input = document.querySelector('#promptInput');
      input.value = 'Check the selected effort.';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#composerEffort [data-effort=medium]').click();
      document.querySelector('#sendBtn').click();
      return true;
    })()`);
    let timeout;
    let requestId;
    try {
      requestId = await Promise.race([held, new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('No thread preference request')), 5000);
      })]);
    } finally { clearTimeout(timeout); }
    assert.equal(await fx.evaluate("document.querySelector('#promptInput').value"), 'Check the selected effort.');
    await fx.cdp.send('Fetch.continueRequest', { requestId });
    await fx.cdp.send('Fetch.disable');
    assert.ok(await fx.waitForEval("document.getElementById('messages').textContent.includes('Received.')"));
    assert.ok(await fx.waitForEval("document.querySelectorAll('#messages .turn-narrative').length >= 2 && document.getElementById('messages').textContent.split('Received.').length >= 3"));
    assert.deepEqual(requests.filter(body => body.stream !== false).map(body => body.reasoning_effort), ['high', 'medium']);
    const { json } = await fx.request('GET', '/api/status');
    assert.equal(json.config.providers[0].reasoningEffort, 'high');
    assert.equal(json.config.providers[1].reasoningEffort, 'high');
    assert.deepEqual(fx.exceptions, []);
  } finally { await fx.close(); }
}

run().then(() => console.log('COMPOSER EFFORT BROWSER E2E: ALL PASS')).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
