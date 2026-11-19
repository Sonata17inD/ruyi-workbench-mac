'use strict';
// Fresh mutable scope/config hooks per fixture; no production host or user data is loaded.
const { createPrivacyCore } = require('../../ruyi-workbench/app/backend/privacy-core.cjs');
const { createPrivacyRegex } = require('../../ruyi-workbench/app/backend/privacy-regex.cjs');
const { PrivacyRuleCatalog } = require('../../ruyi-workbench/app/backend/privacy-rule-catalog.cjs');
const { CredentialVault } = require('../../ruyi-workbench/app/backend/credential-vault.cjs');
const { CredentialRecovery } = require('../../ruyi-workbench/app/backend/credential-recovery.cjs');
function createPrivacyPrimitives() {
  const PrivacyCore = createPrivacyCore();
  return { PrivacyCore, PrivacyRegex: createPrivacyRegex({ core: PrivacyCore }), PrivacyRuleCatalog, CredentialVault, CredentialRecovery };
}
module.exports = { createPrivacyPrimitives };
