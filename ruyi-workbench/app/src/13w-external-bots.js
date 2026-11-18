const ExternalBotCredentials = require('./backend/external-bot-credentials.cjs').createExternalBotCredentials({ DurableJsonStore, LocalSecretCrypto, fsp, paths, process });
const ExternalBotLedger = require('./backend/external-bot-ledger.cjs').createExternalBotLedger({ paths, DurableJsonStore });
const ExternalBotInbox = require('./backend/external-bot-inbox.cjs').createExternalBotInbox({
  ledger: ExternalBotLedger, ExternalBotCredentials, LocalSecretCrypto,
  runStewardTurn, OVERLAY_ID, nowIso, makeId,
});
Object.assign(ExternalBotHooks, ExternalBotInbox.lifecycle, {
  handleApiRoutes: require('./backend/external-bot-routes.cjs').createExternalBotRoutes({
    inbox: ExternalBotInbox, tokenOk, originOk,
  }),
});
