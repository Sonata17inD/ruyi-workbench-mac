'use strict';

// EC-D 第58波：设置域中的运维子域（更新中心 + MCP 运维）。
//
// 两块功能共享“设置页签内的远程读写 + 状态渲染”边界，但不应继续占用 app.js
// 的全局作用域。基础能力直接依赖稳定模块；结构化 API 错误翻译与已有 MCP 导入器
// 由组合根注入，避免反向依赖 app.js。
import { $, el, toast } from './util.js';
import { api, apiErrText as fallbackApiErrText } from './net.js';
import { hasTranslation, t, tCount } from './i18n.js';

export function createSettingsOperationsDomain({
  apiErrText = fallbackApiErrText,
  importMcpFromFolder = async () => {},
  // 118a: 「重新打开引导」。组合根注入与两壳同一个 onboarding-wizard.js 实例。
  openOnboarding = () => {},
} = {}) {
  let mcpConnectorCache = [];

  /* ---------------- MCP 运维页签 ---------------- */
  const MCP_SOURCE_KEYS = { desktop: 'settings.mcp.source.desktop', config: 'settings.mcp.source.config', 'drop-in': 'settings.mcp.source.dropIn', toolbox: 'settings.mcp.source.toolbox' };
  const MCP_HEALTH_KEYS = { ok: 'settings.mcp.health.ok', degraded: 'settings.mcp.health.degraded', failed: 'settings.mcp.health.failed', disabled: 'settings.mcp.health.disabled' };
  const MCP_CAT_KEYS = { auth: 'settings.mcp.cat.auth', startup: 'settings.mcp.cat.startup', network: 'settings.mcp.cat.network', timeout: 'settings.mcp.cat.timeout', security: 'settings.mcp.cat.security', tool_registration: 'settings.mcp.cat.toolRegistration', protocol: 'settings.mcp.cat.protocol', unknown: 'settings.mcp.cat.unknown' };

  function mcpHealthLampClass(item) {
    if (!item || item.enabled === false) return 'mcp-lamp-disabled';
    const health = item.health;
    if (!health || !health.status) return '';
    if (health.status === 'ok') return 'mcp-lamp-ok';
    if (health.status === 'degraded') return 'mcp-lamp-degraded';
    if (health.status === 'failed') return 'mcp-lamp-failed';
    return 'mcp-lamp-disabled';
  }

  function mcpHealthText(item) {
    if (item && item.enabled === false) return t('settings.mcp.health.disabled');
    const health = item && item.health;
    if (!health || !health.status) return t('settings.mcp.health.unknown');
    const parts = [t(MCP_HEALTH_KEYS[health.status] || 'settings.mcp.health.unknown')];
    if (health.category) parts.push(t(MCP_CAT_KEYS[health.category] || 'settings.mcp.cat.unknown'));
    if (typeof health.toolCount === 'number') parts.push(t('settings.mcp.toolCount', { p1: health.toolCount }));
    if (typeof health.latencyMs === 'number') parts.push(health.latencyMs + 'ms');
    if (health.message) parts.push(String(health.message));
    return parts.join(' · ');
  }

  // 探测（?probe=1，慢）与普通刷新可以同时在飞：修前谁后到谁画，旧的那一发会把新列表和计数盖回去。
  // 每发取序号，只认最新那一发；按钮也只由最新那一发解锁。
  let mcpOpsSeq = 0;
  async function refreshMcpOps(probe) {
    const seq = ++mcpOpsSeq;
    const hint = $('mcpListHint');
    if (hint) hint.textContent = t(probe ? 'settings.mcp.probing' : 'settings.mcp.loading');
    const button = $('mcpRefreshBtn'); if (button) button.disabled = true;
    try {
      const result = await api('/api/mcp/connectors' + (probe ? '?probe=1' : ''));
      if (seq !== mcpOpsSeq) return;
      mcpConnectorCache = Array.isArray(result.connectors) ? result.connectors : [];
      renderMcpCompat(result.compat);
      renderMcpConnList();
      if (hint) hint.textContent = tCount('settings.mcp.count', mcpConnectorCache.length, { p1: mcpConnectorCache.length });
    } catch (error) {
      if (seq !== mcpOpsSeq) return;
      if (hint) hint.textContent = apiErrText(error);
    } finally {
      if (button && seq === mcpOpsSeq) button.disabled = false;
    }
  }

  function renderMcpCompat(compat) {
    const box = $('mcpCompatBox'); if (!box) return;
    box.textContent = '';
    // compat 以 stdio|http|sse 为键;能力/局限的文案服务端写的是中文(MCP_COMPAT_MATRIX),英文界面不能照搬 ——
    // 按键查本地化条目 settings.mcp.compat.<k>.capabilities / .limitations,查不到(新增的 transport)才回落服务端给的数组。
    const entries = compat && typeof compat === 'object' ? Object.entries(compat) : [];
    for (const [transportKey, capability] of entries) {
      const capKey = `settings.mcp.compat.${transportKey}.capabilities`;
      const limKey = `settings.mcp.compat.${transportKey}.limitations`;
      const capText = hasTranslation(capKey) ? t(capKey) : (Array.isArray(capability.capabilities) ? capability.capabilities.join(', ') : '');
      const limText = hasTranslation(limKey) ? t(limKey) : (Array.isArray(capability.limitations) ? capability.limitations.join('; ') : '');
      const item = el('div', 'mcp-compat-item');
      const head = el('div'); head.append(el('code', '', String(capability.transport || '')));
      item.append(
        head,
        el('div', 'mcp-compat-line', t('settings.mcp.capabilities') + ': ' + capText),
        el('div', 'mcp-compat-line', t('settings.mcp.limitations') + ': ' + limText),
      );
      box.append(item);
    }
  }

  function renderMcpConnList() {
    const list = $('mcpConnList'); if (!list) return;
    list.textContent = '';
    if (!mcpConnectorCache.length) {
      list.append(el('p', 'muted', t('settings.mcp.empty')));
      return;
    }
    for (const item of mcpConnectorCache) list.append(mcpConnItemEl(item));
  }

  function mcpConnItemEl(item) {
    const root = el('div', 'mcp-conn-item');
    const main = el('div', 'mcp-conn-main');
    const title = el('div', 'mcp-conn-title');
    const badgeClass = item.source === 'desktop' ? 'mcp-badge-desktop' : item.source === 'drop-in' ? 'mcp-badge-dropin' : 'mcp-badge-config';
    title.append(
      el('span', ('mcp-lamp ' + mcpHealthLampClass(item)).trim()),
      // 内置桌面控制的 label 是服务端中文('桌面控制 (ai-computer-control)'):按 id 走本地化键。
      el('strong', '', item.id === 'ai-computer-control' ? t('settings.mcp.desktopControl.label') : String(item.label || item.id || '')),
      el('span', 'mcp-badge ' + badgeClass, t(MCP_SOURCE_KEYS[item.source] || 'settings.mcp.source.config')),
      el('code', 'mcp-transport', String(item.transport || 'stdio')),
      el('span', 'muted', item.enabled === false ? t('settings.mcp.status.disabled') : t('settings.mcp.status.enabled')),
    );
    const sub = el('div', 'mcp-conn-sub'); sub.append(el('code', '', String(item.commandOrUrl || '')));
    const healthData = item.health;
    const healthClass = item.enabled === false || !healthData || !healthData.status
      ? ''
      : healthData.status === 'ok'
        ? 'mcp-health-ok'
        : healthData.status === 'degraded'
          ? 'mcp-health-degraded'
          : healthData.status === 'failed' ? 'mcp-health-failed' : '';
    const health = el('div', 'mcp-conn-health'); health.append(el('span', healthClass, mcpHealthText(item)));
    main.append(title, sub, health);

    const actions = el('div', 'mcp-conn-actions');
    const retest = el('button', 'mini', t('settings.mcp.action.retest')); retest.type = 'button';
    retest.disabled = item.enabled === false;
    if (item.enabled === false) retest.title = t('settings.mcp.retestDisabledHint');
    else retest.onclick = () => mcpRetest(item.id);
    actions.append(retest);

    const toggle = el('button', 'mini', item.enabled === false ? t('settings.mcp.action.enable') : t('settings.mcp.action.disable')); toggle.type = 'button';
    const remove = el('button', 'mini', t('settings.mcp.action.remove')); remove.type = 'button';
    if (item.source !== 'config') {
      const reason = item.source === 'desktop' ? t('settings.mcp.guardDesktop') : t('settings.mcp.guardDropIn');
      toggle.disabled = true; remove.disabled = true; toggle.title = reason; remove.title = reason;
    } else {
      toggle.onclick = () => mcpToggle(item.id, item.enabled !== false);
      remove.onclick = () => mcpRemove(item.id);
    }
    actions.append(toggle, remove);
    root.append(main, actions);
    return root;
  }

  async function mcpRetest(id) {
    try {
      const result = await api('/api/mcp/connectors/health', {
        method: 'POST',
        body: JSON.stringify({ id }),
      });
      const health = result && result.health;
      const item = mcpConnectorCache.find(connector => connector.id === id);
      if (item && health) item.health = health;
      renderMcpConnList();
      if (health && health.status === 'ok') toast(t('settings.mcp.retestOk', { p1: id, p2: health.toolCount || 0 }), 'ok');
      else if (health) toast(mcpHealthText({ health, enabled: true }), 'err');
    } catch (error) {
      toast(apiErrText(error), 'err');
    }
  }

  async function mcpToggle(id, currentlyEnabled) {
    try {
      const result = await api('/api/mcp/connectors/toggle', {
        method: 'POST',
        body: JSON.stringify({ id, enabled: !currentlyEnabled }),
      });
      if (result && result.ok) {
        toast(t(!currentlyEnabled ? 'settings.mcp.enabledOk' : 'settings.mcp.disabledOk', { p1: id }), 'ok');
        if (result.warning) toast(String(result.warning));
      }
    } catch (error) {
      toast(apiErrText(error), 'err');
    }
    await refreshMcpOps(false);
  }

  async function mcpRemove(id) {
    if (!confirm(t('settings.mcp.removeConfirm', { p1: id }))) return;
    try {
      const result = await api('/api/mcp/connectors', {
        method: 'POST',
        headers: { 'x-http-method': 'DELETE' },
        body: JSON.stringify({ id }),
      });
      if (result && result.ok) {
        toast(t('settings.mcp.removedOk', { p1: id }), 'ok');
        if (result.warning) toast(String(result.warning));
      }
    } catch (error) {
      toast(apiErrText(error), 'err');
    }
    await refreshMcpOps(false);
  }

  function bindSettingsOperations() {
    const refreshMcp = $('mcpRefreshBtn'); if (refreshMcp) refreshMcp.onclick = () => refreshMcpOps(true);
    const importMcp = $('mcpImportBtn');
    if (importMcp) importMcp.onclick = async () => { await importMcpFromFolder(importMcp); refreshMcpOps(false); };
    // 118a: 设置 → 基础 里的「重新打开引导」。向导可跳过，也必须可重开。
    const reopenOnboarding = $('reopenOnboardingBtn'); if (reopenOnboarding) reopenOnboarding.onclick = () => openOnboarding();
  }

  return Object.freeze({
    bindSettingsOperations,
    refreshMcpOps,
  });
}
