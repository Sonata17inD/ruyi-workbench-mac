# 路由清册(第 103 波 103a · 机器生成)

> 由 `dev-harness/route-inventory.js` 生成,`route-inventory.static.e2e.js` 重算比对;手改无效。
> 判定点 171(精确 148 / 前缀 11 / 正则 12),ROUTE_AUTH 157 条,生成于 2026-11-18T10:13:19.809Z。

鉴权级别:`open` 低敏读 · `origin` 同源 · `token` 始终 token · `token-browser` 浏览器须 token/loopback 须同源 · `body-token` handler 自查 body token · `host-gate` 顶层 host 门(非 /api)。`self` = handler 内另有 tokenOk 纵深自查。

## 13ab-privacy-api.js(9)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| GET | `/api/privacy/status` | exact | token | 13ab-privacy-api.js · `PrivacySettings` | config-read-safety.e2e.js, privacy-gateway.e2e.js, privacy-missing-config-vault.test.js |
| GET | `/api/privacy/settings` | exact | token | 13ab-privacy-api.js · `PrivacySettings` | privacy-gateway.e2e.js, privacy-config-health.test.js, privacy-missing-config-vault.test.js |
| POST | `/api/privacy/settings` | exact | token | 13ab-privacy-api.js · `PrivacySettings` | privacy-gateway.e2e.js, privacy-config-health.test.js, privacy-missing-config-vault.test.js |
| POST | `/api/privacy/encryption` | exact | token | 13ab-privacy-api.js · `PrivacySettings` | offline-upgrade-drill.e2e.js, onboard.e2e.js, privacy-gateway.e2e.js 等 4 件 |
| POST | `/api/privacy/rules/test` | exact | token | 13ab-privacy-api.js · `PrivacySettings` | privacy-gateway.e2e.js |
| POST | `/api/privacy/use-native` | exact | token | 13ab-privacy-api.js · `PrivacySettings` | privacy-gateway.e2e.js |
| POST | `/api/privacy/backup/export` | exact | token | 13ab-privacy-api.js · `PrivacySettings` | privacy-gateway.e2e.js, privacy-missing-config-vault.test.js |
| POST | `/api/privacy/backup/preview` | exact | token | 13ab-privacy-api.js · `PrivacySettings` | privacy-gateway.e2e.js, privacy-missing-config-vault.test.js |
| POST | `/api/privacy/backup/import` | exact | token | 13ab-privacy-api.js · `PrivacySettings` | privacy-gateway.e2e.js, privacy-missing-config-vault.test.js |

## agent-run(5)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| GET | `/api/agent-runs` | exact | token self | ../backend/agent-run-routes.cjs · `handleAgentRunApiRoutes` | agent-coordination.e2e.js, agent-deadlock-watchdog.e2e.js, agent-mode-v2.e2e.js 等 45 件 |
| GET | `/api/agent-runs/…/events` | prefix | token self | ../backend/agent-run-routes.cjs · `handleAgentRunApiRoutes` | agent-coordination.e2e.js, agent-deadlock-watchdog.e2e.js, agent-mode-v2.e2e.js 等 26 件 |
| POST | `/api/agent-runs/` | prefix | token | ../backend/agent-run-routes.cjs · `handleAgentRunApiRoutes` | agent-coordination.e2e.js, agent-deadlock-watchdog.e2e.js, agent-mode-v2.e2e.js 等 26 件 |
| DELETE | `/api/agent-runs/` | prefix | token | ../backend/agent-run-routes.cjs · `handleAgentRunApiRoutes` | agent-coordination.e2e.js, agent-deadlock-watchdog.e2e.js, agent-mode-v2.e2e.js 等 26 件 |
| GET | `/api/agent-runs/` | prefix | token self | ../backend/agent-run-routes.cjs · `handleAgentRunApiRoutes` | agent-coordination.e2e.js, agent-deadlock-watchdog.e2e.js, agent-mode-v2.e2e.js 等 26 件 |

## agent-workflow(3)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| POST | `/api/agent-workflow/launch` | exact | body-token | ../backend/agent-workflow-routes.cjs · `handleAgentWorkflowApiRoutes` | agent-deadlock-watchdog.e2e.js, agent-node-limits.e2e.js, agent-node-wrapup.e2e.js 等 40 件 |
| POST | `/api/agent-workflow/wait` | exact | body-token | ../backend/agent-workflow-routes.cjs · `handleAgentWorkflowApiRoutes` | agent-node-limits.e2e.js |
| POST | `/api/agent-workflow/result` | exact | body-token | ../backend/agent-workflow-routes.cjs · `handleAgentWorkflowApiRoutes` | — |

## attachment(2)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| POST | `/api/upload` | exact | token-browser | ../backend/attachment-routes.cjs · `handleAttachmentApiRoutes` | chat-ux-wave1.browser.e2e.js, external-bots.browser.e2e.js, file-text-encoding.e2e.js 等 9 件 |
| GET | `/api/upload/content` | exact | token self | ../backend/attachment-routes.cjs · `handleAttachmentApiRoutes` | tool-result-render.browser.e2e.js, tool-result-shrink.test.js, vision-loop.e2e.js |

