'use strict';

const { resolveBridge, bridgedToolTier, dropPolicyDisabledBridgedTools } = require('./bridged-tool-policy.cjs');
const { nativeToolTier } = require('./native-tool-tiers.cjs');
const { TOOL_PACK_DESCRIPTIONS, DESKTOP_MCP_SERVER_ID } = require('./tool-access-policy.cjs');
const { appendOnlyToolSchemasEnabled } = require('./runtime-policy.cjs');
const { hashRuntimeToolEvidence } = require('./runtime-tool-telemetry.cjs');

// 2026-10 起手工具:模型服务商回合的按需装载里,不论这句话分到哪些包,第一发就带上的几个原生工具(相当于给 core 扩一小圈;
// 不改 core 包本身 —— core 同时决定 Claude CLI 的 MCP 工具清单,而 CLI 有自己的 Read/WebSearch/WebFetch/Bash)。
// 依据(本机 4 天真实调用):联网 web_search + web_fetch 占全部工具调用的六成多(147/230),3 个会话里 2 个用到;
// 命令行 3 个会话都用到(shell_run 27 次、script_run 9 次)。开局没装、中途补装时,提供方的前缀缓存会整段失效
// (实测命中率 97%→3%、94%→8%,下一发几乎整段上下文按未缓存计);三个合计约 630 token,每发基本都命中缓存,比中途断一次便宜。
// file_read 不进:分包对文件类说法的召回本就高(文件/目录/路径/代码/项目/查看/搜索…),tool-loading e2e 也用它钉「按需注入」。
const PROVIDER_STARTER_TOOLS = Object.freeze(['web_search', 'web_fetch', 'shell_run']);
const DESKTOP_STARTERS = new Set(['list_windows', 'focus_window', 'observe', 'ui_find', 'mouse_click', 'press_key', 'batch_actions']);
const BROWSER_STARTERS = new Set(['browser_open', 'browser_get_elements', 'browser_get_text', 'browser_click', 'browser_type', 'browser_navigate']);
const NATIVE_TOOL_PACKS = Object.freeze({
  threads_search: 'memory', thread_read: 'memory',
  permission_prompt: 'core', request_user_input: 'core', todo_write: 'core', mission_update: 'core',
  workbench_memory_list: 'core', workbench_memory_read: 'core', workbench_memory_propose: 'core',
  // N8: 三个记忆维护工具(关系边提议/修订/撤销边,合计 ≈3.1K 字符)很少用,不必每回合都带:归 memory 包,
  // 用户话里提到记忆/修订/关系时 classifyToolPacks 自动装载;没装时仍可 tool_load({packs:['memory']}) 或 tool_invoke_read 调用。
  workbench_memory_relation_propose: 'memory', workbench_memory_revise: 'memory', workbench_memory_relation_revoke: 'memory',
  observation_recall: 'core', workbench_self_status: 'core', // 108c: core 常驻,不依赖 classifyToolPacks 意图分类
  // C2(61 号文)会话草稿本归 core(开局即在):它的用处在压缩之后,而笔记得在压缩【之前】就记下 —— 放进按需包,模型要么不知道
  // 有它,要么中途 tool_load 一次,提供方前缀缓存整段失效(起手工具表头注的实测:97%→3%)。常驻的代价是 schema 约 710 字符
  // (≈200 token),每发基本命中缓存。core 同时决定 Claude CLI 的 MCP 工具清单,但它不在 MCP_TOOLS 里(13f 头注),CLI 那边不受影响。
  scratchpad_write: 'core',
  thread_title_update: 'core',
  list_tools: 'core', tool_search: 'core', tool_load: 'core', tool_invoke_read: 'core', tool_invoke_edit: 'core', tool_invoke_exec: 'core',
  file_read: 'files_read', file_list: 'files_read', file_search: 'files_read', glob: 'files_read', project_snapshot: 'files_read',
  audio_transcribe: 'files_read', // 127-114c③:读本地音频文件转写,目录归 files_read(tier 仍是 exec)
  audio_inspect: 'files_read', media_probe: 'files_read', code_check: 'files_read', acceptance_report: 'files_write',
  file_write: 'files_write', file_edit: 'files_write', file_delete: 'files_write', file_move: 'files_write', file_copy: 'files_write',
  // C4:检查点清单归 files_write 而不是 core / files_read —— 它回答的是「刚才那些写操作哪些能撤」,只有手里有写类工具时才有用,
  // 随写包一起装(写包本就按「修改/创建/删除…」意图装载,下面 classifyToolPacks 另补了撤销/回滚/检查点);放 core 会每回合常驻
  // 并泄给 Claude CLI 的 MCP 清单(CLI 自己有 Edit/Write),放 files_read 则读文件的回合白背一个用不上的 schema。
  checkpoint_list: 'files_write',
  dependency_inventory: 'code', code_review_scan: 'code', frontend_audit: 'code', claude_md_audit: 'code', docs_search: 'code', codebase_symbol_search: 'code', debug_hypothesis: 'code', data_profile: 'code',
  git_status: 'code', git_diff: 'code', git_log: 'code', git_commit: 'code',
  shell_run: 'shell', script_run: 'shell', shell_start: 'shell', shell_send: 'shell', shell_poll: 'shell', shell_kill: 'shell', shell_list: 'shell',
  web_search: 'web', web_fetch: 'web', http_request: 'web', http_download: 'web', browser_open: 'web',
  desktop_screenshot: 'desktop', office_open: 'office',
  archive_zip: 'archive', archive_unzip: 'archive', spawn_agent: 'agents', orchestrate_agents: 'agents', wait_agents: 'agents', agent_result: 'agents', send_to_agent: 'agents', skill_read: 'skills',
  playbook_list: 'skills', playbook_read: 'skills', skill_list: 'skills', // 61 号文 C1:不进 PROVIDER_STARTER_TOOLS(起手工具影响前缀缓存),说到 Playbook/技能时 classifyToolPacks 带出
  mcp_list: 'integrations', mcp_configure: 'integrations',
  // 116c: 管家工具族全部归 steward 包 —— 普通会话的 classifyToolPacks 永远不会路由到这个包
  // (四个 offer 面在包路由【之前】就按 isStewardToolName 拦掉了,包只是目录归属的一致性声明)。
  steward_self_status: 'steward', steward_threads_search: 'steward', steward_thread_status: 'steward',
  steward_thread_read: 'steward', steward_runs_status: 'steward', steward_inbox_read: 'steward',
  steward_usage: 'steward', steward_health: 'steward', steward_audit_tail: 'steward',
  steward_missions: 'steward',
  steward_skills: 'steward', steward_providers: 'steward', steward_playbooks: 'steward',
  steward_web_search: 'steward', steward_web_fetch: 'steward', steward_file_read: 'steward',
  steward_thread_artifact_read: 'steward',
  steward_notify: 'steward',
  steward_thread_new: 'steward', steward_thread_continue: 'steward', steward_thread_rename: 'steward',
  steward_thread_workspace: 'steward',
  steward_thread_permission: 'steward', steward_thread_note: 'steward', steward_thread_prioritize: 'steward',
  steward_decide: 'steward', steward_run_action: 'steward',
  steward_thread_stop: 'steward',                                            // 117m-A4
  steward_memory_write: 'steward', steward_memory_veto: 'steward', steward_memory_search: 'steward',
  steward_config_get: 'steward', steward_config_set: 'steward',              // 116-2e
  steward_bot_setup: 'steward',
  steward_playbook_draft: 'steward', steward_skill_toggle: 'steward', steward_quick_ask: 'steward',
  // 123-M2:定时任务六件同归 steward 包(与上面 27 个同一条理由 —— 包只是目录归属的一致性声明)。
  steward_schedule_create: 'steward', steward_schedule_list: 'steward', steward_schedule_pause: 'steward',
  steward_schedule_resume: 'steward', steward_schedule_run_now: 'steward', steward_schedule_delete: 'steward',
});

function toolPackForName(name, bridgedRoute) {
  if (NATIVE_TOOL_PACKS[name]) return NATIVE_TOOL_PACKS[name];
  const bridge = resolveBridge(bridgedRoute || {}, name);
  const raw = String(bridge ? bridge.toolName : name || '').toLowerCase();
  if (/(excel|spreadsheet|workbook|worksheet|word|docx|document|ppt|powerpoint|slide|pdf|chart_image)/.test(raw)) return 'office';
  if (/(screen|window|mouse|keyboard|click|clipboard|ocr|ui_|desktop|hotkey|input_sequence|type_text|scroll|drag)/.test(raw)) return 'desktop';
  if (/(archive|zip|unzip|compress|extract)/.test(raw)) return 'archive';
  if (/(search|fetch|http|url|browser|download|web)/.test(raw)) return 'web';
  if (/^memory_(save|read|list|delete)$/.test(raw)) return 'memory';
  if (/sequential_thinking/.test(raw)) return 'thinking';
  if (/(read|list|get_|find|inspect|status|info|diagnostic|wait_for_)/.test(raw)) return 'files_read';
  if (/(write|edit|delete|move|copy|create|save|upload)/.test(raw)) return 'files_write';
  return 'desktop'; // unknown external tools are conservative opt-in, never part of simple chat
}

