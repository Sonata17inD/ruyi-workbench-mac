// 81: This administration surface requires the workbench token, including loopback clients.
PrivacyGateway.setHost({ paths, isRegisteredTool: name => Object.prototype.hasOwnProperty.call(TOOL_HANDLERS, name) || Boolean(nativeToolSchema(name)), normalizeToolInvokeArgs: args => normalizeToolInvokeArgs(args), makeStore: (file, key) => DurableJsonStore.create({
  id: 'privacy-mapping-' + key, file, schemaKey: 'version', schemaVersion: 1, cache: false, strictRead: true, quarantine: false,
  defaultValue: () => ({}), validate: value => value.version === 1 && typeof value.instanceId === 'string' && !!value.envelope,
}) });
PrivacyCore.configHooks.isBusy = () => activeChildren.size > 0 || turnSettlers.size > 0;
const PrivacySettings = require('./backend/privacy-settings-service.cjs').createPrivacySettings({
  configHooks: PrivacyCore.configHooks, PrivacyGateway, PrivacyRegex, LocalSecretCrypto,
  turnSettlers, readConfig, mutateConfig, sessionEngineRouteFromConfig, stewardAppendDecision,
});
Object.assign(PrivacyCore.configHooks, {
  stewardPrivacy: PrivacySettings.administer,
  settleStewardPrivacy: PrivacySettings.settle,
  handleApiRoutes: require('./backend/privacy-routes.cjs').createPrivacyRoutes({
    configHooks: PrivacyCore.configHooks, PrivacySettings, PrivacyGateway, PrivacyRegex, PrivacyRuleCatalog, LocalSecretCrypto,
    readConfig,
  }),
});
