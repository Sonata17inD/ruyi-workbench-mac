'use strict';

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CLAUDE_PERMISSION_MODE_MAP, agentRoleIsUntrusted, claudePermissionMode } = require('./agent-role-policy.cjs');
const { safeJsonParse, readUserJsonObjectForMerge } = require('./ordinary-json.cjs');

const RUYI_AGENT_FILE_MARKER = '<!-- ruyi-managed: 由如意工作台同步生成,会被后续同步覆盖;删掉本行即改由你自己维护 -->';
const RUYI_AGENT_FILE_MARKER_RE = /^---\n[\s\S]*?\n---\n\s*<!-- ruyi-managed\b/;

function createClaudeConfigSync({ paths, atomicWriteJson, getAgentRoleLibrary, logEvent }) {
  // v1.4.3: Sync workbench settings to ~/.claude/settings.json so the Claude CLI's own config stays
  // aligned with what the user selected in the Ruyi UI. This is a MERGE: existing keys are preserved.
  // Covers: permissionMode, model, thinkingBudget, appendSystemPrompt.
  // 读不动 / 不合法的 settings.json 不碰(整次跳过),见上面的 readUserJsonObjectForMerge。
  async function syncClaudeCliSettings(config) {
    try {
      const claudeDir = path.join(os.homedir(), '.claude');
      const settingsPath = path.join(claudeDir, 'settings.json');
      const read = await readUserJsonObjectForMerge(settingsPath);
      if (!read.ok) {
        // 用户的 settings.json 读不动 / 不合法:不碰它(写回会把用户内容整份覆盖掉)。CLI 回合另有 --permission-mode 等命令行参数兜底。
        logEvent({ kind: 'claude_settings_sync_skipped', file: settingsPath, reason: read.reason });
        return;
      }
      const settings = read.value;

      // 1. Permission mode —— 只在用户【选过】档位时同步(显式键)。2026-10 出厂档改成智能自动后,修前全新安装一启动就把
      // 用户自己的 ~/.claude/settings.json 写成 defaultMode:auto,单独用 claude 的人被悄悄放宽、没经过任何确认。
      // 出厂值不代表用户的意思,不碰它;存量用户经 to:14 迁移钉成显式 default,照旧同步。
      const explicitMode = Array.isArray(config.configExplicitKeysV1) && config.configExplicitKeysV1.includes('permissionMode');
      // 安全走查 S9:如意档位是 bypass(全自动)时【不】把 permissions.defaultMode 写成 bypassPermissions。如意自己的 Claude 回合每回合都带
      // --permission-mode(05),这个全局键只会波及【脱离如意的独立 claude 会话】—— 它们被无声放宽成免问,直到用户手动改回。
      // 其余档位的同步行为不变(照旧写)。权属 / 撤回:与下面的 model / MAX_THINKING_TOKENS 同一套 sidecar 纪律 —— sidecar 记「上次我们写进去的值」
      // (defaultMode)与「写之前用户自己的值」(defaultModePrior,null = 当时没有这个键);切到 bypass 时,若 settings 里的值仍等于我们上次写的,
      // 就撤回成 prior(没有 prior 就删掉这个键);不等于(用户后来自己改过)或 sidecar 没记(老版本写的,分不出是谁写的)一律原样不碰。
      const sidecarPath = path.join(paths.data, 'claude-settings-sync.json');
      let prevSyncedModel = null;
      let prevSyncedThinking = null;
      let prevSyncedDefaultMode = null;
      let prevDefaultModePrior = null;
      try {
        const sc = safeJsonParse(await fsp.readFile(sidecarPath, 'utf8'), null);
        if (sc && typeof sc.model === 'string') prevSyncedModel = sc.model;
        if (sc && typeof sc.maxThinkingTokens === 'string') prevSyncedThinking = sc.maxThinkingTokens;
        if (sc && typeof sc.defaultMode === 'string') { prevSyncedDefaultMode = sc.defaultMode; prevDefaultModePrior = typeof sc.defaultModePrior === 'string' ? sc.defaultModePrior : null; }
      } catch { /* no sidecar yet */ }
      const permsNow = (settings.permissions && typeof settings.permissions === 'object' && !Array.isArray(settings.permissions)) ? settings.permissions : null;
      const currentDefaultMode = permsNow && typeof permsNow.defaultMode === 'string' ? permsNow.defaultMode : null;
      const ownsDefaultMode = prevSyncedDefaultMode !== null && currentDefaultMode === prevSyncedDefaultMode;
      let nextDefaultMode = null;        // 本次同步后 settings.permissions.defaultMode 里【由我们写的】那个值(null = 我们不拥有它)
      let nextDefaultModePrior = null;
      if (explicitMode) {
        const cliMode = CLAUDE_PERMISSION_MODE_MAP[config.permissionMode] || config.permissionMode;
        if (cliMode === 'bypassPermissions') {
          if (ownsDefaultMode) {
            const rest = { ...permsNow };
            // prior 本身是 bypassPermissions(老版本留下的,或用户原先自己设的)也不在 bypass 档下写回去 —— 写回就等于又放宽了独立 claude 会话。
            if (prevDefaultModePrior !== null && prevDefaultModePrior !== 'bypassPermissions') rest.defaultMode = prevDefaultModePrior; else delete rest.defaultMode;
            if (Object.keys(rest).length) settings.permissions = rest; else delete settings.permissions;
          }
        } else {
          nextDefaultModePrior = ownsDefaultMode ? prevDefaultModePrior : currentDefaultMode;
          nextDefaultMode = cliMode;
          settings.permissions = { ...(settings.permissions || {}), defaultMode: cliMode };
        }
      } else if (ownsDefaultMode) {
        nextDefaultMode = prevSyncedDefaultMode; nextDefaultModePrior = prevDefaultModePrior;   // 用户没选过档位:不碰,只把已有的权属记录带下去
      }
      // 2. Model. 第36波(v1.7): 只删【自己写过的】model —— settings.json 是用户自己的配置,工作台未设模型时
      // 无条件 delete 会把用户手写的 settings.model 一并抹掉(越权接管,与本函数 "MERGE: existing keys are
      // preserved" 的契约直接冲突)。权属用工作台侧 sidecar(dataRoot, 非用户 ~/.claude)追踪:记住上次同步写入的
      // 值,仅当 settings.model 仍等于该值时才删除(证明是我们写的);否则原样保留。sidecar 缺失(老版本首次升级)
      // 时宁可留一次陈旧值也不误删。
      if (config.model && typeof config.model === 'string') settings.model = config.model;
      else if (prevSyncedModel && settings.model === prevSyncedModel) delete settings.model;
      // 3. Thinking budget -> env.MAX_THINKING_TOKENS。与上面的 model 同一条权属纪律:工作台没设预算时,只删【自己写过的】
      // 那个值(仍等于 sidecar 记的上次同步值才删);用户自己在 settings.json 里手写的 MAX_THINKING_TOKENS 原样保留。
      // 修前无条件 delete,会把用户手写的值一并抹掉。sidecar 缺这个键(老版本升级)时宁可留一次陈旧值也不误删。
      if (config.thinkingBudget) {
        settings.env = { ...(settings.env && typeof settings.env === 'object' ? settings.env : {}), MAX_THINKING_TOKENS: String(config.thinkingBudget) };
      } else if (prevSyncedThinking !== null && settings.env && typeof settings.env === 'object'
        && String(settings.env.MAX_THINKING_TOKENS) === prevSyncedThinking) {
        delete settings.env.MAX_THINKING_TOKENS;
      }
      // 4. Append-system-prompt: intentionally NOT written to settings.json (E2). The official Claude Code
      // settings schema has no top-level `appendSystemPrompt` key, so writing it was a dead config at best and
      // a double-injection risk at worst (it is already, reliably, passed as the --append-system-prompt spawn
      // flag on every runClaudeTurn). Keep the flag as the single channel and actively strip any stale key a
      // prior workbench version may have written.
      delete settings.appendSystemPrompt;

      await fsp.mkdir(claudeDir, { recursive: true }).catch(() => {});
      await atomicWriteJson(settingsPath, JSON.stringify(settings, null, 2));   // 25.1 收编
      // 第36波: 记录本次同步的 model 权属(见上方 "2. Model");null 表示本工作台当前无 model 可声明。
      await atomicWriteJson(sidecarPath, JSON.stringify({
        model: (config.model && typeof config.model === 'string') ? config.model : null,
        maxThinkingTokens: config.thinkingBudget ? String(config.thinkingBudget) : null,   // 同上,见 "3. Thinking budget"
        defaultMode: nextDefaultMode,                                                       // 安全走查 S9:见 "1. Permission mode"
        defaultModePrior: nextDefaultMode !== null ? nextDefaultModePrior : null,
      })).catch(() => {});
    } catch { /* non-fatal: CLI flag --permission-mode is the primary mechanism */ }
  }

  // v1.4.3: Write workbench-managed agent roles to ~/.claude/agents/*.md so they are available
  // when running `claude` directly (not just via the workbench's --agents flag).
  //
  // 所有权:~/.claude/agents 是用户自己的目录(reviewer.md / planner.md 这类同名子代理文件很常见)。修前启动时无条件整文件覆盖、
  // 无备份。现在只覆盖【自己写的】文件 —— 写出的文件在 frontmatter 之后第一行带标记注释(HTML 注释:不进 frontmatter,
  // 不影响 Claude Code 对 frontmatter 的解析;只多一行进子代理提示词),目标已存在时:
  //   · 带标记 → 自家文件,照常更新(内容相同就不写);
  //   · 无标记但内容与「老版本(无标记)会为当前角色生成的内容」逐字相同 → 老版本写的、用户没动过,认作自家,升级成带标记的;
  //   · 其余(用户自己的同名文件 / 老版本写的但用户或后来的角色配置改过 / 读不动)→ 保守跳过,记一条审计事件。
  //     想接管某个角色:删掉标记行即可,之后不再被覆盖。
  async function syncAgentRolesToClaude(cwd, config) {
    try {
      const claudeDir = path.join(os.homedir(), '.claude');
      const agentsDir = path.join(claudeDir, 'agents');
      await fsp.mkdir(agentsDir, { recursive: true }).catch(() => {});
      const roles = await getAgentRoleLibrary(cwd, config);
      const skipped = [];
      for (const role of roles) {
        if (role.nativeClaude) continue;
        // 安全走查 S3:项目来源的角色(仓库作者写的)不把自己声明的权限档写进用户全局 ~/.claude/agents —— 那是跨项目、用户自己的目录,
        // 一句 permissionMode:bypassPermissions 写进去就让所有独立的 claude 会话里同名子代理都免问。该角色的档位留给起跑时按线程档夹。
        const cliMode = agentRoleIsUntrusted(role) ? undefined : claudePermissionMode(role.permissionMode);
        var fm = ['---'];
        fm.push('description: ' + JSON.stringify(role.description || role.label));
        if (cliMode) fm.push('permissionMode: ' + cliMode);
        if (role.models && role.models.claude && role.models.claude !== 'inherit') fm.push('model: ' + role.models.claude);
        if (role.claudeTools && role.claudeTools.length) fm.push('tools: ' + JSON.stringify(role.claudeTools));
        fm.push('---');
        var body = role.prompt || role.description || role.label;
        const legacyMd = fm.join('\n') + '\n\n' + body + '\n';   // 老版本(无标记)的写法
        // 3.0 收口走查(第四波):preview.3 及更早【不分来源】都写 permissionMode(S3 之前,项目角色声明的 bypassPermissions 也写进全局目录)。
        // S3 之后上面的 fm 对项目角色不再带这一行,于是那份老文件与 legacyMd 逐字对不上、被当成用户自己的文件跳过,免问档永远留在
        // ~/.claude/agents 里(独立 claude 会话照样生效)。按老写法再拼一份:逐字相同就认作自家旧文件,覆盖成现在这份(不再带免问档)。
        const legacyCliMode = claudePermissionMode(role.permissionMode);
        const legacyUntrustedMd = (!cliMode && legacyCliMode)
          ? [fm[0], fm[1], 'permissionMode: ' + legacyCliMode, ...fm.slice(2)].join('\n') + '\n\n' + body + '\n'
          : null;
        var md = fm.join('\n') + '\n\n' + RUYI_AGENT_FILE_MARKER + '\n\n' + body + '\n';
        var file = path.join(agentsDir, role.id + '.md');
        let existing = null;
        try { existing = await fsp.readFile(file, 'utf8'); }
        catch (error) {
          if (!(error && (error.code === 'ENOENT' || error.code === 'ENOTDIR'))) { skipped.push({ id: role.id, reason: `read-failed:${(error && error.code) || 'unknown'}` }); continue; }
        }
        if (existing !== null) {
          const text = existing.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
          if (!RUYI_AGENT_FILE_MARKER_RE.test(text) && text !== legacyMd && text !== legacyUntrustedMd) { skipped.push({ id: role.id, reason: 'user-file' }); continue; }
          if (text === md) continue;   // 已是最新,不重写
        }
        await atomicWriteJson(file, md);   // 25.1 收编(md 字符串直接透传)
      }
      if (skipped.length) logEvent({ kind: 'claude_agent_sync_skipped', dir: agentsDir, skipped });
    } catch { /* non-fatal */ }
  }

  return { syncClaudeCliSettings, syncAgentRolesToClaude };
}

module.exports = { createClaudeConfigSync, RUYI_AGENT_FILE_MARKER };