## audio(9)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| POST | `/api/audio/transcribe` | exact | token | ../backend/audio-routes.cjs · `handleAudioApiRoutes` | asr-transcribe.e2e.js, asr-warmup.e2e.js, composer-voice-stream.browser.e2e.js 等 8 件 |
| POST | `/api/audio/stream/sessions` | exact | token | ../backend/audio-routes.cjs · `handleAudioApiRoutes` | composer-voice-stream.browser.e2e.js, composer-voice-warmup.browser.e2e.js, macos-desktop-media.e2e.js 等 6 件 |
| POST | `/api/audio/stream/sessions/` | prefix | token | ../backend/audio-routes.cjs · `handleAudioApiRoutes` | macos-desktop-media.e2e.js, toolbox-discovery.e2e.js, voice-lexicon.e2e.js |
| DELETE | `/api/audio/stream/sessions/` | prefix | token | ../backend/audio-routes.cjs · `handleAudioApiRoutes` | macos-desktop-media.e2e.js, toolbox-discovery.e2e.js, voice-lexicon.e2e.js |
| POST | `/api/audio/correct` | exact | token | ../backend/audio-routes.cjs · `handleAudioApiRoutes` | asr-config-ui.static.e2e.js, composer-voice-stream.browser.e2e.js, voice-lexicon.e2e.js |
| POST | `/api/audio/warmup` | exact | token | ../backend/audio-routes.cjs · `handleAudioApiRoutes` | asr-warmup.e2e.js, composer-voice-warmup.browser.e2e.js |
| GET | `/api/audio/lexicon` | exact | token | ../backend/audio-routes.cjs · `handleAudioApiRoutes` | data-root-migration.e2e.js, voice-learn-front.test.js, voice-learn.browser.e2e.js 等 5 件 |
| POST | `/api/audio/lexicon` | exact | token | ../backend/audio-routes.cjs · `handleAudioApiRoutes` | data-root-migration.e2e.js, voice-learn-front.test.js, voice-learn.browser.e2e.js 等 5 件 |
| POST | `/api/audio/lexicon/observe` | exact | token | ../backend/audio-routes.cjs · `handleAudioApiRoutes` | voice-learn-front.test.js, voice-learn.browser.e2e.js, voice-learn.e2e.js |

## autonomy-grant(3)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| * | `/api/autonomy/grants` | exact | token self | ../backend/autonomy-grant-routes.cjs · `handleAutonomyGrantApiRoutes` | autonomy-grant.e2e.js |
| POST | `/api/autonomy/grant` | exact | token self | ../backend/autonomy-grant-routes.cjs · `handleAutonomyGrantApiRoutes` | autonomy-grant.e2e.js |
| POST | `/api/autonomy/revoke` | exact | token self | ../backend/autonomy-grant-routes.cjs · `handleAutonomyGrantApiRoutes` | autonomy-grant.e2e.js |

## checkpoint-storage(7)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| GET | `/api/checkpoints` | exact | token self | ../backend/checkpoint-routes.cjs · `handleCheckpointQueryApiRoutes` | action-feedback.static.e2e.js, artifacts.e2e.js, changes-diff.e2e.js 等 18 件 |
| POST | `/api/checkpoints/open-external` | exact | token | ../backend/checkpoint-routes.cjs · `handleCheckpointQueryApiRoutes` | external-code-diff.e2e.js |
| GET | `/api/checkpoints/diff` | exact | token self | ../backend/checkpoint-routes.cjs · `handleCheckpointQueryApiRoutes` | changes-diff.e2e.js, frontend-domains.static.e2e.js, i18n.e2e.js |
| POST | `/api/storage/policy` | exact | token | ../backend/checkpoint-routes.cjs · `handleCheckpointApiRoutes` | config-mutate-mcp-parity.e2e.js, frontend-domains.static.e2e.js, session-storage-v2.e2e.js 等 4 件 |
| POST | `/api/storage/clean` | exact | token | ../backend/checkpoint-routes.cjs · `handleCheckpointApiRoutes` | frontend-domains.static.e2e.js, session-storage-v2.e2e.js, storage-steward.e2e.js |
| POST | `/api/checkpoints/rollback` | exact | token | ../backend/checkpoint-routes.cjs · `handleCheckpointApiRoutes` | action-feedback.static.e2e.js, artifacts.e2e.js, checkpoint-coverage.e2e.js 等 11 件 |
| POST | `/api/session/rewind` | exact | token | ../backend/checkpoint-routes.cjs · `handleCheckpointApiRoutes` | action-feedback.static.e2e.js, agent-wake.e2e.js, checkpoint-visibility.e2e.js 等 15 件 |

## configuration(6)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| POST | `/api/config` | exact | token | ../backend/configuration-routes.cjs · `handleConfigurationApiRoutes` | agent-coordination.e2e.js, agent-team-mode.e2e.js, agent-wake.e2e.js 等 68 件 |
| GET | `/api/agent-roles` | exact | token-browser | ../backend/configuration-routes.cjs · `handleConfigurationApiRoutes` | auth-deny-default.e2e.js, config-mutate-mcp-parity.e2e.js, frontend-domains.static.e2e.js 等 7 件 |
| POST | `/api/agent-roles` | exact | token | ../backend/configuration-routes.cjs · `handleConfigurationApiRoutes` | auth-deny-default.e2e.js, config-mutate-mcp-parity.e2e.js, frontend-domains.static.e2e.js 等 7 件 |
| GET | `/api/agent-workflows` | exact | token-browser | ../backend/configuration-routes.cjs · `handleConfigurationApiRoutes` | agent-workflow-audit-fixes.e2e.js, auth-deny-default.e2e.js, meta-guard.e2e.js 等 6 件 |
| POST | `/api/agent-workflows` | exact | token | ../backend/configuration-routes.cjs · `handleConfigurationApiRoutes` | agent-workflow-audit-fixes.e2e.js, auth-deny-default.e2e.js, meta-guard.e2e.js 等 6 件 |
| DELETE/POST | `/api/agent-workflows/` | prefix | token | ../backend/configuration-routes.cjs · `handleConfigurationApiRoutes` | auth-deny-default.e2e.js, store-walkthrough-w1.e2e.js |

