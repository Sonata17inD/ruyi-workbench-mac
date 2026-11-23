import { knownAgentCliMeta } from './agent-cli-registry.js';
import { PROVIDER_REASONING_EFFORT_CHOICES, providerApiStyleMeta } from './provider-api-styles.js';

export function effortOptions(route, config) {
  if (route.engine !== 'openai') {
    return { values: knownAgentCliMeta(route.agentCliType)?.thinkingEfforts || [], current: config.claudeThinkingEffort || '' };
  }
  const provider = config.providers?.find(item => item.id === route.providerId);
  if (!provider) return { values: [], current: '' };
  const anthropic = providerApiStyleMeta(provider.apiStyle).anthropicOptions;
  return {
    provider, current: provider.reasoningEffort || '',
    enabled: anthropic ? provider.anthropicThinking !== 'off' : provider.reasoning,
    values: anthropic ? PROVIDER_REASONING_EFFORT_CHOICES.filter(v => v !== 'none' && v !== 'minimal') : PROVIDER_REASONING_EFFORT_CHOICES,
  };
}
