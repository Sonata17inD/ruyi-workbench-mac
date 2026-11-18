'use strict';
const { createRunner } = require('./lib/harness');
const { createDesktopCapabilityProbe } = require('../ruyi-workbench/app/backend/desktop-capability-probe.cjs');
const { evalPlaybookAvailability } = require('../ruyi-workbench/app/backend/playbook-policy.cjs');
const t = createRunner('MACOS CAPABILITY PROJECTION');
function probe(diag) {
  const names = ['get_active_window', 'type_text', 'screenshot', 'ocr_image', 'ocr_screen', 'ui_inspect', 'diagnostics']
    .map(name => 'ai_computer_control__' + name);
  const probeDesktopMcp = createDesktopCapabilityProbe({
    platform: 'darwin',
    collectBridgedTools: async () => ({
      tools: names.map(name => ({ function: { name } })),
      route: Object.fromEntries(names.map(name => [name, {}])),
    }),
    resolveExternalMcpServers: () => [{ id: 'ai-computer-control' }],
    sanitizeServerId: id => id.replace(/-/g, '_'),
    DesktopExecutionHooks: { enabled: () => false },
    getMcpClient: id => id === 'ai-computer-control' ? { callTool: async () => diag } : null,
  });
  return probeDesktopMcp({ browserAutomation: { mode: 'system' } });
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
    const result = evalPlaybookAvailability({ requires: [key] }, { desktopMcp: dm });
    t.ok(result.available && result.status === 'available', key + ' template enabled by actual Mac readiness');
  }
  diag.capabilities['desktop.capture'].authorization = 'denied';
  diag.capabilities['desktop.capture'].ready = false;
  diag.capabilities['desktop.ocr'].screenReady = false;
  dm = await probe(diag);
  t.ok(evalPlaybookAvailability({ requires: ['ocr'] }, { desktopMcp: dm }).status === 'available', 'local OCR template survives screen permission denial');
  t.ok(!evalPlaybookAvailability({ requires: ['desktopAutomation'] }, { desktopMcp: dm }).available && dm.screenOcr.ready === false,
    'screen workflows remain blocked on screen denial');
  dm = await probe({ ok: false });
  t.ok(dm.ocr.ready === null && evalPlaybookAvailability({ requires: ['ocr'] }, { desktopMcp: dm }).status === 'unknown'
    && evalPlaybookAvailability({ requires: ['ocr'] }, { desktopMcp: dm }).available === false,
    'failed diagnostics do not claim absent or ready OCR');
  t.done();
})().catch(error => { t.fail(error.stack); t.done(); });
