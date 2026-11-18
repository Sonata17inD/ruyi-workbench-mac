'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { stat: statFile } = require('node:fs/promises');

const EXTERNAL_BOT_LIMITS = Object.freeze({ connections: 16, retiredIds: 4096, items: 1000, textChars: 8192, textBytes: 32768, bodyBytes: 65536, stateBytes: 40 * 1024 * 1024, readTimeoutMs: 5000, inflightCallbacks: 8, callbacksPerMinute: 120 });
const EXTERNAL_BOT_CONNECTION_KEYS = Object.freeze(['id', 'platform', 'label', 'enabled', 'appId', 'tenantId', 'botUserId', 'allowedSenderIds', 'allowedConversationIds', 'verificationTokenEnv', 'encryptKeyEnv', 'botSecretEnv', 'appSecretEnv', 'mode', 'ownerSenderId', 'ownerConversationId', 'ownerConversationType']);

function externalBotError(code, statusCode = 400) {
  return Object.assign(new Error(code), { code, apiCode: code, statusCode });
}
function externalBotString(value, max = 128, empty = false) {
  return typeof value === 'string' && value.length <= max && (empty || value.trim().length > 0) && !/[\u0000-\u001f\u007f]/.test(value);
}
function externalBotEnvReference(value) {
  return value === '' || (typeof value === 'string' && /^RUYI_BOT_[A-Z0-9_]{1,100}$/.test(value));
}
function externalBotIdentity(value) { return typeof value === 'string' && /^[\x21-\x7e]{1,128}$/.test(value); }
function externalBotNormalizeConnection(raw, id) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !EXTERNAL_BOT_CONNECTION_KEYS.includes(key))) throw externalBotError('external_channel.connection_invalid');
  if (!['qq', 'feishu'].includes(raw.platform) || !externalBotIdentity(raw.appId)) throw externalBotError('external_channel.connection_invalid');
  if (raw.tenantId !== undefined && typeof raw.tenantId !== 'string') throw externalBotError('external_channel.connection_invalid');
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id)) throw externalBotError('external_channel.connection_invalid');
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') throw externalBotError('external_channel.connection_invalid');
  const out = { id, platform: raw.platform, label: raw.label ?? '', enabled: raw.enabled === true, appId: raw.appId,
    tenantId: raw.tenantId || (raw.platform === 'qq' ? raw.appId : ''), botUserId: raw.botUserId ?? '',
    allowedSenderIds: raw.allowedSenderIds ?? [], allowedConversationIds: raw.allowedConversationIds ?? [],
    verificationTokenEnv: raw.verificationTokenEnv ?? '', encryptKeyEnv: raw.encryptKeyEnv ?? '', botSecretEnv: raw.botSecretEnv ?? '',
    appSecretEnv: raw.appSecretEnv ?? '', mode: raw.mode ?? 'inbox', ownerSenderId: raw.ownerSenderId ?? '',
    ownerConversationId: raw.ownerConversationId ?? '', ownerConversationType: raw.ownerConversationType ?? 'direct' };
  if (!externalBotString(out.label, 120, true) || !externalBotString(out.tenantId, 128, true) || !externalBotString(out.botUserId, 128, true)) throw externalBotError('external_channel.connection_invalid');
  if ((out.tenantId && !externalBotIdentity(out.tenantId)) || (out.botUserId && !externalBotIdentity(out.botUserId))) throw externalBotError('external_channel.connection_invalid');
  for (const key of ['allowedSenderIds', 'allowedConversationIds']) {
    if (!Array.isArray(out[key]) || out[key].length > 100 || out[key].some(value => !externalBotIdentity(value))) throw externalBotError('external_channel.connection_invalid');
    out[key] = [...new Set(out[key])];
  }
  for (const key of ['verificationTokenEnv', 'encryptKeyEnv', 'botSecretEnv', 'appSecretEnv']) if (!externalBotEnvReference(out[key])) throw externalBotError('external_channel.env_reference_invalid');
  if ((out.platform === 'qq' && (out.verificationTokenEnv || out.encryptKeyEnv || out.appSecretEnv)) || (out.platform === 'feishu' && out.botSecretEnv)) throw externalBotError('external_channel.connection_invalid');
  if (!['inbox', 'control'].includes(out.mode) || !['direct', 'group'].includes(out.ownerConversationType)
    || (out.ownerSenderId && !externalBotIdentity(out.ownerSenderId)) || (out.ownerConversationId && !externalBotIdentity(out.ownerConversationId))) throw externalBotError('external_channel.connection_invalid');
  if (out.mode === 'control' && (!out.ownerSenderId || !out.ownerConversationId || !['direct', 'group'].includes(raw.ownerConversationType)
    || !out.allowedSenderIds.includes(out.ownerSenderId) || !out.allowedConversationIds.includes(out.ownerConversationId))) throw externalBotError('external_channel.owner_invalid');
  return out;
}

