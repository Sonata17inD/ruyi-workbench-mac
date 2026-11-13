'use strict';
const fs = require('node:fs');
const path = require('node:path');
const manifest = require('../packaging/macos/runtime-files.json');
function filesFor(component) {
  const files = manifest[component];
  if (manifest.schemaVersion !== 1 || !Array.isArray(files) || !files.length) throw new Error('Invalid runtime manifest');
  const seen = new Set();
  for (const file of files) {
    if (typeof file !== 'string' || file.includes('\\') || file.split('/').some(p => !p || p === '.' || p === '..')
      || /\.(exe|dll|cmd|bat|ps1)$/i.test(file) || /windows-(control|operator)/i.test(file) || seen.has(file))
      throw new Error('Invalid runtime path: ' + file);
    seen.add(file);
  }
  return files;
}
function copyRuntimeFiles(component, source, destination) {
  const base = fs.realpathSync(source) + path.sep;
  for (const file of filesFor(component)) {
    const input = path.join(source, file);
    if (!fs.lstatSync(input).isFile() || !fs.realpathSync(input).startsWith(base)) throw new Error('Invalid runtime source: ' + file);
    const target = path.join(destination, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(input, target);
  }
}
module.exports = { filesFor, copyRuntimeFiles };
