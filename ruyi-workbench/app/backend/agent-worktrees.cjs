'use strict';

const path = require('node:path');
const fsp = require('node:fs/promises');
const { normalizeCwd, pathWithinRoot } = require('./path-containment.cjs');
const { runKeyedChain } = require('./keyed-chain.cjs');

function createAgentWorktrees({ worktreesDirectory, runGit, safeSessionId, nowIso, agentRunFile, saveAgentRun }) {
  async function gitExec(cwd, args, timeout = 30000) {
    const result = await runGit(args, cwd, timeout, { maxBuffer: 16 * 1024 * 1024, owner: { kind: 'agent-worktree' } });
    if (result.ok) return String(result.stdout || '').trim();
    const error = result.error || new Error(String(result.stderr || 'Git command failed').trim());
    error.gitStderr = String(result.stderr || '').trim();
    error.cleanupIncomplete = result.cleanupIncomplete === true || error.code === 'ERR_PROCESS_OUTPUT_INCOMPLETE';
    throw error;
  }
  async function createAgentWorktree(cwd, runId, nodeId, attempt) {
    const repoRoot = await gitExec(cwd, ['rev-parse', '--show-toplevel']);
    const dirty = await gitExec(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
    if (dirty) throw new Error('原工作区有未提交改动，无法从一致快照创建隔离节点；请先提交或移走这些改动');
    const baseCommit = await gitExec(repoRoot, ['rev-parse', 'HEAD']);
    const folder = `${safeSessionId(runId)}-${safeSessionId(nodeId)}-a${Math.max(1, Number(attempt) || 1)}`;
    const worktreePath = path.resolve(worktreesDirectory, folder);
    if (!pathWithinRoot(worktreePath, path.resolve(worktreesDirectory))) throw new Error('invalid agent worktree path');
    await fsp.mkdir(path.dirname(worktreePath), { recursive: true });
    const isolation = { mode: 'worktree', status: 'running', path: worktreePath, repoRoot: path.resolve(repoRoot), baseCommit, createdAt: nowIso() };
    try { await gitExec(repoRoot, ['worktree', 'add', '--detach', worktreePath, baseCommit], 60000); }
    catch (error) {
      if (error.cleanupIncomplete) error.worktreeIsolation = { ...isolation, status: 'error', cleanupIncomplete: true };
      throw error;
    }
    return isolation;
  }
  async function finalizeAgentWorktree(isolation, runId, nodeId) {
    if (!isolation || isolation.mode !== 'worktree') return isolation;
    const changes = await gitExec(isolation.path, ['status', '--porcelain=v1', '--untracked-files=all']);
    if (!changes) {
      isolation.status = 'clean'; isolation.completedAt = nowIso();
      try { await gitExec(isolation.repoRoot, ['worktree', 'remove', '--force', isolation.path], 60000); } catch (error) { if (error.cleanupIncomplete) throw error; }
      isolation.path = ''; return isolation;
    }
    await gitExec(isolation.path, ['add', '-A']);
    // 走查 W1·F5:这是工作台自己给隔离节点拍的内部快照提交,不是用户的提交 —— 不能受用户仓库配置牵连:
    //   · pre-commit / commit-msg 钩子(lint、测试、commitlint)会让快照失败,整个隔离节点跟着报错 → --no-verify;
    //     prepare-commit-msg / post-commit 钩子(commitizen、通知脚本)--no-verify 管不到,worktree 与主仓共用钩子目录,
    //     所以再把 core.hooksPath 指到一个不存在的目录,一并不跑;
    //   · commit.gpgsign=true 在没有 gpg / 没有私钥的环境里直接报错 → 显式关掉。
    //   user.name / user.email 照旧用 -c 注入(用户没配身份时也提得成)。
    await gitExec(isolation.path, [
      '-c', 'user.name=Ruyi Agent', '-c', 'user.email=agent@ruyi.local', '-c', 'commit.gpgsign=false',
      '-c', 'core.hooksPath=' + path.join(worktreesDirectory, '.no-hooks'),
      'commit', '--no-verify', '-m', `agent(${nodeId}): isolated result for ${runId}`,
    ], 60000);
    isolation.commit = await gitExec(isolation.path, ['rev-parse', 'HEAD']);
    isolation.status = 'ready'; isolation.completedAt = nowIso(); isolation.changeSummary = changes.split(/\r?\n/).slice(0, 100);
    return isolation;
  }
  const agentWorktreeApplyChains = new Map();
  async function applyAgentWorktree(run, nodeId) {
    const isolation = (run.nodes || []).find(node => node.id === nodeId)?.isolation;
    if (!isolation) return { ok: false, error: '该节点没有可应用的隔离提交' };
    const repoRoot = path.resolve(isolation.repoRoot || '');
    const stat = await fsp.stat(repoRoot, { bigint: true }).catch(() => null);
    const key = stat && stat.ino !== 0n ? `${stat.dev}:${stat.ino}:${stat.birthtimeNs}` : 'unknown-repository';
    return runKeyedChain(agentWorktreeApplyChains, key, async () => {
      try {
        const stored = JSON.parse(await fsp.readFile(agentRunFile(run.sessionId, run.id), 'utf8'));
        if (!stored || stored.id !== run.id || stored.sessionId !== run.sessionId) throw new Error('隔离运行记录身份不匹配');
        const storedIsolation = stored.nodes?.find(node => node.id === nodeId)?.isolation;
        if (storedIsolation && path.resolve(storedIsolation.repoRoot || '') !== repoRoot) return { ok: false, recordChanged: true, error: '隔离工作树目标已变化，请重新读取后重试' };
        Object.assign(run, stored);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      return applyAgentWorktreeLocked(run, nodeId);
    });
  }
  async function applyAgentWorktreeLocked(run, nodeId) {
    const node = (run.nodes || []).find(n => n.id === nodeId);
    if (!node || !node.isolation || node.isolation.mode !== 'worktree' || !node.isolation.commit) return { ok: false, error: '该节点没有可应用的隔离提交' };
    if (node.isolation.status === 'applied') return { ok: true, alreadyApplied: true, commit: node.isolation.commit, cleanupPending: Boolean(node.isolation.path) };
    const iso = node.isolation;
    if (iso.status === 'applying') return { ok: false, applicationUnconfirmed: true, error: '上次隔离提交应用结果尚未确认，请先核对仓库状态' };
    const repoRoot = path.resolve(iso.repoRoot || '');
    let currentRoot = '';
    try { currentRoot = await gitExec(normalizeCwd(repoRoot), ['rev-parse', '--show-toplevel']); }
    catch (error) {
      if (error.cleanupIncomplete) return { ok: false, cleanupIncomplete: true, error: 'Git 子进程清理尚未确认，请核对仓库状态后重试' };
    }
    if (!currentRoot || path.resolve(currentRoot) !== repoRoot) return { ok: false, error: '原工作区已不可用' };
    const dirty = await gitExec(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
    if (dirty) return { ok: false, error: '当前工作区有未提交改动；为避免覆盖，请先提交或移走这些改动' };
    const previousStatus = iso.status;
    iso.status = 'applying'; iso.applyStartedAt = nowIso();
    try {
      await saveAgentRun(run);
      const recorded = JSON.parse(await fsp.readFile(agentRunFile(run.sessionId, run.id), 'utf8'));
      const recordedIsolation = recorded.nodes?.find(item => item.id === nodeId)?.isolation;
      if (recordedIsolation?.status !== 'applying' || recordedIsolation.commit !== iso.commit) throw new Error('隔离提交应用意图未持久化');
    }
    catch (error) { iso.status = previousStatus; delete iso.applyStartedAt; throw error; }
    try {
      await gitExec(repoRoot, ['cherry-pick', iso.commit], 120000);
    } catch (e) {
      if (e.cleanupIncomplete) return { ok: false, applicationUnconfirmed: true, cleanupIncomplete: true, error: '隔离提交的 Git 子进程清理尚未确认，请核对仓库状态后重试' };
      try { await gitExec(repoRoot, ['cherry-pick', '--abort'], 30000); }
      catch (error) { return { ok: false, applicationUnconfirmed: true, cleanupIncomplete: error.cleanupIncomplete === true, error: '隔离提交回退尚未确认，请先核对仓库状态' }; }
      iso.status = previousStatus; delete iso.applyStartedAt;
      await saveAgentRun(run);
      return { ok: false, error: `隔离提交无法安全应用：${e.gitStderr || e.message || e}` };
    }
    iso.status = 'applied'; iso.appliedAt = nowIso();
    try { await saveAgentRun(run); }
    catch (error) {
      iso.status = 'applying';
      throw Object.assign(error, { applied: true, commit: iso.commit, applicationUnconfirmed: true });
    }
    if (iso.path && await agentWorktreePathOwned(iso.path)) {
      try { await gitExec(repoRoot, ['worktree', 'remove', '--force', iso.path], 60000); iso.path = ''; }
      catch (error) {
        if (error.cleanupIncomplete) {
          iso.cleanupIncomplete = true;
          await saveAgentRun(run);
          return { ok: false, applied: true, commit: iso.commit, cleanupIncomplete: true, error: '隔离提交已应用，工作树清理尚未确认' };
        }
      }
    }
    await saveAgentRun(run);
    return { ok: true, commit: iso.commit };
  }
  // 这个 worktree 路径是不是如意自己的 agent-worktrees 目录底下的。先按词法比;不在的话再按 realpath 比 ——
  // 3.0 改名前起的 run 落盘的是旧前缀 ~/.win-claude-workbench/agent-worktrees/…,迁移后那是一个指回新目录的联接,
  // 只按词法比会认成「外面的目录」,于是 worktree 永远不清。
  async function agentWorktreePathOwned(p) {
    const target = path.resolve(String(p || ''));
    const root = path.resolve(worktreesDirectory);
    if (pathWithinRoot(target, root)) return true;
    try { return pathWithinRoot(await fsp.realpath(target), await fsp.realpath(root)); } catch { return false; }
  }
  async function cleanupAgentWorktree(isolation) {
    if (!isolation || !isolation.path) return;
    const worktreePath = path.resolve(isolation.path);
    if (!(await agentWorktreePathOwned(worktreePath))) return;
    try { await gitExec(path.resolve(isolation.repoRoot), ['worktree', 'remove', '--force', worktreePath], 60000); }
    catch (error) {
      if (error.cleanupIncomplete) throw error;
      try { await fsp.rm(worktreePath, { recursive: true, force: true }); } catch {}
      try { await gitExec(path.resolve(isolation.repoRoot), ['worktree', 'prune'], 30000); } catch (pruneError) { if (pruneError.cleanupIncomplete) throw pruneError; }
    }
    isolation.path = '';
    delete isolation.cleanupIncomplete;
  }

  async function cleanupAgentWorktreeForRetry(node) {
    if (node.errorClass === 'process_cleanup_incomplete' || node.isolation?.cleanupIncomplete) {
      node.status = 'failed'; node.degraded = false;
      node.errorClass = 'process_cleanup_incomplete';
      return false;
    }
    if (!node.isolation || !node.isolation.path) return true;
    try { await cleanupAgentWorktree(node.isolation); return true; }
    catch (error) {
      if (!error.cleanupIncomplete) return true;
      node.isolation.cleanupIncomplete = true;
      node.status = 'failed'; node.degraded = false;
      node.error = '隔离工作树清理尚未确认，已停止自动重试';
      node.errorClass = 'process_cleanup_incomplete';
      return false;
    }
  }

  return { gitExec, createAgentWorktree, finalizeAgentWorktree, applyAgentWorktree, cleanupAgentWorktree, cleanupAgentWorktreeForRetry };
}

module.exports = { createAgentWorktrees };
