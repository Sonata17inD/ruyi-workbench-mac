#!/usr/bin/env node
'use strict';

const isCommandLine = require.main === module;
// Reuse Node's bytecode cache across launches of the explicit backend modules.
if (isCommandLine) require('node:module').enableCompileCache?.();

const { startWorkbenchFromCommandLine, createWorkbenchApi } = require('./workbench-runtime.cjs');

if (isCommandLine) startWorkbenchFromCommandLine();
else module.exports = createWorkbenchApi();
