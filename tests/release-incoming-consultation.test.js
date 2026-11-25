'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {KTReleaseContext:C} = require('../src/release-context.js');
const input = {text:'商品ごとに最近の受注を見たい',base:{
  ok:true,appId:'466',env:'preview',data:{fields:{sku:{code:'sku',label:'商品コード',type:'SINGLE_LINE_TEXT'}}}
}};
const remote = {code:'selected',label:'商品選択',type:'SINGLE_LINE_TEXT'};
const row = appId => ({appId,appName:'受注'+appId,kind:'ルックアップ',sourceField:'selected',targetField:'sku'});
for (const count of [0,1,2]) {
  test('相談と採用計画に確認済みの照合候補を渡す: '+count,async()=>{
    const rows=['1','2'].slice(0,count).map(row);
    const incoming={loadCache:()=>({scannedAt:'2026-11-25',rows}),analyzeApp:app=>[row(app.appId)]};
    const enriched=await C.withIncomingLookups(input,async(route)=>{
      assert.equal(route,'/k/v1/app/form/fields.json');return {properties:{selected:remote}};
    },incoming);
    for (const payload of [C.proposal(enriched),C.plan({...enriched,proposal:{},version:1,goal:input.text})]) {
      const fact=payload.facts.find(f=>f.kind==='incoming-lookup');
      assert.equal(fact.value.candidates.length,count);
      for(const c of fact.value.candidates){assert.equal(c.local.code,'sku');assert.equal(c.remote.code,'selected');}
    }
  });
}
test('一般相談では走査せず、読めない参照元は未確認として返す',async()=>{
  const normal={...input,text:'フィールドを追加したい'};
  assert.equal(await C.withIncomingLookups(normal,assert.fail,{}),normal);
  const incoming={loadCache:()=>({scannedAt:'2026-11-25',rows:[row('1')]})};
  const result=await C.withIncomingLookups(input,async()=>{throw Error('unavailable')},incoming);
  assert.deepEqual(result.base.lookupEvidence.candidates,[]);
  assert.equal(result.base.lookupEvidence.partial,true);
});
