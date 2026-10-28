'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {KTReleaseConfigLensView: View} = require('../src/release-config-lens-view.js');
const clone = value => JSON.parse(JSON.stringify(value));
function comparison() {
  const fields = [
    {categoryId:'fields',code:'memo',label:'備考',kind:'changed',before:{required:false},after:{required:true},rows:[{path:['required'],before:false,after:true}]},
    {categoryId:'fields',code:'limit',label:'確認期限',kind:'added',after:{label:'確認期限',type:'DATE'},rows:[{path:['label'],after:'確認期限'}]},
    {categoryId:'fields',code:'old',label:'紹介経路',kind:'deleted',before:{label:'紹介経路',type:'SINGLE_LINE_TEXT'},rows:[{path:['label'],before:'紹介経路'}]}
  ];
  const views = [{categoryId:'views',code:'1',label:'期限の近い順',kind:'changed',before:{sort:'memo asc'},after:{sort:'limit asc'},rows:[{path:['sort'],before:'memo asc',after:'limit asc'}]}];
  return {status:'partial',source:{appId:'398',loadedAt:'2026-10-28T01:00:00Z',productionRevision:'1',previewRevision:'2'},
    categories:[{id:'fields',label:'フィールド',status:'ok',warnings:[],entries:fields},{id:'views',label:'一覧',status:'ok',warnings:[],entries:views},
      {id:'process',label:'プロセス管理',status:'ok',warnings:[],entries:[]},
      {id:'aclField',label:'アクセス権：フィールド',status:'unavailable',warnings:['運用環境の設定を取得できませんでした。'],entries:[]}],
    entries:[...fields,...views],unavailable:[{categoryId:'aclField',label:'アクセス権：フィールド',reasons:['運用環境の設定を取得できませんでした。']}],
    limitations:['レコードの内容は比較していません。']};
}
const render = (extra = {}) => View.render({result:comparison(),localEdits:{available:true,files:[]},canSaveProduction:true,canSavePreview:true,...extra});
const tagOf = (html,selector) => html.match(new RegExp('<button[^>]*'+selector+'[^>]*>'))?.[0];

test('独立タブは比較・AI説明・環境別保存を分け、運用から動作テストへの左右を表示する', () => {
  const html = render();
  assert.match(html,/data-config-lens-view/);
  assert.match(html,/<h2>Config Lens<\/h2>/);
  assert.match(html,/data-cl-action="refresh"/);
  assert.match(html,/data-cl-action="explain"/);
  assert.match(html,/data-cl-action="save-production"/);
  assert.match(html,/data-cl-action="save-preview"/);
  assert.match(html,/確認できた変更 4件/);
  assert.match(html,/2分類に変更/);
  assert.match(html,/1分類に未確認の範囲/);
  assert.match(html,/<th scope="col">設定項目<\/th><th scope="col">運用環境<\/th><th scope="col">動作テスト環境<\/th>/);
  assert.match(html,/運用環境の版 1 → 動作テスト環境の版 2/);
  assert.doesNotMatch(html,/data-release-action="send"|data-cl-action="apply"|data-cl-action="restore"/);
});

test('カテゴリを選ぶとその変更だけを表示し、追加・変更・削除の件数は同じカテゴリの結果を使う', () => {
  const html = render({selectedCategory:'fields'});
  assert.match(html,/data-cl-category="fields" aria-pressed="true"/);
  assert.match(html,/data-cl-kind="all" aria-pressed="true">すべて 3/);
  assert.match(html,/data-cl-kind="added" aria-pressed="false">追加 1/);
  assert.match(html,/data-cl-kind="changed" aria-pressed="false">変更 1/);
  assert.match(html,/data-cl-kind="deleted" aria-pressed="false">削除 1/);
  assert.match(html,/data-cl-result-category="fields"/);
  assert.doesNotMatch(html,/data-cl-result-category="views"|期限の近い順/);
  assert.match(html,/data-cl-category="views"/,'他カテゴリへの入口は残る');
});

test('追加・変更・削除は構造のkindで切り替え、比較値を読み替えない', () => {
  const onlyAdded = render({selectedCategory:'fields',filter:'added'});
  assert.match(onlyAdded,/data-cl-kind="added" aria-pressed="true"/);
  assert.match(onlyAdded,/<strong>確認期限<\/strong>/);
  assert.doesNotMatch(onlyAdded,/<strong>備考<\/strong>|<strong>紹介経路<\/strong>/);
  const onlyChanged = render({selectedCategory:'fields',filter:'changed'});
  assert.match(onlyChanged,/<strong>備考<\/strong>/);
  assert.doesNotMatch(onlyChanged,/<strong>確認期限<\/strong>|<strong>紹介経路<\/strong>/);
  const onlyDeleted = render({selectedCategory:'fields',filter:'deleted'});
  assert.match(onlyDeleted,/<strong>紹介経路<\/strong>/);
  assert.match(render({selectedCategory:'views'}),/memo asc/);
  assert.match(render({selectedCategory:'views'}),/limit asc/);
});

test('取得不可と一部未確認を変更なしと言い切らず、カテゴリの注意を表示する', () => {
  const unavailable = render({selectedCategory:'aclField'});
  assert.match(unavailable,/この範囲は比較できていません/);
  assert.match(unavailable,/運用環境の設定を取得できませんでした/);
  assert.doesNotMatch(unavailable,/<p class="ktcl-empty">変更はありません/);
  const result = comparison();result.categories[0].status='partial';result.categories[0].entries=[];result.categories[0].warnings=['一部の情報がありません。'];
  const partial = render({result,selectedCategory:'fields'});
  assert.match(partial,/比較できた範囲に変更はありません/);
  assert.match(partial,/一部の情報がありません/);
  assert.match(partial,/一部未確認・変更 0件/);
});