## core-inline(3)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| * | `/health` | exact | host-gate | ../backend/workbench-http-server.cjs · `createWorkbenchHttpServer` | — |
| POST | `/api/chat/stream` | exact | token-browser | 13-http-router.js · `handleApi` | a11y-lint.browser.e2e.js, a11y-walkthrough.browser.e2e.js, acc-capability-gates.e2e.js 等 209 件 |
| POST | `/api/tools/` | prefix | token | 13-http-router.js · `handleApi` | audit-w23.e2e.js, autonomy-shell-sandbox.e2e.js, background-completion.e2e.js 等 25 件 |

## diagnostics(5)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| GET | `/api/usage/summary` | exact | token self | ../backend/diagnostic-routes.cjs · `handleUsageApiRoutes` | model-menu-no-shift.browser.e2e.js, settings-wave1.browser.e2e.js, steward-drawer.e2e.js 等 11 件 |
| GET | `/api/ops/metrics` | exact | token self | ../backend/diagnostic-routes.cjs · `handleUsageApiRoutes` | monitor-incremental.e2e.js |
| GET | `/api/audit` | exact | token self | ../backend/diagnostic-routes.cjs · `handleDiagnosticsApiRoutes` | audit-desktop-records.e2e.js, audit.e2e.js, auth-deny-default.e2e.js 等 7 件 |
| GET | `/api/storage/summary` | exact | token self | ../backend/diagnostic-routes.cjs · `handleDiagnosticsApiRoutes` | frontend-domains.static.e2e.js, metrics-panel.e2e.js, session-storage-v2.e2e.js 等 4 件 |
| GET | `/api/metrics` | exact | token self | ../backend/diagnostic-routes.cjs · `handleDiagnosticsApiRoutes` | frontend-domains.static.e2e.js, metrics-panel.e2e.js |

## event-stream(1)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| GET | `/api/events/stream` | exact | token-browser | ../backend/event-stream.cjs · `handleEventStreamApiRoutes` | action-feedback.browser.e2e.js, background-completion.e2e.js, boot-failure-kind.browser.e2e.js 等 24 件 |

## external-bots(10)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| POST | `/api/external-bots/callback/qq` | exact | external-callback self | 13w-external-bots.js · `handleExternalBotApiRoutes` | external-bot-gateway.e2e.js, external-bot-setup.e2e.js, external-bots.e2e.js |
| POST | `/api/external-bots/callback/feishu` | exact | external-callback self | 13w-external-bots.js · `handleExternalBotApiRoutes` | external-bot-gateway.e2e.js, external-bot-setup.browser.e2e.js, external-bots-control.e2e.js 等 5 件 |
| GET | `/api/external-bots/setup` | exact | token | 13w-external-bots.js · `handleExternalBotApiRoutes` | external-bot-discovery.e2e.js, external-bot-setup.browser.e2e.js, external-bot-setup.e2e.js 等 4 件 |
| POST | `/api/external-bots/setup` | exact | token | 13w-external-bots.js · `handleExternalBotApiRoutes` | external-bot-discovery.e2e.js, external-bot-setup.browser.e2e.js, external-bot-setup.e2e.js 等 4 件 |
| POST | `/api/external-bots/credentials` | exact | token | 13w-external-bots.js · `handleExternalBotApiRoutes` | external-bot-setup.e2e.js, external-bot-setup-ui.test.js |
| POST | `/api/external-bots/discover` | exact | token | 13w-external-bots.js · `handleExternalBotApiRoutes` | external-bot-discovery.e2e.js, external-bots-ui.test.js |
| GET | `/api/external-bots/connections` | exact | token | 13w-external-bots.js · `handleExternalBotApiRoutes` | external-bot-discovery.e2e.js, external-bot-gateway.e2e.js, external-bot-setup.browser.e2e.js 等 7 件 |
| POST | `/api/external-bots/connections` | exact | token | 13w-external-bots.js · `handleExternalBotApiRoutes` | external-bot-discovery.e2e.js, external-bot-gateway.e2e.js, external-bot-setup.browser.e2e.js 等 7 件 |
| GET | `/api/external-bots/inbox` | exact | token | 13w-external-bots.js · `handleExternalBotApiRoutes` | external-bot-setup.browser.e2e.js, external-bot-setup.e2e.js, external-bots-control.e2e.js 等 5 件 |
| POST | `/api/external-bots/inbox/read` | exact | token | 13w-external-bots.js · `handleExternalBotApiRoutes` | external-bots.e2e.js |

