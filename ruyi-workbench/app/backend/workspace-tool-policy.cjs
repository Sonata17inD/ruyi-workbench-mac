'use strict';
const os = require('node:os');
const path = require('node:path');
const { pathWithinAnyRoot } = require('./path-containment.cjs');
const { unprefixedBridgedName } = require('./turn-effect-kinds.cjs');

function createWorkspaceToolPolicy({ policy, config }) {
  const { guardFileToolPath, realpathForContainment } = policy;
  const { logEvent, readConfig } = config;

  // 安全修复(审计 A②):桥接(ACC 等)的【读文件内容】族工具走与原生 file_read 同一道读边界。
  // 修前 read_file / list_directory / file_info / ocr_image 在 read 档(任何权限模式都零弹窗放行),却从不经
  // guardFileToolPath —— 远端模型一句话就能读 <dataRoot>\config.json(API 密钥)、runtime.json(回环令牌)、
  // ~\.ssh\*。现在分发前(callTool 之前、三个分发点同一个函数)对这些工具的路径参数过读闸:
  //   · 应用内部数据(配置/会话/记忆/日志)一律拒(与 file_read 同一条 isSensitiveDataPath 地板);
  //   · 工作区外:本机模型放行、远端模型拒(allowOutsideWorkspace 是唯一逃生舱)—— 口径逐字同 file_read;
  //   · 必须是绝对路径:相对路径由 ACC 按它自己的工作目录解析,工作台这边判不准,缺省 '.' 同理 → 拒并提示改绝对路径。
  // 仍是 read 档:工作区里的读照旧零弹窗,桌面自动化的日常用法不受影响。表按【裸名】登记,对任何桥接服务器
  // 同名工具一视同仁(第三方 MCP 的 read_file 也是读文件)。
  // 后续补漏:表覆盖 ACC 【全部只读】且带路径入参的工具(逐个对过 mcp/ai-computer-control 的函数签名)——
  //   · 读内容 / 列目录 / 看元数据:path 必填(缺省即 ACC 按自己的 cwd 解析,判不准 → 拒);
  //   · 模板匹配:find_template / find_all_templates / wait_for_image 的 template_path 与 template_b64 二选一
  //     (vision.py _load_template_gray)→ 【给了才查】;find_on_screen 只收 template_path(screen.py,必填)。
  //     修前它们在 read 档零弹窗,template_path 指向 config.json 也照读不误。
  // 要动桌面 / 动文件的工具(vision_click、copy_file、image_resize、set_clipboard_image、play_sound ……)不在此表:
  // 它们是 exec 档(非 bypass/auto 先问人),写路径另有 BRIDGED_WRITE_PATH_ARGS 与检查点。
  // 条目形状:{ required: [参数名...], optional: [参数名...] }。
  const BRIDGED_READ_PATH_ARGS = Object.freeze({
    read_file: { required: ['path'] }, list_directory: { required: ['path'] }, file_info: { required: ['path'] }, ocr_image: { required: ['path'] },
    read_document: { required: ['path'] }, excel_read: { required: ['path'] }, pdf_read_pages: { required: ['path'] }, image_info: { required: ['path'] },
    find_on_screen: { required: ['template_path'] },
    find_template: { optional: ['template_path'] }, find_all_templates: { optional: ['template_path'] }, wait_for_image: { optional: ['template_path'] },
  });
  async function bridgedReadPathGate(bridgedName, args, ctx) {
    const bare = unprefixedBridgedName(bridgedName);
    if (!Object.prototype.hasOwnProperty.call(BRIDGED_READ_PATH_ARGS, bare)) return null;
    const a = (args && typeof args === 'object' && !Array.isArray(args)) ? args : {};
    const spec = BRIDGED_READ_PATH_ARGS[bare];
    const fields = [...(spec.required || []).map(f => [f, true]), ...(spec.optional || []).map(f => [f, false])];
    for (const [field, required] of fields) {
      const raw = typeof a[field] === 'string' ? a[field].trim() : '';
      if (!raw && !required) continue;
      if (!raw || !path.isAbsolute(raw)) {
        return { ok: false, code: 'path-not-absolute', error: `桌面控制读文件必须用【绝对路径】。参数「${field}」${raw ? '是相对路径' : '缺失'},工作台无法判断它指向哪里。请用完整绝对路径重试。` };
      }
      const g = await guardFileToolPath(raw, ctx, { tool: bare, write: false });
      if (!g.ok) return { ok: false, error: g.error, code: g.code, path: raw };
    }
    return null;
  }
  function resolveExecCwd(cwd, ctx, config) {
    const session = ctx && ctx.session ? ctx.session : null;
    const base = (ctx && ctx.workingDir) || (session && session.cwd) || (config && config.defaultWorkspace) || os.homedir();
    if (!cwd) return path.resolve(String(base));
    // 相对 cwd(`src`、`sub\\repo`)接在【回合工作目录】下面:修前直接 path.resolve(cwd),落到服务进程自己的
    // 启动目录,报出来的「工作目录不存在: <进程目录>\\src」模型从没见过。按 Windows 形判绝对路径(盘符/UNC),
    // 宿主上的绝对路径也认。
    const raw = String(cwd);
    if (path.win32.isAbsolute(raw) || path.isAbsolute(raw)) return path.resolve(raw);
    return path.resolve(String(base), raw);
  }
  async function guardWorkspaceExecute(cwd, ctx) {
    let config = ctx && ctx.config ? ctx.config : null;
    if (!config) { try { config = await readConfig(); } catch { config = {}; } }
    const abs = resolveExecCwd(cwd, ctx, config);
    const list = (config && Array.isArray(config.workspaces)) ? config.workspaces : [];
    const deny = [];
    for (const w of list) {
      if (w && typeof w === 'object' && w.execute === false && typeof w.path === 'string' && w.path.trim()) {
        try { deny.push(path.resolve(w.path.trim())); } catch { /* skip unresolvable */ }
      }
    }
    if (!deny.length) return { ok: true, cwd: abs };
    const real = await realpathForContainment(abs);
    const realDeny = await Promise.all(deny.map(r => realpathForContainment(r)));
    if (pathWithinAnyRoot(real, realDeny)) {
      logEvent({ kind: 'workspace_boundary', tool: 'exec', op: 'execute', decision: 'deny-workspace-exec', pathLen: abs.length });
      return { ok: false, code: 'not-allowed', error: '该工作区未授权执行命令(execute=false),已拒绝;如需执行请在工作区权限中开启' };
    }
    return { ok: true, cwd: abs };
  }

  return { bridgedReadPathGate, resolveExecCwd, guardWorkspaceExecute };
}

module.exports = { createWorkspaceToolPolicy };
