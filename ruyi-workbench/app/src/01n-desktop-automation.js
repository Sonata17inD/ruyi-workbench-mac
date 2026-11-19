// P5 bounded native desktop IPC. The helper is a leaf and never starts child processes.
const MacDesktopAutomationHooks = { helperPath: () => process.env.RUYI_MACOS_AUTOMATION_HELPER
  || require('node:path').resolve(__dirname, '..', 'runtime', 'macos', 'ruyi-automation-helper') };
const MacDesktopAutomation = require('./backend/desktop-automation.cjs').createDesktopAutomation({ hooks: MacDesktopAutomationHooks, process });
