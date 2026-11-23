#!/usr/bin/env node
'use strict';

require('./lib/self-isolate-home.js');
const assert = require('node:assert/strict');
const { startBrowserFixture } = require('./lib/browser-fixture');

async function run() {
  const requests = [];
  const fx = await startBrowserFixture({
    isolatedKeychain: true,
    prefix: 'ruyi-composer-ime-',
    provider(ctx) {
      requests.push(ctx.body);
      ctx.text('已收到。');
      ctx.stop();
    },
    async prepare(fixture) {
      await fixture.request('POST', '/api/sessions', { title: '输入法', cwd: fixture.work });
    },
  });
  try {
    assert.ok(await fx.waitForEval('window.state?.currentSession?.id && document.querySelector("#promptInput").offsetWidth'));
    await fx.evaluate('document.querySelector("#promptInput").focus()');
    await fx.cdp.send('Input.insertText', { text: '选择' });
    await fx.cdp.send('Input.imeSetComposition', { text: 'han', selectionStart: 3, selectionEnd: 3 });
    const result = await fx.evaluate(`(() => {
      const input = document.querySelector('#promptInput');
      const enter = init => input.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', bubbles: true, cancelable: true, ...init
      }));
      return [enter({isComposing: true}), enter({keyCode: 13}), input.value];
    })()`);
    assert.deepEqual(result, [true, true, '选择han']);
    await fx.cdp.send('Input.insertText', { text: '汉字' });
    const draft = await fx.evaluate(`(() => {
      const input = document.querySelector('#promptInput');
      const enter = (type, keyCode) => input.dispatchEvent(new KeyboardEvent(type, {
        key: 'Enter', keyCode, bubbles: true, cancelable: true
      }));
      enter('keyup', 13);
      const nativeConfirm = enter('keydown', 229);
      // Replay WebKit's compositionend-before-keydown ordering within the same task.
      input.dispatchEvent(new CompositionEvent('compositionstart'));
      input.dispatchEvent(new CompositionEvent('compositionend'));
      const lateConfirm = enter('keydown', 13);
      enter('keyup', 13);
      return [nativeConfirm, lateConfirm, input.value];
    })()`);
    assert.deepEqual(draft, [true, false, '选择汉字']);
    for (const type of ['keyDown', 'keyUp']) {
      await fx.cdp.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 8, text: type === 'keyDown' ? '\r' : '' });
    }
    assert.equal(await fx.evaluate('document.querySelector("#promptInput").value'), '选择汉字\n');
    assert.equal(requests.length, 0);
    await fx.enter();
    assert.ok(await fx.waitForEval('document.querySelector("#messages").innerText.includes("已收到。")'));
    assert.equal(requests.length, 1);
    assert.deepEqual(fx.exceptions, []);
  } finally { await fx.close(); }
}

run().then(() => console.log('COMPOSER IME BROWSER E2E: ALL PASS')).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
