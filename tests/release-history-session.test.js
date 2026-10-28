'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { KTReleaseHistorySession: Module } = require('../src/release-history-session.js');
const clone = x => JSON.parse(JSON.stringify(x));
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return {promise,resolve}; };
function fixture() {
  let payload = {version:1,session:{state:{messages:[{role:'user',text:'元の依頼'}],explanations:[],goal:'依頼'}},draft:'入力中',editor:null};
  let time = 1000, id=0, gate=null, fail=false, access=true, restores=0; const saved=new Map(), statuses=[]; let selected=null;
  const store={
    async prune(){}, async getSelection(){return selected;}, async select(id){selected={id};},
    async save(value,options={}){if(gate){const g=gate;gate=null;await g.promise;}if(fail)throw Object.assign(Error('capacity'),{code:'HISTORY_LIMIT'});const old=saved.get(value.id);if((old?.revision??null)!==value.revision)throw Object.assign(Error('conflict'),{code:'HISTORY_CONFLICT'});const entry={...clone(value),revision:(old?.revision||0)+1,updatedAt:time};saved.set(value.id,entry);if(options.activate!==false)selected={id:entry.id};const{payload,...meta}=entry;return meta;},
    async load(id){return saved.has(id)?clone(saved.get(id)):null;},
    async list(){return [...saved.values()].map(({payload,...meta})=>clone(meta));},async usage(){return {bytes:0,maxBytes:100000,count:saved.size};},
    async remove(id,revision){if(saved.get(id)?.revision!==revision)throw Object.assign(Error('conflict'),{code:'HISTORY_CONFLICT'});saved.delete(id);return true;},close(){}
  };
  const manager=Module.create({store,capture:()=>payload,restore:async value=>{restores++;payload=clone(value);return true;},verifyAccess:async()=>{if(!access)throw Error('access denied');},canSwitch:()=>true,onStatus:s=>statuses.push(s),now:()=>time,makeId:()=>String(++id),debounceMs:1000000});
  return {manager,store,saved,statuses,get payload(){return payload;},set payload(v){payload=v;},set time(v){time=v;},set gate(v){gate=v;},set fail(v){fail=v;},set access(v){access=v;},get restores(){return restores;}};
}
test('save restores complete payload, no action callbacks; view-only selection does not extend expiry',async()=>{
 const f=fixture();await f.manager.flush();const id=f.manager.getCurrent().id;await f.manager.markComplete();const at=f.manager.getCurrent().completedAt;
 f.payload.session.state.explanationId='old-document';f.manager.changed();await f.manager.flush();assert.equal(f.manager.getCurrent().completedAt,at);
 await f.manager.beforeNewTask();f.payload={version:1,session:{state:{messages:[]}},draft:'次',editor:null};await f.manager.flush();assert.equal(await f.manager.open(id),true);assert.equal(f.payload.draft,'入力中');assert.equal(f.restores,1);assert.equal(f.manager.getCurrent().completedAt,at);await f.manager.dispose();
});
test('real edits reopen completed work and unpin starts a fresh 30day origin',async()=>{
 const f=fixture();await f.manager.markComplete();f.payload.draft='修正';await f.manager.flush();assert.equal(f.manager.getCurrent().completedAt,null);
 await f.manager.markComplete();await f.manager.setPinned(f.manager.getCurrent(),true);f.time=2000;await f.manager.setPinned(f.manager.getCurrent(),false);assert.equal(f.manager.getCurrent().completedAt,2000);await f.manager.dispose();
});
test('capacity failure prevents new task and preserves memory + last stored copy',async()=>{
 const f=fixture();await f.manager.flush();const id=f.manager.getCurrent().id;f.payload.draft='大事な修正';f.fail=true;
 assert.equal(await f.manager.beforeNewTask(),false);assert.equal(f.payload.draft,'大事な修正');assert.equal(f.saved.get(id).payload.draft,'入力中');assert.equal(f.manager.getStatus().state,'error');f.fail=false;await f.manager.dispose();
});
test('concurrent save and typing retain newest snapshot; CAS conflicts do not overwrite',async()=>{
 const f=fixture();const gate=deferred();f.gate=gate;const first=f.manager.flush();await new Promise(r=>setImmediate(r));f.payload.draft='保存中の追記';f.manager.changed();gate.resolve();await first;await f.manager.flush();const id=f.manager.getCurrent().id;assert.equal(f.saved.get(id).payload.draft,'保存中の追記');
 f.saved.get(id).revision++;f.payload.draft='競合した手元';await assert.rejects(f.manager.flush(),{code:'HISTORY_CONFLICT'});assert.equal(f.payload.draft,'競合した手元');assert.equal(f.saved.get(id).payload.draft,'保存中の追記');await f.manager.dispose();
});
test('lost access prevents listing/opening and retains active work',async()=>{
 const f=fixture();await f.manager.flush();f.access=false;await assert.rejects(f.manager.list(),/access denied/);assert.equal(await f.manager.open('1'),false);assert.equal(f.restores,0);assert.equal(f.payload.draft,'入力中');await f.manager.dispose();
});
test('active entries cannot be deleted and unpinned active work remains protected',async()=>{
 const f=fixture();await f.manager.flush();await assert.rejects(f.manager.remove(f.manager.getCurrent()),{code:'HISTORY_ACTIVE'});await f.manager.setPinned(f.manager.getCurrent(),true);await f.manager.setPinned(f.manager.getCurrent(),false);assert.equal(f.manager.getCurrent().completedAt,null);await f.manager.dispose();
});

