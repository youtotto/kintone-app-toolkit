'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {KTReleaseContext:C} = require('../src/release-context.js');
const {KTReleaseView:View} = require('../src/release-view.js');
const {KTReleaseWorkspace:Workspace} = require('../src/release-workspace.js');
const {fixture, proposal} = require('./helpers/release-workspace-fixture.js');
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
  const unavailable=await C.withIncomingLookups(input,assert.fail,null);
  assert.deepEqual(unavailable.base.lookupEvidence,{candidates:[],partial:true,scannedAt:null});
});

test('調査機能がない場合と参照元が読めない場合は未調査と伝え、画面に使う事実を保つ', async () => {
  const noScanner = await C.withIncomingLookups(input,assert.fail,null);
  const denied = await C.withIncomingLookups(input,async()=>{throw Error('unavailable')},
    {loadCache:()=>({scannedAt:'2026-11-25',rows:[row('1')]})});
  for (const enriched of [noScanner,denied]) {
    const results = [C.proposal(enriched),C.plan({...enriched,proposal:{},version:1,goal:input.text})];
    for (const payload of results) {
      const fact = payload.facts.find(f=>f.kind==='incoming-lookup');
      assert.equal(fact.confidence,'NOT_ANALYZED');
      assert.match(fact.statement,/未確認/);
      assert.deepEqual(fact.value.candidates,[]);
      assert.equal(fact.value.partial,true);
    }
  }
});

test('全範囲を調べて候補が見つからなかった結果を未調査と区別する', async () => {
  const empty = await C.withIncomingLookups(input,assert.fail,
    {loadCache:()=>({scannedAt:'2026-11-25',rows:[]})});
  const fact = C.proposal(empty).facts.find(f=>f.kind==='incoming-lookup');
  assert.equal(fact.confidence,'CERTAIN');
  assert.equal(fact.value.partial,false);
  assert.deepEqual(fact.value.candidates,[]);
});

const candidate = (appName, appId, code = 'selected', label = '商品選択') => ({
  appId, appName, local:{code:'sku',label:'商品コード'}, remote:{code,label}
});
const lookupFact = (candidates, partial = false) => ({
  kind:'incoming-lookup', value:{candidates,partial}
});
function draft({ facts, standard = [], decisions = [], followup = [], legacy = false }) {
  return View.render({ phase:'proposal', taskId:1, version:1, runs:[],
    proposal:{behaviors:[{id:'B1',text:'現在の関連レコード一覧で最近の受注を表示する',origin:'user'}],
      decisions,approach:{standard,js:[]}},
    messages:[{role:'assistant',text:'既存の受注履歴を使う案です。',facts,...(legacy ? {} : {proposalVersion:1})},...followup]
  });
}

test('既存一覧を提案しても仮案に参照先・照合項目の組が無ければ未確定を表示する', () => {
  const html = draft({facts:[lookupFact([candidate('店舗受注','467')])],
    standard:['既存の受注履歴に作成日時を追加する。']});
  assert.match(html, /<h3>未確定の事項<\/h3>/);
  assert.match(html, /参照先アプリと両側の照合項目/);
  assert.match(html, /店舗受注.*商品コード.*商品選択/);
});

test('候補なし・読み取り未確認でも仮案に未確定の一覧を残す', () => {
  for (const partial of [false,true]) {
    const html = draft({facts:[lookupFact([],partial)]});
    assert.match(html, /<h3>未確定の事項<\/h3>/);
    assert.match(html, /参照先アプリ名と、照合する両方の項目/);
  }
});

test('仮案の説明が別の返答で続いても、旧履歴と現在の履歴の両方で未確定欄を保持する', () => {
  for (const legacy of [false,true]) {
    const html = draft({facts:[lookupFact([candidate('店舗受注','467')])],legacy,
      followup:[{role:'assistant',text:'表示順の説明のみです。',facts:[]}]});
    assert.match(html, /<h3>未確定の事項<\/h3>/);
  }
});

test('根拠と一致する完全な照合の組を明記した案や通常相談には未確定欄を追加しない', () => {
  const cases = [draft({facts:[lookupFact([candidate('店舗受注','467')])],
    standard:['現在のアプリの「商品コード」と「店舗受注」の「商品選択」を照合する。']}),
    draft({facts:[{kind:'environment',value:{}}]})];
  for(const html of cases) assert.doesNotMatch(html, /<h3>未確定の事項<\/h3>/);
});

test('別の候補の項目、候補としての記載、参照先の確認質問は未確定とする', () => {
  const facts = [lookupFact([candidate('店舗受注','467'),candidate('通販受注','468','orderSku','注文商品')])];
  const chosen = '商品コードと「店舗受注」の「商品選択」を照合する。';
  const cases = [draft({facts,standard:['商品コードと「店舗受注」の「注文商品」を照合する。']}),
    draft({facts,standard:['現在のアプリの商品選択と「店舗受注」の「商品コード」を照合する。']}),
    draft({facts,standard:['候補では、' + chosen]}),
    draft({facts,standard:['変更前は、' + chosen]}),
    draft({facts,standard:[chosen,'商品コードと「通販受注」の「注文商品」を照合する。']}),
    draft({facts,standard:[chosen],decisions:[{id:'Q1',question:'どの項目でひも付けますか？'}]})];
  for(const html of cases) assert.match(html, /<h3>未確定の事項<\/h3>/);
});

test('相談の通常経路で未確定欄が出て、質問への返答と会話の開き直しでも維持する', async () => {
  const response = proposal('既存の関連レコード一覧を使う案です。');
  response.proposal = {behaviors:[{id:'B1',text:'既存の関連レコード一覧で最近の受注を表示する',origin:'user'}],
    decisions:[],approach:{standard:['作成日時を表示する。'],js:[]}};
  response.facts = [lookupFact([candidate('店舗受注','467')])];
  const f = fixture(Workspace,{propose:() => response});
  assert.equal(await f.controller.send(input.text),true);
  assert.match(View.render(f.controller.getState()), /<h3>未確定の事項<\/h3>/);
  f.services.propose = async () => ({reply:'表示順は新しい順です。',intent:'question',proposalUnchanged:true,facts:[]});
  assert.equal(await f.controller.send('並び順はどうなりますか？'),true);
  const reopened = fixture(Workspace);
  assert.equal(await reopened.controller.restoreSession(f.controller.exportSession()),true);
  assert.match(View.render(reopened.controller.getState()), /<h3>未確定の事項<\/h3>/);
  assert.equal(f.count('plan'),0);
  assert.equal(reopened.count('propose'),0);
  assert.equal(f.writes.length,0);
  assert.equal(reopened.writes.length,0);
});
