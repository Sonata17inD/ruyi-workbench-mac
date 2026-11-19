'use strict';

const os = require('node:os');
const { apiFailure, json, send } = require('./http-protocol.cjs');
const { PERMISSION_MODES } = require('./agent-role-policy.cjs');
const { ERROR_CLASSES } = require('./turn-error-classes.cjs');

function createStatusRoutes({
  paths, RUNTIME, ServerStartNotices, readConfig, maskProviders, requestIsLoopback, computeHealth, getCapabilities, probeRgAsync,
  identity: { APP_NAME, VERSION, CONFIG_SCHEMA, OVERLAY_ID, dataRootAliases, exePath },
  conversation: { safeSessionId, readSessionRouteHead, configForSessionEngineRoute, activeOpenAiProvider,
    agentConversationContextMeta, configuredConversationWindow, resolveContextWindow, learnedWindowCap },
  cli: { agentCliAdapter, detectClaudePath, detectKimiPath, AGENT_CLI_TYPES, selectedAgentCli },
  desktopMcp: { desktopMcpDetectionPending, mcpConfigFilePath, generateMcpConfig, ensureDesktopMcpWarm,
    detectDesktopMcp, resolveExternalMcpServers },
  tools: { MCP_TOOLS, runtimeToolRequirementsMet, nativeToolDisabledByPolicy, observationRecallEnabled, isStewardToolName },
  ToolboxHooks, PROVIDER_PRESETS, CLAUDE_ENDPOINT_PRESETS,
}) {
  async function handleStatusApiRoutes(req, res, pathname) {
    if (req.method === 'POST' && pathname === '/api/bootstrap') {
      // 47c(S1):浏览器拿 token 的【唯一】通道(HTML 不再明文下发)。auth=open -> 顶层 host 门已挡 rebinding
      // (Host=攻击域 -> 403),信任面与旧 GET / 明文下发完全等同;非浏览器(curl/node)亦同旧规可得。
      // 不查 Origin:'open' 级本就允许 loopback 非浏览器,浏览器同源(Host=loopback)也放行,跨站 rebinding 已被 host 门拦。
      // 安全走查 S13(纵深):authorizeRoute 已对非本机对端拒掉这条路由;这里再核一次对端地址,别让以后改鉴权表的人把它放开。
      if (!requestIsLoopback(req)) return send(res, apiFailure('auth.remote_denied', {}, 'remote client not allowed', 403));
      return send(res, json({ ok: true, token: RUNTIME.token || '' }));
    }
    if (req.method === 'GET' && pathname === '/api/status') {
      const config = await readConfig();
      let conversationConfig = config;
      try {
        const requestedSessionId = safeSessionId(new URL(req.url, 'http://127.0.0.1').searchParams.get('sessionId') || '');
        if (requestedSessionId) {
          // 开放读口只读会话头(02 readSessionRouteHead 头注):不装载、不回写。
          const statusHead = await readSessionRouteHead(requestedSessionId);
          if (statusHead) conversationConfig = configForSessionEngineRoute(config, statusHead);
        }
      } catch { /* status without a valid session keeps the global new-session default */ }
      // 128f-③(48 号文 §2-c):桌面组件的 Python 探测还在飞(缓存冷)时,本路由【不等、也不走同步探针】——
      // 健康项报 preparing、desktopMcp 报 probing、mcpConfigPath 只回路径;前端见 probing 自己有界跟进。
      // 修前这里三处 await 预热:Full 包首个 /api/status 实测 8.7–8.9 s,整个界面跟着等内嵌 Python 导入 FastMCP。
      const desktopPending = desktopMcpDetectionPending(config);
      const { health, manifest, runtime } = await computeHealth(config, { desktopPending });
      return send(res, json({
        ok: true,
        app: APP_NAME,
        version: VERSION,
        configSchema: CONFIG_SCHEMA, // v0.8-S0: surfaced top-level so clients/tests don't dig into config
        overlayId: OVERLAY_ID,
        launchMode: RUNTIME.launchMode,
        dataRoot: paths.data, dataRootAliases: dataRootAliases(), homeDir: os.homedir(),   // homeDir:体验走查 #7,向导据此判「工作文件夹是不是整个用户目录」
        exePath: exePath(),
        exePresent: false, // Legacy status field retained for older clients.
        config: maskProviders(config), // F2: never emit plaintext provider api keys in the response

        permissionModes: PERMISSION_MODES,
        // Resolve the conversation route (including CLI/manual overrides), never the summary provider.
        contextWindowResolved: await (async () => {
          const p = activeOpenAiProvider(conversationConfig);
          if (!p) {
            const meta = await agentConversationContextMeta(conversationConfig, null);
            return { value: meta.contextWindow, source: meta.contextWindowSource, engine: 'agent', agentCliType: meta.contextAgentCliType, provider: '', model: String(conversationConfig.model || '') };
          }
          const model = p ? String(p.model || (p.models && p.models[0] && p.models[0].id) || '').trim() : '';
          const manual = configuredConversationWindow(conversationConfig, 'openai', p.id, model);
          const r = resolveContextWindow(manual ? { ...p, contextWindow: manual } : p, model);
          // 45f 对抗轮 P3-5:窗口学习生效时如实展示 —— 否则用户看到「才用一半就压缩」会对不上账。
          const cap = p ? learnedWindowCap(p.id, model) : 0;
          return { value: cap ? Math.min(r.value, cap) : r.value, source: r.source, provider: p ? p.id : '', model, learnedCap: cap || undefined };
        })(),
        models: agentCliAdapter(conversationConfig.agentCliType).modelCatalog.offline(conversationConfig), // instant offline list for the requested conversation route (per-CLI adapter, 05)
        providerPresets: PROVIDER_PRESETS, // v0.5: built-in OpenAI-compatible provider templates (local Ollama/LM Studio + custom; no vendor presets)
        toolbox: typeof ToolboxHooks.statusView === 'function' ? ToolboxHooks.statusView(config) : { autoDiscover: false, components: [] },   // ruyi-toolbox 已登记的组件与各自状态(只读视图;命令不出进程)
        claudeEndpointPresets: CLAUDE_ENDPOINT_PRESETS, // v1.4.4: third-party Anthropic-compatible endpoint templates for the Claude CLI engine (custom only; no vendor presets)
        detectedClaudePath: detectClaudePath(),
        detectedKimiPath: detectKimiPath(),
        agentCliDrivers: Object.values(AGENT_CLI_TYPES).map(d => ({ ...d, path: selectedAgentCli({ ...config, agentCliType: d.id }).detected })),
        mcpConfigPath: desktopPending ? mcpConfigFilePath() : await generateMcpConfig(config.mcpCommandMode),
        // v0.7d: desktop MCP discovery status for the settings UI. `detected` is the autodetect result
        // (null when not found); `resolved` is what would actually be launched (honors explicit overrides).
        desktopMcp: desktopPending ? {
          enabled: !!(config.desktopMcp && config.desktopMcp.enabled), detected: null, resolved: null, probing: true,
        } : await (async () => {
          // 39 号文:先等那趟异步预热。缓存热时它是个已决 Promise(零开销);冷时若不等,下面两行会
          // 同步 spawnSync 逐个探候选,把整个进程钉住 ~2 s —— e2e 每件的首个 /api/status 正是这一处。
          await ensureDesktopMcpWarm(config);
          const enabled = !!(config.desktopMcp && config.desktopMcp.enabled);
          const detected = detectDesktopMcp();
          const resolved = resolveExternalMcpServers(config).find(s => s.id === 'ai-computer-control') || null;
          return {
            enabled,
            detected: detected ? { command: detected.command, args: detected.args, via: detected.via, pythonSource: detected.pythonSource || '' } : null,
            resolved: resolved ? { command: resolved.command, args: resolved.args, cwd: resolved.cwd || '', pythonSource: resolved.pythonSource || '' } : null,
          };
        })(),
        health,
        runtime,
        manifest,
        // 118c: 一次性启动提示(上次启动失败的人话 / 本次改用了哪个端口)。纯进程内常量,恒定形状,
        // 两个位都可能为 null。前端顶部条消费,详见 START_NOTICE 处的口径说明。
        startNotice: ServerStartNotices.START_NOTICE,
        // v0.8-S1: vendored-binary capability probe (additive). S6's capability matrix will formally own
        // this; the `rg` field is established here so file_search's fast-path status is observable now.
        // 145-W3:异步探测＋进程级缓存(修前 hasRg() 冷缓存在请求路径上 spawnSync rg --version);rgSource 加法字段。
        binaries: await probeRgAsync().then(info => ({ rg: !!info, rgSource: info ? info.source : null })).catch(() => ({ rg: false, rgSource: null })),
        // v0.9-S1 (C6): expose the ERROR_CLASSES table top-level so the error-humanization UI renders zh/next
        // from the single server-side source of truth (result.errorClass keys into this) — no double-maintain.
        errorClasses: ERROR_CLASSES,
        // 116c: /api/status 的工具清单是【设置页面向用户的目录】,管家工具族一律不出现在这里(四个
        // offer 面之一)—— 它们只属于 kind==='steward' 的管家会话,不是用户可挑选的会话工具。
        tools: MCP_TOOLS.filter(t => runtimeToolRequirementsMet(t.name, runtime).met && !nativeToolDisabledByPolicy(t.name, config) && (t.name !== 'observation_recall' || observationRecallEnabled(config)) && !isStewardToolName(t.name)).map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      }));
    }
    // v0.8-S6: capability matrix (§7.2). Read-only → same-origin gate is enough (not in needsToken). 60s
    // internal cache; ?force=1 busts it (used by the UI popover for an on-open refresh). Never throws.
    if (req.method === 'GET' && pathname === '/api/capabilities') {
      const config = await readConfig();
      const force = new URL(req.url, 'http://x').searchParams.get('force') === '1';
      const caps = await getCapabilities(config, force).catch(() => null);
      if (!caps) return send(res, json({ ok: false, error: 'capability probe failed' }, 500));
      return send(res, json({ ok: true, ...caps }));
    }
  }

  return handleStatusApiRoutes;
}

module.exports = { createStatusRoutes };
