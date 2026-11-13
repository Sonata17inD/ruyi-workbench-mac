import subprocess,pathlib,json,re,collections,hashlib
root=pathlib.Path('/Users/jiming/Documents/ruyi-workbench-mac')
paths=subprocess.check_output(['git','ls-files','-z'],cwd=root).decode().split('\0');paths=[x for x in paths if x]
win=re.compile(r'win32|windows|powershell|cmd\.exe|explorer\.exe|\.exe\b|\.cmd\b|\.bat\b|dpapi|appdata',re.I)
src_ext={'.js','.cjs','.mjs','.py','.m','.h','.c','.swift','.cs','.ps1','.cmd','.bat'}
rows=[];groups=collections.defaultdict(lambda:{'files':0,'bytes':0}); product=[]
for name in paths:
 p=root/name
 if not p.is_file():continue
 b=p.read_bytes();group=name.split('/')[0];groups[group]['files']+=1;groups[group]['bytes']+=len(b)
 if not (name.startswith('ruyi-workbench/') or name.startswith('mcp/') or name.startswith('.github/')):continue
 text=b.decode('utf-8',errors='replace');lines=text.splitlines();code=p.suffix in src_ext
 row={'path':name,'bytes':len(b),'lines':len(lines),'sha256':hashlib.sha256(b).hexdigest(),'windowsMentionLines':[i+1 for i,s in enumerate(lines) if win.search(s)],'code':code,'generated':name=='ruyi-workbench/app/server.js' or '/vendor/' in name}
 if code and not row['generated']:
  row['intervalLines']=[i+1 for i,s in enumerate(lines) if 'setInterval(' in s or 'Timer.scheduledTimer' in s]
  row['syncProcessLines']=[i+1 for i,s in enumerate(lines) if re.search(r'\b(?:spawnSync|execFileSync|execSync)\s*\(',s) and not s.strip().startswith('//')]
 product.append(row)
summary={'sourceCommit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root).decode().strip(),'trackedFileCount':len(paths),'groups':dict(groups),'productFiles':len(product),'productSourceFiles':sum(x['code'] and not x['generated'] for x in product),'sourceWindowsMentionFiles':sum(x['code'] and not x['generated'] and bool(x['windowsMentionLines']) for x in product),'sourceWindowsMentionLines':sum(len(x['windowsMentionLines']) for x in product if x['code'] and not x['generated']),'backendModules':len(json.loads((root/'ruyi-workbench/app/src/manifest.json').read_text())['modules']),'backendGeneratedLines':len((root/'ruyi-workbench/app/server.js').read_bytes().splitlines()),'note':'keyword matches include comments, data and fixtures; not proof of dead code or runtime cost'}
pathlib.Path('/tmp/ruyi-mac-audit-20261113/inventory.json').write_text(json.dumps({'summary':summary,'files':product},ensure_ascii=False,indent=2)+'\n');print(json.dumps(summary,ensure_ascii=False,indent=2))