// 20-T1: small, reviewable retrieval vocabulary for high-value native capabilities. This is deliberately
// not a second tool registry: tier/pack/schema remain sourced from their existing tables; these hints only
// bridge user language (especially Chinese) to a capability name. Unknown/bridged tools still receive
// deterministic fields derived from name, description and JSON Schema parameters.
const TOOL_RETRIEVAL_HINTS = Object.freeze({
  file_read: { capabilities: ['workspace.file.read', 'image.view', 'document.read'], aliases: ['读取文件', '查看文件', '读文件', '读取图片', '查看图像', '看图', '视觉输入', '读取文档', '读取PDF', 'read workspace file', 'read image', 'view image', 'view image vision', 'vision'] },
  audio_inspect: { capabilities: ['audio.inspect', 'audio.loudness', 'audio.waveform'], aliases: ['音频验收', '音频分析', '响度', '削波', 'audio inspect', 'audio levels', 'LUFS'] },
  media_probe: { capabilities: ['media.dependencies.inspect'], aliases: ['依赖探测', '媒体工具链', 'ffmpeg', 'ffprobe', 'chrome', 'ffmpeg ffprobe chrome', 'media dependencies'] },
  code_check: { capabilities: ['code.syntax.check'], aliases: ['语法检查', '代码体检', '写盘前语法检查', 'syntax check', 'validate code'] },
  acceptance_report: { capabilities: ['verification.evidence.report'], aliases: ['验收回执', '证据卡', '验收清单', 'acceptance checklist', 'verification report'] },
  shell_start: { capabilities: ['shell.background.start'], aliases: ['后台任务', '后台运行', '长任务', '后台渲染', 'background shell', 'background job', 'render video background'] },
  shell_poll: { capabilities: ['shell.background.poll'], aliases: ['后台任务进度', '读取后台输出', 'poll background job'] },
  shell_kill: { capabilities: ['shell.background.cancel'], aliases: ['取消后台任务', '停止渲染', 'cancel background job'] },
  file_list: { capabilities: ['workspace.file.list'], aliases: ['列出目录', '查看目录', 'list directory'] },
  file_search: { capabilities: ['workspace.text.search'], aliases: ['搜索文件内容', '全文检索', 'search files'] },
  glob: { capabilities: ['workspace.path.glob'], aliases: ['按模式找文件', '文件通配符', 'find files by pattern'] },
  file_write: { capabilities: ['workspace.file.write'], aliases: ['写入文件', '创建文件', 'write file'] },
  file_edit: { capabilities: ['workspace.file.edit'], aliases: ['修改文件', '替换文本', 'edit file'] },
  file_delete: { capabilities: ['workspace.file.delete'], aliases: ['删除文件', '移除文件', 'delete file'] },
  file_move: { capabilities: ['workspace.file.move'], aliases: ['移动文件', '重命名文件', 'move file'] },
  file_copy: { capabilities: ['workspace.file.copy'], aliases: ['复制文件', '拷贝文件', 'copy file'] },
  codebase_symbol_search: { capabilities: ['code.symbol.definition', 'code.symbol.references'], aliases: ['查找符号定义', '查找代码引用', 'find definition references'] },
  docs_search: { capabilities: ['documentation.search'], aliases: ['搜索项目文档', '查文档', 'search documentation'] },
  git_status: { capabilities: ['git.status'], aliases: ['查看代码变更', '仓库状态', 'working tree status'] },
  git_diff: { capabilities: ['git.diff'], aliases: ['查看差异', '代码改动', 'show changes diff'] },
  shell_run: { capabilities: ['shell.exec'], aliases: ['运行命令', '执行 bash', 'run command'] },
  script_run: { capabilities: ['shell.script.execute'], aliases: ['运行脚本', '执行脚本', 'run script'] },
  web_search: { capabilities: ['web.search'], aliases: ['搜索互联网', '联网搜索', 'search the web'] },
  web_fetch: { capabilities: ['web.page.fetch'], aliases: ['抓取网页', '读取网页', 'fetch web page'] },
  http_request: { capabilities: ['network.http.request'], aliases: ['发送 http 请求', '调用接口', 'http api request'] },
  http_download: { capabilities: ['network.http.download', 'workspace.file.write'], aliases: ['下载文件', '从网址下载', 'download url to file'] },
  desktop_screenshot: { capabilities: ['desktop.screen.capture'], aliases: ['桌面截图', '屏幕截图', 'take screenshot'] },
  // 下面两件和桥接桌面服务器的 type_text/hotkey、browser_open 是同一件事;给中文叫法,中文检索时与桥接的同分、按原生优先排在前面。
  browser_open: { capabilities: ['browser.url.open'], aliases: ['打开网页', '浏览器打开', '打开网址', 'open url in browser'] },
  office_open: { capabilities: ['office.document.open'], aliases: ['打开办公文档', '打开 excel word ppt pdf', 'open office document'] },
  orchestrate_agents: { capabilities: ['agent.workflow.orchestrate'], aliases: ['编排多个代理', '多代理工作流', 'orchestrate agents'] },
  wait_agents: { capabilities: ['agent.workflow.wait'], aliases: ['等待代理完成', '收代理结果', 'wait for agents'] },
  agent_result: { capabilities: ['agent.workflow.result'], aliases: ['读取代理产出全文', '代理结果', 'read agent result'] },
  skill_read: { capabilities: ['skill.instructions.read'], aliases: ['读取技能说明', '加载技能', 'read skill instructions'] },
  playbook_list: { capabilities: ['playbook.catalog.list'], aliases: ['列出预置流程', '有哪些流程模板', '查看 playbook 清单', 'list playbooks'] },
  playbook_read: { capabilities: ['playbook.steps.read'], aliases: ['读取预置流程步骤', '流程模板填参', '查看 playbook 步骤', 'read playbook steps'] },
  skill_list: { capabilities: ['skill.catalog.list'], aliases: ['列出可用技能', '有哪些技能', '查看技能清单', 'list installed skills'] },
  threads_search: { capabilities: ['chat.history.search'], aliases: ['上次聊天记录', '查找其他聊天', '搜索线程', 'previous chat', 'chat history search'] },
  thread_read: { capabilities: ['chat.history.read'], aliases: ['读取聊天记录', '回读旧历史', '另一个线程', 'read chat history'] },
  workbench_memory_read: { capabilities: ['memory.read'], aliases: ['读取工作台记忆', '回忆信息', 'read memory'] },
  checkpoint_list: { capabilities: ['workspace.checkpoint.list'], aliases: ['查看检查点', '可撤销的修改', '哪些改动能撤销', '已撤销的修改', 'list checkpoints', 'what can be undone'] },
  observation_recall: { capabilities: ['context.observation.recall'], aliases: ['回读原始工具结果', '取回被省略的观察', 'recall reduced observation', 'restore tool result'] },
  workbench_memory_propose: { capabilities: ['memory.propose'], aliases: ['提议保存记忆', '记住经验', 'propose memory'] },
});
// 2026-10: 桥接(MCP)工具的中文检索词。桥接工具的名字和描述多是英文,模型用中文搜(「截图」「鼠标点击」「关闭窗口」)时
// 一个词都对不上 —— 实测内置桌面服务器 108 个工具,「截图」只搜出 set_clipboard_image,「鼠标点击」零命中。这两张表按【工具名里的
// 英文词】给中文说法,不按哪个服务器的清单逐个登记:别的 MCP 服务器里同名词的工具(browser_take_screenshot、list_tabs…)一样受益。
// 键是 normalizeToolSearchText 之后的词或词组(词组优先、最长匹配;单词再试去掉复数 s/es),值的第一项是主说法;认不出的词
// (for/on/at/take…)跳过。词组键只给中文语序或说法与逐词拼接对不上的少数工具。只喂 aliases,不碰 tier/pack/schema。
// 刻意不收 file/directory/folder:桥接服务器自带的 read_file/edit_file/delete_file 与原生 file_* 重复,原生的有工作区护栏、
// 不用代理,中文搜「删除文件」该排出原生的,不该把桥接的复本顶上去。
const BRIDGED_TOOL_NAME_TERMS = Object.freeze({
  // 屏幕 / 截图 / 识别
  screenshot: ['截图', '截屏', '屏幕截图', '截个图'], screen: ['屏幕'], region: ['区域'],
  monitor: ['显示器'], pixel: ['像素'], color: ['颜色'], dpi: ['缩放比例', '显示缩放'],
  'screen info': ['屏幕信息', '屏幕分辨率'], 'find on screen': ['屏幕找图', '在屏幕上找图'],
  observe: ['观察屏幕', '看屏幕', '屏幕快照'], ocr: ['文字识别', '识别文字'], language: ['语言'],
  template: ['模板', '找图'], vision: ['识图', '找图'],
  // 鼠标 / 键盘
  mouse: ['鼠标'], click: ['点击', '单击'], drag: ['拖拽', '拖动'], scroll: ['滚动', '滚轮'], position: ['位置', '坐标'],
  'mouse click': ['鼠标点击', '鼠标单击', '双击', '右键点击'],
  keyboard: ['键盘'], key: ['按键'], hotkey: ['快捷键', '组合键'], text: ['文字', '文本'],
  'type text': ['输入文字', '键盘输入', '打字', '输入文本'], 'key down': ['按住按键', '按住'], 'key up': ['松开按键', '松开'],
  // 窗口 / 程序 / 系统
  window: ['窗口'], topmost: ['置顶'], application: ['程序', '应用', '软件'], process: ['进程'], command: ['命令'],
  system: ['系统'], environment: ['环境'], variable: ['变量'], notification: ['通知'], notify: ['提醒'],
  'message box': ['消息框', '弹窗', '对话框'], sound: ['声音'], beep: ['蜂鸣', '提示音'], wait: ['等待'],
  // 剪贴板
  clipboard: ['剪贴板', '粘贴板'], 'set clipboard': ['复制到剪贴板', '写入剪贴板', '设置剪贴板'],
  // 浏览器 / 网页
  browser: ['浏览器', '网页'], page: ['页面'], tab: ['标签页'], navigate: ['导航', '后退', '前进', '刷新'],
  element: ['元素'], js: ['脚本'], url: ['网址'], fetch: ['抓取网页', '网页抓取', '请求网址'],
  // 办公文档 / 图片
  document: ['文档'], excel: ['表格', '电子表格', '工作簿'], chart: ['图表'], beautify: ['美化', '排版'],
  pdf: ['pdf', 'pdf文档'], pptx: ['ppt', '幻灯片', '演示文稿'], ppt: ['ppt', '幻灯片', '演示文稿'], image: ['图片', '图像'],
  // 录制 / 批量 / 记忆 / 杂项
  record: ['录制'], macro: ['宏'], batch: ['批量'], verify: ['验证', '确认'], memory: ['记忆'],
  sequential: ['逐步'], thinking: ['思考', '推理'], diagnostics: ['诊断', '自检'], audit: ['审计日志', '审计'],
  safety: ['安全'], version: ['版本'], ui: ['控件', '界面'],
});
// 通用动词与修饰词:只跟上表的词拼成整句,自己撑不起别名(否则「删除」会成为 delete_file 的整句别名,任何带「删除」的查询都加分)。
const BRIDGED_TOOL_NAME_MODIFIERS = Object.freeze({
  get: ['获取', '读取'], set: ['设置', '写入'], list: ['列出', '列表'], read: ['读取', '查看'], write: ['写入', '生成', '创建'],
  edit: ['修改', '编辑'], copy: ['复制'], move: ['移动'], delete: ['删除'], save: ['保存'], open: ['打开'],
  close: ['关闭'], show: ['显示', '弹出'], find: ['查找', '定位'], run: ['运行', '执行'], execute: ['执行'],
  start: ['开始'], stop: ['停止'], switch: ['切换'], launch: ['启动', '打开'], kill: ['结束', '杀掉'], play: ['播放'],
  capture: ['截取', '捕获'],   // capture_screen → 截取屏幕;packet_capture / capture_audio 不该叫「截图」
  press: ['按下'], type: ['输入'], input: ['输入'], focus: ['切换到', '激活'], resize: ['调整大小', '缩放'],
  minimize: ['最小化'], maximize: ['最大化'], active: ['活动', '当前'], idle: ['空闲', '就绪'], attention: ['注意'],
  inspect: ['检查', '结构'], invoke: ['操作', '触发'], act: ['操作'], action: ['操作'],
  info: ['信息'], status: ['状态'],
});
const BRIDGED_TOOL_NAME_TERM_MAX_WORDS = 3;
// 桥接工具名 → 中文别名。逐词查表后按「第 k 个说法」齐步拼成整句(mouse_click → 鼠标点击 / 鼠标单击 / 双击…),最多 4 句:
// 每个说法至少在一句里出现,整句又能吃到 v1 的整句/精确别名分。名字里一个 BRIDGED_TOOL_NAME_TERMS 的词都没有就不给别名(修前口径)。
function bridgedToolAliases(toolName) {
  const words = normalizeToolSearchText(toolName).split(' ').filter(Boolean);
  const own = (table, k) => Object.prototype.hasOwnProperty.call(table, k);
  const units = []; let anchored = false;
  for (let i = 0; i < words.length;) {
    let terms = null; let used = 1;
    for (let n = Math.min(BRIDGED_TOOL_NAME_TERM_MAX_WORDS, words.length - i); n >= 2 && !terms; n--) {
      const key = words.slice(i, i + n).join(' ');
      if (own(BRIDGED_TOOL_NAME_TERMS, key)) { terms = BRIDGED_TOOL_NAME_TERMS[key]; used = n; anchored = true; }
    }
    const w = words[i];
    const stems = [w, w.replace(/es$/, ''), w.replace(/s$/, '')].filter(Boolean);
    if (!terms) { const k = stems.find(s => own(BRIDGED_TOOL_NAME_TERMS, s)); if (k) { terms = BRIDGED_TOOL_NAME_TERMS[k]; anchored = true; } }
    if (!terms) { const k = stems.find(s => own(BRIDGED_TOOL_NAME_MODIFIERS, s)); if (k) terms = BRIDGED_TOOL_NAME_MODIFIERS[k]; }
    if (terms) units.push(terms);
    i += used;
  }
  if (!anchored) return [];
  const width = Math.min(4, Math.max(...units.map(u => u.length)));
  const out = new Set();
  for (let k = 0; k < width; k++) out.add(units.map(u => u[Math.min(k, u.length - 1)]).join(''));
  return [...out];
}

