'use strict';

const crypto = require('node:crypto');

function createMcpExecutionReceipts({
  executionArgumentsDigest,
}) {

  // A real, safe tools/call roundtrip must preserve both reserved metadata and SDK numeric types.
  // The schema-shape flag alone is insufficient. Never cache this across an MCP child replacement.
  async function probeDesktopExecutionReceipts(client, options = {}) {
    const nonce = crypto.randomBytes(16).toString('hex');
    const probeValues = { integer: 1000000000000000100, exponent: 1e21, decimal: 0.0000001,
      subnormal: Number.MIN_VALUE, zero: 0, unicode: '你好🚀' };
    const expected = executionArgumentsDigest(probeValues);
    const result = await client.callTool('execution_receipt', { invocation_id: '0'.repeat(32), probe_values: probeValues },
      8000, { ...options, meta: { 'org.ruyi.workbench/execution-probe-v1': { schema: 1, nonce } } });
    const probe = result?.metadata_probe;
    if (result?.ok !== true || result.execution_receipt_version !== 1 || result.semantic_validation?.semantic_version !== 1 || !probe || probe.schema !== 1 || probe.nonce !== nonce
        || probe.context_required !== true || probe.args_semantic_codec !== 'ruyi-sdk-json-v1' || probe.received_semantic_sha256 !== expected
        || !/^[a-f0-9]{32}$/.test(probe.acc_worker_id || '') || !Number.isSafeInteger(probe.acc_pid) || probe.acc_pid <= 0) {
      return { ok: false, code: 'execution_receipts_unavailable', outcome: 'not_dispatched', action_sent: false };
    }
    return { ok: true, receiptVersion: 1, argumentsCodec: probe.args_semantic_codec,
      accWorkerId: probe.acc_worker_id, accPid: probe.acc_pid, contextRequired: true };
  }

  return { probeDesktopExecutionReceipts };
}

module.exports = { createMcpExecutionReceipts };