test('dispose captures editor synchronously before UI teardown',async()=>{
 const f=fixture();f.payload.editor={version:1,active:'pc',files:[{text:'latest edit'}]};const finish=f.manager.dispose();f.payload.editor=null;await finish;assert.equal([...f.saved.values()][0].payload.editor.files[0].text,'latest edit');
});
test('edits to an expired open conversation save under a new identity',async()=>{
 const f=fixture();await f.manager.markComplete();const id=f.manager.getCurrent().id;
 f.saved.get(id).expiresAt=1100;
 // Model the store's expiry metadata on the open entry.
 await f.manager.beforeNewTask();f.payload={version:1,session:{state:{messages:[]}},draft:'',editor:null};await f.manager.open(id);
 f.time=1200;f.saved.delete(id);f.payload.draft='期限後に再開';await f.manager.flush();
 assert.notEqual(f.manager.getCurrent().id,id);assert.equal(f.manager.getCurrent().completedAt,null);assert.equal([...f.saved.values()][0].payload.draft,'期限後に再開');await f.manager.dispose();
});


test('editing during history load cancels switching and retains the edit for the next save',async()=>{
 const f=fixture();await f.manager.flush();const first=f.manager.getCurrent().id;
 await f.manager.beforeNewTask();f.payload.draft='開く先';await f.manager.flush();const second=f.manager.getCurrent().id;
 await f.manager.open(first);
 const load=f.store.load,gate=deferred(),started=deferred();f.store.load=async id=>{started.resolve();await gate.promise;return load(id);};
 const opening=f.manager.open(second);await started.promise;f.payload.draft='読込中の大事な追記';f.manager.changed();gate.resolve();
 assert.equal(await opening,false);assert.equal(f.payload.draft,'読込中の大事な追記');assert.equal(f.manager.getCurrent().id,first);
 await f.manager.flush();assert.equal(f.saved.get(first).payload.draft,'読込中の大事な追記');await f.manager.dispose();
});

test('new task does not discard typing made during the save it waits for',async()=>{
 const f=fixture();await f.manager.flush();const id=f.manager.getCurrent().id;
 const gate=deferred();f.gate=gate;f.payload.draft='保存を待つ';
 const switching=f.manager.beforeNewTask();await new Promise(r=>setImmediate(r));f.payload.draft='保存中にさらに追記';f.manager.changed();gate.resolve();
 assert.equal(await switching,false);assert.equal(f.manager.getCurrent().id,id);assert.equal(f.payload.draft,'保存中にさらに追記');
 await f.manager.flush();assert.equal(f.saved.get(id).payload.draft,'保存中にさらに追記');await f.manager.dispose();
});

test('a user change during storage load cannot reveal the saved conversation',async()=>{
 const f=fixture();await f.manager.flush();
 const gate=deferred(),started=deferred(),load=f.store.load;f.store.load=async id=>{started.resolve();await gate.promise;return load(id);};
 const opening=f.manager.open(f.manager.getCurrent().id);await started.promise;f.access=false;gate.resolve();
 assert.equal(await opening,false);assert.equal(f.restores,0);assert.equal(f.payload.draft,'入力中');f.access=true;await f.manager.dispose();
});

test('clearing the only draft saves the empty state instead of reviving deleted text',async()=>{
 const f=fixture();f.payload={version:1,session:{state:{messages:[]}},draft:'後で消す下書き',editor:null};await f.manager.flush();const id=f.manager.getCurrent().id;
 f.payload.draft='';await f.manager.flush();assert.equal(f.saved.get(id).payload.draft,'');assert.equal(f.manager.isDirty(),false);
 await f.manager.beforeNewTask();f.payload.draft='別の会話';await f.manager.flush();await f.manager.open(id);assert.equal(f.payload.draft,'');await f.manager.dispose();
});

test('viewing a registered file does not restart completed work or create empty conversations',async()=>{
 const f=fixture();await f.manager.markComplete();const at=f.manager.getCurrent().completedAt;
 f.payload.editor={version:1,active:'pc',files:[{name:'existing.js',text:'original',registeredText:'original'}]};await f.manager.flush();assert.equal(f.manager.getCurrent().completedAt,at);
 f.payload.editor.files[0].text='a real edit';await f.manager.flush();assert.equal(f.manager.getCurrent().completedAt,null);await f.manager.dispose();
 const empty=fixture();empty.payload={version:1,session:{state:{messages:[]}},draft:'',editor:{version:1,active:'pc',files:[{text:'original',registeredText:'original'}]}};
 await empty.manager.flush();assert.equal(empty.manager.getCurrent(),null);await empty.manager.dispose();
});