function normalizeToolSearchText(value) {
  return String(value == null ? '' : value).normalize('NFKC')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().replace(/[_./\\:-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokenizeToolSearchText(value) {
  const normalized = normalizeToolSearchText(value);
  const out = new Set(normalized.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  // Chinese has no whitespace boundaries in most queries/descriptions. Add bounded 2/3-grams while keeping
  // Latin words intact; this makes 「查找符号引用」 match 「查找代码引用」 without an embedding runtime.
  for (const segment of normalized.match(/[\p{Script=Han}]{2,}/gu) || []) {
    out.add(segment);
    for (const n of [2, 3]) for (let i = 0; i + n <= segment.length; i++) out.add(segment.slice(i, i + n));
  }
  // 中英混写不留空格(「读取pdf」「做个ppt」「写excel」)时整串是一个词,里面的英文词单独再记一份。
  for (const part of normalized.split(/[^\p{L}\p{N}]+|\p{Script=Han}+/u)) if (part) out.add(part);
  return [...out].filter(t => t.length > 1 || /^\d+$/.test(t));
}

function toolSchemaSearchText(schema) {
  const out = []; const seen = new Set();
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 4 || seen.has(node)) return;
    seen.add(node);
    if (typeof node.title === 'string') out.push(node.title);
    if (typeof node.description === 'string') out.push(node.description.slice(0, 160));
    if (node.properties && typeof node.properties === 'object') {
      for (const [key, child] of Object.entries(node.properties)) { out.push(key); walk(child, depth + 1); }
    }
    if (node.items) walk(node.items, depth + 1);
  };
  walk(schema, 0);
  return out.join(' ').slice(0, 1200);
}

// bridgedToolName:桥接工具去掉服务器前缀的名字(bridge.toolName);给了才按 BRIDGED_TOOL_NAME_TERMS 补中文别名。
function retrievalHintForTool(name, pack, bridgedToolName) {
  const exact = TOOL_RETRIEVAL_HINTS[name] || {};
  const nameWords = normalizeToolSearchText(name).split(' ').filter(Boolean);
  return {
    capabilities: [...new Set([...(exact.capabilities || []), `${pack}.${nameWords.join('.')}`])],
    aliases: [...new Set([...(exact.aliases || []), ...(bridgedToolName ? bridgedToolAliases(bridgedToolName) : [])])],
  };
}

function classifyToolPacks(message, attachments) {
  const s = String(message || '').toLowerCase();
  const packs = new Set(['core']);
  const add = (...xs) => xs.forEach(x => packs.add(x));
  if (Array.isArray(attachments) && attachments.length) add('files_read');
  if (/(图片|图像|照片|扫描件|看图|文档|image|photo|scan\b)/i.test(s)) add('files_read');
  if (/(文件|目录|路径|源码|代码|项目|repo|repository|file|folder|directory|source|workspace|read|读取|查看|搜索|查找|分析|审查)/i.test(s)) add('files_read');
  // 2026-10:泛化的动词(修改/编辑/更新/写入/创建/删除…)只带文件读写,不再顺带 code 包。code 包(git/依赖/审查/符号检索等
  // 12 个工具、约 2.3K token)本机 4 天 0 次使用,却被「file_edit」里的 edit、「更新」这类词带进来;而会话工具表只增不减,
  // 带进来就跟着整个会话。只有明确的代码意图(实现/修复/重构,或下一条的代码词)才装 code。
  if (/(实现|修改|编辑|写入|创建|删除|移动|复制|修复|重构|更新|落盘|撤销|回滚|检查点|implement|modify|edit|write|create|delete|move|copy|fix|refactor|update|undo|rollback|checkpoint)/i.test(s)) add('files_read', 'files_write');
  if (/(实现|修复|重构|implement|fix|refactor)/i.test(s)) add('code');
  // 「编码」多指「编码能力」或字符编码、「测试」多指「测一下」,都不再单独算代码意图(「测试」仍带 shell:跑测试要命令行);
  // 明确的「单测 / 单元测试」照旧算。
  if (/(代码|编程|bug|单测|单元测试|构建|依赖|git|commit|push|pull request|typescript|javascript|python|java|rust|go\b|npm|pnpm|yarn|编译)/i.test(s)) add('files_read', 'code');
  if (/(运行|执行|命令|终端|shell|powershell|脚本|测试|构建|安装|启动|重启|部署|run|execute|command|terminal|script|test|build|install|start|restart|deploy)/i.test(s)) add('shell');
  // 2026-10:补实时信息类说法(行情/走势/股/汇率/天气/新闻…)。修前「查一下美股这周与下周的走势」只分到 core,
  // 整个会话 36 次联网全绕 tool_invoke_read 代理(web 包 schema 合计不到 1K token)。
  if (/(联网|网页|网站|搜索网络|查新闻|新闻|最新|行情|走势|股价|股市|美股|港股|a股|汇率|天气|热搜|票房|url|https?:|web|internet|online|search the web|fetch)/i.test(s)) add('web');
  if (/(excel|word|powerpoint|pptx?|docx?|pdf|表格|电子表格|工作簿|幻灯片|演示文稿|文档排版)/i.test(s)) add('office', 'files_read', 'files_write');
  if (/(截图|桌面|窗口|鼠标|键盘|点击|屏幕|ocr|screenshot|desktop|window|mouse|keyboard|click)/i.test(s)) add('desktop');
  if (/(压缩|解压|zip|archive|unzip)/i.test(s)) add('archive', 'files_read', 'files_write');
  if (/(子代理|多代理|工作流|并行|agent|orchestrat|delegate)/i.test(s)) add('agents');
  // 61 号文 C1:Playbook / 预置流程 / 流程模板 / 操作流程 也带 skills 包(playbook_list / playbook_read / skill_list 住在那里)。
  if (/(技能|skill|playbook|预置流程|预置操作|流程模板|模板流程|操作流程)/i.test(s)) add('skills');
  if (/(mcp|连接器|工具配置|浏览器目标|browser target|connector|tool config)/i.test(s)) add('integrations');
  // 「偏好 / preference」不再单独装 memory 包:记下一条偏好用的是 core 里的 workbench_memory_propose,memory 包是关系边 /
  // 修订 / 撤销这几件维护工具;修前「这两家模型谁更强…偏好」这类话题词就把它带进来、跟着整个会话。
  if (/(上次|接着|另一个线程|其他聊天|其它聊天|聊天记录|对话历史|previous chat|another thread|chat history|continue.*thread)/i.test(s)) add('memory');
  if (/(记住|记忆|以后别忘|修订记忆|更正记忆|过时|关系边|remember|memorize|memory|memories|recall|outdated|supersede|contradict)/i.test(s)) add('memory');
  if (/(思考|推理|分析|对比|决策|规划|方案|权衡|think|reason|analy|compare|decide|plan|strateg)/i.test(s)) add('thinking');
  return [...packs];
}

function buildToolCatalog(tools, bridgedRoute, config) {
  return (tools || []).map(t => {
    const fn = t && t.function || {};
    const bridge = resolveBridge(bridgedRoute || {}, fn.name);
    const pack = toolPackForName(fn.name, bridgedRoute);
    const hint = retrievalHintForTool(fn.name, pack, bridge ? bridge.toolName : '');
    return {
      name: fn.name || '', pack,
      tier: bridge ? bridgedToolTier(bridge.toolName, config) : nativeToolTier(fn.name),
      bridged: !!bridge,
      description: String(fn.description || '').replace(/\s+/g, ' ').slice(0, 220), tool: t,
      capabilities: hint.capabilities, aliases: hint.aliases,
      parameterText: toolSchemaSearchText(fn.parameters),
    };
  }).filter(x => x.name);
}

function legacyToolCatalogSearch(catalog, query, limit, nameBoost) {
  const words = String(query || '').toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean);
  const scored = (catalog || []).map(x => {
    const hay = `${x.name} ${x.pack} ${x.description}`.toLowerCase();
    const score = words.reduce((n, w) => n + (hay.includes(w) ? (x.name.toLowerCase().includes(w) ? nameBoost : 1) : 0), 0);
    return { x, score };
  }).filter(r => !words.length || r.score > 0).sort((a, b) => b.score - a.score || a.x.name.localeCompare(b.x.name)).slice(0, limit);
  const matches = scored.map(({ x }) => ({ name: x.name, pack: x.pack, tier: x.tier, description: x.description }));
  return { ok: true, query: String(query || ''), matches, packs: packDescriptionsFor(matches) };
}
// tool_search 结果只带【命中条目所在的那几个包】的说明。修前每次都附整张 15 个包的表:实测一次检索结果 3302 B 里它占 1049 B,
// 一个会话检索几次就重复几次。整张表归 list_tools(它本来就是「不知道搜什么时先看目录」的入口)。
function packDescriptionsFor(matches) {
  const out = {};
  for (const m of Array.isArray(matches) ? matches : []) {
    const p = m && m.pack;
    if (p && !out[p] && Object.prototype.hasOwnProperty.call(TOOL_PACK_DESCRIPTIONS, p)) out[p] = TOOL_PACK_DESCRIPTIONS[p];
  }
  return out;
}

function runtimeToolBlockedReason(item, config) {
  const mode = config && config.permissionMode;
  if ((mode === 'plan' || mode === 'dontAsk') && item && item.tier !== 'read') return `permission mode '${mode}' blocks ${item.tier}-tier execution`;
  return '';
}

// 21-E5 (metaToolHintsV1): 紧凑调用提示 —— 只加字段,不改排序/内容。requiredArgs 只取必填参数名与基础
// 类型(有界 ≤4,不回传完整 schema);callHint 告诉模型「direct 直调 / tool_invoke_* 代理 / tool_load 先加载」;
// state=blocked 携带不泄漏敏感信息的原因码(复用 searchToolCatalog 的 blockedReason 文本)。
function buildCallHint(item, loadedNames, config, blockedReason) {
  if (!item) return {};
  const name = String(item.name || '');
  const loaded = !!(loadedNames && loadedNames.has(name));
  const fn = item.tool && item.tool.function;
  const params = fn && fn.parameters;
  const props = (params && params.properties && typeof params.properties === 'object') ? params.properties : {};
  const required = Array.isArray(params && params.required) ? params.required.filter(k => props[k]).slice(0, 4) : [];
  const argTypes = {};
  for (const k of required) {
    const p = props[k] || {};
    if (typeof p.type === 'string') argTypes[k] = p.type;
    else if (Array.isArray(p.enum) && p.enum.length) argTypes[k] = 'enum';
    else argTypes[k] = 'any';
  }
  let callHint;
  if (loaded) callHint = 'direct';
  else if (item.bridged) callHint = 'tool_invoke_' + (item.tier || 'read');
  else callHint = 'tool_load';
  const state = loaded ? 'loaded' : (blockedReason ? 'blocked' : 'callable');
  return { requiredArgs: required, argTypes, callHint, state, ...(blockedReason ? { blockedReason } : {}) };
}

// 2026-10 代叫「叫得对」:把一个工具的 JSON Schema 压成一行参数骨架 —— `path*:string, mode?:a|b`(* 必填、? 可选)。
// 代叫不把完整说明书装进上下文,模型手里只有目录卡;骨架让它第一次就知道该传哪几个键、什么类型、哪些取值。
//   brief:目录卡用 —— 全部必填(至多 6 个)+ 至多 2 个可选,总长 ≤140 字符,超出的记成 …(+N);
//   full :代叫参数错时随错误递回(12 withToolArgsGuide)—— 至多 16 个,每个带 ≤60 字的用途说明。
// 认 pydantic 的可空写法(anyOf [T, null])、类型数组、$ref → $defs(FastMCP 的 Enum / 模型参数就是这么出的)、allOf 单包装、
// const;对象 / 数组只标 object / array<T>,不往里展开(展开就是把说明书搬回来了)。
// 返回值:'none' = 明确没有参数(properties 是空对象,也没有 $ref / allOf / 额外键这些说不清的形状);
//         ''     = 这份 schema 压不成骨架(根上是 $ref / allOf / 自由对象 / 没给)—— 调用方不加 args / argsGuide,不拿「无参」误导模型。
const TOOL_ARGS_BRIEF_CHARS = 140;
const TOOL_ARG_ENUM_VALUE_CHARS = 24;
function toolArgsResolveRef(p, root, depth) {
  let cur = p;
  for (let i = 0; i < 4 && cur && typeof cur === 'object'; i += 1) {
    if (typeof cur.$ref === 'string') {
      const m = /^#\/(\$defs|definitions)\/(.+)$/.exec(cur.$ref);
      const defs = m && root && root[m[1]];
      const next = defs && typeof defs === 'object' ? defs[m[2]] : null;
      if (!next) return cur;
      cur = next; continue;
    }
    if (Array.isArray(cur.allOf) && cur.allOf.length === 1 && !cur.type && !cur.enum) { cur = cur.allOf[0]; continue; }
    break;
  }
  return depth > 6 ? null : cur;
}
function toolArgEnumText(values) {
  const shown = values.slice(0, 5).map(v => {
    const s = (v !== null && typeof v === 'object') ? JSON.stringify(v) : String(v);
    return s.length > TOOL_ARG_ENUM_VALUE_CHARS ? s.slice(0, TOOL_ARG_ENUM_VALUE_CHARS) + '…' : s;
  });
  return shown.join('|') + (values.length > 5 ? '|…' : '');
}
function toolArgTypeText(p0, root, depth = 0) {
  const p = toolArgsResolveRef(p0, root, depth);
  if (!p || typeof p !== 'object' || depth > 6) return 'any';
  if (Array.isArray(p.enum) && p.enum.length) return toolArgEnumText(p.enum);
  if (Object.prototype.hasOwnProperty.call(p, 'const')) return toolArgEnumText([p.const]);
  const alts = Array.isArray(p.anyOf) ? p.anyOf : (Array.isArray(p.oneOf) ? p.oneOf : null);
  if (alts && !p.type) {
    const nonNull = alts.filter(a => a && typeof a === 'object' && a.type !== 'null');
    const texts = [...new Set(nonNull.map(a => toolArgTypeText(a, root, depth + 1)))];
    return texts.length ? texts.join('/') : 'any';
  }
  let t = p.type;
  if (Array.isArray(t)) { t = t.filter(x => x !== 'null'); t = t.length === 1 ? t[0] : t.join('/'); }
  if (t === 'array') {
    const it = (p.items && typeof p.items === 'object' && !Array.isArray(p.items)) ? toolArgTypeText(p.items, root, depth + 1) : 'any';
    return it !== 'any' ? `array<${it}>` : 'array';
  }
  return (typeof t === 'string' && t) ? t : 'any';
}
function toolArgsSkeleton(schema0, mode) {
  const full = mode === 'full';
  const schema = toolArgsResolveRef(schema0, schema0, 0);
  if (!schema || typeof schema !== 'object') return '';
  const props = (schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)) ? schema.properties : null;
  const names = props ? Object.keys(props) : [];
  if (!names.length) {
    const opaque = !props || schema.$ref || schema.allOf || schema.anyOf || schema.oneOf || (schema.additionalProperties && schema.additionalProperties !== false);
    return opaque ? '' : 'none';
  }
  const required = new Set((Array.isArray(schema.required) ? schema.required : []).filter(k => Object.prototype.hasOwnProperty.call(props, k)));
  const req = names.filter(n => required.has(n));
  const opt = names.filter(n => !required.has(n));
  const part = n => {
    const p = props[n] || {};
    let s = `${n}${required.has(n) ? '*' : '?'}:${toolArgTypeText(p, schema0)}`;
    if (full) {
      const d = String((toolArgsResolveRef(p, schema0, 0) || {}).description || p.description || '').replace(/\s+/g, ' ').trim();
      if (d) s += ` — ${d.length > 60 ? d.slice(0, 60) + '…' : d}`;
    }
    return s;
  };
  // 尾注:没列出来的个数,其中有必填时点明 —— 「…(+5, 3 required)」,模型就知道该去要完整说明而不是当它们可有可无。
  const tail = shownNames => {
    const hidden = names.filter(n => !shownNames.includes(n));
    if (!hidden.length) return '';
    const hiddenReq = hidden.filter(n => required.has(n)).length;
    return `…(+${hidden.length}${hiddenReq ? `, ${hiddenReq} required` : ''})`;
  };
  if (full) {
    const pick = req.concat(opt).slice(0, 16);
    const t = tail(pick);
    return pick.map(part).join('; ') + (t ? `; ${t}` : '');
  }
  // brief:必填在前、可选至多 2 个;总长(含尾注)守住 140 —— 只有第一个参数本身就超长时例外(参数名不能截,模型要原样传)。
  const order = req.slice(0, 6).concat(opt.slice(0, 2));
  const kept = [];
  for (const n of order) {
    const next = kept.concat(n);
    const t = tail(next);
    const text = next.map(part).join(', ') + (t ? `, ${t}` : '');
    if (kept.length && text.length > TOOL_ARGS_BRIEF_CHARS) break;
    kept.push(n);
  }
  const t = tail(kept);
  return kept.map(part).join(', ') + (t ? `, ${t}` : '');
}
// 检索结果统一出口:还没装进工具表的命中带上参数骨架(args)。已装的不带 —— 它的完整说明书本来就在工具表里。
// opts.loadedNames 只有模型服务商回合给(09 的 toolLoading.search);MCP / CLI 路径不知道 CLI 手里有什么,一律带。
// 与 metaToolHintsV1(requiredArgs / callHint / 待办去重)无关:那个开关仍管它自己那几样,这里默认开。
// 61-B1:排在最前的 3 个未装载命中给 full 骨架(全部参数 + 用途说明),其余仍是 brief。真机里 brief 有 41% 被截成「…(+N)」,
// 模型要么多一轮 tool_load、要么猜参数代叫;最可能被选中的那几个直接给全,文本落在 tool_result 里,不动工具表(缓存中性)。
const TOOL_SEARCH_FULL_ARGS_TOP = 3;
function withToolArgSkeletons(result, catalog, opts) {
  if (!result || !Array.isArray(result.matches) || !result.matches.length) return result;
  const loaded = (opts && opts.loadedNames instanceof Set) ? opts.loadedNames : null;
  const byName = new Map((catalog || []).map(x => [x && x.name, x]));
  let fullLeft = TOOL_SEARCH_FULL_ARGS_TOP;
  const matches = result.matches.map(m => {
    if (!m || m.args !== undefined || (loaded && loaded.has(m.name))) return m;
    const item = byName.get(m.name);
    const params = item && item.tool && item.tool.function && item.tool.function.parameters;
    const full = fullLeft > 0;
    const args = toolArgsSkeleton(params, full ? 'full' : 'brief');
    if (!args) return m;   // 压不成骨架的(根上是 $ref / 自由对象)不加,别拿「无参」误导
    if (full) fullLeft -= 1;
    return { ...m, args };
  });
  return { ...result, matches };
}
// 61-B3:桌面 MCP 里与内置工具同一件事的桥接工具(按桥接裸名)。只做目录标注:对应的内置工具在本回合目录里时,命中卡带
// preferred、排到同批未遮蔽项之后。不隐藏、不改 tier / 闸 / 分发 —— 桥接版有内置没有的能力(追加写、目录级 move/copy、
// cmd.exe 语义),模型确有需要时照样能用。内置版受工作区边界与写前检查点保护,这是首选的理由。
const BRIDGED_SHADOWED_BY_NATIVE = Object.freeze({
  read_file: 'file_read', write_file: 'file_write', edit_file: 'file_edit',
  delete_file: 'file_delete', move_file: 'file_move', copy_file: 'file_copy',
  list_directory: 'file_list', fetch: 'web_fetch', run_command: 'shell_run',
});
function bridgedShadowNative(item, nativeNames) {
  if (!item || !item.bridged) return '';
  const raw = String(item.name || '').split('__').pop();
  const native = Object.prototype.hasOwnProperty.call(BRIDGED_SHADOWED_BY_NATIVE, raw) ? BRIDGED_SHADOWED_BY_NATIVE[raw] : '';
  return native && nativeNames.has(native) ? native : '';
}
function withShadowedBridgeHints(result, catalog) {
  if (!result || !Array.isArray(result.matches) || !result.matches.length) return result;
  const nativeNames = new Set((catalog || []).filter(x => x && !x.bridged).map(x => x.name));
  const byName = new Map((catalog || []).map(x => [x && x.name, x]));
  let any = false;
  const tagged = result.matches.map(m => {
    const native = m && bridgedShadowNative(byName.get(m.name), nativeNames);
    if (!native) return m;
    any = true;
    return { ...m, preferred: native };
  });
  if (!any) return result;
  // 稳定分区:同一批命中里未遮蔽的在前,被遮蔽的桥接项挪到后面(只在已截好的 Top-K 内重排,不动两套排序本身)。
  return { ...result, matches: tagged.filter(m => !m || !m.preferred).concat(tagged.filter(m => m && m.preferred)) };
}
// 61-A4:零命中不再只回一张空表 —— 模型分不清「措辞没对上」和「真没有这类工具」,于是换着说法连搜(真机搜「撤销/回滚」)。
const TOOL_SEARCH_EMPTY_NOTE = 'No dedicated tool matched. Try other capability words (Chinese or English) or browse with list_tools {pack}; if nothing fits, do it with the general tools you already have (e.g. shell_run / script_run when available) or tell the user it is not supported.';
function searchToolCatalog(catalog, args, config, opts) {
  const q = normalizeToolSearchText(args && args.query || '');
  // New media/background entry points must remain discoverable when legacy retrieval is selected.
  // Ordinary file/tool queries still honor runtimeToolRetrievalV1 (including shadow-only comparisons).
  const mediaQuery = ['读取图片', '查看图像', '看图', '视觉输入', '读取文档', '读取PDF', 'read image', 'view image', 'view image vision', 'vision']
    .some(alias => normalizeToolSearchText(alias) === q);
  const workflowQuery = ['audio_inspect', 'media_probe', 'code_check', 'acceptance_report', 'shell_start', 'shell_poll', 'shell_kill']
    .some(name => TOOL_RETRIEVAL_HINTS[name].aliases.some(alias => normalizeToolSearchText(alias) === q));
  if (q && (mediaQuery || workflowQuery)) opts = { ...(opts || {}), forceV1: true };
  // 先分区再给骨架:full 骨架的 3 个名额先给未遮蔽项(被遮蔽的桥接项已挪到后面)。
  const result = withToolArgSkeletons(withShadowedBridgeHints(rankToolCatalog(catalog, args, config, opts), catalog), catalog, opts);
  if (result && Array.isArray(result.matches)) {
    for (const match of result.matches) {
      if (/^shell_(?:start|send|poll|kill|list)$/.test(match.name)) match.availability = 'Native provider turns only; CLI/MCP engines use their own background-command tools.';
    }
    if (args && args.view === 'matrix') result.capabilityMatrix = result.matches.map(m => ({ tool: m.name, pack: m.pack, tier: m.tier,
      modality: m.name === 'file_read' ? 'text/image/document' : /^audio_/.test(m.name) ? 'audio' : /^shell_/.test(m.name) ? 'background process' : m.name === 'code_check' ? 'code' : m.name === 'acceptance_report' ? 'verification' : 'other',
      ...(m.availability ? { availability: m.availability } : {}) }));
  }
  if (result && Array.isArray(result.matches) && !result.matches.length && String(args && args.query || '').trim()) return { ...result, note: TOOL_SEARCH_EMPTY_NOTE };
  return result;
}

