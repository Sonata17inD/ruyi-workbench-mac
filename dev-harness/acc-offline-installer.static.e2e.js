'use strict';
// Mac ACC packaging contract. Windows installer/OCR rules no longer describe this product.
const fs = require('node:fs');
const path = require('node:path');
const { createRunner } = require('./lib/harness');
const t = createRunner('ACC OFFLINE MAC CONTRACT');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const metadata = read('mcp/ai-computer-control/pyproject.toml');
const requirements = read('mcp/ai-computer-control/requirements_offline.txt');
const packager = read('ruyi-workbench/tools/package-macos-offline.js');
const scripts = JSON.parse(read('ruyi-workbench/package.json')).scripts;
t.ok(!/pywin32|pyautogui|winsdk|uiautomation|comtypes|pynput|win32/.test(metadata + requirements), 'ACC metadata and dependency inputs have no Windows backend dependencies');
t.ok(metadata.includes('mcp[cli]>=1.0.0,<2.0.0') && metadata.includes('requires-python = ">=3.12"'), 'Python and MCP API contracts remain pinned');
t.ok(scripts['package:offline'] === 'node tools/package-macos-offline.js --variant full' && scripts['package:offline:slim'] === 'node tools/package-macos-offline.js --variant slim', 'default offline commands select Mac Full and Slim');
t.ok(packager.includes("'--no-index'") && packager.includes("'--require-hashes'") && packager.includes("'--no-deps'"), 'Full installs from offline hash-locked assets and a local ACC wheel');
t.ok(packager.includes("variant === 'full'") && packager.includes('officialAgentCliBundled: false'), 'optional Full runtime and unbundled official CLIs remain explicit');
t.done();
