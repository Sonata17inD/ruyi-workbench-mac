// SSE transport owns subscriptions, clients and heartbeat lifetime.
const EventStreamService = require('./backend/event-stream.cjs').createEventStream({
  apiFailure,
  EventStreamHooks,
  nowIso,
  OVERLAY_ID,
  RUYI_EVENTS,
  URL,
  safeSessionId,
  send,
  readMissionSessionHead,
  sessionDisplayTitle,
  sessionMissionId,
  activeChildren,
  subscribeActiveChildEvents,
  STEWARD_SESSION_ID,
  stewardThreadStateFromHead,
  stewardWatchedThread,
  threadOriginOf,
  missionPendingCounts
});
const { eventStreamEmitThreadState, eventStreamRing } = EventStreamService;
