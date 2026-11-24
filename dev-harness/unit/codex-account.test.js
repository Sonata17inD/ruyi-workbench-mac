'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createCodexAccount } = require('../../ruyi-workbench/app/backend/codex-account.cjs');
const { createAtomicFileStore } = require('../../ruyi-workbench/app/backend/file-persistence.cjs');

test('ChatGPT registration, loopback callback, model discovery, renewal and revocation', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ruyi-chatgpt-account-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const issuer = 'https://auth.openai.com';
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test' };
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const { atomicWriteJson } = createAtomicFileStore({ paths: {}, process });
  let query,
    refreshes = 0,
    revocations = 0,
    client = 'oaiapp_test',
    grant = true;
  let nonceMismatch = false;
  let denyKeychain = false;
  let lifetime = 3600;
  const promptRequests = [];
  function jwt() {
    const input =
      encode({ alg: 'RS256', kid: 'test' }) +
      '.' +
      encode({
        sub: 'user1',
        email: 'fixture@example.invalid',
        iss: issuer,
        aud: client,
        nonce: nonceMismatch ? 'invalid' : query.get('nonce'),
        exp: Date.now() / 1000 + 60,
      });
    return input + '.' + crypto.sign('sha256', Buffer.from(input), privateKey).toString('base64url');
  }
  const options = {
    directory,
    atomicWriteJson,
    protector: {
      async run(op, bytes, _context, options, usePlaintext) {
        promptRequests.push([op, options?.allowKeychainPrompt === true]);
        if (denyKeychain === true || (denyKeychain === 'silent' && !options?.allowKeychainPrompt))
          throw Object.assign(new Error('local_crypto.permission_denied'), { code: 'local_crypto.permission_denied' });
        const transform = value => Buffer.from(value).reverse();
        return usePlaintext ? usePlaintext(transform(bytes), transform) : transform(bytes);
      },
    },
    async fetch(url, opts) {
      if (url.endsWith('openid-configuration'))
        return Response.json({ jwks_uri: issuer + '/keys', revocation_endpoint: issuer + '/revoke' });
      if (url.endsWith('/keys')) return Response.json({ keys: [jwk] });
      if (url.endsWith('/models')) {
        assert.equal(opts.headers.Authorization, 'Bearer renewed');
        return Response.json({
          models: [
            { slug: 'visible', display_name: 'Visible', visibility: 'list' },
            { slug: 'hidden', visibility: 'hide' },
          ],
        });
      }
      if (url.endsWith('/revoke')) {
        assert.equal(opts.body.get('token'), 'rotated');
        revocations++;
        return new Response();
      }
      assert.equal(url, issuer + '/api/accounts/oauth/token');
      assert.equal(opts.body.get('client_id'), client);
      if (opts.body.get('grant_type') === 'refresh_token') {
        refreshes++;
        assert.equal(opts.body.get('refresh_token'), 'original');
        return Response.json({ access_token: 'renewed', refresh_token: 'rotated', expires_in: 3600 });
      }
      assert.equal(opts.body.get('redirect_uri'), query.get('redirect_uri'));
      assert.equal(
        crypto.createHash('sha256').update(opts.body.get('code_verifier')).digest('base64url'),
        query.get('code_challenge'),
      );
      return Response.json({
        access_token: 'first',
        refresh_token: 'original',
        scope: grant ? 'chatgpt.tokens.use.direct' : 'openid',
        id_token: jwt(),
        expires_in: lifetime,
      });
    },
  };
  const service = createCodexAccount(options);
  t.after(service.cancel);
  async function signIn(id, expectedStatus = 200) {
    query = new URL(await service.login(id)).searchParams;
    const callback = new URL(query.get('redirect_uri'));
    callback.search = new URLSearchParams({ state: 'wrong', code: 'test-code', client_id: client });
    assert.equal((await fetch(callback)).status, 400);
    callback.searchParams.set('state', query.get('state'));
    const response = await fetch(callback);
    assert.equal(response.status, expectedStatus);
    return response.text();
  }
  nonceMismatch = true;
  await signIn(undefined, 400);
  assert.equal((await service.status()).accounts.length, 0);
  nonceMismatch = false;
  denyKeychain = true;
  assert.match(await signIn(undefined, 400), /ruyi-keychain-helper/);
  assert.match((await service.status()).error, /钥匙串/);
  assert.equal((await service.status()).accounts.length, 0);
  denyKeychain = false;
  await signIn();
  assert.deepEqual(promptRequests.splice(0), [['protect', true], ['protect', true]]);
  denyKeychain = 'silent';
  assert.deepEqual(await service.access(), { id: client, token: 'first' });
  assert.deepEqual(promptRequests, []);
  assert.equal(query.get('client_id'), 'dynamic_agent_client');
  const host = query.get('ext_agent_host_id');
  lifetime = 1;
  await signIn(client);
  promptRequests.length = 0;
  const restarted = createCodexAccount(options);
  await assert.rejects(restarted.access(), /local_crypto.permission_denied/);
  assert.deepEqual(
    await Promise.all([restarted.access({ allowKeychainPrompt: true }), restarted.access()]),
    Array(2).fill({ id: client, token: 'renewed' }),
  );
  assert.equal(refreshes, 1);
  assert.deepEqual(promptRequests.splice(0), [['unprotect', false], ['unprotect', true]]);
  assert.deepEqual(await restarted.models(), [{ id: 'visible', label: 'Visible' }]);
  assert.equal((await restarted.status()).accounts[0].signedIn, true);
  const file = path.join(directory, 'chatgpt-accounts.json');
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.doesNotMatch(await fs.readFile(file, 'utf8'), /original|renewed|rotated/);
  await restarted.logout();
  assert.equal(revocations, 1);
  assert.deepEqual(restarted.cachedModels(), []);
  await assert.rejects(restarted.access(), /ChatGPT/);
  grant = false;
  await signIn(client);
  assert.equal(query.get('client_id'), client);
  assert.equal(query.get('ext_agent_host_id'), host);
  assert.equal((await service.status()).accounts[0].plan, false);
  await assert.rejects(service.access(), /ChatGPT/);
});
