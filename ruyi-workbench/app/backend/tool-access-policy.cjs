'use strict';

// 审计 N4:allowCommandTools / allowDesktopTools 不只是「不 offer」—— 分发点也按同一判据拒绝(bypass/auto 下 gate 恒 allow,
// 光藏 schema 拦不住模型直接吐出的 script_run)。offer 面(buildOpenAiTools)与分发面(09 主循环 / 08 子代理 / 12 toolCall)共用本函数。
// 返回空串 = 放行;否则是给模型看的中文原因。desktopOverride 语义同 buildOpenAiTools(null = 跟随全局)。
const NATIVE_COMMAND_TOOL_NAMES = new Set(['shell_run', 'script_run', 'shell_start', 'shell_send', 'shell_poll', 'shell_kill', 'shell_list']);
const NATIVE_DESKTOP_TOOL_NAMES = new Set(['desktop_screenshot']);
// 桌面闸的唯一判法(原生与桥接共用):会话级覆盖 desktopOverride 非 null 时以它为准,否则跟随全局 allowDesktopTools。
function desktopToolsDisabledReason(cfg, desktopOverride) {
  const allowDesk = desktopOverride == null ? (cfg || {}).allowDesktopTools !== false : desktopOverride === true;
  if (allowDesk) return '';
  return desktopOverride === false ? 'desktopTools=false (this session)' : 'allowDesktopTools=false';
}
function nativeToolDisabledByPolicy(name, config, desktopOverride = null) {
  const cfg = config || {};
  if (NATIVE_COMMAND_TOOL_NAMES.has(name) && cfg.allowCommandTools === false) return 'allowCommandTools=false';
  if (NATIVE_DESKTOP_TOOL_NAMES.has(name)) return desktopToolsDisabledReason(cfg, desktopOverride);
  return '';
}
// 2026-10 能力总闸补上桥接面。设置页承诺「关掉之后,对应的工具在所有线程里既不提供给模型、也不会执行」,修前只兑现了上面
// 两张原生名单 —— 内置桌面 MCP(ACC:serverId 'ai-computer-control',桥接名前缀 ai_computer_control__)的 run_command /
// screenshot / mouse_click 等在两个开关都关掉之后照常提供、照常执行。下面按 ACC 的【裸工具名】补两族(逐个对过
// mcp/ai-computer-control/src/ai_computer_control/tools/*.py:平台源码注册名并集 109 件里收 56 件),【只认内置桌面 MCP】—— 外部 MCP 服务器
// 哪怕有同名工具也不受影响(它们的语义由用户接入时自己负责,工作台不替它猜)。判据收在 toolDisabledByPolicy 一个函数里,
// offer 面(09 目录 / 08 子代理 / 11 MCP 子进程目录 / 07 createToolLoadingState)与分发面(09 / 08 / 12 代理 / 13d CLI 权限桥)
// 都调它;CLI 直挂 ACC 的那一路(01 addExternalMcpServersToMap / syncMcpServersToClaude)按同一张表算出 ACC_HIDE_TOOLS 交给
// ACC 自己在注册表里摘掉。
//   命令族(随 allowCommandTools):起进程 / 跑命令 / 杀进程,与原生 shell_run / script_run / shell_* 同一类能力。
//     list_processes 只读进程表、不执行任何东西,不收。
//   桌面族(随 allowDesktopTools 与会话级 desktopTools 覆盖,判法与 NATIVE_DESKTOP_TOOL_NAMES 是同一个 desktopToolsDisabledReason):
//     按「作用于真实桌面」归类 ——
//     · screen / capture / mouse / keyboard / window / uia / vision / sync / observe / act_and_verify 全族:读屏、点屏、动键鼠、摆窗口;
//     · ocr 只收读屏的 ocr_screen / ocr_click / ocr_find_text(后者内部就是 ocr_screen);ocr_image 读的是图片文件、
//       ocr_available_languages 只列语言包,不收;
//     · desktop_extra 的像素 / 窗口等待 / 显示器与 DPI 查询;它的 get_clipboard_image / set_clipboard_image 与 clipboard
//       模块一起按剪贴板算(剪贴板是桌面会话的共享状态,原生 keyboard_send_keys 同族);
//     · record 全族:record_start 装全局键鼠钩子录下用户的真实输入;macro_list 只列宏文件,但它唯一的用途是喂给 macro_run 回放,随宏族一起关。
//     名单外的(文件、Office、浏览器自动化、提示音 / 通知弹窗、系统信息、诊断、记忆、fetch)不受影响。
//   转调器(两个开关【任一】关掉都关):batch_actions / macro_run 按步骤名转调 ACC 实时注册表里的【任意】工具(batch.py
//     _tool_map,含 run_command / launch_application)—— 只随桌面闸关,它就是命令族的后门;只随命令闸关,反过来也一样。
const DESKTOP_MCP_SERVER_ID = 'ai-computer-control';
const ACC_POLICY_TOOL_FAMILIES = Object.freeze({
  command: Object.freeze(['run_command', 'launch_application']),
  desktop: Object.freeze([
    'screenshot', 'screenshot_region', 'get_screen_info', // screen
    'window_screenshot',                                                                                       // capture
    'mouse_click', 'mouse_move', 'mouse_drag', 'mouse_scroll', 'scroll_at', 'get_mouse_position',              // mouse
    'type_text', 'press_key', 'hotkey', 'input_sequence', // keyboard
    'list_windows', 'get_active_window', 'focus_window', 'resize_window', 'move_window',                       // window
    'minimize_window', 'maximize_window', 'close_window', 'ui_inspect', 'ui_find', 'ui_invoke',                                                                      // uia
    'find_template', 'find_all_templates', 'vision_click', 'wait_for_image',                                   // vision
    'ocr_screen', 'ocr_click', 'ocr_find_text',                                                                // ocr(只收读屏的)
    // sync
    'list_monitors', 'get_dpi_info',             // desktop_extra
    'observe', 'act_and_verify',                                                                               // observe / act_and_verify
    'record_start', 'record_stop', 'macro_list',                                                               // record
    'get_clipboard', 'set_clipboard', 'get_clipboard_image', 'set_clipboard_image',                            // clipboard
  ]),
  dispatcher: Object.freeze(['batch_actions', 'macro_run']),
});
const ACC_COMMAND_TOOL_NAMES = new Set(ACC_POLICY_TOOL_FAMILIES.command);
const ACC_DESKTOP_TOOL_NAMES = new Set(ACC_POLICY_TOOL_FAMILIES.desktop);
const ACC_DISPATCHER_TOOL_NAMES = new Set(ACC_POLICY_TOOL_FAMILIES.dispatcher);
// bridge = resolveBridge 的结果 { serverId, toolName }(toolName 是裸名)。不是内置桌面 MCP 的一律放行。
function bridgedToolDisabledByPolicy(bridge, config, desktopOverride = null) {
  if (!bridge || bridge.serverId !== DESKTOP_MCP_SERVER_ID) return '';
  const cfg = config || {};
  const bare = String(bridge.toolName || '');
  const commandOff = cfg.allowCommandTools === false;
  if (ACC_COMMAND_TOOL_NAMES.has(bare)) return commandOff ? 'allowCommandTools=false' : '';
  if (ACC_DESKTOP_TOOL_NAMES.has(bare)) return desktopToolsDisabledReason(cfg, desktopOverride);
  if (ACC_DISPATCHER_TOOL_NAMES.has(bare)) return desktopToolsDisabledReason(cfg, desktopOverride) || (commandOff ? 'allowCommandTools=false' : '');
  return '';
}
// 唯一入口:bridge 为空 = 原生工具(按名字判),否则按桥接目标判。返回空串 = 放行,否则是原因(给 toolDisabledResult)。
function toolDisabledByPolicy(name, config, desktopOverride = null, bridge = null) {
  return bridge ? bridgedToolDisabledByPolicy(bridge, config, desktopOverride) : nativeToolDisabledByPolicy(name, config, desktopOverride);
}
// 这份配置(+ 会话覆盖)下内置桌面 MCP 里被关掉的裸工具名(升序)—— 交给 ACC 的 ACC_HIDE_TOOLS 在注册表里摘掉(CLI 直挂面)。
function accPolicyHiddenToolNames(config, desktopOverride = null) {
  const names = [...ACC_POLICY_TOOL_FAMILIES.command, ...ACC_POLICY_TOOL_FAMILIES.desktop, ...ACC_POLICY_TOOL_FAMILIES.dispatcher];
  return names.filter(n => bridgedToolDisabledByPolicy({ serverId: DESKTOP_MCP_SERVER_ID, toolName: n }, config, desktopOverride)).sort();
}
const TOOL_PACK_DESCRIPTIONS = Object.freeze({
  core: 'planning, user questions, Workbench Memory, mission metadata and tool discovery',
  files_read: 'read, list, search and inspect workspace files',
  files_write: 'write, edit, delete, copy and move files',
  code: 'project inspection, code review and git operations',
  shell: 'Bash, Python/Node scripts and persistent shell sessions',
  web: 'web search, fetch, HTTP requests and downloads',
  desktop: 'screenshots, UI inspection and desktop control',
  office: 'Excel, Word, PowerPoint and PDF document operations',
  archive: 'zip and unzip archives',
  agents: 'sub-agents and workflow orchestration',
  skills: 'list installed skills and Playbooks, read enabled skill instructions and Playbook steps',
  integrations: 'inspect and configure MCP connectors and browser targets',
  memory: 'Workbench Memory maintenance: propose relations between memories, revise a confirmed memory, revoke a relation (plus external memory_save/read/list/delete)',
  thinking: 'step-by-step reasoning chains and sequential thinking',
  // 116c: 管家专属包。只对 kind==='steward' 的会话 offer(四个 offer 面各自门控),普通会话永不进入。
  steward: 'workbench steward: observe threads, delegate work, decide pending items and keep steward memory',
});
module.exports = { NATIVE_COMMAND_TOOL_NAMES, NATIVE_DESKTOP_TOOL_NAMES, DESKTOP_MCP_SERVER_ID, ACC_POLICY_TOOL_FAMILIES, nativeToolDisabledByPolicy, bridgedToolDisabledByPolicy, toolDisabledByPolicy, accPolicyHiddenToolNames, TOOL_PACK_DESCRIPTIONS };