test('未取得・失敗・取得中には説明や保存を使わせず、表示済み結果の時点を残す', () => {
  const empty = View.render();
  assert.match(empty,/設定を読み込むと差分を表示/);
  assert.match(empty,/一覧を見る操作ではAIを呼びません/);
  for (const action of ['explain','save-production','save-preview']) assert.match(tagOf(empty,'data-cl-action="'+action+'"'),/ disabled/);
  const busy = render({busy:true,reading:true});
  for (const action of ['refresh','explain','save-production','save-preview']) assert.match(tagOf(busy,'data-cl-action="'+action+'"'),/ disabled/);
  assert.match(busy,/設定を読み込んでいます/);
  assert.match(busy,/2026-10-28T01:00:00Z/);
  const failed = render({error:'設定を取り直せませんでした。',canExplain:false,canSaveProduction:false});
  assert.match(failed,/role="alert" data-cl-error/);
  assert.match(tagOf(failed,'data-cl-action="explain"'),/ disabled/);
  assert.match(tagOf(failed,'data-cl-action="save-production"'),/ disabled/);
  assert.doesNotMatch(tagOf(failed,'data-cl-action="save-preview"'),/ disabled/);
  const stale = comparison();stale.status='stale';
  assert.match(tagOf(render({result:stale}),'data-cl-action="explain"'),/ disabled/);
});

test('手元の未登録編集は比較一覧と分け、本文やファイルキーを出さない', () => {
  const html = render({localEdits:{available:true,files:[{name:'memo.js',target:'mobile',state:'edited',text:'SECRET_DRAFT',fileKey:'SECRET_KEY'}]}});
  assert.match(html,/手元の未登録編集（1件）/);
  assert.match(html,/memo.js（モバイル・手元で編集中・未登録）/);
  assert.match(html,/設定の保存には含めません/);
  assert.doesNotMatch(html,/SECRET_DRAFT|SECRET_KEY/);
  assert.match(View.render({localEdits:{available:false,files:[]}}),/手元の未登録編集（未確認）/);
});

test('設定名・コード・値・警告・取得情報・保存結果をHTMLとして解釈しない', () => {
  const result = comparison(), attack = '<img src=x onerror="alert(1)">';
  result.source.appId=attack;result.source.loadedAt=attack;
  result.categories[0].label=attack;result.categories[0].entries[0].label=attack;
  result.categories[0].entries[0].code=attack;result.categories[0].entries[0].rows[0].before=attack;
  result.categories[3].warnings=[attack];result.limitations=[attack];
  const html=render({result,error:attack,exportStatus:attack,localEdits:{available:true,files:[{name:attack,state:'new'}]}});
  assert.doesNotMatch(html,/<img|onerror="alert/);
  assert.match(html,/&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
});

test('描画は入力比較・選択・編集状態を変更せず、無効な選択は全件へ戻す', () => {
  const result=comparison(),before=clone(result),localEdits={available:true,files:[{name:'a.js',state:'edited',target:'desktop'}]},copy=clone(localEdits);
  const html=render({result,localEdits,selectedCategory:'missing',filter:'unknown'});
  assert.deepEqual(result,before);assert.deepEqual(localEdits,copy);
  assert.match(html,/data-cl-category="all" aria-pressed="true"/);
  assert.match(html,/data-cl-kind="all" aria-pressed="true"/);
});


test('全設定では変更と未確認を先に表示し、変更なしのカテゴリも選んで確認できる', () => {
  const html=render();
  assert.match(html,/data-cl-category="process"/);
  assert.doesNotMatch(html,/data-cl-result-category="process"/);
  assert.match(html,/data-cl-result-category="aclField"/);
  const selected=render({selectedCategory:'process'});
  assert.match(selected,/data-cl-result-category="process"/);
  assert.match(selected,/<p class="ktcl-empty">変更はありません/);
});

test('項目の開閉用識別子は比較値や表示順によらず、明示IDがあればその値を使う', () => {
  const before=render({selectedCategory:'fields'});
  const ids=html=>Array.from(html.matchAll(/data-cl-entry="([^"]+)"/g),m=>m[1]).sort();
  const result=comparison();result.categories[0].entries.reverse();result.categories[0].entries.find(e=>e.code==='memo').label='備考（新しい名前）';
  assert.deepEqual(ids(render({result,selectedCategory:'fields'})),ids(before));
  assert.equal(new Set(ids(before)).size,3);
  result.categories[0].entries[0].id='explicit "entry"';
  assert.match(render({result,selectedCategory:'fields'}),/data-cl-entry="explicit &quot;entry&quot;"/);
});

test('読込・AI説明準備・保存を区別し、別処理を設定の読込中と表示しない', () => {
  const reading=render({reading:true});
  assert.match(reading,/設定を読み込んでいます…/);
  const sending=render({sending:true});
  assert.match(sending,/AI説明を準備しています…/);
  assert.doesNotMatch(sending,/設定を読み込んでいます…|設定を保存しています…/);
  const saving=render({saving:true});
  assert.match(saving,/設定を保存しています…/);
  assert.doesNotMatch(saving,/設定を読み込んでいます…|AI説明を準備しています…/);
  assert.doesNotMatch(render({busy:true}),/設定を読み込んでいます…/);
  for(const html of [reading,sending,saving]) {
    for(const action of ['refresh','explain','save-production','save-preview']) assert.match(tagOf(html,'data-cl-action="'+action+'"'),/ disabled/);
  }
});
