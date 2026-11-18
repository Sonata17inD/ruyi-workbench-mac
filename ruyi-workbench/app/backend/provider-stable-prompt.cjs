'use strict';

const { getPromptPack } = require('./prompt-registry.cjs');

function renderProviderStablePrompt({ provider, model, cwd, tools, identityOnly, config, runtimeIdentity }) {
  const label = String((provider && provider.label) || (provider && provider.id) || '模型端点').trim();
  const modelName = String(model || '').trim() || '(未指定模型)';
  const hasTools = Array.isArray(tools) && tools.length > 0;
  const lines = [];
  // [身份层]
  lines.push(getPromptPack(config && config.locale).identity({ label, modelName, cwd }));
  // [运行时身份层] - 108a
  if (!identityOnly) lines.push(getPromptPack(config && config.locale).runtimeIdentity(runtimeIdentity));
  // [界面渲染] - 145-W3:mermaid 成图 / 本地图片(版本级常量,稳定层;Markdown 与代码块那半句身份层已说过)。
  if (!identityOnly) lines.push(getPromptPack(config && config.locale).engineBrief.renderDiagram);
  if (hasTools) {
    // [工具协议层]
    lines.push(getPromptPack(config && config.locale).toolProtocol.intro);
    lines.push(getPromptPack(config && config.locale).toolProtocol.rules);
    lines.push(getPromptPack(config && config.locale).toolProtocol.batching);
    lines.push(getPromptPack(config && config.locale).toolProtocol.authorization);
    lines.push(getPromptPack(config && config.locale).toolProtocol.questioning);
    if ((tools || []).some(t => t && t.function && t.function.name === 'tool_search')) {
      lines.push(getPromptPack(config && config.locale).toolProtocol.onDemand);
    }
    lines.push(getPromptPack(config && config.locale).toolProtocol.priority);
    lines.push(getPromptPack(config && config.locale).toolProtocol.contextBudget);
    // C2(61 号文):会话草稿本何时用。工具表里有 scratchpad_write 才说(只有模型服务商普通会话主回合有;它常驻 core,
    // 会话第一回合起就在,这一行在会话内逐字节稳定,不破稳定层缓存)。子代理、管家、Claude/Kimi 引擎没有这个工具,也就没有这一行。
    if ((tools || []).some(t => t && t.function && t.function.name === 'scratchpad_write')) {
      lines.push(getPromptPack(config && config.locale).toolProtocol.scratchpad);
    }
  } else if (!identityOnly) {
    lines.push(getPromptPack(config && config.locale).noTools);
  }
  // [答复形状层] - 117v-V3(27 号文 §11.16.2 V3 行):结论先行。门控只有 !identityOnly ——
  //   · 排除 identity-only 探针(压缩摘要 06:997 / 10:1263 那两条调用逐字节不变,capabilities.e2e
  //     的身份泄漏守卫与 prompt-snapshot D13 那条路径都不受影响);
  //   · 【不】看 hasTools:纯对话的研究型线程(管家 steward_thread_new 开的那种)既没有 mission 账本、
  //     也进不了 softwareEngineering 那一包,它恰恰是这条规则唯一能落到的地方。理由与被修的那条
  //     head.summary 链路写在 06b 的 answerShape 头注里。
  if (!identityOnly) lines.push(getPromptPack(config && config.locale).answerShape);
  // [provider 层]
  const psp = String((provider && provider.systemPrompt) || '').trim();
  if (psp) lines.push(psp);
  return lines.join('\n');
}

module.exports = { renderProviderStablePrompt };
