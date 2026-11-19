'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');

function createDesktopToolHandlers({
  FileTextIo, MacDesktopAutomation, VisualPipeline, REVEAL_OPEN_SAFE_EXTS, UNC_DENIED_ERROR, paths, launch,
  policy,
}) {
  const { buildOpenSpawn, buildRevealSpawn, spawnDetachedChecked } = launch;
  const { guardFileToolPath, openToolUncDenied, resolveFileToolPath } = policy;

  const VISION_SIDECAR_SUFFIX = '.vision.jpg';
  const SCREENSHOT_EMBED_MAX_BYTES = 2500000;
  async function attachScreenshotImage(result, outPath, useSidecar = true) {
    if (!result || result.ok === false) return result;
    const sidecar = outPath + VISION_SIDECAR_SUFFIX;
    try {
      let buf = null;
      if (useSidecar) {
        try { buf = await fsp.readFile(sidecar); } catch { buf = null; }
        finally { await fsp.rm(sidecar, { force: true }).catch(() => {}); }
      }
      if (!buf || !buf.length) {
        const st = await fsp.stat(outPath).catch(() => null);
        if (!st || !st.isFile()) return result;
        if (st.size > SCREENSHOT_EMBED_MAX_BYTES) return { ...result, imageOmitted: `screenshot is ${st.size} bytes; not embedded (use ocr / a smaller region via the desktop control tools)` };
        buf = await fsp.readFile(outPath);
      }
      if (buf.length > SCREENSHOT_EMBED_MAX_BYTES) return { ...result, imageOmitted: `screenshot is ${buf.length} bytes; not embedded` };
      const b64 = buf.toString('base64');
      const mime = VisualPipeline.sniffImageMime(b64) || 'image/png';
      const dims = VisualPipeline.imageSizeFromBuffer(buf);
      return { ...result, image_base64: b64, image_mime: mime, format: mime === 'image/jpeg' ? 'jpeg' : 'png', ...(dims ? { width: dims.width, height: dims.height } : {}) };
    } catch { return result; }
  }

  const DESKTOP_TOOL_HANDLERS = {
    desktop_screenshot: { paths: "conditional", guardNote: '', handler: async (args, ctx) => {
        // outputPath 不是字符串(模型传了数字 / 对象)时 path.resolve 抛 TypeError 变成工具异常:明说参数不对。
        if (args.outputPath != null && typeof args.outputPath !== 'string') return { ok: false, code: 'invalid_args', error: 'outputPath 必须是字符串路径', hint: '省略 outputPath 则存到应用的 generated 目录' };
        // 模型给的 outputPath 与 file_write 同一条解析链(resolveFileToolPath:相对路径接在会话工作区下、~ / %USERPROFILE% 先展开);
        // 修前裸 path.resolve 把 'shot.png' 落到服务进程 cwd,被写闸判成「工作文件夹外面」,提示里的路径也是模型从没见过的启动目录。
        const outPathRaw = args.outputPath ? await resolveFileToolPath(args.outputPath, ctx) : path.resolve(path.join(paths.generated, `screenshot-${Date.now()}.png`));
        // 第36波(v1.7): 模型【给定】的 outputPath 过工作区写闸(越界写恒拒,与 file_write 同闸;bypass 模式下这是
        // 唯一防线)。缺省落 generated/ 是应用自选路径,不过此闸 —— generated 属 isSensitiveDataPath 敏感名单
        // (内含带 token 的会话 MCP 配置),文件工具闸会连缺省路径一起误拒;应用自身写自己的产物目录本就合法。
        let outPath = outPathRaw;
        if (args.outputPath) {
          const gShot = await guardFileToolPath(outPathRaw, ctx, { tool: 'desktop_screenshot', write: true });
          if (!gShot.ok) return { ok: false, error: gShot.error, code: gShot.code, path: outPathRaw };
          outPath = gShot.absPath;
        }
        if (process.platform === 'darwin') {
          const captured = await MacDesktopAutomation.request({ op: 'capture' }, ctx && ctx.signal, args.timeoutMs);
          if (!captured.ok) return captured;
          let image;
          try {
            image = Buffer.from(captured.png, 'base64');
            if (image.length < 24 || image.toString('hex', 0, 8) !== '89504e470d0a1a0a'
              || image.readUInt32BE(16) !== captured.width || image.readUInt32BE(20) !== captured.height
              || image.toString('base64') !== captured.png || !captured.logical_bounds
              || !['x','y','width','height'].every(key => Number.isFinite(captured.logical_bounds[key]))
              || captured.logical_bounds.width <= 0 || captured.logical_bounds.height <= 0
              || captured.width <= 0 || captured.height <= 0 || captured.width * captured.height > 32000000
              || captured.coordinate_space !== 'macos_global_points') throw new Error('Invalid PNG or geometry');
          } catch { return { ok: false, code: 'capture_failed', error: 'Invalid native screenshot image' }; }
          if (ctx?.signal?.aborted) return { ok: false, code: 'aborted', error: 'Desktop request cancelled' };
          await fsp.mkdir(path.dirname(outPath), { recursive: true });
          await FileTextIo.writeFileAtomic(outPath, image, { signal: ctx && ctx.signal });
          const bounds = captured.logical_bounds;
          return await attachScreenshotImage({ ok: true, path: outPath, width: captured.width, height: captured.height,
            origin: { x: bounds.x, y: bounds.y }, scale: captured.width / bounds.width,
            scale_y: captured.height / bounds.height, coordinate_space: captured.coordinate_space, method: captured.method }, outPath, false);
        }
        return { ok: false, code: 'platform_unsupported', error: 'Mac native capture is required' };
    } },
    office_open: { paths: null, guardNote: "第36波录在案:不加读闸(打开不回流模型;exec tier 权限门);v1.4.6-S2 无 shell spawn", handler: async (args, ctx) => {
        // path 为空时 path.resolve('') 是【服务进程的当前目录】—— 修前会把它在资源管理器里打开。
        if (!String(args.path == null ? '' : args.path).trim()) return { ok: false, code: 'invalid_args', error: 'path 不能为空', hint: '传入要打开的文档 / 图片 / 文件夹的完整路径' };
        if (await openToolUncDenied(args.path, ctx)) return { ok: false, code: 'not-allowed', error: UNC_DENIED_ERROR };
        const target = path.resolve(String(args.path || ''));
        let openTarget = target;
        if (process.platform === 'darwin') {
          try { openTarget = await fsp.realpath(target); }
          catch (error) { return { ok: false, code: error.code || 'not_found', error: '无法解析要打开的文件路径', target }; }
        }
        // 只「打开」查看类文件(与 /api/file/reveal 同一张白名单 REVEAL_OPEN_SAFE_EXTS):修前 office_open 一个 .bat/.exe/.lnk
        // 就是交给关联程序【执行】—— allowCommandTools:false 时命令工具全关,这条路照样能跑脚本。其余扩展名只在资源管理器里
        // 定位出来,让用户自己决定要不要运行。
        const ext = path.extname(openTarget).slice(1).toLowerCase();
        if (!REVEAL_OPEN_SAFE_EXTS.has(ext)) {
          const st = await fsp.stat(openTarget).catch(() => null);
          if (!(st && st.isDirectory())) {
            const r = buildRevealSpawn('select', openTarget);
            const shown = await spawnDetachedChecked(r.command, r.args, { detached: true, stdio: 'ignore' });
            if (!shown.ok) return { ok: false, error: `无法启动资源管理器:${shown.error}`, target };
            return { ok: true, opened: false, revealed: target, note: `.${ext || '(无扩展名)'} 不是文档/图片/音视频类文件,出于安全没有直接打开(可能会被执行),只在资源管理器里选中了它;要运行请让用户自己决定` };
          }
        }
        // 第36波(v1.7) 评审结论:本工具【不】加工作区读闸,理由记录在案防复报 —— 打开的文件内容不回流模型
        // (无 S3 外传通道),"打开桌面/下载里的文档"正是非程序员用户的正当主流程,读闸会误杀;模型可控路径
        // 的风险面是命令注入(S2 已修)与关联程序执行,后者由 exec tier 权限弹窗/授权书把守,与其它 exec 工具同级。
        // v1.4.6-S2: same cmd.exe injection fix as browser_open — direct explorer.exe spawn, no shell.
        const s = buildOpenSpawn(openTarget);
        // 启动失败(ENOENT/EPERM…)是异步 'error' 事件:等到 spawn/error 再回话,不再先报「opened」再把服务带崩。
        const started = await spawnDetachedChecked(s.command, s.args, { detached: true, stdio: 'ignore' });
        if (!started.ok) return { ok: false, error: `无法启动打开程序 ${s.command}:${started.error}`, target };
        if (s.mode === 'select') return { ok: true, opened: false, revealed: target };
        return { ok: true, opened: target };
    } },
  };

  return { DESKTOP_TOOL_HANDLERS, attachScreenshotImage };
}

module.exports = { createDesktopToolHandlers };
