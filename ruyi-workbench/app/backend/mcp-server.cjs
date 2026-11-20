'use strict';
const readline = require('node:readline');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { RUYI_MCP_SERVER_ID } = require('./product-identity.cjs');

// One stdio connection owns its accepted calls and bridge-drain lifecycle.
function createMcpServer({ input, output, env, version, configPath,
  readConfig, PrivacyGateway, ProcessRuntime, observationRecallEnabled, policyDesktopOverrideFor, runtimeToolRequirementsMet, nativeToolDisabledByPolicy, isStewardToolName, toolPackForName, toolCall, VisualPipeline, truncateToolResult, maskProviders, samePathKey, killAllMcpClients, safeJsonParse, MCP_TOOLS
}) {
  function sendMcp(id, result, error) {
    const payload = error
      ? { jsonrpc: '2.0', id, error: { code: -32000, message: error.message || String(error) } }
      : { jsonrpc: '2.0', id, result };
    output.write(`${JSON.stringify(payload)}\n`);
  }
  function sendMcpNotification(method, params) {
    output.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  function start() {
    const rl = readline.createInterface({ input: input, crlfDelay: Infinity });
    let inputClosed = false;
    let pendingRequests = 0;
    const closeBridgesWhenDrained = () => {
      if (inputClosed && pendingRequests === 0) killAllMcpClients();
    };
    // EOF accepts no new calls. Finish already accepted requests, then close their bridges so
    // pipe handles and a live ACC child cannot keep a disconnected stdio server alive forever.
    rl.once('close', () => { inputClosed = true; closeBridgesWhenDrained(); });
    rl.on('line', line => {
      void (async () => {
        if (inputClosed || !line.trim()) return;
        const msg = safeJsonParse(line);
        if (!msg || !msg.method) return;
        pendingRequests += 1;
        try {
          if (msg.method === 'initialize') {
            return sendMcp(msg.id, {
              protocolVersion: msg.params?.protocolVersion || '2024-11-05',
              capabilities: { tools: {}, resources: {} },
              serverInfo: { name: RUYI_MCP_SERVER_ID, version: version }, // MCP 服务端标识名与 server id 一致
            });
          }
          if (msg.method === 'tools/list') {
            const userInputEnabled = Boolean(env.WCW_SESSION_ID) && env.WCW_DISABLE_USER_INPUT !== '1';
            const mode = env.WCW_TOOL_LOADING_MODE || 'full';
            const routedPacks = new Set(String(env.WCW_TOOL_PACKS || '').split(',').filter(Boolean));
            routedPacks.add('core');
            const adaptiveAlways = new Set(['permission_prompt', 'list_tools', 'tool_search', 'tool_load', 'tool_invoke_read', 'tool_invoke_edit', 'tool_invoke_exec']);
            const listConfig = await readConfig();
            PrivacyGateway.assertPolicyAvailable(listConfig);
            if (PrivacyGateway.enabled(listConfig)) return sendMcp(msg.id, { tools: [], _meta: { privacy: 'privacy.engine_not_supported' } });
            const runtime = await ProcessRuntime.capabilitySnapshot();
            const recallEnabled = observationRecallEnabled(listConfig);
            const stewardSession = env.WCW_SESSION_KIND === 'steward';
            const desktopOverride = await policyDesktopOverrideFor();
            const listed = MCP_TOOLS.filter(t => {
              if (!runtimeToolRequirementsMet(t.name, runtime).met) return false;
              if (nativeToolDisabledByPolicy(t.name, listConfig, desktopOverride)) return false;
              if (t.name === 'request_user_input' && !userInputEnabled) return false;
              if (t.name === 'observation_recall' && !recallEnabled) return false; // 105a: 双开关门
              if (isStewardToolName(t.name) && !stewardSession) return false; // 116c: 管家工具族门
              if (mode !== 'auto') return true;
              return adaptiveAlways.has(t.name) || routedPacks.has(toolPackForName(t.name, {}));
            });
            return sendMcp(msg.id, { tools: listed });
          }
          if (msg.method === 'tools/call') {
            const name = msg.params?.name;
            const args = msg.params?.arguments || {};
            const progressToken = msg.params?._meta?.progressToken;
            const progressStartedAt = Date.now();
            // Claude CLI may attach an MCP progress token to a long tool call. Report elapsed liveness while
            // orchestrate_agents is waiting on the synchronous DAG result; this is in addition to the app-level
            // workflow heartbeat and helps MCP clients distinguish "still running" from a dead server.
            const progressTimer = (name === 'orchestrate_agents' || name === 'wait_agents') && progressToken != null ? setInterval(() => {
              const elapsedSec = Math.max(1, Math.round((Date.now() - progressStartedAt) / 1000));
              try { sendMcpNotification('notifications/progress', { progressToken, progress: elapsedSec, message: `Agent 工作流仍在运行 · ${elapsedSec}s` }); } catch {}
            }, 10000) : null;
            if (progressTimer && progressTimer.unref) progressTimer.unref();
            try {
              const result = await toolCall(name, args);
              PrivacyGateway.assertSupported(await readConfig(), 'external-tool-result');
              // S1 修复:MCP tools/call 路径(Claude 引擎)原样直出大结果会灌爆 CLI context。
              // 经 truncateToolResult 截断(file_read 走 head/tail,其余 60KB+标记),与 OpenAI 引擎 push 路径一致。
              const images = VisualPipeline.extractToolImages(result);
              const modelResult = images.length ? VisualPipeline.stripToolImageFields(result, '[image attached in MCP content]') : result;
              const text = truncateToolResult(name, JSON.stringify(modelResult, null, 2));
              return sendMcp(msg.id, {
                content: [{ type: 'text', text }, ...images.map(uri => {
                  const split = uri.indexOf(';base64,');
                  return { type: 'image', mimeType: uri.slice(5, split), data: uri.slice(split + 8) };
                })],
                isError: result.ok === false,
              });
            } finally {
              if (progressTimer) clearInterval(progressTimer);
            }
          }
          if (msg.method === 'resources/list') {
            const resourceConfig = await readConfig();
            PrivacyGateway.assertPolicyAvailable(resourceConfig);
            if (PrivacyGateway.enabled(resourceConfig)) return sendMcp(msg.id, { resources: [], _meta: { privacy: 'privacy.engine_not_supported' } });
            return sendMcp(msg.id, {
              resources: [
                {
                  uri: pathToFileURL(configPath).href,
                  name: 'Workbench config',
                  description: 'Local workbench configuration file',
                  mimeType: 'application/json',
                },
              ],
            });
          }
          if (msg.method === 'resources/read') {
            const resourceConfig = await readConfig();
            PrivacyGateway.assertSupported(resourceConfig, 'external-resource');
            const uri = String(msg.params?.uri || '');
            const resource = new URL(uri);
            if (resource.protocol !== 'file:' || resource.hostname || resource.search || resource.hash) throw new Error('Only local file:// resources are supported');
            const p = fileURLToPath(resource);
            // resources/list only exposes the config file — confine reads to exactly it (no traversal,
            // no UNC/SMB egress from an "offline" tool).
            const resolved = path.resolve(p);
            if (samePathKey(resolved) !== samePathKey(configPath)) throw new Error('resource not found');
            // 128e(48 号文 §1,实测坐实):修前这里把 config.json【原样】读出来返回 —— 明文的 provider apiKey、Claude CLI 的
            // modelsApiKey、外部 MCP 连接器 env 里的令牌,连到工作台 MCP 的模型用读资源的工具就能拿走(GET /api/status 早在
            // 107-S0／S0b 掩了同一批值,文件工具也把 config.json 列为敏感路径拒读 —— 这是绕过两道门的第三条路)。
            // 现在交出去的是与 /api/status 同一份掩码视图(maskProviders,不另写一套),并且是归一化后的整份配置 ——
            // 128a 之后盘上是稀疏文件,原样读反而给不出「当前生效的配置」。
            const view = maskProviders(resourceConfig);
            return sendMcp(msg.id, { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(view, null, 2) }] });
          }
          if (msg.id !== undefined) return sendMcp(msg.id, {});
        } catch (err) {
          // A long tool may fail after protection was enabled in the serving process.
          // Error text can contain private paths or stdout too; recheck before exposing it.
          try { PrivacyGateway.assertSupported(await readConfig(), 'external-error'); }
          catch (policyError) { err = new Error(policyError.code === 'privacy.engine_not_supported' ? policyError.code : 'privacy.policy_unavailable'); }
          return sendMcp(msg.id, null, err);
        } finally {
          pendingRequests -= 1;
          closeBridgesWhenDrained();
        }
      })();
    });
  }
  return { start };
}

module.exports = { createMcpServer };
