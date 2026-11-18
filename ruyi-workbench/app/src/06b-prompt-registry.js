// Explicit shared prompt-registry service.
const { PROMPT_EN, PROMPT_PACK_VERSION, PROMPT_ZH, getPromptPack, revertNoticeTurns } = require('./backend/prompt-registry.cjs');
const { appendMemorySection, clampAppendWithSkills, fenceSafeSlice, shrinkFencedSection } = require('./backend/prompt-budget.cjs');
const { appendResponseLanguagePolicy, appendTurnPolicies, buildAgentTeamHint, buildClaudeNativeAgentPolicy, buildPromptTaskContext, buildSoftwareEngineeringPolicy, softwareEngineeringTaskProfile } = require('./backend/turn-prompt-policy.cjs');
