'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {KTReleaseView:View}=require('../src/release-view.js');
const {KTReleaseWorkspace}=require('../src/release-workspace.js');
const {fixture,proposal}=require('./helpers/release-workspace-fixture.js');
const E=require('./helpers/release-explanation-fixture.js');
const documentOf=(id='explanation-1',title)=>({id,...E.explanation(title),facts:E.clone(E.facts),createdAt:100,version:1});
const stateOf=(phase='review')=>({phase,messages:[{role:'assistant',text:'短い返答'}],runs:[],explanations:[documentOf()],explanationId:'explanation-1',
 proposal:proposal().proposal,plan:{steps:[],customizations:[]},artifacts:[],prepared:{ok:true,changes:[{title:'備考の編集制御'}],confirmations:[]}});
const markup=state=>View.render(state).replace(/<style>[\s\S]*?<\/style>/,'');
function hostOf() {
 const listeners=new Map();let html='',input=null;
 const host={ownerDocument:{activeElement:null},querySelector:selector=>selector==='#kt-release-input'?input:null,querySelectorAll:()=>[],
  addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name),
  dispatch:async(name,target)=>listeners.get(name)?.({target,preventDefault(){}})};
 Object.defineProperty(host,'innerHTML',{get:()=>html,set(value){html=String(value);input={id:'kt-release-input',value:'',selectionStart:0,selectionEnd:0,focus(){host.ownerDocument.activeElement=input;},setSelectionRange(){}};}});
 return host;
}
async function click(host,action,id) {await host.dispatch('click',{dataset:{releaseAction:action,releaseId:id},disabled:false});}

test('説明本文を読む間は変更操作を出さず、根拠は作成時の参照された事実だけ表示する',()=>{
 const state=stateOf(),before=JSON.stringify(state),html=markup(state);
 assert.match(html,/data-release-stage="explanation"/);assert.match(html,/アプリの目的/);assert.match(html,/確認できていないこと/);
 assert.match(html,/説明作成時の設定/);assert.match(html,/備考は文字列/);
 assert.doesNotMatch(html,/参照していない設定|data-release-action="(?:apply|adopt|resume)"/);
 assert.match(html,/data-release-action="show-changes"/);assert.match(html,/id="kt-release-input"/);
 assert.match(html,/資料を作る/);assert.equal(JSON.stringify(state),before);
});
test('表・本文・タイトル・根拠の文字はHTMLとして実行せず、既知の根拠だけ開ける',()=>{
 const state=stateOf();state.explanations[0].title='<script>alert(1)</script>';
 state.explanations[0].sections[0].paragraphs.push('<svg onload=alert(2)>');
 state.explanations[0].facts[0].statement='<iframe src=x>';
 const html=markup(state);
 assert.doesNotMatch(html,/<script|<img|<svg|<iframe/);
 assert.match(html,/&lt;img src=x onerror=&quot;/);assert.match(html,/&lt;script&gt;/);
 assert.match(html,/<table>/);assert.match(html,/tabindex="0" role="region"/);
 assert.doesNotMatch(html,/<strong>unknown/);
});
test('Markdown保存は構造化本文のコピーで、記号・改行を保ち埋め込みHTMLやリンクを作らない',()=>{
 const doc=documentOf();doc.title='タイトル # [x]';doc.sections[0].paragraphs.push('```コード``` と **太字**');
 const md=View.explanationMarkdown(doc);
 assert.match(md,/^# タイトル \\# \\\[x\\\]/);
 assert.ok(md.includes('\\<img src=x onerror="window\\.injected=true"\\>'));
 assert.ok(md.includes('A\\|B<br>次の行'));
 assert.ok(md.includes('\\[実行\\]\\(javascript:alert\\(1\\)\\)'));
 assert.ok(md.includes('\\`\\`\\`コード\\`\\`\\` と \\*\\*太字\\*\\*'));
 assert.ok(md.includes('### 根拠（説明作成時の設定）'));
 assert.doesNotMatch(md,/参照していない設定|MULTI_LINE_TEXT/);
 assert.ok(md.includes('## 確認できていないこと'));assert.equal(View.explanationMarkdown(null),'');
});
test('説明の履歴を選び、コピー・保存・変更案へ戻っても採用状態を変更せずAIを呼ばない',async()=>{
 const f=fixture(KTReleaseWorkspace,{propose:args=>args.text==='一覧を追加'?proposal():E.response(args.text)});await f.controller.send('一覧を追加');await f.controller.adopt();
 await f.controller.send('案件管理の仕組み');await f.controller.send('引継ぎ資料');
 const state=f.controller.getState(),firstId=state.explanations[0].id;
 const prepared=JSON.stringify(state.prepared),paid=f.count('propose')+f.count('plan')+f.count('generate');
 const host=hostOf(),copies=[],downloads=[];const view=View.create(host,{controller:f.controller,onCopy:text=>copies.push(text),onDownload:(...args)=>downloads.push(args)});
 assert.match(host.innerHTML,/これまでの説明/);
 const input=host.querySelector('#kt-release-input');input.value='詳しく説明してください';await host.dispatch('input',input);
 await click(host,'show-explanation',firstId);assert.equal(f.controller.getState().explanationId,firstId);
 assert.equal(host.querySelector('#kt-release-input').value,'詳しく説明してください');
 await click(host,'copy-explanation',firstId);await click(host,'download-explanation',firstId);
 assert.equal(copies[0],View.explanationMarkdown(state.explanations[0]));
 assert.deepEqual(downloads[0],['アプリの説明.md',copies[0],'text/markdown;charset=utf-8']);
 await click(host,'show-changes');assert.equal(f.controller.getState().explanationId,null);
 assert.match(host.innerHTML,/data-release-action="apply"/);assert.equal(JSON.stringify(f.controller.getState().prepared),prepared);
 assert.equal(f.count('propose')+f.count('plan')+f.count('generate'),paid);assert.equal(f.writes.length,0);view.dispose();
});
test('説明の返答待ちでは切替を無効にし、説明だけの状態に採用・反映を置かない',()=>{
 const state=stateOf('consulting');state.prepared=null;state.proposalPending=true;
 const html=markup(state);assert.match(html,/data-release-stage="working"/);
 for(const action of ['show-explanation','show-changes'])assert.match(html,new RegExp('data-release-action="'+action+'"[^>]* disabled'));
 assert.doesNotMatch(html,/data-release-action="(?:apply|adopt|resume)"/);
 state.phase='idle';state.proposal=null;assert.doesNotMatch(markup(state),/data-release-action="(?:apply|adopt|resume)"/);
});
