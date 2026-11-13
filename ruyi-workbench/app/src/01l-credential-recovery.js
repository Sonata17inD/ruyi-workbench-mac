// 81-P1: Import appends immutable vault records before a journaled config switch.
// An interrupted switch rolls back config on the next read; old encrypted records remain usable.
const { CredentialRecovery } = require('./backend/credential-recovery.cjs');

const credentialRecoveryJournal = DurableJsonStore.create({
  id: 'credential-import-v1', file: () => path.join(paths.data, 'credential-import-v1.json'), schemaKey: 'version', schemaVersion: 1,
  cache: false, strictRead: true, quarantine: false, defaultValue: () => null,
  validate: value => value.version === 1 && typeof value.instanceId === 'string' && !!value.envelope,
});
Object.assign(PrivacyCore.configHooks, CredentialRecovery.create({
  committed: configEmitWritten, vault: { ...PrivacyCore.configHooks }, normalize: normalizeConfig, readConfig, mutate: mutateConfig,
  busy: () => typeof PrivacyCore.configHooks.isBusy === 'function' && PrivacyCore.configHooks.isBusy(),
  readConfigFile: () => fsp.readFile(paths.config, 'utf8'),
  writeConfigFile: value => atomicWriteJson(paths.config, value, { mode: 0o600 }),
  readJournal: async () => {
    try { const file = path.join(paths.data, 'credential-import-v1.json'), stat = await fsp.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error('credential_recovery.journal_invalid');
      return credentialRecoveryJournal.read(); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  },
  writeJournal: value => credentialRecoveryJournal.write(value),
  removeJournal: () => fsp.unlink(path.join(paths.data, 'credential-import-v1.json')).catch(error => { if (error.code !== 'ENOENT') throw error; }),
  invalidate: () => { configReadCache = null; lastGoodConfig = null; },
}));
