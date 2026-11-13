'use strict';
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const out = __dirname;
const root = '/Users/jiming/Documents/ruyi-workbench-mac';
const { buildMacProcessHelper } = require(path.join(root, 'ruyi-workbench/tools/build-macos-process-helper.js'));
const helper = buildMacProcessHelper(path.join(out, 'ruyi-process-helper'));
const pause = ms => new Promise(r => setTimeout(r, ms));
const ps = () => cp.execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,time=,rss=,comm='], { encoding: 'utf8' }).trim().split('\n').map(s => {const m=s.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.+)$/);return m&&{pid:+m[1],ppid:+m[2],cpu:m[3],rssKB:+m[4],command:m[5]};}).filter(Boolean);
const seconds = s => s.split(':').reduce((a,n)=>a*60+Number(n),0);
async function run(supervised) {
  const child = cp.spawn(supervised?helper:'/bin/sleep', supervised?['--supervise-v2','/bin/sleep','14']:['14'], {stdio:supervised?['ignore','ignore','ignore','pipe']:'ignore'});
  const frames=[];
  if(supervised) child.stdio[3].on('data', b=>frames.push(b.toString()));
  const done=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));
  await pause(1000);
  const table=ps();const ids=new Set([child.pid]);let changed=true;while(changed){changed=false;for(const row of table)if(ids.has(row.ppid)&&!ids.has(row.pid)){ids.add(row.pid);changed=true;}}
  const before=table.filter(p=>ids.has(p.pid));const started=performance.now();
  await pause(10000);
  const after=ps().filter(p=>ids.has(p.pid));const durationSec=(performance.now()-started)/1000;
  const rows=after.map(p=>({...p,deltaCpuSec:seconds(p.cpu)-seconds(before.find(b=>b.pid===p.pid)?.cpu||'0')}));
  const exit=await done;
  return {supervised,durationSec,rows,totalCpuSec:rows.reduce((a,r)=>a+r.deltaCpuSec,0),exit,frames:frames.join(''),remainingPids:ps().filter(p=>ids.has(p.pid)).map(p=>p.pid)};
}
(async()=>{const results=[];for(const mode of [false,true,true])results.push(await run(mode));const report={sourceCommit:cp.execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),node:process.version,platform:process.platform,arch:process.arch,systemProcessCount:ps().length,method:'same-source -O2 helper; direct sleep control then two supervised sleep runs; 1s warmup + 10s measured interval; ps cumulative CPU resolution 0.01s; no power measurement',results};fs.writeFileSync(path.join(out,'process-cost.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));})().catch(e=>{console.error(e);process.exitCode=1});
