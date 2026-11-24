'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');

const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const TOKEN_URL = ISSUER + '/api/accounts/oauth/token';
const NEW_CLIENT = 'dynamic_agent_client';
const random = () => crypto.randomBytes(32).toString('base64url');

function createCodexAccount({
  directory,
  atomicWriteJson,
  protector,
  onAccountChanged = () => {},
  fetch = globalThis.fetch,
}) {
  const file = path.join(directory, 'chatgpt-accounts.json');
  let queue = Promise.resolve();
  let revision = 0;
  let sessionAccess;
  let pending,
    lastError = '',
    catalog = [];
  function exclusive(operation) {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  }
  async function read() {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      return { accounts: [], active: '', host: '' };
    }
  }
  async function write(state) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await atomicWriteJson(file, state, { mode: 0o600, exclusiveTemp: true });
  }
  async function request(url, options) {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'error', ...options });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const code = String(body.error?.code || (typeof body.error === 'string' ? body.error : '')).slice(0, 120);
      throw Object.assign(new Error(['ChatGPT HTTP', res.status, code].filter(Boolean).join(' ')), { code });
    }
    return res;
  }
  const post = (url, values) => request(url, { method: 'POST', body: new URLSearchParams(values) });
  const metadata = async () => (await request(ISSUER + '/.well-known/openid-configuration')).json();
  async function identity(jwt, client, nonce) {
    const [header, payload, signature] = jwt.split('.');
    const decode = (part) => JSON.parse(Buffer.from(part, 'base64url'));
    const { alg, kid } = decode(header);
    const discovery = await metadata();
    const { keys } = await (await request(discovery.jwks_uri)).json();
    const jwk = keys.find((k) => k.kid === kid && k.kty === 'RSA');
    if (
      alg !== 'RS256' ||
      !jwk ||
      !crypto.verify(
        'RSA-SHA256',
        Buffer.from(header + '.' + payload),
        crypto.createPublicKey({ key: jwk, format: 'jwk' }),
        Buffer.from(signature, 'base64url'),
      )
    )
      throw new Error('ChatGPT identity signature invalid');
    const claims = decode(payload);
    if (
      claims.iss !== ISSUER ||
      ![claims.aud].flat().includes(client) ||
      !(claims.exp > Date.now() / 1000) ||
      claims.nonce !== nonce ||
      !claims.sub
    )
      throw new Error('ChatGPT identity validation failed');
    return claims;
  }
  const context = (id) => Buffer.from('ruyi.chatgpt:' + id);
  async function seal(id, tokens, options) {
    const cipher = await protector.run('protect', Buffer.from(JSON.stringify(tokens)), context(id), options);
    return cipher.toString('base64');
  }
  async function unseal(account, options) {
    return JSON.parse(await protector.run('unprotect', Buffer.from(account.secret, 'base64'), context(account.id), options));
  }
  function rememberAccess(account, tokens) {
    sessionAccess = { id: account.id, secret: account.secret, token: tokens.access_token, expires: tokens.expires };
    return { id: account.id, token: sessionAccess.token };
  }
  function statusOf(s) {
    return {
      active: s.active,
      pending: Boolean(pending),
      error: lastError,
      accounts: s.accounts.map(({ id, label, plan, secret }) => ({ id, label, plan, signedIn: Boolean(secret) })),
    };
  }
  function cancel() {
    if (pending) {
      clearTimeout(pending.timer);
      pending.server.close();
      pending = null;
    }
  }
  async function login(id = '') {
    return exclusive(async () => {
      cancel();
      lastError = '';
      const s = await read();
      const prior = s.accounts.find((a) => a.id === id);
      if (id && !prior) throw new Error('Unknown ChatGPT registration');
      if (!s.host) {
        s.host = 'urn:uuid:' + crypto.randomUUID();
        await write(s);
      }
      const verifier = random(),
        nonce = random(),
        state = random();
      let redirect;
      const server = http.createServer(async (req, res) => {
        const u = new URL(req.url, 'http://127.0.0.1');
        if (
          req.method !== 'GET' ||
          u.pathname !== '/auth/callback' ||
          u.searchParams.get('state') !== state ||
          pending?.server !== server
        ) {
          res.writeHead(400).end();
          return;
        }
        cancel();
        try {
          await exclusive(async () => {
            if (u.searchParams.has('error')) throw new Error('ChatGPT authorization declined');
            const client = u.searchParams.get('client_id') || prior?.id;
            const code = u.searchParams.get('code');
            if (!code || !client || client === NEW_CLIENT || (prior && prior.id !== client))
              throw new Error('Incomplete ChatGPT registration');
            const tokens = await (
              await post(TOKEN_URL, {
                grant_type: 'authorization_code',
                code,
                redirect_uri: redirect,
                code_verifier: verifier,
                resource: RESOURCE,
                client_id: client,
              })
            ).json();
            const claims = await identity(tokens.id_token, client, nonce);
            const current = await read();
            const old = current.accounts.find((a) => a.id === client);
            if (old && old.subject !== claims.sub) throw new Error('ChatGPT account changed');
            const credentials = {
              access_token: tokens.access_token,
              refresh_token: tokens.refresh_token,
              scope: tokens.scope,
              expires: Date.now() + tokens.expires_in * 1000,
            };
            const account = {
              id: client,
              subject: claims.sub,
              label: claims.email || claims.sub,
              plan: String(tokens.scope || '')
                .split(' ')
                .includes(PLAN_SCOPE),
              secret: await seal(client, credentials, { allowKeychainPrompt: true }),
            };
            current.accounts = [...current.accounts.filter((a) => a.id !== client), account];
            const switched = current.active !== client;
            current.active = client;
            await write(current);
            if (switched || !account.plan) invalidateAccount();
            else catalog = [];
            if (account.plan) rememberAccess(account, credentials);
          });
          res
            .writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
            .end('ChatGPT connected. Return to Ruyi. 已连接，请返回如意。');
        } catch (error) {
          let guidance;
          if (['local_crypto.permission_denied', 'local_crypto.permission_required', 'local_crypto.process_timeout'].includes(error.code)) {
            guidance = 'Keychain access is needed to save this sign-in. Retry and choose Always Allow for ruyi-keychain-helper.\n'
              + '如意需要钥匙串权限才能保存登录。请重试，并在 macOS 提示中为 ruyi-keychain-helper 选择「始终允许」。';
          } else if (error.code === 'local_crypto.keychain_locked') {
            guidance = 'Unlock your login keychain, then retry.\n请先解锁 macOS 登录钥匙串，再重新登录。';
          }
          lastError = guidance || error.message;
          res
            .writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
            .end(guidance || 'Sign-in failed. See Ruyi settings. 登录失败，请查看如意设置。');
        }
      });
      await new Promise((ok, fail) => {
        server.once('error', fail);
        server.listen(0, '127.0.0.1', ok).unref();
      });
      redirect = 'http://127.0.0.1:' + server.address().port + '/auth/callback';
      pending = {
        server,
        timer: setTimeout(() => {
          lastError = 'Sign-in expired. Please try again.';
          cancel();
        }, 300000).unref(),
      };
      const query = new URLSearchParams({
        client_id: prior?.id || NEW_CLIENT,
        ext_agent_host_id: s.host,
        response_type: 'code',
        redirect_uri: redirect,
        scope: 'openid profile email offline_access resource.invoke ' + PLAN_SCOPE,
        resource: RESOURCE,
        state,
        nonce,
        code_challenge_method: 'S256',
        code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
      });
      if (!prior) query.set('agent_name_hint', 'Ruyi');
      return ISSUER + '/api/accounts/authorize?' + query;
    });
  }
  async function access(options) {
    return exclusive(async () => {
      const state = await read();
      const account = state.accounts.find((entry) => entry.id === state.active);
      if (!account?.secret || !account.plan) throw new Error('请在「设置 → Agent CLI」连接 ChatGPT 并授权套餐用量。');
      if (sessionAccess?.id === account.id && sessionAccess.secret === account.secret && sessionAccess.expires > Date.now() + 60000)
        return { id: account.id, token: sessionAccess.token };
      // A rotating refresh token must be sealed using the same Keychain grant that opened it.
      return protector.run('unprotect', Buffer.from(account.secret, 'base64'), context(account.id), options, async (plain, reseal) => {
        let tokens = JSON.parse(plain);
        if (tokens.expires < Date.now() + 60000) {
          let next;
          try {
            next = await (
              await post(TOKEN_URL, {
                grant_type: 'refresh_token',
                client_id: account.id,
                refresh_token: tokens.refresh_token,
                resource: RESOURCE,
              })
            ).json();
          } catch (error) {
            if (error.code !== 'invalid_grant') throw error;
            lastError = 'ChatGPT authorization expired. Please sign in again.';
            await disconnectAccount(state, account);
            throw new Error(lastError);
          }
          tokens = { ...tokens, ...next, expires: Date.now() + next.expires_in * 1000 };
          account.plan = tokens.scope.split(' ').includes(PLAN_SCOPE);
          account.secret = reseal(Buffer.from(JSON.stringify(tokens))).toString('base64');
          await write(state);
          if (!account.plan) {
            invalidateAccount();
            throw new Error('ChatGPT plan access was revoked');
          }
        }
        return rememberAccess(account, tokens);
      });
    });
  }
  function invalidateAccount() {
    sessionAccess = undefined;
    catalog = [];
    revision++;
    onAccountChanged();
  }
  async function disconnectAccount(state, account) {
    delete account.secret;
    account.plan = false;
    state.active = '';
    await write(state);
    invalidateAccount();
  }
  async function logout() {
    return exclusive(async () => {
      cancel();
      const state = await read();
      const account = state.accounts.find((entry) => entry.id === state.active);
      if (!account?.secret) return;
      const tokens = await unseal(account, { allowKeychainPrompt: true });
      lastError = '';
      try {
        await post((await metadata()).revocation_endpoint, {
          token: tokens.refresh_token || tokens.access_token,
          token_type_hint: tokens.refresh_token ? 'refresh_token' : 'access_token',
          client_id: account.id,
        });
      } catch {
        lastError = 'Remote revocation unconfirmed. Check ChatGPT Settings → Usage.';
      }
      await disconnectAccount(state, account);
    });
  }
  async function models(credentials) {
    const { id, token } = credentials || (await access());
    const data = await (await request(RESOURCE + '/models', { headers: { Authorization: 'Bearer ' + token } })).json();
    const models = data.models
      .filter((m) => m.visibility === 'list')
      .map((m) => ({ id: m.slug, label: m.display_name || m.slug }));
    if ((await read()).active !== id) throw new Error('ChatGPT account changed');
    catalog = models;
    return models;
  }
  return {
    get revision() {
      return revision;
    },
    login,
    logout,
    access,
    models,
    cachedModels: () => catalog,
    cancel,
    status: () => exclusive(async () => statusOf(await read())),
  };
}

function createCodexAccountRoutes(account) {
  const { json, readJsonBody, send } = require('./http-protocol.cjs');
  const openBrowser = require('node:util').promisify(require('node:child_process').execFile);
  async function handleCodexApiRoutes(req, res, pathname) {
    if (req.method === 'GET' && pathname === '/api/codex/models')
      return send(res, json({ ok: true, agentCliType: 'codex', models: await account.models() }));
    if (req.method === 'POST' && pathname === '/api/codex/unlock') {
      await account.access({ allowKeychainPrompt: true });
      return send(res, json({ ok: true }));
    }
    if (req.method === 'GET' && pathname === '/api/codex/account') return send(res, json(await account.status()));
    if (req.method === 'POST' && pathname === '/api/codex/login') {
      const { id } = await readJsonBody(req);
      const url = await account.login(id);
      try {
        await openBrowser('/usr/bin/open', [url]);
      } catch (error) {
        account.cancel();
        throw error;
      }
      return send(res, json({ ok: true }));
    }
    if (req.method === 'POST' && pathname === '/api/codex/logout') {
      await account.logout();
      return send(res, json(await account.status()));
    }
  }
  return handleCodexApiRoutes;
}
module.exports = { createCodexAccount, createCodexAccountRoutes };
