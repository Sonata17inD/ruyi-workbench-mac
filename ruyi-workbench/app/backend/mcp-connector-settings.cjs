'use strict';

const { URL } = require('node:url');

function createMcpConnectorSettings({
  BROWSER_AUTOMATION_MODES, generateMcpConfig, invalidateMcpRuntime, isRuyiMcpServerId, logEvent,
  mutateConfig, resolveExternalMcpServers, sanitizeExternalMcpServer, scanMcpDropIns, privacy,
}) {
  const {
    collectDisplayUrlRestores, mcpArgsForDisplay, restoreExternalMcpServerSecrets, safeUrlForDisplay,
  } = privacy;

  function safeMcpInventory(config) {
    return resolveExternalMcpServers(config).map(entry => ({
      id: entry.id, label: entry.label || entry.id, command: entry.command, args: mcpArgsForDisplay(entry.args || []),   // 107-S0b:args 显示脱敏(`--token xyz` 一类)
      cwd: entry.cwd || '', envKeys: Object.keys(entry.env || {}),
      // 49c:远程条目无 command,回显 transport+url(headers 键名可见,值永不回显)。
      // 107-S2:url 过 safeUrlForDisplay —— `https://u:p@host` 与 `?api_key=…` 此前经 mcp_list 明文回给模型。
      ...(entry.transport ? { transport: entry.transport, url: safeUrlForDisplay(entry.url || ''), headerKeys: Object.keys(entry.headers || {}) } : {}),
      builtin: entry.id === 'ai-computer-control',
    }));
  }

  function mcpConnectorMutateError(id, config, opts) {
    if (id === 'ai-computer-control') return { status: 409, error: '内置桌面连接器(ai-computer-control)不可在此启停/删除;请在「设置」中调整桌面控制开关。' };
    // 如意自己的 MCP server id(ruyi 与旧名 win-claude-workbench)是保留名:新建 / 改写成这个 id 的外部连接器,
    // 生成 MCP 配置时会被静默丢掉,连接器列表里还会出现两个同名项。导入路径早就挡了,这里补上手动新建 / mcp_configure。
    // 已经存在的同名旧条目仍然允许停用 / 删除(allowMissing 只在 upsert 时给)。
    if (opts && opts.allowMissing && isRuyiMcpServerId(id)) return { status: 409, error: `「${id}」是如意自己的 MCP 服务名,不能用作外部连接器的 id;请换一个 id。` };
    const list = (config && Array.isArray(config.externalMcpServers)) ? config.externalMcpServers : [];
    if (list.some(s => s && s.id === id)) return null;
    const drop = scanMcpDropIns().find(d => d && d.id === id);
    if (drop) return { status: 409, error: `连接器「${id}」是 drop-in 目录运行时合并的(${drop._dropInFolder}),不可在此启停/删除/改写;请移除对应目录后再试。` };
    if (opts && opts.allowMissing) return null;
    return { status: 404, error: '未找到连接器: ' + id };
  }

  // 停用/删除遮蔽了同 id drop-in 的 config 条目时的如实告知(resolveExternalMcpServers:config 优先,
  // 条目消失/停用后 drop-in 落入清单)。两个动作两句话,别处不要再抄一份。
  const MCP_DROPIN_SHADOW_WARNING = {
    remove: '注意:存在同 id 的 drop-in 连接器,删除该 config 条目后 drop-in 版本将生效;如需彻底移除,请同时删除对应 drop-in 目录。',
    disable: '注意:存在同 id 的 drop-in 连接器,停用该 config 条目后 drop-in 版本将生效;如需彻底停用,请移除对应 drop-in 目录。',
  };

  // ── 117n-M2:MCP 连接器变更的唯一内核 ────────────────────────────────────────────────────────
  // 修前同一件事有两处独立实现。HTTP 面(13b 的 POST /api/mcp/connectors/toggle 与
  // DELETE /api/mcp/connectors)做了八件事:源守卫 -> 改 list -> 落盘 -> invalidateMcpRuntime ->
  // 重生成 .mcp.json -> 删除时记 dismissedMcpIds -> drop-in 遮蔽警告 -> 审计。
  // 工具面(mcp_configure -> configureMcpFromTool)只做了其中三件,于是漏了三项副作用:
  //   · remove 不记 dismissedMcpIds -> 模型删掉的连接器下次启动被 autoImportClaudeCodeMcp 悄悄加回来;
  //   · 不调 generateMcpConfig -> .mcp.json 落后于 config.json,CLI 侧看到的是旧清单;
  //   · 没有源守卫(只硬编码挡了 ai-computer-control)-> drop-in 来源的连接器在工具面能改、
  //     HTTP 面却拒绝(同一件事两套判据),且零审计。
  // 现在两边都调这里,判据与副作用只有一份。op:'set-enabled' | 'remove' | 'upsert'
  // (upsert 是工具面专有的写入操作,但走同一条护栏与同一个 generateMcpConfig 收尾)。
  // 不收 config 入参:护栏与改 list 必须发生在 mutateConfig 的锁内、基于锁内刚读到的那一份,
  // 拿调用方的快照判定等于把丢失更新换个地方留着。
  // 返回 { ok:false, status, error } 或 { ok:true, op, id, config, server, removed, warning? }。
  async function mutateMcpConnector({ op, id, enabled, server }) {
    const wantId = String(id || '').trim();
    if (!wantId) return { ok: false, status: 400, error: 'id is required' };
    const on = enabled !== false;
    const r = await mutateConfig(async (config) => {
      const guard = mcpConnectorMutateError(wantId, config, { allowMissing: op === 'upsert' });
      if (guard) return { abort: { ok: false, status: guard.status, error: guard.error } };
      const list = Array.isArray(config.externalMcpServers) ? config.externalMcpServers.slice() : [];
      const dismissed = Array.isArray(config.dismissedMcpIds) ? config.dismissedMcpIds.slice() : [];
      const idx = list.findIndex(s => s && s.id === wantId);
      if (op === 'set-enabled') {
        list[idx] = { ...list[idx], enabled: on };
      } else if (op === 'remove') {
        list.splice(idx, 1);
        // 记入 dismissedMcpIds:启动时 autoImportClaudeCodeMcp 会跳过它,避免「删了又自动回来」。
        // (normalizeConfig 去重;用户经 import-folder/import-config/upsert 显式再导入会从 dismissed 移除。)
        if (!dismissed.includes(wantId)) dismissed.push(wantId);
      } else if (op === 'upsert') {
        // 107-S0b:模型可能把读到的掩码(env／headers 的 ••••、args 的脱敏标记)原样回传 —— 与 POST /api/config 同一条
        // 还原规则:同 id 且启动向量(command／cwd／args,远程为 url)没变才取磁盘真值,否则 sanitize 那道闸清空。
        // 107-S2:远程 url 的显示脱敏(`?api_key=••••cdef`)也在这里对回真值 —— 模型从 mcp_list／
        // steward_config_get 读到的就是脱敏形,原样 upsert 回来是常态。对不回去的(改了一半的掩码)
        // 活不过 sanitize -> 下面那句 400,不会把掩码写进 config.json,也不会把连接器静默改接到别处。
        const clean = sanitizeExternalMcpServer(restoreExternalMcpServerSecrets({ ...(server || {}), id: wantId }, idx >= 0 ? list[idx] : null, collectDisplayUrlRestores(config)));
        if (!clean) return { abort: { ok: false, status: 400, error: 'MCP 配置无效：upsert 至少需要 id 与 command，args 必须是字符串数组。' } };
        // 122-§2.6:用户/工具显式 upsert = 接管这条连接器 —— 清掉来源标记,它从此算 Ruyi 自己的、照常同步回
        // Claude Code。显式删掉(不是让 sanitize 缺省丢弃):调用方可能把读出来的整条 server 原样回传。
        delete clean.origin;
        if (idx >= 0) list[idx] = clean; else list.push(clean);
        // 显式(再)导入覆盖撤销 —— 与 import-folder / import-config/apply 同语义。
        for (let i = dismissed.length - 1; i >= 0; i--) if (dismissed[i] === wantId) dismissed.splice(i, 1);
      } else {
        return { abort: { ok: false, status: 400, error: 'operation 必须是 upsert、remove 或 set-enabled' } };
      }
      config.externalMcpServers = list;
      config.dismissedMcpIds = dismissed;
      return {};
    });
    if (!r.ok) return r.value;
    const next = r.config;
    invalidateMcpRuntime(wantId); // 杀活客户端 / 清失败冷却:停用后不再重连,启用后可立即重测
    await generateMcpConfig(next.mcpCommandMode).catch(() => {}); // 与 import 路径一致:启用集变化后再生成 .mcp.json
    const shadowKind = op === 'remove' ? 'remove' : (op === 'set-enabled' && !on ? 'disable' : '');
    const warning = (shadowKind && scanMcpDropIns().some(d => d && d.id === wantId)) ? MCP_DROPIN_SHADOW_WARNING[shadowKind] : null;
    if (op === 'remove') logEvent({ kind: 'mcp_connector_delete', id: wantId });
    else if (op === 'set-enabled') logEvent({ kind: 'mcp_connector_toggle', id: wantId, enabled: on });
    else logEvent({ kind: 'mcp_connector_upsert', id: wantId });
    return { ok: true, op, id: wantId, config: next, removed: op === 'remove',
      server: (next.externalMcpServers || []).find(s => s && s.id === wantId) || null,
      ...(warning ? { warning } : {}) };
  }

  // 工具面入口(mcp_configure)。117n-M2 起只剩「工具形状 + set-browser」,连接器三操作全部转
  // mutateMcpConnector。第二个参数 currentConfig 保留在签名里只为兼容既有调用点(12-tool-dispatch),
  // 【有意不再使用】:落盘前的读必须发生在 mutateConfig 的锁内,回合起点的快照到这里已可能陈旧。
  // 把 args 字符串按 shell 口径切开(空白分隔,单/双引号成组,不处理反斜杠转义 —— Windows 路径里全是反斜杠)。
  function splitMcpArgsString(text) {
    const out = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m;
    while ((m = re.exec(String(text || '')))) out.push(m[1] != null ? m[1] : (m[2] != null ? m[2] : m[3]));
    return out;
  }
  // 外部 MCP 连接器 id 的合法形(与 upsert 落盘文件名/CLI 键名兼容;含空格/斜杠/.. 的 id 会让 .mcp.json 键与路径判断出岔子)。
  const MCP_CONNECTOR_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
  // set-browser 的入参校验与合并 —— 修前对非法输入一律静默改写成默认值还回 ok:true(mode:'bogus' 存成 system、
  // 缺 browser 对象把自定义的 executable/cdpUrl 重置、cdpUrl:'not a url' 原样落盘、custom 没有 executable 也存)。
  // 现在:只改显式给出的字段(其余沿用磁盘上的现值);任何一项不合法就整次拒绝并点名允许值。返回 { error } 或 { browser }。
  function validateBrowserTargetPatch(raw, current) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Object.keys(raw).length) {
      return { error: `set-browser 需要 browser 对象:{mode: ${BROWSER_AUTOMATION_MODES.join('|')}, executable?, cdpUrl?}` };
    }
    const next = { ...(current || {}) };
    if (raw.mode !== undefined) {
      const mode = String(raw.mode).trim().toLowerCase();
      if (!BROWSER_AUTOMATION_MODES.includes(mode)) return { error: `browser.mode 无效:${JSON.stringify(raw.mode)};允许值 ${BROWSER_AUTOMATION_MODES.join(' / ')}` };
      next.mode = mode;
    }
    if (raw.executable !== undefined) {
      if (typeof raw.executable !== 'string') return { error: 'browser.executable 必须是字符串(浏览器可执行文件路径)' };
      next.executable = raw.executable.trim();
    }
    if (raw.cdpUrl !== undefined) {
      const url = typeof raw.cdpUrl === 'string' ? raw.cdpUrl.trim() : '';
      let ok = false;
      try { ok = /^(https?|wss?):$/.test(new URL(url).protocol); } catch { ok = false; }
      if (!ok) return { error: `browser.cdpUrl 不是合法地址:${JSON.stringify(raw.cdpUrl)};需要 http(s):// 或 ws(s):// 开头,如 http://127.0.0.1:9222` };
      next.cdpUrl = url;
    }
    if (next.mode === 'custom' && !String(next.executable || '').trim()) return { error: "browser.mode 为 custom 时必须同时给出 executable(浏览器可执行文件的完整路径)" };
    return { browser: { mode: next.mode, executable: next.executable, cdpUrl: next.cdpUrl } };
  }

  // 工具面入口(mcp_configure)。117n-M2 起只剩「工具形状 + set-browser」,连接器三操作全部转
  // mutateMcpConnector。第二个参数 currentConfig 保留在签名里只为兼容既有调用点(12-tool-dispatch),
  // 【有意不再使用】:落盘前的读必须发生在 mutateConfig 的锁内,回合起点的快照到这里已可能陈旧。
  async function configureMcpFromTool(args, currentConfig) {
    void currentConfig; // 见上:有意不用
    const operation = String(args && args.operation || '').trim();
    if (operation === 'set-browser') {
      // 校验与合并都在 mutateConfig 的锁内、基于锁内刚读到的那份现值(同连接器写入的纪律)。
      const r = await mutateConfig(async (config) => {
        const checked = validateBrowserTargetPatch(args && args.browser, config.browserAutomation);
        if (checked.error) return { abort: { ok: false, operation, error: checked.error } };
        config.browserAutomation = checked.browser;
        return {};
      });
      if (!r.ok) return r.value;
      invalidateMcpRuntime('ai-computer-control');
      return { ok: true, operation, browserAutomation: r.config.browserAutomation,
        note: '浏览器目标已保存；当前桌面 MCP 连接已刷新，下一次工具发现会按新策略启动。' };
    }
    const id = String(args && (args.id || (args.server && args.server.id)) || '').trim();
    if (!id || id === 'ai-computer-control') return { ok: false, error: '外部 MCP 需要合法 id；内置 ai-computer-control 只能用 set-browser 调整浏览器目标。' };
    if (operation !== 'upsert' && operation !== 'remove' && operation !== 'set-enabled') {
      return { ok: false, error: 'operation 必须是 upsert、remove、set-enabled 或 set-browser' };
    }
    let server = (args && args.server) || null;
    if (operation === 'upsert') {
      // 新建/改写的入口形状校验(remove / set-enabled 不卡:历史导入的 id 可能带别的字符,照样要能停用/删除)。
      if (!MCP_CONNECTOR_ID_RE.test(id)) return { ok: false, operation, id, error: 'MCP id 只能含字母、数字、下划线、点和连字符(1-64 个字符),不能含空格或斜杠。' };
      if (server !== null && (typeof server !== 'object' || Array.isArray(server))) return { ok: false, operation, id, error: 'server 必须是对象:{command, args[], cwd, env{}, enabled},远程连接器用 {transport, url}' };
      if (server && server.args !== undefined) {
        // args 给成一个字符串(模型常这么写)修前被静默存成 [];按 shell 口径切开,数组里混进非字符串则拒绝。
        if (typeof server.args === 'string') server = { ...server, args: splitMcpArgsString(server.args) };
        else if (!Array.isArray(server.args) || server.args.some(a => typeof a !== 'string')) return { ok: false, operation, id, error: 'server.args 必须是字符串数组(或一个按空格切分的字符串)。' };
      }
    }
    const r = await mutateMcpConnector({ op: operation, id, enabled: args && args.enabled, server });
    if (!r.ok) return { ok: false, operation, id, error: r.error };
    const saved = r.server;
    return { ok: true, operation, id, removed: r.removed, ...(r.warning ? { warning: r.warning } : {}),
      server: saved ? { id: saved.id, label: saved.label, command: saved.command, args: mcpArgsForDisplay(saved.args), cwd: saved.cwd, enabled: saved.enabled, envKeys: Object.keys(saved.env || {}) } : null,   // 107-S0b:args 显示脱敏
      note: '配置已原子保存并刷新工具目录；若工具仍不可用，请读取 MCP 列表与启动诊断。' };
  }

  return { safeMcpInventory, configureMcpFromTool, mutateMcpConnector };
}

module.exports = { createMcpConnectorSettings };