## intervention(11)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| POST | `/api/_test/pretender-maintenance` | exact | token | ../backend/intervention-routes.cjs · `handleInterventionApiRoutes` | mission-index-scale.e2e.js |
| POST | `/api/missions/:missionId/interventions/:interventionId/decision` | regex | token | ../backend/intervention-routes.cjs · `handleInterventionApiRoutes` | acceptance-provenance.e2e.js, action-feedback.browser.e2e.js, agent-workflow-replan-approve.e2e.js 等 35 件 |
| GET | `/api/interventions` | exact | token-browser self | ../backend/intervention-routes.cjs · `handleInterventionApiRoutes` | agent-workflow-replan-approve.e2e.js, agent-workflow-replan-review.e2e.js, event-stream-client.browser.e2e.js 等 30 件 |
| GET | `/api/interventions/:sessionId` | regex | token-browser self | ../backend/intervention-routes.cjs · `handleInterventionApiRoutes` | interventions-persist.e2e.js, mission-index-scale.e2e.js, session-id-path-guard.e2e.js 等 7 件 |
| POST | `/api/chat/answer` | exact | token-browser | ../backend/intervention-routes.cjs · `handleInterventionApiRoutes` | event-stream-client.browser.e2e.js, event-stream-replay.browser.e2e.js, event-stream.e2e.js 等 17 件 |
| POST | `/api/question/heartbeat` | exact | token-browser | ../backend/intervention-routes.cjs · `handleInterventionApiRoutes` | — |
| POST | `/api/question/request` | exact | body-token | ../backend/intervention-routes.cjs · `handleInterventionApiRoutes` | — |
| POST | `/api/permission/request` | exact | body-token | ../backend/intervention-routes.cjs · `handleInterventionApiRoutes` | acc-capability-gates.e2e.js, claude-cli-bridged-read-guard.e2e.js, claude-permission-bridge-mode.e2e.js 等 6 件 |
| POST | `/api/permission/decision` | exact | token-browser | ../backend/intervention-routes.cjs · `handleInterventionApiRoutes` | acc-capability-gates.e2e.js, autonomy-pause.e2e.js, claude-binary-live.e2e.js 等 17 件 |
| POST | `/api/plan/decision` | exact | token | ../backend/intervention-routes.cjs · `handleInterventionApiRoutes` | intervention-mission-gate.e2e.js, interventions-snapshot.e2e.js, plan-mode.e2e.js 等 7 件 |
| POST | `/api/_test/intervention-cas` | exact | token self | ../backend/intervention-routes.cjs · `handleInterventionApiRoutes` | interventions-cas.e2e.js, interventions-changeseq.e2e.js |

## local-support(5)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| GET | `/api/help/doc` | exact | token self | ../backend/local-support-routes.cjs · `handleLocalSupportApiRoutes` | help-viewer.e2e.js, onboarding.static.e2e.js |
| POST | `/api/open-path` | exact | token self | ../backend/local-support-routes.cjs · `handleLocalSupportApiRoutes` | copy-path-guard.static.e2e.js, help-menu.e2e.js, macos-runtime-start.e2e.js |
| GET | `/api/logs/tail` | exact | token self | ../backend/local-support-routes.cjs · `handleLocalSupportApiRoutes` | help-menu.e2e.js, ui-misc-wave1.browser.e2e.js |
| GET | `/api/file/preview` | exact | token self | ../backend/local-support-routes.cjs · `handleLocalSupportApiRoutes` | artifacts.e2e.js, audit-w23.e2e.js, file-text-encoding.e2e.js 等 8 件 |
| POST | `/api/file/reveal` | exact | token | ../backend/local-support-routes.cjs · `handleLocalSupportApiRoutes` | artifacts.e2e.js, copy-path-guard.static.e2e.js, help-menu.e2e.js 等 6 件 |

## mcp(7)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| POST | `/api/mcp/import-folder` | exact | token | ../backend/mcp-routes.cjs · `handleMcpApiRoutes` | mcp-config.e2e.js |
| POST | `/api/mcp/import-config/scan` | exact | token | ../backend/mcp-routes.cjs · `handleMcpApiRoutes` | mcp-import-config.e2e.js |
| POST | `/api/mcp/import-config/apply` | exact | token | ../backend/mcp-routes.cjs · `handleMcpApiRoutes` | action-feedback.static.e2e.js, copy-path-guard.static.e2e.js, mcp-import-config.e2e.js 等 4 件 |
| GET | `/api/mcp/connectors` | exact | token | ../backend/mcp-routes.cjs · `handleMcpApiRoutes` | config-mutate-mcp-parity.e2e.js, mcp-ops-closure.e2e.js, mcp-ops-gui.static.e2e.js 等 5 件 |
| POST | `/api/mcp/connectors/health` | exact | token | ../backend/mcp-routes.cjs · `handleMcpApiRoutes` | mcp-ops-closure.e2e.js, mcp-ops-gui.static.e2e.js, repo-hygiene.e2e.js |
| POST | `/api/mcp/connectors/toggle` | exact | token | ../backend/mcp-routes.cjs · `handleMcpApiRoutes` | config-mutate-mcp-parity.e2e.js, mcp-ops-closure.e2e.js, mcp-ops-gui.static.e2e.js 等 4 件 |
| DELETE | `/api/mcp/connectors` | exact | token | ../backend/mcp-routes.cjs · `handleMcpApiRoutes` | config-mutate-mcp-parity.e2e.js, mcp-ops-closure.e2e.js, mcp-ops-gui.static.e2e.js 等 5 件 |

