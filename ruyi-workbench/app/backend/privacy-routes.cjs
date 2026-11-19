'use strict';

const { apiFailure, json, send } = require('./http-protocol.cjs');

const PRIVACY_PATHS = new Set(['/api/privacy/status', '/api/privacy/settings', '/api/privacy/encryption', '/api/privacy/rules/test', '/api/privacy/use-native', '/api/privacy/backup/export', '/api/privacy/backup/preview', '/api/privacy/backup/import']);

function createPrivacyRoutes({
  configHooks, PrivacySettings, PrivacyGateway, PrivacyRegex, PrivacyRuleCatalog, LocalSecretCrypto,
  readConfig,
}) {
  const { draft, nativeProviders } = PrivacySettings;
  async function handlePrivacyApiRoutes(req, res, pathname) {
    if (!PRIVACY_PATHS.has(pathname)) return false;
    const reply = value => send(res, json(value, 200, { 'cache-control': 'no-store' }));
    try {
      if (req.method === 'GET') {
        const config = await readConfig();
        if (req.method === 'GET' && pathname === '/api/privacy/status') reply({ ok: true, encryption: config.credentialEncryptionV1 === true, supported: LocalSecretCrypto.supported(), recoveryRequired: PrivacyGateway.recoveryRequired(), mode: config.privacyModeV1, coverage: 'native-text', activeProvider: config.activeProvider, nativeProviders: nativeProviders(config), channels: [
          { id: 'nativeText', supported: true }, { id: 'managedMcpText', supported: true },
          { id: 'cli', supported: false }, { id: 'standaloneMcp', supported: false }, { id: 'media', supported: false }, { id: 'serverTools', supported: false },
        ] });
        else if (req.method === 'GET' && pathname === '/api/privacy/settings') reply({ ok: true, encryption: config.credentialEncryptionV1 === true, recoveryRequired: PrivacyGateway.recoveryRequired(), mode: config.privacyModeV1, technical: config.privacyTechnicalV1, rules: config.privacyRulesV1, ruleVersion: PrivacyGateway.ruleVersion(config), regexLimits: PrivacyRegex.LIMITS, catalog: PrivacyRuleCatalog.list() });
        else return false;
        return true;
      }
      if (req.method !== 'POST') return false;
      const cap = 2 * 1024 * 1024;
      if (Number(req.headers['content-length'] || 0) > cap) throw Object.assign(new Error(), { code: 'privacy.body_limit' });
      const chunks = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > cap) throw Object.assign(new Error(), { code: 'privacy.body_limit' }); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error(), { code: 'privacy.settings_invalid' });
      if (req.method === 'POST' && pathname === '/api/privacy/settings') {
        reply(await PrivacySettings.apply(body));
      } else if (req.method === 'POST' && pathname === '/api/privacy/encryption') {
        reply(await PrivacySettings.updateEncryption(body));
      } else if (req.method === 'POST' && pathname === '/api/privacy/rules/test') {
        const policy = draft(body);
        reply({ ok: true, ...await PrivacyGateway.preview({ ...await readConfig(), ...policy }, body.sample) });
      } else if (req.method === 'POST' && pathname === '/api/privacy/use-native') {
        reply(await PrivacySettings.useNativeProvider(body));
      } else if (req.method === 'POST' && pathname === '/api/privacy/backup/export') {
        if ((await readConfig()).credentialEncryptionV1 !== true) throw Object.assign(new Error(), { code: 'privacy.encryption_required' });
        reply({ ok: true, backup: await configHooks.exportBackup(body.password) });
      }
      else if (req.method === 'POST' && pathname === '/api/privacy/backup/preview') reply({ ok: true, ...await configHooks.preview(body.backup, body.password) });
      else if (req.method === 'POST' && pathname === '/api/privacy/backup/import') reply(await configHooks.commit(body.ticket));
      else return false;
    } catch (error) {
      const code = /^(?:privacy|credential_vault|credential_recovery)\.[a-z_]+$/.test(error.code || '') ? error.code : 'privacy.request_failed';
      const params = typeof error.ruleId === 'string' && /^[a-zA-Z0-9_.:-]{1,160}$/.test(error.ruleId) ? { ruleId: error.ruleId } : {};
      const response = apiFailure(code, params, code, code === 'privacy.body_limit' ? 413 : 409);
      response.headers['cache-control'] = 'no-store'; send(res, response);
    }
    return true;
  }
  return handlePrivacyApiRoutes;
}

module.exports = { createPrivacyRoutes };
