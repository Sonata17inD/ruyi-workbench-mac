'use strict';

// Tool offers and dispatch use the same runtime capability requirements.
const TOOL_REQUIRES = {
  // TEST-ONLY entry (see note above). Requires network; when the probe URL points at a dead port the
  // capability matrix reports network.online===false → http_request is filtered + listed unavailable.
  // Guarded so it never fires unless a test opts in.
  http_request: { requires: ['network'], reason: '需要联网', testOnly: true },
  // v0.9-S9 (D6): web_search needs BOTH a live network AND a configured search backend. Either unmet → the
  // tool is filtered from the offered set (buildOpenAiTools) and listed under 「当前不可用」 with this reason.
  web_search: { requires: ['network', 'searchBackend'], reason: '需要联网并配置搜索后端' },
  // v0.9-S9: web_fetch needs a live network (it fetches an arbitrary http(s) url; SSRF-guarded at call time).
  // Offline, the tool is still offered so the model can hit the on-disk web cache; but when the matrix knows
  // it is offline we drop it and let the model read from cache only via an explicit ask? — decision: KEEP it
  // required on network so the model isn't tempted to fetch when offline; the offline cache path is a
  // graceful fallback INSIDE the tool for when it IS offered but the request fails. (See webFetch.)
  web_fetch: { requires: ['network'], reason: '需要联网' },
  // v1.1-W2 (T1): http_download 从任意 http(s) url 下载到工作区(SSRF-guarded);离线时无从下载 → require network。
  http_download: { requires: ['network'], reason: '需要联网' },
  // v1.0-S4: the git 工具族 all need a runnable `git` binary (caps.gitCli). When git is absent the four tools
  // are filtered from the offered set (buildOpenAiTools) and listed under 「当前不可用」 with this reason.
  git_status: { requires: ['gitCli', 'processSupervisor'], reason: '需要安装 Git' },
  git_diff: { requires: ['gitCli', 'processSupervisor'], reason: '需要安装 Git' },
  git_log: { requires: ['gitCli', 'processSupervisor'], reason: '需要安装 Git' },
  git_commit: { requires: ['gitCli', 'processSupervisor'], reason: '需要安装 Git' },
  shell_run: { requires: ['processSupervisor'], reason: 'Mac 进程监督器尚未就绪' },
  script_run: { requires: ['processSupervisor'], reason: 'Mac 进程监督器尚未就绪' },
  shell_start: { requires: ['processSupervisor'], reason: 'Mac 进程监督器尚未就绪' },
  desktop_screenshot: { requires: ['desktopCapture'], reason: 'Mac 屏幕捕获尚未就绪，请检查屏幕录制权限和自动化组件' },
};
// Is a tool's requirement met given the capability matrix? Unknown cap keys are treated as satisfied
// (fail-open: a typo in the table must never silently strip a tool). `enabled` gates testOnly entries.
// `config` is consulted for capability keys that live in config rather than the probe matrix (searchBackend).
function runtimeToolRequirementsMet(toolName, runtime) {
  if (process.platform === 'darwin' && TOOL_REQUIRES[toolName]?.requires.includes('desktopCapture')
    && runtime?.capabilities?.['desktop.capture']?.ready !== true) {
    return { met: false, reason: TOOL_REQUIRES[toolName].reason,
      code: runtime?.capabilities?.['desktop.capture']?.reasonCode || 'capture_unavailable' };
  }
  const requiresSupervisor = TOOL_REQUIRES[toolName]?.requires.includes('processSupervisor');
  if (process.platform !== 'darwin' || !requiresSupervisor || runtime?.capabilities?.['process.supervisor']?.ready === true) return { met: true };
  return { met: false, reason: 'Mac 进程监督器尚未就绪' };
}
function toolRequirementsMet(toolName, caps, toolRequiresEnabled, config) {
  const spec = TOOL_REQUIRES[toolName];
  if (!spec) return { met: true };
  if (spec.testOnly && !toolRequiresEnabled) return { met: true }; // test hook off → treat as no requirement
  const reqs = Array.isArray(spec.requires) ? spec.requires : [];
  for (const cap of reqs) {
    if (cap === 'processSupervisor' || cap === 'desktopCapture') {
      const requirement = runtimeToolRequirementsMet(toolName, caps && caps.runtime);
      if (requirement.met) continue;
      return requirement;
    }
    if (cap === 'network') { if (caps && caps.network && caps.network.online === true) continue; return { met: false, reason: spec.reason || '当前不可用' }; }
    // v0.9-S9: searchBackend is 'met' when config.searchBackend.type is a real backend (not 'none'). It is a
    // CONFIG fact, not a probe fact — pass config through so this check is deterministic offline too.
    // v1.1-W1a (T3): 'builtin' counts as configured (t !== 'none'); it needs no key, only the network cap
    // (a separate requires entry on web_search), so the zero-config default satisfies this check.
    if (cap === 'searchBackend') { const t = config && config.searchBackend && config.searchBackend.type; if (t && t !== 'none') continue; return { met: false, reason: spec.reason || '当前不可用' }; }
    // v1.0-S4: gitCli is a probe fact carried on the matrix (caps.gitCli === true when `git --version` ran).
    // Unknown (matrix without the key, e.g. an old cache) → treat as satisfied (fail-open, mirrors网络's spirit
    // that only an EXPLICIT negative strips a tool). Only an explicit `false` filters the git tools.
    if (cap === 'gitCli') { if (!caps || caps.gitCli !== false) continue; return { met: false, reason: spec.reason || '当前不可用' }; }
    // Unknown capability key → fail-open (satisfied). Future keys (vision/ocr/…) add explicit cases here.
  }
  return { met: true };
}

module.exports = { TOOL_REQUIRES, runtimeToolRequirementsMet, toolRequirementsMet };
