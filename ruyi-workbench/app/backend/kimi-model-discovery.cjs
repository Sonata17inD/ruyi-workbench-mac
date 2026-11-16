'use strict';
const { StringDecoder } = require('node:string_decoder');

function createKimiModelDiscovery({ ProcessRuntime, selectedAgentCli, prepareAgentCliSpawn, killChildTree, redact, safeJsonParse }) {
  // Kimi's `--model` values are aliases from `kimi provider list --json` (for example
  // `kimi-code/k3-256k`), not the bare backend model ids historically remembered by the Claude adapter.
  // The no-discovery form is intentionally tiny so Claude knownModels never leak into the Kimi picker.
  function kimiModelList(config, discovered) {
    const seen = new Map([['', { id: '', label: '默认 (Kimi 配置)' }]]);
    const add = (id, label, contextLength) => {
      const key = String(id || '').trim();
      if (!key || seen.has(key)) return;
      const item = { id: key, label: String(label || key).trim() || key };
      const cl = Number(contextLength);
      if (Number.isFinite(cl) && cl > 0) item.contextLength = Math.round(cl);
      seen.set(key, item);
    };
    if (Array.isArray(discovered)) {
      for (const item of discovered) add(item && item.id, item && item.label, item && item.contextLength);
    } else if (config && config.model) {
      add(config.model, `${config.model} (当前选择)`);
    }
    return [...seen.values()];
  }

  // Query the installed Kimi Code CLI itself, which is the source of truth for OAuth-managed and custom
  // providers. This is local/read-only and avoids baking account-specific aliases into Ruyi.
  async function discoverKimiModels(config) {
    const fallback = kimiModelList(config);
    const capability = await ProcessRuntime.helperCapabilityAsync();
    if (!capability.ready) return { ok: false, models: fallback, discoveredCount: 0, code: capability.code, capability, error: 'Mac 进程监督器尚未就绪' };
    const selected = selectedAgentCli({ ...(config || {}), agentCliType: 'kimi' });
    if (!selected.path) return Promise.resolve({ ok: false, models: fallback, discoveredCount: 0, error: '未检测到 Kimi Code CLI' });
    const launch = prepareAgentCliSpawn('kimi', selected.path, ['provider', 'list', '--json']);
    return new Promise((resolve, reject) => {
      void (async () => {
      let child;
      let stdout = '';
      let stderr = '';
      let settled = false;
      let stopping = false;
      let stdoutBytes = 0, stderrBytes = 0;
      const stdoutDecoder = new StringDecoder('utf8');
      const stderrDecoder = new StringDecoder('utf8');
      const finish = value => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        const cleanup = child ? ProcessRuntime.result(child) : null;
        const cleanupFields = cleanup ? { cleanupScope: cleanup.scope, cleanupIncomplete: cleanup.incomplete,
          cleanupEscapeCoverage: cleanup.escapeCoverage, cleanupUnconfirmed: cleanup.unconfirmed } : {};
        if (value.ok && cleanup?.incomplete) value = { ok: false, models: fallback, discoveredCount: 0, error: 'Kimi 模型探针的进程清理尚未确认' };
        try { child?.stdout?.destroy(); child?.stderr?.destroy(); } catch { /* Completion still reports the cleanup result. */ }
        resolve({ ...cleanupFields, ...value });
      };
      const stopProbe = async reason => {
        if (stopping || settled) return;
        stopping = true; clearTimeout(timer);
        let cleanup;
        try { killChildTree(child); cleanup = await ProcessRuntime.waitForCleanup(child, 1500); }
        catch { cleanup = { incomplete: true }; }
        finally {
          let error = reason === 'timeout' ? '读取 Kimi Code 模型列表超时' : 'Kimi Code 模型探针输出超过上限';
          if (cleanup?.incomplete !== false) error += '，进程清理尚未确认';
          finish({ ok: false, models: fallback, discoveredCount: 0, cleanupIncomplete: cleanup?.incomplete !== false,
            timedOut: reason === 'timeout', code: reason === 'timeout' ? 'process_timeout' : 'process_output_limit', error });
        }
      };
      const timer = setTimeout(() => { void stopProbe('timeout'); }, 10000);
      try {
        const options = { stdio: ['ignore', 'pipe', 'pipe'], ...launch.opts, admit: () => { if (settled || stopping) throw Object.assign(new Error('Model discovery cancelled'), { code: 'ABORT_ERR' }); } };
        child = await ProcessRuntime.spawn(launch.command, launch.args, options, { ...ProcessRuntime.currentOwner(), kind: 'cli-model-discovery', cliType: 'kimi' });
      } catch (error) {
        if (stopping) return;
        finish({ ok: false, models: fallback, discoveredCount: 0, error: `无法启动 Kimi Code CLI: ${redact(error && error.message || String(error))}` });
        return;
      }
      child.stdout.on('data', chunk => {
        if (stopping || settled) return;
        stdoutBytes += chunk.length;
        if (stdoutBytes > 1024 * 1024) { void stopProbe('output-limit'); return; }
        stdout += stdoutDecoder.write(chunk);
      });
      child.stderr.on('data', chunk => {
        if (stopping || settled) return;
        stderrBytes += chunk.length;
        if (stderrBytes > 64 * 1024) { void stopProbe('output-limit'); return; }
        stderr += stderrDecoder.write(chunk);
      });
      child.on('error', error => { if (!stopping) finish({ ok: false, models: fallback, discoveredCount: 0, error: `无法启动 Kimi Code CLI: ${redact(error && error.message || String(error))}` }); });
      child.on('close', code => {
        if (settled || stopping) return;
        stdout += stdoutDecoder.end(); stderr += stderrDecoder.end();
        if (code !== 0) {
          finish({ ok: false, models: fallback, discoveredCount: 0, error: redact(stderr.trim() || `Kimi Code CLI 退出码 ${code}`).slice(0, 1000) });
          return;
        }
        const parsed = safeJsonParse(stdout.trim(), null);
        const rawModels = parsed && parsed.models && typeof parsed.models === 'object' ? parsed.models : null;
        if (!rawModels || Array.isArray(rawModels)) {
          finish({ ok: false, models: fallback, discoveredCount: 0, error: 'Kimi Code 返回了无法识别的模型列表' });
          return;
        }
        const discovered = [];
        for (const [alias, raw] of Object.entries(rawModels).slice(0, 100)) {
          const id = String(alias || '').trim();
          if (!id) continue;
          const item = raw && typeof raw === 'object' ? raw : {};
          const display = String(item.displayName || item.model || id).trim() || id;
          discovered.push({ id, label: display === id ? id : `${display} · ${id}`, contextLength: Number(item.maxContextSize) || undefined });
        }
        finish({ ok: true, models: kimiModelList(config, discovered), discoveredCount: discovered.length });
      });
    })().catch(reject);
    });
  }
  return { kimiModelList, discoverKimiModels };
}

module.exports = { createKimiModelDiscovery };