## memory(16)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| POST | `/api/session/memories` | exact | token-browser | ../backend/memory-routes.cjs · `handleMemoryApiRoutes` | memory-subagent.e2e.js, session-id-path-guard.e2e.js, session-memory-cap.test.js 等 4 件 |
| GET | `/api/memory` | exact | token self | ../backend/memory-routes.cjs · `handleMemoryApiRoutes` | action-feedback.static.e2e.js, agent-quality-workflow.e2e.js, auth-deny-default.e2e.js 等 15 件 |
| GET | `/api/memory/item` | exact | token self | ../backend/memory-routes.cjs · `handleMemoryApiRoutes` | memory-scope-card.browser.e2e.js, memory-scope.e2e.js, workbench-memory.e2e.js |
| POST | `/api/memory/proposal` | exact | token-browser | ../backend/memory-routes.cjs · `handleMemoryApiRoutes` | action-feedback.static.e2e.js, memory-auto-proposal-api.e2e.js, memory-batch-proposal.e2e.js 等 5 件 |
| POST | `/api/memory/proposal/decision` | exact | token-browser | ../backend/memory-routes.cjs · `handleMemoryApiRoutes` | memory-auto-proposal-api.e2e.js, memory-batch-proposal.e2e.js, frontend-failure-paths.test.js |
| POST | `/api/memory/proposal/apply` | exact | token-browser | ../backend/memory-routes.cjs · `handleMemoryApiRoutes` | action-feedback.static.e2e.js, memory-batch-proposal.e2e.js, memory-scope.e2e.js 等 4 件 |
| POST | `/api/memory/draft` | exact | token-browser | ../backend/memory-routes.cjs · `handleMemoryApiRoutes` | memory-scope.e2e.js, workbench-memory.e2e.js |
| POST | `/api/memory/migrate` | exact | token-browser | ../backend/memory-routes.cjs · `handleMemoryApiRoutes` | workbench-memory.e2e.js |
| POST | `/api/memory/metadata` | exact | token-browser | ../backend/memory-routes.cjs · `handleMemoryApiRoutes` | memory-scope.e2e.js, http-input-hardening.test.js, memory-scope-fixes.test.js |
| POST | `/api/memory` | exact | token-browser | ../backend/memory-routes.cjs · `handleMemoryApiRoutes` | action-feedback.static.e2e.js, agent-quality-workflow.e2e.js, auth-deny-default.e2e.js 等 15 件 |
| GET | `/api/memory/relations` | exact | token self | ../backend/memory-routes.cjs · `handleMemoryApiRoutes` | agent-quality-workflow.e2e.js, workbench-memory.e2e.js |
| GET | `/api/memory/maintenance` | exact | token self | ../backend/memory-routes.cjs · `handleMemoryApiRoutes` | workbench-memory.e2e.js |
| POST | `/api/memory/relations/propose` | exact | token-browser | ../backend/memory-routes.cjs · `handleMemoryApiRoutes` | workbench-memory.e2e.js |
| POST | `/api/memory/relations/confirm` | exact | token-browser | ../backend/memory-routes.cjs · `handleMemoryApiRoutes` | workbench-memory.e2e.js |
| DELETE/POST | `/api/memory/relations/` | prefix | token-browser | ../backend/memory-routes.cjs · `handleMemoryApiRoutes` | workbench-memory.e2e.js |
| DELETE/POST | `/api/memory/` | prefix | token-browser | ../backend/memory-routes.cjs · `handleMemoryApiRoutes` | action-feedback.static.e2e.js, agent-quality-workflow.e2e.js, auth-deny-default.e2e.js 等 11 件 |

## migration(5)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| GET | `/api/migration/scan` | exact | token | ../backend/migration-routes.cjs · `handleMigrationApiRoutes` | memory-scope.e2e.js, migration-center.browser.e2e.js, migration-center.e2e.js |
| POST | `/api/migration/apply` | exact | token | ../backend/migration-routes.cjs · `handleMigrationApiRoutes` | migration-center.e2e.js |
| POST | `/api/migration/undo` | exact | token | ../backend/migration-routes.cjs · `handleMigrationApiRoutes` | migration-center.e2e.js |
| POST | `/api/migration/recycle` | exact | token | ../backend/migration-routes.cjs · `handleMigrationApiRoutes` | migration-center.e2e.js |
| POST | `/api/migration/skills/copy` | exact | token | ../backend/migration-routes.cjs · `handleMigrationApiRoutes` | migration-center.e2e.js |

## mission(7)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| GET | `/api/missions` | exact | token-browser self | ../backend/mission-routes.cjs · `handleMissionsApiRoutes` | acceptance-provenance.e2e.js, action-feedback.browser.e2e.js, agent-workflow-replan-approve.e2e.js 等 56 件 |
| POST | `/api/missions` | exact | token self | ../backend/mission-routes.cjs · `handleMissionsApiRoutes` | acceptance-provenance.e2e.js, action-feedback.browser.e2e.js, agent-workflow-replan-approve.e2e.js 等 56 件 |
| PATCH/POST | `/api/missions/:missionId` | regex | token self | ../backend/mission-routes.cjs · `handleMissionsApiRoutes` | acceptance-provenance.e2e.js, action-feedback.browser.e2e.js, agent-workflow-replan-approve.e2e.js 等 35 件 |
| POST | `/api/missions/:missionId/threads` | regex | token self | ../backend/mission-routes.cjs · `handleMissionsApiRoutes` | acceptance-provenance.e2e.js, action-feedback.browser.e2e.js, agent-workflow-replan-approve.e2e.js 等 35 件 |
| POST | `/api/missions/:missionId/merge` | regex | token self | ../backend/mission-routes.cjs · `handleMissionsApiRoutes` | acceptance-provenance.e2e.js, action-feedback.browser.e2e.js, agent-workflow-replan-approve.e2e.js 等 35 件 |
| POST | `/api/missions/:missionId/split` | regex | token self | ../backend/mission-routes.cjs · `handleMissionsApiRoutes` | acceptance-provenance.e2e.js, action-feedback.browser.e2e.js, agent-workflow-replan-approve.e2e.js 等 35 件 |
| GET | `/api/missions/:missionId` | regex | token-browser self | ../backend/mission-routes.cjs · `handleMissionsApiRoutes` | acceptance-provenance.e2e.js, action-feedback.browser.e2e.js, agent-workflow-replan-approve.e2e.js 等 35 件 |

