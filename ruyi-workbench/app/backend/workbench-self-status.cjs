'use strict';

function createWorkbenchSelfStatus({
  RUNTIME, ProcessRuntime, buildRuntimeIdentityFacts, computeHealth, nativeToolCount, readConfig, catalog,
  providers,
}) {
  const { BUILTIN_AGENT_WORKFLOWS, getAgentWorkflows, getCapabilities, loadSkillRegistry } = catalog;
  const { activeOpenAiProvider, providerWireProtocol, resolveAsrProvider, selectedAgentCli } = providers;

  // 116c: 108c 的自状态装配从 handler 里零行为抽成同模块函数,让 13g 的 steward_self_status 复用同一份
  // 事实源(§3.5「复用 workbench_self_status 装配并加管家段」——不新造第二个事实源)。逻辑逐行未变;
  // 唯一新增是「未知 section 回落 all」的既有行为对 'steward' 也成立(该段由 13g 自己追加,本函数不认识它)。
  async function buildWorkbenchSelfStatus(args, ctx) {
        const SECTIONS = new Set(['identity', 'health', 'counts', 'config', 'capabilities', 'all']);
        const section = SECTIONS.has(args && args.section) ? args.section : 'all';
        const identity = buildRuntimeIdentityFacts();
        const out = {
          ok: true, app: identity.appName, version: identity.version, launchMode: identity.launchMode,
          installDir: identity.installDir, dataDir: identity.dataDir, address: identity.address, instanceId: identity.instanceId,
        };
        if (section === 'identity') return out;

        const config = await readConfig();

        if (section === 'all' || section === 'health') {
          const { health } = await computeHealth(config);
          out.health = health.map(h => ({ id: h.id, ok: h.ok, detail: h.detail }));
        }
        if (section === 'all' || section === 'counts') {
          const cwd = (ctx && ctx.workingDir) || (ctx && ctx.session && ctx.session.cwd) || process.cwd();
          const [caps, entries, workflows] = await Promise.all([
            getCapabilities(config).catch(() => null),
            loadSkillRegistry(cwd, config).catch(() => []),
            getAgentWorkflows(cwd).catch(() => null),
          ]);
          const kindCount = k => entries.filter(e => e.kind === k).length;
          out.counts = {
            nativeTools: nativeToolCount(),
            accTools: (caps && caps.desktopMcp && Number(caps.desktopMcp.toolCount)) || 0,
            skills: kindCount('skill'), commands: kindCount('command'), playbooks: kindCount('playbook'),
            // getAgentWorkflows 失败(如 dataRoot 不可读)时退化为仅内置模板计数,不让整段 counts 落空。
            workflows: Array.isArray(workflows) ? workflows.length : BUILTIN_AGENT_WORKFLOWS.length,
          };
        }
        if (section === 'all' || section === 'config' || section === 'capabilities') {
          const p = (ctx && ctx.provider) || activeOpenAiProvider(config);
          const cli = selectedAgentCli(config);
          const modalities = { vision: p ? p.vision === true : null, audio: false, asr: !resolveAsrProvider(config).failure };
          out.config = {
            engine: p ? 'openai' : cli.id,
            providerId: p ? p.id : '',
            providerLabel: p ? (p.label || p.id) : cli.label,
            model: p ? String(p.model || (p.models && p.models[0] && p.models[0].id) || '') : String(config.model || ''),
            permissionMode: String(config.permissionMode || ''),
            outputStyle: String(config.outputStyle || ''),
            locale: String(config.locale || ''),
            modalities,
            providerCapabilities: { protocol: p ? providerWireProtocol(p).id : 'cli', visionConfigured: p ? p.vision === true : null, source: 'configuration', modelSupportProbed: false },
          };
          const runtime = await ProcessRuntime.capabilitySnapshot();
          out.capabilities = {
            runtime,
            modalities,
            matrix: [
              { modality: 'image', tools: ['file_read'], input: 'as:image or auto', providerVisionEnabled: modalities.vision },
              { modality: 'document', tools: ['file_read'], input: 'PDF/OOXML/ODF; embedded images and page windows' },
              { modality: 'audio', tools: ['audio_inspect', 'audio_transcribe'], analysis: 'local FFmpeg measurements', listening: false, transcriptionConfigured: modalities.asr },
              { modality: 'code', tools: ['code_check', 'file_edit', 'file_write'], input: 'validateSyntax:true checks candidate before writing' },
              { modality: 'background', tools: ['shell_start', 'shell_poll', 'shell_kill'], available: !!p && !RUNTIME.isMcpChild && (process.platform !== 'darwin' || runtime.capabilities['shell.session'].ready), engine: 'native provider turns', fallback: 'CLI engine native background-command tools' },
              { modality: 'verification', tools: ['acceptance_report', 'media_probe', 'checkpoint_list'] },
            ],
            checkpointScope: 'Native journaled file operations only. Shell/script/ffmpeg/browser/application side effects are not checkpointed; recursive operations restore file contents, not empty-directory metadata.',
            audioInputNote: 'This harness does not send raw audio to the chat model. ASR transcription and objective audio analysis do not constitute listening.',
          };
          if (section === 'capabilities') delete out.config;
        }
        return out;
  }

  return { buildWorkbenchSelfStatus };
}

module.exports = { createWorkbenchSelfStatus };
