'use strict';
// Exercises the production Mac envelope/vault with an ephemeral key provider.
// No system Keychain access. Parent and child hosts share only this fixture helper.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
function createIsolatedKeychain(root) {
  const helper = path.join(root, 'fixture-keychain-helper');
  const key = crypto.randomBytes(32).toString('base64');
  fs.writeFileSync(helper, `#!${process.execPath}\n'use strict';\nlet body='';process.stdin.setEncoding('utf8');process.stdin.on('data',part=>body+=part);process.stdin.on('end',()=>{let request;try{request=JSON.parse(body);}catch{process.exit(1);}if(request.version!==1||!['get','get-or-create'].includes(request.op))process.exit(1);process.stdout.write(JSON.stringify({ok:true,value:${JSON.stringify(key)}}));});\n`, { mode: 0o700, flag: 'wx' });
  return helper;
}
module.exports = { createIsolatedKeychain };
