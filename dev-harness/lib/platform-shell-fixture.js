'use strict';
// Mac shell fixtures share the production bash quoting contract.
const windows = false;
const shellTool = 'shell_run';
const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
const echo = value => "printf '%s\\n' " + quote(value);
const delay = (seconds, value) => 'sleep ' + seconds + (value === undefined ? '' : '; ' + echo(value));
const writeFile = (file, value = 'ran') => echo(value) + ' > ' + quote(file);
const cwdCommand = 'pwd -P';
module.exports = { windows, shellTool, quote, echo, delay, writeFile, cwdCommand };
