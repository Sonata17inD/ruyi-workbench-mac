// Mac credential protection. Unknown legacy ciphertext remains opaque and fails without mutation.
const LocalSecretCryptoHooks = { helperPath: () => require('node:path').resolve(__dirname, '..', 'runtime', 'macos', 'ruyi-keychain-helper') };
const LocalSecretCrypto = (() => {
  const childProcess = require('node:child_process');
  const cryptoApi = require('node:crypto');
  const MAC_MAGIC = Buffer.from('ruyi.keychain.v1\0');
  const MAC_PROVIDER = 'macos-keychain';
  const MAC_ERRORS = Object.freeze(['dependency_missing', 'permission_required', 'permission_denied', 'keychain_locked', 'keychain_unavailable', 'keychain_corrupt', 'key_missing', 'key_changed', 'provider_mismatch']);
  let macInFlight = 0;
  const LIMIT = Object.freeze({ processMs: 15000, outputBytes: 131072, cipherBytes: 65536 });
  const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
  const base64 = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max * 2 && value.length % 4 === 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) && Buffer.from(value, 'base64').length <= max && Buffer.from(value, 'base64').toString('base64') === value;


  const failure = suffix => Object.assign(new Error('local_crypto.' + suffix), { code: 'local_crypto.' + suffix, apiCode: 'local_crypto.' + suffix, statusCode: suffix === 'unsupported' ? 501 : 503 });
  function keychainKey(create) {
    if (macInFlight >= 4) return Promise.reject(failure('process_busy'));
    macInFlight++;
    return new Promise((resolve, reject) => {
      let child, complete = false, size = 0;
      const output = [];
      const finish = (suffix, key) => {
        if (complete) return;
        complete = true; clearTimeout(timer); macInFlight--;
        for (const chunk of output) chunk.fill(0);
        if (suffix) reject(failure(suffix)); else resolve(key);
      };
      // This native leaf never starts subprocesses. Killing it cannot leave a secret-bearing descendant.
      const stop = suffix => { finish(suffix); if (child) child.kill(); };
      const timer = setTimeout(() => stop('process_timeout'), LIMIT.processMs);
      try {
        child = childProcess.spawn(LocalSecretCryptoHooks.helperPath(), [], { stdio: ['pipe', 'pipe', 'ignore'], env: {} });
        child.once('error', error => finish(error.code === 'ENOENT' ? 'dependency_missing' : 'process_failed'));
        child.stdin.on('error', () => stop('process_failed'));
        child.stdout.on('error', () => stop('process_failed'));
        child.stdout.on('data', chunk => {
          size += chunk.length;
          if (complete || size > 4096) { chunk.fill(0); if (!complete) stop('process_capacity'); return; }
          output.push(chunk);
        });
        child.once('close', code => {
          if (complete) return;
          const bytes = Buffer.concat(output);
          let response;
          try { response = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
          catch { finish('process_failed'); return; }
          finally { bytes.fill(0); }
          if (!exact(response, ['ok', 'value', 'error'])) { finish('process_failed'); return; }
          if (code !== 0 || response.ok !== true) {
            finish(exact(response, ['ok', 'error']) && MAC_ERRORS.includes(response.error) ? response.error : 'process_failed'); return;
          }
          if (!exact(response, ['ok', 'value']) || !base64(response.value, 32) || Buffer.from(response.value, 'base64').length !== 32) { finish('process_failed'); return; }
          finish(null, Buffer.from(response.value, 'base64'));
        });
        child.stdin.end(JSON.stringify({ version: 1, op: create ? 'get-or-create' : 'get' }));
      } catch { stop('process_failed'); }
    });
  }
  async function runMac(op, value, entropy) {
    if (!['protect', 'unprotect'].includes(op) || !Buffer.isBuffer(value) || !value.length || value.length > (op === 'protect' ? 65536 : 98304)
      || !Buffer.isBuffer(entropy) || entropy.length > 4096) throw failure('input_invalid');
    let envelope;
    if (op === 'unprotect') {
      if (!value.subarray(0, MAC_MAGIC.length).equals(MAC_MAGIC)) throw failure('provider_mismatch');
      try { envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value.subarray(MAC_MAGIC.length))); }
      catch { throw failure('decrypt_failed'); }
      if (!exact(envelope, ['schemaVersion', 'provider', 'keyId', 'nonce', 'ciphertext', 'tag']) || envelope.schemaVersion !== 1 || envelope.provider !== MAC_PROVIDER
        || !/^[a-f0-9]{64}$/.test(envelope.keyId) || !base64(envelope.nonce, 12) || Buffer.from(envelope.nonce, 'base64').length !== 12
        || !base64(envelope.tag, 16) || Buffer.from(envelope.tag, 'base64').length !== 16 || !base64(envelope.ciphertext, 65536)) throw failure('decrypt_failed');
    }
    const key = await keychainKey(op === 'protect');
    try {
      const keyId = cryptoApi.createHash('sha256').update(key).digest('hex');
      const aad = Buffer.concat([MAC_MAGIC, Buffer.from(JSON.stringify([1, MAC_PROVIDER, keyId])), entropy]);
      if (op === 'protect') {
        const nonce = cryptoApi.randomBytes(12), cipher = cryptoApi.createCipheriv('aes-256-gcm', key, nonce);
        cipher.setAAD(aad);
        return Buffer.concat([MAC_MAGIC, Buffer.from(JSON.stringify({ schemaVersion: 1, provider: MAC_PROVIDER, keyId, nonce: nonce.toString('base64'),
          ciphertext: Buffer.concat([cipher.update(value), cipher.final()]).toString('base64'), tag: cipher.getAuthTag().toString('base64') }))]);
      }
      if (envelope.keyId !== keyId) throw failure('key_changed');
      const decipher = cryptoApi.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64'));
      decipher.setAAD(aad); decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      try { return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]); }
      catch { throw failure('decrypt_failed'); }
    } finally { key.fill(0); }
  }
  function run(op, value, entropy) {
    if (process.platform === 'darwin') return runMac(op, value, entropy);
    if (op === 'unprotect' && Buffer.isBuffer(value) && value.subarray(0, MAC_MAGIC.length).equals(MAC_MAGIC)) return Promise.reject(failure('provider_mismatch'));
    return Promise.reject(failure('unsupported'));
  }
  return Object.freeze({ run, supported: () => process.platform === 'darwin', MAC_ERRORS });
})();
