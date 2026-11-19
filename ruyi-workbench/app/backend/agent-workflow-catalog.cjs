'use strict';

const path = require('node:path');
const fsp = require('node:fs/promises');
const { safeJsonParse } = require('./ordinary-json.cjs');
const { normalizeAgentGate, sanitizeAgentOutputSchema, QUALITY_GATE_OUTPUT_SCHEMA } = require('./agent-quality.cjs');

const C3_HIGH_RISK_GATE = Object.freeze({ mode: 'cross_review', requireEvidence: true });

const BUILTIN_AGENT_WORKFLOWS = Object.freeze([
  {
    id: 'debate-and-judge', title: '正反辩论 → 裁决', description: '正反双方并行分析，由 Reviewer 交叉审查并给出可核验的裁决。',
    nodes: [
      { id: 'pro', task: '从支持方立场分析议题，给出证据、收益、适用条件和主要风险。', role: 'explorer', failurePolicy: 'continue', position: { x: 80, y: 80 } },
      { id: 'con', task: '从反对方立场分析议题，主动寻找反例、成本、失败条件和替代方案。', role: 'explorer', failurePolicy: 'continue', position: { x: 80, y: 260 } },
      { id: 'judge', task: '交叉审查正反双方：核验依据、去除重复和无证据主张，给出最终裁决。', role: 'reviewer', dependsOn: ['pro', 'con'], gate: C3_HIGH_RISK_GATE, position: { x: 420, y: 170 } },
    ],
  },
  {
    id: 'implement-review-fix-test', title: '编码实现 → 独立审查 → 定向修复 → 验收', description: 'Coder 完成代码与针对性自测，Reviewer 独立审查；仅对确认的问题定向修复，最后由 Verifier 按验收标准复核。适合可拆成实现与独立复核的代码任务；单一、不可分的长改动不必使用团队。',
    nodes: [
      { id: 'implement', task: '阅读相关实现、测试和项目约束，按需求完成最小且完整的代码改动；补充能证明行为的针对性测试并运行基础检查，报告改动、验证和风险。', role: 'coder', failurePolicy: 'block', position: { x: 40, y: 160 } },
      { id: 'review', task: '独立审查实现与测试：核对需求覆盖、正确性、安全性、并发/边界条件、回归风险和测试缺口。只报告有具体触发路径或证据的问题；输出明确 verdict(pass/fail)、置信度和逐项发现。', role: 'reviewer', dependsOn: ['implement'], gate: C3_HIGH_RISK_GATE, failurePolicy: 'continue', position: { x: 310, y: 160 } },
      { id: 'fix', task: '逐项核对 review 的成立问题，只修复已确认的根因；补充对应回归测试并运行相关检查，说明每项采纳或不采纳的证据。', role: 'coder', dependsOn: ['review'], condition: { node: 'review', path: 'verdict', operator: 'equals', value: 'fail' }, failurePolicy: 'continue', position: { x: 580, y: 80 } },
      { id: 'test', task: '从用户验收标准出发运行独立验证，并覆盖实现者容易遗漏的失败路径；核验最终工作区（含条件修复）是否满足需求。输出 verdict、confidence、summary 与 findings；每条验收判断必须在 evidenceRefs 中引用可见 Evidence Catalog 的 eventId。不擅自修改产品代码。', role: 'verifier', dependsOn: ['implement', 'fix'], gate: C3_HIGH_RISK_GATE, failurePolicy: 'retry', maxRetries: 1, position: { x: 850, y: 160 } },
    ],
  },
  {
    id: 'deep-research', title: '深度研究 → 核验 → 综述',
    description: '拆解问题 → 双镜头并行联网检索(事实/观点) → 对抗式事实核验(剔除无据主张、去重) → 只依据已核验发现写带引用的结构化综述。适合需要可靠、可追溯结论的调研。模型建议:并行检索(research_*)可用快模型广撒网;核验(verify)与综述(synthesize)建议在编辑器为其指派更强模型,因为它们决定结论的可信度。',
    nodes: [
      { id: 'plan', task: '把研究问题拆成 3–4 个关键子问题。每个子问题注明:①要回答什么(具体到可判定);②优先检索方向与关键词;③适合的权威来源类型。若问题本身含歧义,先列出你对范围/定义的假设。输出:编号子问题清单 + 检索要点。', role: 'explorer', position: { x: 40, y: 200 } },
      { id: 'research_facts', task: '认领 plan 的全部子问题,联网检索并阅读来源,重点抓【事实与现状】:定义、关键数据/数字、时间线、权威来源的明确表述。对每条发现给出:结论一句话 + 支撑来源(标题与 URL)+ 置信度(高/中/低)。只记录有来源支撑的内容;查不到就写"未找到可靠来源",不要编。', role: 'researcher', dependsOn: ['plan'], failurePolicy: 'continue', position: { x: 340, y: 90 } },
      { id: 'research_context', task: '认领 plan 的全部子问题,联网检索并阅读来源,重点抓【分析与观点】:不同立场与权衡、争议点、行业/专家观点、反面证据。格式同 research_facts(结论 + 来源 + 置信度)。刻意寻找与主流叙述相悖的证据,避免只找支持性材料。', role: 'researcher', dependsOn: ['plan'], failurePolicy: 'continue', position: { x: 340, y: 310 } },
      { id: 'verify', task: '对 research_facts 与 research_context 的所有发现做对抗式核验:逐条检查是否真有来源支撑、来源是否可靠、彼此有无矛盾;剔除无据或夸大的主张、合并重复项、标注仍存疑的点。输出 verdict、confidence、summary 与 findings；每条事实性 finding 必须在 evidenceRefs 中引用可见 Evidence Catalog 的 eventId。默认怀疑,证据不足即降级或剔除。', role: 'critic', dependsOn: ['research_facts', 'research_context'], gate: C3_HIGH_RISK_GATE, failurePolicy: 'continue', position: { x: 660, y: 200 } },
      { id: 'synthesize', task: '仅依据 verify 节点【已核验】的发现,写一篇结构化综述:①一段摘要给出总体结论;②按主题分节的结论(每条关键判断标注来源);③已知的不确定性与分歧;④针对原始问题的建议或下一步。绝不引入未经核验的新主张;证据不足处如实说明。', role: 'synthesizer', dependsOn: ['verify'], position: { x: 980, y: 200 } },
    ],
  },
  {
    id: 'design-and-decide', title: '需求 → 多方案 → 选型 → 落地清单',
    description: '拆清需求与评价维度 → 并行产出三种不同取向的候选方案 → 按权重打分横向选型 → 输出可执行落地清单。适合技术选型、架构决策、方案权衡。模型建议:方案生成(option_*)可用快模型广撒网;选型(decide)与落地清单(rollout)建议指派更强模型,它们承担权衡与决策质量。',
    nodes: [
      { id: 'clarify', task: '把需求拆清并结构化:①目标与非目标;②硬约束(性能/成本/合规/时间/团队能力等,尽量量化);③评价维度及其相对权重;④明确的成功判据。凡有歧义处,列出你所做的假设。输出结构化需求说明,供后续方案与选型共用。', role: 'planner', position: { x: 40, y: 220 } },
      { id: 'option_a', task: '在 clarify 的约束下产出一个【稳妥成熟】取向的候选方案:方案概述、核心取舍、如何逐条满足硬约束、优点、主要风险与缓解、粗略成本/工期。只出一个方案,把它论证扎实。', role: 'explorer', dependsOn: ['clarify'], failurePolicy: 'continue', position: { x: 340, y: 70 } },
      { id: 'option_b', task: '同 option_a 的格式,但取【性能/能力优先或创新】取向,给出与 option_a 明显不同的方案(不同技术栈/架构/思路),并诚实标注其代价。', role: 'explorer', dependsOn: ['clarify'], failurePolicy: 'continue', position: { x: 340, y: 220 } },
      { id: 'option_c', task: '同 option_a 的格式,取【最简/最低成本或最快落地】取向,给出投入最小、能先跑起来的方案,并说明其局限与后续演进路径。', role: 'explorer', dependsOn: ['clarify'], failurePolicy: 'continue', position: { x: 340, y: 370 } },
      { id: 'decide', task: '按 clarify 的评价维度与权重,对 option_a/b/c 逐维打分并给出理由(不只给分),做一张横向对比表。选出推荐方案,说明它为何优于其余、以及采用它最需警惕的风险。若某方案的局部优点值得吸收,可提出一个融合改良版。', role: 'reviewer', dependsOn: ['option_a', 'option_b', 'option_c'], gate: C3_HIGH_RISK_GATE, failurePolicy: 'continue', position: { x: 680, y: 220 } },
      { id: 'rollout', task: '把 decide 选定(或改良)的方案落成可执行清单:分阶段任务及其依赖顺序、每步交付物与验收点、所需资源与前置条件、主要风险的应对与回滚点、以及最早可验证价值的里程碑。', role: 'planner', dependsOn: ['decide'], position: { x: 1000, y: 220 } },
    ],
  },
  {
    id: 'codebase-audit', title: '代码审计:多维并行 → 核验 → 修复排期',
    description: '建库地图 → 三维度并行审计(正确性/安全/性能与可维护性) → 亲读核验剔除误报 → 按严重度×价值排优先级出修复清单。审计只读、不改代码。模型建议:并行审计(audit_*)可用中等模型;核验(verify)与排期(backlog)建议指派更强模型,以压住误报、抓准优先级。审计全程优先用 codebase_symbol_search 检索符号的真实定义/引用,以文件:行证据为准,勿凭名称相似下结论。',
    nodes: [
      { id: 'map', task: '快速建立目标代码库地图:核心模块与职责、关键数据流与入口点、外部依赖与信任边界、以及凭经验判断的高风险区域。用 codebase_symbol_search(没有这个工具时改用 Grep / Glob)抽查关键符号/函数/类的定义与引用,确认模块、入口点与依赖真实存在、命名与文件对应,不要凭名称猜测。输出简明地图 + 一份"建议重点审计的文件/区域"清单,供后续各维度聚焦。只读不改。', role: 'explorer', position: { x: 40, y: 220 } },
      // 2026-10:三路审计与下面 debug-root-cause 的 reproduce 是【产出发现】的节点,显式 gate:false —— 不写时 reviewer/verifier
      // 角色会被 normalizeAgentGate 自动补上 review/verify 门,审计一发现缺陷就判 rejected、运行汇总报「质量门未通过」。核验交给下游 verify。
      { id: 'audit_correctness', task: '在 map 指出的重点区域找【正确性缺陷】:边界条件、错误处理缺失、并发/竞态、空值/未初始化、类型或接口契约不一致、资源泄漏。每条给:文件:行、具体触发条件、影响、建议修法。只报你能写出触发路径的,拿不准不报。', role: 'reviewer', gate: false, dependsOn: ['map'], failurePolicy: 'continue', position: { x: 340, y: 70 } },
      { id: 'audit_security', task: '找【安全缺陷】:注入(命令/SQL/路径)、路径穿越、鉴权/越权、敏感信息泄露、SSRF、不安全默认值、反序列化。每条给:文件:行、具体利用路径、影响、修法。只报可利用的,理论风险不报。', role: 'reviewer', gate: false, dependsOn: ['map'], failurePolicy: 'continue', position: { x: 340, y: 220 } },
      { id: 'audit_quality', task: '找【性能与可维护性】问题:热路径/循环内的低效、随数据量或时长恶化的结构、重复三次以上的逻辑、超长函数、死代码、易错的命名/边界。每条给文件:行与可度量的改进点。只报改了确有收益的。', role: 'reviewer', gate: false, dependsOn: ['map'], failurePolicy: 'continue', position: { x: 340, y: 370 } },
      { id: 'verify', task: '对三路审计的全部发现做对抗核验:亲自读引用位置及上下文确认属实、检查是否已有防线/测试覆盖、剔除误报与重复项。对发现中引用的符号/函数/类,用 codebase_symbol_search(没有这个工具时改用 Grep / Glob)反查其定义与调用是否真实存在、文件:行是否对得上,否证幻觉与名称相近的误判。输出 verdict、confidence、summary 与 findings；每条成立或否证 finding 必须在 evidenceRefs 中引用可见 Evidence Catalog 的 eventId。默认怀疑,写不出具体触发即否证。', role: 'critic', dependsOn: ['audit_correctness', 'audit_security', 'audit_quality'], gate: C3_HIGH_RISK_GATE, failurePolicy: 'continue', position: { x: 680, y: 220 } },
      { id: 'backlog', task: '把 verify 的成立发现排成可执行修复清单:按(严重度 × 影响 ÷ 改动成本)分三档——立即修 / 下一轮 / 可选打磨;标注依赖顺序、建议测试与验收点；识别可在同一次改动里安全带走的同类项，但不要直接修改代码。', role: 'planner', dependsOn: ['verify'], position: { x: 1000, y: 220 } },
    ],
  },
  {
    id: 'debug-root-cause', title: 'Bug 定位:复现 → 假设 → 验证 → 根因修复',
    description: '系统化定位难缠 Bug:确认最小复现 → 双方向并行提根因假设 → 逐一实验证伪(排除法) → 锁定根因并给最小修复。模型建议:复现(reproduce)与假设(hypo_*)可用快模型;验证(verify)与修复(fix)建议指派更强模型,因为根因判定与"修根因而非症状"最吃推理。verify 用 debug_hypothesis 追踪假设证伪状态,确保每个假设都被排除或证实,勿只验证一条就下结论。',
    nodes: [
      { id: 'reproduce', task: '确认并最小化复现:写出精确复现步骤、观察到的实际现象(日志/报错/异常状态)、预期现象、以及能稳定触发的最小条件集。若当前信息不足以复现,明确列出还需要哪些信息或环境。输出复现报告。', role: 'verifier', gate: false, position: { x: 40, y: 220 } },
      { id: 'hypo_a', task: '基于 reproduce 提出 2–3 个【最可能】的根因假设。每个假设说明:机制解释(为什么会导致该现象)、若成立应能观察到什么证据、以及最快的验证手段。按可能性排序。', role: 'explorer', dependsOn: ['reproduce'], failurePolicy: 'continue', position: { x: 340, y: 110 } },
      { id: 'hypo_b', task: '从 hypo_a 未覆盖的方向提出 2–3 个根因假设:环境/依赖版本、并发时序、数据/边界输入、配置/部署差异、上游变更等。同样给机制、预期证据、验证手段。目标是补齐盲区,而非重复 hypo_a。', role: 'explorer', dependsOn: ['reproduce'], failurePolicy: 'continue', position: { x: 340, y: 300 } },
      { id: 'verify', task: '对 hypo_a/hypo_b 的每个假设逐一验证:能跑实验就跑最小实验、加日志或读代码去证实或证伪。先用 debug_hypothesis(action=init)把两个方向的假设登记成台账(没有这个工具时在输出里自建同样的台账:假设、实验、结果、结论),每做一次实验就用 debug_hypothesis(action=test)记录其结果(证伪 refutes / 支持 supports / 无结论 inconclusive),锁定根因前用 action=conclude 并留意 earlyStopWarning(是否还有假设未排除)。输出 verdict、confidence、summary 与 findings；每条判定必须在 evidenceRefs 中引用可见 Evidence Catalog 的 eventId。综合后锁定最可能的单一根因;若证据指向多因,说清主次。', role: 'verifier', dependsOn: ['hypo_a', 'hypo_b'], gate: C3_HIGH_RISK_GATE, failurePolicy: 'continue', position: { x: 680, y: 220 } },
      { id: 'fix', task: '针对 verify 锁定且有证据支持的根因实施最小、聚焦的代码修复；先补能稳定复现的回归测试，再修改并运行相关测试，说明为什么修的是根因而非症状、潜在副作用与残余风险。动手前确认 verify 已(用 debug_hypothesis 或它自建的台账)排除其余主要假设(而非只验证了一条);若根因仍存疑，不要猜改。', role: 'coder', dependsOn: ['verify'], position: { x: 1000, y: 220 } },
    ],
  },
  {
    id: 'doc-from-scratch', title: '文档生成:提纲 → 分节撰写 → 核验 → 统稿',
    description: '从零产出高质量文档/报告:定提纲与受众 → 并行撰写各章节 → 事实与一致性核验 → 统稿润色并落盘。适合技术文档、方案书、调研报告。模型建议:分节撰写(draft_*)可用快模型提产量;提纲(outline)、核验(factcheck)、统稿(finalize)建议指派更强模型,它们决定结构与成稿质量。',
    nodes: [
      { id: 'outline', task: '明确文档的目标、目标受众与使用场景;产出详细提纲:章节结构、每节的要点与预期篇幅、需要引用的事实/数据来源、关键术语的统一口径。并给出写作约定(风格、人称、格式规范),供各撰写节点共同遵循。', role: 'planner', position: { x: 40, y: 200 } },
      { id: 'draft_front', task: '按 outline 撰写【前半部分章节】:严格遵循提纲要点与写作约定,内容具体、有必要的例子,不编造事实——不确定的数据/事实标注"[待核]"而非杜撰。只输出你负责章节的正文。', role: 'explorer', dependsOn: ['outline'], failurePolicy: 'continue', position: { x: 340, y: 90 } },
      { id: 'draft_back', task: '按 outline 撰写【后半部分章节】,方法与格式同 draft_front(遵循写作约定、具体有例、不编造、"[待核]"标注)。只输出你负责章节的正文。', role: 'explorer', dependsOn: ['outline'], failurePolicy: 'continue', position: { x: 340, y: 310 } },
      { id: 'factcheck', task: '核验 draft_front 与 draft_back:事实/数据是否准确且前后一致、有无自相矛盾、是否偏离提纲与受众、"[待核]"项是否仍未解决。输出 verdict、confidence、summary 与 findings；每条事实性 finding 必须在 evidenceRefs 中引用可见 Evidence Catalog 的 eventId。此节点不改写正文。', role: 'critic', dependsOn: ['draft_front', 'draft_back'], gate: C3_HIGH_RISK_GATE, failurePolicy: 'continue', position: { x: 680, y: 200 } },
      { id: 'finalize', task: '整合 draft_front 与 draft_back,按 factcheck 的问题清单逐条修正;统一术语、风格与章节过渡,润色成一篇连贯完整的文档,补齐目录与小结。将成稿写入工作区文件(用户未指定文件名时取一个合理默认,如 <主题>.md)。输出成稿路径与一段变更摘要。', role: 'worker', toolTier: 'edit', dependsOn: ['factcheck', 'draft_front', 'draft_back'], position: { x: 1000, y: 200 } },
    ],
  },
  {
    id: 'data-insights', title: '数据洞察:探查 → 方案 → 多角度分析 → 核验 → 洞察',
    description: '对数据/日志/指标做系统化分析:数据画像 → 定分析方案与口径 → 双线并行分析(主线 + 交叉/异常) → 对抗核验剔除不稳健结论 → 综合成洞察报告。模型建议:探查/分析(analyst)可用中等模型;方案(planner)、核验(critic)、洞察综述(synthesizer)建议指派更强模型。分析节点要读数据/跑只读脚本,请给足工具权限(analyst 为 exec 级)。探查用 data_profile 做机器级数据画像(规模/列类型/缺失/离群),不要靠目测。',
    nodes: [
      { id: 'profile', task: '对目标数据/日志做初步探查:先用 data_profile(没有这个工具时用只读脚本统计同样的指标)对每个数据文件做机器级画像(行列规模、每列类型、缺失率、唯一值数、数值列的 min/max/mean/median/std 与离群点、样本值),据此确认字段与结构、数据质量问题(缺失/异常/重复/格式)、时间与口径范围。不要靠 file_read 目测几行就下结论。只读不改。输出数据画像 + 待澄清项。', role: 'analyst', position: { x: 40, y: 200 } },
      { id: 'plan', task: '基于 profile 定分析方案:要回答的关键问题(可判定)、清洗与口径规则(如何处理缺失/异常/去重、指标如何定义)、每个问题用什么切法与指标、结果如何交叉验证。输出结构化分析方案。', role: 'planner', dependsOn: ['profile'], position: { x: 340, y: 200 } },
      { id: 'analyze_main', task: '按 plan 执行【主线分析】:运行必要的只读查询/脚本,产出关键指标、趋势、分组对比等,每条结论标注口径(样本/时间范围/指标定义)与证据。不修改源数据。', role: 'analyst', dependsOn: ['plan'], failurePolicy: 'continue', position: { x: 640, y: 90 } },
      { id: 'analyze_cross', task: '按 plan 执行【交叉与异常分析】:换维度切分、寻找异常点与反直觉现象、验证主线结论在不同切法下是否稳健。同样标注口径与证据。', role: 'analyst', dependsOn: ['plan'], failurePolicy: 'continue', position: { x: 640, y: 310 } },
      { id: 'verify', task: '对 analyze_main 与 analyze_cross 的结论做对抗核验:口径是否一致、样本/时间范围是否可比、有无以偏概全或把相关当因果、异常是否被解释。输出 verdict、confidence、summary 与 findings；每条稳健、剔除或存疑 finding 必须在 evidenceRefs 中引用可见 Evidence Catalog 的 eventId。', role: 'critic', dependsOn: ['analyze_main', 'analyze_cross'], gate: C3_HIGH_RISK_GATE, failurePolicy: 'continue', position: { x: 960, y: 200 } },
      { id: 'insights', task: '仅依据 verify 通过的稳健结论,综合成一份洞察报告:①核心发现(按重要性排序,每条附口径与证据);②值得注意的异常或反直觉点;③局限与不确定性;④建议的下一步或可行动项。不引入未经核验的新结论。', role: 'synthesizer', dependsOn: ['verify'], position: { x: 1280, y: 200 } },
    ],
  },
].map(workflow => ({
  ...workflow,
  nodes: workflow.nodes.map(node => (
    // C3: 仅高风险裁决门(requireEvidence)显式声明结构化 verdict/findings/evidenceRefs 输出契约,
    // 使其在编辑器/存储中可见且持久化。源节点(pro/con/implement/draft/research…)保持自由文本输出 ——
    // 它们的证据来自本轮工具调用,由 indexNodeEvidence 统一入图,不需要模型自报 verdict。给源节点强制
    // required verdict schema 会让真实模型的自由文本产出 schema_failed(已实证)。运行时 09:624 本就会
    // 给模型 gate 自动套 QUALITY_GATE_OUTPUT_SCHEMA,这里只是把该契约显式落到 C3 的高风险门节点上。
    node.gate && node.gate.requireEvidence && !node.outputSchema
      ? { ...node, outputSchema: QUALITY_GATE_OUTPUT_SCHEMA }
      : node
  )),
})));
function normalizeWorkflowCondition(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const operators = ['equals', 'not_equals', 'truthy', 'falsy', 'contains', 'greater', 'greater_equal', 'less', 'less_equal', 'status_is'];
  const operator = operators.includes(raw.operator) ? raw.operator : 'truthy';
  return { node: String(raw.node || '').trim().slice(0, 64), path: String(raw.path || '').trim().slice(0, 200), operator, value: raw.value };
}
function normalizeWorkflowLoop(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const maxIterations = Math.max(1, Math.min(20, Math.round(Number(raw.maxIterations) || 1)));
  if (maxIterations <= 1 && !raw.until && !raw.noProgressLimit) return null;
  return { maxIterations, until: normalizeWorkflowCondition(raw.until), progressPath: String(raw.progressPath || '').trim().slice(0, 200), noProgressLimit: Math.max(1, Math.min(10, Math.round(Number(raw.noProgressLimit) || 2))), onNoProgress: raw.onNoProgress === 'fail' ? 'fail' : 'continue' };
}
// 第28e波(§28e):wait_for 等待原语规格。node.wait 为 truthy 即 wait_for 节点(与 node.gate 平行)。仿 normalizeAgentGate/
// normalizeWorkflowLoop 全字段 clamp。各 mode 参数在 poll 时才真正解析/过护栏(file→guardWorkspacePath、url→ssrfCheck),
// 此处只做形状规整。返回 null = 非法/非 wait 节点。timeoutMs∈[1s,24h] 默认 300s;pollMs∈[500ms,60s] 默认 2s。
function normalizeWaitSpec(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const mode = ['timer', 'file', 'process', 'url'].includes(raw.mode) ? raw.mode : null;
  if (!mode) return null;
  const spec = {
    mode,
    timeoutMs: Math.max(1000, Math.min(24 * 3600 * 1000, Math.round(Number(raw.timeoutMs) || 300000))),
    pollMs: Math.max(500, Math.min(60000, Math.round(Number(raw.pollMs) || 2000))),
  };
  if (mode === 'timer') {
    spec.durationMs = Math.max(0, Math.min(24 * 3600 * 1000, Math.round(Number(raw.durationMs) || 0)));
    // 对抗轮 P2:timer 一定会在 durationMs 到点,超时兜底不得抢先。把 timeoutMs 抬到 ≥ durationMs+pollMs,否则 >5min(默认 timeout)
    // 的 timer 会在到点前先被超时判失败(核心用法静默炸掉)。
    spec.timeoutMs = Math.max(spec.timeoutMs, spec.durationMs + spec.pollMs);
  }
  else if (mode === 'file') { spec.path = String(raw.path || '').slice(0, 1000); spec.exists = raw.exists !== false; if (!spec.path) return null; }
  else if (mode === 'process') { spec.pid = Math.round(Number(raw.pid) || 0); spec.state = raw.state === 'exit' ? 'exit' : 'alive'; if (!(spec.pid > 1)) return null; } // 禁 pid≤1(0/负/init)
  else if (mode === 'url') { spec.url = String(raw.url || '').slice(0, 2000); if (!spec.url) return null; }
  return spec;
}

