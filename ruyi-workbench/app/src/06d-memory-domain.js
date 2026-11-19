// ============================================================================
// v2 跨会话记忆(团队模式 v2 Phase 3, 设计稿 C0-C5)。文件型记忆库 + 起草-确认写入 + 围栏式渐进注入。
// 与 <project-memory>(CLAUDE.md,作者=仓库)分工(C0):本库作者=用户+AI 经确认,随工作台走。注入标签
// <workbench-memory>、UI 一律称「工作台记忆」。存储:dataRoot()/memory/{global,project/<projectKey>}/<id>.md。
// ============================================================================
const MEMORY_TYPES = new Set(['preference', 'convention', 'lesson', 'reference']);
const MEMORY_METADATA_READ_CAP = 16 * 1024;
const MEMORY_USAGE_TOUCH_MS = 60 * 60 * 1000; // 主动检索/读取最多每小时记一次 use
const MEMORY_RULE_TOUCH_MS = 24 * 60 * 60 * 1000; // 核心偏好/惯例被基础提示词采用时每天记一次隐式 use
// frontmatter 单行值消毒:去换行(parseFrontmatter 按行 key: value 解析,值里的换行会破坏结构)。
const MemoryStore = require('./backend/memory-store.cjs').createMemoryStore({
  paths, atomicWriteJson, safeJsonParse, SKILL_ID_RE, makeId, nowIso,
  limits: { MEMORY_TYPES, MEMORY_METADATA_READ_CAP, CORE_MEMORY_SUMMARY_CAP, MEMORY_USAGE_TOUCH_MS, MEMORY_RULE_TOUCH_MS },
});
const { fmVal, memoryGlobalDir, memoryProjectDir, projectKeyForCwd, cleanMemoryDate, memoryIsExpired,
  loadMemoryRegistry, listMemoryProjectGroups, readMemoryItem, saveMemory, deleteMemory } = MemoryStore;

const { createAgentInstructionImports, filterMemoryForNativeCli } = require('./backend/agent-instruction-imports.cjs');
const AgentInstructionImports = createAgentInstructionImports({
  paths, DurableJsonStore, agentCliHomes, tildePath, nowIso, logEvent, atomicWriteJson, store: MemoryStore,
  summaryCap: CORE_MEMORY_SUMMARY_CAP,
});
const { syncAgentInstructionImports } = AgentInstructionImports;

// ============================================================================
// R4 Local Memory Graph(设计稿 docs/optimization-plan/15-r4-memory-graph.md)。
// 给已确认工作台记忆加 supports/contradicts/supersedes/derived_from 关系边。模型只 propose(confirmed:false),
// 用户 confirm/delete。边按 scope+projectKey 隔离;pending 不进检索;confirmed contradicts 在注入时双向标记。
// 不建全局跨项目索引(evidenceRef 只存 eventId 不存原文,与 R1 同纪律)。
// ============================================================================
const MemoryRelations = require('./backend/memory-relations.cjs').createMemoryRelations({
  storage: { memoryGlobalDir, memoryProjectDir, readMemoryDir: MemoryStore.readMemoryDir, writeMemoryMeta: MemoryStore.writeMemoryMeta, atomicWriteJson },
  safeJsonParse, SKILL_ID_RE, makeId, nowIso, fmVal, logEvent, memoryIsExpired,
});
const { analyzeMemoryMaintenance, listMemoryRelations, proposeMemoryRelation, confirmMemoryRelation, deleteMemoryRelation,
  buildMemoryConflictMap, readConfirmedSupersedeEdges, extractMemoryRelationProposals, removeMemoryRelationsFor } = MemoryRelations;

const MemoryRecall = require('./backend/memory-recall.cjs').createMemoryRecall();
const { rankRelevantMemories } = MemoryRecall;

const { MEMORY_EXCLUSION_MAX, createMemorySelection, memorySelectionSignature } = require('./backend/memory-selection.cjs');
const MemorySelection = createMemorySelection({
  store: MemoryStore, prompts: MemoryPrompts, recall: MemoryRecall, relations: MemoryRelations, readConfig,
});
const { memoryExclusionSet, resolveCoreMemoryState, resolveMemoryPreflight } = MemorySelection;

const { memoryProposalLooksSensitive } = require('./backend/memory-sensitivity.cjs');
const MemoryMigrations = require('./backend/memory-migrations.cjs').createMemoryMigrations({
  paths, store: MemoryStore, removeMemoryRelationsFor, atomicWriteJson, SKILL_ID_RE,
  logEvent, nowIso, accMemoryImportStore, ACC_MEMORY_IMPORT_SCHEMA, legacyAccMemoryMigrationComplete,
});
const { moveMemoryScope, migrateLegacyAccMemory, migrateMemory } = MemoryMigrations;
const { resolveWorkbenchMemoryToolContext, listWorkbenchMemories, readWorkbenchMemory } = require('./backend/memory-tools.cjs').createMemoryTools({
  store: MemoryStore, selection: MemorySelection, recall: MemoryRecall, relations: MemoryRelations,
  activeChildren, loadSession, readConfig, safeSessionId, SKILL_ID_RE,
});
const MemoryProposals = require('./backend/memory-proposals.cjs').createMemoryProposals({
  paths, store: MemoryStore, relations: MemoryRelations, memorySearchTerms: MemoryRecall.memorySearchTerms, resolveWorkbenchMemoryToolContext,
  moveMemoryScope, activeChildren, loadSession, readConfig, safeSessionId, providerRawCompletion, appendUsageLedger,
  atomicWriteJson, makeId, nowIso, SKILL_ID_RE, MEMORY_TYPES,
});
const {
  proposeWorkbenchMemory, proposeMemoryRelationTool, proposeMemoryRevision, proposeMemoryRelationRevoke,
  draftMemoryFromSession, proposeMemoryFromSession, replayPendingMemoryProposal, decideMemoryProposal,
  applyMemoryRelationProposal, validateMemoryProposalSave,
  memoryProposalPrefilter, parseMemoryProposalDecision, memoryProposalSimilarity, memoryProposalIsDuplicate,
} = MemoryProposals;
