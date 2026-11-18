const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { constBlock } = require('./source-slice');
const read = name => fs.readFileSync(path.join(__dirname, '../../ruyi-workbench/app/src', name), 'utf8');
const primitives = require('./privacy-primitives').createPrivacyPrimitives();
const clone = value => structuredClone(value);
function fixture() {
  let state = primitives.CredentialVault.empty(), serial = 0;
  const host = { core: primitives.PrivacyCore, size: async () => Buffer.byteLength(JSON.stringify(state)), supportedDefault: () => true,
    store: { read: async () => clone(state), write: async value => { state = clone(value); serial++; }, invalidate() {} },
    protector: { supported: () => true, run: async (op, value) => Buffer.from(value) },
    stamp: async () => String(serial) };
  return { ...primitives, vault: primitives.CredentialVault.create(host), restartVault: () => primitives.CredentialVault.create(host), state: () => clone(state) };
}
function gateway(root, f) {
  const service = require('../../ruyi-workbench/app/backend/privacy-gateway.cjs').createPrivacyGateway({
    PrivacyRegex: f.PrivacyRegex, core: { ...f.PrivacyCore, configHooks: { sealLocal: f.vault.sealLocal, openLocal: f.vault.openLocal } },
  });
  service.setHost({ paths: { data: root }, makeStore: file => ({ read: async () => JSON.parse(await fs.promises.readFile(file, 'utf8')), write: async value => fs.promises.writeFile(file, JSON.stringify(value)) }) });
  return service;
}

function loadWithProviderStream(load, createStream) {
  const providerStream = require('../../ruyi-workbench/app/backend/provider-stream.cjs');
  const original = providerStream.createProviderStream;
  providerStream.createProviderStream = ({ PrivacyGateway }) => createStream(PrivacyGateway);
  try { return load(); }
  finally { providerStream.createProviderStream = original; }
}

module.exports = { fixture, gateway, clone, loadWithProviderStream };
