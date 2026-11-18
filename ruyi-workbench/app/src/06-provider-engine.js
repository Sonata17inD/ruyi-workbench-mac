// Compose the Provider helpers and prompt services used by the execution engines.
const { ERROR_CLASSES } = require('./backend/turn-error-classes.cjs');
const { TOOL_ITERATION_BUDGETS, resolveToolIterationBudget, shouldExtendToolIterationBudget } = require('./backend/tool-iteration-budget.cjs');
const {
  buildBrowserAutomationHint, buildToolCustomizationHint, readProjectMemory, buildSkillsPromptSection,
  buildPlaybookIndexSection, neutralizeAuthoredText,
} = require('./backend/prompt-context.cjs');

const { evalPlaybookAvailability, matchServiceEntry } = require('./backend/playbook-policy.cjs');
const { normalizePlaybook, loadAllPlaybooks, listPlaybooksWithAvailability, saveUserPlaybook, deleteUserPlaybook, playbookReuseSources, draftPlaybookFromSession } = require('./backend/playbooks.cjs').createPlaybooks({ safeSessionId, externalRoot, paths, safeJsonParse, getCapabilities, atomicWriteJson, loadSession, readConfig, activeOpenAiProvider, providerRawCompletion, appendUsageLedger });

const { createThreadBriefService, parseThreadBrief } = require('./backend/thread-brief.cjs');
const { maybeWriteThreadBrief, settleThreadBrief, updateAutomaticThreadTitle } = createThreadBriefService({
  safeSessionId, loadSession, updateSessionMeta, getSessionTitleOverride, setSessionTitleOverride,
  PrivacyGateway, providerRawCompletion,
  appendUsageLedger, RUYI_EVENTS, nowIso, logEvent,
});

const repairNodeJsonViaProvider = require('./backend/provider-raw-completion.cjs').createNodeJsonRepair({
  providerRawCompletion, appendUsageLedger,
});

function buildRuntimeIdentityFacts() {
  const host = (typeof RUNTIME !== 'undefined' && RUNTIME && RUNTIME.host) || '127.0.0.1';
  const port = (typeof RUNTIME !== 'undefined' && RUNTIME && RUNTIME.port) || DEFAULT_PORT;
  return {
    appName: APP_NAME,
    version: VERSION,
    launchMode: 'node',
    installDir: externalRoot(),
    dataDir: dataRoot(),
    address: 'http://' + host + ':' + port,
    instanceId: OVERLAY_ID,
  };
}

const { buildEngineEnvBrief, resolveEngineEnvBrief } = require('./backend/engine-env-brief.cjs').createEngineEnvBrief({
  appName: APP_NAME, buildRuntimeIdentityFacts, probeRgAsync,
});
const { buildStableSystemPrompt, buildVolatileParts, buildProviderSystemPrompt } = require('./backend/provider-prompt.cjs').createProviderPrompt({
  buildRuntimeIdentityFacts, buildEngineEnvBrief, toolPackForName,
  buildMemoryCheckPrompt, buildMemoryPromptSection,
  buildMissionPromptSection: (...args) => buildMissionPromptSection(...args),
});
