# 发行说明 · Changelog

本文件记录面向用户的重要发行变化，不替代完整的 Git 提交历史。版本遵循 `ruyi-workbench/package.json`。
This file records user-facing release highlights; it does not replace the complete Git history. Versions follow `ruyi-workbench/package.json`.

## 3.0.2 · 2026-11-23

- 完整版更名为 Ruyi，轻量版更名为 Ruyi Slim。两版使用新版图标和对话布局，支持在输入区调整推理强度，并修复中文输入法确认候选时误发送的问题。
- The two Mac editions are now named Ruyi and Ruyi Slim. Both include the new icon, revised chat layout, composer reasoning controls and IME-aware sending.

- Mac 版以 Full 和 Slim 两种 DMG 分发，均随附双语使用与管理手册。工作流从暂停恢复后可立即派发就绪节点；聊天界面在消息包含图表时载入 Mermaid。
- The Mac Full and Slim DMGs include the user and administrator guides in both languages. Resuming a workflow dispatches ready nodes immediately. Chat loads Mermaid when a message contains a diagram.

- 别处发起的回合在最终消息保存前继续保持运行状态，避免查看全文时提前停表而漏掉最终回复。管家到访回执迟到时保留期间新增的原话、回复与递话回执。
- Turns started elsewhere remain live until their final messages are saved, so full-text views keep polling through settlement. Late Steward arrival receipts preserve messages, replies, and hand-off receipts added while they were loading.


- 直接进入工作台会完成共享侧栏的运行与排队读取，不再永久显示加载；关闭管家时不显示不适用的仲裁故障。
- Opening the workbench directly completes the shared sidebar's run and queue read. Disabling the Steward no longer shows an inapplicable arbiter warning.

- 3.1 收口补齐明确新任务的当轮交办与整条原话保真规则；记忆主动读取遵守会话关闭、固定集合、排除、项目与有效期，取代关系有提示。停止、换回合及库变化后的迟到结果丢弃，后续模型请求不再追加失效摘要。本机固定样本中新增补查提示无稳定收益，保持现有指南，不引入额外自动召回。
- The 3.1 source work clarifies immediate dispatch of explicit new tasks and verbatim message relay. Active memory reads honor session selection, exclusions, project scope and expiry, with superseded-reference warnings. Late results are discarded and stale summaries are removed from later requests. A fixed local-model comparison found no repeatable benefit from an extra recall hint, so the existing guide remains in place without new automatic recall.

- 管家直接递话可在发送中刷新后找回原话、附件、目标和核对入口，不自动补发。服务重启、回执过期或容量淘汰后的未知结果不会按“未执行”重派；真实重放和迟到成功只结算原记录。
- Direct Steward deliveries recover their text, attachments, target and receipt check after a page reload, without automatic resending. Restarted, expired or evicted receipt windows remain unknown; replays and late success settle the original record.

- 可从指定的认可成果、所选纠正、可变输入和验收项提炼一键任务。保存前可编辑、恢复或取消，修改已存规则会另存副本；使用新材料沿原 Playbook 路径执行，并明确尚未验证，模型自报不算机器验收。起草仍需要模型服务商。
- Save an accepted result, selected corrections, variable inputs and acceptance criteria as a Playbook. Review, reset or cancel before saving; editing saved rules creates a copy. Verify with new materials through the existing execution path; model claims do not imply machine verification. Drafting still requires a model provider.

- 管家可把一个新事项按 2–8 个有序步骤交办给同一协调线程，复用工作流的依赖、预算、资源租约和交付信封；前序失败或权限拒绝会阻止后序，停止传播到子步骤，重启后的未知结果等待人工核对。兼容存量 `claude-cli` 默认模型配置。
- The Steward can delegate one new task group as 2–8 ordered steps in one coordinator thread, reusing workflow dependencies, budgets, resource leases and delivery envelopes. Failure or denied permission blocks successors; stop propagates to steps, and unknown results after restart require manual review. Legacy `claude-cli` model defaults remain supported.

