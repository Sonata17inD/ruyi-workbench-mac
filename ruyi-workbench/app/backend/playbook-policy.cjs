'use strict';
const PLAYBOOK_INPUT_TYPES = ['text', 'folder', 'file'];
// desktopMcp means the shared ACC connection. UI, OCR and form control have separate requirements.
const PLAYBOOK_REQUIRES = ['network', 'desktopMcp', 'vision', 'desktopAutomation', 'ocr', 'browserControl'];
// 45号文③(A-S01) 六类服务的机器键:research=研究比较 organize=资料整理 writing=产物撰写
// coding=代码任务 scheduled=定时汇总 watch=变化守望。与 requires 同模具:白名单钳制,未知/缺失 →
// ''(未分类)。允许为空是关键——45号文§1.4 实盘证实六类盖不住现有模板(desktop-open-app/web-form-fill
// 是「动作」不是「完成一件事」),硬塞会让分类变成谎。未分类 ≠ 不可用(service 不参与 available 评估)。
const PLAYBOOK_SERVICES = ['research', 'organize', 'writing', 'coding', 'scheduled', 'watch'];

// Evaluate a playbook's requires against the capability matrix → { available, unavailableReason, missingCaps }.
// Empty requirements are available; declared capabilities must be positively ready. A specific中文原因 for each
// unmet requirement so the greyed card can explain itself (C2: 不隐藏,给一行原因)。
// 127-A-S02:新增 missingCaps(全部缺失能力的结构化数组,available 时为空)——unavailableReason 只报
// 第一个缺失(卡片一行人话),服务入口的「≤1 次配置引导」要按【全部】缺失能力去重计数;纯增量字段。
// 127-⑧ A-F01(41 号文 §5.9「能力未知时如实显示未知,不能经文案升级成已验证可用」):每条必带 status 四态。
// available 与 status 使用同一准入事实；未知不能放行，也不冒充缺少依赖。逐项:
//   network    online true 通过 / false → unavailable(离线,改配置补不回来) / 其余(null、缺席、非布尔)→ unknown
//   desktopMcp present true 通过 / false → needs_config(探针说没检测到;探针出错也折成 false、分不出,记债) / 其余 → unknown
//   vision     provider===null → needs_config(没配兼容 provider,CLI 引擎,配置层事实) / vision true 通过 /
//              vision false → needs_config / 其余(caps 或 provider 缺席、非对象、非布尔)→ unknown
// 多项取最重:unavailable > needs_config > unknown > available —— 有一项未知就绝不会是 available。
const PLAYBOOK_STATUS_RANK = ['available', 'unknown', 'needs_config', 'unavailable'];
function evalPlaybookAvailability(pb, caps) {
  const req = Array.isArray(pb.requires) ? pb.requires : [];
  const missingCaps = [];
  let reason = '';
  let rank = 0;
  const fact = (value, onFalse) => { rank = Math.max(rank, value === true ? 0 : PLAYBOOK_STATUS_RANK.indexOf(value === false ? onFalse : 'unknown')); };
  for (const r of req) {
    if (r === 'network') {
      // false 表示离线；null／缺失保持未知并拒绝自动执行。
      if (caps && caps.network && caps.network.online === false) { missingCaps.push('network'); if (!reason) reason = '需要联网(当前离线)'; }
      fact(caps && caps.network ? caps.network.online : undefined, 'unavailable');
    } else if (r === 'desktopMcp') {
      if (!caps || !caps.desktopMcp || !caps.desktopMcp.present) { missingCaps.push('desktopMcp'); if (!reason) reason = '需要桌面控制(未检测到 ai-computer-control)'; }
      fact(caps && caps.desktopMcp ? caps.desktopMcp.present : undefined, 'needs_config');
    } else if (r === 'vision') {
      if (!caps || !caps.provider || caps.provider.vision !== true) { missingCaps.push('vision'); if (!reason) reason = '需要视觉模型(当前引擎未开启视觉)'; }
      const p = caps ? caps.provider : undefined;
      fact(p === null ? false : (p && typeof p === 'object' ? p.vision : undefined), 'needs_config');
    } else if (r === 'desktopAutomation' || r === 'ocr') {
      const backend = caps?.desktopMcp?.[r];
      const supported = backend?.supported;
      const prepared = supported === false ? false : backend?.installed;
      const blocked = backend?.authorization === 'denied' || backend?.ready === false;
      if (prepared !== true || blocked) {
        missingCaps.push(r);
        if (!reason) reason = supported === false ? (r === 'ocr' ? '当前平台尚未实现 OCR 后端' : '当前平台尚未实现桌面操控后端')
          : blocked ? '后端未就绪或系统授权已拒绝' : (r === 'ocr' ? '需要可用的 OCR 后端' : '需要桌面操控后端');
      }
      fact(blocked ? false : prepared === true ? (backend.ready === true ? true : undefined) : prepared,
        supported === false || blocked ? 'unavailable' : 'needs_config');
    } else if (r === 'browserControl') {
      const dm = caps?.desktopMcp;
      const browser = dm?.browser;
      const system = browser?.mode === 'system';
      const desktop = dm?.desktopAutomation;
      const blocked = system && (desktop?.authorization === 'denied' || desktop?.ready === false);
      const prepared = system ? !blocked && desktop?.installed === true && desktop?.supported === true
        : browser?.supported === true && browser?.installed === true && browser?.runtimeInstalled !== false;
      if (!prepared) {
        missingCaps.push(r);
        if (!reason) reason = system ? '系统浏览器只接收网址；填表需要桌面后端或配置 DOM 浏览器目标'
          : '需要配置浏览器自动化并预备 Playwright 与浏览器运行时';
      }
      // A prepared binary is startable, not an attached/verified session. CDP reachability
      // is unknown until actual attachment; browser_open may establish that connection.
      fact(!browser ? undefined : prepared ? ((system ? desktop.ready : browser.ready) === true ? true : undefined) : false,
        blocked ? 'unavailable' : 'needs_config');
    }
  }
  const status = PLAYBOOK_STATUS_RANK[rank];
  if (status === 'unknown') reason = '能力状态未知，请重新检查后再运行';
  return { available: status === 'available' && !reason, unavailableReason: reason, missingCaps, status };
}