function externalBotSetupReceipt(connectionId, message) {
  const textHash = crypto.createHash('sha256').update(message.text).digest('hex');
  return { connectionId, tenantId: message.tenantId, conversationId: message.conversationId, messageId: message.messageId,
    senderId: message.senderId, conversationType: message.conversationType, textHash,
    sourceKey: JSON.stringify([connectionId, message.tenantId, message.conversationId, message.messageId]),
    contentHash: crypto.createHash('sha256').update(JSON.stringify([message.senderId, message.conversationType, textHash])).digest('hex') };
}
function externalBotValidSetupReceipt(receipt) {
  return receipt && !Array.isArray(receipt) && !Object.keys(receipt).some(key => !['connectionId', 'tenantId', 'conversationId', 'messageId', 'senderId', 'conversationType', 'textHash', 'sourceKey', 'contentHash'].includes(key))
    && ['connectionId', 'tenantId', 'conversationId', 'messageId', 'senderId'].every(key => externalBotIdentity(receipt[key]))
    && ['direct', 'group'].includes(receipt.conversationType) && /^[a-f0-9]{64}$/.test(receipt.textHash)
    && receipt.sourceKey === JSON.stringify([receipt.connectionId, receipt.tenantId, receipt.conversationId, receipt.messageId])
    && receipt.contentHash === crypto.createHash('sha256').update(JSON.stringify([receipt.senderId, receipt.conversationType, receipt.textHash])).digest('hex');
}

function externalBotValidItem(item) {
  return item && typeof item === 'object' && !Array.isArray(item) && externalBotString(item.id) && externalBotString(item.connectionId)
    && ['qq', 'feishu'].includes(item.platform) && externalBotString(item.connectionLabel, 120, true)
    && ['tenantId', 'conversationId', 'senderId', 'messageId', 'eventId'].every(key => externalBotIdentity(item[key]))
    && ['direct', 'group'].includes(item.conversationType) && typeof item.text === 'string' && item.text.trim().length > 0
    && item.text.length <= EXTERNAL_BOT_LIMITS.textChars && Buffer.byteLength(item.text, 'utf8') <= EXTERNAL_BOT_LIMITS.textBytes && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(item.text)
    && item.sourceKey === JSON.stringify([item.connectionId, item.tenantId, item.conversationId, item.messageId])
    && item.contentHash === crypto.createHash('sha256').update(JSON.stringify([item.senderId, item.conversationType, item.text])).digest('hex')
    && typeof item.receivedAt === 'string' && Number.isFinite(Date.parse(item.receivedAt))
    && typeof item.readAt === 'string' && (!item.readAt || Number.isFinite(Date.parse(item.readAt))) && externalBotValidControlState(item);
}
function externalBotValidControlState(item) {
  if (item.control === null) return item.execution === null && item.delivery === null;
  const control = item.control, execution = item.execution, delivery = item.delivery;
  const date = value => typeof value === 'string' && (!value || Number.isFinite(Date.parse(value)));
  if (!control || typeof control !== 'object' || Array.isArray(control) || !Number.isSafeInteger(control.controlRevision) || control.controlRevision < 1
    || !externalBotIdentity(control.appId) || !['connectionId', 'platform', 'tenantId', 'senderId', 'conversationId', 'conversationType'].every(key => control[key] === item[key])) return false;
  if (!execution || typeof execution !== 'object' || Array.isArray(execution) || !['queued', 'running', 'completed', 'failed', 'unknown'].includes(execution.status)
    || !externalBotString(execution.serverInstanceId, 128, true) || !date(execution.startedAt) || !date(execution.finishedAt)
    || !externalBotString(execution.errorCode, 128, true) || typeof execution.replyText !== 'string' || execution.replyText.length > 3000
    || !Number.isSafeInteger(execution.turnSeq) || execution.turnSeq < 0 || typeof execution.contractIncomplete !== 'boolean'
    || ![execution.actionFailures, execution.proposals].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 100)) return false;
  return delivery === null || (delivery && typeof delivery === 'object' && !Array.isArray(delivery)
    && ['pending', 'sending', 'sent', 'failed', 'unknown'].includes(delivery.status) && typeof delivery.attemptId === 'string' && /^[a-zA-Z0-9_-]{1,50}$/.test(delivery.attemptId)
    && externalBotString(delivery.messageId, 128, true) && externalBotString(delivery.errorCode, 128, true) && date(delivery.updatedAt)
    && (delivery.status !== 'sent' || Boolean(delivery.messageId)));
}

