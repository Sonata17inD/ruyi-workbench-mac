'use strict';
const crypto = require('node:crypto');
const { URL } = require('node:url');
const { apiFailure } = require('./http-protocol.cjs');

const PRETENDER_PAGE_DEFAULT = 100;
const PRETENDER_PAGE_MAX = 200;

function pretenderHash(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value), 'utf8').digest('hex').slice(0, 24);
}

function encodePretenderCursor(kind, revision, offset, limit) {
  return Buffer.from(JSON.stringify({ v: 1, k: kind, r: revision, o: offset, l: limit }), 'utf8').toString('base64url');
}

function decodePretenderCursor(raw) {
  try {
    const value = JSON.parse(Buffer.from(String(raw || ''), 'base64url').toString('utf8'));
    if (!value || value.v !== 1 || typeof value.k !== 'string' || typeof value.r !== 'string' || !Number.isInteger(value.o) || value.o < 0) return null;
    return value;
  } catch { return null; }
}

function paginatePretenderProjection(req, kind, revision, items) {
  const query = new URL(req.url, 'http://127.0.0.1').searchParams;
  const requestedLimit = Number(query.get('limit'));
  let limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.floor(requestedLimit) : PRETENDER_PAGE_DEFAULT;
  limit = Math.max(1, Math.min(PRETENDER_PAGE_MAX, limit));
  let offset = 0;
  const rawCursor = query.get('cursor');
  if (rawCursor) {
    const cursor = decodePretenderCursor(rawCursor);
    if (!cursor || cursor.k !== kind) return { response: apiFailure('projection.invalid_cursor', { kind }, 'invalid pagination cursor', 400) };
    if (cursor.r !== revision) {
      return { response: apiFailure('projection.snapshot_changed', { cursorRevision: cursor.r, projectionRevision: revision, restartCursor: null }, 'projection changed; restart pagination', 409) };
    }
    offset = cursor.o;
    if (!query.has('limit') && Number.isInteger(cursor.l)) limit = Math.max(1, Math.min(PRETENDER_PAGE_MAX, cursor.l));
  }
  const pageItems = items.slice(offset, offset + limit);
  const nextOffset = offset + pageItems.length;
  const nextCursor = nextOffset < items.length ? encodePretenderCursor(kind, revision, nextOffset, limit) : null;
  return {
    items: pageItems,
    page: { limit, offset, count: pageItems.length, total: items.length, nextCursor, projectionRevision: revision },
  };
}

function pretenderEtag(kind, revision, page) {
  const suffix = page ? `-${page.offset}-${page.limit}` : '';
  return `W/\"${kind}-${revision}${suffix}\"`;
}

function pretenderNotModified(req, etag) {
  return String(req.headers['if-none-match'] || '').split(',').map(v => v.trim()).includes(etag);
}

module.exports = { pretenderHash, paginatePretenderProjection, pretenderEtag, pretenderNotModified };
