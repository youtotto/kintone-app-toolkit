'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
const source=fs.readFileSync(path.join(__dirname,'../extension/compare-tests.cjs'),'utf8');
function compare(results,files=['fixture.test.js']) {
 return new Promise((resolve,reject)=>{
  let index=0;
  const fakeFs={existsSync:()=>true,readdirSync:()=>files,writeFileSync:()=>{}};
  const spawn=()=>{const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{};const r=results[index++];queueMicrotask(()=>{child.stdout.emit('data',r.output);child.emit('close',r.code);});return child;};
  const context={require:name=>name==='node:fs'?fakeFs:name==='node:child_process'?{spawn}:require(name),__dirname:path.join(__dirname,'../extension'),process:{env:{},argv:['node','compare-tests.cjs'],execPath:process.execPath,exit:code=>resolve(code)},console:{log:()=>{},error:()=>{}},setTimeout,clearTimeout};
  try{vm.runInNewContext(source,context);}catch(e){reject(e);}
 });
}
const pass={code:0,output:'PASS: fixture\n'},fail={code:1,output:'FAIL: fixture\n'};
test('両方で同じ失敗が起きても比較を成功扱いしない',async()=>assert.equal(await compare([fail,fail]),1));
test('片方だけ失敗した比較は成功扱いしない',async()=>assert.equal(await compare([pass,fail]),1));
test('両方で合格した比較だけ成功する',async()=>assert.equal(await compare([pass,pass]),0));
test('対象テストがゼロの比較は成功扱いしない',async()=>assert.equal(await compare([],[]),1));
