'use strict';

// Risk tier per tool → drives permission gating in the native loop (read = auto-allow).
const NATIVE_TOOL_TIER = {
  threads_search: 'read', thread_read: 'read',
  permission_prompt: 'exec', // CLI 权限桥(由 --permission-prompt-tool 触达);原靠 unknown→exec 兜底,第41波显式化
  workbench_memory_list: 'read', workbench_memory_read: 'read', workbench_memory_propose: 'read',
  workbench_memory_relation_propose: 'read', workbench_memory_revise: 'read', workbench_memory_relation_revoke: 'read',
  observation_recall: 'read', // 105a: 只读当前会话快照,授权来自 ctx 会话归属 → auto-allow
  checkpoint_list: 'read', // C4: 只读当前会话的检查点索引与撤销记录(会话取自 ctx,不触文件路径、不回滚;撤销只能由用户在界面做)→ auto-allow
  list_tools: 'read', tool_search: 'read', tool_load: 'read', tool_invoke_read: 'read', tool_invoke_edit: 'edit', tool_invoke_exec: 'exec',
  propose_task: 'read', send_to_agent: 'read', // 本地协作元工具：提案/消息入队及账本记账，不改变外部文件或用户授权。
  request_user_input: 'read', // waits for an explicit UI answer; no filesystem/exec side effect
  file_read: 'read', file_list: 'read', file_search: 'read', glob: 'read', project_snapshot: 'read', git_status: 'read',
  git_diff: 'read', git_log: 'read', // v1.0-S4: read-only git inspection → auto-allow
  git_commit: 'exec', // v1.0-S4: commit triggers .git/hooks (arbitrary code) → must be exec (never lower)
  dependency_inventory: 'read', code_review_scan: 'read', frontend_audit: 'read', claude_md_audit: 'read', docs_search: 'read', codebase_symbol_search: 'read', debug_hypothesis: 'read', data_profile: 'read',
  mcp_list: 'read', mcp_configure: 'exec',
  todo_write: 'read', // v0.8-S3: writing the task list is a planning act, not a filesystem/exec mutation → auto-allow
  mission_update: 'read', // 第26波b: 更新任务账本是规划/元数据写,非文件/exec 变更 → auto-allow
  // C2(61 号文):会话草稿本与 todo_write 同类 —— 只写工作台自有的会话旁车(sessions/<id>.scratchpad.json),不碰用户文件、
  // 不执行任何东西,会话只取回合 ctx(12 handler) → read 档 auto-allow。计划阶段也放行(见 09 PLAN_DISCOVERY_BLOCKED_TOOLS 头注)。
  scratchpad_write: 'read',
  thread_title_update: 'read',
  workbench_self_status: 'read', // 108c: 只读自状态(版本/位置/端口/健康/计数/设置掩码),不触文件路径 → auto-allow
  // 116c(27 号文 §3.5 tier 分档):管家工具族。观察族 read(只读如意自身账面,零副作用);线程族 edit
  // (建线程/递话/改名,全部返回 undoRef 可撤销);决策族 exec(替用户答复待决、控制班组运行,最高危)。
  // 记忆族按「管家记忆自由」定 edit —— 写的是管家自己的记忆文件,不触外部世界。
  steward_self_status: 'read', steward_threads_search: 'read', steward_thread_status: 'read',
  steward_thread_read: 'read', steward_runs_status: 'read', steward_inbox_read: 'read',
  steward_usage: 'read', steward_health: 'read', steward_audit_tail: 'read',
  // 116g: 事项级只读视图归观察族 read —— 它只读事项文件与既有投影,零副作用。
  steward_missions: 'read',
  // 129b: 三张「有哪些可选」的只读清单同归 read —— 只读如意自己的注册表/配置/模板目录,
  // 零副作用、零外部内容(与 129d 的「眼睛」那四件分界线就在这一句上)。
  steward_skills: 'read', steward_providers: 'read', steward_playbooks: 'read',
  // 129d: 眼睛四件也是 read —— 它们只读、不改世界。「读了之后不能再自己动手」由污染闸管,
  // 不是靠把它们归成 edit(归成 edit 只会让读本身变难,挡不住读完之后的那个写)。
  steward_web_search: 'read', steward_web_fetch: 'read', steward_file_read: 'read',
  steward_thread_artifact_read: 'read',
  // 129f: 叫人归 read —— 它不改世界,只是把一句话送到屏幕上(三档都可用)。
  steward_notify: 'read',
  steward_thread_new: 'edit', steward_thread_continue: 'edit', steward_thread_rename: 'edit',
  // 129e: 改工作目录归线程族 edit(它改的是线程元数据,不执行任何东西)。
  steward_thread_workspace: 'edit',
  // 116-2a: 线程权限收紧归线程族 edit —— 它只能【降】档(放宽是永久豁免第 2 条,机器上就走不通),
  // 收紧本身是保守动作,且返回 undoRef 可一键改回;给 exec 反而会让「先收紧再动手」在低档线程上失效。
  steward_thread_permission: 'edit',
  // 116-2b: 插话补充归线程族 edit —— 它只是往【已在跑】的回合里补一句上下文(不新起回合、不放宽
  // 任何权限,目标回合自己的权限门一字未动),与递话/改名同一档。
  steward_thread_note: 'edit',
  steward_thread_prioritize: 'edit',   // 116h:插队只动队列顺序,不改文件不动世界,归线程族 edit
  steward_decide: 'exec', steward_run_action: 'exec',
  // 117m-A4: 线程级停止与 run_action 同族(决策族 exec)—— 它真的去掐一个在跑的子进程/在途请求。
  // 归 exec 是按「动作强度」定档,不是按「危险方向」:它是收紧类,13g 内部对任何权限档都放行。
  steward_thread_stop: 'exec',
  // 记忆族整族 edit(含只读的 search):27 号文 §3.5「内容管理」按族定档,116c 交办单同口径。
  // search 本身零副作用,给 edit 只是让整族在权限面上同进同退,不额外放宽任何东西。
  steward_memory_write: 'edit', steward_memory_veto: 'edit', steward_memory_search: 'edit',
  // 116-2e(§3.5 工具面表「如意设置」/「内容管理」两行):config_get 只读掩码后的配置、零副作用,归
  // read(与观察族同档);config_set 真的改工作台的行为,exec。内容管理:playbook 起草只出草稿不落盘,
  // 归 edit;技能启停改的是那条线程下一回合的工具面与提示词、速查开的是一条真会动世界的线程,两者 exec。
  steward_config_get: 'read', steward_config_set: 'exec',
  steward_bot_setup: 'edit', // inspect or prepare a disabled inbox only; activation is a separate local UI operation
  steward_playbook_draft: 'edit', steward_skill_toggle: 'exec', steward_quick_ask: 'exec',
  // 123-M2(37 号文 §3.5):定时任务六件归「如意设置」族 —— list 只读、零副作用,归 read;
  // 另五件都改的是【如意自己账面上的一张表】(任务定义),不动文件、不动外部世界,归 edit。
  // 特别是 run_now:它自己不动世界,真正会动世界的是那一次回合,而那一次回合走的是任务自带的
  // permissionMode(天花板 = 全局档,永不含 bypass),边界在那儿,不在这张分档表上。
  steward_schedule_list: 'read',
  steward_schedule_create: 'edit', steward_schedule_pause: 'edit', steward_schedule_resume: 'edit',
  steward_schedule_run_now: 'edit', steward_schedule_delete: 'edit',
  skill_read: 'read', // v1 技能体系: 只读已启用技能的 SKILL.md + 目录清单(路径受限该技能目录内)→ auto-allow
  // 61 号文 C1:Playbook / 技能清单与 Playbook 步骤文本 —— 只读如意自己的注册表与模板目录,零副作用 → auto-allow。
  // 「读到模板」不等于「被授权照做」:照做须用户点名或明确同意,由结果 note + 系统提示尾行讲明,不靠把它们归成 edit。
  playbook_list: 'read', playbook_read: 'read', skill_list: 'read',
  web_search: 'read', web_fetch: 'read', // v0.9-S9: read-only network reads (no local mutation) → auto-allow (SSRF-guarded)
  file_write: 'edit', file_edit: 'edit', file_delete: 'edit', // v0.8-S4a: delete is journaled (revertible) → edit tier
  // v1.1-W2 (T1): 移动/复制/压缩/解压/下载 —— 均落盘且经检查点(可撤销) → edit tier。
  file_move: 'edit', file_copy: 'edit', archive_zip: 'edit', archive_unzip: 'edit', http_download: 'edit',
  shell_run: 'exec', script_run: 'exec', browser_open: 'exec', office_open: 'exec',
  desktop_screenshot: 'exec', http_request: 'exec',
  // 127-114c③(26 号文 §3):读本地音频后出网转写 —— 用户文件内容离开本进程,与「文件出网」同档 exec。
  audio_transcribe: 'exec',
  audio_inspect: 'read', media_probe: 'read', code_check: 'read', acceptance_report: 'edit',
  orchestrate_agents: 'exec', // 代理模式 v2:委派子代理是最高特权的原生动作 → exec 档(旧 spawn_agent 已并入)
  spawn_agent: 'exec', // 137 集成:兼容口仍在注册表(旧模型调它 → MCP 子进程翻译成单节点 orchestrate),档位必须与 orchestrate_agents 同为 exec,不能因缺声明落到低档
  wait_agents: 'read',
  agent_result: 'read',
  // v0.8-S2 shell session族: listing is read-only; start/send/poll/kill mutate state → exec.
  shell_list: 'read', shell_start: 'exec', shell_send: 'exec', shell_poll: 'exec', shell_kill: 'exec',
};

function knownNativeToolTier(name) {
  return Object.hasOwn(NATIVE_TOOL_TIER, name) ? NATIVE_TOOL_TIER[name] : null;
}

function nativeToolTier(name) {
  return knownNativeToolTier(name) || 'exec';
}

module.exports = { NATIVE_TOOL_TIER, nativeToolTier, knownNativeToolTier };
