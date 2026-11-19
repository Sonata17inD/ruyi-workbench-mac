'use strict';

const { projectMacCapabilities } = require('./mac-capabilities.cjs');

function createDesktopCapabilityProbe({
  collectBridgedTools, resolveExternalMcpServers, sanitizeServerId, getMcpClient, DesktopExecutionHooks,
  platform = process.platform,
}) {
  // Probe the desktop MCP's optional python deps via a single bridged `diagnostics` call. Returns
  // { present, toolCount, optional:{ocr,uia,cv2,playwright} }. Absence/failure → present:false + all-false.
  async function probeDesktopMcp(config) {
    const out = { present: false, toolCount: 0, optional: { ocr: false, uia: false, cv2: false, playwright: false },
      desktopAutomation: { supported: false, installed: false, authorization: 'unknown', ready: null },
      ocr: { supported: false, installed: false, authorization: 'unknown', ready: null },
      browser: { mode: String(config?.browserAutomation?.mode || 'system'), supported: false, installed: false, runtimeInstalled: null, ready: false } };
    if (platform === 'darwin') Object.assign(out, projectMacCapabilities(null));
    try {
      const bridged = await collectBridgedTools(config);
      const accEntry = resolveExternalMcpServers(config).find(s => s.id === 'ai-computer-control');
      // Count only ACC. The old implementation counted every imported MCP (for example the user's
      // Claude Code connectors), which made a 108-tool desktop component appear as "328 tools" and
      // even reported desktop control as connected when only an unrelated MCP was live.
      if (!accEntry) return out; // no desktop bridge configured → optional stays all-false
      const prefix = sanitizeServerId(accEntry.id);
      const prefixWithSep = `${prefix}__`;
      out.toolCount = (bridged.tools || []).filter(tool => {
        const name = tool && tool.function && tool.function.name;
        return typeof name === 'string' && name.startsWith(prefixWithSep);
      }).length;
      out.present = out.toolCount > 0;
      const has = name => !!bridged.route[`${prefix}__${name}`];
      if (platform !== 'darwin') out.desktopAutomation.installed = has('get_active_window') && has('type_text') && has('screenshot');
      // Tool registration proves an implemented backend, not current OS focus/authorization.
      // Find the bridged diagnostics tool name (serverId__diagnostics) for the ACC server, if listed.
      const diagName = `${prefix}__diagnostics`;
      if (!bridged.route[diagName]) return out; // ACC present but no diagnostics tool → leave optional false
      const client = getMcpClient(accEntry.id);
      if (!client || client.dead) return out;
      let diag;
      try { diag = DesktopExecutionHooks.enabled() ? await DesktopExecutionHooks.readiness(client) : await client.callTool('diagnostics', {}); } catch { return out; }
      // diagnostics shape is best-effort — scan for boolean-ish availability of each optional module. Accept
      // several likely shapes: {optional:{ocr:true}}, {modules:{ocr:{available:true}}}, flat {ocr:true}, etc.
      const truthy = v => v === true || v === 'ok' || v === 'available' || (v && typeof v === 'object' && (v.available === true || v.ok === true));
      const pick = key => {
        if (!diag || typeof diag !== 'object') return false;
        const sources = [diag, diag.optional, diag.modules, diag.deps, diag.dependencies, diag.capabilities].filter(s => s && typeof s === 'object');
        for (const s of sources) { if (key in s && truthy(s[key])) return true; }
        return false;
      };
      out.optional = { ocr: pick('ocr'), uia: pick('uia'), cv2: pick('cv2'), playwright: pick('playwright') };
      out.ocr.installed = has('ocr_image') && out.optional.ocr;
      if (platform === 'darwin') Object.assign(out, projectMacCapabilities(diag, has));
      if (has('browser_backend_status') && !DesktopExecutionHooks.enabled()) {
        out.browser = { ...out.browser, supported: out.browser.mode !== 'system', installed: out.optional.playwright };
        try {
          const status = await client.callTool('browser_backend_status', {}, 20000);
          if (status?.ok === true) out.browser = {
            mode: status.targetMode || out.browser.mode, supported: status.supported === true,
            installed: status.installed === true,
            runtimeInstalled: status.probeError ? null : typeof status.runtimeInstalled === 'boolean' ? status.runtimeInstalled : null,
            ready: status.ready === true, profileIsolation: status.profileIsolation || 'not-attached',
            probeFailed: !!status.probeError,
          };
        } catch { out.browser.probeFailed = true; /* no failed lookup is evidence of a missing binary */ }
      }
      return out;
    } catch { return out; }
  }
  return probeDesktopMcp;
}

module.exports = { createDesktopCapabilityProbe };
