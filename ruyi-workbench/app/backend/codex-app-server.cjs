'use strict';

const readline = require('node:readline');

// Each child serves one Ruyi turn. Request ids belong to its stdio connection.
function codexConnection(child, { notify, handleRequest }) {
  const pending = new Map();
  let seq = 0,
    failure;
  let disconnect;
  const disconnected = new Promise((resolve) => {
    disconnect = resolve;
  });
  function close(error) {
    if (failure) return;
    failure = error;
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
    disconnect(error);
  }
  function send(frame) {
    if (failure) throw failure;
    child.stdin.write(JSON.stringify(frame) + '\n');
  }
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', (line) => {
    if (failure || !line) return;
    try {
      const msg = JSON.parse(line);
      if (!msg.method) {
        const entry = pending.get(msg.id);
        if (!entry) return;
        pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(msg.error.message));
        else entry.resolve(msg.result);
      } else if (msg.id === undefined) notify(msg.method, msg.params);
      else
        Promise.resolve()
          .then(() => handleRequest(msg.method, msg.params))
          .then(
            (result) => send({ id: msg.id, result }),
            (error) => send({ id: msg.id, error: { code: -32601, message: error.message } }),
          )
          .catch(close);
    } catch (error) {
      close(error);
    }
  });
  lines.once('close', () => close(new Error('Codex app-server disconnected')));
  child.once('error', close);
  child.stdin.on('error', close);
  function request(method, params) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      if (failure) return reject(failure);
      const timer = setTimeout(() => close(new Error('Codex RPC timed out: ' + method)), 30000).unref();
      pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      send({ id, method, params });
    });
  }
  return { request, send, disconnected };
}

const providerId = 'ruyi_chatgpt_plan';
const providerConfig = {
  model_provider: providerId,
  ['model_providers.' + providerId + '.name']: 'ChatGPT plan',
  ['model_providers.' + providerId + '.base_url']: 'https://api.openai.com/v1',
  ['model_providers.' + providerId + '.env_key']: 'RUYI_CHATGPT_ACCESS_TOKEN',
  ['model_providers.' + providerId + '.wire_api']: 'responses',
  ['model_providers.' + providerId + '.requires_openai_auth']: false,
  ['model_providers.' + providerId + '.supports_websockets']: false,
  'shell_environment_policy.exclude': ['RUYI_CHATGPT_ACCESS_TOKEN', 'WCW_TOKEN'],
  'features.tool_search': false,
  'features.multi_agent': false,
  'features.multi_agent_v2': false,
  'features.plugins': false,
  web_search: 'disabled',
};
function appServerArgs() {
  return [
    'app-server',
    '--listen',
    'stdio://',
    ...Object.entries(providerConfig).flatMap(([key, value]) => ['-c', key + '=' + JSON.stringify(value)]),
  ];
}
module.exports = { codexConnection, providerId, appServerArgs };
