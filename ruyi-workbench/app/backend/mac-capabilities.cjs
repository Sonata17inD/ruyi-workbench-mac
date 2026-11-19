'use strict';
// One projection of ACC/native facts for templates, the UI and model context.
// A failed query is unknown; tool registration alone is never OS readiness.
const bool = value => typeof value === 'boolean' ? value : null;
const denied = value => ['denied', 'permission_denied'].includes(value);
function capability(source, registered, defaults = {}) {
  if (!source || typeof source !== 'object') return { supported: null, installed: null,
    authorization: 'unknown', ready: null, reasonCode: 'diagnostics_unavailable' };
  const installed = bool(source.installed);
  const supported = bool(source.supported);
  const authorization = typeof source.authorization === 'string' ? source.authorization : 'unknown';
  const locked = defaults.requiresSession === true && source.locked === true;
  let ready = bool(source.ready);
  if (installed === false || supported === false || denied(authorization) || locked) ready = false;
  if (ready === true && (installed !== true || supported !== true || authorization === 'unknown' || (defaults.requiresSession === true && source.locked !== false))) ready = null;
  if (ready === true && !registered) ready = false;
  const reasonCode = installed === false ? 'dependency_missing' : supported === false ? 'backend_unsupported'
    : locked ? 'session_locked' : denied(authorization) ? 'permission_denied'
      : source.ready === true && !registered ? 'tool_unavailable'
        : ready === true ? null : source.reasonCode || (ready === false ? 'backend_not_ready' : 'diagnostics_unavailable');
  return { supported, installed, authorization, ready, reasonCode };
}
function permissions(...values) {
  if (values.some(denied)) return 'denied';
  return values.every(value => value === 'granted') ? 'granted' : 'unknown';
}
function projectMacCapabilities(diagnostics, has = () => false) {
  const facts = diagnostics?.ok === false ? null : diagnostics?.capabilities;
  const raw = facts?.['desktop.capture'];
  // Native IPC failure is not evidence that AX/Vision is absent.
  if (raw?.installed === true && raw.queryReady === false) {
    const unknown = capability(null, false);
    return Object.fromEntries(['capture', 'input', 'accessibility', 'ocr', 'screenOcr', 'desktopAutomation']
      .map(key => [key, { ...unknown, supported: true, installed: true }]));
  }
  const capture = capability(raw, has('screenshot'), { requiresSession: true });
  const input = capability(raw && { ...raw, supported: true,
    authorization: permissions(raw.windowAuthorization, raw.eventAuthorization), ready: raw.inputReady,
    reasonCode: undefined }, has('type_text') && has('get_active_window'), { requiresSession: true });
  const accessibility = capability(facts?.['desktop.accessibility'] && {
    ...facts['desktop.accessibility'], locked: raw?.locked,
  }, has('ui_inspect'), { requiresSession: true });
  const ocrFacts = facts?.['desktop.ocr'];
  const ocr = capability(ocrFacts, has('ocr_image'));
  const screenOcr = capability(ocrFacts && { ...ocrFacts, authorization: raw?.authorization,
    locked: raw?.locked, ready: ocrFacts.screenReady }, has('ocr_screen'), { requiresSession: true });
  const states = [capture, input];
  const desktopAutomation = {
    supported: states.some(s => s.supported === false) ? false : states.every(s => s.supported === true) ? true : null,
    installed: states.some(s => s.installed === false) ? false : states.every(s => s.installed === true) ? true : null,
    authorization: permissions(...states.map(s => s.authorization)),
    ready: states.some(s => s.ready === false) ? false : states.every(s => s.ready === true) ? true : null,
    reasonCode: states.find(s => s.ready === false)?.reasonCode || states.find(s => s.ready !== true)?.reasonCode || null,
  };
  return { capture, input, accessibility, ocr, screenOcr, desktopAutomation };
}
module.exports = { projectMacCapabilities };
