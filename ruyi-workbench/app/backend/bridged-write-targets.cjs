'use strict';

const path = require('node:path');
const { unprefixedBridgedName, unwrapToolInvokeCall, isBridgedWriteTool, ARTIFACT_OUTPUT_PATH_KEYS } = require('./turn-effect-kinds.cjs');

// v1.5-W1.5 (T3): bridged 写族工具的路径提取表 —— 裸工具名 → args 里的目标路径字段名。ACC 的
// write_document/write_excel/write_pdf 入参都叫 `path`(见 document.py 函数签名);delete 类走 op:delete。
// 表里没有的 bridged 工具不快照(collectBridgedWriteTargets 返回 []),工具照常执行。
//
// v1.2-B:两种条目形状 ——
//   (1) 单目标:{ field:'<argName>', op:'write'|'delete' } —— 一条快照(绝大多数写族)。
//   (2) 多目标:{ multi: [{ field, op }, ...] } —— 一次工具调用动多个文件,逐条独立快照。
//       move_file 是典型:源存在→op:'delete'(回滚=写回原处),目的地→op:'write'(存在→modify,否则 create,
//       回滚=删除)。回滚整回合时 journalRollback 按 entrySeq 逆序展开:后写的 dest 先撤(删掉新文件),
//       再撤 src(把源写回原处)—— 净效果=文件回到移动前的位置与内容。任一目标快照失败静默跳过,不阻断工具、
//       不阻断其它目标(与单目标同一安全网纪律)。
//   ⚠️ 参数名以 ACC 源码实际签名为准(不是本能猜测):filesystem.move_file/copy_file 的入参是
//      `source` / `destination`,不是 src/dest;window_screenshot 是 output_path;get_clipboard_image 是 save_path。
const BRIDGED_WRITE_PATH_ARGS = {
  write_document: { field: 'path', op: 'write' },
  write_docx: { field: 'path', op: 'write' },
  write_excel: { field: 'path', op: 'write' },
  write_pdf: { field: 'path', op: 'write' },
  write_file: { field: 'path', op: 'write' },
  // v1.1 返修(用户真机撞出):ACC v1.6 四个 Office 工具上线时漏进此表 → write_pptx/excel_beautify 全程
  // 零快照,用户「生成的 Excel 和 PPT 不能撤销」。教训:新增 bridged 写族工具时,此表 + toolIsRevertible
  // 徽章是【发布检查项】,不是可选项。四个入参均为 `path`(office_pptx/office_excel/office_chart 签名核对)。
  write_pptx: { field: 'path', op: 'write' },
  excel_beautify: { field: 'path', op: 'write' },
  excel_chart: { field: 'path', op: 'write' },
  chart_image: { field: 'path', op: 'write' },
  // 删除类:存 before 快照(op:delete → 回滚=写回)。ACC filesystem.delete_file 入参叫 `path`。
  delete_file: { field: 'path', op: 'delete' },
  // v1.2-B:move/copy 补齐(W1.5 明确欠账)。ACC filesystem.py 签名:move_file(source, destination)、
  //   copy_file(source, destination)。move = 源删 + 目的写(两条);copy = 只动目的地(一条 write)。
  //   注:源/目的地可能是目录(shutil.move/copytree);journalBridgedWrite 只快照普通文件(读得到字节的),
  //   目录目标读 before 失败按「无 before」处理 → 目录 move 的源侧记 delete 但无内容(回滚会 loudly fail),
  //   这是可接受的降级(整目录快照超出 checkpoint 的字节级设计,和内建 file_move 同保真度)。
  move_file: { multi: [{ field: 'source', op: 'delete' }, { field: 'destination', op: 'write' }] },
  copy_file: { field: 'destination', op: 'write' },
  // v1.2-B:截图/抓图类 —— 仅当调用方显式给了落盘路径参数时才产出磁盘文件(否则回 base64,无文件可撤)。
  //   op:'create' 语义(新 png),快照价值=可回滚删除。参数名:window_screenshot=output_path、
  //   get_clipboard_image=save_path(capture.py / desktop_extra.py 签名核对)。缺参→collectBridgedWriteTargets
  //   返回 [](不快照)。这些路径由调用方给,可能落在工作区内;落在护栏外则 journalBridgedWrite 自然跳过。
  window_screenshot: { field: 'output_path', op: 'write' },
  get_clipboard_image: { field: 'save_path', op: 'write' },
  // ACC v1.8:image_resize —— 真写文件 (缩放后落 output_path),但名字不含写族前缀 (^write_/save_/…),
  //   与 excel_beautify/chart_image 同类:命名审计抓不到,靠 B1 人工盘点入表。参数名 output_path
  //   (image_tools.py: image_resize(path, output_path, …) 签名核对)。落盘可能在工作区内 → 快照可撤;
  //   护栏外 (image_resize 自带 protected_path 护栏兜底) → journalBridgedWrite 自然跳过。
  image_resize: { field: 'output_path', op: 'write' },
  // 第49波(49a):ACC v1.9 edit_file —— in-place 精确替换(path 指向既有文件),op:write 快照 before
  //   → 回滚=写回原内容(与整文件 write_file 同保真度)。入表即获得检查点+撤销能力(03 方案 P0 联动要求)。
  edit_file: { field: 'path', op: 'write' },
};
// 从 bridged 工具名 + args 解析出「该工具将要动的所有目标文件」。返回 [{path, mode}, ...](可能空数组)。
// mode ∈ 'write'|'delete'。纯字符串/查表逻辑,无 I/O。每个目标:path 缺失/非字符串/非绝对路径 → 跳过该目标
// (不快照,不阻断);单目标条目产出 0 或 1 条,多目标条目逐字段产出(move 最多 2 条)。
function collectBridgedWriteTargets(bridgedName, args) {
  const bare = unprefixedBridgedName(bridgedName);
  const spec = BRIDGED_WRITE_PATH_ARGS[bare];
  if (!spec) return [];
  const fields = Array.isArray(spec.multi) ? spec.multi : [spec];
  const out = [];
  for (const f of fields) {
    const raw = args && typeof args === 'object' ? args[f.field] : null;
    if (typeof raw !== 'string' || !raw.trim()) continue; // 该字段缺省(如可选 output_path)→ 跳过
    if (!path.isAbsolute(raw)) continue;                   // 相对路径 → 不快照(护栏也只认绝对路径)
    out.push({ path: raw, mode: f.op });
  }
  return out;
}
// v1.4.1 (audit #9):某桥接【写族】工具带【相对路径】写目标时返回该字段名(否则 null)。工作台无法可靠知道 ACC
// 对相对路径的解析基准(ACC 子进程 cwd ≠ 会话工作区)——既不能正确快照也不能正确回滚 → 会变成【静默不可撤销】
// 的写。分发点据此拒绝并引导改用绝对路径(绝对路径照常快照 + 可撤销)。
function bridgedWriteRelativePathArg(bridgedName, args) {
  const bare = unprefixedBridgedName(bridgedName);
  const spec = BRIDGED_WRITE_PATH_ARGS[bare];
  if (!spec) return null;
  const fields = Array.isArray(spec.multi) ? spec.multi : [spec];
  for (const f of fields) {
    const raw = args && typeof args === 'object' ? args[f.field] : null;
    if (typeof raw === 'string' && raw.trim() && !path.isAbsolute(raw)) return f.field;
  }
  return null;
}
// 单目标兼容层(保留原契约:返回首个目标 {path, mode} 或 null)。既有 e2e 直测此签名;多目标工具(move_file)
// 由此返回其第一条(source delete)。新代码应改用 collectBridgedWriteTargets(复数,全目标)。
function collectBridgedWriteTarget(bridgedName, args) {
  const targets = collectBridgedWriteTargets(bridgedName, args);
  return targets.length ? targets[0] : null;
}

const NATIVE_PRODUCT_TOOLS = new Set(['file_write', 'file_edit', 'file_copy', 'file_move', 'archive_zip', 'archive_unzip', 'http_download']);
function producedUserFile(call) {
  const { name, result, input } = unwrapToolInvokeCall(call);
  if (!result || result.error || result.unchanged || result.ok === false || result.success === false) return false;
  if (result.ok !== true && result.success !== true) return false;
  if (NATIVE_PRODUCT_TOOLS.has(name)) return true;
  // Some bridges return only path, which also occurs in read receipts. Require a write operation there.
  if (collectBridgedWriteTargets(name, input).some(target => target.mode === 'write')) return true;
  if (!isBridgedWriteTool(name)) return false;
  return ARTIFACT_OUTPUT_PATH_KEYS.some(key => typeof result[key] === 'string' && result[key].trim())
    || (typeof result.path === 'string' && !!result.path.trim());
}

module.exports = { producedUserFile, BRIDGED_WRITE_PATH_ARGS, collectBridgedWriteTargets, collectBridgedWriteTarget, bridgedWriteRelativePathArg };
