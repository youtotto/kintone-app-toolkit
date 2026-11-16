'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm');
const clone=value=>JSON.parse(JSON.stringify(value));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture(){
  const counts={parse:0,stringify:0},box={module:{exports:{}},setTimeout,clearTimeout,JSON:{parse(...args){counts.parse++;return JSON.parse(...args);},stringify(...args){counts.stringify++;return JSON.stringify(...args);}}};
  const source=['release-utils.js','release-history-session.js'].map(file=>fs.readFileSync(require.resolve('../src/'+file),'utf8')).join('\n');
  vm.runInNewContext(source,box);
  let payload={session:{state:{messages:[{role:'user',text:'保存する会話'}],explanationId:'A',resultRunId:null}},draft:'下書き',editor:{version:1,active:'one',files:[{name:'one',text:'before',registeredText:'before',viewState:{line:1}},{name:'two',text:'edited',registeredText:'before',viewState:{line:2}}]}},saved=null,accessGate=null;
  const writes=[];
  const store={async save(input){writes.push(clone(input));saved={...clone(input),revision:(saved?.revision||0)+1};const {payload,...meta}=saved;return meta;},async select(){},close(){}};
  const manager=box.module.exports.KTReleaseHistorySession.create({store,capture:()=>payload,restore:async()=>true,verifyAccess:async()=>{if(accessGate){const gate=accessGate;accessGate=null;gate.started.resolve();await gate.release.promise;}},makeId:()=> 'one',now:()=>1000,debounceMs:100000});
  return {manager,counts,writes,get payload(){return payload;},set payload(value){payload=value;},pause(){accessGate={started:deferred(),release:deferred()};return accessGate;}};
}
test('unchanged history flush does not reparse the conversation or rewrite storage',async t=>{
  const f=fixture();t.after(()=>f.manager.dispose());await f.manager.flush();
  f.counts.parse=0;f.counts.stringify=0;
  await f.manager.flush();
  assert.equal(f.counts.parse,0,'No allocation of a duplicate snapshot when content is unchanged');
  assert.equal(f.counts.stringify,1,'One complete comparison still detects edits without notifications');
  assert.equal(f.writes.length,1);
});
test('edits during permission checking preserve the saved snapshot and remain pending even without changed()',async t=>{
  const f=fixture();t.after(()=>f.manager.dispose());const gate=f.pause(),saving=f.manager.flush();
  await gate.started.promise;f.payload.draft='保存中の追記';f.payload.session.state.messages[0].text='変更後';gate.release.resolve();await saving;
  assert.equal(f.writes[0].payload.draft,'下書き');assert.equal(f.writes[0].payload.session.state.messages[0].text,'保存する会話');assert.equal(f.manager.isDirty(),true);
  await f.manager.flush();assert.equal(f.writes[1].payload.draft,'保存中の追記');assert.equal(f.manager.isDirty(),false);
});
test('display-only edits are saved without reopening completed work; meaningful editor edits reopen it',async t=>{
  const f=fixture();t.after(()=>f.manager.dispose());await f.manager.flush();await f.manager.markComplete();
  f.payload.session.state.explanationId='B';f.payload.session.state.resultRunId='result';f.payload.editor.active='two';f.payload.editor.files[1].viewState.line=9;
  const before=clone(f.payload);await f.manager.flush();assert.deepEqual(f.payload,before,'signature projection must not mutate caller data');
  assert.equal(f.writes.at(-1).completedAt,1000);assert.deepEqual(f.writes.at(-1).payload,before);
  f.payload.editor.files[1].text='さらに編集';await f.manager.flush();assert.equal(f.writes.at(-1).completedAt,null);
});
test('rapid queued saves persist the newest content and skip duplicate snapshots',async t=>{
  const f=fixture();t.after(()=>f.manager.dispose());await f.manager.flush();
  const gate=f.pause();f.payload.draft='first';const a=f.manager.flush();await gate.started.promise;
  f.payload.draft='latest';const b=f.manager.flush(),c=f.manager.flush();gate.release.resolve();await Promise.all([a,b,c]);
  assert.deepEqual(f.writes.map(w=>w.payload.draft),['下書き','first','latest']);assert.equal(f.manager.isDirty(),false);
});
