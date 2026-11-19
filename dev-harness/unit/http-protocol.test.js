'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const protocol = require('../../ruyi-workbench/app/backend/http-protocol.cjs');
function request(parts, headers = {}) {
  return Object.assign(Readable.from(parts.map(p => Buffer.isBuffer(p) ? p : Buffer.from(p))), { headers });
}
test('body reader preserves split UTF-8 and accepts only object JSON', async () => {
  const bytes = Buffer.from('{"内容":"中"}');
  assert.deepEqual(await protocol.readJsonBody(request([bytes.subarray(0, 3), bytes.subarray(3, 8), bytes.subarray(8)])), { 内容: '中' });
  for (const body of ['', '  ', 'null', '[]', '42', '"text"']) {
    assert.deepEqual(await protocol.readJsonBody(request([body])), {});
  }
  await assert.rejects(protocol.readJsonBody(request(['{'])), { statusCode: 400, apiCode: 'api.bad_json' });
});
test('declared oversize fails before reading and absorbs late stream errors', async () => {
  let reads = 0;
  const req = new Readable({ read() { reads++; this.push(null); } });
  req.headers = { 'content-length': protocol.MAX_BODY_BYTES + 1 };
  await assert.rejects(protocol.readBody(req), { statusCode: 413, apiCode: 'api.body_too_large' });
  assert.equal(reads, 0);
  assert.doesNotThrow(() => req.emit('error', new Error('late socket error')));
  req.destroy();
});
test('stream byte limit applies without trusting content-length; transport failures propagate', async () => {
  const chunk = Buffer.alloc(1024 * 1024);
  const req = request(Array(129).fill(chunk), { 'content-length': '1' });
  await assert.rejects(protocol.readBody(req), { statusCode: 413, apiCode: 'api.body_too_large' });
  const broken = new Readable({ read() { this.destroy(new Error('connection lost')); } });
  await assert.rejects(protocol.readBody(broken), /connection lost/);
});
test('error envelopes, status and MIME headers keep their wire contract', () => {
  const response = protocol.json({ ok: false, error: 'session not found', extra: 1 }, 404);
  assert.deepEqual(JSON.parse(response.body), { ok: false, extra: 1, error: { code: 'session.not_found', params: {}, message: 'session not found' } });
  let status, headers, body;
  protocol.sendError({ writeHead(s, h) { status = s; headers = h; }, end(b) { body = b; } }, Object.assign(new Error('invalid'), { statusCode: 400, apiCode: 'api.bad_json' }));
  assert.equal(status, 400);
  assert.equal(headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(JSON.parse(body).error.code, 'api.bad_json');
  assert.equal(protocol.contentTypeFor('/tmp/图.PNG'), 'image/png');
  assert.equal(protocol.contentTypeFor('file.unknown'), 'application/octet-stream');
});
