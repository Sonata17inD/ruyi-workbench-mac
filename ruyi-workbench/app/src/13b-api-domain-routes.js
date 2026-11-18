const MigrationCenter = require('./backend/migration-center.cjs').createMigrationCenter({
  paths, nowIso, logEvent, VERSION, SKILL_ID_RE, process,
  MigrationTrashHooks: {
    helperPath: () => path.resolve(__dirname, '..', 'runtime', 'macos', 'ruyi-trash-helper'),
    run: (...args) => DesktopShell.runProcess(...args),
  },
  packages: { externalRoot, findRuyiPackageRootFor, ruyiPackageInfo, samePathKey, readInstallRegistry, writeInstallRegistry },
  config: { readConfig, mutateConfig, atomicWriteJson, agentMcpImportSources, classifyAgentMcpCandidate, generateMcpConfig, kimiMcpManagedIds },
  skills: { agentCliHomes, tildePath, SkillRegistry, syncAgentInstructionImports },
});
const handleMigrationApiRoutes = require('./backend/migration-routes.cjs').createMigrationRoutes({ migration: MigrationCenter });

const handleMcpApiRoutes = require('./backend/mcp-routes.cjs').createMcpRoutes({
  paths, logEvent, readConfig, mutateConfig, generateMcpConfig, resolveExternalMcpServers, handleMigrationApiRoutes,
  invalidateMcpRuntime, buildMcpConnectorInventory, MCP_COMPAT_MATRIX, probeMcpConnector, mutateMcpConnector,
});

const { steerSessionCore, handleSteerApiRoute } = require('./backend/session-steering.cjs').createSessionSteering({
  paths, activeChildren, safeSessionId, nowIso, logEvent, saveSession, buildUserEnvelope, writeToChild,
  VisualPipeline, sanitizeFsSegmentName, hasPendingQuestionForSession, STEER_QUEUE_MAX,
});

const handleAudioApiRoutes = require('./backend/audio-routes.cjs').createAudioRoutes({
  ASR_MAX_BODY_BYTES, PrivacyGateway, ToolboxHooks, nowIso, logEvent, readConfig, appendUsageLedger,
  voiceLexiconRead, voiceLexiconUpdate, resolveAsrFixProvider, providerFixCompletion, transcribeAudioViaProvider,
  resolveAsrProvider, asrFixModeOf, voiceLexiconAsrPromptFor, asrFixMessages, asrFixSanity, resolveAsrStreamProvider,
});

const { maybeTranscribeAudioAttachment, maybeOcrImageAttachment, maybeCompressImageAttachment } =
  require('./backend/attachment-enrichment.cjs').createAttachmentEnrichment({
    ASR_MAX_BODY_BYTES, readConfig, PrivacyGateway, activeOpenAiProvider,
    collectBridgedTools, resolveBridge, getBridgedClient,
    resolveAsrProvider, voiceLexiconAsrPromptFor, transcribeAudioViaProvider,
  });
