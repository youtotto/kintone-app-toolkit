'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { loadToolkit } = require('./helpers/load-toolkit.js');
const FX = require('./fixtures/ai-context-app.js');
function fixture() {
  const values = new Map(), storage = { getItem:k=>values.get(k)||null, setItem:(k,v)=>values.set(k,String(v)), removeItem:k=>values.delete(k) };
  const T = loadToolkit({localStorage:storage});
  let user = {id:'A',code:'alice'}, calls = 0;
  T.__sandbox.kintone = {getLoginUser:()=>user};
  T.KTApi.getAppList = async () => {calls++;return [{appId:'2',name:'Restricted app'}];};
  T.KTApi.getFormFieldsOf = async () => ({properties:{lookup:{code:'lookup',label:'Restricted field',lookup:{relatedApp:{app:'1'},relatedKeyField:'key',fieldMappings:[]}}}});
  T.KTApi.getActionsOf = async () => ({actions:{}});
  return {T,values,setUser:v=>{user=v;},get calls(){return calls;}};
}
test('incoming cache separates A/B/A accounts and apps, while reusing the same account',async()=>{
  const f=fixture(), incoming=f.T.KTIncoming;
  await incoming.run('1',{force:true});
  assert.equal((await incoming.run('1')).fromCache,true);assert.equal(f.calls,1);
  f.setUser({id:'B',code:'bob'});
  assert.equal(incoming.loadCache('1'),null);
  f.T.KTApi.getAppList=async()=>[];
  assert.equal((await incoming.run('1')).rows.length,0);
  f.setUser({id:'A',code:'alice'});
  assert.equal(incoming.loadCache('1').rows[0].appName,'Restricted app');
  assert.equal(incoming.loadCache('3'),null);
  incoming.clearCache('1');assert.equal(incoming.loadCache('1'),null);
  f.setUser({id:'B',code:'bob'});assert.ok(incoming.loadCache('1'));
});
test('unscoped v1/v2 entries are discarded, never inherited by a logged-in user',()=>{
  const f=fixture();
  for(const version of ['v1','v2']) f.values.set('ktIncoming.'+version+'.1',JSON.stringify({rows:[{appName:'Private'}],scannedAt:new Date().toISOString()}));
  assert.equal(f.T.KTIncoming.loadCache('1'),null);assert.equal(f.values.size,0);
});
test('unknown identity cannot read or create persistent reference caches',async()=>{
  const f=fixture();await f.T.KTIncoming.run('1');const prior=f.values.size;
  f.setUser(null);assert.equal(f.T.KTIncoming.loadCache('1'),null);
  assert.equal((await f.T.KTIncoming.run('1')).fromCache,false);assert.equal(f.values.size,prior);
  f.T.__sandbox.kintone.getLoginUser=()=>{throw Error('unavailable');};
  assert.equal(f.T.KTIncoming.loadCache('1'),null);
});
test('an account switch during a scan neither returns nor stores another account result',async()=>{
  const f=fixture();f.T.KTApi.getFormFieldsOf=async()=>{f.setUser({id:'B'});return {properties:{}};};
  await assert.rejects(f.T.KTIncoming.run('1',{force:true}),/ログインユーザー/);
  assert.equal(f.values.size,0);
});
test('expired or invalid cache timestamps trigger a fresh scan',async()=>{
  const f=fixture();await f.T.KTIncoming.run('1');const key=[...f.values.keys()][0];
  for(const scannedAt of ['invalid',new Date(Date.now()-25*60*60*1000).toISOString()]){
    const data=JSON.parse(f.values.get(key));data.scannedAt=scannedAt;f.values.set(key,JSON.stringify(data));
    assert.equal(f.T.KTIncoming.loadCache('1'),null);await f.T.KTIncoming.run('1');
  }
});
test('action failures remain partial coverage in results, field impact and AI materials',async()=>{
  const f=fixture();
  f.T.KTApi.getActionsOf=async()=>{throw Object.assign(Error('permission denied'),{status:403});};
  const result=await f.T.KTIncoming.run('1',{force:true,includeActions:true});
  assert.equal(result.rows.length,1,'successful lookup evidence is retained');
  assert.equal(result.stats.failedApps,1);assert.equal(result.stats.actionsFailedApps,1);
  assert.equal(result.errors[0].what,'actions');
  const data=FX.makeData(), deps=f.T.KTDeps.buildDependencyData(data,f.T.KTDeps.normalizeFields(data.fields));
  f.T.KTDeps.applyIncomingRefs(deps,result);
  const code=f.T.KTDeps.normalizeFields(data.fields).find(x=>x.type!=='SUBTABLE').code;
  assert.match(f.T.KTDeps.impactOf(deps,code).cautions.join('\n'),/確認できていない/);
  const ctx=f.T.KTContext.build({question:null,data,deps,incoming:result});
  assert.equal(ctx.app.incoming.failedApps,1);assert.equal(ctx.app.incoming.actionsFailedApps,1);
  assert.match(JSON.stringify(ctx.coverage),/アプリアクション/);
});
test('normal scans succeed, field failures are recorded, and disabled action scans are explicit',async()=>{
  const f=fixture();assert.equal((await f.T.KTIncoming.run('1')).stats.failedApps,0);
  f.T.KTApi.getFormFieldsOf=async()=>{throw Error('offline');};
  const failed=await f.T.KTIncoming.run('1',{force:true});
  assert.equal(failed.stats.failedApps,1);assert.equal(failed.errors[0].what,'fields');
  let actions=0;f.T.KTApi.getFormFieldsOf=async()=>({properties:{}});f.T.KTApi.getActionsOf=async()=>{actions++;return {actions:{}};};
  assert.equal((await f.T.KTIncoming.run('1',{force:true,includeActions:false})).stats.includeActions,false);
  assert.equal(actions,0);
  assert.equal((await f.T.KTIncoming.run('1',{includeActions:true})).fromCache,false,'a fields-only cache cannot satisfy an action scan');assert.equal(actions,1);
});
test('500-app cap is preserved with or without self; a smaller complete list has no warning',async()=>{
  const f=fixture();
  for(const [count,self,expected] of [[500,'1',true],[500,'999',true],[499,'1',false]]){
    f.T.KTApi.getAppList=async()=>Array.from({length:count},(_,i)=>({appId:String(i+1),name:'App'}));
    const result=await f.T.KTIncoming.run(self,{force:true});
    assert.equal(result.stats.truncated,expected);assert.equal(result.stats.scannedApps,count-(self==='1'?1:0));
  }
});
