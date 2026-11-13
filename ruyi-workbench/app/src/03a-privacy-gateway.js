// Privacy model boundary; state and dependencies are private to this host.
const PrivacyGateway = require('./backend/privacy-gateway.cjs').createPrivacyGateway({ core: PrivacyCore, PrivacyRegex });

PrivacyCore.configHooks.configurePrivacy = PrivacyGateway.configure;
PrivacyCore.configHooks.assertCliAllowed = PrivacyGateway.assertCliAllowed;
PrivacyCore.configHooks.markPrivacyUnavailable = PrivacyGateway.markUnavailable;