function rankToolCatalog(catalog, args, config, opts) {
  const query = String(args && args.query || '');
  // limit ≤ 0 / 非数字一律回默认(修前 0 → 默认、-5 → 1,同一参数两种口径)。
  const limitNum = Number(args && args.limit);
  const limit = limitNum > 0 ? Math.min(20, Math.max(1, limitNum)) : 8;
  const forceV1 = !!(opts && opts.forceV1);
  if ((!config || config.runtimeToolRetrievalV1 !== true) && !forceV1) {
    const legacySearch = () => legacyToolCatalogSearch(catalog, query, limit, Math.max(1, Number(opts && opts.legacyNameBoost) || 1));
    // 带汉字的查询不走子串匹配:中文不分词,整段说法只能原样撞上描述里的同一串字 —— 撞上的多半是噪声(「截图」只撞上
    // set_clipboard_image 描述里的「截图了一张图」),还挡掉了下面的别名排序。这类查询直接用带别名/能力词的分词排序。
    const legacy = /\p{Script=Han}/u.test(query) ? null : legacySearch();
    // 子串匹配零命中(或上面跳过了它)时,退到分词排序再试一次,而不是交回空表让模型以为没有这个工具。
    // 只交得分 > 0 的:单个汉字(「删」)切不出词,分词排序会把整张目录按 0 分垫满;一个都没得分就照旧交子串匹配的结果。
    // 不含汉字且有命中时排序与修前一致(出口另加 args 骨架,见上)。注:shadow 对比(compareToolRetrievalShadow)对这类查询是 v1 比 v1,恒一致。
    if (query.trim() && (!legacy || (Array.isArray(legacy.matches) && legacy.matches.length === 0))) {
      const v1 = rankToolCatalog(catalog, args, config, { ...(opts || {}), forceV1: true });
      const hits = (Array.isArray(v1.matches) ? v1.matches : []).filter(m => m.score > 0);
      if (hits.length) return { ...v1, matches: hits, packs: packDescriptionsFor(hits), fallback: 'alias_ranker' };
    }
    return legacy || legacySearch();
  }
  const startedAt = Date.now();
  const qNorm = normalizeToolSearchText(query);
  const qTokens = [...new Set(tokenizeToolSearchText(query))];
  const docs = (catalog || []).map(item => {
    const fields = {
      name: tokenizeToolSearchText(item.name),
      aliases: tokenizeToolSearchText((item.aliases || []).join(' ')),
      capabilities: tokenizeToolSearchText((item.capabilities || []).join(' ')),
      parameters: tokenizeToolSearchText(item.parameterText || ''),
      description: tokenizeToolSearchText(item.description || ''),
      pack: tokenizeToolSearchText(item.pack || ''),
    };
    const all = new Set(Object.values(fields).flat());
    return { item, fields, all };
  });
  const df = new Map();
  for (const token of qTokens) df.set(token, docs.reduce((n, d) => n + (d.all.has(token) ? 1 : 0), 0));
  const weights = { name: 9, aliases: 7, capabilities: 6, parameters: 3, description: 2, pack: 2 };
  const ranked = docs.map(doc => {
    const components = {}; const matchedOn = new Set(); let score = 0;
    const itemNameNorm = normalizeToolSearchText(doc.item.name);
    if (qNorm && (qNorm === itemNameNorm || qNorm === String(doc.item.name || '').toLowerCase())) { components.exactName = 100; score += 100; matchedOn.add('exact_name'); }
    // 整句别名:互相包含 +14;一字不差 +24(「截图」是 screenshot 的叫法,只是 browser_screenshot 叫法的一部分)。
    let aliasPhrase = 0;
    for (const alias of doc.item.aliases || []) {
      const a = normalizeToolSearchText(alias);
      if (!qNorm || !a) continue;
      if (qNorm === a) { aliasPhrase = 24; break; }
      if (!aliasPhrase && (qNorm.includes(a) || a.includes(qNorm))) aliasPhrase = 14;
    }
    if (aliasPhrase) { components.aliasPhrase = aliasPhrase; score += aliasPhrase; matchedOn.add('alias'); }
    for (const [field, tokens] of Object.entries(doc.fields)) {
      const set = new Set(tokens); let subtotal = 0;
      for (const token of qTokens) {
        if (!set.has(token)) continue;
        const freq = Math.max(1, df.get(token) || 1);
        const idf = Math.log(1 + (docs.length + 1) / freq);
        subtotal += weights[field] * idf;
      }
      if (subtotal > 0) { components[field] = Number(subtotal.toFixed(3)); score += subtotal; matchedOn.add(field); }
    }
    return { doc, score, components, matchedOn: [...matchedOn] };
  }).filter(r => !qTokens.length || r.score > 0)
    // 同分时原生工具排在桥接工具前面(ACC 的 read_file 与原生 file_read 同叫「读取文件」时,原生的有工作区护栏、不用代理)。
    .sort((a, b) => b.score - a.score || (a.doc.item.bridged ? 1 : 0) - (b.doc.item.bridged ? 1 : 0) || a.doc.item.name.localeCompare(b.doc.item.name)).slice(0, limit);
  const loadedNames = opts && opts.loadedNames instanceof Set ? opts.loadedNames : null;
  const matches = ranked.map(r => {
    const x = r.doc.item; const blockedReason = runtimeToolBlockedReason(x, config);
    return {
      name: x.name, pack: x.pack, tier: x.tier, description: x.description,
      score: Number(r.score.toFixed(3)), matchedOn: r.matchedOn,
      loaded: loadedNames ? loadedNames.has(x.name) : undefined,
      blockedReason: blockedReason || undefined,
    };
  });
  return {
    ok: true, query, retrievalVersion: 'deterministic-v1',
    queryHash: hashRuntimeToolEvidence(qNorm),
    elapsedMs: Date.now() - startedAt,
    matches,
    packs: packDescriptionsFor(matches),
  };
}

