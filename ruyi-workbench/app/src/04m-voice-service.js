// Compose voice, auxiliary correction, and lexicon persistence below tool dispatch.
const {
  asrFixMessages, asrFixModeOf, asrFixSanity, providerFixCompletion,
  resolveAsrFixProvider, resolveAsrProvider, resolveAsrStreamProvider, transcribeAudioViaProvider,
  voiceLexiconAsrPromptFor, voiceLexiconRead, voiceLexiconUpdate,
} = require('./backend/voice-service.cjs').createVoiceService({
  dataDirectory: paths.data, DurableJsonStore, appendUsageLedger, readConfig, logEvent, PrivacyGateway, ToolboxHooks,
  providerBaseWithV1, providerPostJsonOnce, providerWireProtocol,
});
