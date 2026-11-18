# 后端模块依赖图（第 103b／104 波）

> 本文件由 `node dev-harness/module-dependency-graph.js --write` 从 `app/src/manifest.json` 与源码生成。请勿手改。
> `provides/requires` 是构建期拼接作用域的显式契约；运行时仍执行单文件 `app/server.js`。

## 摘要

| 模块 | 顶层符号 | 跨模块符号引用 | 模块边 | 前向边 | 重复导出 | 强连通分量 |
|---:|---:|---:|---:|---:|---:|---:|
| 94 | 2850 | 3359 | 637 | 21 | 0 | 0 |

“前向边”表示较早拼接的模块引用较晚模块，依赖函数提升或延迟执行；它不是自动判错，但已由债务上限锁住，禁止无评审增加。

## 模块清单

| # | 模块 | 层 | provides | requires | 直接依赖 |
|---:|---|---|---:|---:|---:|
| 0 | `00-platform-runtime.js` | bootstrap | 3 | 0 | 0 |
| 1 | `00-boot.js` | bootstrap | 183 | 1 | 1 |
| 2 | `01o-execution-state.js` | foundation | 9 | 0 | 0 |
| 3 | `00b-ruyi-names.js` | bootstrap | 5 | 0 | 0 |
| 4 | `01b-route-auth.js` | foundation | 1 | 0 | 0 |
| 5 | `01c-runtime-flags.js` | foundation | 36 | 0 | 0 |
| 6 | `01e-permission-modes.js` | foundation | 13 | 0 | 0 |
| 7 | `01f-agent-cli-types.js` | foundation | 4 | 0 | 0 |
| 8 | `01g-server-ownership.js` | foundation | 1 | 0 | 0 |
| 9 | `01n-desktop-automation.js` | foundation | 2 | 0 | 0 |
| 10 | `01h-process-runtime.js` | foundation | 23 | 6 | 2 |
| 11 | `01i-privacy-rules.js` | foundation | 1 | 0 | 0 |
| 12 | `01h-privacy-core.js` | foundation | 1 | 0 | 0 |
| 13 | `01m-privacy-regex.js` | foundation | 1 | 1 | 1 |
| 14 | `01j-local-crypto.js` | foundation | 2 | 0 | 0 |
| 15 | `03a-privacy-gateway.js` | foundation | 10 | 2 | 2 |
| 16 | `04h-provider-http.js` | foundation | 16 | 1 | 1 |
| 17 | `04i-provider-anthropic.js` | foundation | 59 | 1 | 1 |
| 18 | `04i-provider-wire.js` | foundation | 45 | 21 | 2 |
| 19 | `01-config.js` | foundation | 130 | 31 | 6 |
| 20 | `01k-credential-vault.js` | foundation | 1 | 7 | 4 |
| 21 | `01l-credential-recovery.js` | foundation | 2 | 11 | 3 |
| 22 | `02c-turn-segments.js` | foundation | 1 | 0 | 0 |
| 23 | `02d-session-overrides.js` | foundation | 11 | 1 | 1 |
| 24 | `02e-session-engine-route.js` | foundation | 4 | 1 | 1 |
| 25 | `02f-turn-effect-kinds.js` | foundation | 4 | 0 | 0 |
| 26 | `02g-desktop-executions.js` | foundation | 1 | 4 | 1 |
| 27 | `02h-desktop-ledger.js` | foundation | 1 | 9 | 3 |
| 28 | `06f-autonomy-grants.js` | engine | 13 | 4 | 1 |
| 29 | `02-session-store.js` | foundation | 236 | 59 | 9 |
| 30 | `03-bridge-guard.js` | foundation | 68 | 28 | 5 |
| 31 | `04-visual-pipeline.js` | foundation | 1 | 0 | 0 |
| 32 | `04-permission-runtime.js` | foundation | 117 | 54 | 6 |
| 33 | `04g-session-deletion.js` | foundation | 3 | 37 | 7 |
| 34 | `04f-toolbox-services.js` | foundation | 0 | 9 | 4 |
| 35 | `04j-hanzi-pinyin.js` | foundation | 1 | 0 | 0 |
| 36 | `04j-voice-lexicon.js` | foundation | 1 | 0 | 0 |
| 37 | `04j-voice-learn.js` | foundation | 1 | 0 | 0 |
| 38 | `06b-prompt-registry.js` | engine | 16 | 0 | 0 |
| 39 | `06c-agent-workflow-catalog.js` | engine | 11 | 2 | 2 |
| 40 | `04l-skill-registry.js` | foundation | 4 | 6 | 2 |
| 41 | `04m-voice-service.js` | foundation | 11 | 10 | 7 |
| 42 | `06v-operational-services.js` | engine | 15 | 13 | 5 |
| 43 | `06w-capability-service.js` | engine | 9 | 13 | 5 |
| 44 | `05-claude-engine.js` | engine | 3 | 121 | 24 |
| 45 | `05b-kimi-bridge.js` | engine | 47 | 58 | 11 |
| 46 | `06-provider-engine.js` | engine | 32 | 29 | 10 |
| 47 | `06h-retrieval-index.js` | engine | 4 | 0 | 0 |
| 48 | `06i-steward-core.js` | engine | 167 | 1 | 1 |
| 49 | `06d-memory-domain.js` | engine | 157 | 36 | 6 |
| 50 | `06e-mission-domain.js` | engine | 9 | 33 | 6 |
| 51 | `06g-resource-leases.js` | engine | 9 | 2 | 1 |
| 52 | `06j-scheduler-core.js` | engine | 44 | 0 | 0 |
| 53 | `06k-config-patch.js` | engine | 1 | 21 | 7 |
| 54 | `07-autonomy.js` | orchestration | 112 | 75 | 16 |
| 55 | `08-agent-runs.js` | orchestration | 76 | 108 | 23 |
| 56 | `09b-replan-ledger.js` | orchestration | 8 | 4 | 1 |
| 57 | `09-workflow.js` | orchestration | 22 | 195 | 24 |
| 58 | `09b-agent-recovery.js` | orchestration | 3 | 19 | 8 |
| 59 | `10-context-governance.js` | orchestration | 66 | 31 | 12 |
| 60 | `10a-session-turn.js` | orchestration | 4 | 45 | 16 |
| 61 | `11-native-tools.js` | tools | 52 | 46 | 11 |
| 62 | `11b-file-text-io.js` | tools | 1 | 0 | 0 |
| 63 | `11c-file-visual-io.js` | tools | 1 | 1 | 1 |
| 64 | `11d-media-inspection.js` | tools | 1 | 1 | 1 |
| 65 | `12-tool-dispatch.js` | tools | 88 | 171 | 26 |
| 66 | `13-http-router.js` | transport | 39 | 277 | 41 |
| 67 | `13b-api-domain-routes.js` | transport | 41 | 68 | 13 |
| 68 | `13d-core-domain-routes.js` | transport | 53 | 149 | 21 |
| 69 | `13e-pretender-index.js` | transport | 62 | 43 | 7 |
| 70 | `13i-steward-inbox.js` | transport | 90 | 29 | 7 |
| 71 | `13j-steward-tool-base.js` | transport | 80 | 23 | 9 |
| 72 | `13aa-steward-delivery.js` | unclassified | 10 | 31 | 7 |
| 73 | `13k-steward-threads.js` | transport | 60 | 127 | 18 |
| 74 | `13l-steward-ops.js` | transport | 54 | 133 | 22 |
| 75 | `13g-steward.js` | transport | 20 | 75 | 12 |
| 76 | `13m-steward-runner-base.js` | transport | 49 | 16 | 7 |
| 77 | `13n-steward-arbiter.js` | transport | 42 | 21 | 7 |
| 78 | `13o-steward-runner-prompt.js` | transport | 22 | 67 | 17 |
| 79 | `13p-steward-runner-actions.js` | transport | 35 | 63 | 12 |
| 80 | `13q-steward-runner-turn.js` | transport | 45 | 86 | 22 |
| 81 | `13h-steward-runner.js` | transport | 8 | 49 | 13 |
| 82 | `13r-event-stream.js` | transport | 3 | 18 | 7 |
| 83 | `13s-scheduler.js` | transport | 6 | 29 | 9 |
| 84 | `13t-steward-schedule.js` | transport | 10 | 29 | 10 |
| 85 | `13u-migration-center.js` | transport | 63 | 36 | 5 |
| 86 | `13v-external-channel-protocols.js` | transport | 1 | 3 | 1 |
| 87 | `13x-external-channel-delivery.js` | transport | 1 | 2 | 1 |
| 88 | `13y-external-bot-credentials.js` | transport | 1 | 4 | 3 |
| 89 | `13z-external-bot-discovery.js` | transport | 1 | 0 | 0 |
| 90 | `13ab-privacy-api.js` | unclassified | 1 | 19 | 13 |
| 91 | `13w-external-bots.js` | transport | 67 | 23 | 8 |
| 92 | `13ac-desktop-execution-runtime.js` | unclassified | 1 | 22 | 8 |
| 93 | `14-main.js` | entrypoint | 1 | 588 | 50 |

## 模块边

