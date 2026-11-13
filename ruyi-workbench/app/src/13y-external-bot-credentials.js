// Explicit credential service dependencies.
const ExternalBotCredentials = require('./backend/external-bot-credentials.cjs').createExternalBotCredentials({ DurableJsonStore, LocalSecretCrypto, fsp, paths, runKeyedChain, process });