// ── 127-A-S02(41 号文 §5.9「将自然语言与既有模板入口接通」)─────────────────────────────────
// 自然语言 → 服务入口匹配。不新建目录引擎/探针/DSL:服务 = ③ 的 service 六类,匹配 = 关键词表(中文优先),
// 可用性直接读 listPlaybooksWithAvailability 的既有结论。配置引导硬顶 SERVICE_GUIDANCE_MAX=1 条 ——
// 「必要配置引导 ≤1 次」(45 号文 §4⑥ 计数判据;反向:提到 2,双缺失夹具实得 2 → 红)。
const SERVICE_GUIDANCE_MAX = 1;
// 六类意图词表:命中词数最多的类胜出(需 ≥1 命中,否则零行为返回 null);平手按表序。词都是 playbook
// 标题/描述里真实出现或用户嘴边真实会说的;宁缺毋滥 —— 多写冷门词只会把不相关的话也吸进服务。
const SERVICE_INTENT_KEYWORDS = Object.freeze({
  research: ['对比', '比较', '研究', '调研', '竞品', '摘要', 'pdf'],
  organize: ['整理', '归档', '重命名', '清洗', '清理', '盘点', '合并', '识别', 'ocr', '表格', '下载'],
  writing: ['撰写', '周报', '报告', '纪要', '会议', '大纲', '翻译', '汇报', '文章'],
  coding: ['代码', '编程', 'bug', '修复', '重构', '开发', '报错'],
  scheduled: ['定时', '定期', '每天', '每日', '每周', '汇总', '自动跑'],
  watch: ['守望', '监控', '盯着', '变化', '提醒'],
});
// query → { service, playbooks(可用在前), state, guidance, guidanceDropped } | null。
// state: available(类下有可用模板,引导 0 条) / needs_config(全不可用,引导 = 去重缺失能力,硬顶 MAX)
// / no_template(类下零模板,如实说没有,不给成功承诺也不给配置引导 —— 配不出一个不存在的模板)。
// 可用只数 status==='available'，与执行准入 available 保持一致；整体序
// available > needs_config(类下有 needs_config/unavailable 模板,引导只取它们的 missingCaps —— 离线仍引导 network)
// > unknown(新:其余全是未知,引导 0 条 —— 不知道缺什么就不教人去配) > no_template。
function matchServiceEntry(query, playbooks) {
  const q = String(query || '').trim().toLowerCase();
  if (q.length < 2) return null;
  let best = '', bestScore = 0;
  for (const [service, words] of Object.entries(SERVICE_INTENT_KEYWORDS)) {
    let score = 0;
    for (const w of words) { if (q.includes(w.toLowerCase())) score++; }
    if (score > bestScore) { bestScore = score; best = service; }
  }
  if (!best) return null;
  const mine = (Array.isArray(playbooks) ? playbooks : []).filter(p => p && p.service === best);
  const ordered = [...mine.filter(p => p.available !== false), ...mine.filter(p => p.available === false)]
    .map(p => ({ id: p.id, title: p.title, available: p.available !== false, unavailableReason: String(p.unavailableReason || ''), status: p.status }));
  if (!mine.length) return { service: best, playbooks: [], state: 'no_template', guidance: [], guidanceDropped: 0 };
  if (mine.some(p => p.status === 'available')) return { service: best, playbooks: ordered, state: 'available', guidance: [], guidanceDropped: 0 };
  const blocked = mine.filter(p => p.status === 'needs_config' || p.status === 'unavailable');
  if (!blocked.length) return { service: best, playbooks: ordered, state: 'unknown', guidance: [], guidanceDropped: 0 };
  const missing = [];
  for (const p of blocked) {
    for (const cap of (Array.isArray(p.missingCaps) ? p.missingCaps : [])) {
      if (!missing.includes(cap)) missing.push(cap);
    }
  }
  return { service: best, playbooks: ordered, state: 'needs_config', guidance: missing.slice(0, SERVICE_GUIDANCE_MAX), guidanceDropped: Math.max(0, missing.length - SERVICE_GUIDANCE_MAX) };
}

module.exports = { PLAYBOOK_INPUT_TYPES, PLAYBOOK_REQUIRES, PLAYBOOK_SERVICES, evalPlaybookAvailability, matchServiceEntry };
