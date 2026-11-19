'use strict';
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');

// -z keeps filenames literal, including tabs, newlines and non-ASCII bytes.
async function* nulRecords(stream) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  for await (const bytes of stream) {
    pending += decoder.write(bytes);
    let end;
    while ((end = pending.indexOf('\0')) !== -1) {
      yield pending.slice(0, end);
      pending = pending.slice(end + 1);
    }
  }
  pending += decoder.end();
  if (pending) throw new Error('Truncated Git NUL record');
}

function parseEolRecord(record) {
  const tab = record.indexOf('\t');
  const match = /^i\/(\S+)\s+w\/(\S*)\s+attr\/(\S+)(?:\s+eol=(\S+))?\s*$/.exec(record.slice(0, tab));
  if (tab < 0 || !match || !record.slice(tab + 1)) throw new Error('Invalid Git EOL record');
  return { index: match[1], worktree: match[2], attr: match[3], eol: match[4] || '', file: record.slice(tab + 1) };
}

async function* trackedEol(root) {
  const child = spawn('git', ['ls-files', '--eol', '-z'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-4096); });
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`git ls-files failed (${code}): ${stderr}`)));
  });
  // Attach immediately, including when the executable cannot be spawned.
  completion.catch(() => {});
  try {
    for await (const record of nulRecords(child.stdout)) yield parseEolRecord(record);
    await completion;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}
module.exports = { nulRecords, parseEolRecord, trackedEol };
