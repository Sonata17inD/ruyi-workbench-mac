'use strict';

const { apiFailure, json, send } = require('./http-protocol.cjs');
const { EXTERNAL_BOT_LIMITS, externalBotError } = require('./external-bot-ledger.cjs');
const { externalBotDecodeJson } = require('./external-bot-inbox.cjs');

const EXTERNAL_BOT_SETUP_PATHS = Object.freeze(['/api/external-bots/setup', '/api/external-bots/credentials', '/api/external-bots/discover']);

async function externalBotReadBody(req) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > EXTERNAL_BOT_LIMITS.bodyBytes) throw externalBotError('external_channel.body_too_large', 413);
  return new Promise((resolve, reject) => {
    const chunks = []; let bytes = 0;
    const cleanup = () => { clearTimeout(timer); req.removeListener('data', onData); req.removeListener('end', onEnd); req.removeListener('error', onError); req.removeListener('aborted', onAbort); };
    const fail = error => { cleanup(); req.once('error', () => {}); req.pause(); reject(error); };
    const onData = chunk => { bytes += chunk.length; if (bytes > EXTERNAL_BOT_LIMITS.bodyBytes) fail(externalBotError('external_channel.body_too_large', 413)); else chunks.push(chunk); };
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    const onError = () => fail(externalBotError('external_channel.body_invalid'));
    const onAbort = () => fail(externalBotError('external_channel.body_invalid'));
    const timer = setTimeout(() => fail(externalBotError('external_channel.read_timeout', 408)), EXTERNAL_BOT_LIMITS.readTimeoutMs);
    req.on('data', onData); req.once('end', onEnd); req.once('error', onError); req.once('aborted', onAbort);
  });
}

function createExternalBotRoutes({ inbox, tokenOk, originOk }) {
  let externalBotInflight = 0;
  let externalBotRate = { at: 0, count: 0 };

  async function externalBotSetupHttpOperation(req, res, operation) {
    if (new URL(req.url, 'http://localhost').search) throw externalBotError('external_channel.request_invalid');
    const body = externalBotDecodeJson(await externalBotReadBody(req));
    const result = await operation(body);
    inbox.wake();
    if (!res.destroyed && !res.writableEnded) send(res, json(result));
    return true;
  }
  async function handleExternalBotApiRoutes(req, res, pathname) {
    const adminPaths = ['/api/external-bots/setup', '/api/external-bots/credentials', '/api/external-bots/discover', '/api/external-bots/connections', '/api/external-bots/inbox', '/api/external-bots/inbox/read'];
    let callbackPlatform = '';
    if (req.method === 'POST' && pathname === '/api/external-bots/callback/qq') callbackPlatform = 'qq';
    if (req.method === 'POST' && pathname === '/api/external-bots/callback/feishu') callbackPlatform = 'feishu';
    if (!adminPaths.includes(pathname) && !callbackPlatform) return false;
    let admitted = false;
    try {
      const url = new URL(req.url, 'http://localhost');
      if (callbackPlatform) {
        if (req.method !== 'POST') throw externalBotError('external_channel.request_invalid', 405);
        const id = url.searchParams.get('connectionId');
        if ([...url.searchParams.keys()].length !== 1 || url.searchParams.getAll('connectionId').length !== 1 || !id || !/^[a-z][a-z0-9_-]{0,63}$/.test(id)) throw externalBotError('external_channel.connection_unavailable', 404);
        const at = Date.now();
        if (at - externalBotRate.at >= 60000) externalBotRate = { at, count: 0 };
        if (externalBotInflight >= EXTERNAL_BOT_LIMITS.inflightCallbacks || externalBotRate.count >= EXTERNAL_BOT_LIMITS.callbacksPerMinute) throw externalBotError('external_channel.rate_limited', 429);
        externalBotInflight += 1; externalBotRate.count += 1; admitted = true;
        const raw = await externalBotReadBody(req);
        const result = await inbox.acceptCallback(callbackPlatform, id, req.headers, raw);
        inbox.wake(); // Durable acceptance owns this wakeup even if the peer already lost the ACK.
        if (!res.destroyed && !res.writableEnded) send(res, json(result)); return true;
      }
      if (!tokenOk(req)) throw externalBotError('auth.token_invalid', 403);
      if (EXTERNAL_BOT_SETUP_PATHS.includes(pathname) && !originOk(req)) throw externalBotError('auth.origin_rejected', 403);
      if (req.method === 'GET' && pathname === '/api/external-bots/setup') {
        if ([...url.searchParams.keys()].some(key => key !== 'connectionId') || url.searchParams.getAll('connectionId').length !== 1) throw externalBotError('external_channel.request_invalid');
        const result = await inbox.getSetup(url.searchParams.get('connectionId'));
        send(res, json(result)); return true;
      }
      if (req.method === 'POST' && pathname === '/api/external-bots/setup') return await externalBotSetupHttpOperation(req, res, inbox.setup);
      if (req.method === 'POST' && pathname === '/api/external-bots/credentials') return await externalBotSetupHttpOperation(req, res, inbox.saveCredentials);
      if (req.method === 'POST' && pathname === '/api/external-bots/discover') {
        if (url.search) throw externalBotError('external_channel.request_invalid');
        // Discovery owns its own chaining: the probe runs outside the state lock, the optional write inside it.
        const body = externalBotDecodeJson(await externalBotReadBody(req));
        const result = await inbox.discover(body);
        if (!res.destroyed && !res.writableEnded) send(res, json(result)); return true;
      }
      if (req.method === 'GET' && pathname === '/api/external-bots/connections') {
        send(res, json(await inbox.listConnections())); return true;
      }
      if (req.method === 'POST' && pathname === '/api/external-bots/connections') {
        const body = externalBotDecodeJson(await externalBotReadBody(req));
        const result = await inbox.updateConnection(body);
        inbox.wake();
        if (!res.destroyed && !res.writableEnded) send(res, json(result)); return true;
      }
      if (req.method === 'GET' && pathname === '/api/external-bots/inbox') {
        const result = await inbox.listInbox({ limit: url.searchParams.get('limit'),
          connectionId: url.searchParams.get('connectionId'), before: url.searchParams.get('before') });
        send(res, json(result)); return true;
      }
      if (req.method === 'POST' && pathname === '/api/external-bots/inbox/read') {
        const body = externalBotDecodeJson(await externalBotReadBody(req));
        const result = await inbox.markRead(body.id);
        send(res, json(result)); return true;
      }
      throw externalBotError('external_channel.request_invalid', 405);
    } catch (error) {
      const code = typeof error?.apiCode === 'string' && /^(external_channel\.|external_credentials\.|external_discovery\.|auth\.)[a-z_]+$/.test(error.apiCode) ? error.apiCode : 'external_channel.storage_unavailable';
      res.setHeader('connection', 'close');
      if (!req.complete) res.once('finish', () => req.destroy());
      send(res, apiFailure(code, {}, code, error?.statusCode || 503)); return true;
    } finally {
      if (admitted) externalBotInflight -= 1;
    }
  }
  return handleExternalBotApiRoutes;
}

module.exports = { createExternalBotRoutes };
