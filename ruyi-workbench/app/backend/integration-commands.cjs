'use strict';

const fsp = require('node:fs/promises');
const os = require('node:os');
const { LEGACY_RUYI_MCP_SERVER_IDS, RUYI_MCP_SERVER_ID } = require('./product-identity.cjs');

function createIntegrationCommands({
  paths, RUNTIME, process, APP_NAME, VERSION, ensureDirs, readConfig, generateMcpConfig,
  existsExecutable, DesktopShell, syncClaudeCliSettings, syncAgentRolesToClaude, syncMcpServersToClaude, mcpServices,
}) {
  async function startMcp() {
    await ensureDirs();
    // Stateful shell sessions belong to the serving process, not this MCP child.
    RUNTIME.isMcpChild = true;
    return require('./mcp-server.cjs').createMcpServer({
      input: process.stdin, output: process.stdout, env: process.env, version: VERSION, configPath: paths.config,
      readConfig, ...mcpServices,
    }).start();
  }

  async function installIntegration() {
    await ensureDirs();
    const config = await readConfig();
    const mcpPath = await generateMcpConfig();
    console.log(`${APP_NAME} integration`);
    console.log(`Data root: ${paths.data}`);
    console.log(`MCP config: ${mcpPath}`);
    console.log(`Claude CLI: ${config.claudePath || '(not configured)'}`);
    if (config.claudePath && existsExecutable(config.claudePath)) {
      // 3.0:先移除旧 id 的登记(win-claude-workbench;没有就报错,忽略),再按新 id 'ruyi' 登记 —— 否则 Claude Code 里
      // 同一个工作台 MCP 会以两个名字各起一个子进程。
      // 逐个作用域删:老版本 node install 登记在 local、安装脚本登记在 user;不带 -s 时同一个 id 在多个作用域里都有会直接报错。
      for (const legacyId of LEGACY_RUYI_MCP_SERVER_IDS) {
        for (const scope of ['local', 'user', 'project']) {
          try { await DesktopShell.runProcess(config.claudePath, ['mcp', 'remove', legacyId, '-s', scope], { cwd: os.homedir(), timeoutMs: 15000 }); } catch { /* 这个作用域里没登记过 */ }
        }
      }
      const result = await DesktopShell.runProcess(config.claudePath, ['mcp', 'add-json', RUYI_MCP_SERVER_ID, JSON.stringify(JSON.parse(await fsp.readFile(mcpPath, 'utf8')).mcpServers[RUYI_MCP_SERVER_ID])], {
        cwd: os.homedir(),
        timeoutMs: 30000,
      });
      console.log(result.stdout || result.stderr || JSON.stringify(result, null, 2));
    }
    // v1.4.3: full sync — settings.json + agent roles + MCP servers
    await syncClaudeCliSettings(config);
    await syncAgentRolesToClaude(config.defaultWorkspace || os.homedir(), config);
    await syncMcpServersToClaude(config);
    console.log('Claude CLI synced: settings+agents+mcp (permissionMode=' + config.permissionMode + ')');
  }

  return { startMcp, installIntegration };
}

function createWorkbenchCli({ process, console = globalThis.console, parseArgs, startServer, startStewardInbox, readConfig,
  startMcp, installIntegration, doctor, generateMcpConfig, startupGuidance }) {
  async function main() {
    const argv = parseArgs(process.argv.slice(2));
    const command = argv._[0] || 'serve';
    if (command === 'serve') {
      const served = await startServer(argv);
      // Start the inbox after the server has published its runtime metadata.
      await startStewardInbox(await readConfig()).catch(() => {});
      return served;
    }
    if (command === 'mcp') return startMcp();
    if (command === 'install') return installIntegration();
    if (command === 'doctor') return doctor(argv);
    if (command === 'mcp-config') {
      console.log(await generateMcpConfig());
      return;
    }
    console.error(`Unknown command: ${command}`);
    process.exitCode = 1;
  }

  return function runWorkbenchCli() {
    return main().catch(err => {
      console.error(startupGuidance(err) || err.stack || err.message || String(err));
      // Startup may fail after opening watchers or timers, so exit immediately.
      process.exit(1);
    });
  };
}

module.exports = { createIntegrationCommands, createWorkbenchCli };
