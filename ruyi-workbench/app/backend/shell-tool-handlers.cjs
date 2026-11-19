'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');

function createShellToolHandlers({
  DesktopShell, OFFICE_WRITER_LIB_RE, RUNTIME, makeId, paths, readConfig, policy, shells,
}) {
  const { guardFileToolPath, guardWorkspaceExecute, resolveExecCwd, shellMcpChildGuard } = policy;
  const { shellKill, shellList, shellPoll, shellSend, shellStart } = shells;

  // NE-13/NE-6:执行类与 git 工具共用的 cwd 校验。Node 把「cwd 不存在」报成 `spawn python ENOENT`(模型会误判成没装解释器),
  // 所以起进程前先确认目录在,并明说「工作目录不存在」。
  async function execCwdProblem(cwd) {
    try { if ((await fsp.stat(cwd)).isDirectory()) return null; } catch { /* fall through */ }
    return { ok: false, error: `工作目录不存在: ${cwd}`, hint: '确认 cwd 是已存在的目录,或省略 cwd 使用当前对话的工作目录。' };
  }
  // NE-6:git_* 与 shell_run/script_run/shell_start 同一套 cwd 解析(显式 cwd → 回合工作目录 → 会话 cwd → defaultWorkspace → 家目录)。
  // 读类 git 只要解析 cwd(不做执行闸);git_commit 会跑 hooks,走 guardWorkspaceExecute。显式给了不存在的目录是错误,不再悄悄换成家目录。
  async function resolveGitToolCwd(args, ctx, { exec = false } = {}) {
    let cwd;
    if (exec) {
      const g = await guardWorkspaceExecute(args && args.cwd, ctx);
      if (!g.ok) return { ok: false, error: g.error, code: g.code };
      cwd = g.cwd;
    } else {
      let config = ctx && ctx.config ? ctx.config : null;
      if (!config) { try { config = await readConfig(); } catch { config = {}; } }
      cwd = resolveExecCwd(args && args.cwd, ctx, config);
      // 读类 git 是 read 档(不弹窗),范围要与 file_read 同一道工作区围栏:修前 git_diff 能把工作区外仓库里
      // 文件的改动内容整段读出来,而 file_read 读同一个文件是 not-allowed。git_commit 是 exec 档,与 shell_run
      // 同样走执行闸,不在这里拦。
      const fence = await guardFileToolPath(cwd, ctx, { tool: 'git', write: false });
      if (!fence.ok) return { ok: false, error: fence.error, code: fence.code, cwd };
    }
    const problem = await execCwdProblem(cwd);
    return problem || { ok: true, cwd };
  }
  // NE-13:python 解释器候选。Windows 全新机器上裸 `python` 常是 Microsoft Store 占位程序(退出码 9009)或根本没有,`py -3` 才是官方启动器;
  // 非 Windows 有些发行版只有 python3。找不到(ENOENT / 9009)才换下一个候选。
  async function runPythonScript(scriptPath, opts) {
    const candidates = [...new Set([process.env.RUYI_BUNDLED_PYTHON, process.env.PYTHON, 'python3', 'python'].filter(Boolean))].map(command => [command, []]);
    // NE-13:管道下 Windows 中文系统的 python 按 cp936 写 stdout / 读文件,脚本里的 ✓ → emoji 会 UnicodeEncodeError —— 强制 UTF-8。
    // PYTHONPATH 补上工作目录:脚本文件在应用目录里,修前 `import helper`(工作区里的 helper.py)找不到。
    const env = { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONPATH: [opts && opts.cwd, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) };
    let last = null;
    for (const [cmd, pre] of candidates) {
      last = await DesktopShell.runProcess(cmd, [...pre, scriptPath], { ...opts, env, shape: true });
      const notFound = (last.code === -1 && /ENOENT/i.test(String(last.stderr || '')));
      if (!notFound) return last;
    }
    return { ...last, error: '未找到可用的 Python 解释器', hint: '可改用 language:"bash" 或 "node",或请用户安装 Python(python.org)后重试' };
  }

  const SHELL_TOOL_HANDLERS = {
    shell_run: { paths: null, guardNote: 'exec tier and workspace execution guard', handler: async (args, ctx) => {
        if (args.language && args.language !== 'bash') return { ok: false, code: 'invalid_args', error: 'shell_run supports bash' };
        if (!String(args.command || '').trim()) return { ok: false, code: 'invalid_args', error: 'command 不能为空' };
        const guard = await guardWorkspaceExecute(args.cwd, ctx);
        if (!guard.ok) return { ok: false, error: guard.error, code: guard.code };
        const problem = await execCwdProblem(guard.cwd);
        if (problem) return problem;
        return DesktopShell.runBash(String(args.command), guard.cwd, args.timeoutMs, ctx && ctx.signal, { shape: true });
    } },
    script_run: { paths: null, guardNote: "任意脚本执行(落 generated/scripts 应用自选目录),exec tier+权限链把守;Office 手写软闸内置", handler: async (args, ctx) => {
        if (!String(args.code == null ? '' : args.code).trim()) return { ok: false, code: 'invalid_args', error: 'code 不能为空', hint: '传入要执行的脚本源码(缺省 bash，也可显式选 python / node)' };
        const g = await guardWorkspaceExecute(args.cwd, ctx);
        if (!g.ok) return { ok: false, error: g.error, code: g.code };
        const badCwd = await execCwdProblem(g.cwd);
        if (badCwd) return badCwd;
        // v1.2 返修(用户实测证明:Office 产出规程提示词在续聊/惯性场景拦不住)——脚本手写 Office 的
        // 【工具层】软闸。现成 Office 工具走统一模板且进检查点可撤销;脚本现场发挥二者皆失。检测到
        // Office 写意图 → 拒绝并给配方;确有现成工具覆盖不了的特殊需求时,模型加 force:true 重调即放行
        // (并应向用户说明该产出不可自动撤销)。提示词是软约束,这里是硬闸(带 force 泄压阀,不锁死能力)。
        {
          const codeStr = String(args.code || '');
          const officeLib = OFFICE_WRITER_LIB_RE.test(codeStr);   // v1.4.1 (audit #7):与 bridged 软闸共用强化正则
          const officeFile = /\.(xlsx|xlsm|docx|pptx|pdf)\b/i.test(codeStr);
          if (args.force !== true && officeLib && officeFile) {
            return {
              ok: false,
              error: '检测到脚本在手写 Office 文件。请改用现成工具:Excel = write_excel → excel_beautify →(需图表)excel_chart;PPT = write_pptx;Word = write_document;PDF = write_pdf——统一模板、可一键撤销。若现成工具确实覆盖不了(特殊格式需求),重新调用 script_run 并加参数 force:true,同时向用户说明该产出不可自动撤销。',
              hint: 'Office 产出规程(工具层强制,v1.2)',
            };
          }
        }
        const language = String(args.language || 'bash').toLowerCase();
        if (language === 'bash') return DesktopShell.runBash(String(args.code), g.cwd, args.timeoutMs, ctx && ctx.signal, { shape: true });
        const id = makeId('script');
        const dir = path.join(paths.generated, 'scripts');
        await fsp.mkdir(dir, { recursive: true });
        // 走查 W1·F10:脚本明文落在 generated/scripts,修前执行完不删 —— 模型嵌在脚本里的密钥 / token 就一直躺在数据目录里。
        // 执行是【同步等到进程结束 / 超时 / 被中断】才返回的(runProcess 在 close 或超时兜底后才 resolve;没有后台 / 脱离执行分支),
        // 解释器启动时已把整份脚本读完(PowerShell -File、python、node 都是),所以 finally 里删是安全的 —— 与 04 runPowerShell 的临时 .ps1 同一做法。
        // 删不掉(Windows 上杀毒 / 索引器瞬时占着)不报错,按龄清扫(01 sweepStaleScriptFiles,启动时跑)兜底。
        const dropScript = p => fsp.unlink(p).catch(() => {});
        if (language === 'python') {
          const p = path.join(dir, `${id}.py`);
          await fsp.writeFile(p, String(args.code || ''), 'utf8');
          try { return await runPythonScript(p, { cwd: g.cwd, timeoutMs: args.timeoutMs || 60000, signal: ctx && ctx.signal }); }
          finally { await dropScript(p); }
        }
        if (language === 'node' || language === 'javascript') {
          const p = path.join(dir, `${id}.js`);
          await fsp.writeFile(p, String(args.code || ''), 'utf8');
          // 脚本文件落在应用目录(generated/scripts),Node 按脚本所在目录找模块:修前工作区里装好的 node_modules 一个都 require 不到。
          // NODE_PATH 补上工作目录的 node_modules(裸模块名);相对路径的 require 仍按脚本目录算,提示里用 path.join(process.cwd(), …)。
          const nodePath = [path.join(g.cwd, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
          try { return await DesktopShell.runProcess(process.execPath, [p], { cwd: g.cwd, timeoutMs: args.timeoutMs || 60000, signal: ctx && ctx.signal, shape: true, env: { NODE_PATH: nodePath } }); }
          finally { await dropScript(p); }
        }
        return { ok: false, code: 'invalid_args', error: 'script_run supports bash, python or node' };
    } },
    shell_start: { paths: null, guardNote: "持久 shell 会话状态面,exec tier 门+MCP 子进程拒;不直接触文件路径", handler: async (args, ctx) => {
      // v0.8-S2 shell session族 — provider-engine only. In the one-shot MCP child (Claude CLI engine) the
      // session Map cannot persist across turns, so return a guiding error rather than fake a session.
        const g = await guardWorkspaceExecute(args.cwd, ctx);
        if (!g.ok) return { ok: false, error: g.error, code: g.code };
        if (RUNTIME.isMcpChild) return shellMcpChildGuard();
        const badCwd = await execCwdProblem(g.cwd);
        if (badCwd) return badCwd;
        const cfg = await readConfig().catch(() => ({ shellSessionMax: 3 }));
        // 107-S0(45 号文 §9.6 发现 3):shell 起在闸判过的那个目录(显式 cwd → 回合工作目录 → 会话 cwd → defaultWorkspace
        // → 家目录),不再缺省落家目录。
        return shellStart({ ...args, cwd: g.cwd }, cfg, ctx);
    } },
    shell_send: { paths: null, guardNote: "同 shell_start", handler: async (args, ctx) => {
        if (RUNTIME.isMcpChild) return shellMcpChildGuard();
        return shellSend(args, ctx);
    } },
    shell_poll: { paths: null, guardNote: "同 shell_start", handler: async (args, ctx) => {
        if (RUNTIME.isMcpChild) return shellMcpChildGuard();
        return shellPoll(args, ctx);
    } },
    shell_kill: { paths: null, guardNote: "同 shell_start", handler: async (args, ctx) => {
        if (RUNTIME.isMcpChild) return shellMcpChildGuard();
        return shellKill(args, ctx);
    } },
    shell_list: { paths: null, guardNote: "会话清单只读,不触文件路径", handler: async (args, ctx) => {
        if (RUNTIME.isMcpChild) return shellMcpChildGuard();
        return shellList(ctx);   // 135c:只列本线程开的(见 11 shellVisibleTo)
    } },
  };

  // 审计 NE-12:desktop_screenshot 修前只回一个路径 —— 视觉模型永远看不到这张图(file_read 对图片的拒绝提示还指回本工具)。
  // 现在 PowerShell 顺手存一份缩略 JPEG 副本(<outPath>.vision.jpg,长边 <= 1600);这里读回、以 image_base64 返回
  // (与 ACC 截图同一条工具图像通道:视觉开的模型经 extractToolImages 收到真图,非视觉模型由 N7 换成占位),路径照旧保留。
  // 副本缺失(PS 缩放失败 / 旧路径)回落到 PNG 本体,但超过上限就不内嵌(只回路径 + 说明),避免一张 4K PNG 把历史撑爆。

  return { SHELL_TOOL_HANDLERS, resolveGitToolCwd };
}

module.exports = { createShellToolHandlers };
