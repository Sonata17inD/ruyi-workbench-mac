'use strict';
require('./lib/self-isolate-home');
const { createRunner } = require('./lib/harness');
const { loadServerInternals } = require('./lib/server-internals');
const t = createRunner('MACOS CAPABILITY PROJECTION');
const S = loadServerInternals(['probeDesktopMcp', 'evalPlaybookAvailability'], { withEval: true, testPlatform: 'darwin' });
S.__eval(`collectBridgedTools = async () => {const names=['get_active_window','type_text','screenshot','ocr_image','ocr_screen','ui_inspect','diagnostics'];return {tools:names.map(n=>({function:{name:'ai_computer_control__'+n}})),route:Object.fromEntries(names.map(n=>['ai_computer_control__'+n,{}]))}}; resolveExternalMcpServers = () => [{id:'ai-computer-control'}];`);
async function probe(diag) {
  S.__eval(`mcpClients.set('ai-computer-control', {dead:false,callTool:async()=>(${JSON.stringify(diag)})});`);
  return S.probeDesktopMcp({ browserAutomation: { mode: 'system' } });
}
(async () => {
  const diag = { ok: true, optional: { ocr: true, uia: true }, capabilities: {
    'desktop.capture': { supported: true, installed: true, authorization: 'granted', windowAuthorization: 'granted', eventAuthorization: 'granted',
      locked: false, ready: true, inputReady: true },
    'desktop.accessibility': { supported: true, installed: true, authorization: 'granted', ready: true },
    'desktop.ocr': { supported: true, installed: true, authorization: 'not_required_for_local_images', ready: true, screenReady: true },
  } };
  let dm = await probe(diag);
  t.ok(dm.present && dm.toolCount === 7, 'actual aggregation counts the registered ACC tools');
  for (const key of ['desktopAutomation', 'ocr']) {
    const result = S.evalPlaybookAvailability({ requires: [key] }, { desktopMcp: dm });
    t.ok(result.available && result.status === 'available', key + ' template enabled by actual Mac readiness');
  }
  diag.capabilities['desktop.capture'].authorization = 'denied';
  diag.capabilities['desktop.capture'].ready = false;
  diag.capabilities['desktop.ocr'].screenReady = false;
  dm = await probe(diag);
  t.ok(S.evalPlaybookAvailability({ requires: ['ocr'] }, { desktopMcp: dm }).status === 'available', 'local OCR template survives screen permission denial');
  t.ok(!S.evalPlaybookAvailability({ requires: ['desktopAutomation'] }, { desktopMcp: dm }).available && dm.screenOcr.ready === false,
    'screen workflows remain blocked on screen denial');
  dm = await probe({ ok: false });
  t.ok(dm.ocr.ready === null && S.evalPlaybookAvailability({ requires: ['ocr'] }, { desktopMcp: dm }).status === 'unknown'
    && S.evalPlaybookAvailability({ requires: ['ocr'] }, { desktopMcp: dm }).available === false,
    'failed diagnostics do not claim absent or ready OCR');
  t.done();
})().catch(error => { t.fail(error.stack); t.done(); });
