#!/usr/bin/env node
'use strict';

const { startWorkbenchFromCommandLine, createWorkbenchApi } = require('./workbench-runtime.cjs');

if (require.main === module) startWorkbenchFromCommandLine();
else module.exports = createWorkbenchApi();