## mission-ledger(2)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| POST | `/api/todo` | exact | body-token | ../backend/mission-ledger-routes.cjs · `handleMissionLedgerApiRoutes` | event-stream.e2e.js, todo-loopback.e2e.js, http-input-hardening.test.js 等 4 件 |
| GET/POST | `/api/mission` | exact | body-token self | ../backend/mission-ledger-routes.cjs · `handleMissionLedgerApiRoutes` | acceptance-provenance.e2e.js, action-feedback.browser.e2e.js, agent-workflow-replan-approve.e2e.js 等 71 件 |

## playbook(5)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| GET | `/api/playbooks` | exact | token-browser | ../backend/playbook-routes.cjs · `handlePlaybookApiRoutes` | auth-deny-default.e2e.js, macos-platform-templates.e2e.js, meta-guard.e2e.js 等 8 件 |
| POST | `/api/playbooks/service-match` | exact | token-browser | ../backend/playbook-routes.cjs · `handlePlaybookApiRoutes` | playbooks.e2e.js |
| POST | `/api/playbooks/draft` | exact | token | ../backend/playbook-routes.cjs · `handlePlaybookApiRoutes` | playbook-reuse.browser.e2e.js, playbooks.e2e.js |
| POST | `/api/playbooks` | exact | token | ../backend/playbook-routes.cjs · `handlePlaybookApiRoutes` | auth-deny-default.e2e.js, macos-platform-templates.e2e.js, meta-guard.e2e.js 等 8 件 |
| DELETE/POST | `/api/playbooks/` | prefix | token | ../backend/playbook-routes.cjs · `handlePlaybookApiRoutes` | auth-deny-default.e2e.js, playbook-reuse.browser.e2e.js, playbooks.e2e.js |

## provider(2)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| GET | `/api/models` | exact | open | ../backend/provider-routes.cjs · `handleModelsApiRoute` | asr-config-ui.static.e2e.js, claude-models-cache.e2e.js, context-window.e2e.js 等 7 件 |
| POST | `/api/provider/test` | exact | token | ../backend/provider-routes.cjs · `handleProviderTestApiRoute` | anthropic-gateway-setup.e2e.js, anthropic-provider-setup.browser.e2e.js, audit-w23.e2e.js 等 8 件 |

## scheduler(6)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| GET | `/api/scheduler/tasks` | exact | token | ../backend/scheduler-routes.cjs · `handleSchedulerApiRoutes` | macos-desktop-lifecycle.e2e.js, quiet-card-snooze.browser.e2e.js, rail-pocket.browser.e2e.js 等 15 件 |
| POST | `/api/scheduler/tasks` | exact | token | ../backend/scheduler-routes.cjs · `handleSchedulerApiRoutes` | macos-desktop-lifecycle.e2e.js, quiet-card-snooze.browser.e2e.js, rail-pocket.browser.e2e.js 等 15 件 |
| * | `/api/scheduler/tasks/:taskId` | regex | token | ../backend/scheduler-routes.cjs · `handleSchedulerApiRoutes` | scheduler-api.e2e.js, scheduler-crash.e2e.js, scheduler-steward.e2e.js 等 9 件 |
| * | `/api/scheduler/tasks/:taskId` | regex | token | ../backend/scheduler-routes.cjs · `handleSchedulerApiRoutes` | scheduler-api.e2e.js, scheduler-crash.e2e.js, scheduler-steward.e2e.js 等 9 件 |
| POST | `/api/scheduler/tasks/:taskId/run-now` | regex | token | ../backend/scheduler-routes.cjs · `handleSchedulerApiRoutes` | scheduler-api.e2e.js, scheduler-crash.e2e.js, scheduler-steward.e2e.js 等 9 件 |
| GET | `/api/scheduler/tasks/:taskId/runs` | regex | token | ../backend/scheduler-routes.cjs · `handleSchedulerApiRoutes` | scheduler-api.e2e.js, scheduler-crash.e2e.js, scheduler-steward.e2e.js 等 9 件 |

## session(6)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| GET | `/api/sessions` | exact | token-browser | ../backend/session-routes.cjs · `handleSessionApiRoutes` | a11y-lint.browser.e2e.js, a11y-walkthrough.browser.e2e.js, acc-capability-gates.e2e.js 等 274 件 |
| GET | `/api/sessions/search` | exact | token self | ../backend/session-routes.cjs · `handleSessionApiRoutes` | session-id-path-guard.e2e.js, session-search.e2e.js, steward-runner.e2e.js 等 4 件 |
| POST | `/api/sessions` | exact | token-browser | ../backend/session-routes.cjs · `handleSessionApiRoutes` | a11y-lint.browser.e2e.js, a11y-walkthrough.browser.e2e.js, acc-capability-gates.e2e.js 等 274 件 |
| POST | `/api/sessions/bulk-delete` | exact | token-browser | ../backend/session-routes.cjs · `handleSessionApiRoutes` | session-bulk-cleanup.e2e.js |
| GET | `/api/sessions/background-counts` | exact | token-browser self | ../backend/session-routes.cjs · `handleSessionApiRoutes` | — |
| DELETE/GET/PATCH/POST | `/api/sessions/:id` | regex | token-browser | ../backend/session-routes.cjs · `handleSessionApiRoutes` | acc-capability-gates.e2e.js, action-feedback.browser.e2e.js, agent-mode-v2.e2e.js 等 156 件 |