- 管家设置回执显示实际值、作用域和生效时机，历史与行动流水一致；free 标量修改可按现值条件撤销，冲突或回包未知时不会冒充成功。任务模型选择从下一回合使用，且不再间接改变“上次使用”的新任务默认；修改后续默认仍需显式操作。
- Steward setting receipts show actual values, scope and effective timing in chat, history and the activity ledger. Free scalar changes support guarded undo; conflicts and unknown responses never imply success. Task model choices apply from the next turn and preserve new-task defaults, including the last-used route; changing defaults remains explicit.

- 管家新增「事项待决」清单，按事项归组查看来源、具体内容与影响，逐项允许、拒绝或回答。同名事项、同文问题保持独立身份；陈旧按钮不会重复办理，读取失败保留草稿，处理中刷新可核对原回执，结果未确认时不自动重发。
- The Steward’s Task decisions list groups pending items by task group, shows their sources, details and effects, and handles each approval, rejection or answer separately. Same-named groups and identical questions retain separate identities. Stale controls cannot repeat decisions; failed reads preserve drafts, refreshes recover source receipts, and unconfirmed requests are never resent automatically.

- 管家交付卡可直接打开本轮产物、查看机器检查／用户确认／模型自报与未完成项，并准备回到原任务的修订。缺失、变更和旧回合会明确标记；文件或要求变化后，旧检查不再表示当前版本已验证。同名文件保留完整路径区别。
- Steward delivery cards now open artifacts from the source turn, distinguish machine checks, human confirmation, model claims and unfinished work, and prepare revisions in the source task. Missing or changed files and historical turns are explicit; old checks cannot verify changed files or later requirements. Same-named files retain their full paths.

- 管家手选已有任务后可带上传附件续办；目标空闲时沿既有回合接收，忙碌、待决或附件过期时整次拒绝并保留原话、材料和目标供核对或重试。被拒绝的工具结果不再记成成功递送，同一回执绑定原始目标与内容。任务搜索说明有界索引范围，未找到不代表从未做过。
- The Steward can continue a selected idle task with uploaded attachments. Busy/waiting targets and expired files reject the whole delivery while preserving the words, files and target for retry. Rejected tools no longer count as successful deliveries; receipts bind to the original target and payload. Task search now explains its bounded index.
- 联网搜索新增 DeepSeek Search / Fetch API 后端，普通任务和管家共用；支持 DeepSeek API Key、可选代理地址、Markdown 分页、取消和带来源的缓存回退。默认搜索选择不变，密钥仍按现有规则遮罩。
- Add DeepSeek Search / Fetch APIs as a shared web backend for tasks and the Steward, with an API key, optional proxy root, paged Markdown, cancellation and explicit cached results. Existing backend defaults and secret masking remain in effect.

- 递话失败或超时时不再只说「没做成」：如实显示「结果未确认」并保留原话，可先核对回执再决定是否重发；同一次递送带同一个 attemptId，服务端只执行一次，重发不会把同一件事交办两遍。
- When a hand-off fails or times out, the reply is no longer just "failed": it says the outcome is unconfirmed, keeps the text, and lets you check the receipt before resending. One hand-off carries one attemptId and executes once on the server, so resending cannot duplicate the task.

- 递话候选不再把同名任务折成一行：两条同名线程都能选，重名行带时间（或 `sessionId` 尾段）区分；焦点线程仍排第一。手选后 chip 与递话目标沿用原话标题。
- Same-named tasks are no longer collapsed into one picker row: both threads stay selectable and duplicate titles carry a distinguishing time (or session-id tail); the focused thread still ranks first. The chip and hand-off still use the original title.

- 只有飞书应用 ID 与应用密钥也能接上机器人：在“外部机器人”面板用“用应用信息自动发现”，本机向飞书固定官方接口探测一次，自动取得租户 key 与机器人 open_id 并准备一条关闭的连接，应用密钥存进本机凭据。已有连接可“核验身份”复核租户与机器人，不会改动身份。探测失败不保存任何凭据，也不开启连接或授予控制权。
- With only a Feishu App ID and App Secret you can prepare a bot: the External bots panel offers "Discover from app credentials", which probes the fixed official Feishu endpoints once, reads the tenant key and bot open_id, prepares a disabled connection and stores the app secret locally. Existing connections can re-check tenant and bot identity without changing it. A failed probe stores nothing and never enables control.

