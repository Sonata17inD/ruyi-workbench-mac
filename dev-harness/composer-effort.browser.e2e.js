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
      const result = await fixture.request('POST', '/api/sessions', { title: 'Reasoning', cwd: fixture.work });
      sessionId = result.json.session.id;
    },
  });
  try {
    assert.ok(await fx.waitForEval("document.querySelector('#composerEffort button[data-effort=high]:enabled')"));
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
      document.querySelector('#composerEffort [data-effort=high]').click();
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
    assert.deepEqual(requests.map(body => body.reasoning_effort), ['high']);
    const { json } = await fx.request('GET', '/api/status');
    assert.equal(json.config.providers[0].reasoningEffort, '');
    assert.deepEqual(fx.exceptions, []);
  } finally { await fx.close(); }
}

run().then(() => console.log('COMPOSER EFFORT BROWSER E2E: ALL PASS')).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
