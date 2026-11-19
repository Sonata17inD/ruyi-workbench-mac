'use strict';
const { nativeToolTier } = require('./native-tool-tiers.cjs');

// v2.6 (loop guard 分层): 同签名连击(连续相同 name+rawArgs)对「无副作用」工具不应 abort ——
// 轮询/等待原语(相同参数反复调用是其设计语义: wait_agents 等后台 run 结束、shell_poll 读增量输出)
// 完全豁免同签名连击(不累计/不 warn/不 abort),无进展由语义指纹判定;只读工具(重复读无害)只 warn
// 不 abort;有副作用工具(edit/exec)保持 5 次 abort(重复执行=重复破坏)。
const LOOP_POLLING_TOOLS = new Set(['wait_agents', 'shell_poll']);
function loopAbortExempt(name) { return LOOP_POLLING_TOOLS.has(String(name || '').replace(/^.+?__/, '')); } // 轮询原语: 完全豁免
function loopWarnOnly(name) { return nativeToolTier(String(name || '').replace(/^.+?__/, '')) === 'read'; } // 无副作用只读: 只 warn 不 abort

// P2-14(30号文§3 总表): 死循环护栏数值 —— 主回合(09-workflow.js 的 LOOP_WARN_AT/LOOP_ABORT_AT/
// LOOP_RECOVERY_MAX)与子代理(08-agent-runs.js 的 SUB_LOOP_WARN_AT/SUB_LOOP_ABORT_AT/SUB_LOOP_RECOVERY_MAX)
// 各写一份完全相同的数值(3/5/2),两处注释互相点名「对称」。只抽这三个数值,不抽判定逻辑 —— 两边命中之后
// 的「配对铁律补答」各有必要差异(主回合数 toolCalls 数组、子代理数 subHistory 消息数组;主回合额外记
// mission 停滞账本、子代理不记;子代理事件带 subagentId/scope:'subagent'),强行合并成参数化大函数收益
// 不抵风险,明确不做。09/08 两处保留各自的局部变量名(LOOP_*/SUB_LOOP_*),只把右侧字面量改成引用这里。
const LOOP_GUARD_LIMITS = Object.freeze({ WARN_AT: 3, ABORT_AT: 5, RECOVERY_MAX: 2 });

module.exports = { loopAbortExempt, loopWarnOnly, LOOP_GUARD_LIMITS };
