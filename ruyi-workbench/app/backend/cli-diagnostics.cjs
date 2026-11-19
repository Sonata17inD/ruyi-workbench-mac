'use strict';
const fs = require('node:fs');
const path = require('node:path');

function createCliDiagnostics({ externalRoot, publicDirectory, ensureDirs, readConfig, generateMcpConfig, APP_NAME, VERSION, exePath, paths, detectClaudePath, existsExecutable, computeHealth }) {
  // ── 118b: `doctor --human` ─────────────────────────────────────────────────────────────────────────
  // 默认输出仍是逐字节不变的 JSON(脚本依赖它);加 --human 才多打一段人话体检,让支持人员可以直接让用户
  // 跑一条命令、念出结果,而不必读 JSON。
  //
  // 文案不在这里重抄一遍:直接读前端 i18n 目录里同一批 health.* 键。之所以不抽公共模块,是因为两端的模
  // 块制式本就不通 -- 前端 health-i18n.js 是浏览器原生 ES Module,服务端是 src/*.js 拼接出来的单文件
  // CommonJS,任何「共享模块」都得在 public/ 与 src/ 之间新开一条跨制式引用。真正会重复的只剩下面这张
  // 严重度小表(纯机器判定,没有文案),人话一个字都不重复。
  const DOCTOR_HUMAN_LANGS = Object.freeze(['zh-CN', 'en-US']);
  const DOCTOR_HEALTH_SEVERITY = Object.freeze({
    'process-supervisor': Object.freeze({ ok: 'ok', bad: 'error' }),
    'agent-cli': Object.freeze({ ok: 'ok', bad: 'warn' }),
    'claude-cli': Object.freeze({ ok: 'ok', bad: 'warn' }),
    'data-writable': Object.freeze({ ok: 'ok', bad: 'error' }),
    'server-source': Object.freeze({ ok: 'ok', bad: 'ok' }),
    'mcp-target': Object.freeze({ ok: 'ok', bad: 'warn' }),
    'vendor-libs': Object.freeze({ ok: 'ok', bad: 'warn' }),
    'overlay-integrity': Object.freeze({ ok: 'ok', bad: 'error' }),
    'desktop-control': Object.freeze({
      ready: 'ok', disabled: 'warn', 'not-installed': 'warn',
      'python-missing': 'warn', preparing: 'warn', unreachable: 'error',
    }),
    // 145-W3:与前端 health-i18n.js 的同名两行逐字一致(search-ripgrep 的变体写在 detail 的来源前缀里)。
    'search-ripgrep': Object.freeze({ bundled: 'ok', system: 'ok', env: 'ok', absent: 'warn' }),
    'diagram-renderer': Object.freeze({ ok: 'ok', bad: 'warn' }),
  });
  // 文案目录。与 helpDocsDir()/staticBase() 同一口径:先看发布件外部目录,再回落打包内相对路径。
  function doctorLocaleCatalog(lang) {
    const file = DOCTOR_HUMAN_LANGS.includes(lang) ? lang : 'zh-CN';
    const candidates = [
      path.join(externalRoot(), 'app', 'public', 'locales', `${file}.json`),
      path.join(publicDirectory, 'locales', `${file}.json`),
    ];
    for (const full of candidates) {
      try { if (fs.existsSync(full)) return JSON.parse(fs.readFileSync(full, 'utf8')); }
      catch { /* 这一份读不通就试下一个候选 */ }
    }
    return {};
  }
  // health 条目 -> 变体键。desktop-control / search-ripgrep 的变体写在 detail 的状态前缀里;其余项只有 ok/bad 两态。
  function doctorHealthVariant(item) {
    if (!item) return 'bad';
    if (item.id === 'desktop-control') return String(item.detail || '').split(':')[0].trim() || 'not-installed';
    if (item.id === 'search-ripgrep') {
      const token = String(item.detail || '').split(':')[0].trim();
      return Object.prototype.hasOwnProperty.call(DOCTOR_HEALTH_SEVERITY['search-ripgrep'], token) ? token : 'absent';
    }
    return item.ok ? 'ok' : 'bad';
  }
  function doctorHealthSeverity(item) {
    const table = DOCTOR_HEALTH_SEVERITY[item && item.id];
    if (!table) return item && item.ok ? 'ok' : 'warn';
    return table[doctorHealthVariant(item)] || (item && item.ok ? 'ok' : 'warn');
  }
  // 只做 {{name}} 占位替换 -- 与前端 i18n interpolate 同一约定,不引入任何模板引擎。
  function doctorFill(text, params) {
    return String(text || '').replace(/{{\s*([\w.-]+)\s*}}/g, (_m, key) => (params && key in params ? String(params[key]) : ''));
  }
  // 把 health[] 渲染成人话行。返回字符串数组(便于测试逐行断言),不直接 console.log。
  function doctorHumanLines(health, catalog) {
    const pick = (key, fallback) => (typeof catalog[key] === 'string' && catalog[key] ? catalog[key] : fallback);
    const lines = [pick('health.cli.title', 'Ruyi health check')];
    for (const item of Array.isArray(health) ? health : []) {
      if (!item || item.id === 'claude-cli') continue; // claude-cli 与 agent-cli 是同一件事的旧别名,人话输出只列一次
      const id = String(item.id || '');
      const known = typeof catalog[`health.item.${id}.label`] === 'string';
      const variant = doctorHealthVariant(item);
      const severity = doctorHealthSeverity(item);
      const label = known ? catalog[`health.item.${id}.label`] : pick('health.item.unknown.label', 'Other check');
      const count = Number((String(item.detail || '').match(/(\d+)/) || [])[1] || 0);
      const hint = known
        ? doctorFill(catalog[`health.item.${id}.hint.${variant}`] || catalog[`health.item.${id}.hint.bad`] || '', { count })
        : pick(`health.item.unknown.hint.${item.ok ? 'ok' : 'bad'}`, '');
      const next = known ? String(catalog[`health.item.${id}.next.${variant}`] || '') : '';
      lines.push(`[${pick('health.status.' + severity, severity)}] ${label}`);
      if (hint) lines.push('    ' + hint);
      if (severity !== 'ok' && next) lines.push('    ' + pick('health.action.howto', 'What to do') + ': ' + next);
      lines.push('    ' + pick('health.tech.toggle', 'Technical details') + ': ' + id + ' · ' + String(item.detail || ''));
    }
    return lines;
  }

  async function doctor(argv) {
    await ensureDirs();
    const config = await readConfig();
    const mcpConfigPath = await generateMcpConfig();
    const info = {
      app: APP_NAME,
      version: VERSION,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      exePath: exePath(),
      dataRoot: paths.data,
      configPath: paths.config,
      mcpConfigPath,
      claudePath: config.claudePath,
      claudeDetected: detectClaudePath(),
      claudeWorks: Boolean(config.claudePath && existsExecutable(config.claudePath)),
      resourcesRoot: path.join(externalRoot(), 'resources'),
    };
    console.log(JSON.stringify(info, null, 2));
    // 118b: 加法开关。没有 --human 时上面的 JSON 就是全部输出,与历史逐字节一致。
    if (!(argv && (argv.human === true || argv.human === '1' || argv.human === 'true'))) return;
    // 刻意不在这里预热能力缓存:getCapabilities(force) 会真去把桌面 MCP 桥起来,子进程会把一次性 CLI
    // 的事件循环吊住(实测不退出)。所以 CLI 的桌面控制在冷缓存下如实报「正在准备中」,不为一行文案
    // 换一个会挂住的命令。
    const { health } = await computeHealth(config).catch(() => ({ health: [] }));
    const catalog = doctorLocaleCatalog(String(config.locale || ''));
    console.log('');
    for (const line of doctorHumanLines(health, catalog)) console.log(line);
  }

  function parseArgs(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i += 1) {
      const arg = argv[i];
      if (arg.startsWith('--')) {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (!next || next.startsWith('--')) out[key] = true;
        else {
          out[key] = next;
          i += 1;
        }
      } else {
        out._.push(arg);
      }
    }
    return out;
  }
  return { doctor, parseArgs, doctorHealthSeverity, doctorHumanLines };
}

module.exports = { createCliDiagnostics };