| 调用方 | 提供方 | 方向 | 符号 |
|---|---|---|---|
| `00-boot.js` | `00-platform-runtime.js` | backward | `platformRuntimeEnvironment` |
| `01-config.js` | `00-boot.js` | backward | `CONFIG_SCHEMA`, `DEFAULT_PORT`, `RUYI_EVENTS`, `SKILL_ID_RE`, `VERSION`, `agentCliHomes`, `crypto`, `dataRoot`, `ensureDirs`, `externalRoot`, `findRuyiPackageRootFor`, `fs`, `fsp`, `logEvent`, `nowIso`, `path`, `pathWithinRoot`, `paths`, `safeJsonParse`, `samePathKey`, `text` |
| `01-config.js` | `01f-agent-cli-types.js` | backward | `AGENT_CLI_TYPES`, `normalizeAgentCliType` |
| `01-config.js` | `01h-privacy-core.js` | backward | `PrivacyCore` |
| `01-config.js` | `01h-process-runtime.js` | backward | `DesktopShell`, `ProcessRuntime`, `existsExecutableAsync`, `spawnProbeAsync`, `spawnProbeSync` |
| `01-config.js` | `01o-execution-state.js` | backward | `activeChildren` |
| `01-config.js` | `04i-provider-wire.js` | backward | `sanitizeProvider` |
| `01h-process-runtime.js` | `00-boot.js` | backward | `RUYI_PATH_BEFORE_VENDOR`, `externalRoot`, `path`, `ruyiVendorBinDir`, `spawnDetachedChecked` |
| `01h-process-runtime.js` | `01n-desktop-automation.js` | backward | `MacDesktopAutomation` |
| `01k-credential-vault.js` | `00-boot.js` | backward | `fsp`, `path`, `paths` |
| `01k-credential-vault.js` | `01-config.js` | backward | `DurableJsonStore`, `atomicWriteJson` |
| `01k-credential-vault.js` | `01h-privacy-core.js` | backward | `PrivacyCore` |
| `01k-credential-vault.js` | `01j-local-crypto.js` | backward | `LocalSecretCrypto` |
| `01l-credential-recovery.js` | `00-boot.js` | backward | `fsp`, `path`, `paths` |
| `01l-credential-recovery.js` | `01-config.js` | backward | `DurableJsonStore`, `atomicWriteJson`, `configEmitWritten`, `invalidateConfigRecoveryState`, `mutateConfig`, `normalizeConfig`, `readConfig` |
| `01l-credential-recovery.js` | `01h-privacy-core.js` | backward | `PrivacyCore` |
| `01m-privacy-regex.js` | `01h-privacy-core.js` | backward | `PrivacyCore` |
| `02-session-store.js` | `00-boot.js` | backward | `DesktopExecutionHooks`, `EventStreamHooks`, `RUYI_EVENTS`, `SESSION_SCHEMA`, `SKILL_ID_RE`, `SessionExecutionHooks`, `clearDeletedSession`, `ensureDirs`, `fsp`, `logEvent`, `makeId`, `normalizeCwd`, `nowIso`, `os`, `path`, `pathWithinRoot`, `paths`, `runKeyedChain`, `safeJsonParse`, `sessionAssociatedSaveIsTombstoned`, `sessionSaveIsTombstoned`, `text` |
| `02-session-store.js` | `01-config.js` | backward | `DurableJsonStore`, `assertSessionIdForPath`, `atomicWriteJson`, `mutateConfig`, `noteSessionsDirOwnWrite`, `readConfig`, `readFileTail`, `safeSessionId`, `selectedAgentCli`, `sessionPath` |
| `02-session-store.js` | `01c-runtime-flags.js` | backward | `MEMORY_FIXED_SELECTION_HARD_MAX` |
| `02-session-store.js` | `01e-permission-modes.js` | backward | `resolvePermissionMode` |
| `02-session-store.js` | `01h-process-runtime.js` | backward | `DesktopShell`, `gitReadOnlyGuard`, `runGit` |
| `02-session-store.js` | `01o-execution-state.js` | backward | `activeAgentRuns`, `activeChildren`, `pendingPermissions`, `pendingPlans`, `pendingQuestions`, `sessionWriteChains`, `turnSettlers` |
| `02-session-store.js` | `02d-session-overrides.js` | backward | `applySessionDesktopToolsOverride`, `applySessionPermissionModeOverride`, `normalizeSessionDesktopTools`, `normalizeSessionPermissionMode`, `sessionDesktopToolsOverrides`, `sessionEngineRouteOverrides`, `sessionEngineRouteScopeOverrides`, `sessionPermissionModeOf`, `sessionPermissionModeOverrides` |
| `02-session-store.js` | `02e-session-engine-route.js` | backward | `inferSessionEngineRoute`, `normalizeSessionEngineRoute`, `sessionEngineRouteFromConfig` |
| `02-session-store.js` | `03-bridge-guard.js` | forward | `guardFileToolPath`, `guardWorkspacePath`, `realpathForContainment` |
| `02d-session-overrides.js` | `01e-permission-modes.js` | backward | `PERMISSION_MODES` |
| `02e-session-engine-route.js` | `01f-agent-cli-types.js` | backward | `normalizeAgentCliType` |
| `02g-desktop-executions.js` | `00-boot.js` | backward | `copyOrdinaryJsonData`, `crypto`, `executionArgumentsDigest`, `json` |
| `02h-desktop-ledger.js` | `00-boot.js` | backward | `copyOrdinaryJsonData`, `crypto`, `fsp`, `json`, `nowIso`, `path`, `runKeyedChain` |
| `02h-desktop-ledger.js` | `01-config.js` | backward | `DurableJsonStore` |
| `02h-desktop-ledger.js` | `02g-desktop-executions.js` | backward | `prepareDesktopExecutionArguments` |
| `03-bridge-guard.js` | `00-boot.js` | backward | `AUTOEXEC_DENYLIST`, `BRIDGED_WRITE_PATH_ARGS`, `URL`, `agentCliHomes`, `dataRoot`, `ensureDataRootReal`, `externalRoot`, `fs`, `fsp`, `isSensitiveDataPath`, `isSensitiveHardlinkAlias`, `isSensitiveHardlinkStat`, `logEvent`, `macPathAnchor`, `os`, `path`, `pathWithinAnyRoot`, `pathWithinRoot`, `sameFileIdentity`, `samePathKey`, `sensitiveDataRoots`, `spawnDetachedChecked` |
| `03-bridge-guard.js` | `00-platform-runtime.js` | backward | `platformOpenSpawn` |
| `03-bridge-guard.js` | `01-config.js` | backward | `mcpDropInDirs`, `readConfig`, `toolboxComponentsDir` |
| `03-bridge-guard.js` | `02f-turn-effect-kinds.js` | backward | `unprefixedBridgedName` |
| `03-bridge-guard.js` | `04i-provider-wire.js` | backward | `activeOpenAiProvider` |
| `03a-privacy-gateway.js` | `01h-privacy-core.js` | backward | `PrivacyCore` |
| `03a-privacy-gateway.js` | `01m-privacy-regex.js` | backward | `PrivacyRegex` |
| `04-permission-runtime.js` | `00-boot.js` | backward | `DesktopExecutionHooks`, `MCP_TOOLS`, `OVERLAY_ID`, `SessionExecutionHooks`, `URL`, `VERSION`, `_expandMcpVar`, `collectDisplayUrlRestores`, `crypto`, `decodeTextFileBytes`, `ensureDirs`, `executionArgumentsDigest`, `fsp`, `logEvent`, `makeId`, `maskKey`, `mcpArgsForDisplay`, `nowIso`, `path`, `paths`, `redact`, `restoreExternalMcpServerSecrets`, `safeJsonParse`, `safeUrlForDisplay`, `sanitizeExternalMcpServer`, `text` |
| `04-permission-runtime.js` | `00b-ruyi-names.js` | backward | `RUYI_MCP_SERVER_ID`, `isRuyiMcpServerId` |
| `04-permission-runtime.js` | `01-config.js` | backward | `BROWSER_AUTOMATION_MODES`, `detectDesktopMcp`, `enabledToolboxComponents`, `ensureDesktopMcpWarm`, `generateMcpConfig`, `invalidateMcpDropInCache`, `mutateConfig`, `prepareAgentCliSpawn`, `readConfig`, `resolveExternalMcpServers`, `safeSessionId`, `scanMcpDropIns`, `selectedAgentCli` |
| `04-permission-runtime.js` | `01h-process-runtime.js` | backward | `ProcessRuntime`, `killChildTree` |
| `04-permission-runtime.js` | `01o-execution-state.js` | backward | `activeChildren`, `pendingPermissions`, `pendingPlans`, `pendingQuestions`, `turnSettlers` |
| `04-permission-runtime.js` | `02-session-store.js` | backward | `readInterventions`, `readSessionHeadResilient`, `registerIntervention`, `sessionMissionId`, `settleIntervention`, `transitionInterventionState` |
| `04f-toolbox-services.js` | `00-boot.js` | backward | `logEvent`, `redact`, `safeJsonParse` |
| `04f-toolbox-services.js` | `01-config.js` | backward | `ToolboxRegistry`, `mutateConfig`, `readConfig` |
| `04f-toolbox-services.js` | `01h-process-runtime.js` | backward | `ProcessRuntime`, `killChildTree` |
| `04f-toolbox-services.js` | `04-permission-runtime.js` | backward | `ToolboxHooks` |
| `04g-session-deletion.js` | `00-boot.js` | backward | `RUYI_EVENTS`, `logEvent`, `markSessionDeleted`, `paths` |
| `04g-session-deletion.js` | `01-config.js` | backward | `assertSessionIdForPath`, `safeSessionId`, `sessionPath` |
| `04g-session-deletion.js` | `01o-execution-state.js` | backward | `activeAgentRuns`, `activeChildren`, `sessionWriteChains`, `turnSettlers` |
| `04g-session-deletion.js` | `02-session-store.js` | backward | `AgentRunStore`, `SESSION_TOMBSTONE`, `SessionPersistence`, `agentRunDir`, `dropInterventionSessionState`, `dropSessionBodyState`, `dropSessionTitleOverride`, `interventionFilePath`, `journalDir`, `listSessions`, `missionChangeFilePath`, `missionIndexRemove`, `readMissionSessionHead`, `removeSessionNotes`, `scheduleSessionIndexUpdate`, `sessionBodyPaths`, `sessionMissionId`, `sessionScratchpadChains`, `sessionScratchpadPath`, `stopMissionAgentRuns` |
| `04g-session-deletion.js` | `02d-session-overrides.js` | backward | `sessionDesktopToolsOverrides`, `sessionEngineRouteOverrides`, `sessionEngineRouteScopeOverrides`, `sessionPermissionModeOverrides` |
| `04g-session-deletion.js` | `04-permission-runtime.js` | backward | `stopSession` |
| `04g-session-deletion.js` | `06f-autonomy-grants.js` | backward | `revokeAllGrants` |
| `04h-provider-http.js` | `03a-privacy-gateway.js` | backward | `PrivacyGateway` |
| `04i-provider-anthropic.js` | `04h-provider-http.js` | backward | `providerBaseWithV1` |
| `04i-provider-wire.js` | `04h-provider-http.js` | backward | `providerApiBase`, `providerBaseWithV1`, `providerCompletionUrl`, `providerPostJsonOnce`, `providerRequestHeaders` |
| `04i-provider-wire.js` | `04i-provider-anthropic.js` | backward | `anthropicApiBase`, `anthropicMessagesUrl`, `anthropicModelsUrl`, `anthropicRequestHeaders`, `anthropicRetryBodyOn400`, `applyAnthropicEffort`, `applyAnthropicTemperature`, `applyAnthropicTools`, `createAnthropicStreamDecoder`, `decodeAnthropicCompletion`, `encodeAnthropicMessages`, `encodeAnthropicQuick`, `normalizeAnthropicAuth`, `normalizeAnthropicFallbacks`, `normalizeAnthropicThinking`, `normalizeAnthropicUsage` |
| `04l-skill-registry.js` | `00-boot.js` | backward | `SKILL_ID_RE`, `agentCliHomes`, `externalRoot`, `paths`, `safeJsonParse` |
| `04l-skill-registry.js` | `03a-privacy-gateway.js` | backward | `readIfExists` |
| `04m-voice-service.js` | `00-boot.js` | backward | `logEvent`, `paths` |
| `04m-voice-service.js` | `01-config.js` | backward | `DurableJsonStore`, `readConfig` |
| `04m-voice-service.js` | `02-session-store.js` | backward | `appendUsageLedger` |
| `04m-voice-service.js` | `03a-privacy-gateway.js` | backward | `PrivacyGateway` |
| `04m-voice-service.js` | `04-permission-runtime.js` | backward | `ToolboxHooks` |
| `04m-voice-service.js` | `04h-provider-http.js` | backward | `providerBaseWithV1`, `providerPostJsonOnce` |
| `04m-voice-service.js` | `04i-provider-wire.js` | backward | `providerWireProtocol` |
| `05-claude-engine.js` | `00-boot.js` | backward | `DeliveryHooks`, `DesktopExecutionHooks`, `EventStreamHooks`, `RUYI_EVENTS`, `buildAttachmentPrompt`, `buildDeliveryRevisionPrompt`, `claudeCostFields`, `createCappedDiagnosticText`, `createNdjsonLineFeeder`, `crypto`, `fsp`, `lastAssistantEngine`, `logEvent`, `normalizeCwd`, `nowIso`, `path`, `paths`, `redact`, `safeJsonParse` |
| `05-claude-engine.js` | `00b-ruyi-names.js` | backward | `RUYI_MCP_CLI_TOOL_PREFIX` |
| `05-claude-engine.js` | `01-config.js` | backward | `agentCliLauncherUsable`, `buildClaudeAgentDefinitions`, `buildModelHint`, `buildUserEnvelope`, `decodeClaudeCliText`, `discoverModels`, `effectiveAnthropicEnv`, `generateSessionMcpConfig`, `isAskUserTool`, `offlineModelList`, `prepareAgentCliSpawn`, `readConfig`, `selectedAgentCli`, `syncMcpServersToKimi`, `writeToChild` |
| `05-claude-engine.js` | `01e-permission-modes.js` | backward | `CLAUDE_PERMISSION_MODE_MAP` |
| `05-claude-engine.js` | `01f-agent-cli-types.js` | backward | `AGENT_CLI_TYPES`, `normalizeAgentCliType` |
| `05-claude-engine.js` | `01h-process-runtime.js` | backward | `ProcessRuntime`, `killChildTree` |
| `05-claude-engine.js` | `01o-execution-state.js` | backward | `activeChildren` |
| `05-claude-engine.js` | `02-session-store.js` | backward | `appendUsageLedger`, `buildTurnSummary`, `bumpMissionChangeSeq`, `captureWorkspaceTurnBaseline`, `finalizeMissionAfterTurn`, `isUntitledSessionTitle`, `journalReadIndex`, `loadSession`, `mergeMissionBeforeSave`, `reconcileWorkspaceTurnBaseline`, `saveSession`, `saveTurnFinalSession` |
| `05-claude-engine.js` | `02c-turn-segments.js` | backward | `createTurnSegmentBuilder` |
| `05-claude-engine.js` | `02d-session-overrides.js` | backward | `sessionDesktopToolsOf` |
| `05-claude-engine.js` | `03-bridge-guard.js` | backward | `cwdWarning` |
| `05-claude-engine.js` | `03a-privacy-gateway.js` | backward | `PrivacyGateway` |
| `05-claude-engine.js` | `04-permission-runtime.js` | backward | `AgentLoopHooks`, `appendLiveTail`, `assertSessionExecutionOwner`, `buildClaudeRecoveryHistory`, `claudeProviderTailSince`, `claudeResumeRouteKey`, `clearPendingPermissions`, `clearPendingQuestions`, `discoverKimiModels`, `formatQuestionGuidance`, `hasPendingPermissionForSession`, `hasPendingQuestionForSession`, `installActiveChildEventFanout`, `isClaudeResumeMissingError`, `kimiContextWindow`, `kimiModelList`, `lastSuccessfulClaudeModel`, `nativeClaudeAgentResultInfo`, `parseClaudeEvent`, `parseKimiStreamJsonEvent`, `permissionWaitMs`, `registerSessionExecutionChild`, `registerUserQuestion`, `sameClaudeResumeCwd`, `stopSession` |
| `05-claude-engine.js` | `04i-provider-wire.js` | backward | `activeOpenAiProvider` |
| `05-claude-engine.js` | `04l-skill-registry.js` | backward | `effectiveSkillSelection`, `resolveEnabledSkillEntries` |
| `05-claude-engine.js` | `05b-kimi-bridge.js` | forward | `applyKimiStatusToSession`, `kimiSessionStatus`, `kimiUsageFromStatus`, `maybeAutoCompactAgentSession`, `runKimiAcpTurnPrepared`, `runKimiCompact`, `syncKimiSessionUsage`, `syncKimiTurnPreferences`, `watchKimiWire` |
| `05-claude-engine.js` | `06-provider-engine.js` | forward | `buildBrowserAutomationHint`, `buildPlaybookIndexSection`, `buildSkillsPromptSection`, `buildToolCustomizationHint`, `evalPlaybookAvailability`, `loadAllPlaybooks`, `resolveEngineEnvBrief` |
| `05-claude-engine.js` | `06b-prompt-registry.js` | backward | `PROMPT_PACK_VERSION`, `appendMemorySection`, `appendTurnPolicies`, `buildPromptTaskContext`, `getPromptPack`, `softwareEngineeringTaskProfile` |
| `05-claude-engine.js` | `06c-agent-workflow-catalog.js` | backward | `buildOrchestrateHint`, `getAgentWorkflows` |
| `05-claude-engine.js` | `06d-memory-domain.js` | forward | `buildMemoryCheckPrompt`, `buildMemoryConflictMap`, `buildMemoryPromptSection`, `filterMemoryForNativeCli`, `memoryGlobalDir`, `memoryProjectDir`, `resolveMemoryPreflight` |
| `05-claude-engine.js` | `06e-mission-domain.js` | forward | `buildMissionPromptSection` |
| `05-claude-engine.js` | `06v-operational-services.js` | backward | `engineTranscriptCwd` |
| `05-claude-engine.js` | `06w-capability-service.js` | backward | `getCapabilities`, `peekCapabilities` |
| `05-claude-engine.js` | `07-autonomy.js` | forward | `classifyToolPacks` |
| `05b-kimi-bridge.js` | `00-boot.js` | backward | `RUYI_EVENTS`, `appRoot`, `dataRoot`, `externalRoot`, `isSensitiveDataPath`, `logEvent`, `makeId`, `nowIso`, `pathWithinRoot`, `paths`, `spawnDetachedChecked` |
| `05b-kimi-bridge.js` | `01-config.js` | backward | `RUNTIME`, `agentCliLauncherUsable`, `prepareAgentCliSpawn`, `readConfig`, `selectedAgentCli`, `syncMcpServersToKimi` |
| `05b-kimi-bridge.js` | `01h-process-runtime.js` | backward | `ProcessRuntime`, `killChildTree` |
| `05b-kimi-bridge.js` | `01o-execution-state.js` | backward | `activeChildren` |
| `05b-kimi-bridge.js` | `02-session-store.js` | backward | `bumpMissionChangeSeq`, `captureWorkspaceTurnBaseline`, `finalizeMissionAfterTurn`, `isUntitledSessionTitle`, `journalReadIndex`, `loadSession`, `mergeMissionBeforeSave`, `mutateSession`, `normalizeTodoItems`, `reconcileWorkspaceTurnBaseline`, `saveSession`, `saveTurnFinalSession` |
| `05b-kimi-bridge.js` | `03-bridge-guard.js` | backward | `buildOpenSpawn`, `cwdWarning`, `fileAllowedRoots`, `guardFileToolPath`, `guardWorkspaceExecute`, `realpathForContainment`, `workspaceWriteRoots` |
| `05b-kimi-bridge.js` | `03a-privacy-gateway.js` | backward | `PrivacyGateway` |
| `05b-kimi-bridge.js` | `04-permission-runtime.js` | backward | `AgentLoopHooks`, `assertSessionExecutionOwner`, `clearPendingPermissions`, `clearPendingPlans`, `clearPendingQuestions`, `hasPendingPermissionForSession`, `kimiContextWindow`, `permissionWaitMs`, `registerSessionExecutionChild`, `requestUserQuestion`, `runAutomaticInterventionDecision`, `stopSession` |
| `05b-kimi-bridge.js` | `07-autonomy.js` | forward | `requestNativePermission` |
| `05b-kimi-bridge.js` | `10-context-governance.js` | forward | `agentConversationContextMeta`, `lastSessionContextTokens`, `runAgentExternalCompact`, `upsertCompactMarker` |
| `05b-kimi-bridge.js` | `12-tool-dispatch.js` | forward | `toolCall` |
| `06-provider-engine.js` | `00-boot.js` | backward | `APP_NAME`, `DEFAULT_PORT`, `OVERLAY_ID`, `RUYI_EVENTS`, `VERSION`, `dataRoot`, `externalRoot`, `logEvent`, `nowIso`, `paths`, `safeJsonParse` |
| `06-provider-engine.js` | `01-config.js` | backward | `RUNTIME`, `atomicWriteJson`, `readConfig`, `safeSessionId` |
| `06-provider-engine.js` | `01h-process-runtime.js` | backward | `probeRgAsync` |
| `06-provider-engine.js` | `02-session-store.js` | backward | `appendUsageLedger`, `getSessionTitleOverride`, `loadSession`, `setSessionTitleOverride`, `updateSessionMeta` |
| `06-provider-engine.js` | `03a-privacy-gateway.js` | backward | `PrivacyGateway` |
| `06-provider-engine.js` | `04i-provider-wire.js` | backward | `activeOpenAiProvider`, `providerRawCompletion` |
| `06-provider-engine.js` | `06d-memory-domain.js` | forward | `buildMemoryCheckPrompt`, `buildMemoryPromptSection` |
| `06-provider-engine.js` | `06e-mission-domain.js` | forward | `buildMissionPromptSection` |
| `06-provider-engine.js` | `06w-capability-service.js` | backward | `getCapabilities` |
| `06-provider-engine.js` | `07-autonomy.js` | forward | `toolPackForName` |
| `06c-agent-workflow-catalog.js` | `00-boot.js` | backward | `paths` |
| `06c-agent-workflow-catalog.js` | `01-config.js` | backward | `atomicWriteJson` |
| `06d-memory-domain.js` | `00-boot.js` | backward | `SKILL_ID_RE`, `agentCliHomes`, `apiFailure`, `cachedInputTokensFromUsage`, `computeProviderCost`, `crypto`, `fsp`, `json`, `logEvent`, `makeId`, `neutralizeFenceTag`, `normalizeCwd`, `nowIso`, `os`, `path`, `paths`, `runKeyedChain`, `safeJsonParse`, `text`, `tildePath` |
| `06d-memory-domain.js` | `01-config.js` | backward | `ACC_MEMORY_IMPORT_SCHEMA`, `DurableJsonStore`, `accMemoryImportStore`, `atomicWriteJson`, `legacyAccMemoryMigrationComplete`, `readConfig`, `safeSessionId` |
| `06d-memory-domain.js` | `01c-runtime-flags.js` | backward | `coreMemoryCharBudget`, `coreMemoryMaxItems`, `memoryFixedSelectionMax`, `memoryRelevanceMax` |
| `06d-memory-domain.js` | `01o-execution-state.js` | backward | `activeChildren` |
| `06d-memory-domain.js` | `02-session-store.js` | backward | `appendUsageLedger`, `loadSession` |
| `06d-memory-domain.js` | `04i-provider-wire.js` | backward | `activeOpenAiProvider`, `providerRawCompletion` |
| `06e-mission-domain.js` | `00-boot.js` | backward | `logEvent`, `makeId`, `neutralizeFenceTag`, `normalizeCwd`, `nowIso` |
| `06e-mission-domain.js` | `01o-execution-state.js` | backward | `activeAgentRuns`, `activeChildren`, `turnSettlers` |
| `06e-mission-domain.js` | `02-session-store.js` | backward | `MISSION_DEFAULT_MAX_TURNS`, `MISSION_MAX_MILESTONES`, `MISSION_MAX_TEXT`, `MISSION_STALL_LIMIT`, `archiveMissionResult`, `buildMissionResult`, `bumpMissionChangeSeq`, `evaluateMissionCheck`, `followupAcceptanceCriterion`, `journalReadIndex`, `listAgentRuns`, `loadSession`, `maybeFinalizeMission`, `missionProgressDigest`, `mutateSession`, `normalizeMission`, `normalizeMissionCheck`, `recordMissionCheckResult`, `rewindSession`, `saveSession`, `sessionObjectIsStale`, `stopMissionAgentRuns` |
| `06e-mission-domain.js` | `04-permission-runtime.js` | backward | `stopSession` |
| `06e-mission-domain.js` | `06b-prompt-registry.js` | backward | `getPromptPack` |
| `06e-mission-domain.js` | `06f-autonomy-grants.js` | backward | `revokeAllGrants` |
| `06f-autonomy-grants.js` | `00-boot.js` | backward | `hashArgs`, `isSensitiveDataPath`, `logEvent`, `makeId` |
| `06g-resource-leases.js` | `00-boot.js` | backward | `makeId`, `nowIso` |
| `06i-steward-core.js` | `03a-privacy-gateway.js` | backward | `PrivacyGateway` |
| `06k-config-patch.js` | `00-boot.js` | backward | `fsp`, `logEvent`, `maskedSecretConflictMessage`, `maskedSecretConflicts`, `os`, `path`, `paths`, `unmaskSecrets` |
| `06k-config-patch.js` | `01-config.js` | backward | `ConfigPatchHooks`, `invalidateAgentCliPathCaches`, `mutateConfig`, `syncAgentCliMcpManifests`, `syncAgentRolesToClaude`, `syncClaudeCliSettings`, `syncMcpServersToClaude` |
| `06k-config-patch.js` | `01e-permission-modes.js` | backward | `PERMISSION_MODES_REQUIRING_CONFIRM` |
| `06k-config-patch.js` | `02-session-store.js` | backward | `rememberLastUsedEngineRoute` |
| `06k-config-patch.js` | `02e-session-engine-route.js` | backward | `sessionEngineRouteFromConfig` |
| `06k-config-patch.js` | `04-permission-runtime.js` | backward | `ToolboxHooks`, `invalidateMcpRuntime` |
| `06k-config-patch.js` | `06i-steward-core.js` | backward | `StewardHooks` |
| `06v-operational-services.js` | `00-boot.js` | backward | `RUYI_EVENTS`, `logEvent`, `nowIso`, `paths`, `safeJsonParse` |
| `06v-operational-services.js` | `01-config.js` | backward | `atomicWriteJson`, `resolveExternalMcpServers`, `safeSessionId` |
| `06v-operational-services.js` | `01o-execution-state.js` | backward | `activeChildren` |
| `06v-operational-services.js` | `02-session-store.js` | backward | `SESSION_INDEX_FILE` |
| `06v-operational-services.js` | `04-permission-runtime.js` | backward | `collectBridgedTools`, `mcpClients`, `sanitizeServerId` |
| `06w-capability-service.js` | `00-boot.js` | backward | `DesktopExecutionHooks`, `nowIso` |
| `06w-capability-service.js` | `01-config.js` | backward | `readConfig`, `resolveExternalMcpServers` |
| `06w-capability-service.js` | `01h-process-runtime.js` | backward | `ProcessRuntime`, `existsExecutableAsync`, `probeGitCliAsync`, `probeRgAsync` |
| `06w-capability-service.js` | `04-permission-runtime.js` | backward | `collectBridgedTools`, `mcpClients`, `sanitizeServerId` |
| `06w-capability-service.js` | `04h-provider-http.js` | backward | `providerBaseIsLocalOrLan`, `providerBaseWithV1` |
| `07-autonomy.js` | `00-boot.js` | backward | `BRIDGED_WRITE_PATH_ARGS`, `CONTEXT_OVERFLOW_PATTERNS`, `DesktopExecutionHooks`, `MCP_TOOLS`, `PROVIDER_SESSION_TOOL_SCHEMAS`, `TOOL_PACK_DESCRIPTIONS`, `TOOL_REQUIRES`, `TOOL_TIER_RANK`, `URL`, `adaptiveMetaToolSchemas`, `apiFailure`, `bridgedToolDisabledByPolicy`, `buildAttachmentPrompt`, `cacheContextLength`, `claudeCostFields`, `createNdjsonLineFeeder`, `crypto`, `extractContextLength`, `fsp`, `isContextOverflowError`, `logEvent`, `makeId`, `nativeToolDisabledByPolicy`, `nativeToolTier`, `nowIso`, `path`, `redact`, `safeJsonParse`, `text`, `toolRequirementsMet` |
| `07-autonomy.js` | `01-config.js` | backward | `buildUserEnvelope`, `decodeClaudeCliText`, `detectClaudePath`, `effectiveAnthropicEnv`, `generateAgentNodeMcpConfig`, `readConfig` |
| `07-autonomy.js` | `01c-runtime-flags.js` | backward | `appendOnlyToolSchemasEnabled`, `observationRecallEnabled` |
| `07-autonomy.js` | `01e-permission-modes.js` | backward | `clampAgentRoleToParent`, `claudePermissionMode` |
| `07-autonomy.js` | `01h-process-runtime.js` | backward | `ProcessRuntime`, `existsExecutableAsync`, `killChildTree` |
| `07-autonomy.js` | `01o-execution-state.js` | backward | `pendingPermissions`, `pendingPlans` |
| `07-autonomy.js` | `02-session-store.js` | backward | `appendUsageLedger`, `loadSession`, `registerIntervention`, `repairProviderHistoryPairing`, `repairProviderHistoryToolArgs`, `saveSession`, `settleIntervention` |
| `07-autonomy.js` | `02d-session-overrides.js` | backward | `sessionDesktopToolsOf` |
| `07-autonomy.js` | `02f-turn-effect-kinds.js` | backward | `unprefixedBridgedName` |
| `07-autonomy.js` | `03a-privacy-gateway.js` | backward | `PrivacyGateway` |
| `07-autonomy.js` | `04-permission-runtime.js` | backward | `PermissionWaitHooks`, `parseClaudeEvent`, `promptWaitMs`, `resolveBridge`, `runAutomaticInterventionDecision` |
| `07-autonomy.js` | `04-visual-pipeline.js` | backward | `VisualPipeline` |
| `07-autonomy.js` | `04h-provider-http.js` | backward | `providerBaseIsLocalOrLan`, `providerRetryAfterMs`, `providerScrubSecrets`, `providerThrownErrorText`, `withTransientRetry` |
| `07-autonomy.js` | `04i-provider-wire.js` | backward | `ProviderWireHooks`, `providerWireProtocol`, `providerWireProtocolForBody` |
| `07-autonomy.js` | `06b-prompt-registry.js` | backward | `appendResponseLanguagePolicy` |
| `07-autonomy.js` | `06i-steward-core.js` | backward | `isStewardToolName`, `stewardAutoAskIndirect`, `stewardAutoAskScanIncomplete`, `stewardAutoAskSensitiveKind`, `stewardToolPermanentlyExempt` |
| `08-agent-runs.js` | `00-boot.js` | backward | `DesktopExecutionHooks`, `EventStreamHooks`, `SubAgentMemoryHooks`, `TOOL_TIER_RANK`, `boundToolResultForDisplay`, `bridgedWriteRelativePathArg`, `cachedInputTokensFromUsage`, `computeProviderCost`, `crypto`, `estimateContentTokens`, `estimateHistoryTokens`, `fsp`, `httpGetGuarded`, `isContextOverflowError`, `logEvent`, `makeId`, `nativeToolTier`, `normalizeCwd`, `nowIso`, `path`, `paths`, `redact`, `safeJsonParse`, `samePathKey`, `setEstimateBucketsV1`, `ssrfCheck`, `text`, `toolDisabledByPolicy`, `truncateToolResult` |
| `08-agent-runs.js` | `01-config.js` | backward | `resolveNodeModel`, `safeSessionId` |
| `08-agent-runs.js` | `01c-runtime-flags.js` | backward | `estimateBucketsEnabled` |
| `08-agent-runs.js` | `01e-permission-modes.js` | backward | `clampAgentRoleToParent` |
| `08-agent-runs.js` | `01h-process-runtime.js` | backward | `runGit` |
| `08-agent-runs.js` | `01o-execution-state.js` | backward | `activeAgentRuns`, `pendingPermissions` |
| `08-agent-runs.js` | `02-session-store.js` | backward | `agentRunFile`, `appendAgentRunEvent`, `appendUsageLedger`, `isProviderToolArgsObject`, `journalBridgedWrite`, `mutateSession`, `preflightWriteBoundary`, `providerHistoryToolCalls`, `saveAgentRun`, `writeHistorySnapshot` |
| `08-agent-runs.js` | `02d-session-overrides.js` | backward | `liveSessionPermissionMode`, `sessionDesktopToolsOf` |
| `08-agent-runs.js` | `03-bridge-guard.js` | backward | `bridgedOfficeScriptGate`, `bridgedReadPathGate`, `guardWorkspacePath` |
| `08-agent-runs.js` | `03a-privacy-gateway.js` | backward | `PrivacyGateway` |
| `08-agent-runs.js` | `04-permission-runtime.js` | backward | `bridgedServerUnavailableMessage`, `collectBridgedTools`, `getBridgedClient`, `permissionWaitMs`, `resolveBridge`, `runAutomaticInterventionDecision` |
| `08-agent-runs.js` | `04-visual-pipeline.js` | backward | `VisualPipeline` |
| `08-agent-runs.js` | `04h-provider-http.js` | backward | `providerBaseWithV1`, `providerCallIsTransient`, `withTransientRetry` |
| `08-agent-runs.js` | `04i-provider-wire.js` | backward | `applyProviderReasoningEffort`, `providerServerSearchCard`, `providerWireOutputLimited`, `providerWireProtocol`, `resolveProvider` |
| `08-agent-runs.js` | `06-provider-engine.js` | backward | `TOOL_ITERATION_BUDGETS`, `buildProviderSystemPrompt`, `readProjectMemory`, `resolveToolIterationBudget`, `shouldExtendToolIterationBudget` |
| `08-agent-runs.js` | `06b-prompt-registry.js` | backward | `appendResponseLanguagePolicy` |
| `08-agent-runs.js` | `06c-agent-workflow-catalog.js` | backward | `getAgentWorkflows` |
| `08-agent-runs.js` | `06g-resource-leases.js` | backward | `acquireResourceLease`, `inferToolResources`, `normalizeAgentResources`, `releaseResourceLease` |
| `08-agent-runs.js` | `06i-steward-core.js` | backward | `stewardAutoAskReason` |
| `08-agent-runs.js` | `06w-capability-service.js` | backward | `getCapabilities` |
| `08-agent-runs.js` | `07-autonomy.js` | backward | `LOOP_GUARD_LIMITS`, `MAIL_QUEUE_MAX`, `MEMORY_WRITE_TOOL_NAMES`, `bridgedToolTier`, `buildOpenAiTools`, `classifyToolPacks`, `dropPolicyDisabledBridgedTools`, `fetchOpenAiModels`, `loopAbortExempt`, `loopWarnOnly`, `nativeToolGate`, `neutralizeInjectedPrefixes`, `openAiStreamOnce`, `requestNativePermission`, `runClaudeSubAgentOnce`, `toolDisabledResult`, `toolPackForName`, `webPayloadReason` |
| `08-agent-runs.js` | `10-context-governance.js` | forward | `SessionCompaction`, `compactionRefetchRefusal`, `compactionRefetchWarning`, `createCompactionRefetchGuard`, `estimateFactor`, `noteWindowOvershoot`, `recordCompactUsage`, `runForcedOverflowCompaction` |
| `08-agent-runs.js` | `12-tool-dispatch.js` | forward | `toolCall`, `toolFailureResult` |
| `09-workflow.js` | `00-boot.js` | backward | `DeliveryHooks`, `DesktopExecutionHooks`, `EventStreamHooks`, `RUYI_EVENTS`, `SubAgentMemoryHooks`, `TOOL_TIER_RANK`, `boundToolResultForDisplay`, `estimateContentTokens`, `estimateHistoryTokens`, `estimateToolSchemaTokens`, `isContextOverflowError`, `localTurnTimeParts`, `logEvent`, `makeId`, `nativeToolTier`, `nowIso`, `safeJsonParse`, `sessionSaveIsTombstoned`, `setEstimateBucketsV1` |
| `09-workflow.js` | `01-config.js` | backward | `buildModelHint`, `getAgentRoleLibrary`, `readConfig`, `resolveNodeModel`, `safeSessionId` |
| `09-workflow.js` | `01o-execution-state.js` | backward | `activeAgentRuns`, `activeChildren` |
| `09-workflow.js` | `02-session-store.js` | backward | `AgentRunStore`, `agentRunFile`, `appendUsageLedger`, `applyMissionUpdate`, `bumpMissionChangeSeq`, `captureWorkspaceTurnBaseline`, `finalizeMissionAfterTurn`, `isProviderToolArgsObject`, `isUntitledSessionTitle`, `journalBridgedWrite`, `journalReadIndex`, `journalRevertNoticesAck`, `journalRevertNoticesPeek`, `loadSession`, `maybeWriteSessionNotes`, `mergeMissionBeforeSave`, `mutateSession`, `normalizeMetaToolArgs`, `normalizeTodoItems`, `preflightWriteBoundary`, `providerHistoryToolCalls`, `readSessionNotes`, `readSessionScratchpad`, `reconcileWorkspaceTurnBaseline`, `recordMissionBudgetTrippedChange`, `recordMissionStalledChange`, `registerIntervention`, `repairProviderHistoryPairing`, `repairProviderHistoryToolArgs`, `saveAgentRun`, `saveSession`, `saveTurnFinalSession`, `settleIntervention`, `syncProviderHistoryFromDisplay`, `writeHistorySnapshot` |
| `09-workflow.js` | `02d-session-overrides.js` | backward | `liveSessionPermissionMode`, `sessionDesktopToolsOf` |
| `09-workflow.js` | `03-bridge-guard.js` | backward | `bridgedOfficeScriptGate`, `bridgedReadPathGate`, `cwdWarning` |
| `09-workflow.js` | `03a-privacy-gateway.js` | backward | `PrivacyGateway` |
| `09-workflow.js` | `04-permission-runtime.js` | backward | `AgentLoopHooks`, `appendLiveTail`, `assertSessionExecutionOwner`, `bridgedServerUnavailableMessage`, `clearPendingPermissions`, `clearPendingPlans`, `clearPendingQuestions`, `collectBridgedTools`, `getBridgedClient`, `hasPendingPermissionForSession`, `hasPendingQuestionForSession`, `installActiveChildEventFanout`, `permissionWaitMs`, `registerSessionExecutionChild`, `requestUserQuestion`, `resolveBridge`, `stopSession` |
| `09-workflow.js` | `04-visual-pipeline.js` | backward | `VisualPipeline` |
| `09-workflow.js` | `04h-provider-http.js` | backward | `providerCallIsTransient`, `providerThrownErrorText`, `withTransientRetry` |
| `09-workflow.js` | `04i-provider-wire.js` | backward | `applyProviderReasoningEffort`, `providerServerSearchCard`, `providerWireContentFiltered`, `providerWireContextExceeded`, `providerWireOutputLimited`, `providerWireProtocol` |
| `09-workflow.js` | `04l-skill-registry.js` | backward | `resolveEnabledSkillEntries` |
| `09-workflow.js` | `06-provider-engine.js` | backward | `buildStableSystemPrompt`, `buildVolatileParts`, `loadAllPlaybooks`, `repairNodeJsonViaProvider` |
| `09-workflow.js` | `06c-agent-workflow-catalog.js` | backward | `getAgentWorkflows` |
| `09-workflow.js` | `06d-memory-domain.js` | backward | `MemoryStore`, `buildMemoryCheckPrompt`, `buildMemoryConflictMap`, `buildMemoryPromptSection`, `buildMemoryTurnSection`, `extractMemoryRelationProposals`, `filterMemoryForNativeCli`, `memoryExclusionSet`, `memoryIsExpired`, `memorySelectionSignature`, `proposeMemoryRelation`, `readConfirmedSupersedeEdges`, `resolveMemoryPreflight` |
| `09-workflow.js` | `06f-autonomy-grants.js` | backward | `consumeGrant` |
| `09-workflow.js` | `06g-resource-leases.js` | backward | `acquireResourceLease`, `inferToolResources`, `normalizeAgentResources`, `releaseResourceLease`, `remapAgentResources` |
| `09-workflow.js` | `06i-steward-core.js` | backward | `StewardHooks`, `isStewardToolName` |
| `09-workflow.js` | `06w-capability-service.js` | backward | `getCapabilities` |
| `09-workflow.js` | `07-autonomy.js` | backward | `ACTION_VIEW_MIN_CHARS`, `ACTION_VIEW_TOOLS`, `LOOP_GUARD_LIMITS`, `MAIL_PER_SENDER_MAX`, `MAIL_QUEUE_MAX`, `MAIL_TEXT_MAX`, `actionTargetMeta`, `bridgedToolTier`, `buildOpenAiTools`, `classifyRuntimeToolFailure`, `compareToolRetrievalShadow`, `createToolLoadingState`, `drainSteerQueue`, `dropPolicyDisabledBridgedTools`, `failoverStickyBase`, `hasInterruptingSteer`, `looksLikePlan`, `loopAbortExempt`, `loopWarnOnly`, `nativeToolGate`, `openAiStreamOnce`, `projectActionModelView`, `requestNativePermission`, `requestPlanApproval`, `toolDisabledResult`, `webPayloadReason` |
| `09-workflow.js` | `08-agent-runs.js` | backward | `agentRunCapabilities`, `agentRunResultSlice`, `agentRunRoster`, `buildAgentRunEnvelope`, `buildUpstreamContext`, `cleanupAgentWorktree`, `cleanupAgentWorktreeForRetry`, `createAgentWorktree`, `deriveNodeOutputs`, `evalWaitCondition`, `evaluateNodeToolEvidence`, `evaluateWorkflowCondition`, `finalizeAgentWorktree`, `formatNodeEvidencePrompt`, `indexNodeEvidence`, `materializePoolItem`, `nodeDeliveryEligibility`, `orchestrateArgsProblem`, `orchestrateModelNotes`, `ownAgentMessageReceipt`, `poolChainDepth`, `purgeNodeEvidence`, `readAgentRunRecord`, `recordAgentNodeProgress`, `resolveAgentTeamRoute`, `resolveOrchestrateFollowup`, `resolveOrchestrateNodes`, `runSubAgent`, `summarizeAgentWorkflowRun`, `verifyNodeClaims`, `workflowProgressFingerprint` |
| `09-workflow.js` | `09b-replan-ledger.js` | backward | `proposeReplanPatch`, `recordNodeContinuation`, `validateReplanPatch` |
| `09-workflow.js` | `10-context-governance.js` | forward | `agentNodeContextWindow`, `buildObservationRecallPrompt`, `estimateFactor`, `maybeAutoCompact`, `noteEstimateSample`, `noteWindowOvershoot`, `providerContextWindow`, `recordCompactUsage`, `runForcedOverflowCompaction`, `upsertCompactMarker` |
| `09-workflow.js` | `12-tool-dispatch.js` | forward | `toolCall`, `toolFailureResult`, `validateNativeToolArgs` |
| `09b-agent-recovery.js` | `00-boot.js` | backward | `EventStreamHooks`, `nowIso`, `paths` |
| `09b-agent-recovery.js` | `01-config.js` | backward | `readConfig`, `safeSessionId` |
| `09b-agent-recovery.js` | `01e-permission-modes.js` | backward | `resolvePermissionMode` |
| `09b-agent-recovery.js` | `01o-execution-state.js` | backward | `activeAgentRuns` |
| `09b-agent-recovery.js` | `02-session-store.js` | backward | `appendAgentRunEvent`, `listAgentRuns`, `readInterventions`, `readSessionHeadResilient`, `registerIntervention`, `saveAgentRun`, `settleIntervention`, `syncRunEventSeq` |
| `09b-agent-recovery.js` | `02d-session-overrides.js` | backward | `applySessionPermissionModeOverride` |
| `09b-agent-recovery.js` | `08-agent-runs.js` | backward | `NODE_WRITE_FAMILY`, `buildAgentRunEnvelope` |
| `09b-agent-recovery.js` | `09-workflow.js` | backward | `launchPersistedAgentRun` |
| `09b-replan-ledger.js` | `00-boot.js` | backward | `TOOL_TIER_RANK`, `hashArgs`, `makeId`, `nowIso` |
| `10-context-governance.js` | `00-boot.js` | backward | `DesktopExecutionHooks`, `estimateContentTokens`, `estimateHistoryTokens`, `estimateTextTokens`, `fmtTokensServer`, `isContextOverflowError`, `logEvent`, `nowIso`, `paths`, `resolveContextWindow` |
| `10-context-governance.js` | `01-config.js` | backward | `DurableJsonStore`, `readConfig` |
| `10-context-governance.js` | `02-session-store.js` | backward | `appendUsageLedger`, `loadSession`, `maybeWriteSessionNotes`, `mutateSession`, `repairProviderHistoryPairing`, `saveSession`, `sessionObjectIsStale`, `writeHistorySnapshot` |
| `10-context-governance.js` | `02d-session-overrides.js` | backward | `sessionDesktopToolsOf` |
| `10-context-governance.js` | `02e-session-engine-route.js` | backward | `configForSessionEngineRoute` |
| `10-context-governance.js` | `03a-privacy-gateway.js` | backward | `PrivacyGateway` |
| `10-context-governance.js` | `04-permission-runtime.js` | backward | `AGENT_CLI_CONTEXT_WINDOW_PROBES` |
| `10-context-governance.js` | `04h-provider-http.js` | backward | `providerBaseWithV1` |
| `10-context-governance.js` | `04i-provider-wire.js` | backward | `normalizeProviderApiStyle`, `providerWireProtocol` |
| `10-context-governance.js` | `06-provider-engine.js` | backward | `buildStableSystemPrompt` |
| `10-context-governance.js` | `06i-steward-core.js` | backward | `StewardHooks` |
| `10-context-governance.js` | `07-autonomy.js` | backward | `buildOpenAiTools`, `fetchOpenAiModels` |
| `10a-session-turn.js` | `00-boot.js` | backward | `DesktopExecutionHooks`, `EventStreamHooks`, `SessionExecutionHooks`, `logEvent`, `makeId`, `nowIso` |
| `10a-session-turn.js` | `01-config.js` | backward | `readConfig`, `safeSessionId` |
| `10a-session-turn.js` | `01h-privacy-core.js` | backward | `PrivacyCore` |
| `10a-session-turn.js` | `01o-execution-state.js` | backward | `activeChildren`, `turnSettlers` |
| `10a-session-turn.js` | `02-session-store.js` | backward | `createSession`, `loadSession`, `rememberLastUsedEngineRoute`, `sessionMessagesDelta`, `sessionMessagesStamp`, `sessionMissionId`, `sessionTodosSignature`, `updateSessionMeta` |
| `10a-session-turn.js` | `02d-session-overrides.js` | backward | `sessionEngineRouteScopeOverrides` |
| `10a-session-turn.js` | `02e-session-engine-route.js` | backward | `configForSessionEngineRoute`, `inferSessionEngineRoute`, `normalizeSessionEngineRoute`, `sessionEngineRouteFromConfig` |
| `10a-session-turn.js` | `03a-privacy-gateway.js` | backward | `PrivacyGateway` |
| `10a-session-turn.js` | `04-permission-runtime.js` | backward | `assertSessionExecutionOwner`, `driverAutoSessions`, `recordSessionExecutionOwner`, `requestSessionExecutionStop`, `sessionExecutionSnapshot`, `stopSession`, `turnOutcomePending` |
| `10a-session-turn.js` | `05-claude-engine.js` | backward | `runClaudeTurn` |
| `10a-session-turn.js` | `06-provider-engine.js` | backward | `maybeWriteThreadBrief`, `settleThreadBrief` |
| `10a-session-turn.js` | `06e-mission-domain.js` | backward | `runMissionDriver` |
| `10a-session-turn.js` | `06f-autonomy-grants.js` | backward | `bindDriverRun`, `endDriverRun`, `revokeGrantsForRun` |
| `10a-session-turn.js` | `06i-steward-core.js` | backward | `STEWARD_SESSION_ID`, `StewardHooks`, `stewardTaintToolCall`, `stewardWatchedThread` |
| `10a-session-turn.js` | `09-workflow.js` | backward | `runOpenAiTurn` |
| `10a-session-turn.js` | `10-context-governance.js` | backward | `runProviderCompact` |
| `11-native-tools.js` | `00-boot.js` | backward | `EventStreamHooks`, `MCP_TOOLS`, `RUYI_EVENTS`, `ensureDataRootReal`, `isSensitiveDataPath`, `isSensitiveHardlinkAlias`, `logEvent`, `nativeToolDisabledByPolicy`, `nowIso`, `pathWithinRoot`, `paths`, `redact`, `runtimeToolRequirementsMet`, `sensitiveFileIdentities`, `sensitiveGlobsForRg` |
| `11-native-tools.js` | `01-config.js` | backward | `atomicWriteJson`, `readConfig`, `safeSessionId`, `sessionPath` |
| `11-native-tools.js` | `01c-runtime-flags.js` | backward | `observationRecallEnabled` |
| `11-native-tools.js` | `01h-process-runtime.js` | backward | `GitRuntime`, `ProcessRuntime`, `hasRgAsync`, `killChildTree`, `probeRg` |
| `11-native-tools.js` | `01o-execution-state.js` | backward | `activeAgentRuns`, `activeChildren` |
| `11-native-tools.js` | `03-bridge-guard.js` | backward | `realpathForContainment` |
| `11-native-tools.js` | `03a-privacy-gateway.js` | backward | `PrivacyGateway`, `privacyProjectSearch`, `privacySourceActive`, `privacySourceFragment`, `privacySourceLine`, `privacySourceLineOffsets`, `privacySourceMark`, `readIfExists`, `sourceViewOf` |
| `11-native-tools.js` | `04-permission-runtime.js` | backward | `collectBridgedTools` |
| `11-native-tools.js` | `06i-steward-core.js` | backward | `isStewardToolName` |
| `11-native-tools.js` | `06w-capability-service.js` | backward | `markNetworkOnline`, `networkAnchors`, `probeAny` |
| `11-native-tools.js` | `07-autonomy.js` | backward | `MAIL_TEXT_MAX`, `buildToolCatalog`, `dropPolicyDisabledBridgedTools`, `neutralizeInjectedPrefixes` |
| `11c-file-visual-io.js` | `01h-process-runtime.js` | backward | `ProcessRuntime` |
| `11d-media-inspection.js` | `01h-process-runtime.js` | backward | `ProcessRuntime` |
| `12-tool-dispatch.js` | `00-boot.js` | backward | `ASR_MAX_BODY_BYTES`, `DesktopExecutionHooks`, `NATIVE_COMMAND_TOOL_NAMES`, `NATIVE_DESKTOP_TOOL_NAMES`, `OVERLAY_ID`, `TOOL_TIER_RANK`, `URL`, `bridgedWriteRelativePathArg`, `crypto`, `externalRoot`, `fs`, `fsp`, `isSensitiveDataPath`, `isSensitiveHardlinkAlias`, `logEvent`, `makeId`, `nativeToolDisabledByPolicy`, `normalizeCwd`, `nowIso`, `os`, `path`, `pathWithinRoot`, `paths`, `runtimeToolRequirementsMet`, `safeJsonParse`, `sensitiveFileIdentities`, `spawnDetachedChecked`, `text`, `toolDisabledByPolicy` |
| `12-tool-dispatch.js` | `01-config.js` | backward | `RUNTIME`, `agentCliLauncherOk`, `commandForSelfMcp`, `defaultConfig`, `ensureDesktopMcpWarm`, `externalServerJs`, `readConfig`, `resolveExternalMcpServers`, `safeSessionId`, `selectedAgentCli`, `staticBase` |
| `12-tool-dispatch.js` | `01c-runtime-flags.js` | backward | `execResultCacheEnabled`, `execResultCacheMaxEntries`, `observationRecallEnabled` |
| `12-tool-dispatch.js` | `01h-process-runtime.js` | backward | `DesktopShell`, `ProcessRuntime`, `probeRgAsync` |
| `12-tool-dispatch.js` | `01n-desktop-automation.js` | backward | `MacDesktopAutomation` |
| `12-tool-dispatch.js` | `01o-execution-state.js` | backward | `providerTurnQuotaKey` |
| `12-tool-dispatch.js` | `02-session-store.js` | backward | `JOURNAL_KEEP_TURNS`, `JOURNAL_MAX_BEFORE_BYTES`, `SESSION_SCRATCHPAD_LIMITS`, `fileToolWorkspaceDir`, `journalBridgedWrite`, `journalDropEntries`, `journalReadIndex`, `journalRecord`, `journalRecordMany`, `journalRevertLogRead`, `journalSessionCtx`, `loadSession`, `normalizeMetaToolArgs`, `normalizeScratchpadKey`, `normalizeScratchpadText`, `normalizeTodoItems`, `readSessionScratchpad`, `rehydrateObservation`, `resolveFileToolPath`, `resolveFileToolRoot`, `scratchpadTotalChars`, `updateSessionScratchpad` |
| `12-tool-dispatch.js` | `02d-session-overrides.js` | backward | `sessionDesktopToolsOf` |
| `12-tool-dispatch.js` | `02f-turn-effect-kinds.js` | backward | `normalizeToolInvokeArgs` |
| `12-tool-dispatch.js` | `03-bridge-guard.js` | backward | `OFFICE_WRITER_LIB_RE`, `REVEAL_OPEN_SAFE_EXTS`, `UNC_DENIED_ERROR`, `bridgedOfficeScriptGate`, `bridgedReadPathGate`, `buildBrowserOpenSpawn`, `buildOpenSpawn`, `buildRevealSpawn`, `guardFileToolPath`, `guardWorkspaceExecute`, `isBrowserDocumentTarget`, `realpathForContainment`, `remoteUncDenialResolved`, `resolveExecCwd` |
| `12-tool-dispatch.js` | `03a-privacy-gateway.js` | backward | `PrivacyGateway`, `privacyReadTextWindow`, `privacySourceActive`, `privacySourceLine`, `privacySourceLineOffsets`, `privacySourceMark`, `sourceViewOf` |
| `12-tool-dispatch.js` | `04-permission-runtime.js` | backward | `bridgedServerUnavailableMessage`, `configureMcpFromTool`, `getBridgedClient`, `resolveBridge`, `safeMcpInventory` |
| `12-tool-dispatch.js` | `04-visual-pipeline.js` | backward | `VisualPipeline` |
| `12-tool-dispatch.js` | `04i-provider-wire.js` | backward | `activeOpenAiProvider`, `providerWireProtocol` |
| `12-tool-dispatch.js` | `04l-skill-registry.js` | backward | `SkillRegistry`, `effectiveSkillSelection` |
| `12-tool-dispatch.js` | `04m-voice-service.js` | backward | `resolveAsrProvider`, `transcribeAudioViaProvider`, `voiceLexiconAsrPromptFor` |
| `12-tool-dispatch.js` | `06-provider-engine.js` | backward | `buildRuntimeIdentityFacts`, `listPlaybooksWithAvailability`, `loadAllPlaybooks`, `neutralizeAuthoredText`, `updateAutomaticThreadTitle` |
| `12-tool-dispatch.js` | `06c-agent-workflow-catalog.js` | backward | `BUILTIN_AGENT_WORKFLOWS`, `getAgentWorkflows` |
| `12-tool-dispatch.js` | `06d-memory-domain.js` | backward | `listWorkbenchMemories`, `proposeMemoryRelationRevoke`, `proposeMemoryRelationTool`, `proposeMemoryRevision`, `proposeWorkbenchMemory`, `readWorkbenchMemory` |
| `12-tool-dispatch.js` | `06i-steward-core.js` | backward | `StewardHooks`, `isStewardToolName`, `stewardAssemblePlaybookPrompt`, `stewardPlaybookMissingInputs` |
| `12-tool-dispatch.js` | `06w-capability-service.js` | backward | `getCapabilities`, `markNetworkOnline`, `peekCapabilities` |
| `12-tool-dispatch.js` | `07-autonomy.js` | backward | `bridgedToolTier`, `compareToolRetrievalShadow`, `listCompactTools`, `nativeToolSchema`, `nativeToolsAcceptingArgKeys`, `policyDesktopOverrideFor`, `policySessionFor`, `searchToolCatalog`, `toolArgsSkeleton`, `toolDisabledResult` |
| `12-tool-dispatch.js` | `11-native-tools.js` | backward | `adaptiveCatalogForMcp`, `boundedReadPage`, `claudeMdAudit`, `codeReviewScan`, `codebaseSymbolSearch`, `dataProfile`, `debugHypothesis`, `dependencyInventory`, `docsSearch`, `explicitAllowDirs`, `frontendAudit`, `gitCommit`, `gitDiff`, `gitLog`, `gitStatus`, `httpRequest`, `levenshtein`, `prunedDirsHint`, `searchFileContent`, `shellKill`, `shellList`, `shellMcpChildGuard`, `shellPoll`, `shellSend`, `shellStart`, `walkDepthHint`, `walkEnvelopeEntries`, `walkFiles`, `walkTruncationHint`, `webFetch`, `webSearch`, `zipCollectEntries` |
| `12-tool-dispatch.js` | `11b-file-text-io.js` | backward | `FileTextIo` |
| `12-tool-dispatch.js` | `11c-file-visual-io.js` | backward | `FileVisualIo` |
| `12-tool-dispatch.js` | `11d-media-inspection.js` | backward | `MediaInspection` |
| `13-http-router.js` | `00-boot.js` | backward | `APP_NAME`, `CLAUDE_ENDPOINT_PRESETS`, `CONFIG_SCHEMA`, `DATA_ROOT_MIGRATION`, `DEFAULT_PORT`, `DesktopExecutionHooks`, `EventStreamHooks`, `ExternalBotHooks`, `MCP_TOOLS`, `OVERLAY_ID`, `PREVIEW_TEXT_EXTS`, `SKILL_ID_RE`, `URL`, `VERSION`, `apiFailure`, `apiSessionIdInvalid`, `apiSessionNotFound`, `cachedContextLength`, `contentTypeFor`, `contextWindowFromTable`, `crypto`, `dataRootAliases`, `defaultDataRoots`, `ensureDataRootReal`, `ensureDirs`, `exePath`, `externalRoot`, `fs`, `fsp`, `http`, `isDirectServeInvocation`, `isSensitiveDataPath`, `isSensitiveHardlinkAlias`, `json`, `logEvent`, `lstatOrNull`, `makeId`, `maskProviders`, `maskedSecretConflictMessage`, `maskedSecretConflicts`, `migrateLegacyDataRoot`, `nativeToolDisabledByPolicy`, `normalizeCwd`, `nowIso`, `os`, `path`, `pathWithinAnyRoot`, `pathWithinRoot`, `paths`, `readFilePreview`, `readJsonBody`, `redact`, `resolveContextWindow`, `runtimeToolRequirementsMet`, `safeJsonParse`, `samePathKey`, `send`, `sendError`, `spawnDetachedChecked`, `text`, `truncateToolResult`, `unmaskProviders`, `zlib` |
| `13-http-router.js` | `00-platform-runtime.js` | backward | `platformOpenSpawn` |
| `13-http-router.js` | `00b-ruyi-names.js` | backward | `LEGACY_RUYI_MCP_SERVER_IDS`, `RUYI_MCP_SERVER_ID` |
| `13-http-router.js` | `01-config.js` | backward | `ConfigPatchHooks`, `RUNTIME`, `atomicWriteJson`, `authorizeRoute`, `autoImportClaudeCodeMcp`, `beginBootCliPathProbes`, `buildClaudeAgentDefinitions`, `desktopMcpDetectionPending`, `detectClaudePath`, `detectDesktopMcp`, `detectKimiPath`, `ensureDesktopMcpWarm`, `externalServerJs`, `finishBootCliPathProbes`, `generateMcpConfig`, `getAgentRoleLibrary`, `hostAllowed`, `isLoopbackBindHost`, `mcpConfigFilePath`, `mutateConfig`, `projectAgentRoleFile`, `readClaudeProjectAgentRoles`, `readConfig`, `readProjectAgentRoles`, `recordInstallLaunch`, `requestIsLoopback`, `resolveExternalMcpServers`, `safeSessionId`, `saveProjectAgentRoles`, `selectedAgentCli`, `serveStatic`, `sweepStaleScriptFiles`, `syncAgentCliMcpManifests`, `syncAgentRolesToClaude`, `syncClaudeCliSettings`, `syncMcpServersToClaude`, `tokenMatches`, `tokenOk`, `waitForBootCliPathProbes` |
| `13-http-router.js` | `01c-runtime-flags.js` | backward | `coreMemoryCharBudget`, `coreMemoryMaxItems`, `memoryFixedSelectionMax`, `memoryRelevanceMax`, `observationRecallEnabled` |
| `13-http-router.js` | `01e-permission-modes.js` | backward | `BUILTIN_AGENT_ROLES`, `PERMISSION_MODES`, `annotateAgentRoleEffective`, `normalizeAgentRole`, `resolvePermissionMode` |
| `13-http-router.js` | `01f-agent-cli-types.js` | backward | `AGENT_CLI_TYPES` |
| `13-http-router.js` | `01g-server-ownership.js` | backward | `ServerOwnership` |
| `13-http-router.js` | `01h-privacy-core.js` | backward | `PrivacyCore` |
| `13-http-router.js` | `01h-process-runtime.js` | backward | `DesktopShell`, `ProcessRuntime`, `existsExecutable`, `existsExecutableAsync`, `probeRgAsync` |
| `13-http-router.js` | `01o-execution-state.js` | backward | `activeAgentRuns`, `activeChildren` |
| `13-http-router.js` | `02-session-store.js` | backward | `MISSION_MAX_TEXT`, `applyMissionUpdate`, `bumpMissionChangeSeq`, `evaluateMissionCheck`, `flushSessionIndexSync`, `flushUsageLedgerSync`, `forEachUsageRow`, `invalidateSessionIndex`, `journalDir`, `journalReadIndex`, `loadSession`, `markInterruptedInterventions`, `materializeCheckpointEditorDiff`, `maybeFinalizeMission`, `mutateSession`, `normalizeMission`, `normalizeTodoItems`, `overlayUnflushedSessionIndex`, `readSessionIndex`, `readSessionRouteHead`, `recordMissionCheckResult`, `saveAgentRun`, `usageDayKeyMemo`, `usageRangeLowerMs`, `workspaceBaselineIsCodePath`, `workspaceBaselinePathKey` |
| `13-http-router.js` | `02e-session-engine-route.js` | backward | `configForSessionEngineRoute` |
| `13-http-router.js` | `03-bridge-guard.js` | backward | `buildCodeEditorSpawn`, `buildRevealSpawn`, `fileAllowedRoots`, `guardWorkspacePath`, `launchCodeEditor`, `remoteUncDenialResolved`, `resolvePreferredCodeEditor`, `resolveWorkspace` |
| `13-http-router.js` | `03a-privacy-gateway.js` | backward | `PrivacyGateway` |
| `13-http-router.js` | `04-permission-runtime.js` | backward | `ToolboxHooks`, `killAllMcpClients`, `makeAttachmentRecord`, `requestSessionExecutionStop`, `stopSession` |
| `13-http-router.js` | `04-visual-pipeline.js` | backward | `VisualPipeline` |
| `13-http-router.js` | `04h-provider-http.js` | backward | `providerScrubSecrets` |
| `13-http-router.js` | `04i-provider-wire.js` | backward | `PROVIDER_PRESETS`, `activeOpenAiProvider`, `normalizeProviderApiStyle`, `resolveProvider`, `sanitizeProvider` |
| `13-http-router.js` | `05-claude-engine.js` | backward | `agentCliAdapter` |
| `13-http-router.js` | `05b-kimi-bridge.js` | backward | `applyKimiStatusToSession`, `kimiSessionStatus`, `kimiStatusFingerprint`, `kimiUsageFromStatus` |
| `13-http-router.js` | `06-provider-engine.js` | backward | `ERROR_CLASSES`, `deleteUserPlaybook`, `draftPlaybookFromSession`, `listPlaybooksWithAvailability`, `matchServiceEntry`, `normalizePlaybook`, `playbookReuseSources`, `saveUserPlaybook` |
| `13-http-router.js` | `06c-agent-workflow-catalog.js` | backward | `agentWorkflowSaveProblem`, `deleteAgentWorkflow`, `getAgentWorkflows`, `normalizeAgentWorkflow`, `saveAgentWorkflow` |
| `13-http-router.js` | `06d-memory-domain.js` | backward | `MEMORY_EXCLUSION_MAX`, `analyzeMemoryMaintenance`, `applyMemoryRelationProposal`, `confirmMemoryRelation`, `decideMemoryProposal`, `deleteMemory`, `deleteMemoryRelation`, `draftMemoryFromSession`, `listMemoryProjectGroups`, `listMemoryRelations`, `loadMemoryRegistry`, `memoryFailureResponse`, `migrateLegacyAccMemory`, `migrateMemory`, `moveMemoryScope`, `projectKeyForCwd`, `proposeMemoryFromSession`, `proposeMemoryRelation`, `readMemoryItem`, `replayPendingMemoryProposal`, `resolveCoreMemoryState`, `saveMemory`, `syncAgentInstructionImports`, `validateMemoryProposalSave` |
| `13-http-router.js` | `06e-mission-domain.js` | backward | `missionControlCommand` |
| `13-http-router.js` | `06f-autonomy-grants.js` | backward | `activeDriverRunOf`, `dryRunGrantFiles`, `installGrant`, `listGrantsView`, `normalizeGrant`, `revokeAllGrants`, `revokeGrant` |
| `13-http-router.js` | `06i-steward-core.js` | backward | `StewardHooks`, `isStewardToolName` |
| `13-http-router.js` | `06v-operational-services.js` | backward | `buildMetricsPayload`, `buildOpsMetrics`, `collectAudit`, `collectStorageStats`, `maybeRecordStorageTrend`, `recordRequestMetric`, `storageSweep` |
| `13-http-router.js` | `06w-capability-service.js` | backward | `getCapabilities` |
| `13-http-router.js` | `07-autonomy.js` | backward | `fetchOpenAiModels`, `policyDesktopOverrideFor`, `probeProviderCompletion`, `projectCwdDirectoryFailure`, `toolPackForName` |
| `13-http-router.js` | `08-agent-runs.js` | backward | `agentRunResultSlice`, `buildAgentRunEnvelope`, `resolveOrchestrateNodes` |
| `13-http-router.js` | `09-workflow.js` | backward | `AGENT_RUN_TERMINAL`, `deliverAgentRunEnvelope`, `resolveWaitAgentsMs`, `runAgentWorkflow`, `settleWaitEnvelopes`, `waitForAgentRunResults` |
| `13-http-router.js` | `09b-agent-recovery.js` | backward | `autoResumeInterruptedRuns`, `markInterruptedAgentRuns` |
| `13-http-router.js` | `10-context-governance.js` | backward | `agentConversationContextMeta`, `configuredConversationWindow`, `learnedWindowCap`, `runAgentExternalCompact` |
| `13-http-router.js` | `10a-session-turn.js` | backward | `runProviderCompactTracked`, `runSessionTurn`, `scheduleAgentWakesAtBoot` |
| `13-http-router.js` | `11-native-tools.js` | backward | `killAllShellSessions` |
| `13-http-router.js` | `12-tool-dispatch.js` | backward | `LAUNCH_MODE`, `TOOL_HANDLERS`, `computeHealth`, `loadSkillRegistry`, `toolCall` |
| `13-http-router.js` | `13b-api-domain-routes.js` | forward | `handleAudioApiRoutes`, `handleCheckpointApiRoutes`, `handleMcpApiRoutes`, `handleSteerApiRoute`, `maybeCompressImageAttachment`, `maybeOcrImageAttachment`, `maybeTranscribeAudioAttachment` |
| `13-http-router.js` | `13d-core-domain-routes.js` | forward | `handleAgentRunApiRoutes`, `handleInterventionApiRoutes`, `handleMissionsApiRoutes`, `handleSessionApiRoutes` |
| `13-http-router.js` | `13e-pretender-index.js` | forward | `warmPretenderProjectionIndex` |
| `13-http-router.js` | `13s-scheduler.js` | forward | `handleSchedulerApiRoutes`, `startScheduler`, `stopScheduler` |
| `13aa-steward-delivery.js` | `00-boot.js` | backward | `DeliveryHooks`, `URL`, `apiFailure`, `apiSessionNotFound`, `crypto`, `ensureDataRootReal`, `fsp`, `isSensitiveDataPath`, `isSensitiveHardlinkAlias`, `json`, `nowIso`, `path`, `pathWithinAnyRoot`, `readFilePreview`, `send`, `text` |
| `13aa-steward-delivery.js` | `01-config.js` | backward | `readConfig`, `safeSessionId`, `tokenOk` |
| `13aa-steward-delivery.js` | `02-session-store.js` | backward | `buildMissionAcceptanceProjection`, `kindForPath`, `loadSession`, `readMissionContainer`, `sessionDisplayTitle`, `sessionMissionId` |
| `13aa-steward-delivery.js` | `03-bridge-guard.js` | backward | `fileAllowedRoots`, `remoteUncDenialResolved` |
| `13aa-steward-delivery.js` | `04-permission-runtime.js` | backward | `sessionExecutionSnapshot` |
| `13aa-steward-delivery.js` | `06i-steward-core.js` | backward | `StewardHooks` |
| `13aa-steward-delivery.js` | `13j-steward-tool-base.js` | backward | `stewardFail`, `stewardRawKind` |
| `13ab-privacy-api.js` | `00-boot.js` | backward | `apiFailure`, `json`, `paths`, `send` |
| `13ab-privacy-api.js` | `01-config.js` | backward | `DurableJsonStore`, `mutateConfig`, `readConfig` |
| `13ab-privacy-api.js` | `01h-privacy-core.js` | backward | `PrivacyCore` |
| `13ab-privacy-api.js` | `01i-privacy-rules.js` | backward | `PrivacyRuleCatalog` |
| `13ab-privacy-api.js` | `01j-local-crypto.js` | backward | `LocalSecretCrypto` |
| `13ab-privacy-api.js` | `01m-privacy-regex.js` | backward | `PrivacyRegex` |
| `13ab-privacy-api.js` | `01o-execution-state.js` | backward | `activeChildren`, `turnSettlers` |
| `13ab-privacy-api.js` | `02e-session-engine-route.js` | backward | `sessionEngineRouteFromConfig` |
| `13ab-privacy-api.js` | `02f-turn-effect-kinds.js` | backward | `normalizeToolInvokeArgs` |
| `13ab-privacy-api.js` | `03a-privacy-gateway.js` | backward | `PrivacyGateway` |
| `13ab-privacy-api.js` | `07-autonomy.js` | backward | `nativeToolSchema` |
| `13ab-privacy-api.js` | `12-tool-dispatch.js` | backward | `TOOL_HANDLERS` |
| `13ab-privacy-api.js` | `13j-steward-tool-base.js` | backward | `stewardAppendDecision` |
| `13ac-desktop-execution-runtime.js` | `00-boot.js` | backward | `DesktopExecutionHooks`, `copyOrdinaryJsonData`, `crypto`, `fs`, `fsp`, `json`, `path`, `paths`, `sessionSaveIsTombstoned` |
| `13ac-desktop-execution-runtime.js` | `01-config.js` | backward | `isEquivalentDesktopAccServer` |
| `13ac-desktop-execution-runtime.js` | `01g-server-ownership.js` | backward | `ServerOwnership` |
| `13ac-desktop-execution-runtime.js` | `01o-execution-state.js` | backward | `activeAgentRuns`, `turnSettlers` |
| `13ac-desktop-execution-runtime.js` | `02-session-store.js` | backward | `loadSession`, `saveSession`, `sessionObjectIsStale`, `sessionRewindGenHighWater` |
| `13ac-desktop-execution-runtime.js` | `02h-desktop-ledger.js` | backward | `DesktopExecutionLedger` |
| `13ac-desktop-execution-runtime.js` | `04-permission-runtime.js` | backward | `McpStdioClient`, `mcpClients`, `probeDesktopExecutionReceipts` |
| `13ac-desktop-execution-runtime.js` | `04h-provider-http.js` | backward | `ProviderHttpHooks` |
| `13b-api-domain-routes.js` | `00-boot.js` | backward | `ASR_MAX_BODY_BYTES`, `MigrationHooks`, `URL`, `apiFailure`, `apiSessionIdInvalid`, `computeProviderCost`, `crypto`, `fsp`, `json`, `logEvent`, `maskExternalMcpServerForDisplay`, `normalizeStoragePolicy`, `nowIso`, `os`, `path`, `paths`, `readJsonBody`, `redact`, `safeJsonParse`, `sanitizeExternalMcpServer`, `scanMcpSources`, `send`, `text` |
| `13b-api-domain-routes.js` | `01-config.js` | backward | `buildUserEnvelope`, `generateMcpConfig`, `mutateConfig`, `readConfig`, `resolveExternalMcpServers`, `safeSessionId`, `writeToChild` |
| `13b-api-domain-routes.js` | `01o-execution-state.js` | backward | `activeAgentRuns`, `activeChildren` |
| `13b-api-domain-routes.js` | `02-session-store.js` | backward | `appendUsageLedger`, `bumpMissionChangeSeq`, `journalRevertLogRecord`, `journalRollback`, `mutateSession`, `rewindSession`, `saveSession` |
| `13b-api-domain-routes.js` | `03a-privacy-gateway.js` | backward | `PrivacyGateway` |
| `13b-api-domain-routes.js` | `04-permission-runtime.js` | backward | `MCP_COMPAT_MATRIX`, `ToolboxHooks`, `buildMcpConnectorInventory`, `collectBridgedTools`, `getBridgedClient`, `hasPendingQuestionForSession`, `invalidateMcpRuntime`, `mutateMcpConnector`, `probeMcpConnector`, `resolveBridge`, `sanitizeFsSegmentName` |
| `13b-api-domain-routes.js` | `04-visual-pipeline.js` | backward | `VisualPipeline` |
| `13b-api-domain-routes.js` | `04i-provider-wire.js` | backward | `activeOpenAiProvider` |
| `13b-api-domain-routes.js` | `04j-voice-learn.js` | backward | `VoiceLearn` |
| `13b-api-domain-routes.js` | `04j-voice-lexicon.js` | backward | `VoiceLexicon` |
| `13b-api-domain-routes.js` | `04m-voice-service.js` | backward | `asrFixMessages`, `asrFixModeOf`, `asrFixSanity`, `providerFixCompletion`, `resolveAsrFixProvider`, `resolveAsrProvider`, `resolveAsrStreamProvider`, `transcribeAudioViaProvider`, `voiceLexiconAsrPromptFor`, `voiceLexiconRead`, `voiceLexiconUpdate` |
| `13b-api-domain-routes.js` | `06v-operational-services.js` | backward | `storageSweep` |
| `13b-api-domain-routes.js` | `07-autonomy.js` | backward | `STEER_QUEUE_MAX` |
| `13d-core-domain-routes.js` | `00-boot.js` | backward | `DESKTOP_MCP_SERVER_ID`, `EventStreamHooks`, `RUYI_EVENTS`, `URL`, `apiFailure`, `apiSessionIdInvalid`, `apiSessionNotFound`, `cliBridgeToolTier`, `crypto`, `dataRootAliases`, `fsp`, `json`, `logEvent`, `makeId`, `normalizeCwd`, `nowIso`, `os`, `path`, `pathWithinRoot`, `paths`, `readJsonBody`, `redact`, `runKeyedChain`, `safeDecodeURIComponent`, `safeJsonParse`, `send`, `text`, `toolDisabledByPolicy` |
| `13d-core-domain-routes.js` | `00b-ruyi-names.js` | backward | `RUYI_MCP_CLI_TOOL_PREFIX` |
| `13d-core-domain-routes.js` | `01-config.js` | backward | `atomicWriteJson`, `getAgentRoleLibrary`, `readConfig`, `safeSessionId`, `sessionPath`, `tokenMatches`, `tokenOk` |
| `13d-core-domain-routes.js` | `01c-runtime-flags.js` | backward | `sessionSearchIndexEnabled` |
| `13d-core-domain-routes.js` | `01e-permission-modes.js` | backward | `PERMISSION_MODES`, `PERMISSION_MODES_REQUIRING_CONFIRM`, `resolvePermissionMode` |
| `13d-core-domain-routes.js` | `01o-execution-state.js` | backward | `activeAgentRuns`, `activeChildren`, `pendingPermissions`, `pendingPlans`, `pendingQuestions`, `turnSettlers` |
| `13d-core-domain-routes.js` | `02-session-store.js` | backward | `AgentRunStore`, `agentRunDigestRow`, `agentRunEventsFile`, `agentRunFile`, `appendAgentRunEvent`, `buildMissionAcceptanceProjection`, `bumpMissionChangeSeq`, `bumpRunIntervention`, `compactInterventionJournal`, `createMissionContainer`, `createSession`, `detectDanglingTurn`, `foldTurnSummaries`, `journalReadIndex`, `listAgentRunDigests`, `listAgentRuns`, `listMissionContainers`, `listSessions`, `loadSession`, `missionAttachThread`, `missionContainerAcceptanceStamp`, `missionDetachThread`, `missionMergeInto`, `missionSplitThreads`, `patchMissionContainer`, `readAgentRunEvents`, `readMissionChangesWithMeta`, `readMissionContainer`, `readMissionSessionHead`, `readSessionHeadResilient`, `registerIntervention`, `saveAgentRun`, `saveSession`, `sessionBodyPaths`, `sessionBriefOf`, `sessionDisplayTitle`, `sessionKind`, `sessionMessagesDelta`, `sessionMeta`, `sessionMissionId`, `sessionOmittedProviderHistory`, `sessionProviderHistoryLength`, `settleIntervention`, `transitionInterventionState`, `updateSessionMeta` |
| `13d-core-domain-routes.js` | `02d-session-overrides.js` | backward | `sessionDesktopToolsOf`, `sessionDesktopToolsOverrides`, `sessionPermissionModeOverrides` |
| `13d-core-domain-routes.js` | `03-bridge-guard.js` | backward | `bridgedReadPathGate`, `resolveContainmentPath` |
| `13d-core-domain-routes.js` | `03a-privacy-gateway.js` | backward | `PrivacyGateway` |
| `13d-core-domain-routes.js` | `04-permission-runtime.js` | backward | `decideInterventionCommand`, `driverAutoSessions`, `extendUserQuestion`, `interventionCommandFailure`, `normalizeQuestionAnswer`, `permissionWaitMs`, `requestUserQuestion`, `runAutomaticInterventionDecision`, `sessionExecutionObservation`, `sessionExecutionSnapshot` |
| `13d-core-domain-routes.js` | `04g-session-deletion.js` | backward | `bulkDeleteUnpinnedSessions`, `deleteSession` |
| `13d-core-domain-routes.js` | `06e-mission-domain.js` | backward | `missionControlCommand`, `missionControlView` |
| `13d-core-domain-routes.js` | `06f-autonomy-grants.js` | backward | `consumeGrant` |
| `13d-core-domain-routes.js` | `06h-retrieval-index.js` | backward | `createRetrievalCorpusCache`, `rankRetrievalCorpus`, `retrievalTerms` |
| `13d-core-domain-routes.js` | `06i-steward-core.js` | backward | `STEWARD_SESSION_ID`, `StewardHooks`, `aggregateMissionState`, `deriveStewardThreadState`, `stewardRuyiOwnedPath`, `stewardSanitizeText`, `stewardThreadStateFromCard`, `stewardThreadStateFromHead`, `stewardThreadStateRank`, `stewardThreadTurnQueued`, `waitReasonFor` |
| `13d-core-domain-routes.js` | `07-autonomy.js` | backward | `STEER_QUEUE_MAX`, `nativeToolGate`, `toolDisabledResult`, `toolIsRevertible` |
| `13d-core-domain-routes.js` | `08-agent-runs.js` | backward | `applyAgentWorktree`, `cleanupAgentWorktree`, `materializePoolItem`, `nodeDeliveryEligibility` |
| `13d-core-domain-routes.js` | `09-workflow.js` | backward | `launchPersistedAgentRun` |
| `13d-core-domain-routes.js` | `09b-replan-ledger.js` | backward | `applyReplanPatch` |
| `13d-core-domain-routes.js` | `13e-pretender-index.js` | forward | `emptyMissionUsage`, `getPretenderProjectionIndex`, `missionCardStatus`, `missionPendingCounts`, `missionRunDigest`, `overlayMissionCard`, `paginatePretenderProjection`, `pretenderEtag`, `pretenderHash`, `pretenderIndexMeta`, `pretenderIndexRuntime`, `pretenderLiveOverlayRevision`, `pretenderNotModified` |
| `13e-pretender-index.js` | `00-boot.js` | backward | `EventStreamHooks`, `RUYI_EVENTS`, `URL`, `apiFailure`, `crypto`, `fs`, `fsp`, `nowIso`, `path`, `paths`, `safeJsonParse` |
| `13e-pretender-index.js` | `01-config.js` | backward | `THREAD_INDEX_RECENT_DEFAULT`, `THREAD_INDEX_RECENT_MAX`, `THREAD_INDEX_RECENT_MIN`, `atomicWriteJson`, `readConfig`, `safeSessionId`, `sessionPath`, `sessionsDirOwnWriteSeq` |
| `13e-pretender-index.js` | `01o-execution-state.js` | backward | `activeAgentRuns`, `activeChildren` |
| `13e-pretender-index.js` | `02-session-store.js` | backward | `agentRunDir`, `agentRunHealth`, `compactInterventionJournal`, `forEachUsageRow`, `interventionFilePath`, `interventionJournalWorthCompacting`, `listAgentRuns`, `readInterventions`, `readInterventionsWithMeta`, `sessionBriefOf`, `sessionDisplayTitle`, `sessionKind`, `sessionMissionId`, `usageLedgerChangesSince` |
| `13e-pretender-index.js` | `04-permission-runtime.js` | backward | `sessionExecutionSnapshot` |
| `13e-pretender-index.js` | `06i-steward-core.js` | backward | `stewardAsksYouForThread`, `stewardThreadTurnQueued`, `stewardWatchedThread`, `threadOriginOf`, `threadVisible` |
| `13e-pretender-index.js` | `08-agent-runs.js` | backward | `computeWaveSeq`, `nodeDeliveryEligibility` |
| `13g-steward.js` | `00-boot.js` | backward | `ExternalBotHooks`, `URL`, `apiFailure`, `json`, `logEvent`, `nowIso`, `readJsonBody`, `send`, `text` |
| `13g-steward.js` | `01-config.js` | backward | `readConfig`, `tokenOk` |
| `13g-steward.js` | `02-session-store.js` | backward | `loadSession` |
| `13g-steward.js` | `03a-privacy-gateway.js` | backward | `PrivacyGateway` |
| `13g-steward.js` | `06d-memory-domain.js` | backward | `memoryIsExpired`, `memoryProposalLooksSensitive` |
| `13g-steward.js` | `06i-steward-core.js` | backward | `STEWARD_MEMORY_KINDS`, `STEWARD_MEMORY_LIMITS`, `STEWARD_PREROUTE_QUERY_MAX`, `STEWARD_SESSION_ID`, `StewardHooks`, `stewardSanitizeText` |
| `13g-steward.js` | `07-autonomy.js` | backward | `nativeToolSchema` |
| `13g-steward.js` | `12-tool-dispatch.js` | backward | `jsonSchemaValueProblems` |
| `13g-steward.js` | `13i-steward-inbox.js` | backward | `startStewardInbox`, `stewardInboxRead`, `stewardInboxState`, `stopStewardInbox` |
| `13g-steward.js` | `13j-steward-tool-base.js` | backward | `STEWARD_MEMORY_NEW_WINDOW_MS`, `STEWARD_MEMORY_SCHEMA`, `stewardAppendDecision`, `stewardDecisionsRead`, `stewardFail`, `stewardMemoryScopeLabel`, `stewardMutateMemory`, `stewardQuickClosed`, `stewardReadMemoryStore`, `stewardTurnTaintedBy` |
| `13g-steward.js` | `13k-steward-threads.js` | backward | `stewardEnrichInboxRows`, `stewardImplQuickAsk`, `stewardImplThreadContinue`, `stewardImplThreadNew`, `stewardImplThreadNote`, `stewardImplThreadPermission`, `stewardImplThreadRead`, `stewardImplThreadRename`, `stewardImplThreadStatus`, `stewardImplThreadWorkspace`, `stewardImplThreadsSearch`, `stewardQuickClose`, `threadRelatedThreads`, `threadRelationsIndex` |
| `13g-steward.js` | `13l-steward-ops.js` | backward | `stewardImplAuditTail`, `stewardImplConfigGet`, `stewardImplConfigSet`, `stewardImplDecide`, `stewardImplFileRead`, `stewardImplHealth`, `stewardImplInboxRead`, `stewardImplMemorySearch`, `stewardImplMemoryVeto`, `stewardImplMemoryWrite`, `stewardImplMissions`, `stewardImplNotify`, `stewardImplPlaybookDraft`, `stewardImplPlaybooks`, `stewardImplProviders`, `stewardImplRunAction`, `stewardImplRunsStatus`, `stewardImplSelfStatus`, `stewardImplSkillToggle`, `stewardImplSkills`, `stewardImplThreadArtifactRead`, `stewardImplUsage`, `stewardImplWebFetch`, `stewardImplWebSearch` |
| `13h-steward-runner.js` | `00-boot.js` | backward | `SessionExecutionHooks`, `apiFailure`, `json`, `nowIso`, `readJsonBody`, `send` |
| `13h-steward-runner.js` | `01-config.js` | backward | `readConfig`, `safeSessionId`, `tokenOk` |
| `13h-steward-runner.js` | `03a-privacy-gateway.js` | backward | `PrivacyGateway` |
| `13h-steward-runner.js` | `04-permission-runtime.js` | backward | `requestSessionExecutionStop` |
| `13h-steward-runner.js` | `06f-autonomy-grants.js` | backward | `revokeAllGrants` |
| `13h-steward-runner.js` | `06i-steward-core.js` | backward | `STEWARD_SESSION_ID`, `StewardHooks`, `stewardSanitizeText`, `waitReasonFor` |
| `13h-steward-runner.js` | `13g-steward.js` | backward | `stewardToolHandler` |
| `13h-steward-runner.js` | `13j-steward-tool-base.js` | backward | `stewardAppendDecision`, `stewardBasisOf`, `stewardFail`, `stewardRawKind`, `stewardReadSessionHead`, `stewardThreadPermissionMode` |
| `13h-steward-runner.js` | `13m-steward-runner-base.js` | backward | `STEWARD_TURN_DAY_MS`, `STEWARD_TURN_WINDOW_MS`, `ensureStewardSession`, `stewardResumeRunner`, `stewardRunnerRuntime`, `stewardStopRunner` |
| `13h-steward-runner.js` | `13n-steward-arbiter.js` | backward | `stewardAcquireTurnSlot`, `stewardArbiterPrioritize`, `stewardArbiterRefresh`, `stewardArbiterState`, `stewardArbiterWait`, `stewardCancelQueuedTurn` |
| `13h-steward-runner.js` | `13o-steward-runner-prompt.js` | backward | `buildStewardSystemPrompt`, `stewardContextBudget`, `stewardPreroute`, `stewardVisitNotesPrompt` |
| `13h-steward-runner.js` | `13p-steward-runner-actions.js` | backward | `stewardDayCost`, `stewardTurnsInWindow` |
| `13h-steward-runner.js` | `13q-steward-runner-turn.js` | backward | `runStewardTurn`, `stewardApplyThreadTier`, `stewardOnInboxBatch`, `stewardRelayChannelFor`, `stewardRelayDeliver`, `stewardResetConversation`, `stewardRunAct`, `stewardVisit` |
| `13i-steward-inbox.js` | `00-boot.js` | backward | `EventStreamHooks`, `RUYI_EVENTS`, `fs`, `fsp`, `logEvent`, `nowIso`, `path`, `paths`, `safeJsonParse`, `text` |
| `13i-steward-inbox.js` | `01-config.js` | backward | `atomicWriteJson`, `readConfig`, `safeSessionId`, `sessionPath` |
| `13i-steward-inbox.js` | `01o-execution-state.js` | backward | `activeAgentRuns`, `activeChildren`, `turnSettlers` |
| `13i-steward-inbox.js` | `02-session-store.js` | backward | `listAgentRuns`, `readAgentRunEvents`, `readMissionChangesWithMeta`, `repairMissionChangeTornTail` |
| `13i-steward-inbox.js` | `04-permission-runtime.js` | backward | `turnOutcomePending` |
| `13i-steward-inbox.js` | `06i-steward-core.js` | backward | `STEWARD_EVENT_KINDS`, `STEWARD_SESSION_ID`, `StewardHooks`, `stewardCoveringLastTurn`, `stewardSanitizeText`, `stewardWatchedThread` |
| `13i-steward-inbox.js` | `13e-pretender-index.js` | backward | `getPretenderProjectionIndex` |
| `13j-steward-tool-base.js` | `00-boot.js` | backward | `fsp`, `nowIso`, `path`, `safeJsonParse`, `text` |
| `13j-steward-tool-base.js` | `01-config.js` | backward | `atomicWriteJson`, `readFileTail`, `safeSessionId`, `sessionPath` |
| `13j-steward-tool-base.js` | `01e-permission-modes.js` | backward | `resolvePermissionMode` |
| `13j-steward-tool-base.js` | `01o-execution-state.js` | backward | `providerTurnQuotaKey` |
| `13j-steward-tool-base.js` | `02-session-store.js` | backward | `foldTurnSummaries`, `repairMissionChangeTornTail` |
| `13j-steward-tool-base.js` | `02d-session-overrides.js` | backward | `applySessionPermissionModeOverride` |
| `13j-steward-tool-base.js` | `06d-memory-domain.js` | backward | `cleanMemoryDate`, `projectKeyForCwd` |
| `13j-steward-tool-base.js` | `06i-steward-core.js` | backward | `STEWARD_CONFIG_SECRET_PATTERN`, `STEWARD_EXEMPT_DELEGATION_WINDOW_MS`, `STEWARD_MEMORY_KINDS`, `STEWARD_MEMORY_LIMITS`, `STEWARD_NOTIFY_WINDOW_MS`, `stewardSanitizeText` |
| `13j-steward-tool-base.js` | `13i-steward-inbox.js` | backward | `stewardDir` |
| `13k-steward-threads.js` | `00-boot.js` | backward | `EventStreamHooks`, `ExternalBotHooks`, `dataRoot`, `dataRootAliases`, `decodeTextFileBytes`, `fsp`, `logEvent`, `nowIso`, `path`, `pathWithinRoot`, `paths`, `redact`, `text` |
| `13k-steward-threads.js` | `01-config.js` | backward | `mutateConfig`, `normalizeWorkspacePathString`, `safeSessionId` |
| `13k-steward-threads.js` | `01c-runtime-flags.js` | backward | `sessionSearchIndexEnabled` |
| `13k-steward-threads.js` | `01e-permission-modes.js` | backward | `PERMISSION_MODES` |
| `13k-steward-threads.js` | `01o-execution-state.js` | backward | `activeChildren` |
| `13k-steward-threads.js` | `02-session-store.js` | backward | `SESSION_BRIEF_TITLE_CHARS`, `createSession`, `isUntitledSessionTitle`, `listSessions`, `loadSession`, `missionIndexAdd`, `readInterventions`, `readMissionContainer`, `saveSession`, `sessionBriefOf`, `sessionDisplayTitle`, `sessionMeta`, `sessionMetaIsSteward`, `sessionMissionId`, `updateSessionMeta`, `withMissionContainerLock`, `writeMissionContainer` |
| `13k-steward-threads.js` | `02d-session-overrides.js` | backward | `sessionDesktopToolsOf`, `sessionPermissionModeOf` |
| `13k-steward-threads.js` | `03-bridge-guard.js` | backward | `realpathForContainment` |
| `13k-steward-threads.js` | `04-permission-runtime.js` | backward | `PermissionWaitHooks`, `sanitizeFsSegmentName`, `sessionExecutionSnapshot` |
| `13k-steward-threads.js` | `06-provider-engine.js` | backward | `listPlaybooksWithAvailability` |
| `13k-steward-threads.js` | `06b-prompt-registry.js` | backward | `getPromptPack` |
| `13k-steward-threads.js` | `06d-memory-domain.js` | backward | `memoryIsExpired` |
| `13k-steward-threads.js` | `06i-steward-core.js` | backward | `STEWARD_ANSWER_BASIS`, `STEWARD_DELIVERABLE_CHARS`, `STEWARD_EXEMPT_INPUT_CHARS`, `STEWARD_QUICK_ANSWER_CHARS`, `STEWARD_QUICK_KIND`, `STEWARD_QUICK_QUESTION_CHARS`, `STEWARD_SESSION_ID`, `STEWARD_WORKSPACE_TABLE_MAX`, `StewardHooks`, `buildStewardBrief`, `deriveStewardThreadState`, `stewardAsksYouForThread`, `stewardAssemblePlaybookPrompt`, `stewardClipSay`, `stewardExemptExcerpt`, `stewardExemptHits`, `stewardExemptInputText`, `stewardExemptScanInput`, `stewardForeignProjection`, `stewardMayAct`, `stewardMayTightenTo`, `stewardOpenAiFallback`, `stewardPendingOneLine`, `stewardPermissionLabel`, `stewardPlaybookMissingInputs`, `stewardRuyiOwnedPath`, `stewardSamePath`, `stewardSanitizeBlock`, `stewardSanitizeText`, `stewardStoppedRefusal`, `stewardStoppedTarget`, `stewardThreadStateFromCard`, `stewardThreadStateFromHead`, `stewardTurnTaint`, `stewardWatchedThread`, `stewardWorkspaceLabels`, `stewardWorkspaceRootFor`, `threadOriginOf`, `waitReasonFor` |
| `13k-steward-threads.js` | `10a-session-turn.js` | backward | `runSessionTurn` |
| `13k-steward-threads.js` | `13b-api-domain-routes.js` | backward | `steerSessionCore` |
| `13k-steward-threads.js` | `13d-core-domain-routes.js` | backward | `SESSION_SEARCH_MIN_QUERY`, `buildMissionAggregateRows`, `searchSessionsByContent`, `sessionSearchScope` |
| `13k-steward-threads.js` | `13e-pretender-index.js` | backward | `getPretenderProjectionIndex`, `missionPendingCounts`, `overlayMissionCard` |
| `13k-steward-threads.js` | `13j-steward-tool-base.js` | backward | `STEWARD_NOTE_PREFIX`, `STEWARD_NOTE_TEXT_MAX`, `STEWARD_PENDING_SUMMARY_MAX`, `STEWARD_QUICK_ASKS_PER_TURN`, `STEWARD_READ_CALLS_PER_TURN`, `STEWARD_READ_CHARS_DEFAULT`, `STEWARD_READ_CHARS_MAX`, `STEWARD_READ_CHARS_MIN`, `STEWARD_READ_CLIP_MARK`, `STEWARD_READ_ROW_OVERHEAD`, `STEWARD_READ_TAIL_DEFAULT`, `STEWARD_READ_TAIL_MAX`, `STEWARD_SEARCH_LIMIT_DEFAULT`, `STEWARD_SEARCH_LIMIT_MAX`, `STEWARD_TITLE_MAX`, `stewardAppendDecision`, `stewardBasisOf`, `stewardClampInt`, `stewardDisplayKind`, `stewardEngineOf`, `stewardFail`, `stewardLastAssistantText`, `stewardQuickClosed`, `stewardQuickThread`, `stewardRawKind`, `stewardReadBucket`, `stewardReadMemoryStore`, `stewardReadSessionHead`, `stewardThreadPermissionMode`, `stewardTurnAssistantText`, `stewardTurnFiles`, `stewardTurnKeyOf`, `stewardTurnQuotaTake`, `stewardTurnTaintedBy` |
| `13l-steward-ops.js` | `00-boot.js` | backward | `KEY_MASK_PREFIX`, `RUYI_EVENTS`, `fsp`, `makeId`, `maskProviders`, `maskedSecretConflictMessage`, `maskedSecretConflicts`, `nowIso`, `path`, `pathWithinRoot`, `redact`, `safeJsonParse`, `text`, `unmaskSecrets` |
| `13l-steward-ops.js` | `01-config.js` | backward | `ConfigPatchHooks`, `normalizeConfig`, `safeSessionId` |
| `13l-steward-ops.js` | `01e-permission-modes.js` | backward | `PERMISSION_MODES_REQUIRING_CONFIRM` |
| `13l-steward-ops.js` | `01h-privacy-core.js` | backward | `PrivacyCore` |
| `13l-steward-ops.js` | `01o-execution-state.js` | backward | `activeAgentRuns` |
| `13l-steward-ops.js` | `02-session-store.js` | backward | `agentRunFile`, `forEachUsageRow`, `listAgentRuns`, `loadSession`, `readInterventions`, `usageDayKey`, `usageDayKeyMemo` |
| `13l-steward-ops.js` | `03-bridge-guard.js` | backward | `realpathForContainment` |
| `13l-steward-ops.js` | `03a-privacy-gateway.js` | backward | `privacySourceMark`, `sourceViewOf` |
| `13l-steward-ops.js` | `06-provider-engine.js` | backward | `draftPlaybookFromSession`, `listPlaybooksWithAvailability`, `playbookReuseSources` |
| `13l-steward-ops.js` | `06d-memory-domain.js` | backward | `cleanMemoryDate`, `memoryIsExpired`, `memoryProposalLooksSensitive` |
| `13l-steward-ops.js` | `06i-steward-core.js` | backward | `STEWARD_CATALOG_DESC_CHARS`, `STEWARD_CATALOG_ROWS`, `STEWARD_EXEMPT_CATEGORY_LABELS`, `STEWARD_EYES_CHARS`, `STEWARD_MEMORY_KINDS`, `STEWARD_MEMORY_LIMITS`, `STEWARD_NOTIFY_KINDS`, `STEWARD_NOTIFY_TEXT_CHARS`, `STEWARD_SESSION_ID`, `isStewardToolName`, `stewardAutoAskIndirect`, `stewardAutoAskScanIncomplete`, `stewardAutoAskSensitiveKind`, `stewardConfigHelpFor`, `stewardConfigTierFor`, `stewardExemptDelegationVerdict`, `stewardExemptHits`, `stewardExemptReason`, `stewardExemptRiskNote`, `stewardExemptScanInput`, `stewardForeignProjection`, `stewardMayAct`, `stewardMemoryTerms`, `stewardPermissionLabel`, `stewardPermissionRank`, `stewardSamePath`, `stewardSanitizeBlock`, `stewardSanitizeText`, `stewardStateLabel`, `stewardStoppedRefusal`, `stewardStoppedTarget`, `stewardTermJaccard`, `stewardThreadArtifactFiles`, `stewardWatchedThread`, `stewardWorkspaceRootFor`, `threadOriginOf` |
| `13l-steward-ops.js` | `06v-operational-services.js` | backward | `collectAudit` |
| `13l-steward-ops.js` | `07-autonomy.js` | backward | `httpRequestInternalTargetReason`, `webPayloadReason` |
| `13l-steward-ops.js` | `09b-agent-recovery.js` | backward | `AgentRecovery` |
| `13l-steward-ops.js` | `11-native-tools.js` | backward | `webFetch`, `webSearch` |
| `13l-steward-ops.js` | `12-tool-dispatch.js` | backward | `TOOL_HANDLERS`, `buildWorkbenchSelfStatus`, `computeHealth`, `loadSkillRegistry` |
| `13l-steward-ops.js` | `13-http-router.js` | backward | `setSessionSkillsCore` |
| `13l-steward-ops.js` | `13d-core-domain-routes.js` | backward | `agentRunActionCommand`, `buildMissionAggregateRows`, `decideIntervention` |
| `13l-steward-ops.js` | `13e-pretender-index.js` | backward | `getPretenderProjectionIndex`, `missionRunDigest` |
| `13l-steward-ops.js` | `13i-steward-inbox.js` | backward | `stewardInboxPendingState`, `stewardInboxRead`, `stewardInboxState` |
| `13l-steward-ops.js` | `13j-steward-tool-base.js` | backward | `STEWARD_AUDIT_LIMIT_DEFAULT`, `STEWARD_AUDIT_LIMIT_MAX`, `STEWARD_MEMORY_MERGED_FROM_MAX`, `STEWARD_MISSIONS_LIMIT_DEFAULT`, `STEWARD_MISSIONS_LIMIT_MAX`, `STEWARD_PLAYBOOK_DRAFTS_PER_TURN`, `STEWARD_READ_CALLS_PER_TURN`, `STEWARD_RUNS_MAX`, `STEWARD_STEER_TEXT_MAX`, `stewardAppendDecision`, `stewardBasisOf`, `stewardClampInt`, `stewardExemptDelegationRecord`, `stewardExemptDelegationsInWindow`, `stewardFail`, `stewardMarkTurnTainted`, `stewardMemoryScopeMatches`, `stewardMemoryScopeOf`, `stewardMutateMemory`, `stewardNormalizeMemoryScope`, `stewardNotifiesInWindow`, `stewardNotifyRecord`, `stewardRawKind`, `stewardReadBucket`, `stewardReadMemoryStore`, `stewardReadSessionHead`, `stewardThreadPermissionMode`, `stewardTurnKeyOf`, `stewardTurnQuotaRefund`, `stewardTurnQuotaTake`, `stewardTurnTaintedBy` |
| `13l-steward-ops.js` | `13k-steward-threads.js` | backward | `stewardExemptDelegatedLog`, `stewardExemptLiveTurn`, `stewardExemptPendingSummary`, `stewardKnownWorkspaces`, `stewardLiveTurnPermissionMode`, `stewardSeatedByUser`, `stewardSeatedFail`, `stewardToolCallLine`, `stewardToolCallVerdict`, `stewardUserDirected`, `stewardWorkspaceNameOf` |
| `13m-steward-runner-base.js` | `00-boot.js` | backward | `SESSION_SCHEMA`, `logEvent`, `nowIso`, `paths` |
| `13m-steward-runner-base.js` | `01f-agent-cli-types.js` | backward | `AGENT_CLI_TYPES`, `normalizeAgentCliType` |
| `13m-steward-runner-base.js` | `02-session-store.js` | backward | `loadSession`, `saveSession` |
| `13m-steward-runner-base.js` | `02e-session-engine-route.js` | backward | `normalizeSessionEngineRoute`, `sessionEngineRouteFromConfig` |
| `13m-steward-runner-base.js` | `04-permission-runtime.js` | backward | `stopSession` |
| `13m-steward-runner-base.js` | `06-provider-engine.js` | backward | `ERROR_CLASSES` |
| `13m-steward-runner-base.js` | `06i-steward-core.js` | backward | `STEWARD_PERMISSION_MODE`, `STEWARD_SESSION_ID`, `STEWARD_SESSION_TITLE`, `stewardSanitizeText` |
| `13n-steward-arbiter.js` | `00-boot.js` | backward | `OVERLAY_ID`, `RUYI_EVENTS`, `crypto`, `fs`, `logEvent`, `path` |
| `13n-steward-arbiter.js` | `01-config.js` | backward | `readConfig`, `safeSessionId` |
| `13n-steward-arbiter.js` | `01o-execution-state.js` | backward | `turnSettlers` |
| `13n-steward-arbiter.js` | `02-session-store.js` | backward | `forEachUsageRow`, `readInterventions`, `recordMissionBudgetTrippedChange`, `usageDayKey`, `usageDayKeyMemo`, `usageRangeLowerMs` |
| `13n-steward-arbiter.js` | `04-permission-runtime.js` | backward | `assertSessionExecutionOwner` |
| `13n-steward-arbiter.js` | `06i-steward-core.js` | backward | `STEWARD_SESSION_ID`, `stewardSanitizeText`, `waitReasonFor` |
| `13n-steward-arbiter.js` | `13m-steward-runner-base.js` | backward | `STEWARD_TURN_DAY_MS`, `STEWARD_TURN_WINDOW_MS` |
| `13o-steward-runner-prompt.js` | `00-boot.js` | backward | `fsp`, `logEvent`, `path`, `redact`, `text` |
| `13o-steward-runner-prompt.js` | `01-config.js` | backward | `readConfig`, `safeSessionId` |
| `13o-steward-runner-prompt.js` | `01o-execution-state.js` | backward | `activeChildren` |
| `13o-steward-runner-prompt.js` | `02-session-store.js` | backward | `listSessions`, `readMissionContainer`, `sessionDisplayTitle`, `sessionMeta`, `sessionMetaIsSteward`, `sessionMissionId` |
| `13o-steward-runner-prompt.js` | `02d-session-overrides.js` | backward | `applySessionPermissionModeOverride` |
| `13o-steward-runner-prompt.js` | `06b-prompt-registry.js` | backward | `getPromptPack` |
| `13o-steward-runner-prompt.js` | `06d-memory-domain.js` | backward | `memoryIsExpired` |
| `13o-steward-runner-prompt.js` | `06i-steward-core.js` | backward | `STEWARD_DIGEST_LIMITS`, `STEWARD_KNOWN_WORKSPACE_LIMITS`, `STEWARD_MEMORY_KINDS`, `STEWARD_MEMORY_LIMITS`, `STEWARD_SESSION_ID`, `STEWARD_WORKSPACE_TABLE_MAX`, `StewardHooks`, `buildStewardDigestLine`, `isStewardToolName`, `prerouteText`, `stewardActConfirmSpec`, `stewardForeignProjection`, `stewardSanitizeText`, `stewardThreadStateFromCard`, `stewardThreadStateFromHead`, `stewardTrimSayAtSentence`, `waitReasonFor` |
| `13o-steward-runner-prompt.js` | `06j-scheduler-core.js` | backward | `normalizeSchedulerTask` |
| `13o-steward-runner-prompt.js` | `07-autonomy.js` | backward | `nativeToolSchema` |
| `13o-steward-runner-prompt.js` | `08-agent-runs.js` | backward | `parseStructuredAgentOutput` |
| `13o-steward-runner-prompt.js` | `12-tool-dispatch.js` | backward | `jsonSchemaObjectProblems` |
| `13o-steward-runner-prompt.js` | `13e-pretender-index.js` | backward | `getPretenderProjectionIndex`, `overlayMissionCard` |
| `13o-steward-runner-prompt.js` | `13j-steward-tool-base.js` | backward | `stewardMemoryScopeLabel`, `stewardQuickThread`, `stewardRawKind`, `stewardReadMemoryStore`, `stewardReadSessionHead`, `stewardThreadPermissionMode` |
| `13o-steward-runner-prompt.js` | `13k-steward-threads.js` | backward | `stewardCanonWorkspacePath`, `stewardFoldWorkspacePath`, `stewardKnownWorkspaces`, `stewardSeatedByUser`, `stewardThreadDisplayTitle` |
| `13o-steward-runner-prompt.js` | `13m-steward-runner-base.js` | backward | `STEWARD_ACTIONS_MAX`, `STEWARD_ACTION_HOOKS`, `STEWARD_ACTS_MAX`, `STEWARD_ACT_CONFIRM_LABEL_MAX`, `STEWARD_ACT_CONFIRM_VALUE_CHARS`, `STEWARD_ACT_LABEL_MAX`, `STEWARD_DECIDE_LABELS`, `STEWARD_MEMORY_BLOCK_CHARS`, `STEWARD_MEMORY_VETOED_BLOCK_CHARS`, `STEWARD_MEMORY_VETOED_MAX`, `STEWARD_RUN_ACTION_LABELS`, `STEWARD_SAY_CEILING`, `STEWARD_TOOL_LABELS`, `STEWARD_WHY_MAX`, `stewardRunnerRuntime` |
| `13o-steward-runner-prompt.js` | `13n-steward-arbiter.js` | backward | `stewardArbiterWait` |
| `13p-steward-runner-actions.js` | `00-boot.js` | backward | `logEvent`, `text` |
| `13p-steward-runner-actions.js` | `01-config.js` | backward | `configValueEquals`, `safeSessionId` |
| `13p-steward-runner-actions.js` | `01o-execution-state.js` | backward | `activeChildren` |
| `13p-steward-runner-actions.js` | `02-session-store.js` | backward | `SESSION_LOAD_OMIT_PROVIDER`, `detectDanglingTurn`, `forEachUsageRow`, `loadSession`, `mutateSession`, `readInterventions`, `sessionDisplayTitle`, `sessionTodosSignature`, `usageDayKey`, `usageDayKeyMemo`, `usageRangeLowerMs` |
| `13p-steward-runner-actions.js` | `06b-prompt-registry.js` | backward | `getPromptPack` |
| `13p-steward-runner-actions.js` | `06i-steward-core.js` | backward | `STEWARD_ANSWER_BASIS`, `STEWARD_EXEMPT_CATEGORY_LABELS`, `STEWARD_SESSION_ID`, `StewardHooks`, `stewardActConfirmSpec`, `stewardAsksYouForThread`, `stewardForeignProjection`, `stewardHumanizeIds`, `stewardMayAct`, `stewardPermissionLabel`, `stewardSanitizeBlock`, `stewardSanitizeText`, `stewardStoppedRefusal`, `stewardStoppedTarget` |
| `13p-steward-runner-actions.js` | `13g-steward.js` | backward | `stewardAuthorizeExternalContext`, `stewardExternalOwnerDirected` |
| `13p-steward-runner-actions.js` | `13j-steward-tool-base.js` | backward | `stewardAppendDecision`, `stewardFail`, `stewardLastAssistantText`, `stewardReadSessionHead`, `stewardThreadPermissionMode`, `stewardTurnTaintedBy` |
| `13p-steward-runner-actions.js` | `13k-steward-threads.js` | backward | `stewardSeatedByUser` |
| `13p-steward-runner-actions.js` | `13l-steward-ops.js` | backward | `stewardReadRunSnapshot`, `stewardRunResumeTier` |
| `13p-steward-runner-actions.js` | `13m-steward-runner-base.js` | backward | `STEWARD_ACTION_HOOKS`, `STEWARD_ACTS_MAX`, `STEWARD_ACT_LABEL_MAX`, `STEWARD_CONTINUE_FRESH_MS`, `STEWARD_CONTINUE_NOPLAN_MAX`, `STEWARD_CONTINUE_PROMPT`, `STEWARD_INBOX_DELIVERABLE_CHARS`, `STEWARD_INBOX_EVENTS_PER_TURN`, `STEWARD_INBOX_EVENT_CHARS`, `STEWARD_INBOX_MESSAGE_CHARS`, `STEWARD_NO_PROGRESS_MAX`, `STEWARD_SELF_SERVE_ATTEMPT_MAX`, `STEWARD_SELF_SERVE_PER_TURN_MAX`, `STEWARD_SELF_SERVE_RETRY_WINDOW_MS`, `STEWARD_TURN_DAY_MS`, `STEWARD_TURN_WINDOW_MS`, `stewardFailureExplain`, `stewardRunnerRuntime` |
| `13p-steward-runner-actions.js` | `13o-steward-runner-prompt.js` | backward | `stewardActConfirmLines`, `stewardActLabel`, `stewardNormalizeAct` |
| `13q-steward-runner-turn.js` | `00-boot.js` | backward | `OVERLAY_ID`, `RUYI_EVENTS`, `crypto`, `fsp`, `logEvent`, `makeId`, `nowIso`, `path` |
| `13q-steward-runner-turn.js` | `01-config.js` | backward | `atomicWriteJson`, `readConfig`, `safeSessionId` |
| `13q-steward-runner-turn.js` | `01o-execution-state.js` | backward | `activeChildren`, `pendingPermissions`, `pendingQuestions`, `turnSettlers` |
| `13q-steward-runner-turn.js` | `02-session-store.js` | backward | `loadSession`, `mutateSession`, `readSessionNotes`, `writeSessionNotes` |
| `13q-steward-runner-turn.js` | `02e-session-engine-route.js` | backward | `normalizeSessionEngineRoute` |
| `13q-steward-runner-turn.js` | `04-permission-runtime.js` | backward | `normalizeQuestionAnswer`, `promptDeadlineIsReal`, `stopSession` |
| `13q-steward-runner-turn.js` | `06e-mission-domain.js` | backward | `waitMissionTurnSettled` |
| `13q-steward-runner-turn.js` | `06i-steward-core.js` | backward | `STEWARD_DIGEST_LIMITS`, `STEWARD_EVENT_KINDS`, `STEWARD_SESSION_ID`, `StewardHooks`, `stewardOpenAiFallback`, `stewardPendingOneLine`, `stewardSanitizeText`, `stewardThreadEngineRoute`, `waitReasonFor` |
| `13q-steward-runner-turn.js` | `06j-scheduler-core.js` | backward | `SchedulerHooks` |
| `13q-steward-runner-turn.js` | `10a-session-turn.js` | backward | `runSessionTurn` |
| `13q-steward-runner-turn.js` | `13b-api-domain-routes.js` | backward | `steerSessionCore` |
| `13q-steward-runner-turn.js` | `13d-core-domain-routes.js` | backward | `decideIntervention` |
| `13q-steward-runner-turn.js` | `13e-pretender-index.js` | backward | `getPretenderProjectionIndex` |
| `13q-steward-runner-turn.js` | `13g-steward.js` | backward | `stewardAuthorizeExternalContext` |
| `13q-steward-runner-turn.js` | `13i-steward-inbox.js` | backward | `stewardDir`, `stewardInboxRead`, `stewardPendingKeyOf`, `stewardPendingStillOpen`, `stewardPresenceRows`, `stewardViewingSessionIds` |
| `13q-steward-runner-turn.js` | `13j-steward-tool-base.js` | backward | `_stewardReadBudget`, `stewardFail`, `stewardReadSessionHead` |
| `13q-steward-runner-turn.js` | `13k-steward-threads.js` | backward | `stewardErrorDetail`, `stewardLaunchingTurns`, `stewardMediatesPermissions` |
| `13q-steward-runner-turn.js` | `13l-steward-ops.js` | backward | `stewardDecideAttempted` |
| `13q-steward-runner-turn.js` | `13m-steward-runner-base.js` | backward | `STEWARD_ACTION_HOOKS`, `STEWARD_ACTS_MAX`, `STEWARD_BLOCKING_DEBOUNCE_MS`, `STEWARD_DEBOUNCE_MS`, `STEWARD_DIGEST_KIND_TEXT`, `STEWARD_INBOX_EVENTS_PER_TURN`, `STEWARD_PENDING_LIST_MAX`, `STEWARD_PREEMPT_WAIT_MS`, `STEWARD_QUICK_DEBOUNCE_MS`, `STEWARD_TOOL_LABELS`, `STEWARD_USER_QUEUE_WAIT_MS`, `STEWARD_VIEW_HELD_MAX`, `STEWARD_VIEW_RECHECK_MS`, `STEWARD_VISITS_DIR`, `STEWARD_VISITS_KEEP`, `STEWARD_VISIT_DIGEST_MAX`, `STEWARD_VISIT_SCHEMA`, `ensureStewardSession`, `stewardAbortInflight`, `stewardRunnerRuntime` |
| `13q-steward-runner-turn.js` | `13n-steward-arbiter.js` | backward | `stewardArbiterWait` |
| `13q-steward-runner-turn.js` | `13o-steward-runner-prompt.js` | backward | `stewardParseReply`, `stewardThreadDigestRows` |
| `13q-steward-runner-turn.js` | `13p-steward-runner-actions.js` | backward | `stewardCircuitCheck`, `stewardDowngradeActions`, `stewardExecuteActions`, `stewardHumanizeSay`, `stewardInboxMessage`, `stewardLastAssistantContent`, `stewardLastAssistantFinalSegment`, `stewardNormalizeRouteHint`, `stewardSelfServeInbox`, `stewardStampReply`, `stewardTriggerStamp` |
| `13r-event-stream.js` | `00-boot.js` | backward | `EventStreamHooks`, `OVERLAY_ID`, `RUYI_EVENTS`, `URL`, `apiFailure`, `nowIso`, `send` |
| `13r-event-stream.js` | `01-config.js` | backward | `safeSessionId` |
| `13r-event-stream.js` | `01o-execution-state.js` | backward | `activeChildren` |
| `13r-event-stream.js` | `02-session-store.js` | backward | `readMissionSessionHead`, `sessionDisplayTitle`, `sessionMissionId` |
| `13r-event-stream.js` | `04-permission-runtime.js` | backward | `subscribeActiveChildEvents` |
| `13r-event-stream.js` | `06i-steward-core.js` | backward | `STEWARD_SESSION_ID`, `stewardThreadStateFromHead`, `stewardWatchedThread`, `threadOriginOf` |
| `13r-event-stream.js` | `13e-pretender-index.js` | backward | `missionPendingCounts` |
| `13s-scheduler.js` | `00-boot.js` | backward | `RUYI_EVENTS`, `logEvent`, `makeId`, `nowIso`, `paths`, `safeDecodeURIComponent` |
| `13s-scheduler.js` | `01-config.js` | backward | `atomicWriteJson`, `readConfig` |
| `13s-scheduler.js` | `01e-permission-modes.js` | backward | `PERMISSION_MODES` |
| `13s-scheduler.js` | `02-session-store.js` | backward | `createSession`, `loadSession`, `repairMissionChangeTornTail`, `saveSession`, `updateSessionMeta` |
| `13s-scheduler.js` | `04-permission-runtime.js` | backward | `stopSession` |
| `13s-scheduler.js` | `06i-steward-core.js` | backward | `STEWARD_SESSION_ID`, `StewardHooks`, `stewardPermissionRank` |
| `13s-scheduler.js` | `06j-scheduler-core.js` | backward | `SCHEDULER_LIMITS`, `SCHEDULER_OUTCOMES`, `SCHEDULER_PHASES`, `SchedulerHooks`, `describeSchedule`, `missedOccurrence`, `nextFireAt`, `normalizeSchedulerTask`, `occurrenceKey` |
| `13s-scheduler.js` | `07-autonomy.js` | backward | `schedulerAskWaitSessions` |
| `13s-scheduler.js` | `10a-session-turn.js` | backward | `runSessionTurn` |
| `13t-steward-schedule.js` | `00-boot.js` | backward | `makeId`, `nowIso` |
| `13t-steward-schedule.js` | `01-config.js` | backward | `readConfig`, `safeSessionId` |
| `13t-steward-schedule.js` | `06i-steward-core.js` | backward | `STEWARD_SESSION_ID`, `StewardHooks`, `stewardSanitizeText` |
| `13t-steward-schedule.js` | `06j-scheduler-core.js` | backward | `SCHEDULER_LIMITS`, `SchedulerHooks`, `describeSchedule`, `nextFireAt`, `normalizeSchedulerTask` |
| `13t-steward-schedule.js` | `13g-steward.js` | backward | `stewardToolHandler` |
| `13t-steward-schedule.js` | `13i-steward-inbox.js` | backward | `stewardAppendInboxRows`, `stewardClipSummary`, `stewardInboxRowDedupeKeys`, `stewardIsoAt`, `stewardLoadState`, `stewardRuntime` |
| `13t-steward-schedule.js` | `13j-steward-tool-base.js` | backward | `stewardAppendDecision`, `stewardFail`, `stewardRawKind`, `stewardReadSessionHead` |
| `13t-steward-schedule.js` | `13k-steward-threads.js` | backward | `stewardCanonWorkspacePath`, `stewardDeriveThreadCwd`, `stewardUnattendedByModel`, `stewardValidateCwd` |
| `13t-steward-schedule.js` | `13q-steward-runner-turn.js` | backward | `stewardEnsureOpenAiRoute` |
| `13t-steward-schedule.js` | `13s-scheduler.js` | backward | `SchedulerRuntime` |
| `13u-migration-center.js` | `00-boot.js` | backward | `MigrationHooks`, `SKILL_ID_RE`, `VERSION`, `_parseTomlMcpServers`, `_tomlKeyPath`, `agentCliHomes`, `crypto`, `externalRoot`, `findRuyiPackageRootFor`, `fs`, `fsp`, `logEvent`, `nowIso`, `os`, `parseMcpConfigFile`, `path`, `paths`, `ruyiPackageInfo`, `safeJsonParse`, `safeUrlForDisplay`, `samePathKey`, `sanitizeExternalMcpServer`, `text`, `tildePath` |
| `13u-migration-center.js` | `01-config.js` | backward | `agentMcpImportSources`, `atomicWriteJson`, `classifyAgentMcpCandidate`, `generateMcpConfig`, `kimiMcpManagedIds`, `mutateConfig`, `readConfig`, `readInstallRegistry`, `writeInstallRegistry` |
| `13u-migration-center.js` | `01h-process-runtime.js` | backward | `DesktopShell` |
| `13u-migration-center.js` | `04l-skill-registry.js` | backward | `SkillRegistry` |
| `13u-migration-center.js` | `06d-memory-domain.js` | backward | `syncAgentInstructionImports` |
| `13v-external-channel-protocols.js` | `00-boot.js` | backward | `crypto`, `json`, `text` |
| `13w-external-bots.js` | `00-boot.js` | backward | `ExternalBotHooks`, `OVERLAY_ID`, `URL`, `apiFailure`, `crypto`, `fsp`, `json`, `makeId`, `nowIso`, `path`, `paths`, `runKeyedChain`, `send`, `text` |
| `13w-external-bots.js` | `01-config.js` | backward | `DurableJsonStore`, `originOk`, `tokenOk` |
| `13w-external-bots.js` | `01j-local-crypto.js` | backward | `LocalSecretCrypto` |
| `13w-external-bots.js` | `13q-steward-runner-turn.js` | backward | `runStewardTurn` |
| `13w-external-bots.js` | `13v-external-channel-protocols.js` | backward | `ExternalChannelProtocols` |
| `13w-external-bots.js` | `13x-external-channel-delivery.js` | backward | `ExternalChannelDelivery` |
| `13w-external-bots.js` | `13y-external-bot-credentials.js` | backward | `ExternalBotCredentials` |
| `13w-external-bots.js` | `13z-external-bot-discovery.js` | backward | `ExternalBotDiscovery` |
| `13x-external-channel-delivery.js` | `00-boot.js` | backward | `path`, `text` |
| `13y-external-bot-credentials.js` | `00-boot.js` | backward | `fsp`, `paths` |
| `13y-external-bot-credentials.js` | `01-config.js` | backward | `DurableJsonStore` |
| `13y-external-bot-credentials.js` | `01j-local-crypto.js` | backward | `LocalSecretCrypto` |
| `14-main.js` | `00-boot.js` | backward | `ACC_POLICY_TOOL_FAMILIES`, `AUTOEXEC_DENYLIST`, `BRIDGED_WRITE_PATH_ARGS`, `CONFIG_SCHEMA`, `CONTEXT_WINDOW_FALLBACK`, `EventStreamHooks`, `NATIVE_TOOL_TIER`, `RUYI_EVENTS`, `TOOL_REQUIRES`, `accPolicyHiddenToolNames`, `adaptiveMetaToolSchemas`, `appendPromptToLastUserMessage`, `classifyTextForEstimate`, `collectBridgedWriteTarget`, `collectBridgedWriteTargets`, `contextWindowFromTable`, `createNdjsonLineFeeder`, `estimateHistoryTokens`, `estimateTextTokens`, `extractContextLength`, `fmtTokensServer`, `hashArgs`, `historyStartsWithCompactionSummary`, `isContextOverflowError`, `maskSecrets`, `maskedSecretConflicts`, `nativeToolDisabledByPolicy`, `neutralizeFenceTag`, `normalizeStoragePolicy`, `parseMcpConfigFile`, `pathWithinAnyRoot`, `pathWithinRoot`, `providerLaunchVectorKey`, `redact`, `resolveContextWindow`, `safeUrlForDisplay`, `sanitizeExternalMcpServer`, `scanMcpSources`, `setEstimateBucketsV1`, `spawnDetachedChecked`, `ssrfCheck`, `toolDisabledByPolicy`, `toolRequirementsMet`, `unmaskProviders`, `unmaskSecrets` |
| `14-main.js` | `01-config.js` | backward | `CONFIG_MIGRATIONS`, `DurableJsonStore`, `autoImportClaudeCodeMcp`, `buildClaudeAgentDefinitions`, `buildClaudeCliEnv`, `decodeClaudeCliText`, `defaultConfig`, `desktopMcpFromInstalledRoot`, `desktopPythonCandidates`, `detectDesktopMcp`, `detectDesktopMcpAsync`, `ensureDesktopMcpWarm`, `generateMcpConfig`, `generateSessionMcpConfig`, `getAgentRoleLibrary`, `invalidateMcpDropInCache`, `legacyAccMemoryMigrationComplete`, `mutateConfig`, `normalizeConfig`, `pickPython`, `pickPythonAsync`, `prepareAgentCliSpawn`, `probeAgentCliLauncher`, `readClaudeProjectAgentRoles`, `readConfig`, `readFileTail`, `resolveExternalMcpServers`, `saveProjectAgentRoles`, `sweepStaleScriptFiles`, `syncAgentCliMcpManifests`, `syncMcpServersToKimi` |
| `14-main.js` | `01b-route-auth.js` | backward | `ROUTE_AUTH` |
| `14-main.js` | `01c-runtime-flags.js` | backward | `appendOnlyToolSchemasEnabled`, `budgetGuardDecision`, `budgetGuardEnabled`, `budgetGuardTurnTokens`, `budgetGuardWarnRatio`, `estimateBucketsEnabled`, `evaporateBudgetBoundaryEnabled`, `execResultCacheEnabled`, `execResultCacheMaxEntries`, `historyReadDedupEnabled`, `reseedReattachFilesEnabled`, `reseedTailUnitsEnabled`, `sessionNotesEnabled`, `sessionNotesInjectEnabled`, `sessionNotesMergeEnabled`, `summaryEntityCheckEnabled`, `summaryFactTableCap`, `summaryFactTableEnabled`, `summaryPromptI18nEnabled`, `summaryRefineEnabled`, `summarySingleShotEnabled`, `toolByteBudgetShadowBytes`, `toolTimeBudgetEnabled`, `toolTimeBudgetHardMs`, `toolTimeBudgetShadowEnabled`, `toolTimeBudgetWarnMs`, `volatileTailLayoutEnabled` |
| `14-main.js` | `01e-permission-modes.js` | backward | `BUILTIN_AGENT_ROLES`, `PERMISSION_MODES`, `PERMISSION_MODES_REQUIRING_CONFIRM`, `normalizeAgentRole`, `resolvePermissionMode` |
| `14-main.js` | `01f-agent-cli-types.js` | backward | `AGENT_CLI_TYPES`, `normalizeAgentCliType` |
| `14-main.js` | `01h-privacy-core.js` | backward | `PrivacyCore` |
| `14-main.js` | `01h-process-runtime.js` | backward | `killChildTree`, `peekRgProbe`, `probeRgAsync` |
| `14-main.js` | `01o-execution-state.js` | backward | `activeChildren` |
| `14-main.js` | `02-session-store.js` | backward | `AgentRunStore`, `MISSION_CONTAINER_MAX_FILES`, `appendAgentRunEvent`, `appendUsageLedger`, `buildSessionNotesInjectPrompt`, `buildTurnSummary`, `bumpMissionChangeSeq`, `captureWorkspaceTurnBaseline`, `compactInterventionJournal`, `createMissionContainer`, `createSession`, `detectDanglingTurn`, `extractSessionNotes`, `flushAgentRunEvents`, `flushSessionIndex`, `flushSessionIndexSync`, `flushUsageLedgerSync`, `forEachUsageRow`, `invalidateSessionIndex`, `isUntitledSessionTitle`, `journalGc`, `journalGcProbe`, `journalRecord`, `kindForPath`, `listAgentRunDigests`, `listMissionContainers`, `listSessions`, `loadSession`, `maybeWriteSessionNotes`, `mergeSessionNotes`, `missionAttachThread`, `missionMergeInto`, `missionSplitThreads`, `mutateSession`, `normalizeSession`, `parseSessionNotesMarkdown`, `patchMissionContainer`, `readAgentRunEvents`, `readInterventions`, `readMissionContainer`, `readSessionHeadResilient`, `readSessionNotes`, `readUsageRows`, `reconcileWorkspaceTurnBaseline`, `registerIntervention`, `rehydrateObservation`, `renderSessionNotesMarkdown`, `repairMissionChangeTornTail`, `repairProviderHistoryPairing`, `repairProviderHistoryToolArgs`, `rewindSession`, `saveAgentRun`, `saveSession`, `sessionBodyPaths`, `sessionBodyPerfStats`, `sessionDisplayTitle`, `sessionMessagesDelta`, `sessionMeta`, `sessionNotesPath`, `sessionObjectIsStale`, `setSessionIndexRebuildScanHookForTest`, `syncRunEventSeq`, `transitionInterventionState`, `updateSessionMeta`, `usageLedgerCacheStats`, `writeHistorySnapshot`, `writeSessionNotes` |
| `14-main.js` | `02d-session-overrides.js` | backward | `liveSessionPermissionMode` |
| `14-main.js` | `02e-session-engine-route.js` | backward | `configForSessionEngineRoute`, `normalizeSessionEngineRoute`, `sessionEngineRouteFromConfig` |
| `14-main.js` | `02f-turn-effect-kinds.js` | backward | `toolInvokeEnvelopeRepair`, `unwrapToolInvokeCall` |
| `14-main.js` | `03-bridge-guard.js` | backward | `auditBridgedWriteCoverage`, `bridgedOfficeScriptGate`, `bridgedReadPathGate`, `buildBrowserOpenSpawn`, `buildCodeEditorSpawn`, `buildOpenSpawn`, `buildRevealSpawn`, `cwdWarning`, `guardFileToolPath`, `guardWorkspacePath`, `providerIsLocal`, `resolveWorkspace` |
| `14-main.js` | `04-permission-runtime.js` | backward | `AgentLoopHooks`, `MCP_COMPAT_MATRIX`, `McpHttpClient`, `McpStdioClient`, `bridgedServerUnavailableMessage`, `buildMcpConnectorInventory`, `classifyMcpError`, `clearPendingPermissions`, `collectBridgedTools`, `configureMcpFromTool`, `hasPendingPermissionForSession`, `killAllMcpClients`, `makeAttachmentRecord`, `mcpChildExitResult`, `nativeClaudeAgentResultInfo`, `normalizeMcpToolResult`, `parseAgentCliEvent`, `parseClaudeTaskNotification`, `permissionWaitMs`, `probeMcpConnector`, `resolveBridge`, `safeMcpInventory` |
| `14-main.js` | `04g-session-deletion.js` | backward | `deleteSession` |
| `14-main.js` | `04h-provider-http.js` | backward | `abortableDelay`, `providerApiBase`, `providerBaseWithV1`, `providerCallIsTransient`, `providerCompletionUrl`, `providerRequestHeaders`, `providerResponsesBase`, `withTransientRetry` |
| `14-main.js` | `04i-provider-wire.js` | backward | `PROVIDER_WIRE_PROTOCOLS`, `applyProviderReasoningEffort`, `buildResponsesInputItems`, `normalizeProviderApiStyle`, `providerRawCompletion`, `providerReasoningEffort`, `providerWireProtocol`, `responsesHistoryWithCompleteToolPairs` |
| `14-main.js` | `04m-voice-service.js` | backward | `asrFixMessages`, `asrFixSanity`, `providerFixCompletion`, `resolveAsrFixProvider` |
| `14-main.js` | `05-claude-engine.js` | backward | `AGENT_CLI_ADAPTERS`, `agentCliAdapter` |
| `14-main.js` | `05b-kimi-bridge.js` | backward | `consumeKimiAcpApproval`, `isKimiAcpPlanFilePath`, `kimiAcpFreshActualForOperation`, `kimiAcpInferConcreteToolInput`, `kimiAcpModeOptionFromActivated`, `kimiAcpNativeBashWrapperCandidate`, `kimiAcpNativeBashWrapperTexts`, `kimiAcpNativeShellQuote`, `kimiAcpPermissionToolCall`, `kimiAcpSessionRestoreMethods`, `kimiAcpSuccessfulEnterPlanMode`, `kimiAcpUnknownSessionError`, `kimiSessionStatus`, `parseKimiWireAgentEvents`, `parseKimiWireCompaction`, `prepareKimiAcpSpawn`, `resolveKimiAcpPlanFilePath`, `runKimiCompact`, `watchKimiWire` |
| `14-main.js` | `06-provider-engine.js` | backward | `ERROR_CLASSES`, `TOOL_ITERATION_BUDGETS`, `buildBrowserAutomationHint`, `buildEngineEnvBrief`, `buildPlaybookIndexSection`, `buildProviderSystemPrompt`, `buildRuntimeIdentityFacts`, `buildStableSystemPrompt`, `buildToolCustomizationHint`, `buildVolatileParts`, `evalPlaybookAvailability`, `matchServiceEntry`, `maybeWriteThreadBrief`, `normalizePlaybook`, `parseThreadBrief`, `resolveEngineEnvBrief`, `resolveToolIterationBudget`, `shouldExtendToolIterationBudget` |
| `14-main.js` | `06b-prompt-registry.js` | backward | `PROMPT_PACK_VERSION`, `appendResponseLanguagePolicy`, `appendTurnPolicies`, `buildAgentTeamHint`, `buildClaudeNativeAgentPolicy`, `buildPromptTaskContext`, `buildSoftwareEngineeringPolicy`, `clampAppendWithSkills`, `fenceSafeSlice`, `getPromptPack`, `shrinkFencedSection`, `softwareEngineeringTaskProfile` |
| `14-main.js` | `06c-agent-workflow-catalog.js` | backward | `BUILTIN_AGENT_WORKFLOWS`, `deleteAgentWorkflow`, `getAgentWorkflows`, `normalizeAgentWorkflow`, `normalizeWorkflowCondition`, `normalizeWorkflowLoop`, `saveAgentWorkflow` |
| `14-main.js` | `06d-memory-domain.js` | backward | `analyzeMemoryMaintenance`, `applyMemoryRelationProposal`, `buildCoreMemoryPromptSection`, `buildMemoryCheckPrompt`, `buildMemoryConflictMap`, `buildMemoryPromptSection`, `confirmMemoryRelation`, `deleteMemoryRelation`, `extractMemoryRelationProposals`, `listMemoryRelations`, `listWorkbenchMemories`, `loadMemoryRegistry`, `memoryProposalIsDuplicate`, `memoryProposalPrefilter`, `memoryProposalSimilarity`, `migrateLegacyAccMemory`, `parseMemoryProposalDecision`, `proposeMemoryFromSession`, `proposeMemoryRelation`, `proposeMemoryRelationRevoke`, `proposeMemoryRelationTool`, `proposeMemoryRevision`, `proposeWorkbenchMemory`, `rankRelevantMemories`, `readWorkbenchMemory`, `resolveCoreMemoryState`, `resolveMemoryPreflight`, `saveMemory` |
| `14-main.js` | `06e-mission-domain.js` | backward | `runMissionDriver` |
| `14-main.js` | `06g-resource-leases.js` | backward | `acquireResourceLease`, `agentResourcesConflict`, `bridgedDesktopLeaseMode`, `inferToolResources`, `normalizeAgentResource`, `normalizeAgentResources`, `releaseResourceLease`, `remapAgentResources`, `resourceBlockers` |
| `14-main.js` | `06i-steward-core.js` | backward | `STEWARD_BRIEF_LIMITS`, `STEWARD_CONFIG_TIERS`, `STEWARD_DELIVERABLE_CHARS`, `STEWARD_DIGEST_LIMITS`, `STEWARD_EVENT_KINDS`, `STEWARD_EXEMPT_CATEGORY_LABELS`, `STEWARD_EXEMPT_DELEGATIONS_PER_HOUR`, `STEWARD_EXEMPT_DELEGATION_GATES`, `STEWARD_EXEMPT_DELEGATION_TEXT_MAX`, `STEWARD_EXEMPT_EXCERPT_CHARS`, `STEWARD_EXEMPT_NAME_CARVEOUTS`, `STEWARD_EXEMPT_TOOL_PATTERNS`, `STEWARD_MEMORY_KINDS`, `STEWARD_PERMISSION_RANK`, `STEWARD_PREROUTE_DEFAULTS`, `STEWARD_QUICK_ANSWER_CHARS`, `STEWARD_SESSION_ID`, `STEWARD_SESSION_TITLE`, `STEWARD_WAIT_LABELS`, `STEWARD_WAIT_REASONS`, `StewardHooks`, `aggregateMissionState`, `buildStewardBrief`, `buildStewardDigestLine`, `deriveStewardThreadState`, `isStewardToolName`, `prerouteText`, `stewardActConfirmSpec`, `stewardAsksYou`, `stewardAssemblePlaybookPrompt`, `stewardClipSay`, `stewardConfigTierFor`, `stewardExemptDelegationVerdict`, `stewardExemptExcerpt`, `stewardExemptHits`, `stewardExemptReason`, `stewardExemptRiskNote`, `stewardExemptScanInput`, `stewardHumanizeIds`, `stewardMayAct`, `stewardMayTightenTo`, `stewardOpenAiFallback`, `stewardPermissionRank`, `stewardPlaybookMissingInputs`, `stewardStoppedTarget`, `stewardTaintToolCall`, `stewardTaintToolName`, `stewardTermJaccard`, `stewardThreadEngineRoute`, `stewardThreadStateFromCard`, `stewardThreadStateFromHead`, `stewardThreadStateRank`, `stewardToolPermanentlyExempt`, `stewardTrimSayAtSentence`, `stewardTurnTaint`, `threadVisible`, `waitReasonFor` |
| `14-main.js` | `06j-scheduler-core.js` | backward | `SCHEDULER_DEFAULT_POLICY`, `SCHEDULER_DESCRIBE_KEYS`, `SCHEDULER_DOW_KEYS`, `SCHEDULER_FIRE_MODES`, `SCHEDULER_FORBIDDEN_PAYLOAD_KEYS`, `SCHEDULER_LIMITS`, `SCHEDULER_OUTCOMES`, `SCHEDULER_THREAD_TIERS`, `describeSchedule`, `missedOccurrence`, `nextFireAt`, `normalizeSchedulerTask`, `occurrenceKey`, `parseCronExpr` |
| `14-main.js` | `06v-operational-services.js` | backward | `buildMetricsPayload`, `claudeProjectDirKey`, `claudeProjectsRoot`, `collectStorageStats`, `desktopAuditEntriesFromResult`, `maybeRecordStorageTrend`, `normalizeMetricsPath`, `readStorageTrend`, `recordEngineTranscript`, `recordRequestMetric`, `storageSweep` |
| `14-main.js` | `06w-capability-service.js` | backward | `CAP_UNKNOWN_TTL_MS`, `getCapabilities`, `invalidateCapabilityCache`, `networkAnchors`, `peekCapabilities`, `probeAny` |
| `14-main.js` | `07-autonomy.js` | backward | `NATIVE_TOOL_PACKS`, `bridgedToolTier`, `buildOpenAiTools`, `buildToolCatalog`, `classifyClaudeSubagentFailure`, `classifyRuntimeToolFailure`, `classifyToolPacks`, `compareToolRetrievalShadow`, `createToolLoadingState`, `dropPolicyDisabledBridgedTools`, `fetchOpenAiModels`, `nativeToolGate`, `nativeToolSchema`, `openAiStreamOnce`, `requestNativePermission`, `schedulerAskWaitSessions`, `searchToolCatalog`, `toolArgsSkeleton`, `toolPackForName` |
| `14-main.js` | `08-agent-runs.js` | backward | `QUALITY_GATE_OUTPUT_SCHEMA`, `aggregateAgentVote`, `aggregateCoverage`, `applyAgentWorktree`, `buildAgentRunEnvelope`, `buildNodeEvidenceCatalog`, `createAgentWorktree`, `cutAtSentence`, `dedupeAgentFindings`, `evaluateNodeToolEvidence`, `evaluateWorkflowCondition`, `finalizeAgentWorktree`, `formatNodeEvidencePrompt`, `indexNodeEvidence`, `normalizeAgentGate`, `parseStructuredAgentOutput`, `propagateAssignments`, `purgeNodeEvidence`, `repairJson`, `resolveAgentTeamRoute`, `runSubAgentCore`, `runWorkspaceHash`, `singleAgentShorthandNode`, `validateAgentJsonSchema`, `verifyNodeClaims`, `workflowProgressFingerprint` |
| `14-main.js` | `09-workflow.js` | backward | `legacySpawnToOrchestrateArgs`, `planDiscoveryToolBatchAllowed`, `waitForAgentRunResults` |
| `14-main.js` | `09b-agent-recovery.js` | backward | `autoResumeInterruptedRuns`, `markInterruptedAgentRuns` |
| `14-main.js` | `10-context-governance.js` | backward | `COMPACT_MARKER_MIN_SAVED_TOKENS`, `COMPACT_RESEED_TAIL_MAX_TOKENS`, `CompactionPlan`, `agentConversationContextMeta`, `agentNodeContextWindow`, `buildObservationRecallPrompt`, `buildSummaryFactTableMessages`, `buildSummaryRefineMessages`, `calibratedEstimate`, `checkSummaryEntities`, `chunkHistoryByBudget`, `configuredConversationWindow`, `contextWindowOverrideKey`, `dedupeRepeatedReads`, `estimateFactor`, `evaporateBudgetBoundary`, `evaporateHistory`, `extractSummaryEntities`, `fileReadDedupKey`, `fitHistoryForSummary`, `historyUnitStarts`, `learnedWindowCap`, `mapSummaryWithLimit`, `measureObservationReductionShadow`, `noteEstimateSample`, `noteWindowOvershoot`, `openCompactMarker`, `providerContextWindow`, `providerConversationContextWindow`, `providerSummaryCall`, `recentFileReads`, `recentTurnsBoundary`, `reduceObservationContent`, `resolveCompactionProvider`, `resolveSummaryCallPolicy`, `summaryMaxConcurrent`, `summaryPromptWithGuidance`, `summarySingleShotCap`, `summarySingleShotReserveTokens`, `upsertCompactMarker`, `validateStructuredSummary` |
| `14-main.js` | `10a-session-turn.js` | backward | `runSessionTurn` |
| `14-main.js` | `11-native-tools.js` | backward | `adaptiveCatalogForMcp`, `crc32`, `readWebCache`, `webCachePath`, `webFetch`, `webSearch`, `writeWebCache`, `zipReadCentralDir`, `zipReadEntryData`, `zipWrite` |
| `14-main.js` | `12-tool-dispatch.js` | backward | `TOOL_HANDLERS`, `attachScreenshotImage`, `guardDownloadDest`, `suggestToolNames`, `toolArgsMissingRequired`, `toolCall`, `toolFailureResult`, `validateNativeToolArgs`, `withToolArgsGuide` |
| `14-main.js` | `13-http-router.js` | backward | `buildUsageSummary`, `doctor`, `installIntegration`, `parseArgs`, `startMcp`, `startServer` |
| `14-main.js` | `13d-core-domain-routes.js` | backward | `buildMissionAggregateRows`, `missionAggregateStats` |
| `14-main.js` | `13e-pretender-index.js` | backward | `getPretenderProjectionIndex`, `pretenderIndexTestHooks`, `warmPretenderProjectionIndex` |
| `14-main.js` | `13i-steward-inbox.js` | backward | `STEWARD_SOURCE_EVENT_MAP`, `startStewardInbox`, `stewardEventDedupeKey`, `stewardInboxRowDedupeKeys`, `stewardMergeInboxEvents`, `stewardNormalizeBudgetExhausted`, `stewardNormalizeMissionChange`, `stewardNormalizePendingIntervention`, `stewardNormalizeRunEvent`, `stopStewardInbox` |
| `14-main.js` | `13j-steward-tool-base.js` | backward | `stewardTurnTaintedBy` |
| `14-main.js` | `13k-steward-threads.js` | backward | `stewardMediatedPermissionWaitMs` |
| `14-main.js` | `13m-steward-runner-base.js` | backward | `STEWARD_INBOX_MESSAGE_CHARS`, `STEWARD_SAY_CEILING`, `STEWARD_SAY_TARGET`, `ensureStewardSession`, `stewardFailureExplain`, `stewardResolveRoute` |
| `14-main.js` | `13o-steward-runner-prompt.js` | backward | `buildStewardSystemPrompt`, `stewardActLabel`, `stewardContextBudget`, `stewardNormalizeAct`, `stewardParseReply`, `stewardPreroute` |
| `14-main.js` | `13p-steward-runner-actions.js` | backward | `stewardCircuitCheck`, `stewardDowngradeActions`, `stewardInboxMessage`, `stewardSelfServeAllows` |
| `14-main.js` | `13q-steward-runner-turn.js` | backward | `runStewardTurn`, `stewardMergeDelegationReceipts`, `stewardResetConversation`, `stewardVisit`, `stewardVisitDigest` |
| `14-main.js` | `13s-scheduler.js` | backward | `handleSchedulerApiRoutes`, `schedulerPermissionModeFor`, `schedulerRuntimeSnapshot`, `startScheduler`, `stopScheduler` |

## 强连通分量

无。

## 维护规则

- 源码新增或删除跨模块引用时，契约与本图必须同步更新；`--check`/CI 会拒绝漂移。
- 禁止重复顶层导出名和生产依赖环。新增前向边必须显式更新 `module-dependency-policy.json` 并说明理由。
- 隔离批次优先把内部符号收进命名空间，只暴露真实公共面；每批保持拼接顺序和运行语义。
