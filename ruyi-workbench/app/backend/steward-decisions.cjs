'use strict';
const fsp = require('node:fs/promises');
const path = require('node:path');

const STEWARD_DECISIONS_FILE = 'decisions-v1.ndjson';

function createStewardDecisions({
  stewardDir, nowIso, safeJsonParse, safeSessionId, readFileTail, repairMissionChangeTornTail, STEWARD_CONFIG_SECRET_PATTERN,
}) {
  // ── 决策日志(§3.5「所有写工具返回 undoRef,决策日志记录」)───────────────────────────────
  // 与 inbox 同款 append-only 纪律:先 repairMissionChangeTornTail 把尾部半行截干净,再整行 appendFile,
  // 全部经一条 per-process 串行链。开关关时根本走不到这里(门控壳先返回 steward.disabled)。
  const stewardDecisionsPath = () => path.join(stewardDir(), STEWARD_DECISIONS_FILE);
  let stewardDecisionChain = Promise.resolve();
  let stewardDecisionSeq = 0;
  // 116-2b:自理动作的溯源基底。13h 在【工具入参】上挂一个内部字段 stewardBasis({inboxSeq,auto,origin}),
  // 由下面两个实现并进决策日志的 basis —— 事后能分清「这一次重试是管家自理做的、由第 N 条收件箱
  // 事件触发」。它不在工具 schema 里(additionalProperties:false),模型即使编造出来也只影响日志注解,
  // 不影响任何判定;args 照旧只记摘要字段,这一坨不进 args。
  function stewardBasisOf(args, extra) {
    const raw = (args && typeof args.stewardBasis === 'object' && args.stewardBasis) ? args.stewardBasis : null;
    const base = (extra && typeof extra === 'object') ? { ...extra } : {};
    if (!raw) return base;
    if (raw.inboxSeq != null) base.inboxSeq = Number(raw.inboxSeq) || 0;
    if (raw.auto != null) base.auto = raw.auto === true;
    if (raw.origin) base.origin = String(raw.origin).slice(0, 40);
    // 「没做完就续」自理动作的理由(计划进度 / 回合没收口 / 第几次),给行动流水点开时看;只是注解,不参与任何判定。
    if (raw.reason) base.reason = String(raw.reason).slice(0, 120);
    return base;
  }

  function stewardAppendDecision(row) {
    const record = {
      seq: ++stewardDecisionSeq,
      at: nowIso(),
      tool: String((row && row.tool) || ''),
      args: (row && row.args && typeof row.args === 'object') ? row.args : {},
      targetSessionId: String((row && row.targetSessionId) || ''),
      permissionMode: String((row && row.permissionMode) || ''),
      mayAct: String((row && row.mayAct) || ''),
      undoRef: (row && row.undoRef) || null,
      basis: (row && row.basis && typeof row.basis === 'object') ? row.basis : {},
    };
    const line = JSON.stringify(record) + '\n';
    stewardDecisionChain = stewardDecisionChain.then(async () => {
      await fsp.mkdir(stewardDir(), { recursive: true });
      const file = stewardDecisionsPath();
      await repairMissionChangeTornTail(file);
      await fsp.appendFile(file, line, 'utf8');
    }).catch(() => {}); // 记账失败绝不回滚已经做完的动作(与 usage ledger 同款 fire-and-forget 纪律)
    return record;
  }

  // ── 决策日志的只读面(117e 第 0 步 · §8.6「行动流水」)────────────────────────────────────
  // 在 117e 之前决策日志【只有】工具 `steward_audit_tail` 能读 —— 也就是说,只有模型看得见管家做过
  // 什么,用户看不见。§8.6 明写「行动流水页按时间列出管家做过的每件事(依据、线程权限、undoRef、
  // 费用),支持按线程与按日期过滤」,那需要一条 HTTP 只读面。
  //
  // 纪律与 inbox 尾窗读取同源(13i stewardReadInboxText/ParseInboxText 的形状):小文件整读、大文件只读
  // 尾窗并丢首个半行、坏行整行跳过、文件不存在 = 空(绝不 mkdir —— 开关关时零持久化写入的红线)。
  const STEWARD_DECISIONS_LIMIT_DEFAULT = 50;
  const STEWARD_DECISIONS_LIMIT_MAX = 200;
  const STEWARD_DECISIONS_FULL_READ_BYTES = 8 * 1024 * 1024;
  const STEWARD_DECISIONS_TAIL_BYTES = 1024 * 1024;
  const STEWARD_DECISIONS_MASK = '••••';

  // args 里像密钥的值一律掩码。**判据复用 116-2e 的那一条**(06i 的 STEWARD_CONFIG_SECRET_PATTERN,
  // `/apiKey|token|secret|password/i`)—— 不另写第二份正则:两份正则迟早会漂移,而漂移的方向永远是
  // 「新面漏掉了旧面拦住的东西」。按【键名】判定(值本身可能是任意串,按值猜是猜不准的),对象递归,
  // 深度与宽度都有硬顶(决策日志的 args 本就只记摘要字段,超了说明写日志的地方出了别的问题)。
  function stewardMaskDecisionArgs(value, depth = 0) {
    if (depth > 4 || value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.slice(0, 50).map(item => stewardMaskDecisionArgs(item, depth + 1));
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 50)) {
      if (STEWARD_CONFIG_SECRET_PATTERN.test(key)) { out[key] = STEWARD_DECISIONS_MASK; continue; }
      out[key] = stewardMaskDecisionArgs(item, depth + 1);
    }
    return out;
  }

  async function stewardReadDecisionsText() {
    const file = stewardDecisionsPath();
    let size = -1;
    try { size = (await fsp.stat(file)).size; } catch { return { text: '', droppedHead: false }; }
    if (size <= STEWARD_DECISIONS_FULL_READ_BYTES) {
      try { return { text: await fsp.readFile(file, 'utf8'), droppedHead: false }; } catch { return { text: '', droppedHead: false }; }
    }
    // 117q-B6(30 号文 P2-10):open/alloc/read/close 收编进 01-config.js 的 readFileTail —— 本处早已按
    // bytesRead 定界(无 bug),这里只是把手写的四步换成共用原语,行为不变。
    try {
      const { buf, bytesRead } = await readFileTail(file, STEWARD_DECISIONS_TAIL_BYTES);
      return { text: buf.toString('utf8', 0, bytesRead), droppedHead: true };
    } catch { return { text: '', droppedHead: false }; }
  }

  // { limit, sessionId, since } -> { ok, rows, total, limit }
  //   · rows 按时间【倒序】(最近的在最前),这是行动流水页的自然阅读序;
  //   · since 认 ISO 时间串(比 seq 稳:seq 是 per-process 计数器,重启即从 1 重来),给了就只回
  //     `at > since` 的行;非法值当没给(不是报错 —— 只读面对坏参数一律降级为「不过滤」);
  //   · total = 尾窗内命中过滤的总行数(不是全量文件行数,尾窗外的行本来就读不到)。
  async function stewardDecisionsRead(opts) {
    const o = (opts && typeof opts === 'object') ? opts : {};
    const rawLimit = Number(o.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(STEWARD_DECISIONS_LIMIT_MAX, Math.max(1, Math.round(rawLimit)))
      : STEWARD_DECISIONS_LIMIT_DEFAULT;
    const sessionId = safeSessionId(String(o.sessionId || ''));
    const sinceRaw = String(o.since || '').trim().slice(0, 40);
    const since = sinceRaw && !Number.isNaN(Date.parse(sinceRaw)) ? sinceRaw : '';
    const { text, droppedHead } = await stewardReadDecisionsText();
    const lines = String(text || '').split('\n');
    const matched = [];
    for (let i = droppedHead ? 1 : 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const row = safeJsonParse(line, null);
      if (!row || typeof row !== 'object' || Array.isArray(row) || !row.tool) continue;  // 坏行整行跳过
      const at = String(row.at || '');
      if (sessionId && String(row.targetSessionId || '') !== sessionId) continue;
      if (since && !(at > since)) continue;
      matched.push({
        seq: Number(row.seq) || 0,
        at,
        tool: String(row.tool || ''),
        args: stewardMaskDecisionArgs((row.args && typeof row.args === 'object') ? row.args : {}),
        targetSessionId: String(row.targetSessionId || ''),
        permissionMode: String(row.permissionMode || ''),
        mayAct: String(row.mayAct || ''),
        undoRef: (row.undoRef && typeof row.undoRef === 'object') ? row.undoRef : null,
        basis: (row.basis && typeof row.basis === 'object') ? stewardMaskDecisionArgs(row.basis) : {},
        ...(row.cost != null ? { cost: Number(row.cost) || 0 } : {}),
      });
    }
    matched.reverse();
    return { ok: true, rows: matched.slice(0, limit), total: matched.length, limit };
  }

  return { stewardAppendDecision, stewardBasisOf, stewardDecisionsRead, flush: () => stewardDecisionChain };
}

module.exports = { createStewardDecisions };
