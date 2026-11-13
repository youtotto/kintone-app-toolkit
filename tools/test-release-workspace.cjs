'use strict';
// Deterministic offline verification. Do not infer failures from words or symbols in UI fixtures.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root=path.resolve(__dirname,'..'), out=path.join(root,'tests/.build/release-check');
fs.mkdirSync(out,{recursive:true});
const built=spawnSync(process.execPath,[path.join(__dirname,'build-release-workspace.cjs'),'--check'],{cwd:root,encoding:'utf8'});
if(built.status!==0) { process.stderr.write(built.stderr||built.stdout);process.exit(1); }
const unitOnly=process.argv.includes('--unit');
const files=fs.readdirSync(path.join(root,'tests')).filter(f=>f.endsWith('.test.js')&&(!unitOnly||!f.endsWith('-browser.test.js'))).sort();
const results=[];
for(const name of files){
  const r=spawnSync(process.execPath,[path.join(root,'tests',name)],{cwd:root,encoding:'utf8',timeout:180000,maxBuffer:16*1024*1024});
  fs.writeFileSync(path.join(out,name+'.log'),(r.stdout||'')+(r.stderr||''));
  const ok=r.status===0&&!r.error;
  results.push({file:name,ok,exitCode:r.status,error:r.error?.message||null});
  process.stdout.write((ok?'PASS ':'FAIL ')+name+'\n');
  if(!ok)process.stderr.write(((r.stdout||'')+(r.stderr||'')).slice(-6000));
}
const hash=crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'kintoneAppToolkit.user.js'))).digest('hex');
const report={bundleSha256:hash,unitOnly,files:results.length,passed:results.filter(r=>r.ok).length,failed:results.filter(r=>!r.ok).length,results};
fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(report,null,2)+'\n');
process.stdout.write(report.passed+'/'+report.files+' files passed; '+report.failed+' failed.\n');
process.exitCode=report.failed?1:0;
