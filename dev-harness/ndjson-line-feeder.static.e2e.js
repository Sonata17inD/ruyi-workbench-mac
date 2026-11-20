#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { readServerSource } = require('./src-reader');

let fail = 0;
const ok = (condition, label) => { if (condition) console.log('PASS ' + label); else { fail++; console.log('FAIL ' + label); } };

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'ruyi-workbench', 'app', 'src');
const readMod = file => fs.readFileSync(path.join(SRC, file), 'utf8');

const boot = readMod('../backend/text-codecs.cjs');
const claudeEngine = readMod('../backend/agent-cli-turn.cjs');
const autonomy = readMod('../backend/claude-subagent.cjs');
const src = [readServerSource(), claudeEngine, autonomy].join('\n');

console.log('\n── [A] 旧缺陷形状在整条逻辑全文里【零命中】──');
// 旧形状: 某变量单独对 chunk 调 toString('utf8') 后再拼接(不经 StringDecoder)。
ok(!/chunk\.toString\(/.test(src), 'A1 全文不再出现 chunk.toString( ——三处逐块 toString 的旧解码形状已清零');
ok(!/\bbuffer\s*\+=\s*chunk\.toString/.test(src), 'A2 05b 原变量名 buffer 的旧拼接形状不再出现');
ok(!/\bstdoutRemainder\s*\+=\s*chunk\.toString/.test(src), 'A3 05/07 原变量名 stdoutRemainder 的旧拼接形状不再出现');

console.log('\n── [B] createNdjsonLineFeeder 只有一份定义,且落在 text-codecs.cjs ──');
const defRe = /function createNdjsonLineFeeder\(onLine\)\s*\{/g;
ok(((src + boot).match(defRe) || []).length === 1, 'B1 整条逻辑全文里 createNdjsonLineFeeder 只定义一次');
ok((boot.match(/function createNdjsonLineFeeder\(onLine\)\s*\{/g) || []).length === 1, 'B2 定义落在 text-codecs.cjs');
for (const [file, body] of [['agent-cli-turn.cjs', claudeEngine], ['claude-subagent.cjs', autonomy]]) {
  ok(!/function createNdjsonLineFeeder\(/.test(body), `B3 ${file} 没有自己复制一份定义(只消费共享解码器)`);
}
ok(/const \{ StringDecoder \} = require\('string_decoder'\);/.test(boot), 'B4 text-codecs.cjs 使用 StringDecoder(createNdjsonLineFeeder 内部依赖它,零新增运行时依赖)');
ok(/decoder\.write\(chunk\)/.test(boot) && /decoder\.end\(\)/.test(boot), 'B5 createNdjsonLineFeeder 内部走 decoder.write/decoder.end,不是逐块 toString');

console.log('\n── [C] 三处调用点都改用了 createNdjsonLineFeeder ──');
ok(/const stdoutFeeder = createNdjsonLineFeeder\(consumeLine\);/.test(claudeEngine), 'C1 agent-cli-turn.cjs 主回合走 createNdjsonLineFeeder(consumeLine)');
ok(/child\.stdout\.on\('data', chunk => \{ stdoutFeeder\.push\(chunk\); \}\);/.test(claudeEngine), 'C2 agent-cli-turn.cjs 的 data 处理器只转发给 feeder');
ok(/stdoutFeeder\.flush\(\);/.test(claudeEngine), 'C3 agent-cli-turn.cjs 收尾调用 flush()');

ok(/const stdoutFeeder = createNdjsonLineFeeder\(consumeLine\);/.test(autonomy), 'C4 claude-subagent.cjs 子代理走 createNdjsonLineFeeder(consumeLine)');
ok(/child\.stdout\.on\('data', chunk => \{ stdoutFeeder\.push\(chunk\); \}\);/.test(autonomy), 'C5 claude-subagent.cjs 的 data 处理器只转发给 feeder');
ok(/closeStdin\(\);\s*stdoutFeeder\.flush\(\);\s*currentChild = null;/.test(autonomy), 'C6 claude-subagent.cjs 的 finish() 在 close/error 收尾里调用 flush()');

console.log('\nNDJSON LINE FEEDER STATIC E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
process.exit(fail ? 1 : 0);