## session-execution(4)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| POST | `/api/stop` | exact | token-browser | ../backend/session-execution-routes.cjs · `handleSessionExecutionApiRoutes` | agent-resource-wait-stop.e2e.js, agent-run-lifecycle.e2e.js, agent-wake.e2e.js 等 27 件 |
| POST | `/api/provider/compact` | exact | token-browser | ../backend/session-execution-routes.cjs · `handleSessionExecutionApiRoutes` | context-compact-v2.e2e.js, provider-compact-recall.e2e.js, provider-compact.e2e.js 等 6 件 |
| POST | `/api/agent/compact` | exact | token-browser | ../backend/session-execution-routes.cjs · `handleSessionExecutionApiRoutes` | agent-cli-registry.test.js |
| GET | `/api/kimi/status` | exact | token-browser | ../backend/session-execution-routes.cjs · `handleSessionExecutionApiRoutes` | kimi-agent-cli.e2e.js, store-walkthrough-w1.e2e.js |

## skills(3)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| GET | `/api/skills` | exact | token-browser | ../backend/skill-routes.cjs · `handleSkillApiRoutes` | audit-w23.e2e.js, meta-guard.e2e.js, migration-center.browser.e2e.js 等 7 件 |
| POST | `/api/session/skills` | exact | token-browser | ../backend/skill-routes.cjs · `handleSkillApiRoutes` | claude-mac-argv.e2e.js, index-dedup.e2e.js, session-id-path-guard.e2e.js 等 6 件 |
| DELETE | `/api/skills` | exact | token | ../backend/skill-routes.cjs · `handleSkillApiRoutes` | audit-w23.e2e.js, meta-guard.e2e.js, migration-center.browser.e2e.js 等 7 件 |

## status(3)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| POST | `/api/bootstrap` | exact | open | ../backend/status-routes.cjs · `handleStatusApiRoutes` | checkpoint-visibility.e2e.js, claude-binary-live.e2e.js, context-compact-v2.e2e.js 等 22 件 |
| GET | `/api/status` | exact | open | ../backend/status-routes.cjs · `handleStatusApiRoutes` | acc-capability-gates.e2e.js, agent-deadlock-watchdog.e2e.js, asr-transcribe.e2e.js 等 82 件 |
| GET | `/api/capabilities` | exact | open | ../backend/status-routes.cjs · `handleStatusApiRoutes` | capabilities.e2e.js, macos-capability-popover.browser.e2e.js, macos-capture-host.e2e.js 等 7 件 |

## steer(2)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| POST | `/api/steer` | exact | token | ../backend/session-steering.cjs · `handleSteerApiRoute` | agent-steer-node.e2e.js, classic-window-live-steer.e2e.js, composer-session-races.browser.e2e.js 等 13 件 |
| DELETE | `/api/steer` | exact | token | ../backend/session-steering.cjs · `handleSteerApiRoute` | agent-steer-node.e2e.js, classic-window-live-steer.e2e.js, composer-session-races.browser.e2e.js 等 13 件 |

## steward(20)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| POST | `/api/steward/start` | exact | token self | ../backend/steward-routes.cjs · `handleStewardApiRoutes` | steward-continue-unfinished.e2e.js, steward-events.static.e2e.js, steward-inbox.e2e.js 等 6 件 |
| POST | `/api/steward/stop` | exact | token self | ../backend/steward-routes.cjs · `handleStewardApiRoutes` | steward-events.static.e2e.js, steward-inbox.e2e.js, steward-preroute.e2e.js 等 5 件 |
| GET | `/api/steward/state` | exact | token self | ../backend/steward-routes.cjs · `handleStewardApiRoutes` | mission-index-late-materialize.e2e.js, rail-pocket.browser.e2e.js, steward-deliverable.e2e.js 等 12 件 |
| GET | `/api/steward/inbox` | exact | token self | ../backend/steward-routes.cjs · `handleStewardApiRoutes` | steward-events.static.e2e.js, steward-inbox.e2e.js, steward-presence-gate.e2e.js 等 5 件 |
| GET | `/api/steward/preroute` | exact | token self | ../backend/steward-routes.cjs · `handleStewardApiRoutes` | external-bots.browser.e2e.js, keyboard-walkthrough.browser.e2e.js, steward-conversation.e2e.js 等 7 件 |
| GET | `/api/steward/memory` | exact | token | ../backend/steward-routes.cjs · `handleStewardApiRoutes` | action-feedback.static.e2e.js, rail-pocket.browser.e2e.js, steward-memory.e2e.js 等 6 件 |
| GET | `/api/steward/memory/export` | exact | token | ../backend/steward-routes.cjs · `handleStewardApiRoutes` | steward-memory.e2e.js, steward-settings.static.e2e.js |
| POST | `/api/steward/memory/edit` | exact | token | ../backend/steward-routes.cjs · `handleStewardApiRoutes` | steward-memory.e2e.js, steward-settings.static.e2e.js |
| POST | `/api/steward/memory/veto` | exact | token | ../backend/steward-routes.cjs · `handleStewardApiRoutes` | steward-memory.e2e.js, steward-settings.static.e2e.js |
| POST | `/api/steward/memory/restore` | exact | token | ../backend/steward-routes.cjs · `handleStewardApiRoutes` | steward-memory.e2e.js, steward-settings.static.e2e.js |
| POST | `/api/steward/memory/clear` | exact | token | ../backend/steward-routes.cjs · `handleStewardApiRoutes` | action-feedback.static.e2e.js, steward-memory.e2e.js, steward-settings.static.e2e.js |
| GET | `/api/steward/decisions` | exact | token | ../backend/steward-routes.cjs · `handleStewardApiRoutes` | steward-decisions.e2e.js, steward-settings.e2e.js, steward-settings.static.e2e.js 等 6 件 |
| GET | `/api/steward/delivery` | exact | token | ../backend/steward-routes.cjs · `handleStewardRunnerApiRoutes` | steward-delivery-history.browser.e2e.js, steward-delivery.browser.e2e.js |
| GET | `/api/steward/arbiter` | exact | token self | ../backend/steward-routes.cjs · `handleStewardRunnerApiRoutes` | focus-rail.browser.e2e.js, net-token-replay.static.e2e.js, session-stop-execution.e2e.js 等 12 件 |
| POST | `/api/steward/arbiter/prioritize` | exact | token self | ../backend/steward-routes.cjs · `handleStewardRunnerApiRoutes` | steward-board.static.e2e.js, steward-drawer.static.e2e.js, thread-arbiter.e2e.js |
| POST | `/api/steward/reset` | exact | token self | ../backend/steward-routes.cjs · `handleStewardRunnerApiRoutes` | steward-conversation.static.e2e.js, steward-new-conversation.browser.e2e.js |
| POST | `/api/steward/visit` | exact | token self | ../backend/steward-routes.cjs · `handleStewardRunnerApiRoutes` | external-bot-setup.browser.e2e.js, steward-conversation.e2e.js, steward-conversation.static.e2e.js 等 8 件 |
| POST | `/api/steward/act` | exact | token self | ../backend/steward-routes.cjs · `handleStewardRunnerApiRoutes` | classic-window-live-steer.e2e.js, event-stream-client.browser.e2e.js, event-stream-pageshow.browser.e2e.js 等 29 件 |
| POST | `/api/steward/relay` | exact | token self | ../backend/steward-routes.cjs · `handleStewardRunnerApiRoutes` | foreign-turn-busy-guard.e2e.js, new-thread-engine-default.e2e.js, session-rewind-execution.e2e.js 等 13 件 |
| POST | `/api/steward/message` | exact | token self | ../backend/steward-routes.cjs · `handleStewardRunnerApiRoutes` | classic-window-live-steer.e2e.js, event-stream.e2e.js, external-bot-setup.e2e.js 等 23 件 |

