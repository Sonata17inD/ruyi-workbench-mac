'use strict';

const { MCP_TOOLS } = require('./native-tool-schemas.cjs');
const { BRIDGED_WRITE_PATH_ARGS } = require('./bridged-write-targets.cjs');
const { bridgedToolDisabledByPolicy } = require('./tool-access-policy.cjs');

// v1.4.1: 桥接工具带 `<serverId>__` 前缀(如 ai_computer_control__excel_read)。部分 provider 模型(实测 qwen)
// 会【丢掉前缀】直接调裸名 `excel_read` → 命不中 bridgedRoute → 落到内建兜底报「Unknown tool: excel_read」。
// 宽容解析:①精确前缀名优先;②内建工具名绝不被桥接遮蔽(返回 null 走内建路径);③裸名在所有桥接工具里
// 【唯一】命中某 toolName 时路由过去(≥2 个同名歧义则不猜、返回 null)。纯加法:精确前缀路径行为不变。
let _nativeToolNameSet = null;
function isNativeToolName(name) {
  if (!_nativeToolNameSet) { try { _nativeToolNameSet = new Set(MCP_TOOLS.map(t => t && t.name)); } catch { _nativeToolNameSet = new Set(); } }
  return _nativeToolNameSet.has(name);
}
function resolveBridge(bridgedRoute, name) {
  if (!name || !bridgedRoute) return null;
  const valid = value => value && typeof value === 'object' && Object.hasOwn(value, 'serverId') && typeof value.serverId === 'string' && value.serverId.length > 0 && Object.hasOwn(value, 'toolName') && typeof value.toolName === 'string' && value.toolName.length > 0;
  if (Object.hasOwn(bridgedRoute, name) && valid(bridgedRoute[name])) return bridgedRoute[name]; // ① 精确前缀名
  if (isNativeToolName(name)) return null;                 // ② 内建优先,不被桥接遮蔽
  let hit = null, count = 0;                               // ③ 裸名唯一命中桥接工具 → 容错路由
  for (const k of Object.keys(bridgedRoute)) {
    const r = bridgedRoute[k];
    if (valid(r) && r.toolName === name) { hit = r; if (++count > 1) return null; }
  }
  return count === 1 ? hit : null;
}