function compareToolRetrievalShadow(baseline, candidate) {
  const baselineNames = Array.isArray(baseline && baseline.matches) ? baseline.matches.slice(0, 5).map(x => x.name) : [];
  const candidateNames = Array.isArray(candidate && candidate.matches) ? candidate.matches.slice(0, 5).map(x => x.name) : [];
  const candidateSet = new Set(candidateNames);
  const overlap = baselineNames.filter(name => candidateSet.has(name)).length;
  const denominator = Math.max(1, Math.min(5, Math.max(baselineNames.length, candidateNames.length)));
  return {
    retrievalVersion: candidate && candidate.retrievalVersion || 'deterministic-v1',
    queryHash: candidate && candidate.queryHash || '',
    baselineResultCount: Array.isArray(baseline && baseline.matches) ? baseline.matches.length : 0,
    candidateResultCount: Array.isArray(candidate && candidate.matches) ? candidate.matches.length : 0,
    baselineTopTools: baselineNames,
    candidateTopTools: candidateNames,
    top1Changed: (baselineNames[0] || '') !== (candidateNames[0] || ''),
    overlapAt5: Number((overlap / denominator).toFixed(3)),
    elapsedMs: Number(candidate && candidate.elapsedMs) || 0,
  };
}

function listCompactTools(catalog, args) {
  const pack = String(args && args.pack || '').trim();
  const cursor = Math.max(0, Math.floor(Number(args && args.cursor) || 0));
  const limitNum = Math.floor(Number(args && args.limit));   // ≤ 0 / 非数字回默认 200(与 tool_search 同口径)
  const limit = limitNum > 0 ? Math.min(200, limitNum) : 200;
  const available = (catalog || []).filter(x => !pack || x.pack === pack)
    .slice().sort((a, b) => a.pack.localeCompare(b.pack) || a.name.localeCompare(b.name));
  const page = available.slice(cursor, cursor + limit);
  const groups = {};
  // 61-B2:代叫要选对 tool_invoke_<tier>,修前 tier 只有 tool_search 给。这里只列非 read 的名字(read 是多数,省 token)。
  const tiers = {};
  for (const item of page) {
    if (!groups[item.pack]) groups[item.pack] = [];
    groups[item.pack].push(item.name);
    if (item.tier && item.tier !== 'read') (tiers[item.tier] || (tiers[item.tier] = [])).push(item.name);
  }
  const nextCursor = cursor + page.length < available.length ? cursor + page.length : null;
  return {
    ok: true, pack: pack || null, total: available.length, cursor, count: page.length, nextCursor,
    groups, tiers, availablePacks: Object.keys(TOOL_PACK_DESCRIPTIONS), packs: TOOL_PACK_DESCRIPTIONS,   // 包说明全表只在这里给(tool_search 只带命中的包)
    next: nextCursor === null ? 'Use tool_search with a capability or exact name for descriptions and risk tiers.' : `Call list_tools again with cursor ${nextCursor}.`,
  };
}

