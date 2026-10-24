'use strict';
// Existing free products are preserved independently of the replaced AI work surface.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadToolkit } = require('./helpers/load-toolkit.js');
const { inputsOf } = require('./helpers/free-materials-fixture.js');
const REAL = require('./fixtures/scanner-cache-297.js');
const T = loadToolkit(), UI = T.KTContextUi;
const json = x => JSON.parse(JSON.stringify(x));
const formats = ['prompt','markdown','json'];

test('無料資料の全7種類を既存の正式な生成部品で3形式に出す', () => {
  assert.deepEqual(json(UI.DOCUMENT_KINDS.map(x=>x.id)).sort(), ['spec','requirements','review-request','plain','changes','handover','improvement'].sort());
  const inputs = inputsOf(T);
  const version = { version:1, status:'ACTIVE', goal:'備考を確認する', plan:{ goal:'備考を確認する', solution:'STANDARD', steps:[{id:'P1',title:'一覧に備考を表示',actionType:'ADD_VIEW',dependsOn:[]}], customizations:[], questions:[] } };
  for (const kind of UI.DOCUMENT_KINDS) {
    const result = UI.generateDocument({kind:kind.id,inputs,version,now:'2026-10-24T00:00:00Z'});
    assert.equal(result.ok,true,kind.id);
    for (const f of formats) assert.ok(result.outputs[f].length>50,`${kind.id}/${f}`);
    assert.match(result.outputs.markdown,/一覧に備考を表示/);
    assert.match(result.outputs.prompt,/Context/);
    assert.equal(JSON.parse(result.outputs.json).production.deployed,false);
    assert.match(result.warnings.join('\n'),/Nest Rec AI は使っていません/);
  }
  assert.equal(UI.generateDocument({kind:'changes',inputs}).reason,'no-plan');
});

test('相談用と計画用の資料、PCとモバイルの同名ファイルと同名フィールドを取り違えない', () => {
  const inputs = inputsOf(T), targets = UI.listTargets(inputs);
  for (const id of ['desktop:js:common.js','mobile:js:common.js']) assert.ok(targets.files.some(f=>f.id===id));
  assert.ok(targets.fields.some(f=>f.id==='pic_sales'));
  assert.ok(targets.fields.some(f=>f.id==='pic_support'));
  for (const [type,id] of [['app',null],['field','pic_sales'],['file','desktop:js:common.js'],['file','mobile:js:common.js']]) {
    const result=UI.generate({targetType:type,targetId:id,question:'この対象の構造を説明してください',inputs});
    assert.equal(result.ok,true,`${type}:${id}`);
    for (const f of formats) assert.ok(result.outputs[f].length>50);
    if(id) assert.equal(result.ctx.focus.target.id,id);
  }
  const result=UI.generatePlan({goal:'備考を一覧に表示する',inputs});
  assert.equal(result.ok,true);
  for (const f of formats) assert.ok(result.outputs[f].length>50);
  assert.equal(UI.generatePlan({goal:'',inputs}).reason,'no-goal');
});

test('対象が曖昧なら資料を作らず、明示した対象から作る', () => {
  const inputs=inputsOf(T);
  const first=UI.generate({targetType:'app',question:'common.js を説明してください',inputs});
  assert.equal(first.ok,false); assert.equal(first.reason,'ambiguous');
  assert.equal(first.outputs,undefined);
  assert.ok(first.candidates.some(c=>c.id==='desktop:js:common.js'));
  const next=UI.generate({targetType:'file',targetId:'desktop:js:common.js',question:'common.js を説明してください',inputs});
  assert.equal(next.ok,true); assert.equal(next.ctx.focus.target.id,'desktop:js:common.js');
});

test('資料の本文・形式ごとに秘密情報を除き、未解析と本文の無いキャッシュを事実どおり示す', () => {
  const data=REAL.makeData(), deps=T.KTDeps.buildDependencyData(data,T.KTDeps.normalizeFields(data.fields));
  T.KTDeps.mergeScannerEdges(deps,REAL.cache.payload);
  const inputs={data,deps,scan:REAL.cache.payload,incoming:null};
  const result=UI.generate({targetType:'file',targetId:`desktop:js:${REAL.FILE}`,question:'この JavaScript を説明してください',inputs});
  assert.equal(result.ok,true);
  assert.match(result.warnings.join('\n'),/キャッシュに含まれない/);
  assert.equal(result.ctx.coverage.javascriptSource,'snippets');
  assert.ok(result.ctx.facts.some(f=>f.kind==='js-match'));
  assert.ok(!result.ctx.facts.some(f=>f.kind==='code-excerpt'));
  for (const f of formats) { assert.doesNotMatch(result.outputs[f],/abcdEFGH12345678/); assert.match(result.outputs[f],/\*\*\*/); }
  const unscanned=UI.generate({targetType:'app',question:'構造を説明してください',inputs:inputsOf(T,{withScan:false})});
  assert.match(unscanned.warnings.join('\n'),/JavaScript は未解析/);
  assert.ok(unscanned.coverage.some(row=>row.label==='レコードデータ' && row.included===false));
  assert.ok(unscanned.coverage.some(row=>row.label==='添付ファイル' && row.included===false));
  const truncated=UI.generate({targetType:'field',targetId:'customer_code',question:'構造を説明してください',inputs:inputsOf(T),limits:{maxDependencyFacts:2,maxJsMatchFacts:1}});
  assert.equal(truncated.truncation.applied,true);
  assert.match(truncated.truncation.message,/省略されています/);
  assert.ok(truncated.truncation.details.some(x=>/件中2件/.test(x)));
});

test('Healthのプロセス図は状態・操作名と空ラベルを失わない', () => {
  const states=Object.fromEntries(['申請前','承認待ち','承認済み'].map((name,i)=>[name,{name,index:String(i)}]));
  const code=T.buildProcessMermaid({states,actions:[{name:'申請する(課長)',from:'申請前',to:'承認待ち'},{name:'承認する',from:'承認待ち',to:'承認済み'},{name:'',from:'承認待ち',to:'申請前'}]});
  assert.match(code,/^flowchart LR/);
  assert.ok(code.includes('S0["申請前"]'));
  assert.ok(code.includes('S0 -->|"申請する(課長)"| S1'));
  assert.ok(code.includes('S1 -->|"承認する"| S2'));
  assert.ok(code.includes('S1 --> S0'));
  assert.equal(T.buildProcessMermaid({states:{},actions:[]}),'');
});

test('Healthのプロセス図は引用符・括弧・改行を安全なラベルにする', () => {
  const labels=['承認("課長")','部長 #1','状態`確認`','確認<対象>','行\n追加','角[括弧] {中括弧} |区切り;'];
  const states=Object.fromEntries(labels.map((name,i)=>[name,{name,index:i}]));
  const code=T.buildProcessMermaid({states,actions:labels.slice(1).map((name,i)=>({name,from:labels[i],to:labels[i+1]}))});
  const node=/^  S\d+\["[^"]*"\]$/, edge=/^  S\d+ -->\|"[^"]*"\| S\d+$/;
  for (const line of code.split('\n').slice(1)) assert.ok(node.test(line)||edge.test(line),line);
  assert.match(code,/#quot;課長#quot;/); assert.match(code,/#35;1/); assert.match(code,/#96;確認#96;/);
  assert.match(code,/確認＜対象＞/); assert.match(code,/行 追加/);
});
