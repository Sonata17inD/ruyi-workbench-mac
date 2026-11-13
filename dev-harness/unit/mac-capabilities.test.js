'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { projectMacCapabilities: project } = require('../../ruyi-workbench/app/backend/mac-capabilities.cjs');
function facts(patch = {}) {
  return { ok: true, capabilities: {
    'desktop.capture': { supported: true, installed: true, authorization: 'granted', windowAuthorization: 'granted',
      eventAuthorization: 'granted', locked: false, ready: true, inputReady: true },
    'desktop.accessibility': { supported: true, installed: true, authorization: 'granted', ready: true },
    'desktop.ocr': { supported: true, installed: true, authorization: 'not_required_for_local_images', ready: true, screenReady: true },
    ...patch,
  } };
}
test('ready Mac capabilities enable desktop, AX and both OCR modes', () => {
  const c = project(facts(), () => true);
  for (const value of Object.values(c)) assert.equal(value.ready, true);
  assert.equal(c.desktopAutomation.supported, true);
});
test('screen denial leaves local OCR available and does not claim screen/desktop readiness', () => {
  const d = facts(); d.capabilities['desktop.capture'].authorization = 'denied';
  d.capabilities['desktop.capture'].ready = false; d.capabilities['desktop.ocr'].screenReady = false;
  const c = project(d, () => true);
  assert.equal(c.ocr.ready, true); assert.equal(c.input.ready, true);
  assert.equal(c.screenOcr.ready, false); assert.equal(c.screenOcr.reasonCode, 'permission_denied');
  assert.equal(c.desktopAutomation.ready, false);
});
test('locked session blocks desktop and AX but not local-file OCR', () => {
  const d = facts(); d.capabilities['desktop.capture'].locked = true;
  const c = project(d, () => true);
  for (const key of ['capture', 'input', 'accessibility', 'screenOcr', 'desktopAutomation']) {
    assert.equal(c[key].ready, false); assert.equal(c[key].reasonCode, 'session_locked');
  }
  assert.equal(c.ocr.ready, true);
});
test('missing helper, withheld toolset and failed diagnostics are distinct', () => {
  const d = facts(); for (const s of Object.values(d.capabilities)) s.installed = false;
  assert.equal(project(d, () => true).ocr.reasonCode, 'dependency_missing');
  assert.equal(project(facts(), () => false).ocr.reasonCode, 'tool_unavailable');
  for (const input of [null, {}, { ok: false, capabilities: facts().capabilities }]) {
    const c = project(input, () => true);
    assert.equal(c.ocr.ready, null); assert.equal(c.ocr.installed, null);
    assert.equal(c.ocr.reasonCode, 'diagnostics_unavailable');
  }
});
test('partial or contradictory permission observations never become ready', () => {
  const d = facts(); d.capabilities['desktop.capture'].eventAuthorization = 'unknown';
  assert.equal(project(d, () => true).input.ready, null);
  d.capabilities['desktop.capture'].eventAuthorization = 'denied';
  assert.equal(project(d, () => true).input.ready, false);
});

test('native IPC failure keeps dependent features unknown rather than missing', () => {
  const d = facts(); Object.assign(d.capabilities['desktop.capture'], {queryReady: false, ready: null});
  for (const value of Object.values(project(d, () => true))) {
    assert.equal(value.ready, null);
    assert.equal(value.reasonCode, 'diagnostics_unavailable');
  }
});
test('missing support or installation facts cannot claim readiness', () => {
  const d = facts(); delete d.capabilities['desktop.ocr'].installed;
  assert.equal(project(d, () => true).ocr.ready, null);
});