- 管家可根据用户提供的 QQ／飞书应用资料检查缺项并准备机器人连接。新增专用凭据录入与短时配对引导，自动识别本人账号和聊天，最终在本机确认开启远程控制。配对与本机配置就绪不等于真实平台收发已验证。
- The Steward can inspect supplied QQ/Feishu app information and prepare a disabled bot connection. Dedicated credential entry and short-lived pairing identify the owner's account and conversation before local authorization enables remote control. Pairing and local readiness do not imply verified live platform delivery.

- 新增 QQ 官方机器人与飞书应用机器人远程控制入口：本机显式授权本人账号与会话后，远程指令进入同一个管家，沿现有权限交办、查询、续办和停止，并将本次答复返回原会话。连接默认关闭，也可选仅收件；持久化区分受理、执行与发送结果，重投不重复办理，未知执行或发送不自动重放。真实平台账户、HTTPS 与权限配置仍需部署联调。
- Add remote control through official QQ and Feishu app bots. After explicit local authorization of an owner account and conversation, remote instructions enter the same Steward for delegation, queries, continuation and stopping under existing permissions; replies return to the original conversation. Connections start disabled and can instead be inbox-only. Durable receipt, execution and delivery states prevent duplicate execution on redelivery; uncertain outcomes are not automatically replayed. Actual platform accounts, HTTPS and permissions still require deployment checks.

- 停止和管家撤回绑定页面看到的那次执行，覆盖排队、启动及连续子回合；旧按钮遇到新执行或服务重启会拒绝。受保护的管家撤回在核验、停止与回退期间阻止新执行插入，空闲确认也检查期间是否启动过新任务。
- 管家任务列表与详情补齐写盘失败、空闲中止和资源阻塞提示；任务、待决和验收读取失败时保留旧内容并说明状态。服务重启后自动清除旧条件缓存、重取权威数据，迟到响应不覆盖新结果。

- Stop actions and Steward rewinds bind to the execution shown when the action was created, including queued and starting turns. Stale actions are rejected after a new execution or server restart; guarded Steward rewinds prevent a new turn from entering during rollback and detect intervening turns even when the thread is idle again.
- Steward lists and details now show persistence, idle-abort and resource-wait faults. Failed task, decision and acceptance reads retain their previous contents with a notice. Server restarts invalidate conditional caches and trigger fresh reads, with late responses prevented from replacing newer results.

- 班组与工具箱统一显示写盘失败、空闲中止和资源阻塞；读取失败时保留并标明旧快照，缺失或畸形响应不再伪装成空列表或成功刷新。
- 管家停止回执区分请求受理、无事可停、拒绝与结果未确认；同一目标的在途点击合并，丢失回包后不自动重发，实时与历史工具回执使用同一判据。

- Crew and Workflows share persistence, idle-abort and resource-wait notices. Failed reads retain a visibly stale snapshot; missing or malformed responses no longer masquerade as empty results or successful refreshes.
- Steward stop receipts distinguish accepted requests, no-ops, rejections and unconfirmed results. Concurrent clicks for one target share a request, lost responses do not trigger automatic resends, and live and replayed tool receipts use the same rules.

- 同一数据目录的第二个服务实例会在恢复任务前被拒绝，避免取消仍在办理的待决或覆盖活实例信息。端口占用时保留原进程并顺延端口；默认旧数据迁移也受同一所有权保护。
- 对齐管家的中英提示与工具说明：少量受限只读即可回答的问题可以当轮处理，需要独立调查或执行的工作仍交办给线程。权限与外部材料污染检查保持生效。

- Reject a second service using the same data directory before recovery can alter active decisions or runtime identity. Occupied ports fall back without terminating their owner; default legacy-data migration uses the same ownership protection.
- Align Chinese and English steward prompts with existing tools: small, restricted reads can answer directly, while independent investigation and execution are delegated to threads. Existing permissions and untrusted-content checks remain in force.
