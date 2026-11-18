'use strict';
const { BRIDGED_WRITE_PATH_ARGS } = require('./bridged-write-targets.cjs');
const { unprefixedBridgedName } = require('./turn-effect-kinds.cjs');

// ===================================================================================================
// v1.2-B (本切片灵魂): 机制性防漏 —— 把「新增桥接写族工具时逐个补 BRIDGED_WRITE_PATH_ARGS」从人肉纪律
// 升级成【离线回归可断言】的机制。前科:ACC v1.6 四个 Office 写族上线时漏进快照表,用户真机撞出「PPT/Excel
// 不能撤销」。此后每补一个是被动的;auditBridgedWriteCoverage 让「漏表」在 e2e 里直接变红。
//
// 判定:一个 bridged 工具的【裸名】命中「写语义命名模式」(见下)却不在 BRIDGED_WRITE_PATH_ARGS 里 → 判为
//   uncovered(疑似漏进快照表)。命名模式覆盖大厂/社区 MCP 的常见写族命名法:
//     ^(write_|save_|export_|create_)  —— 产出/覆盖文件
//     ^(delete_|remove_)               —— 删除文件
//     ^(move_|copy_|rename_)           —— 移动/复制/改名
//   名字命中但【逻辑上不动文件系统】的工具(如 create_session / create_task)由显式豁免表放行 —— 每条都要
//   写清为什么豁免,豁免是「我看过、确认它不写用户文件」的证据,不是「懒得补表」的地毯。
// ⚠️ 局限(诚实):这是【命名启发式】,只能抓「名字看着像写族却漏表」的。像 excel_beautify / chart_image /
//   window_screenshot 这类【真写文件但名字不含写族前缀】的,命名模式抓不到 —— 它们靠 B1 人工盘点入表(已入),
//   审计函数对它们无能为力(不在 uncovered 里也不在豁免表里,因为名字压根不匹配)。所以本函数是「防回潮网」,
//   不是「盘点器」:它保证【叫 write_*/save_*/… 的新工具】不会静默漏表,人工盘点保证【命名不规范的写族】入表。
const BRIDGED_WRITE_NAME_PATTERN = /^(write_|save_|export_|create_|delete_|remove_|move_|copy_|rename_)/;
// 写语义命名模式命中、但【逻辑上不动用户文件系统】故不需要进快照表的桥接工具裸名。每条注释=豁免理由。
// 这张表是审计的「白名单例外」:auditBridgedWriteCoverage 命中命名模式但在此表里的,不算 uncovered。
// 维护纪律:往这里加名字前必须确认该工具【真的不写用户磁盘文件】(读源码,别信名字);写清一句话理由。
const BRIDGED_WRITE_AUDIT_EXEMPT = new Set([
  // —— ACC v1.6(93 工具)现状:命中命名模式但不动用户文件系统的,逐条豁免 ——
  // move_window:命中 ^move_ 但它是【把窗口挪到屏幕新位置】(window.py: move_window(x,y,title,handle)),
  //   零文件 I/O。命名启发式的典型误报 —— 审计报了、人核实了、显式豁免。这正是豁免表存在的意义(不是地毯,
  //   是「我读过源码确认不写文件」的证据)。ACC 里目前唯一的这类误报。
  'move_window',
  // 下面几条是「防未来」的通用逻辑性名字豁免,以及对社区 drop-in MCP 常见命名法的预置豁免,避免把
  // create_session / create_window 之类误判成漏表(它们即便某天出现在某个 MCP 里,也不动用户文件)。
  'create_session',   // 逻辑会话对象(内存/DB),不落用户文件
  'create_task',      // 任务对象,不动文件系统
  'create_context',   // 浏览器/自动化上下文,不落盘
  'create_window',    // 开窗口(UI),不写文件
  'create_directory', // 建目录 —— 目录不是字节级可快照对象(checkpoint 存文件内容),回滚语义=删空目录,
                      //   价值低且易误删用户既有目录;明确不纳入快照(与内建 file_* 不含 mkdir 一致)。
  'save_session',     // 保存会话到 MCP 内部存储(非用户工作区文件),护栏外不快照。
  'export_macro',     // 若某 MCP 提供:宏导出到其内部数据目录(如 ACC record_stop 写 <data>/macros),
                      //   落在工作区护栏外 → journalBridgedWrite 本就跳过;此处豁免让审计不误报。
]);
// 纯函数:给一批桥接工具【裸名】,返回 { uncovered:[...] } —— 名字像写族(命中命名模式)、非豁免、却不在
// 快照表(BRIDGED_WRITE_PATH_ARGS)里的工具名列表(去重、稳定排序)。uncovered 非空 = 有写族工具漏进快照表,
// 用户将撞「该工具产出/删除的文件不能撤销」—— e2e 断言 uncovered 为空即机制性杜绝 v1.6 事故重演。
// 输入既接受裸名(delete_file)也接受带前缀的桥接名(acc__delete_file),内部统一去前缀。无 I/O、可离线直测。
function auditBridgedWriteCoverage(toolNames) {
  const uncovered = new Set();
  for (const name of (Array.isArray(toolNames) ? toolNames : [])) {
    const bare = unprefixedBridgedName(name);
    if (!bare) continue;
    if (!BRIDGED_WRITE_NAME_PATTERN.test(bare)) continue;               // 名字不像写族 → 审计不管
    if (BRIDGED_WRITE_AUDIT_EXEMPT.has(bare)) continue;                 // 显式豁免(逻辑性名字/护栏外)
    if (Object.prototype.hasOwnProperty.call(BRIDGED_WRITE_PATH_ARGS, bare)) continue; // 已在快照表 → 覆盖到了
    uncovered.add(bare);                                                // 像写族、没豁免、没进表 → 疑似漏
  }
  return { uncovered: [...uncovered].sort() };
}
// v1.2 提示词三层防御·工具层缝隙收口:script_run 已有 Office 软闸,但模型仍可绕道 ACC 的
// run_command/execute_command 用 `python -c "...openpyxl...xxx.xlsx..."` 内联手写 Office(实测续聊惯性
// 场景确实这么干过)。同一启发式在 bridged 分发点(callTool 之前)再设一道同款软闸;force:true 泄压。
// 纯函数,导出供 e2e 单测;返回拒绝对象或 null(放行)。
const BRIDGED_SCRIPT_TOOLS = new Set(['run_command', 'execute_command', 'shell', 'powershell']);
// v1.4.1 (audit #6/#7):Office 手写检测的库/写法特征。旧版只认 pip 库 import,漏了【离线运行时里也捆绑的】
// win32com/comtypes COM 自动化(Dispatch/CreateObject Excel|Word|PowerPoint + .SaveAs)、importlib 动态导入
// 绕过、matplotlib savefig —— 模型可借此绕过软闸手写不可撤销 Office。此处集中强化,两道软闸共用。
const OFFICE_WRITER_LIB_RE = /(openpyxl|xlsxwriter|python-docx|from\s+docx|import\s+docx|python-pptx|from\s+pptx|import\s+pptx|reportlab|win32com|comtypes|Dispatch\s*\(\s*['"](?:Excel|Word|PowerPoint)|CreateObject\s*\(\s*['"](?:Excel|Word|PowerPoint)|GetActiveObject\s*\(\s*['"](?:Excel|Word|PowerPoint)|\.SaveAs\b|importlib\.import_module\s*\(\s*['"](?:openpyxl|docx|pptx|xlsxwriter|reportlab)|\.savefig\s*\(|matplotlib)/i;
function bridgedOfficeScriptGate(bridgedName, args) {
  const bare = unprefixedBridgedName(bridgedName);
  if (!BRIDGED_SCRIPT_TOOLS.has(bare)) return null;
  if (args && args.force === true) return null;
  const cmd = String((args && (args.command || args.cmd || args.code)) || '');
  const officeLib = OFFICE_WRITER_LIB_RE.test(cmd);
  const officeFile = /\.(xlsx|xlsm|docx|pptx|pdf)\b/i.test(cmd);
  if (officeLib && officeFile) {
    return {
      ok: false,
      error: '检测到终端命令在手写 Office 文件。请改用现成工具:Excel = write_excel → excel_beautify →(需图表)excel_chart;PPT = write_pptx;Word = write_document;PDF = write_pdf——统一模板、可一键撤销。若现成工具确实覆盖不了(特殊格式需求),重新调用并加参数 force:true,同时向用户说明该产出不可自动撤销。',
      hint: 'Office 产出规程(工具层强制,v1.2)',
    };
  }
  return null;
}

module.exports = { auditBridgedWriteCoverage, OFFICE_WRITER_LIB_RE, bridgedOfficeScriptGate };
