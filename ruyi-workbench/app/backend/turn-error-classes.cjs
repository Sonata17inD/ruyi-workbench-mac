'use strict';

const ERROR_CLASSES = {
  provider_misconfigured: { zh: '模型端点未配置或不可用', next: '到 设置 → 模型与服务 → 模型服务商 检查地址与密钥' },
  network_down: { zh: '网络不可用（当前离线）', next: '联网后重试；或改用离线可完成的任务' },
  permission_denied: { zh: '此操作被权限拒绝', next: '在弹窗中允许，或在 设置→权限 调整模式' },
  tool_error: { zh: '工具执行出错', next: '查看工具返回的错误详情，调整参数后重试' },
  idle_timeout: { zh: '回合空闲超时，已中止', next: '重新发送，或缩小单步任务范围' },
  // v0.8-S7: the repeated-call loop guard stopped the turn (≥5 identical consecutive tool calls). Distinct
  // from idle_timeout / the iteration-cap message — it means the model was stuck retrying the same call.
  tool_loop: { zh: '检测到重复的工具调用，已停止本轮', next: '换个说法或参数再试；若结果不对，先确认前一步的输出' },
  // v0.9-S5: the user rejected the execution plan in 计划模式 (真流程). No tool ran; the turn ended cleanly.
  plan_rejected: { zh: '你否决了本次执行计划', next: '补充要求后重新发起，或切换权限模式' },
  schema_failed: { zh: '节点输出不符合结构化契约', next: '检查 outputSchema；可能缺失的字段请显式允许 null' },
  evidence_missing: { zh: '节点缺少要求的工具执行证据', next: '确认节点工具权限，并让节点实际调用工具后再下结论' },
  vote_contract_failed: { zh: '投票节点输入格式不正确', next: '让每个投票前序明确输出 verdict 与 confidence' },
  dependency_cycle: { zh: '依赖图存在真实环或悬空依赖', next: '检查节点依赖方向和引用的节点 ID' },
  gate_rejected: { zh: '质量门给出不通过裁决', next: '查看 verdict、confidence 和 findings 后决定修复或接受' },
  // 125-P1(42 号文 §5-ter):把「能走到用户/管家面前的机器类」补齐。数过一遍才发现,修前表里 12 条,
  // 而 08 的 classifyNodeErrorText 三个默认出口(timeout / network / subagent_failed)—— 也就是**最常见
  // 的那几类** —— 一条都不在表里,于是管家只能说「未知类别(subagent_failed)」,并不比原始机器词强。
  // 既有 12 条一个字节不动(2.0 错误卡读的是同一张表,改它等于改那张卡的文案)。
  timeout: { zh: '这一步超时了', next: '稍后重试;或把这一步拆小一点再跑' },
  network: { zh: '网络访问失败', next: '检查网络后重试;暂时不通就先做不依赖联网的部分' },
  subagent_failed: { zh: '子代理没能完成这一步', next: '打开节点详情看它最后的输出,再决定重跑还是改任务' },
  no_progress: { zh: '连着几轮没有新进展,已停下', next: '换个做法或把任务拆开,原地重试解决不了' },
  semantic_stall: { zh: '反复产出相同结果,判为原地打转', next: '补上缺的信息,或换一种分解方式' },
  node_exception: { zh: '节点执行时抛了异常', next: '看错误详情,多半是参数或环境问题' },
  scheduler_error: { zh: '调度器兜底异常(节点没能正常收尾)', next: '这类多半是工作台自身的问题,留一条取证给开发者' },
  degraded_fail: { zh: '只拿到降级输出,按策略判失败', next: '重跑这个节点,或把质量门放宽' },
  worktree_error: { zh: '隔离工作树收尾失败', next: '看工作区是不是被占用,再重跑' },
  blocked: { zh: '被前面失败的节点挡住了', next: '先把前一步修好,它好了这一步会自己继续' },
  cancelled: { zh: '已被停止', next: '要接着做就自己按「继续」——工作台不会替你重开' },
  interrupted: { zh: '被中断了(插话或停止)', next: '先确认当时改到哪一步,再决定接着做还是重来' },
  propagate_cycle: { zh: '依赖传播时发现环', next: '检查节点之间的依赖方向' },
  gate_uncovered: { zh: '质量门要求的检查没覆盖到', next: '补上门要求的检查项再跑' },
  gate_unverified: { zh: '质量门的结论缺少验证', next: '让节点真的跑一次验证再下结论' },
  gate_unpropagated: { zh: '质量门结论没有传到下游', next: '检查下游节点有没有声明依赖' },
  claude_cli_error: { zh: 'Claude CLI 这一回合非正常退出', next: '看会话里最后的输出;多为 CLI 侧问题,可以重发' },
  kimi_acp_error: { zh: 'Kimi 这一回合非正常退出', next: '看会话里最后的输出;可以重发' },
  cli_missing: { zh: '找不到可用的 CLI', next: '到 设置 检查 CLI 路径' },
  launch_error: { zh: '这一回合根本没起来', next: '重发一次;仍然不行就看工作台日志' },
  // hunt2:主回合 429 已自动退避重试过几次仍被限流(09 runOpenAiTurn)。修前归 tool_error,把人引去查工具。
  rate_limited: { zh: '模型服务商限流(请求太频繁或额度用尽)', next: '稍等一会儿再发;频繁出现就到 设置 → 模型与服务 → 模型服务商 检查额度或换备用端点' },
  // 服务商自己报的错(HTTP 5xx / 其它 4xx、流内错误帧、Responses failed、Anthropic 拒答)。修前这些全落成 tool_error「工具执行出错」,
  // 把人引去查工具;它不是工具的错,也不一定是配置的错(404 / 401 / 403 另有 provider_misconfigured),多半是服务端暂时故障或请求被拒。
  provider_error: { zh: '模型服务商返回了错误', next: '多为服务端暂时故障或请求被拒:稍后重试;反复出现就看错误详情,或到 设置 → 模型与服务 → 模型服务商 检查模型名与地址' },
};

module.exports = { ERROR_CLASSES };
