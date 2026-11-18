'use strict';
require('./lib/self-isolate-home');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRunner } = require('./lib/harness');
const { loadServerInternals } = require('./lib/server-internals');
const { createAgentWorkflow } = require('../ruyi-workbench/app/backend/agent-workflow.cjs');
const { createAgentWorktrees } = require('../ruyi-workbench/app/backend/agent-worktrees.cjs');
const t = createRunner('WORKTREE CLEANUP RETRY');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-worktree-retry-'));
process.env.RUYI_HOME = path.join(root, 'data');
(async () => {
  try {
    const S = loadServerInternals(['agentWorkflowPorts', 'createSession', 'defaultConfig', 'agentRunFile']);
    const provider = { id: 'fixture', type: 'openai-compat', apiStyle: 'chat', baseUrl: 'http://127.0.0.1:1', model: 'fixture' };
    const config = { ...S.defaultConfig(), defaultWorkspace: root, permissionMode: 'bypass', providers: [provider], activeProvider: provider.id,
      subagentMaxPerTurn: 4, subagentMaxConcurrent: 1, agentTaskPoolPolicy: 'off' };
    const session = await S.createSession({ title: 'cleanup retry fixture', cwd: root });
    for (const mode of ['degraded', 'failed', 'finalize', 'create', 'sub-cleanup']) {
      const ports = S.agentWorkflowPorts;
      let worktree, executions = 0, finalizations = 0;
      const worktrees = createAgentWorktrees({
        worktreesDirectory: path.join(root, 'worktrees'), agentRunFile: S.agentRunFile,
        nowIso: ports.nowIso, safeSessionId: ports.safeSessionId, saveAgentRun: ports.runs.saveAgentRun,
        async runGit(args, cwd) {
          const [command, subcommand] = args;
          const uncertain = { ok: false, stderr: 'cleanup unconfirmed', cleanupIncomplete: true };
          if (command === 'rev-parse') return { ok: true, stdout: subcommand === '--show-toplevel' ? root : 'fixture-commit' };
          if (command === 'worktree' && subcommand === 'add') {
            worktree = args[3];
            fs.mkdirSync(worktree);
            fs.writeFileSync(path.join(worktree, 'retained.txt'), 'keep');
            return mode === 'create' ? uncertain : { ok: true };
          }
          if (command === 'status' && cwd === worktree) {
            finalizations++;
            return mode === 'finalize' ? uncertain : { ok: true, stdout: 'A  retained.txt' };
          }
          if (command === 'worktree' && subcommand === 'remove') return uncertain;
          return { ok: true };
        },
      });
      const { runAgentWorkflow } = createAgentWorkflow({
        ...ports, worktrees,
        nodes: {
          ...ports.nodes,
          async runSubAgent() {
            executions++;
            return {
              ok: mode !== 'failed', cleanupIncomplete: mode === 'sub-cleanup', degraded: mode === 'degraded',
              warning: 'synthetic degraded result', result: 'fixture result', error: 'synthetic failed result', iters: 1, toolCalls: 0,
            };
          },
        },
      });
      const events = [];
      const result = await runAgentWorkflow({ parentSession: session, provider, config, maxNodes: 1,
        nodes: [{ id: 'writer', task: 'fixture', toolTier: 'edit', isolation: 'worktree', failurePolicy: 'retry', maxRetries: 2, degradedPolicy: 'retry' }],
        onEvent: event => events.push(event), ctrl: new AbortController(), poolPolicy: 'off' });
      const run = JSON.parse(fs.readFileSync(S.agentRunFile(session.id, result.runId), 'utf8'));
      const node = run.nodes[0];
      t.ok(node.status === 'failed' && node.errorClass === 'process_cleanup_incomplete' && node.isolation.path === worktree
        && fs.existsSync(path.join(worktree, 'retained.txt')), mode + ' failure persists isolation and failure classification');
      t.ok(!events.some(event => ['node_retry', 'node_degraded_retry'].includes(event.state))
        && executions <= 1, mode + ' cleanup failure prevents automatic re-execution');
      if (['create', 'sub-cleanup'].includes(mode)) t.ok(finalizations === 0, mode + ' uncertainty prevents snapshot finalization');
      const resumed = await runAgentWorkflow({ parentSession: session, provider, config, maxNodes: 1, existingRun: run,
        onEvent: () => {}, ctrl: new AbortController(), poolPolicy: 'off' });
      t.ok(!resumed.ok && resumed.cleanupIncomplete && resumed.startedCount === 0, mode + ' persisted uncertainty prevents silent resume');
      if (mode === 'sub-cleanup') {
        const pending = structuredClone(run);
        pending.nodes[0].isolation.status = 'applying'; delete pending.nodes[0].isolation.cleanupIncomplete; pending.nodes[0].errorClass = '';
        const pendingResult = await runAgentWorkflow({ parentSession: session, provider, config, maxNodes: 1, existingRun: pending, onEvent: () => {}, ctrl: new AbortController() });
        t.ok(!pendingResult.ok && pendingResult.applicationUnconfirmed && pendingResult.startedCount === 0, 'unconfirmed apply intent also blocks workflow resume');
      }
    }
  } catch (error) { t.fail(error.stack || String(error)); }
  finally {
    fs.rmSync(root, { recursive: true, force: true }); t.done();
  }
})();