function normalizeAgentWorkflow(raw, opts = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  const title = String(raw.title || '').trim().slice(0, 120);
  if (!id || !title || !Array.isArray(raw.nodes) || !raw.nodes.length) return null;
  const ids = new Set(); const nodes = [];
  for (const item of raw.nodes.slice(0, 64)) {
    const nodeId = String(item && item.id || '').trim().slice(0, 64);
    const wait = normalizeWaitSpec(item && item.wait); // 第28e波:wait_for 节点
    const task = String(item && item.task || '').trim().slice(0, 20000) || (wait ? `等待条件(${wait.mode})` : '');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(nodeId) || ids.has(nodeId) || !task) return null; ids.add(nodeId); // wait 节点已有默认 task
    const pos = item.position && typeof item.position === 'object' ? { x: Math.max(0, Math.min(4000, Number(item.position.x) || 0)), y: Math.max(0, Math.min(4000, Number(item.position.y) || 0)) } : null;
    nodes.push({
      id: nodeId, task, wait, role: String(item.role || '').trim().toLowerCase().slice(0, 64),
      engine: item.engine === 'claude' || item.engine === 'openai' ? item.engine : '',
      dependsOn: [...new Set((Array.isArray(item.dependsOn) ? item.dependsOn : []).map(x => String(x || '').trim()).filter(Boolean))].slice(0, 16),
      toolTier: ['read', 'edit', 'exec'].includes(item.toolTier) ? item.toolTier : undefined,
      // Preserve an explicit per-node budget only when it is meaningfully customized. Older saved templates
      // were normalized with maxIters:6 even though the UI never exposed that as a user choice; keeping that
      // value would silently override the role library's larger Reviewer/Verifier budgets and recreate the
      // "子代理已达迭代上限 6 轮" failure on every template launch.
      maxIters: (item.maxIters != null && item.maxIters !== '' && Math.round(Number(item.maxIters)) !== 6)
        ? Math.max(1, Math.min(300, Math.round(Number(item.maxIters) || 100)))
        : undefined,
      model: String(item.model || '').trim().slice(0, 160),
      resources: (Array.isArray(item.resources) ? item.resources : []).map(x => String(x || '').trim()).filter(Boolean).slice(0, 32),
      isolation: (item.isolation === 'worktree' && !wait) ? 'worktree' : 'none', outputSchema: sanitizeAgentOutputSchema(item.outputSchema), // 第28e波:wait 节点与 worktree 互斥,静默降级 none(避免模板可存却启动被拒)
      gate: normalizeAgentGate(item.gate, String(item.role || '').trim().toLowerCase()), failurePolicy: ['block', 'continue', 'retry'].includes(item.failurePolicy) ? item.failurePolicy : 'block',
      dependencyPolicy: item.dependencyPolicy === 'all_settled' ? 'all_settled' : 'all_success',
      degradedPolicy: ['accept', 'retry', 'request_review', 'fail'].includes(item.degradedPolicy) ? item.degradedPolicy : 'accept', // 第28波 §28d
      maxRetries: Math.max(0, Math.min(5, Math.round(Number(item.maxRetries) || 0))), retryFallback: item.retryFallback === 'continue' ? 'continue' : 'block',
      minSuccessfulToolCalls: Math.max(0, Math.min(20, Math.round(Number(item.minSuccessfulToolCalls) || 0))),
      condition: normalizeWorkflowCondition(item.condition), loop: normalizeWorkflowLoop(item.loop), position: pos,
      // 2026-10:节点专属资料、失败后重规划、仅报告的依赖 —— 启动路径(09 runAgentWorkflow)与工具 schema 都认,修前
      // 写进个人模板或 .ruyi/workflows.json 一加载就被这里丢掉。钳制与启动路径同口径;没写的不产出键(老模板不变形)。
      ...(item.context ? { context: String(item.context).trim().slice(0, 4000) } : {}),
      ...(item.replan === true ? { replan: true } : {}),
      ...(Array.isArray(item.reportedDependsOn) && item.reportedDependsOn.length
        ? { reportedDependsOn: [...new Set(item.reportedDependsOn.map(x => String(x || '').trim()).filter(Boolean))].slice(0, 16) } : {}),
    });
  }
  for (const node of nodes) {
    if (node.dependsOn.some(dep => !ids.has(dep) || dep === node.id)) return null;
    for (const condition of [node.condition, node.loop && node.loop.until]) {
      if (!condition || !condition.node || condition.node === node.id) continue;
      if (!ids.has(condition.node)) return null;
      if (!node.dependsOn.includes(condition.node)) node.dependsOn.push(condition.node);
    }
  }
  return { schemaVersion: 1, id, title, description: String(raw.description || '').trim().slice(0, 800), nodes, source: opts.source || raw.source || 'personal', builtin: !!opts.builtin };
}

