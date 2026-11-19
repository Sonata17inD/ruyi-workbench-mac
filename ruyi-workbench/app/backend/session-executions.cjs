'use strict';
// Execution identities and bounded completion evidence belong to one server lifetime.
function createSessionExecutions({ activeChildren, turnSettlers, serverInstanceId, hooks, stopChild }) {
const sessionLastExecutions = new Map();
let sessionExecutionEvictionGeneration = 0;
function recordSessionExecutionOwner(sessionId, owner) {
  turnSettlers.set(sessionId, owner);
  sessionLastExecutions.delete(sessionId);
  sessionLastExecutions.set(sessionId, owner.driverRunId);
  while (sessionLastExecutions.size > 2048) {
    sessionLastExecutions.delete(sessionLastExecutions.keys().next().value);
    sessionExecutionEvictionGeneration += 1;
  }
}
function sessionExecutionObservation(sessionId) {
  return { serverInstanceId: serverInstanceId, lastDriverRunId: sessionLastExecutions.get(sessionId) || null, evictionGeneration: sessionExecutionEvictionGeneration };
}
function sessionExecutionSnapshot(sessionId) {
  const owner = turnSettlers.get(sessionId);
  if (!owner || !owner.driverRunId) return null;
  return { serverInstanceId: serverInstanceId, driverRunId: owner.driverRunId, phase: owner.cancelRequested ? 'stopping' : owner.phase || 'starting' };
}
function sessionExecutionCheck(sessionId, expectedExecution) {
  const execution = sessionExecutionSnapshot(sessionId);
  const owner = turnSettlers.get(sessionId) || null;
  if (expectedExecution === undefined && execution) return { ok: false, error: 'execution_identity_required', execution };
  if (expectedExecution == null && !execution) return { ok: true, owner, execution };
  if (!execution || !expectedExecution || typeof expectedExecution !== 'object'
      || expectedExecution.serverInstanceId !== execution.serverInstanceId || expectedExecution.driverRunId !== execution.driverRunId) {
    return { ok: false, error: 'execution_changed', execution };
  }
  return { ok: true, owner, execution };
}
function sessionExecutionCheckRewind(sessionId, expectedExecution) {
  if (!sessionExecutionSnapshot(sessionId) && expectedExecution && typeof expectedExecution === 'object'
      && expectedExecution.serverInstanceId === serverInstanceId && typeof expectedExecution.driverRunId === 'string'
      && sessionLastExecutions.get(sessionId) === expectedExecution.driverRunId) {
    return { ok: true, owner: null, execution: null };
  }
  return sessionExecutionCheck(sessionId, expectedExecution);
}
function assertSessionExecutionOwner(sessionId, owner) {
  if (owner && (owner.cancelRequested || turnSettlers.get(sessionId) !== owner)) {
    throw Object.assign(new Error('Execution stopped or superseded'), { code: 'STEWARD_TURN_CANCELLED' });
  }
}
function registerSessionExecutionChild(sessionId, reg, owner) {
  assertSessionExecutionOwner(sessionId, owner);
  reg.executionOwner = owner || null;
  activeChildren.set(sessionId, reg);
  // Event listeners may synchronously request cancellation when registration is announced.
  if (owner) owner.phase = 'running';
  assertSessionExecutionOwner(sessionId, owner);
}
function requestSessionExecutionStop(sessionId, expectedExecution, reason = 'stopped') {
  const checked = sessionExecutionCheck(sessionId, expectedExecution);
  if (!checked.ok) return checked;
  const owner = checked.owner;
  if (!owner || !owner.driverRunId) return { ok: true, stopped: false, queuedStopped: false, execution: null };
  const explicitStop = reason !== 'disconnected';
  const alreadyRequested = explicitStop ? owner.explicitStopRequested === true : owner.cancelRequested === true;
  if (explicitStop) owner.explicitStopRequested = true;
  // Mark first to close launch gates, then capture queue cancellation before AbortSignal listeners remove it.
  owner.cancelRequested = true; owner.phase = 'stopping';
  const queuedStopped = typeof hooks.cancelQueuedTurn === 'function'
    && hooks.cancelQueuedTurn(sessionId, owner.driverRunId) === true;
  owner.cancel(reason);
  const reg = activeChildren.get(sessionId);
  if (reg && reg.executionOwner === owner) stopChild(sessionId, reason);
  if (explicitStop && !owner.explicitStopGrantsRevoked && typeof hooks.revokeGrants === 'function') {
    hooks.revokeGrants(sessionId);
    owner.explicitStopGrantsRevoked = true;
  }
  return { ok: true, stopped: true, queuedStopped, execution: sessionExecutionSnapshot(sessionId), alreadyRequested };
}
return Object.freeze({ recordSessionExecutionOwner, sessionExecutionObservation, sessionExecutionSnapshot, sessionExecutionCheck, sessionExecutionCheckRewind, assertSessionExecutionOwner, registerSessionExecutionChild, requestSessionExecutionStop });
}
module.exports = { createSessionExecutions };
