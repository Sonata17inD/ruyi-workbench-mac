'use strict';
const {test,after}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const { createSensitivePaths } = require('../../ruyi-workbench/app/backend/sensitive-paths.cjs');
const { createWorkspaceWriteProtection } = require('../../ruyi-workbench/app/backend/workspace-write-protection.cjs');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'ruyi-bot-vault-guards-'));const data=path.join(root,'data'),alias=path.join(root,'legacy');fs.mkdirSync(data);
after(()=>fs.rmSync(root,{recursive:true,force:true}));
const sensitivePaths = createSensitivePaths({ dataRoot: () => data, dataRootAliases: () => [alias] });
const { isWriteProtectedDataPath } = createWorkspaceWriteProtection(sensitivePaths);
const context = { ...sensitivePaths, isWriteProtectedDataPath };
test('vault and atomic-temp family are equally read/write sensitive through the current root, legacy alias and NTFS suffixes',()=>{
 for(const base of [data,alias])for(const name of ['credential-vault-v1.json','credential-vault-v1.json.123.random.tmp','credential-vault-v1.json::$DATA','external-bot-credentials.json','external-bot-credentials.json.123.random.tmp','external-bot-credentials.json::$DATA','external-bot-credentials.json.','external-bots/state-v1.json','external-bots/state-v1.json.123.random.tmp']){
  const file=path.join(base,name);assert.equal(context.isSensitiveDataPath(file),true,file);assert.equal(context.isWriteProtectedDataPath(file),true,file);
 }
 assert.equal(context.isSensitiveDataPath(path.join(data,'checkpoints','s1','before.txt')),false);assert.equal(context.isSensitiveDataPath(path.join(root,'ordinary.txt')),false);
 assert.equal(context.isSensitiveDataPath(path.join(root,'project','external-bot-credentials.json')),false);assert.equal(context.isWriteProtectedDataPath(path.join(root,'project','external-bots','state-v1.json')),false);
 const globs=context.sensitiveGlobsForRg(root);assert.ok(globs.includes('!/data/external-bot-credentials.json'));assert.ok(globs.includes('!/data/external-bot-credentials.json*'));assert.ok(globs.includes('!/legacy/external-bot-credentials.json*'));
 assert.ok(globs.includes('!/data/external-bots'));assert.ok(globs.includes('!/legacy/external-bots'));
});
test('vault and pending-temp hardlinks cannot evade the existing inode gate; unrelated hardlinks stay readable',async t=>{
 const original=path.join(data,'external-bot-credentials.json'),temp=original+'.123.random.tmp';fs.writeFileSync(original,'encrypted synthetic envelope');fs.writeFileSync(temp,'encrypted synthetic temporary envelope');
 const a=path.join(root,'alias-a'),b=path.join(root,'alias-b'),ordinary=path.join(root,'ordinary'),ordinaryLink=path.join(root,'ordinary-link');fs.writeFileSync(ordinary,'normal user text');
 try{fs.linkSync(original,a);fs.linkSync(temp,b);fs.linkSync(ordinary,ordinaryLink);}catch(error){t.skip('hardlinks unavailable: '+error.code);return;}
 const cv=path.join(data,'credential-vault-v1.json'),cl=path.join(root,'credential-hardlink');fs.writeFileSync(cv,'synthetic encrypted envelope');fs.linkSync(cv,cl);
 const identities=await context.sensitiveFileIdentities();assert.equal(await context.isSensitiveHardlinkStat(await fs.promises.stat(cl,{bigint:true}),identities),true);assert.equal(await context.isSensitiveHardlinkStat(await fs.promises.stat(a,{bigint:true}),identities),true);assert.equal(await context.isSensitiveHardlinkStat(await fs.promises.stat(b,{bigint:true}),identities),true);assert.equal(await context.isSensitiveHardlinkStat(await fs.promises.stat(ordinaryLink,{bigint:true}),identities),false);
 const botDir=path.join(data,'external-bots');fs.mkdirSync(botDir);for(const name of ['state-v1.json','state-v1.json.123.random.tmp']){const source=path.join(botDir,name),link=path.join(root,'hard-'+name);fs.writeFileSync(source,'owner authorization');fs.linkSync(source,link);assert.equal(await context.isSensitiveHardlinkStat(await fs.promises.stat(link,{bigint:true}),await context.sensitiveFileIdentities()),true);}
});

test('credential migration backups are excluded when searching either the parent or data root', () => {
 const file = path.join(data, 'credential-import-v1.json.backup');
 assert.equal(context.isSensitiveDataPath(file), true);
 assert.ok(context.sensitiveGlobsForRg(root).includes('!/data/credential-import-v1.json*'));
 assert.ok(context.sensitiveGlobsForRg(data).includes('!/credential-import-v1.json*'));
 assert.ok(context.sensitiveGlobsForRg(root).includes('!/legacy/credential-import-v1.json*'));
});
