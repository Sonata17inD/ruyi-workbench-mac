'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

function createWorkbenchHealth({
  OVERLAY_ID, ProcessRuntime, appDirectory, externalRoot, externalServerJs, paths, staticBase, probes,
}) {
  const {
    agentCliLauncherOk, commandForSelfMcp, ensureDesktopMcpWarm, peekCapabilities, probeRgAsync,
    resolveExternalMcpServers, selectedAgentCli,
  } = probes;

  // 48b(P2):overlay 清单校验缓存。verifyManifest 经 computeHealth -> /api/status 被前端轮询,旧实现每轮全文件
  // SHA-256 是纯浪费。mtime+size 快路径:文件未变则复用上次算的 sha,跳过读盘+hash;60s 强制全量校验防
  // mtime 伪造/同 mtime 异内容边角。缓存按 manifest.version 失效(新 overlay 落地即重算)。
  let _maniCache = null; // { version, files: Map(full->{sha,mtime,size}), lastFullAt, result }
  const MANIFEST_FULL_VERIFY_MS = 60000;
  async function verifyManifest() {
    const manifestPath = path.join(externalRoot(), 'update-manifest.json');
    if (!fs.existsSync(manifestPath)) { _maniCache = null; return { present: false }; }
    try {
      const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
      const base = path.normalize(externalRoot());
      const mismatches = [];
      const newFiles = new Map();
      const forceFull = !_maniCache || _maniCache.version !== manifest.version
        || (Date.now() - (_maniCache.lastFullAt || 0)) > MANIFEST_FULL_VERIFY_MS;
      for (const entry of manifest.files || []) {
        const full = path.normalize(path.join(base, entry.path));
        if (!full.startsWith(base)) { mismatches.push({ path: entry.path, reason: 'path-escape' }); continue; }
        try {
          const st = await fsp.stat(full);
          const prev = _maniCache && _maniCache.files.get(full);
          // 快路径:非强制全量 + 文件 mtime/size 未变 + 缓存 sha 存在 -> 复用,跳过读盘+hash。
          const canSkip = !forceFull && prev && prev.mtime === st.mtimeMs && prev.size === st.size && prev.sha;
          const sha = canSkip ? prev.sha : crypto.createHash('sha256').update(await fsp.readFile(full)).digest('hex');
          newFiles.set(full, { sha, mtime: st.mtimeMs, size: st.size });
          if (sha !== entry.sha256) mismatches.push({ path: entry.path, reason: 'hash' });
        } catch {
          mismatches.push({ path: entry.path, reason: 'missing' });
        }
      }
      const result = { present: true, version: manifest.version, overlay: manifest.overlay, ok: mismatches.length === 0, mismatches };
      _maniCache = { version: manifest.version, files: newFiles, lastFullAt: Date.now(), result };
      return result;
    } catch (e) {
      _maniCache = null;
      return { present: true, ok: false, error: e.message };
    }
  }

  // 118b: 桌面控制(ACC)组件是否躺在盘上。只看文件,绝不 spawn python -- computeHealth 挂在 /api/status
  // 轮询路径上。与 detectDesktopMcp 的前两个候选同址:发布件把 mcp/ 放在 Ruyi.exe 同级(externalRoot),
  // 源码运行时在仓库根(<repo>/mcp/ai-computer-control)。
  function desktopControlComponentOnDisk() {
    const roots = [
      path.join(externalRoot(), 'mcp', 'ai-computer-control'),
      path.join(appDirectory, '..', '..', 'mcp', 'ai-computer-control'),
    ];
    for (const root of roots) {
      try { if (fs.existsSync(path.join(root, 'src', 'ai_computer_control', 'server.py'))) return true; }
      catch { /* 探测失败按不存在处理 */ }
    }
    return false;
  }

  // 118b: desktop-control 健康项的状态推导。数据只取工作台已经握在手里的三样东西:
  //   1) config.desktopMcp.enabled -- 用户是否关掉了桌面控制;
  //   2) peekCapabilities() -- 只读能力缓存,冷缓存返回 null,永不触发探测(不给状态轮询加 3s 网络锚点);
  //   3) resolveExternalMcpServers(config) -- 桥接层自己用的同一份解析,判「配没配上」。
  // 安装器日志 acc-install-latest.log 不在此处读取:工作台源码里没有任何地方知道这个路径
  // (只在 mcp/ai-computer-control/installer/install.py 与两份离线部署文档里出现),为它新造一条
  // 路径常量属于跨组件耦合,超出本刀范围。
  // 返回 { state, count }。state 是稳定小写标识,会作为 detail 的前缀下发给前端映射表与 CLI --human。
  function desktopControlState(config, { detectionPending = false } = {}) {
    const dm = (config && config.desktopMcp) || {};
    if (dm.enabled === false) return { state: 'disabled', count: 0 };
    const caps = peekCapabilities();
    const desk = caps && caps.desktopMcp;
    const bridged = desk && desk.present === true ? Number(desk.toolCount) || 0 : 0;
    if (bridged > 0) return { state: 'ready', count: bridged };
    // 128f-③:Python 探测还在飞(缓存冷)时不走下面那条会同步探针的 resolveExternalMcpServers —— 如实说「正在准备中」。
    if (detectionPending) return { state: 'preparing', count: 0 };
    let entry = null;
    try { entry = resolveExternalMcpServers(config).find(s => s.id === 'ai-computer-control') || null; }
    catch { entry = null; }
    // 解析不出启动命令 = 桥根本没配上。组件文件在盘上却解析失败,几乎只有一个原因:没有可用的 python 运行环境。
    if (!entry) return { state: desktopControlComponentOnDisk() ? 'python-missing' : 'not-installed', count: 0 };
    // 配上了但还没有桥接结果:能力缓存是冷的就是「正在准备中」,已经探过一轮才算「连不上」。
    return { state: caps ? 'unreachable' : 'preparing', count: 0 };
  }

  const DESKTOP_CONTROL_DETAILS = Object.freeze({
    ready: 'ready: desktop tools bridged',
    disabled: 'disabled: desktopMcp is switched off in config',
    'not-installed': 'not-installed: ai-computer-control component not found',
    'python-missing': 'python-missing: component present but no usable python runtime',
    preparing: 'preparing: bridge configured, capability probe has not run yet',
    unreachable: 'unreachable: bridge configured but no tool was bridged',
  });

  async function computeHealth(config, { desktopPending = false } = {}) {
    // 39 号文:下面 desktopControlState → resolveExternalMcpServers → detectDesktopMcp 是【同步】的,
    // 冷缓存时一轮探针把整个进程钉住 ~2.4 s(实测就是这一处最先撞上:/api/status 的 health 字段排在
    // desktopMcp 与 mcpConfigPath 【前面】)。本函数是 async,先等那趟异步预热,缓存热时零开销。
    // 128f-③:调用方已判出「探测在飞」(desktopMcpDetectionPending)时既不等也不探 —— 桌面那一项报 preparing。
    if (!desktopPending) await ensureDesktopMcpWarm(config);
    const health = [];
    const push = (id, ok, detail) => health.push({ id, ok, detail });

    const runtime = await ProcessRuntime.capabilitySnapshot();
    if (process.platform === 'darwin') {
      const supervisor = runtime.capabilities['process.supervisor'];
      push('process-supervisor', supervisor.ready, supervisor.ready ? 'ready' : supervisor.reasonCode);
    }

    const selectedCli = selectedAgentCli(config);
    // 128f-⑬:修前每一次 /api/status 都同步探一遍选中的 CLI(不记忆),换线程就钉一次事件循环;见 01 agentCliLauncherOk。
    const selectedCliOk = Boolean(selectedCli.path && await agentCliLauncherOk(selectedCli.path));
    const selectedCliDetail = `${selectedCli.label}: ${selectedCli.path || '(not found — open Settings)'}`;
    push('agent-cli', selectedCliOk, selectedCliDetail);
    // Backward-compatible health id consumed by older overlays/diagnostics.
    push('claude-cli', selectedCliOk, selectedCliDetail);

    // Real write-probe (not fsp.access, which lies on Windows).
    let writable = false; let writeDetail = paths.data;
    try {
      const probe = path.join(paths.data, `.write-probe-${OVERLAY_ID}`);
      await fsp.writeFile(probe, 'ok'); await fsp.unlink(probe); writable = true;
    } catch (e) { writeDetail = e.message; }
    push('data-writable', writable, writeDetail);

    push('server-source', Boolean(externalServerJs()), externalServerJs() || '(running from baked exe)');
    const mcpCmd = commandForSelfMcp(config.mcpCommandMode || 'auto');
    push('mcp-target', true, `${mcpCmd.via}: ${path.basename(mcpCmd.command)} ${mcpCmd.args.join(' ')}`);
    const vendorOk = fs.existsSync(path.join(staticBase(), 'vendor', 'marked.min.js'));
    // 109a: mermaid is an optional lazy-loaded vendor lib. Missing file only degrades diagrams to code
    // blocks, so it is reported in the detail line and never lowers the vendor-libs health verdict.
    const mermaidPresent = fs.existsSync(path.join(staticBase(), 'vendor', 'mermaid.min.js'));
    const vendorDetail = vendorOk ? 'marked + highlight.js present' : 'vendor/ missing (markdown will fall back to plain text)';
    push('vendor-libs', vendorOk, `${vendorDetail}; mermaid: ${mermaidPresent ? 'present' : 'absent (optional)'}`);
    // 145-W3:随包的两件可选载荷各报一行人话。detail 以来源/状态词开头(与 desktop-control 同一个前缀约定,
    // 前端 health-i18n.js 与 CLI doctor --human 靠它挑文案):ripgrep 是 env / bundled / system / absent;
    // shell 段说模型在终端里敲裸 rg 能不能找到(RUYI_RG_PATH 只服务 file_search,不进 PATH)。
    const rgInfo = await probeRgAsync().catch(() => null);
    push('search-ripgrep', Boolean(rgInfo), rgInfo
      ? `${rgInfo.source}: ${rgInfo.path}; shell: ${rgInfo.shell || 'none'}`
      : 'absent: file_search falls back to the built-in scanner; no rg in shell');
    push('diagram-renderer', mermaidPresent, mermaidPresent ? 'present: vendor/mermaid.min.js' : 'absent: mermaid blocks stay as code');

    // 118b: 桌面控制(ACC)可用性。沿用既有条目形状 {id, ok, detail};detail 以稳定状态标识开头,
    // 前端 health-i18n.js 与 CLI `doctor --human` 都靠它挑人话文案。
    const desktop = desktopControlState(config, { detectionPending: desktopPending });
    const desktopDetail = DESKTOP_CONTROL_DETAILS[desktop.state] || DESKTOP_CONTROL_DETAILS['not-installed'];
    push('desktop-control', desktop.state === 'ready', desktop.state === 'ready' ? `ready: ${desktop.count} desktop tools bridged` : desktopDetail);

    const mani = await verifyManifest();
    if (mani.present) push('overlay-integrity', Boolean(mani.ok), mani.ok ? `v${mani.version || '?'} verified` : `mismatches: ${(mani.mismatches || []).map(m => m.path).join(', ') || mani.error}`);

    return { health, manifest: mani, runtime };
  }

  return { computeHealth };
}

module.exports = { createWorkbenchHealth };