function externalBotValidState(state) {
  if (state?.setupReceipts !== undefined && (!Array.isArray(state.setupReceipts) || state.setupReceipts.length > 4096
    || !state.setupReceipts.every(externalBotValidSetupReceipt) || new Set(state.setupReceipts.map(row => row.sourceKey)).size !== state.setupReceipts.length)) return false;
  if (Object.keys(state).some(key => !['schema', 'connections', 'items', 'retiredConnectionIds', 'setupReceipts'].includes(key)) || state.schema !== 1 || !Array.isArray(state.connections) || state.connections.length > EXTERNAL_BOT_LIMITS.connections
    || !Array.isArray(state.items) || state.items.length > EXTERNAL_BOT_LIMITS.items
    || !Array.isArray(state.retiredConnectionIds) || state.retiredConnectionIds.length > EXTERNAL_BOT_LIMITS.retiredIds
    || state.retiredConnectionIds.some(id => typeof id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(id))
    || new Set(state.retiredConnectionIds).size !== state.retiredConnectionIds.length) return false;
  try {
    for (const connection of state.connections) {
      const { controlRevision, ...fields } = connection;
      if (!Number.isSafeInteger(controlRevision) || controlRevision < 1 || JSON.stringify(externalBotNormalizeConnection(fields, fields.id)) !== JSON.stringify(fields)) return false;
      // Credentials may now live in the separate encrypted vault. This synchronous schema validates
      // metadata only; every admission still resolves and verifies the current credentials strictly.
      if (connection.enabled && (!connection.allowedSenderIds.length || !connection.allowedConversationIds.length
        || (connection.platform === 'feishu' && (!connection.tenantId || !connection.botUserId)))) return false;
    }
  } catch { return false; }
  return new Set(state.connections.map(row => row.id)).size === state.connections.length && state.items.every(externalBotValidItem)
    && !state.connections.some(row => state.retiredConnectionIds.includes(row.id))
    && new Set(state.items.map(row => row.id)).size === state.items.length && new Set(state.items.map(row => row.sourceKey)).size === state.items.length;
}

function createExternalBotLedger({ paths, DurableJsonStore, stat = statFile }) {
  const externalBotStore = DurableJsonStore.create({
    id: 'external-bots', file: () => path.join(paths.data, 'external-bots', 'state-v1.json'), schemaVersion: 1,
    defaultValue: () => ({ schema: 1, connections: [], items: [], retiredConnectionIds: [] }), cache: false, quarantine: false, strictRead: true,
    validate: externalBotValidState,
  });
  async function externalBotReadState() {
    try {
      const info = await stat(externalBotStore.filePath()).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (info && info.size > EXTERNAL_BOT_LIMITS.stateBytes) throw new Error('oversized state');
      return await externalBotStore.read();
    } catch { throw externalBotError('external_channel.storage_unavailable', 503); }
  }
  async function externalBotWriteState(state) {
    if (Buffer.byteLength(JSON.stringify(state), 'utf8') > EXTERNAL_BOT_LIMITS.stateBytes) throw externalBotError('external_channel.inbox_full', 503);
    try { await externalBotStore.write(state); }
    catch { externalBotStore.invalidate(); throw externalBotError('external_channel.storage_unavailable', 503); }
  }
  return { read: externalBotReadState, write: externalBotWriteState };
}

module.exports = {
  createExternalBotLedger, EXTERNAL_BOT_LIMITS, externalBotError, externalBotString, externalBotIdentity,
  externalBotNormalizeConnection, externalBotSetupReceipt, externalBotValidSetupReceipt, externalBotValidState,
};
