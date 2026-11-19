'use strict';

// Kimi's official Claude Code setup uses the /coding/ endpoint (including its trailing
// slash) and requires Claude's internal role aliases to resolve to a Kimi model.  Do
// not apply this to generic Anthropic-compatible endpoints: their aliases can have
// vendor-specific meanings.
function isKimiCodingEndpoint(base) {
  try {
    const url = new URL(String(base || '').trim());
    return url.hostname.toLowerCase() === 'api.kimi.com' && url.pathname.replace(/\/+$/, '') === '/coding';
  } catch {
    return false;
  }
}

// Third-party Anthropic-compatible endpoint (e.g. a vendor Coding Plan) config → env overrides.
// Only returns keys the user actually configured in modelsApiBase/modelsApiKey/model — an unconfigured
// field leaves whatever the OS/shell env already has untouched, so an install with no third-party setup
// behaves exactly as before. Config wins over a stale inherited env var so a hot model/endpoint switch in
// the UI can't be silently shadowed by an old `setx`-set value (previously these fields only fed the
// model-LIST discovery probe, never the actually-spawned CLI child — this is the fix for that gap).
// authMode picks which auth header the CLI sees: 'bearer' -> ANTHROPIC_AUTH_TOKEN only (required by Ark
// Coding Plan), 'x-api-key' -> ANTHROPIC_API_KEY only (Anthropic official protocol), 'auto' sets both (a
// safe hedge for an unspecified vendor, matching this function's pre-existing dual-header behavior). When
// a key is configured, the OTHER header is force-cleared — per this project's own admin guide, having both
// present at once makes the CLI pick the wrong auth scheme.
function buildClaudeCliEnv(config) {
  const env = {};
  // Preserve a trailing slash: Kimi's documented Claude Code endpoint is /coding/.
  const base = String((config && config.modelsApiBase) || '').trim();
  const kimiCoding = isKimiCodingEndpoint(base);
  if (base) {
    env.ANTHROPIC_BASE_URL = base;
    // A custom endpoint is moot if the CLI is routed to Bedrock/Vertex instead — both ignore
    // ANTHROPIC_BASE_URL entirely. Clear them so a configured third-party endpoint always wins.
    env.CLAUDE_CODE_USE_BEDROCK = '';
    env.CLAUDE_CODE_USE_VERTEX = '';
  }
  const key = String((config && config.modelsApiKey) || '').trim();
  if (key) {
    const configuredMode = ['bearer', 'x-api-key'].includes(config && config.claudeAuthMode) ? config.claudeAuthMode : 'auto';
    // Kimi documents ANTHROPIC_API_KEY; sending a second auth scheme can make a
    // newer Claude CLI pick a credential path the proxy does not expect.
    const mode = kimiCoding && configuredMode === 'auto' ? 'x-api-key' : configuredMode;
    if (mode === 'bearer') { env.ANTHROPIC_AUTH_TOKEN = key; env.ANTHROPIC_API_KEY = ''; }
    else if (mode === 'x-api-key') { env.ANTHROPIC_API_KEY = key; env.ANTHROPIC_AUTH_TOKEN = ''; }
    else { env.ANTHROPIC_AUTH_TOKEN = key; env.ANTHROPIC_API_KEY = key; }
  }
  const model = String((config && config.model) || '').trim();
  if (model) {
    env.ANTHROPIC_MODEL = model;
    if (kimiCoding) {
      // A native Agent may ask Claude Code for a fast/default family even when the
      // primary model is overridden.  Route every family to the user's selected
      // entitled Kimi model instead of falling back to an unavailable Claude id.
      env.ANTHROPIC_DEFAULT_FABLE_MODEL = model;
      env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
      env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
      env.ANTHROPIC_SMALL_FAST_MODEL = model;
      env.CLAUDE_CODE_SUBAGENT_MODEL = model;
    }
  }
  return env;
}
// The full env a Claude CLI child (or the model-discovery probe) should see: the process's own env,
// overlaid with the config-driven overrides above. Single source of truth so runClaudeTurn (the real
// spawn) and fetchProxyModels (the model-list probe) can never drift apart on which endpoint is "live".
function effectiveAnthropicEnv(config) {
  return { ...process.env, ...buildClaudeCliEnv(config) };
}

module.exports = { buildClaudeCliEnv, effectiveAnthropicEnv };
