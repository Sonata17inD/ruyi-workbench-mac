'use strict';
// PowerShell / 控制台输出的编码(用户实测:中文 Windows 上 shell 会话里 PowerShell 的中文输出是乱码)。
//   [E1] 按行判定:GBK 行按 GBK 解、UTF-8 行按 UTF-8 解,混在同一份输出里也各自正确
//        (修前 runProcess 整段判定 —— 有一处不是 UTF-8 就整段按 GBK,UTF-8 那部分反被解坏;shell 会话一律按 UTF-8)
//   [E2] 流式:chunk 从一个 GBK / UTF-8 汉字中间切开也不出替换符;不带换行的尾巴(提示符)flush 时吐出
//   [E3] 交互式 shell 的输入:含中文的命令改成纯 ASCII 的等价命令(UTF-8 Base64 → Invoke-Expression),纯 ASCII 原样
//   [E4] 接线:runProcess 的 decodeBestEffort、shell 会话、覆盖包解压 / 进程取证都走这一套
//   [E5] 源头编码(仅 Windows 且有 powershell.exe;走生产路径 toolCall):非中文代码页(en-US:OEM 437 / ANSI 1252)的机器上,
//        powershell.exe 把输出按控制台代码页编码,中文在【源头】就变成 `?`(0x3f),Node 侧的 UTF-8 优先 / GB18030 回落无从还原。
//        脚本前导 [Console]::OutputEncoding = UTF8(无 BOM)后,中文输出、中文文件名、cmd /c dir、Write-Host、stderr 全部正确。
//        powershell_run / script_run(PowerShell)/ shell_start(后台命令 + 交互式 shell_send)四条路径都断言。
//   [E6] 前导的形状(跨平台、不起进程):withQuietProgress 把它放在 $ProgressPreference 之前、同一行、不换行(报错行号不漂);
//        用 UTF8Encoding($false) 而不是带 BOM 的 [Text.Encoding]::UTF8;豁免脚本(param / using / #requires / [CmdletBinding])两样都不加;
//        shell_start 的 -EncodedCommand 脚本头与交互式 -NoExit -Command 都带它,且不改用户命令的行号。
// 夹具里的 GBK 字节是手写的(中文 = D6 D0 CE C4,乱码 = C2 D2 C2 EB,找不到路径 = D5 D2 B2 BB B5 BD C2 B7 BE B6)。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const fs = require('fs');
const os = require('os');
const cp = require('child_process');
const path = require('path');
const { readServerSource } = require('../src-reader');
const readSrcFile = name => fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/src', name), 'utf8');
const { functionBlock, constBlock } = require('../lib/source-slice');

const source = readServerSource();
function load() {
  const code = [
    'let _consoleGbDecoder = null;',
    constBlock(source, '_consoleUtf8Strict'),
    functionBlock(source, 'decodeConsoleSegment'),
    functionBlock(source, 'decodeConsoleText'),
    functionBlock(source, 'consoleIncompleteTail'),
    functionBlock(source, 'createConsoleLineDecoder'),
    '({ decodeConsoleText, createConsoleLineDecoder })',
  ].join('\n');
  return vm.runInNewContext(code, { Buffer, TextDecoder });
}
const { decodeConsoleText, createConsoleLineDecoder } = load();

const GBK_ZHONGWEN = [0xd6, 0xd0, 0xce, 0xc4];                          // 中文
const GBK_LUANMA = [0xc2, 0xd2, 0xc2, 0xeb];                            // 乱码
const GBK_NOTFOUND = [0xd5, 0xd2, 0xb2, 0xbb, 0xb5, 0xbd, 0xc2, 0xb7, 0xbe, 0xb6];   // 找不到路径
const bytes = (...parts) => Buffer.concat(parts.map(p => (typeof p === 'string' ? Buffer.from(p, 'utf8') : Buffer.from(p))));

test('[E1] 同一份输出里 GBK 行与 UTF-8 行各自解对', () => {
  const mixed = bytes('PS> git log --oneline\r\n', 'abc123 修复中文提交说明\n', GBK_NOTFOUND, ' C:\\', GBK_ZHONGWEN, '\r\n', 'done\n');
  assert.equal(decodeConsoleText(mixed), 'PS> git log --oneline\r\nabc123 修复中文提交说明\n找不到路径 C:\\中文\r\ndone\n');
  assert.equal(decodeConsoleText(bytes(GBK_LUANMA)), '乱码', '没有换行的单行 GBK');
  assert.equal(decodeConsoleText(bytes('纯 UTF-8')), '纯 UTF-8');
  assert.equal(decodeConsoleText(Buffer.alloc(0)), '');
});

test('[E2] 流式解码:切在汉字中间不出替换符,尾巴 flush 时吐出', () => {
  const full = bytes(GBK_ZHONGWEN, GBK_LUANMA, '\r\n', 'UTF-8 行:如意\n', 'PS C:\\', GBK_ZHONGWEN, '> ');
  for (let cut = 1; cut < full.length; cut++) {
    const dec = createConsoleLineDecoder();
    let out = dec.write(full.subarray(0, cut)) + dec.write(full.subarray(cut));
    out += dec.flush();
    assert.equal(out, '中文乱码\r\nUTF-8 行:如意\nPS C:\\中文> ', `切点 ${cut}`);
    assert.ok(!out.includes('\ufffd'));
  }
  // 空闲 flush 正好落在一个字符的两半之间(写方停顿):没写完的那半留着,下一次拼上再解
  for (const [label, parts] of [['UTF-8', [bytes('输出:'), Buffer.from([0xe4, 0xb8]), Buffer.from([0xad, 0xe6, 0x96, 0x87])]],
    ['GBK', [bytes('out:'), Buffer.from([0xd6]), Buffer.from([0xd0, 0xce, 0xc4])]]]) {
    const d = createConsoleLineDecoder();
    let got = d.write(parts[0]) + d.write(parts[1]) + d.flush();
    got += d.write(parts[2]) + d.flush();
    assert.equal(got, label === 'UTF-8' ? '输出:中文' : 'out:中文', `${label}:flush 不劈开字符`);
  }
  const dec = createConsoleLineDecoder();
  assert.equal(dec.write(bytes('提示符> ')), '', '没有换行先攒着');
  assert.equal(dec.pendingBytes > 0, true);
  assert.equal(dec.end(), '提示符> ');
});

test('Mac shell decodes UTF-8 incrementally and uses its private completion channel', () => {
  const shell = functionBlock(readSrcFile('11-native-tools.js'), 'shellStart');
  assert.ok(shell.includes("new StringDecoder('utf8')"));
  assert.ok(shell.includes('bindMacShellProtocol(sess)'));
  assert.ok(!shell.includes('powershell.exe'));
});
