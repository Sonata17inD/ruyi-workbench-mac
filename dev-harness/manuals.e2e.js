'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createRunner } = require('./lib/harness');
const t = createRunner('MANUALS');
const { ok } = t;
const root = path.resolve(__dirname, '../ruyi-workbench');
const { workbench } = require('../ruyi-workbench/packaging/macos/runtime-files.json');
const navigation = fs.readFileSync(path.resolve(root, '../docs/README.md'), 'utf8');

for (const [lang, suffix] of [['zh-CN', 'CN'], ['en-US', 'EN']]) {
  const locale = JSON.parse(fs.readFileSync(path.join(root, 'app/public/locales', lang + '.json'), 'utf8'));
  for (const role of ['USER', 'ADMIN']) {
    const file = 'docs/manuals/' + role + '-GUIDE_' + suffix + '.md';
    const guide = fs.readFileSync(path.join(root, file), 'utf8');
    ok(workbench.includes(file) && navigation.includes(file), file + ' is distributed and linked');
    ok(/^# .*Ruyi/m.test(guide) && !/sk-[a-zA-Z0-9]{20,}|TODO|待补/.test(guide), file + ' has a title and publishable content');
    if (role === 'USER') {
      const headings = new Set(guide.split(/\r?\n/).filter(line => line.startsWith('## ')).map(line => line.slice(3)));
      for (const [key, label] of Object.entries(locale).filter(([key]) => key.startsWith('help.anchor.'))) {
        ok(headings.has(label), lang + ' ' + key + ' opens an existing section');
      }
    } else {
      const permissions = lang === 'en-US' ? ['Accessibility', 'Screen Recording', 'microphone'] : ['辅助功能', '屏幕录制', '麦克风'];
      for (const value of ['| Ruyi |', 'Ruyi Slim', '~/.ruyi-workbench-full', '`~/.ruyi-workbench`', 'RUYI_HOME', ...permissions]) {
        ok(guide.includes(value), file + ' documents ' + value);
      }
    }
  }
}
t.done();