// v0.8-S0: risk tiers for BRIDGED (external/desktop MCP) tools, keyed by the UNPREFIXED tool name
// (the bridged name is `serverId__tool`; look up bridge.toolName). Replaces the old flat 'exec' so ACC's
// read-only family (screenshot/OCR/find/inspect/diagnostics/waits/reads) doesn't prompt in 'default' mode.
// Exact-name set below; a few prefix rules follow it. Anything unmatched defaults to 'exec'.
const BRIDGED_READ_TOOLS = new Set([
  'screenshot', 'screenshot_region', 'screenshot_full', 'window_screenshot',
  'ocr_image', 'ocr_screen',
  // 审计 P1: 'ocr_find_text' 有意【不在】read 级 —— 它带 click 参数(click=True 即 pyautogui.click 物理点击,见
  // ocr.py:227/253),被判 read 后 read 子代理可无人值守点击桌面,且 nativeToolGate 对 read 无条件 allow(任何模式
  // 不弹窗)。它落回默认 'exec':read/edit 子代理拿不到,非 bypass 模式点击前弹窗。纯只读文本定位仍可用 ocr_screen/
  // ocr_image(返回全部词+坐标)或 find_on_screen/find_template(模板匹配,无 click、均无 audit → 仍是 read)。
  'find_template', 'find_all_templates', 'find_on_screen',
  'ui_inspect', 'ui_find', 'diagnostics', 'version_info', 'safety_info', 'audit_tail', 'execution_receipt',
  'read_file', 'file_info', 'clipboard_get', 'clipboard_read', 'get_clipboard',
  // 审计 A10:ACC 里其余【纯读、不点不敲不写】的工具(逐个对过 tools/*.py 的签名)。修前它们落到默认 exec,default 模式下
  // 每次调用都弹窗 —— 而 screenshot 不弹,推荐的「一步感知」observe(截图+UIA+OCR)反而每次弹。
  //   · observe(不动桌面;act_and_verify 会动 → 仍 exec);
  //   · 读文档族 read_document / excel_read / pdf_read_pages / image_info —— 路径读闸另有 BRIDGED_READ_PATH_ARGS
  //     (03-bridge-guard,三个分发点同一个函数),工作区外/数据目录照拒;
  //   · 浏览器只读族(状态/标签/文本/元素/截图;打开、点击、输入、执行 JS、导航仍 exec);
  //   · 记忆只读 memory_read / memory_list(save/delete 仍 exec)、macro_list、ocr_available_languages、
  //     wait(纯休眠)、sequential_thinking(只在进程内记推理链)。
  // 【刻意不进】ocr_find_text(click 参数会物理点击;且 tool_invoke_* 的档校验要求目录档=入参档,按入参降档会让代理路径自相矛盾)、
  // get_environment_variable(BRIDGED_NOT_READ 钉着)、beep/play_sound(出声)、fetch(联网)。
  'observe', 'read_document', 'excel_read', 'pdf_read_pages', 'image_info',
  'browser_backend_status', 'browser_list_tabs', 'browser_get_text', 'browser_get_elements', 'browser_screenshot',
  'memory_read', 'memory_list', 'macro_list', 'ocr_available_languages', 'wait', 'sequential_thinking',
]);
// Prefix rules for read-only families that share a common verb (e.g. get_windows, list_processes,
// wait_for_window_idle). Kept narrow so an 'exec'-shaped verb can't sneak in under a broad prefix.
const BRIDGED_READ_PREFIXES = ['get_', 'list_', 'wait_for_'];
// 安全修复(审计 A②):前缀规则会把「读出秘密」的工具也收进 read 档(任何模式都零弹窗放行)。
// get_environment_variable 能读出宿主进程环境里的任何值(令牌、密钥、代理口令)—— 它不是「看一眼桌面」,
// 按未知工具的缺省口径落回 exec(非 bypass/auto 模式下先问人)。
const BRIDGED_NOT_READ = new Set(['get_environment_variable']);
// 安全修复(审计 A③):同一个工具按入参有两副面孔 —— get_clipboard_image / window_screenshot 不带落盘参数时
// 只回图,带了就往任意路径写文件(allow_protected:true 还会绕过 ACC 自己的系统目录护栏)。它们的写路径
// 参数本来就登记在 BRIDGED_WRITE_PATH_ARGS(检查点要用),这里复用同一张表:给了写路径参数的这一次调用,
// 档位至少是 edit;再带 allow_protected:true 就是 exec。只抬不降,用户覆盖表也压不下这道地板。
// args 缺省(目录/清单等不看入参的调用方)= 修前口径。args 可以是对象或 JSON 字符串。
function bridgedCallTierFloor(unprefixedName, args) {
  let a = args;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = null; } }
  if (!a || typeof a !== 'object' || Array.isArray(a)) return '';
  const spec = Object.prototype.hasOwnProperty.call(BRIDGED_WRITE_PATH_ARGS, unprefixedName) ? BRIDGED_WRITE_PATH_ARGS[unprefixedName] : null;
  if (!spec) return '';
  const fields = Array.isArray(spec.multi) ? spec.multi : [spec];
  const writes = fields.some(f => typeof a[f.field] === 'string' && a[f.field].trim());
  if (!writes) return '';
  return a.allow_protected === true ? 'exec' : 'edit';
}
// Resolve a bridged tool's tier: user override (config.bridgedToolTiers) wins, then the built-in table,
// then default 'exec'. `unprefixedName` is bridge.toolName (never the serverId__tool form).
// 第三参 args(可选):按本次调用的入参抬档(见 bridgedCallTierFloor)。
function bridgedToolTier(unprefixedName, config, args) {
  const base = bridgedToolTierByName(unprefixedName, config);
  const floor = args === undefined ? '' : bridgedCallTierFloor(unprefixedName, args);
  const rank = { read: 0, edit: 1, exec: 2 };
  return floor && rank[floor] > rank[base] ? floor : base;
}
function bridgedToolTierByName(unprefixedName, config) {
  const overrides = (config && config.bridgedToolTiers && typeof config.bridgedToolTiers === 'object') ? config.bridgedToolTiers : {};
  const ov = overrides[unprefixedName];
  if (ov === 'read' || ov === 'edit' || ov === 'exec') return ov;
  if (BRIDGED_NOT_READ.has(unprefixedName)) return 'exec';
  if (BRIDGED_READ_TOOLS.has(unprefixedName)) return 'read';
  if (BRIDGED_READ_PREFIXES.some(p => unprefixedName.startsWith(p))) return 'read';
  return 'exec';
}

// offer 面:从 [openai fn schema] 里去掉被设置关掉的【桥接】工具(原生工具由 buildOpenAiTools 自己滤)。route 不动 ——
// 分发面要靠它认出「这是被关掉的 ACC 工具」,回 tool-disabled 而不是 unknown-tool。
function dropPolicyDisabledBridgedTools(tools, bridgedRoute, config, desktopOverride = null) {
  return (Array.isArray(tools) ? tools : []).filter(t => {
    const name = t && t.function && t.function.name;
    const bridge = name ? resolveBridge(bridgedRoute || {}, name) : null;
    return !bridge || !bridgedToolDisabledByPolicy(bridge, config, desktopOverride);
  });
}

module.exports = { resolveBridge, bridgedToolTier, dropPolicyDisabledBridgedTools };
