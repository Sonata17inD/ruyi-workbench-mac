#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// Legacy simple preferences must start in the full workspace on both shells.
const fs = require('fs');
const path = require('path');
const { startBrowserFixture, sleep } = require('./lib/browser-fixture');

let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

const THREAD_TITLE = '简易档那条线程';
const NOTE_TEXT = '简易模式的一行笔记';
const REPLY = '读完了。';
const WIDE_W = 1440;
const WIDE_H = 900;
const NARROW_W = 640;
const NARROW_H = 800;
const SECTION_LINKS = ['overview', 'appearance', 'providers', 'security', 'limits', 'steward', 'basic'];

(async () => {
  let fx = null;
  let notePath = '';
  try {
    fx = await startBrowserFixture({
      ok,
      prefix: 'ruyi-simple-mode-',
      width: WIDE_W,
      height: WIDE_H,
      config: { uiMode: 'simple' },
      provider: async ctx => {
        if (!ctx.answered) { ctx.toolCall('file_read', { path: notePath }, 'call_simple_read'); return; }
        ctx.text(REPLY); ctx.stop();
      },
      prepare: async f => {
        notePath = path.join(f.work, 'note.txt');
        fs.writeFileSync(notePath, NOTE_TEXT + '\n', 'utf8');
        const created = await f.request('POST', '/api/sessions', { title: THREAD_TITLE, cwd: f.work });
        f.sid = created && created.json && created.json.session && created.json.session.id;
        ok(Boolean(f.sid), `S0 线程已建(${f.sid})`);
      },
    });
    const ev = expr => fx.evaluate(expr);

    const migrated = await fx.waitForEval(`window.state?.config?.uiMode === 'pro'
      && document.documentElement.dataset.uiMode === 'pro' && document.documentElement.dataset.density === 'compact'`);
    ok(Boolean(migrated), 'S1 历史精简配置进入专家界面');
    ok(await ev(`document.querySelectorAll('#cfgUiMode, #uiModeToggle').length === 0
      && !!document.querySelector('#sidebar #openSettingsBtn') && !document.querySelector('#appGearMenu #openSettingsBtn')
      && !!document.querySelector('#appTopbar .tb-left #lensSeg')`), 'S1b 视角在品牌旁，设置在侧栏');

    /* ═════════ S2 两个视角、宽窄两档都画得出来 ═════════ */
    const fit = composerId => `(() => {
      const root = document.documentElement;
      const input = document.getElementById('${composerId}');
      const b = input ? input.getBoundingClientRect() : null;
      return {
        overflow: root.scrollWidth - root.clientWidth,
        composer: Boolean(b) && b.width > 40 && b.height > 10 && b.right <= root.clientWidth + 1 && b.bottom <= root.clientHeight + 1,
      };
    })()`;
    for (const [lens, composerId] of [['steward', 'stewardComposerInput'], ['classic', 'promptInput']]) {
      ok(Boolean(await fx.setLens(lens)), `S2a 切到${lens === 'steward' ? '管家' : '工作台'}视角`);
      for (const [w, h] of [[WIDE_W, WIDE_H], [NARROW_W, NARROW_H]]) {
        await fx.resize(w, h);
        const got = await ev(fit(composerId));
        ok(got.overflow <= 1 && got.composer,
          `S2 ${lens} 视角 ${w}px:无横向滚动(差 ${got.overflow}px)、输入框 #${composerId} 整个看得见(${got.composer})`);
      }
      await fx.resize(WIDE_W, WIDE_H);
    }

    /* ═════════ S3 工作台右栏 ═════════ */
    // 右栏在宽屏常驻;万一被折起来就先打开(本件量的是页签的藏/显,不是右栏的开合)。
    await ev(`(() => { const pane = document.getElementById('toolPane'); if (pane && pane.offsetParent === null) document.getElementById('toggleToolsBtn')?.click(); return true; })()`);
    await sleep(300);
    const tabs = await ev(`(() => [...document.querySelectorAll('#toolPane .tool-tabs button[data-tab]')].map(b => ({
      tab: b.dataset.tab, display: getComputedStyle(b).display, shown: b.offsetParent !== null })))()`);
    const shownTabs = tabs.filter(t => t.shown).map(t => t.tab).sort();
    ok(['audit', 'usage', 'agent-runs', 'artifacts', 'changes', 'files', 'memory'].every(t => shownTabs.includes(t)),
      'S3 完整工作台页签可见');
    const rawOut = await ev(`getComputedStyle(document.getElementById('toolOutput')).display`);
    ok(rawOut === 'none', `S3c 原始输出槽 #toolOutput 不显示(实 display:${rawOut})`);

    /* ═════════ S4 设置弹窗 ═════════ */
    await ev(`(() => { document.getElementById('openSettingsBtn').click(); return true; })()`);
    ok(Boolean(await fx.waitForEval(`(() => !document.getElementById('settingsModal').classList.contains('hidden') ? 1 : null)()`, 200)),
      'S4a 设置弹窗打开了');
    const visibleStabs = await ev(`[...document.querySelectorAll('#settingsTabs button[data-stab]')].filter(b => b.offsetParent).map(b => b.dataset.stab)`);
    ok(JSON.stringify(visibleStabs) === JSON.stringify(SECTION_LINKS), 'S4 设置导航按分类平铺');
    for (const stab of SECTION_LINKS) {
      await ev(`(() => { document.querySelector('#settingsTabs button[data-stab="${stab}"]').click(); return true; })()`);
      const panel = await fx.waitForEval(`(() => {
        const active = document.querySelector('.settings-tab.active');
        if (!active || active.id !== 'stab-${stab}') return null;
        return { text: active.innerText.trim().length, themes: [...active.querySelectorAll('[data-theme-choice]')].map(b => b.dataset.themeChoice).sort() };
      })()`, 100);
      ok(Boolean(panel) && (stab === 'appearance' ? panel.themes.join(',') === 'dark,light,system' : panel.text > 20), `S4d 点「${stab}」面板真的切过去且不是空的(${panel ? panel.text + ' 字' : '没切过去'})`);
    }
    // 修前简易档点「高级」会被 JS 兜底拦回「基础」;现在不拦 —— 点哪枚就是哪枚。
    await ev(`(() => { document.querySelector('#settingsTabs button[data-stab="advanced"]').click(); return true; })()`);
    await sleep(150);
    const landed = await ev(`(document.querySelector('.settings-tab.active') || {}).id || ''`);
    ok(landed === 'stab-advanced', `S4e 工作台点「高级」就落在「高级」(实 ${landed})`);
    await fx.escape();
    ok(Boolean(await fx.waitForEval(`(() => document.getElementById('settingsModal').classList.contains('hidden') ? 1 : null)()`, 100)),
      'S4f Esc 关掉设置弹窗');

    /* ═════════ S5 真回合:专家界面的工具卡 ═════════ */
    await ev(`(() => {
      const title = [...document.querySelectorAll('#railList .steward-board-thread-title')].find(n => (n.textContent || '').includes(${JSON.stringify(THREAD_TITLE)}));
      if (title) title.click();
      return Boolean(title);
    })()`);
    ok(Boolean(await fx.waitForEval(`(() => window.state && window.state.currentSession && window.state.currentSession.id === ${JSON.stringify(fx.sid)} ? 1 : null)()`, 300)),
      'S5a 从左栏点开那条线程');
    await ev(`(() => { const i = document.getElementById('promptInput'); i.focus(); return document.activeElement === i; })()`);
    await fx.cdp.send('Input.insertText', { text: '把笔记读一下' });
    await fx.enter();
    const card = await fx.waitForEval(`(() => {
      const card = [...document.querySelectorAll('#messages .tool-card')].find(c => (c.querySelector('.tc-name') || {}).textContent === 'file_read');
      const reply = (document.getElementById('messages').innerText || '').includes(${JSON.stringify(REPLY)});
      if (!card || !reply) return null;
      const show = sel => { const n = card.querySelector(sel); return n ? { display: getComputedStyle(n).display, text: (n.textContent || '').trim() } : null; };
      return { verb: show('.tc-verb'), name: show('.tc-name'), sum: show('.tc-detail > summary.tc-detail-sum') };
    })()`, 1500);
    ok(Boolean(card), 'S5b 回合跑完:工具卡与答复都上屏了');
    ok(Boolean(card) && card.name?.display !== 'none' && card.name?.text === 'file_read', 'S5c 显示工具原名');
    ok(Boolean(card) && card.verb?.display === 'none' && card.sum?.display === 'none', 'S5d 工具卡使用专家排版');

    await ev(`localStorage.setItem('wcw.uiMode', 'simple')`);
    await fx.cdp.send('Page.reload', { ignoreCache: true });
    ok(Boolean(await fx.waitForEval(`window.state?.config?.uiMode === 'pro' && document.documentElement.dataset.uiMode === 'pro'`)),
      'S6 刷新后忽略旧浏览器的精简偏好');
    /* ═════════ S7 全程无未捕获异常 ═════════ */
    ok(fx.exceptions.length === 0, `S7 全程页面上没有未捕获异常(实 ${fx.exceptions.length}${fx.exceptions.length ? ':' + fx.exceptions.slice(0, 3).join(' | ') : ''})`);
    ok(fx.consoleErrors.length === 0, `S7b 全程没有 console.error(实 ${fx.consoleErrors.length}${fx.consoleErrors.length ? ':' + fx.consoleErrors.slice(0, 3).join(' | ') : ''})`);
  } catch (error) {
    fail += 1;
    console.log('FAIL 未捕获异常:' + (error && error.stack || error));
  } finally {
    if (fx) await fx.close({ keepRoot: fail > 0 });
    if (fx && fail > 0) console.log('NOTE 失败现场保留在 ' + fx.root);
  }
  console.log(fail === 0 ? 'SIMPLE MODE BROWSER E2E: ALL PASS' : `SIMPLE MODE BROWSER E2E: FAILURES ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
