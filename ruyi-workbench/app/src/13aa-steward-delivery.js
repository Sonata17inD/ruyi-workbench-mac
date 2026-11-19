const {
  stewardCaptureDelivery, stewardDeliveryFiles, stewardDeliveryInspect, stewardDeliveryProjection,
  stewardValidateDeliveryReference,
} = require('./backend/steward-delivery-evidence.cjs').createStewardDeliveryEvidence({
  files: {
    ensureDataRootReal, fileAllowedRoots, isSensitiveDataPath, isSensitiveHardlinkAlias, kindForPath,
    pathWithinAnyRoot, remoteUncDenialResolved,
  },
  sessions: {
    loadSession, readMissionContainer, sessionDisplayTitle, sessionExecutionSnapshot, sessionMissionId,
    stewardRawKind,
  },
  evidence: { buildMissionAcceptanceProjection, nowIso, readConfig, stewardFail },
});

DeliveryHooks.capture = stewardCaptureDelivery;
StewardHooks.deliveryProjection = stewardDeliveryProjection;
StewardHooks.validateDeliveryReference = stewardValidateDeliveryReference;