// 第23波(主动性·意图触发): orchestrate_agents 的系统提示。既给【模板清单】(模型据 id 用 workflowId),又给
// 【意图→模板映射】——让模型在用户提出复杂多步任务时【主动】考虑编排复用,而非仅"形状已匹配时"被动复用;并带
// "简单任务别套模板"的护栏,避免过度编排增加开销/延迟。两引擎共用:Provider 系统层(runOpenAiTurn)与 Claude 引擎的
// --append-system-prompt(runClaudeTurn)——后者此前从不告知有哪些模板,是两引擎能力不对称的缺口。纯函数,workflows 由调用方传入。
function buildOrchestrateHint(workflows) {
  if (!Array.isArray(workflows) || !workflows.length) return '';
  // 2026-10:个人 / 项目模板(.ruyi/workflows.json 随仓库走)的标题与说明是外来文本,压成单行并截短再进系统提示,
  // 不让一份模板用换行冒充一段指令。
  const flat = (v, max) => String(v || '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max);
  const list = workflows.map(w => `${w.id}(${flat(w.title, 80)}：${flat(w.description, 160) || '无说明'})`).join('；');
  return '\n\n可用工作流模板（orchestrate_agents 的 workflowId）：' + list +
    '。\n主动编排指引：当用户的请求属于【复杂、多步、值得拆解并行或多视角核验】的任务时，优先用 orchestrate_agents（传 workflowId + context，context 填这次的具体主题/任务），复用上面的模板，而不是一个人从头硬做或临时手写 nodes——典型触发：调研/研究某主题→deep-research；审计或体检代码库→codebase-audit；定位难缠的 bug→debug-root-cause；技术选型/架构/多方案权衡→design-and-decide；从零写文档/报告/方案书→doc-from-scratch；实现改动且要质量把关→implement-review-fix-test；分析数据/日志/指标→data-insights；有争议议题要裁决→debate-and-judge。反之，简单、一步能答或纯闲聊的请求【不要】套模板（并行子代理有额外开销与延迟）。已有模板形状不完全吻合时，直接手写 nodes（同时给了 nodes 与 workflowId 时以 nodes 为准，模板被忽略）；内置模板必须带 context，否则不会启动。';
}

// 2026-10:保存口就把跑不起来的模板挡回去,并说清哪里不对 —— 修前环形依赖与不存在的角色都能存进去,到运行时才以
// dependency_cycle / 缺角色失败,而保存失败的文案「需要合法 DAG 节点」也不说明是哪一条。只在保存口判,读盘不判:
// 已经存下的旧模板不会因此从列表里消失(运行时照旧报)。wf 是 normalizeAgentWorkflow 的输出;返回 null = 没问题,
// 否则 { code, params, message }(前端按 code 本地化,params 带出是哪几个节点)。
function agentWorkflowSaveProblem(wf, roleIds) {
  const unknown = wf.nodes.filter(n => n.role && !roleIds.has(n.role)).map(n => `${n.id}(${n.role})`);
  if (unknown.length) return { code: 'agent_workflow.unknown_role', params: { nodes: unknown.join(', ') }, message: `节点引用了不存在的角色:${unknown.join('、')}` };
  const deps = new Map(wf.nodes.map(n => [n.id, n.dependsOn || []]));
  const state = new Map(); // 1 = 正在走, 2 = 走完
  const stack = [];
  const visit = id => {
    if (state.get(id) === 2) return null;
    if (state.get(id) === 1) return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 1); stack.push(id);
    for (const dep of deps.get(id) || []) { const cycle = visit(dep); if (cycle) return cycle; }
    stack.pop(); state.set(id, 2);
    return null;
  };
  for (const node of wf.nodes) {
    const cycle = visit(node.id);
    if (cycle) return { code: 'agent_workflow.cycle', params: { cycle: cycle.join(' → ') }, message: `依赖成环(箭头指向所依赖的节点):${cycle.join(' → ')}` };
  }
  return null;
}

