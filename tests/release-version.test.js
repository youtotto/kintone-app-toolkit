'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),target=path.join(root,'kintoneAppToolkit.user.js');
const builder=path.join(root,'tools/build-release-workspace.cjs');
const code=fs.readFileSync(target,'utf8'),version=code.match(/^\/\/ @version\s+(\S+)$/m)[1];
// Run the actual builder with in-memory file overrides: no disk writes or network.
function build({source=code,notes,check=false}={}){
  let output;
  const fakeFs={readFileSync(file,encoding){
    if(file===target)return source;
    if(notes!==undefined&&file===path.join(root,'docs','RELEASE-NOTES-'+version+'.md'))return notes;
    return fs.readFileSync(file,encoding);
  },writeFileSync(file,value){assert.equal(file,target);output=value;}};
  vm.runInNewContext(fs.readFileSync(builder,'utf8'),{
    __dirname:path.dirname(builder),require(name){return name==='node:fs'?fakeFs:require(name);},
    process:{argv:check?['node',builder,'--check']:['node',builder],stdout:{write(){}}}
  },{filename:builder});
  return output;
}
test('配布物・表示・ビルド識別子・リリースノートの版が一致する',()=>{
  assert.equal(code.match(/const SCRIPT_VERSION = '([^']+)';/)[1],version);
  assert.equal(code.match(/const KT_BUILD = '([^']+)';/)[1],version);
  assert.equal(fs.readFileSync(path.join(root,'docs','RELEASE-NOTES-'+version+'.md'),'utf8').split(/\r?\n/)[0],'# kintone App Toolkit '+version);
  assert.ok(code.includes("setAttribute('data-kt-build', KT_BUILD)"),'実機照合属性にKT_BUILDを使う');
  assert.ok(build()===code.replace(/\r\n/g,'\n'),'再ビルドで変更が生じない');
});
test('KT_BUILDが旧版ならビルドで更新し、checkだけでは不一致を拒否する',()=>{
  const source=code.replace(/const KT_BUILD = '[^']*';/,"const KT_BUILD = '0.0.0';");
  assert.ok(build({source})===code.replace(/\r\n/g,'\n'),'KT_BUILD以外は変わらない');
  assert.throws(()=>build({source,check:true}),/Rebuild the release workspace/);
});
test('表示版と配布版の不一致はビルド時に拒否する',()=>{
  assert.throws(()=>build({source:code.replace(/const SCRIPT_VERSION = '[^']*';/,"const SCRIPT_VERSION = '0.0.0';")}),/@version and SCRIPT_VERSION must match/);
});
test('リリースノートの版違いはビルド時に拒否する',()=>{
  assert.throws(()=>build({notes:'# kintone App Toolkit 0.0.0\n'}),/Release notes version must match/);
});
test('ビルド識別子の宣言が欠落・重複したら黙って通さない',()=>{
  assert.throws(()=>build({source:code.replace(/^  const KT_BUILD = '[^']*';\r?\n/m,'')}),/exactly one KT_BUILD/);
  assert.throws(()=>build({source:code+"\n  const KT_BUILD = '0.0.0';\n"}),/exactly one KT_BUILD/);
});
