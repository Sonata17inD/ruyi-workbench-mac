// 81-P1: Immutable encrypted credential records; config holds typed references, never vault plaintext.
const { CredentialVault } = require('./backend/credential-vault.cjs');

Object.assign(PrivacyCore.configHooks, CredentialVault.create({
  core: PrivacyCore, protector: LocalSecretCrypto,
  store: DurableJsonStore.create({ id: 'credential-vault-v1', file: () => path.join(paths.data, 'credential-vault-v1.json'), schemaVersion: 1,
    defaultValue: CredentialVault.empty, cache: false, strictRead: true, quarantine: false, validate: CredentialVault.validate }),
  size: async () => { try { return (await fsp.stat(path.join(paths.data, 'credential-vault-v1.json'))).size; } catch (error) { if (error.code === 'ENOENT') return 0; throw error; } },
  stamp: async () => {
    try { const stat = await fsp.stat(path.join(paths.data, 'credential-vault-v1.json'), { bigint: true }); return `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}`; }
    catch (error) { if (error.code === 'ENOENT') return 'absent'; throw error; }
  },
  backups: {
    list: async () => (await fsp.readdir(paths.data)).filter(name => /^config\.json\.(?:prev|corrupt|bak[^/\\]*)$/.test(name)),
    read: async name => {
      const file = path.join(paths.data, name), stat = await fsp.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > CredentialVault.MAX.bytes) throw new Error('backup unavailable');
      return fsp.readFile(file, 'utf8');
    },
    write: (name, serialized) => atomicWriteJson(path.join(paths.data, name), serialized, { mode: 0o600 }),
  },
}));
