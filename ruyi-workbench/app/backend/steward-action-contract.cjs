'use strict';

function createStewardActionContract({ limits, labels, tools }) {
  const {
    STEWARD_ACTIONS_MAX, STEWARD_ACTION_HOOKS, STEWARD_ACTS_MAX, STEWARD_ACT_CONFIRM_LABEL_MAX,
    STEWARD_ACT_CONFIRM_VALUE_CHARS, STEWARD_ACT_LABEL_MAX, STEWARD_SAY_CEILING, STEWARD_WHY_MAX,
  } = limits;
  const { STEWARD_DECIDE_LABELS, STEWARD_RUN_ACTION_LABELS, STEWARD_TOOL_LABELS } = labels;
  const {
    isStewardToolName, jsonSchemaObjectProblems, logEvent, nativeToolSchema, normalizeSchedulerTask,
    parseStructuredAgentOutput, redact, safeSessionId, stewardActConfirmSpec, stewardSanitizeText,
    stewardTrimSayAtSentence,
  } = tools;

  // 输出契约解析(§11.3 116f 行)。复用 08 的 json-repair(parseStructuredAgentOutput:多候选 + 两级
  // 解析,合法 JSON 永远走原文 parse 分支)。解析失败不是错误:say 取原文、acts/actions 空、记一条
  // logEvent —— 模型没按契约说话时,把它的话原样端给用户,好过丢掉。
  // ────────────────────────────────────────────────────────────────────────────
  // 107-S1 ④(46 号文 §5 ⑦b H1):confirm 族的值渲染。两道掩码,一个都不能少:
  //   ① tier === 'forbidden' 的键(06i 那道 apiKey|token|secret|password 兜底正则命中的全在内)
  //      连值都不渲染,直接出 `••••` —— 这一族的值恒被 steward_config_set 整份拒绝,把它打在按钮上
  //      没有任何收益,却多一处明文下发面;
  //   ② 其余值过一次 04 的 redact(与 B1 立的「命令原文先 redact」同一张表、同一个单点),再裁 40 字。
  // 【永不把密钥写进标签】:标签会进对话流 DOM、行动流水与落盘回执三处,那是三份长期留存的明文面。
  const STEWARD_ACT_CONFIRM_MASK = '••••';
  function stewardActConfirmValueText(item) {
    if (item && item.tier === 'forbidden') return STEWARD_ACT_CONFIRM_MASK;
    const value = item ? item.value : undefined;
    let text;
    if (value === undefined) text = '(没给值)';
    else if (typeof value === 'string') text = value;
    else { try { text = JSON.stringify(value); } catch { text = String(value); } }
    const shown = redact(stewardSanitizeText(text)).slice(0, STEWARD_ACT_CONFIRM_VALUE_CHARS).trim();
    return shown || '(空)';
  }
  // 确认面板逐条要显示的纯文本行(前端只负责 textContent,不拼字、不解析)。
  function stewardActConfirmLines(spec) {
    const items = (spec && Array.isArray(spec.items)) ? spec.items : [];
    return items.map(item => `${stewardSanitizeText(item && item.key)} = ${stewardActConfirmValueText(item)}`);
  }
  function stewardActLabel(tool, args) {
    const a = (args && typeof args === 'object') ? args : {};
    if (tool === 'steward_decide') {
      const action = String(a.action || '');
      return (STEWARD_DECIDE_LABELS[action] || action || '决定').slice(0, STEWARD_ACT_LABEL_MAX);
    }
    if (tool === 'steward_run_action') {
      const action = String(a.action || '');
      return (STEWARD_RUN_ACTION_LABELS[action] || action || '执行').slice(0, STEWARD_ACT_LABEL_MAX);
    }
    // 117z-E2b 提交①(27 号文 §11.21.7 债 ①):线程权限也按 args 给人话 —— 与 decide / run_action 同一条
    // 理由(按【动作】不按工具名,且降级成按钮与行动流水用的是同一个函数,一处口径)。会降级成按钮的
    // 只有 capabilities.desktop === true 那一支(13k 恒 propose_required),按钮上写用户要做的那件事:
    // 「给它开桌面」;其余(收紧档位 / 关桌面)不出按钮,回落到 STEWARD_TOOL_LABELS 的总称「改线程权限」。
    if (tool === 'steward_thread_permission') {
      const permCaps = (a.capabilities && typeof a.capabilities === 'object' && !Array.isArray(a.capabilities)) ? a.capabilities : null;
      // 这一支本来就是服务端按 args 派生的、且已经写清了用户要做的那件事,107-S1 ④ 一个字不改
      // (steward-guardrails Q2c/Q2d 逐字钉着它);它要补的只是确认清单,见 stewardNormalizeAct。
      if (permCaps && permCaps.desktop === true) return '给它开桌面'.slice(0, STEWARD_ACT_LABEL_MAX);
    }
    // 107-S1 ④:改设置 / 改技能这两支的标签必须写清【要改哪个键、改成什么】——「改设置」三个字
    // 谁也看不出按下去会注册一个任意 stdio MCP 命令。键与值由 06i 的 stewardActConfirmSpec 从
    // args 派生(config_set 的判据就是那张 confirm 分档表),不读模型写的任何一个字。
    {
      const confirmSpec = stewardActConfirmSpec(tool, args);
      if (confirmSpec && (tool === 'steward_config_set' || tool === 'steward_skill_toggle')) {
        const base = STEWARD_TOOL_LABELS[tool] || '去做';
        const first = confirmSpec.items.find(item => item.key === confirmSpec.keys[0]) || confirmSpec.items[0] || null;
        const more = confirmSpec.items.length > 1 ? ` 等 ${confirmSpec.items.length} 项` : '';
        if (first) return `${base}:${stewardSanitizeText(first.key)}=${stewardActConfirmValueText(first)}${more}`.slice(0, STEWARD_ACT_CONFIRM_LABEL_MAX);
      }
    }
    return (STEWARD_TOOL_LABELS[tool] || '去做').slice(0, STEWARD_ACT_LABEL_MAX);
  }

  function stewardNormalizeAct(raw) {
    if (!raw || typeof raw !== 'object') return null;
    // Setup navigation comes only from a successful production prepare receipt, never model JSON.
    if (raw.kind === 'external_bot_setup') return null;
    const tool = String(raw.tool || '');
    const kindRaw = String(raw.kind || '');
    const kind = (kindRaw === 'tool' || kindRaw === 'open_thread' || kindRaw === 'dismiss')
      ? kindRaw
      : (tool ? 'tool' : 'dismiss');
    if (kind === 'tool' && !isStewardToolName(tool)) return null;  // 只认 steward_*(动世界的工具永远进不来)
    // 129k(用户 2026-09-20 报「管家给的按钮按下去说这个工具不能被按钮触发」):**不画按不动的按钮**。
    // 修前这里只问「是不是 steward_ 开头」,不问「它能不能作为 act 执行」。而按钮按下去走
    // POST /api/steward/act -> stewardRunAct,那里按 STEWARD_ACTION_HOOKS 查实现,查不到就
    // `not_allowed: xxx 不能作为 act 执行` —— 于是模型随手把一个【只读】工具(threads_search、
    // schedule_list、三张清单…)提成按钮,用户按下去只看到一句内部话。acts 这一路此前【不经】那张表
    // 过滤,13m 的表头注释早就写明了这个后果("不进表就是同一种「按了报错」"),只是一直没人在
    // 产出侧堵上。堵在这里 = 一处治本:不论模型怎么写、也不论以后谁新增工具,按不动的按钮画不出来。
    //
    // 为什么是【丢掉】而不是放开执行:只读工具当按钮本来就没有归宿 —— act 的回执是一行「做完了」,
    // 没有地方显示一份清单;用户要的那个答案,模型应当在这一回合里直接调工具拿到、写进话里。
    // 与本文件既有的那条纪律同源(13p 的永久豁免支:「宁可少一个按钮,也不画一个按下去必被拒的」)。
    // 记一条审计:这件事修前在界面上是静默失败,现在至少数得出来模型多久犯一次。
    if (kind === 'tool' && !STEWARD_ACTION_HOOKS[tool]) {
      logEvent({ kind: 'steward_act_undeliverable', tool: stewardSanitizeText(tool).slice(0, 64) });
      return null;
    }
    // Buttons carry executable arguments, using the same schema as tool calls.
    const args = (raw.args && typeof raw.args === 'object' && !Array.isArray(raw.args)) ? raw.args : {};
    if (kind === 'tool') {
      const schema = nativeToolSchema(tool);
      if (schema) {
        // Validate trimmed required text, preserving the actual user's words.
        const checkView = (shape, value) => {
          if (shape?.type === 'string' && shape.minLength > 0 && typeof value === 'string') return value.trim();
          if (shape?.type !== 'object' || !value || typeof value !== 'object' || Array.isArray(value)) return value;
          const view = { ...value };
          for (const [key, field] of Object.entries(shape.properties || {})) {
            if (view[key] !== undefined) view[key] = checkView(field, view[key]);
          }
          return view;
        };
        const problems = jsonSchemaObjectProblems(schema, checkView(schema, args), '');
        if (problems.length) {
          logEvent({ kind: 'steward_act_undeliverable', tool, reason: 'invalid_arguments', problems: problems.slice(0, 3) });
          return null;
        }
      }
    }
    // A label is not an executable reminder. Reuse the scheduler's actual
    // validation (including past one-shot times) before offering the button.
    if (kind === 'tool' && tool === 'steward_schedule_create') {

      const checked = normalizeSchedulerTask({
        title: args.title, schedule: args.schedule, payload: args.payload,
        target: args.tier !== undefined ? { ...(args.target || {}), tier: args.tier } : args.target,
        autonomy: { permissionMode: args.permissionMode }, createdBy: 'steward', id: '', revision: 0,
      }, Date.now());
      if (!checked.ok) {
        logEvent({ kind: 'steward_act_undeliverable', tool, reason: checked.code });
        return null;
      }
    }
    // 107-S1 ④(46 号文 §5 ⑦b H1):**confirm 档的按钮不许由模型命名**。修前这一行 label 优先用
    // `raw.label` —— 模型写「好,我知道了」,args 里是 steward_config_set{externalMcpServers:[…]},
    // 用户按下去就是用户「亲手按了」(13q 据此置那一位),而 args 一个字都没被校验过。
    // 于是这一族:① 丢掉模型的标签,恒用服务端按 args 派生的说明(写清键与新值);
    //             ② 把整份清单随 act 带给前端(confirmItems,纯文本),前端 POST 之前弹确认面板逐条列出。
    // 其余 act 一个字节不变(仍然是模型标签优先)——「知道了」这种表态按钮没有二次确认的必要。
    const confirmSpec = kind === 'tool' ? stewardActConfirmSpec(tool, args) : null;
    const label = confirmSpec
      ? stewardActLabel(tool, args)
      : (stewardSanitizeText(raw.label).slice(0, STEWARD_ACT_LABEL_MAX)
        || (kind === 'tool' ? stewardActLabel(tool, raw.args) : (kind === 'open_thread' ? '打开' : '知道了')));
    const act = { label, kind };
    if (kind === 'tool') {
      act.tool = tool;
      act.args = args;
      if (confirmSpec) act.confirmItems = stewardActConfirmLines(confirmSpec);
    }
    const sessionId = raw.sessionId ? safeSessionId(raw.sessionId) : '';
    if (kind === 'open_thread' && !sessionId) return null;
    if (sessionId) act.sessionId = sessionId;
    if (raw.primary === true) act.primary = true;
    return act;
  }

  // acts 归一:≤3 个、主动作只有一个(第一个 primary 胜出,其余降为安静按钮)。
  function stewardNormalizeActs(list) {
    const out = [];
    let primaryTaken = false;
    for (const raw of (Array.isArray(list) ? list : [])) {
      if (out.length >= STEWARD_ACTS_MAX) break;
      const act = stewardNormalizeAct(raw);
      if (!act) continue;
      if (act.primary) {
        if (primaryTaken) delete act.primary;
        else primaryTaken = true;
      }
      out.push(act);
    }
    return out;
  }

  function stewardParseReply(text) {
    const raw = String(text == null ? '' : text);
    const parsed = parseStructuredAgentOutput(raw);
    const value = parsed && parsed.ok ? parsed.value : null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      logEvent({ kind: 'steward_contract_unparsed', chars: raw.length });
      // 117y-S1(§11.18.2):这条兜底灌进来的是【整份原始模型输出】,所以它比解析成功那一路更需要
      // 天花板;但同样【不许裸切】—— 与下面 say 那一处走的是同一个函数、同一个天花板,不许只改一处。
      return { parsed: false, say: stewardTrimSayAtSentence(raw.trim(), STEWARD_SAY_CEILING), why: '', acts: [], actions: [], contractIncomplete: false, contractKeys: [] };
    }
    // 123-P1 ①(38 号文;用户 2026-09-14 真机取证):**契约完整性**。
    // 现象:用户对管家说「下周一整周大A该怎么操作」,管家回「我把你这句话原样递给『下周A股走势分析』
    // 那条线程了」「按钮就在这条消息下面,点『打开线程』」—— 界面上没有任何按钮,线程也从没收到那句话。
    // 病根:真机 sessions/steward.provider.ndjson 里模型的原始输出【只有 say 一个键】,七轮无一例外
    // (stewardProviderId=deepseek / stewardModel=deepseek-v4-flash 这个快档);落盘的七条 assistant
    // 消息 acts=0 actions=0 parsed=true。模型一个工具都没调,却在 say 里把动作说成已完成 —— 违反
    // 06b 稳定层纪律 6「不编造进度、不把没做的事说成做了」,而系统这一侧此前【完全没有兜底】。
    // 判据【不猜 say 的文本】:关键词匹配「已经递了/按钮在下面」这类完成时陈述既脆弱又要维护中英
    // 词表;契约完整性是机器可判的硬事实 —— 06b 的输出契约把 why 写成必填的「依据一句话」,连这个
    // 键都没给就是没按契约输出。
    // **只看键在不在,不看值空不空**:`why:''` 是「按契约给了这个键、这一轮没依据可写」(既有剧本
    // 与线上老回合大量这么写),缺键才是「压根没按契约走」。
    // **acts / actions 一律不当判据**:纯答问回合本来就不需要它们,拿空当判据等于给每一句寒暄都盖
    // 一个红戳。
    const contractIncomplete = !Object.prototype.hasOwnProperty.call(value, 'why');
    const actions = [];
    for (const item of (Array.isArray(value.actions) ? value.actions : [])) {
      if (!item || typeof item !== 'object') continue;
      const tool = String(item.tool || '');
      if (!isStewardToolName(tool)) continue;
      actions.push({ tool, args: (item.args && typeof item.args === 'object' && !Array.isArray(item.args)) ? item.args : {} });
      if (actions.length >= STEWARD_ACTIONS_MAX) break;
    }
    return {
      parsed: true,
      // 117y-S1(§11.18.2):修前这里是按那个 600 的常量直接裸 slice —— 601 字的回复在第 600 字处
      // 无声断掉,可能断在半个句子、半个词中间。现在 600 只是提示词目标(STEWARD_SAY_TARGET),
      // 运行期只剩 4000 的病态载荷天花板,且触顶也在句末标点处切并明说。
      say: stewardTrimSayAtSentence(value.say, STEWARD_SAY_CEILING),
      why: String(value.why == null ? '' : value.why).slice(0, STEWARD_WHY_MAX),
      acts: stewardNormalizeActs(value.acts),
      actions,
      contractIncomplete,
      // 审计要写的是「模型到底给了哪些键」,不是「我们最后解析出了什么」—— 所以取【原始对象】的
      // 顶层键。8 个封顶:病态输出(几十个键)不该把一行审计撑成一屏。
      contractKeys: Object.keys(value).slice(0, 8),
    };
  }

  return { stewardActConfirmLines, stewardActLabel, stewardNormalizeAct, stewardParseReply };
}

module.exports = { createStewardActionContract };
