'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');

function createCodeToolHandlers({
  readConfig, dataProfile, search, paths, git, asr,
}) {
  const {
    claudeMdAudit, codeReviewScan, codebaseSymbolSearch, debugHypothesis, dependencyInventory, docsSearch,
    frontendAudit,
  } = search;
  const {
    fileToolFsFailure, fileToolPrivacySourceOptions, guardFileToolPath, guardedWalkRoot, resolveFileToolPath,
    resolveFileToolRoot, respellWalkPaths, toolRootProblem,
  } = paths;
  const { gitCommit, gitDiff, gitLog, gitStatus, resolveGitToolCwd } = git;
  const { ASR_MAX_BODY_BYTES, resolveAsrProvider, transcribeAudioViaProvider, voiceLexiconAsrPromptFor } = asr;

  const CODE_TOOL_HANDLERS = {
    git_status: { paths: null, guardNote: "git 子进程 execFile 无 shell;cwd 经 resolveGitToolCwd(与执行类工具同一套解析,目录必须存在);只读检查", handler: async (args, ctx) => {
      // v1.0-S4 git 工具族 — 无状态 execFile('git',…),两个引擎路径都命中(同 file_read)。
        const g = await resolveGitToolCwd(args, ctx);
        if (!g.ok) return g;
        return gitStatus({ ...args, cwd: g.cwd });
    } },
    git_diff: { paths: null, guardNote: "同 git_status;另 --no-ext-diff/--no-textconv 关外部执行面", handler: async (args, ctx) => {
        const g = await resolveGitToolCwd(args, ctx);
        if (!g.ok) return g;
        return gitDiff({ ...args, cwd: g.cwd, ...fileToolPrivacySourceOptions(ctx, 'git_diff') });
    } },
    git_log: { paths: null, guardNote: "同 git_status", handler: async (args, ctx) => {
        const g = await resolveGitToolCwd(args, ctx);
        if (!g.ok) return g;
        return gitLog({ ...args, cwd: g.cwd });
    } },
    git_commit: { paths: null, guardNote: "git 子进程 execFile 无 shell;exec tier(commit 触发 hooks)录在案;cwd 经 guardWorkspaceExecute(同 shell_run)", handler: async (args, ctx) => {
        const g = await resolveGitToolCwd(args, ctx, { exec: true });
        if (!g.ok) return g;
        return gitCommit({ ...args, cwd: g.cwd });
    } },
    dependency_inventory: { paths: "read", guardNote: '', handler: async (args, ctx) => {
        const root = await resolveFileToolRoot(args, ctx);
        const g = await guardFileToolPath(root, ctx, { tool: 'dependency_inventory', write: false });
        if (!g.ok) return { ok: false, error: g.error, code: g.code, root };
        const rootBad = await toolRootProblem(root);
        if (rootBad) return rootBad;
        return respellWalkPaths(await dependencyInventory(guardedWalkRoot(root, g)), guardedWalkRoot(root, g), root);
    } },
    code_review_scan: { paths: "read", guardNote: '', handler: async (args, ctx) => {
        const root = await resolveFileToolRoot(args, ctx);
        const g = await guardFileToolPath(root, ctx, { tool: 'code_review_scan', write: false });
        if (!g.ok) return { ok: false, error: g.error, code: g.code, root };
        const rootBad = await toolRootProblem(root);
        if (rootBad) return rootBad;
        return respellWalkPaths(await codeReviewScan(guardedWalkRoot(root, g), { ...args, ...fileToolPrivacySourceOptions(ctx, 'code_review_scan') }), guardedWalkRoot(root, g), root);
    } },
    frontend_audit: { paths: "read", guardNote: '', handler: async (args, ctx) => {
        const root = await resolveFileToolRoot(args, ctx);
        const g = await guardFileToolPath(root, ctx, { tool: 'frontend_audit', write: false });
        if (!g.ok) return { ok: false, error: g.error, code: g.code, root };
        const rootBad = await toolRootProblem(root);
        if (rootBad) return rootBad;
        return respellWalkPaths(await frontendAudit(guardedWalkRoot(root, g), { ...args, ...fileToolPrivacySourceOptions(ctx, 'frontend_audit') }), guardedWalkRoot(root, g), root);
    } },
    claude_md_audit: { paths: "read", guardNote: '', handler: async (args, ctx) => {
        const root = await resolveFileToolRoot(args, ctx);
        const g = await guardFileToolPath(root, ctx, { tool: 'claude_md_audit', write: false });
        if (!g.ok) return { ok: false, error: g.error, code: g.code, root };
        const rootBad = await toolRootProblem(root);
        if (rootBad) return rootBad;
        return respellWalkPaths(await claudeMdAudit(guardedWalkRoot(root, g)), guardedWalkRoot(root, g), root);
    } },
    docs_search: { paths: "read", guardNote: '', handler: async (args, ctx) => {
        const root = await resolveFileToolRoot(args, ctx);
        const g = await guardFileToolPath(root, ctx, { tool: 'docs_search', write: false });
        if (!g.ok) return { ok: false, error: g.error, code: g.code, root };
        const rootBad = await toolRootProblem(root);
        if (rootBad) return rootBad;
        try {
          return respellWalkPaths(await docsSearch(guardedWalkRoot(root, g), String(args.query || ''), { ...args, signal: ctx && ctx.signal, ...fileToolPrivacySourceOptions(ctx, 'docs_search') }), guardedWalkRoot(root, g), root);
        } catch (error) {
          if (!error.searchExecutionFailure) throw error;
          return { ok: false, root, code: error.code, error: error.message, cleanupIncomplete: error.cleanupIncomplete, cleanupScope: error.cleanupScope };
        }
    } },
    codebase_symbol_search: { paths: "read", guardNote: '', handler: async (args, ctx) => {
        // v2.6 (对抗验证 HIGH 收口): 与 file_search/file_list/glob/project_snapshot 同款读闸 —— 仅靠 walkFiles
        // 敏感子树跳过不覆盖工作区外任意路径,远端模型可传越界 root 把符号匹配行(代码内容)确定性外传。
        const root = await resolveFileToolRoot(args, ctx);
        const g = await guardFileToolPath(root, ctx, { tool: 'codebase_symbol_search', write: false });
        if (!g.ok) return { ok: false, error: g.error, code: g.code, root };
        const rootBad = await toolRootProblem(root);
        if (rootBad) return rootBad;
        return respellWalkPaths(await codebaseSymbolSearch(guardedWalkRoot(root, g), { ...args, ...fileToolPrivacySourceOptions(ctx, 'codebase_symbol_search') }), guardedWalkRoot(root, g), root);
    } },
    debug_hypothesis: { paths: null, guardNote: "纯确定性状态机计算,不触文件路径", handler: async (args, ctx) => {
        return debugHypothesis(args);
    } },
    // 127-114c③(26 号文 §3):audio_transcribe —— 读本地音频(guardFileToolPath 与 file_read 同闸)→
    // 经 114b 同一支出站体(05 的事实源)转写。tier exec(用户文件出网),pack files_read;返回值标
    // untrusted:true(26 号文 §4:转写文本一律不可信)。扩展名白名单与 ④ 附件同一张,25 MB 与 ASR 闸同源。
    audio_transcribe: { paths: "read", guardNote: '', handler: async (args, ctx) => {
        const p = await resolveFileToolPath(args.path, ctx);   // 相对路径按工作区解析(同 file_read),不落到进程 cwd
        { const g = await guardFileToolPath(p, ctx, { tool: 'audio_transcribe', write: false }); if (!g.ok) return { ok: false, error: g.error, code: g.code, path: p }; }
        if (!/\.(wav|mp3|m4a|webm|ogg|flac)$/i.test(p)) {
          return { ok: false, error: '不支持的音频扩展名(仅 wav/mp3/m4a/webm/ogg/flac)', path: p };
        }
        let audio = null;
        try { audio = await fsp.readFile(p); }
        catch (e) {
          if (e && e.code === 'ENOENT') return { ok: false, error: '文件不存在', path: p, hint: '文件不存在;先用 glob 或 file_list 确认路径' };
          // 2026-10 走查(R2):路径是个目录(叫 x.wav 的文件夹)/ 被占用 / 无权限 —— 修前是裸 EISDIR 异常。
          const f = fileToolFsFailure(e, p); if (f) return f;
          throw e;
        }
        if (!audio.length) return { ok: false, error: '空音频文件', path: p };
        if (audio.length > ASR_MAX_BODY_BYTES) return { ok: false, error: '音频超过 25 MB 上限', path: p, maxBytes: ASR_MAX_BODY_BYTES };
        const config = await readConfig();
        const resolved = resolveAsrProvider(config);
        if (resolved.failure) return { ok: false, error: resolved.failure.message, code: resolved.failure.code };
        const ext = p.toLowerCase().match(/\.([a-z0-9]+)$/);
        const mime = { wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', webm: 'audio/webm', ogg: 'audio/ogg', flac: 'audio/flac' }[(ext && ext[1]) || ''] || 'application/octet-stream';
        const language = String(args.language || '').trim().slice(0, 40);
        const prompt = await voiceLexiconAsrPromptFor(resolved.provider, '');   // 59 号文:语音词库里的个人词当提示
        const result = await transcribeAudioViaProvider(resolved.provider, resolved.asrModel, { audio, contentType: mime, filename: path.basename(p), language, prompt });
        if (result.failure) return { ok: false, error: result.failure.message, code: result.failure.code };
        return { ok: true, text: result.text, ...(result.outLanguage ? { language: result.outLanguage } : {}), durationMs: result.durationMs, providerId: result.providerId, model: result.model, estimated: result.estimated, untrusted: true };
    } },
    data_profile: { paths: "read", guardNote: '', handler: async (args, ctx) => {
        const p = await resolveFileToolPath(args.path, ctx);
        const g = await guardFileToolPath(p, ctx, { tool: 'data_profile', write: false });
        if (!g.ok) return { ok: false, error: g.error, code: g.code, path: p };
        return dataProfile(p, args);
    } },
  };

  return { CODE_TOOL_HANDLERS };
}

module.exports = { createCodeToolHandlers };
