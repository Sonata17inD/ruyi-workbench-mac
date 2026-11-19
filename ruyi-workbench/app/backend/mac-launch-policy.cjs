'use strict';

// Platform launch policy. Keep these helpers free of application state so boot can call them
// before the remaining concatenated modules initialize. No login shell or profile is evaluated.
function platformRuntimeEnvironment(env, platform = process.platform, nodeExecutable = process.execPath) {
  if (platform !== 'darwin') return { ...env };
  const pathModule = require('path');
  const directories = [
    pathModule.dirname(nodeExecutable),
    ...String(env.PATH || '').split(':'),
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin',
  ];
  const absolute = directories.filter(dir => pathModule.posix.isAbsolute(dir));
  return { ...env, PATH: [...new Set(absolute)].join(':') };
}

function platformOpenSpawn(target, mode = 'open', platform = process.platform) {
  const value = String(target || '');
  if (platform === 'darwin') {
    // LaunchServices treats application/workflow bundles as executable even though they are directories.
    const bundle = !/^[a-z][a-z0-9+.-]*:/i.test(value)
      && /\.(?:app|workflow|scptd|bundle|plugin|prefpane|saver|xpc|appex)\/*$/i.test(value);
    const selected = mode === 'select' || bundle;
    return { command: '/usr/bin/open', args: [...(selected ? ['-R'] : []), '--', value], mode: selected ? 'select' : mode };
  }
  throw Object.assign(new Error('Mac desktop is required'), { code: 'platform_unsupported' });
}

// Non-interactive bash still reads BASH_ENV and imports exported functions/options.
function platformShellEnvironment(env) {
  const clean = { ...env };
  for (const name of Object.keys(clean)) {
    if (/^BASH_/.test(name) || ['ENV', 'SHELLOPTS', 'BASHOPTS', 'CDPATH', 'GLOBIGNORE', 'PROMPT_COMMAND', 'PS4'].includes(name)) delete clean[name];
  }
  return clean;
}

function createDetachedLauncher({ cp, process }) {
  // Attach the asynchronous spawn listeners before unref. The returned promise
  // reports the handoff, while invalid spawn parameters still throw synchronously.
  function spawnDetachedChecked(command, args, options) {
    const child = cp.spawn(command, args || [], options);
    // LaunchServices owns the destination application's lifetime. Wait only for the
    // Mac launcher to confirm its handoff, and bound that launcher's own lifetime.
    if (process.platform === 'darwin' && command === '/usr/bin/open') {
      const completed = new Promise(resolve => {
        let settled = false;
        const finish = result => {
          if (settled) return;
          settled = true; clearTimeout(timer); resolve(result);
        };
        const timer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* report the unconfirmed handoff */ }
          finish({ ok: false, code: 'open_timeout', error: 'macOS opener timed out', pid: child.pid });
        }, 5000);
        child.on('error', error => finish({ ok: false, error: error.message, code: error.code || null }));
        child.once('exit', (code, signal) => finish(code === 0 && !signal
          ? { ok: true, pid: child.pid }
          : { ok: false, code: 'open_failed', error: `macOS opener exited with ${signal || code}`, exitCode: code, signal, pid: child.pid }));
      });
      child.unref();
      return completed;
    }
    const started = new Promise(resolve => {
      child.on('error', error => resolve({ ok: false, error: (error && error.message) || String(error), code: (error && error.code) || null }));
      child.once('spawn', () => resolve({ ok: true, pid: child.pid }));
    });
    child.unref();
    return started;
  }
  return spawnDetachedChecked;
}

module.exports = { createDetachedLauncher, platformRuntimeEnvironment, platformOpenSpawn, platformShellEnvironment };
