'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { filesFor, copyRuntimeFiles } = require('../../ruyi-workbench/tools/macos-runtime-files');
const repo = path.resolve(__dirname, '../..');
test('Mac runtime manifest includes every explicit backend and no Windows payload', () => {
  const files = filesFor('workbench');
  for (const file of fs.readdirSync(path.join(repo, 'ruyi-workbench/app/backend'))) assert.ok(files.includes('app/backend/' + file));
  for (const component of ['workbench', 'acc']) {
    for (const file of filesFor(component)) {
      assert.doesNotMatch(file, /\.(exe|dll|cmd|bat|ps1)$|windows-(control|operator)/i);
      assert.ok(fs.statSync(path.join(repo, component === 'acc' ? 'mcp/ai-computer-control' : 'ruyi-workbench', file)).isFile(), file);
    }
  }
});
test('ACC copying excludes unlisted files and wheel verification rejects injected backends', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-runtime-files-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), output = path.join(root, 'output');
  for (const file of filesFor('acc')) {
    const dest = path.join(source, file); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, '');
  }
  fs.writeFileSync(path.join(source, 'unexpected.exe'), 'MZ');
  copyRuntimeFiles('acc', source, output);
  assert.equal(fs.existsSync(path.join(output, 'unexpected.exe')), false);
  const script = `import importlib.util,json,zipfile,sys
spec=importlib.util.spec_from_file_location('verify',sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
manifest=json.load(open(sys.argv[2])); wheel=sys.argv[3]
with zipfile.ZipFile(wheel,'w') as z:
 for name in manifest['acc']:
  if name.startswith('src/'): z.writestr(name[4:],'')
m.verify(wheel,manifest)
with zipfile.ZipFile(wheel,'a') as z: z.writestr('ai_computer_control/tools/ocr.py','')
try: m.verify(wheel,manifest)
except ValueError: pass
else: raise AssertionError('Injected retired backend accepted')
`;
  cp.execFileSync('python3', ['-c', script, path.join(repo, 'ruyi-workbench/tools/verify-macos-acc-wheel.py'),
    path.join(repo, 'ruyi-workbench/packaging/macos/runtime-files.json'), path.join(root, 'acc.whl')]);
});
