'use strict';
require('./lib/self-isolate-home.js');
const assert = require('node:assert/strict');
const { startBrowserFixture } = require('./lib/browser-fixture');
const t = require('./lib/harness').createRunner('CODEX SETTINGS BROWSER');

(async () => {
  const fixture = await startBrowserFixture({
    ok: t.ok,
    prefix: 'ruyi-codex-ui-',
    config: {
      model: 'claude-fixture',
      codexModel: 'plan-fixture',
      stewardEnabledV1: false,
    },
  });
  try {
    await fixture.evaluate(
      "document.getElementById('appGearBtn').click(); document.getElementById('openSettingsBtn').click(); true",
    );
    await fixture.waitForEval(
      "Array.from(document.querySelectorAll('#cfgMainProvider option')).some(o => o.textContent.includes('Codex CLI'))",
      160,
    );
    await fixture.evaluate(`(() => {
      const select = document.getElementById('cfgMainProvider');
      select.value = Array.from(select.options).find(o => o.textContent.includes('Codex CLI')).value;
      select.dispatchEvent(new Event('change', { bubbles:true })); return true;
    })()`);
    assert.ok(
      await fixture.waitForEval(
        "window.state.config.agentCliType === 'codex' && !document.getElementById('cfgMainProvider').disabled",
        160,
      ),
    );
    const status = await fixture.request('GET', '/api/status');
    assert.equal(status.json.config.model, 'claude-fixture');
    assert.equal(status.json.config.codexModel, 'plan-fixture');
    assert.equal(status.json.config.providers.find((p) => p.id === 'fake').model, 'fake-model');
    t.ok(true, 'choosing Codex in settings preserves Claude and HTTP provider defaults');
    assert.ok(
      await fixture.waitForEval("document.getElementById('codexAccountStatus').textContent.includes('ChatGPT')", 100),
    );
    assert.equal(
      await fixture.evaluate(
        "document.getElementById('codexSignOut').disabled && !document.getElementById('codexSignIn').disabled",
      ),
      true,
    );
    const visible = await fixture.request('GET', '/api/models');
    assert.deepEqual(visible.json.models, []);
    const denied = await fetch('http://127.0.0.1:' + fixture.appPort + '/api/codex/account');
    assert.ok([401, 403].includes(denied.status));
    const protectedUnlock = await fetch('http://127.0.0.1:' + fixture.appPort + '/api/codex/unlock', { method: 'POST' });
    assert.ok([401, 403].includes(protectedUnlock.status));
    await fixture.evaluate(`(() => {
      const original = window.fetch.bind(window);
      let unlocked = false;
      window.fetch = (url, opts) => {
        if (url === '/api/codex/account') return Promise.resolve(Response.json({
          active: 'fixture', accounts: [{ id: 'fixture', label: 'Fixture', plan: true, signedIn: true }]
        }));
        if (url === '/api/codex/unlock' && opts.method === 'POST') {
          unlocked = true;
          return Promise.resolve(Response.json({ ok: true }));
        }
        if (url === '/api/codex/models') return Promise.resolve(unlocked
          ? Response.json({ models: [{ id:'unlocked-model', label:'Unlocked model' }] })
          : Response.json({ error: { code:'local_crypto.permission_denied' } }, { status:503 }));
        return original(url, opts);
      };
      const details = document.getElementById('codexAccountDetails');
      details.open = true;
      details.dispatchEvent(new Event('toggle'));
      return true;
    })()`);
    assert.ok(await fixture.waitForEval("!document.getElementById('codexUnlock').hidden", 100));
    await fixture.evaluate("document.getElementById('codexUnlock').click(); true");
    assert.ok(await fixture.waitForEval("(async () => (await import('/js/model-catalog.js')).agentModels('codex').some(m => m.id === 'unlocked-model'))()", 100));
    assert.equal(await fixture.evaluate("document.getElementById('codexUnlock').hidden"), true);
    t.ok(true, 'a saved account offers a local unlock and loads its catalog without a new browser sign-in');
    assert.equal(fixture.exceptions.length, 0, fixture.exceptions.join('\n'));
    t.ok(true, 'signed-out account controls render and account details require authentication');
  } finally {
    await fixture.close();
  }
})()
  .catch((error) => t.fail(error.stack))
  .finally(() => t.done());
