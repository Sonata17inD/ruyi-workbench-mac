'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHttpAuthorization } = require('../../ruyi-workbench/app/backend/http-authorization.cjs');
const { ROUTE_AUTH } = require('../../ruyi-workbench/app/backend/http-route-policy.cjs');
const request = (headers = {}, remoteAddress = '127.0.0.1') => ({ headers: { host: '127.0.0.1:8765', ...headers }, socket: { remoteAddress } });
test('listener identity stays instance-local and credential rotation takes effect immediately', () => {
  const runtime = { port: 8765, token: 'first' };
  const a = createHttpAuthorization(runtime), b = createHttpAuthorization({ port: 9999, token: 'second' });
  assert.equal(a.hostAllowed(request()), true); assert.equal(b.hostAllowed(request()), false);
  assert.equal(a.tokenMatches('first'), true); assert.equal(b.tokenMatches('first'), false);
  runtime.token = 'rotated';
  assert.equal(a.tokenMatches('first'), false); assert.equal(a.tokenMatches('rotated'), true);
  assert.equal(a.tokenMatches(['rotated']), false);
});
test('HTTP boundary rejects rebinding, browser body-token abuse and unauthenticated remote access', () => {
  const a = createHttpAuthorization({ port: 8765, token: 'secret' });
  assert.equal(a.originOk(request({ host: 'evil.example:8765', origin: 'http://evil.example:8765' })), false);
  assert.equal(a.authorizeRoute(request({ 'sec-fetch-site': 'cross-site' }), 'POST', '/api/permission/request'), 'cross-origin request rejected');
  assert.equal(a.authorizeRoute(request({ 'x-wcw-token': 'secret' }, '192.0.2.1'), 'POST', '/api/bootstrap'), 'remote client not allowed');
  assert.equal(a.authorizeRoute(request({}, '192.0.2.1'), 'GET', '/api/status'), 'missing or invalid workbench token');
  assert.equal(a.authorizeRoute(request({ 'x-wcw-token': 'secret' }), 'POST', '/api/unknown'), 'route not authorized');
  assert.equal(a.authorizeRoute(request(), 'HEAD', '/api/status'), null);
});
test('all token routes require credentials for browser and non-browser callers', () => {
  const a = createHttpAuthorization({ port: 8765, token: 'secret' });
  for (const route of ROUTE_AUTH.filter(r => r.auth === 'token')) {
    const method = route.m === '*' ? 'POST' : route.m;
    assert.equal(a.authorizeRoute(request(), method, route.p), 'missing or invalid workbench token', `${method} ${route.p}`);
    assert.equal(a.authorizeRoute(request({ origin: 'http://127.0.0.1:8765', 'x-wcw-token': 'secret' }), method, route.p), null, `${method} ${route.p}`);
  }
});