function createAgentWorkflowCatalog({ paths, atomicWriteJson }) {
  function projectAgentWorkflowsFile(cwd) { return path.join(path.resolve(cwd), '.ruyi', 'workflows.json'); }
  async function readPersonalAgentWorkflows() {
    let files = []; try { files = await fsp.readdir(paths.agentWorkflows); } catch { return []; }
    const out = []; for (const file of files.filter(x => x.endsWith('.json'))) { try { const wf = normalizeAgentWorkflow(safeJsonParse(await fsp.readFile(path.join(paths.agentWorkflows, file), 'utf8')), { source: 'personal' }); if (wf) out.push(wf); } catch {} } return out;
  }
  async function readProjectAgentWorkflows(cwd) {
    try { const raw = safeJsonParse(await fsp.readFile(projectAgentWorkflowsFile(cwd), 'utf8'), {}); return (Array.isArray(raw.workflows) ? raw.workflows : []).map(x => normalizeAgentWorkflow(x, { source: 'project' })).filter(Boolean); } catch { return []; }
  }
  async function getAgentWorkflows(cwd) {
    const merged = new Map(); for (const raw of BUILTIN_AGENT_WORKFLOWS) { const wf = normalizeAgentWorkflow(raw, { source: 'builtin', builtin: true }); if (wf) merged.set(wf.id, wf); }
    for (const wf of await readPersonalAgentWorkflows()) merged.set(wf.id, wf);
    for (const wf of await readProjectAgentWorkflows(cwd)) merged.set(wf.id, wf);
    return [...merged.values()];
  }

  async function saveAgentWorkflow(scope, cwd, raw) {
    const wf = normalizeAgentWorkflow(raw, { source: scope }); if (!wf) return null;
    // 对抗轮裁定(维持分层设计): personal/project 是覆盖分层(project 覆 personal,删除覆盖版显露底层,契约见
    // agent-workflow-templates e2e),同 id 跨 scope 并存是特性而非僵尸——跨 scope 互斥删除会毁掉服务于其他项目的
    // 个人模板,属数据丢失,故明确不做。编辑器切换保存范围本质是"新增一层覆盖",不是移动。
    if (scope === 'project') {
      const dest = projectAgentWorkflowsFile(cwd); await fsp.mkdir(path.dirname(dest), { recursive: true }); const list = await readProjectAgentWorkflows(cwd); const next = list.filter(x => x.id !== wf.id); next.push(wf); await atomicWriteJson(dest, { schemaVersion: 1, workflows: next });   // 25.1 收编
    } else { await fsp.mkdir(paths.agentWorkflows, { recursive: true }); await atomicWriteJson(path.join(paths.agentWorkflows, wf.id + '.json'), wf); }   // 25.1 收编
    return wf;
  }
  async function deleteAgentWorkflow(scope, cwd, id) {
    if (!/^[a-z0-9_-]{1,64}$/.test(id)) return false;
    if (scope === 'project') { const dest = projectAgentWorkflowsFile(cwd); const list = (await readProjectAgentWorkflows(cwd)).filter(x => x.id !== id); await fsp.mkdir(path.dirname(dest), { recursive: true }); await atomicWriteJson(dest, { schemaVersion: 1, workflows: list }); return true; }   // 25.1 收编
    try { await fsp.unlink(path.join(paths.agentWorkflows, id + '.json')); return true; } catch { return false; }
  }

  return { getAgentWorkflows, saveAgentWorkflow, deleteAgentWorkflow };
}

module.exports = {
  BUILTIN_AGENT_WORKFLOWS, agentWorkflowSaveProblem, buildOrchestrateHint, createAgentWorkflowCatalog,
  normalizeAgentWorkflow, normalizeWaitSpec, normalizeWorkflowCondition, normalizeWorkflowLoop,
};
