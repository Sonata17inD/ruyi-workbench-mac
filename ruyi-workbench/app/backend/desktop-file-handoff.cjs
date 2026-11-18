'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { platformOpenSpawn } = require('./mac-launch-policy.cjs');

function createDesktopFileHandoff({ desktop }) {
  const { spawnDetachedChecked } = desktop;

  // v1.0.2-S3: build the explorer.exe argv for /api/file/reveal WITHOUT touching a shell (路径含用户可控字符,
  // shell 拼接 = 命令注入)。绝不走 cmd.exe:调用方用 cp.spawn('explorer.exe', args, {detached,stdio:'ignore'}).unref()。
  //   mode='select' → ['/select,' + absPath]  (注意 /select, 与路径是同一个参数, 逗号后直接拼路径, 资源管理器定位)
  //   mode='open'   → [absPath]               (explorer 按默认关联程序打开该文件)
  // 把关加固(收官复核):mode='open' 对可执行/脚本类扩展名自动降级为 'select'——否则被提示注入的模型可在
  // 工作区造 .bat/.exe/.js(Windows 上 .js 默认关联是脚本宿主, 会直接执行!), 再诱导用户点「打开」= 一键执行
  // 任意程序。降级后仅在资源管理器中定位, 是否运行由用户在资源管理器里自己决定。返回 {command,args,mode,degraded}。
  // Pure (no I/O, no spawn) — exposed for e2e 单测护栏逻辑。默认 mode='open'。
  // v1.4.1 (audit #3):由「黑名单可执行扩展名」改为【白名单默认拒绝】—— 旧黑名单漏了 .settingcontent-ms /
  // .msc / .chm / .hta / .wsc / .sct / .appref-ms / .library-ms / .diagcab 等一大票 LOLBin「一键代码执行」文件类型,
  // 被提示注入的模型在工作区造这类文件再诱导用户点「打开」= 任意执行。反转:只有【已知安全的查看类】扩展名才允许
  // 'open'(文档/Office/图片/媒体/纯文本/网页),其余一律降级为资源管理器「定位」,由用户自行决定是否运行。
  const REVEAL_OPEN_SAFE_EXTS = new Set([
    // 纯文本 / 数据(默认由文本编辑器打开)
    'txt', 'md', 'markdown', 'rtf', 'csv', 'tsv', 'log', 'json', 'xml', 'yaml', 'yml', 'ini', 'toml', 'conf',
    // 文档 / Office(查看器打开;Office 默认受保护视图 + 宏禁用)
    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'xlsm', 'xlsb', 'ppt', 'pptx', 'odt', 'ods', 'odp',
    // 图片
    'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico', 'tif', 'tiff', 'heic',
    // 音视频
    'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv',
    // 网页(浏览器沙箱打开)
    'html', 'htm',
  ]);
  function buildRevealSpawn(mode, absPath, platform = process.platform) {
    const p = String(absPath || '');
    const ext = path.extname(p).slice(1).toLowerCase();
    const wantOpen = mode !== 'select';
    // 白名单默认拒绝:仅安全查看类扩展名可 'open',其余(可执行/脚本/LOLBin/未知/无扩展名)→ 降级 'select'。
    const effMode = (wantOpen && REVEAL_OPEN_SAFE_EXTS.has(ext)) ? 'open' : 'select';
    return { ...platformOpenSpawn(p, effMode, platform), mode: effMode, degraded: wantOpen && effMode === 'select' };
  }
  // v1.4.6-S2: build the argv to open a URL / file with the OS default handler WITHOUT a shell. browser_open /
  // office_open used to do `cp.spawn('cmd.exe', ['/c','start','', target])` — cmd.exe splits a model-controlled
  // target on & | && metacharacters, so `http://x&calc` ran calc.exe (command injection,实测复现). Spawning
  // explorer.exe directly (Node CreateProcess passes argv verbatim — no shell) hands the URL/path to the
  // default browser/handler and never interprets shell metacharacters. Pure (no spawn); exposed for e2e argv
  // assertions. NB: the caller must still spawn with {detached, stdio:'ignore'}.unref().
  function buildOpenSpawn(target, platform = process.platform) {
    return platformOpenSpawn(target, 'open', platform);
  }

  // User-clicked code handoff is intentionally separate from office_open / file reveal. A source file may be
  // associated with an executable script host on Windows (`.js` -> WScript.exe is still a common default), so
  // blindly asking ShellExecute to "open" model-written code can execute it. Resolve the file association, but
  // only accept a known editor/IDE executable; otherwise fall back to another editor already chosen as the
  // default for a common code/text extension, then to a conservative installed-editor probe.
  function resolvePreferredCodeEditor(filePath) {
    // Test-only seam: route e2e can assert argv/materialized snapshots without opening a real desktop app.
    if (process.env.RUYI_TEST_HOOKS === '1' && process.env.RUYI_TEST_CODE_EDITOR) {
      return { command: String(process.env.RUYI_TEST_CODE_EDITOR), kind: 'vscode', label: 'Test Editor', source: 'test' };
    }
    if (process.platform === 'darwin') {
      const applications = ['Visual Studio Code', 'Visual Studio Code - Insiders', 'Cursor', 'Windsurf', 'VSCodium'];
      for (const directory of [path.join(os.homedir(), 'Applications'), '/Applications']) {
        for (const name of applications) {
          const application = path.join(directory, name + '.app');
          if (fs.existsSync(path.join(application, 'Contents', 'Info.plist'))) {
            return { command: '/usr/bin/open', application, kind: 'mac-vscode', label: name, source: 'installed-fallback' };
          }
        }
      }
      const application = '/System/Applications/TextEdit.app';
      if (fs.existsSync(application)) return { command: '/usr/bin/open', application, kind: 'mac-app', label: 'TextEdit', source: 'system-fallback' };
      return null;
    }
    return null;
  }

  function buildCodeEditorSpawn(editor, action, beforePath, afterPath) {
    if (!editor || !editor.command) return { ok: false, error: '未检测到可安全打开代码的本机编辑器' };
    const current = String(afterPath || beforePath || '');
    if (editor.kind === 'mac-vscode') {
      const args = action === 'diff'
        ? ['-n', '-a', editor.application, '--args', '--reuse-window', '--diff', String(beforePath || ''), String(afterPath || '')]
        : ['-a', editor.application, '--', current];
      if (action === 'diff' && (!beforePath || !afterPath)) return { ok: false, error: 'Diff 两侧文件路径不完整' };
      return { ok: true, command: editor.command, args, mode: action === 'diff' ? 'diff' : 'open', editor: editor.label, source: editor.source };
    }
    if (editor.kind === 'mac-app') {
      const fileOpenPrefix = ['-a', editor.application, '--'];
      return { ok: true, command: editor.command, args: [...fileOpenPrefix, current], fileOpenPrefix,
        mode: 'open', editor: editor.label, source: editor.source, diffUnsupported: action === 'diff' };
    }
    if (action !== 'diff') return { ok: true, command: editor.command, args: [current], mode: 'open', editor: editor.label, source: editor.source };
    const before = String(beforePath || ''), after = String(afterPath || '');
    if (!before || !after) return { ok: false, error: 'Diff 两侧文件路径不完整' };
    if (editor.kind === 'vscode') return { ok: true, command: editor.command, args: ['--reuse-window', '--diff', before, after], mode: 'diff', editor: editor.label, source: editor.source };
    return { ok: true, command: editor.command, args: [current], mode: 'open', editor: editor.label, source: editor.source, diffUnsupported: true };
  }

  async function launchCodeEditor(spawnSpec) {
    if (!spawnSpec || !spawnSpec.ok || !spawnSpec.command) return false;
    if (process.env.RUYI_TEST_HOOKS === '1' && process.env.RUYI_TEST_EXTERNAL_EDITOR_CAPTURE) {
      await fsp.writeFile(process.env.RUYI_TEST_EXTERNAL_EDITOR_CAPTURE, JSON.stringify(spawnSpec, null, 2), 'utf8');
      return true;
    }
    try {
      // 编辑器 exe 可能已卸载/被拦:ENOENT 是异步 'error',要等到 spawn/error 才知道成没成,否则调用方的失败分支永远走不到。
      const started = await spawnDetachedChecked(spawnSpec.command, spawnSpec.args || [], { detached: true, stdio: 'ignore' });
      return started.ok;
    } catch { return false; }
  }

  // Browser navigation has an extra invariant beyond shell-safety: never reuse the current Workbench tab.
  // For web pages, resolve the user's default HTTP handler and pass its documented new-tab switch. Local folders
  // intentionally retain the Explorer behavior used by the "open data directory" UI action.
  function isBrowserDocumentTarget(target) {
    const value = String(target || '').trim();
    return /^(https?:|file:)/i.test(value) || /\.html?$/i.test(value);
  }
  function buildBrowserOpenSpawn(target) {
    const spec = buildOpenSpawn(String(target || ''));
    return { ...spec, mode: spec.mode === 'select' ? 'file-selection' : 'system-default',
      preservesWorkbench: isBrowserDocumentTarget(target) ? null : true };
  }

  return { REVEAL_OPEN_SAFE_EXTS, buildRevealSpawn, buildOpenSpawn, resolvePreferredCodeEditor, buildCodeEditorSpawn, launchCodeEditor, isBrowserDocumentTarget, buildBrowserOpenSpawn };
}

module.exports = { createDesktopFileHandoff };