## workspace(4)

| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |
|---|---|---|---|---|---|
| POST | `/api/workspace/resolve` | exact | token | ../backend/workspace-routes.cjs · `handleWorkspaceApiRoutes` | macos-desktop-bridge.e2e.js, workspace-resolve.e2e.js |
| POST | `/api/pick-folder` | exact | token | ../backend/workspace-routes.cjs · `handleWorkspaceApiRoutes` | macos-desktop-bridge.e2e.js, onboarding-workspace.browser.e2e.js, settings-wave1.browser.e2e.js 等 5 件 |
| POST | `/api/workspace/dedicated` | exact | token | ../backend/workspace-routes.cjs · `handleWorkspaceApiRoutes` | onboarding-workspace.browser.e2e.js |
| POST | `/api/pick-file` | exact | token | ../backend/workspace-routes.cjs · `handleWorkspaceApiRoutes` | macos-desktop-bridge.e2e.js, settings-wave1.browser.e2e.js, workspace-resolve.e2e.js |

## 域路由委派(handleApi → 域 handler)

- ../backend/mcp-routes.cjs · `handleMcpApiRoutes` → `handleMigrationApiRoutes`
- ../backend/steward-routes.cjs · `handleStewardApiRoutes` → `handleStewardRunnerApiRoutes`
- ../backend/steward-routes.cjs · `handleStewardRunnerApiRoutes` → `handleStewardDeliveryApiRoutes`
- 13-http-router.js · `handleApi` → `handleStatusApiRoutes`
- 13-http-router.js · `handleApi` → `handlePlaybookApiRoutes`
- 13-http-router.js · `handleApi` → `handleWorkspaceApiRoutes`
- 13-http-router.js · `handleApi` → `handleModelsApiRoute`
- 13-http-router.js · `handleApi` → `handleConfigurationApiRoutes`
- 13-http-router.js · `handleApi` → `handleProviderTestApiRoute`
- 13-http-router.js · `handleApi` → `handleSessionApiRoutes`
- 13-http-router.js · `handleApi` → `handleMissionsApiRoutes`
- 13-http-router.js · `handleApi` → `handleSkillApiRoutes`
- 13-http-router.js · `handleApi` → `handleMemoryApiRoutes`
- 13-http-router.js · `handleApi` → `handleSessionExecutionApiRoutes`
- 13-http-router.js · `handleApi` → `handleInterventionApiRoutes`
- 13-http-router.js · `handleApi` → `handleMissionLedgerApiRoutes`
- 13-http-router.js · `handleApi` → `handleAutonomyGrantApiRoutes`
- 13-http-router.js · `handleApi` → `handleAgentWorkflowApiRoutes`
- 13-http-router.js · `handleApi` → `handleUsageApiRoutes`
- 13-http-router.js · `handleApi` → `handleAgentRunApiRoutes`
- 13-http-router.js · `handleApi` → `handleCheckpointQueryApiRoutes`
- 13-http-router.js · `handleApi` → `handleLocalSupportApiRoutes`
- 13-http-router.js · `handleApi` → `handleMcpApiRoutes`
- 13-http-router.js · `handleApi` → `handleDiagnosticsApiRoutes`
- 13-http-router.js · `handleApi` → `handleCheckpointApiRoutes`
- 13-http-router.js · `handleApi` → `handleSteerApiRoute`
- 13-http-router.js · `handleApi` → `handleAudioApiRoutes`
- 13-http-router.js · `handleApi` → `handleSchedulerApiRoutes`
- 13-http-router.js · `handleApi` → `handleAttachmentApiRoutes`
