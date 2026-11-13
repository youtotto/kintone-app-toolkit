'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {KTBusinessView:V}=require('../src/release-business-view.js');
const s={evidence:[{kind:'field',value:{code:'case',label:'検証ケース'}},{kind:'field',value:{code:'amount',label:'金額'}}]};
test('AND / NOT LIKE and OR retain their different meaning',()=>{
 assert.equal(V.readableCondition('case like "承認" and case not like "保留"',s),'「検証ケース」に「承認」を含む かつ 「検証ケース」に「保留」を含まない');
 assert.equal(V.readableCondition('case = "要修正" or case = "差戻希望"',s),'「検証ケース」が「要修正」と等しい または 「検証ケース」が「差戻希望」と等しい');
});
test('grouping and numeric boundaries are retained',()=>{
 assert.equal(V.readableCondition('(amount >= 10 and amount < 20) or amount = 30',s),'（（「金額」が10以上 かつ 「金額」が20より小さい）） または 「金額」が30と等しい');
 assert.equal(V.readableCondition('amount < -0.5',s),'「金額」が-0.5より小さい');
});
test('quoted field names, operators and escapes are literal data',()=>{
 const value='case and not like "承認" \\ <script>';
 const raw='case = '+JSON.stringify(value);
 assert.equal(V.readableCondition(raw,s),'「検証ケース」が「'+value+'」と等しい');
 const html=V.conditionHtml(raw,s);assert.ok(!html.includes('<script>'));assert.ok(html.includes(V.escape(raw)));
});
test('unsupported or incomplete expressions fall back without a partial translation',()=>{
 for(const raw of ['missing = "x"','case in ("x")','case = LOGINUSER()','case = "x" and','(case = "x"','case = "x" trailing','case = "unterminated','case = "x" order by amount','case ! "x"']){
  assert.equal(V.readableCondition(raw,s),null,raw);assert.ok(V.conditionHtml(raw,s).includes(V.escape(raw)));
 }
});
test('empty conditions and unavailable field metadata remain distinguishable',()=>{
 assert.equal(V.readableCondition('',s),'追加条件なし');
 assert.equal(V.readableCondition('case = "x"',{evidence:[]}),null);
 assert.equal(V.readableCondition('case = "x"',{evidence:[...s.evidence,{kind:'field',value:{code:'case',label:'別名'}}]}),null);
});
test('conditions are readable in inventory, process table and workflow cards without mutating evidence',async()=>{
 const F=require('./helpers/business-fixture.js'),data=F.raw();
 data.fields.properties.memo.label='検証ケース';
 data.process.actions[0].filterCond='memo like "承認" and memo not like "保留"';
 data.process.actions[1].filterCond='memo = "要修正" or memo = "差戻希望"';
 const {s:snapshot}=await F.snapshot({data});
 const before=JSON.stringify(snapshot),actions=snapshot.evidence.filter(e=>e.kind==='process_action'&&e.value.filterCond);
 for(const html of [V.inventoryHtml(snapshot),V.processHtml(snapshot),V.workflowHtml({rules:[],unassignedEvidence:[]},snapshot)]){
  assert.match(html,/「検証ケース」/);assert.match(html,/かつ/);assert.match(html,/または/);
  for(const a of actions)assert.ok(html.includes(V.escape(a.value.filterCond)));
  assert.match(html,/<details class="ktr-condition-original"><summary>条件式の原文/);
 }
 assert.equal(JSON.stringify(snapshot),before);
});