function createToolLoader({ logEvent }) {
  // 106 #1 G2(21-E4 §7.2): 会话级 schema 冻结表 —— appendOnlyToolSchemasV1 开时按 session 冻结
  // tools 顺序,之后只追加不重排(探针 S5: 中间插入全前缀命中归零,尾部追加保留 ~77%)。
  // 进程内 Map 不持久化:重启后按当次分类重建(等价于新会话的首建冻结),条目变化才记录。
  // 上限 200 会话防常驻内存增长,淘汰最久未触碰。
  const toolSchemaFreezeBySessionMap = new Map();
  function toolSchemaFreezeFor(freezeKey) {
    let freeze = toolSchemaFreezeBySessionMap.get(freezeKey);
    if (!freeze) {
      freeze = { names: [], nameSet: new Set(), initLogged: false, missingKey: '' };
      toolSchemaFreezeBySessionMap.set(freezeKey, freeze);
      if (toolSchemaFreezeBySessionMap.size > 200) toolSchemaFreezeBySessionMap.delete(toolSchemaFreezeBySessionMap.keys().next().value);
    } else {
      // 触碰:提到最新位置,淘汰队首即最久未用
      toolSchemaFreezeBySessionMap.delete(freezeKey);
      toolSchemaFreezeBySessionMap.set(freezeKey, freeze);
    }
    return freeze;
  }

  // 会话头上的工具表(session.toolSchemaNames)只认工具名形状的字符串,去重、限长;不是数组 / 坏元素一律当没有。
  const TOOL_SCHEMA_NAMES_MAX = 200;
  function sanitizeToolSchemaNames(v) {
    if (!Array.isArray(v)) return [];
    const out = [];
    const seen = new Set();
    for (const n of v) {
      if (typeof n !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(n) || seen.has(n)) continue;
      seen.add(n); out.push(n);
      if (out.length >= TOOL_SCHEMA_NAMES_MAX) break;
    }
    return out;
  }

  function createToolLoadingState(config, message, attachments, tools, bridgedRoute, freezeKey, opts) {
    // 2026-10 能力总闸:被设置关掉的内置桌面 MCP 工具不进目录 —— 于是 full 注入、tool_load 按名拉入、tool_search / list_tools
    // 都看不见它;冻结表里早先记下的名字按「目录里已经没有」处理(下方 current() 只输出仍在目录里的,与原生工具被关时同一条路)。
    // opts.desktopOverride 语义同 buildOpenAiTools(null = 跟随全局;09 传会话头上的 desktopTools)。
    const desktopOverride = (opts && opts.desktopOverride != null) ? opts.desktopOverride : null;
    const catalog = buildToolCatalog(dropPolicyDisabledBridgedTools(tools, bridgedRoute, config, desktopOverride), bridgedRoute, config);
    const full = config && config.toolLoadingMode === 'full';
    const activePacks = new Set(full ? Object.keys(TOOL_PACK_DESCRIPTIONS) : classifyToolPacks(message, attachments));
    // 116f: 目录里出现 steward 包 = 这是管家会话(四个 offer 面已经保证普通会话的目录里永远没有它们)。
    // 管家的工具面就是固定的 17 个,意图分类对它没有意义,而 classifyToolPacks 永远不会路由到 steward 包
    // —— 不置活跃的话管家在多数回合会一个工具都拿不到。auto 模式下这条就是管家的「按需装载豁免」。
    if (catalog.some(x => x && x.pack === 'steward')) activePacks.add('steward');
    const activeNames = new Set();
    const metaNames = new Set(['list_tools', 'tool_search', 'tool_load']);
    // 名字 → 它为什么进了工具表(starter / tool_load / proxy_promote;缺省 = 分包)。只给冻结表的追加日志分桶,不影响装载。
    const reasonOf = new Map();
    // 起手工具:目录里有、且不是桥接的才装(管家会话的目录里没有它们;被设置关掉的命令工具本来就不在目录里)。
    if (!full) for (const n of PROVIDER_STARTER_TOOLS) {
      const item = catalog.find(x => x && x.name === n);
      if (item && !item.bridged) { activeNames.add(n); reasonOf.set(n, 'starter'); }
    }
    if (!full) {
      // Use the policy-filtered routes so a third-party MCP with a matching tool name stays on demand.
      const browserTask = /浏览器|网页|网站|Chromium|browser|Playwright/i.test(message);
      const desktopTask = (!browserTask && activePacks.has('desktop')) || /桌面控制|原生窗口|原生界面|真实桌面|访达|Finder|GitHub Desktop|Preview\.app|desktop control|native (window|app)|macOS.{0,6}(股市|预览)/i.test(message);
      for (const item of catalog) {
        const route = bridgedRoute?.[item.name];
        if (route?.serverId !== DESKTOP_MCP_SERVER_ID) continue;
        if ((browserTask && BROWSER_STARTERS.has(route.toolName)) || (desktopTask && DESKTOP_STARTERS.has(route.toolName))) {
          activeNames.add(item.name);
          reasonOf.set(item.name, 'starter');
        }
      }
    }
    // 106 #1 G2: 冻结仅在有会话权属的主循环启用(freezeKey = session.id);子代理/一次性调用不传,
    // 保持现状逐字节一致。
    const freeze = (appendOnlyToolSchemasEnabled(config) && typeof freezeKey === 'string' && freezeKey) ? toolSchemaFreezeFor(freezeKey) : null;
    // 2026-10:会话工具表跨重启。冻结表只在进程内存里,重启(或被 LRU 挤掉)后会话退回只按这一句话分包 —— 漏装的包要中途补,
    // 每补一次提供方的前缀缓存就整段失效;工具表顺序也和重启前不同,缓存哪怕没过期也接不上。这里在进程内冻结表还是空的时候,
    // 用会话头上记下的表(opts.restoredNames,由 09 每次变化后写回 session.toolSchemaNames)按原顺序恢复;目录里已经没有的名字
    // (桥接离线 / 被设置关掉)不恢复。
    if (freeze && !freeze.names.length) {
      const restored = sanitizeToolSchemaNames(opts && opts.restoredNames).filter(n => catalog.some(x => x && x.name === n));
      if (restored.length) {
        for (const n of restored) { freeze.nameSet.add(n); freeze.names.push(n); }
        try { logEvent({ kind: 'tool_schema_freeze', state: 'restore', sessionId: freezeKey, count: restored.length }); } catch { /* 遥测绝不阻断 */ }
      }
    }
    // O1 (hb360): auto 模式下桥接工具不按包自动注入 schema（走 tool_invoke_* 代理或 tool_load 显式拉入），
    // 避免单任务注入 100-280 个桥接 schema 导致 input 膨胀（实测均值 303K tokens）。full 模式与元工具/显式拉入不受影响。
    // O4 (hb360) 对抗验证回退: 高频白名单(file_read 始终注入)破坏 adaptive loading 的"按需注入"语义
    // (tool-loading e2e 断言 file_read 在 tool_load 前不注入);且真实任务 classifyToolPacks 已激活 files_read,
    // 白名单仅对纯闲聊任务有用(而闲聊不需要 file_read),收益不抵语义破坏,故回退。
    // 2026-10 的起手工具(PROVIDER_STARTER_TOOLS)是按另一笔账加的 —— 中途补装的缓存代价,见那张表的头注;file_read 仍不在里面。
    const liveList = () => catalog.filter(x => full || metaNames.has(x.name) || activeNames.has(x.name) || (!x.bridged && activePacks.has(x.pack)));
    const current = () => {
      const live = liveList();
      if (!freeze) return live.map(x => x.tool);
      // 冻结布局:输出 = 冻结序(仍在 catalog 的条目保位) + 本次新激活按 catalog 序追加尾部。
      const byName = new Map(catalog.map(x => [x.name, x]));
      const added = [];
      for (const x of live) {
        if (!freeze.nameSet.has(x.name)) { freeze.nameSet.add(x.name); freeze.names.push(x.name); added.push(x.name); }
      }
      const missing = freeze.names.filter(n => !byName.has(n));
      const missingKey = missing.join('');
      try {
        if (!freeze.initLogged && freeze.names.length) {
          freeze.initLogged = true;
          logEvent({ kind: 'tool_schema_freeze', state: 'init', sessionId: freezeKey, count: freeze.names.length });
        }
        if (added.length) {
          const addedBy = {};
          for (const n of added) { const r = reasonOf.get(n) || 'classifier'; addedBy[r] = (addedBy[r] || 0) + 1; }
          logEvent({ kind: 'tool_schema_freeze', state: 'append', sessionId: freezeKey, added, addedBy, count: freeze.names.length });
        }
        if (missingKey !== freeze.missingKey) {
          freeze.missingKey = missingKey;
          // catalog 缺失(MCP 离线/撤权/caps 变化)= 必然缓存断裂,按 E4 §7.2 记录原因,不为命中率保留错误授权
          if (missing.length) logEvent({ kind: 'tool_schema_freeze', state: 'cache_break', reason: 'catalog_miss', sessionId: freezeKey, missing });
        }
      } catch { /* 遥测绝不阻断 */ }
      return freeze.names.filter(n => byName.has(n)).map(n => byName.get(n).tool);
    };
    const search = (query, limit) => {
      const loadedNames = new Set(current().map(t => t.function && t.function.name).filter(Boolean));
      const result = searchToolCatalog(catalog, { query, limit }, config, { legacyNameBoost: 3, loadedNames });
      // 21-E5 (metaToolHintsV1): 每个 Top-K 候选追加紧凑调用提示(requiredArgs/callHint/state/blockedReason)。
      // 只加字段,不改 legacy 排序、匹配、数量或 description —— 开关关时返回结构与现状逐字节一致。
      if (config && config.metaToolHintsV1 === true) {
        result.matches = (result.matches || []).map(m => {
          const item = catalog.find(c => c.name === m.name);
          return { ...m, ...buildCallHint(item, loadedNames, config, m.blockedReason) };
        });
      }
      return result;
    };
    const shadowSearch = (query, limit) => {
      const loadedNames = new Set(current().map(t => t.function && t.function.name).filter(Boolean));
      return searchToolCatalog(catalog, { query, limit }, config, { forceV1: true, legacyNameBoost: 3, loadedNames });
    };
    // reason:这次装载的来由(模型调 tool_load = 'tool_load';09 的代理自动装载 = 'proxy_promote'),只进冻结追加日志。
    const load = (args, reason) => {
      const before = new Set(current().map(t => t.function.name));
      // packs/tools 收单个字符串也认;认不出的名字记下来如实交回(修前静默忽略,回 loaded:[] 的 ok:true)。
      const asList = v => (Array.isArray(v) ? v : (typeof v === 'string' && v.trim() ? [v.trim()] : []));
      const unknown = [];
      for (const p of asList(args && args.packs)) { if (TOOL_PACK_DESCRIPTIONS[p]) activePacks.add(p); else unknown.push(String(p)); }
      for (const n of asList(args && args.tools)) { if (catalog.some(x => x.name === n)) activeNames.add(n); else unknown.push(String(n)); }
      for (const x of liveList()) if (!before.has(x.name) && !reasonOf.has(x.name)) reasonOf.set(x.name, reason || 'tool_load');
      const after = current().map(t => t.function.name);
      // 61-A4:auto 模式下桥接工具不随包装载(见 liveList 头注)。修前 tool_load({packs:['desktop']}) 回 ok:true、loaded:[],
      // 模型以为装上了。这里如实点名:包里还有哪些桥接工具没装、该怎么拿(只在模型自己调 tool_load 时给,代理自动装载不需要)。
      const bridgedLeft = {};
      if (!full && reason !== 'proxy_promote') {
        for (const p of asList(args && args.packs)) {
          if (!TOOL_PACK_DESCRIPTIONS[p]) continue;
          const names = catalog.filter(x => x.bridged && x.pack === p && !activeNames.has(x.name)).map(x => x.name);
          if (names.length) bridgedLeft[p] = names.slice(0, 12).concat(names.length > 12 ? [`…(+${names.length - 12})`] : []);
        }
      }
      const hasBridgedLeft = Object.keys(bridgedLeft).length > 0;
      const hints = [];
      if (unknown.length) hints.push('这些 pack/工具名不存在;用 list_tools 看可用的 pack,或 tool_search 按用途找工具名');
      if (hasBridgedLeft) hints.push('桥接(桌面/MCP)工具不随包装载:要用时 tool_load {tools:[精确名]},或直接 tool_invoke_<tier> {name, arguments} 代叫');
      return { ok: true, loaded: after.filter(n => !before.has(n)), activePacks: [...activePacks], toolCount: after.length,
        ...(unknown.length ? { unknown } : {}), ...(hasBridgedLeft ? { bridgedNotLoaded: bridgedLeft } : {}),
        ...(hints.length ? { hint: hints.join(';') } : {}) };
    };
    const list = args => listCompactTools(catalog, args);
    // 冻结表的当前内容(按序),09 写回 session.toolSchemaNames 供重启后恢复;没开冻结时为 null。
    const frozenNames = () => (freeze ? freeze.names.slice(0, TOOL_SCHEMA_NAMES_MAX) : null);
    return { catalog, activePacks, current, list, search, shadowSearch, load, frozenNames, fullCount: catalog.length };
  }

  return createToolLoadingState;
}

module.exports = {
  NATIVE_TOOL_PACKS, toolPackForName, classifyToolPacks, buildToolCatalog, searchToolCatalog,
  compareToolRetrievalShadow, listCompactTools, toolArgsSkeleton, createToolLoader,
};
