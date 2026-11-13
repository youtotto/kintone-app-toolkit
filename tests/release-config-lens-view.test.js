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
const originOf = (html, side) => html.match(new RegExp('<section[^>]*data-cl-origin="' + side + '"[\\s\\S]*?<\/section>'))?.[0];

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
  assert.match(html,/<th scope="col">設定項目<\/th><th scope="col">左：現在の運用環境<\/th><th scope="col">右：動作テスト環境<\/th>/);
  assert.match(html,/設定の版：左 1 ／ 右 2/);
  assert.match(originOf(html,'after'),/data-cl-target/);
  assert.match(originOf(html,'after'),/value="preview" selected/);
  assert.match(originOf(html,'after'),/value="file"/);
  assert.doesNotMatch(html,/data-cl-environment|data-cl-action="environment-mode"/);
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

function savedComparison(crossApp = false) {
  const result = comparison();
  result.source = {
    comparisonType: 'saved-settings', crossApp,
    beforeLabel: '現在の運用環境', afterLabel: '保存ファイル（運用環境）',
    before: { domain: crossApp ? 'current.cybozu.com' : 'saved.cybozu.com', appId: crossApp ? '399' : '398', environment: 'production', revision: '12', capturedAt: '2026-10-28T01:00:00Z' },
    after: { domain: 'saved.cybozu.com', appId: '398', environment: 'production', revision: '7', capturedAt: '2026-10-20T01:00:00Z' }
  };
  return result;
}

test('保存ファイルと現在アプリの比較は左右の出所・日時・保存対象を区別する', () => {
  const result = savedComparison(), savedFile = { filename: 'settings-old.json', source: result.source.after };
  const before = clone({ result, savedFile });
  const html = render({ result, savedFile, comparisonTarget: 'file' });
  assert.match(html, /data-cl-action="open-file"/);
  assert.match(html, /<input type="file" data-cl-file accept="\.json,application\/json"[^>]* hidden/);
  assert.match(html, /data-cl-file-comparison/);
  assert.match(html, /settings-old\.json/);
  assert.match(originOf(html,'after'), /value="file" selected/);
  assert.match(originOf(html,'after'), /data-cl-action="open-file"/);
  assert.doesNotMatch(originOf(html,'before'), /settings-old\.json|data-cl-action="open-file"/);
  assert.doesNotMatch(html, /data-cl-environment|data-cl-action="environment-mode"/);
  assert.match(html, /<th scope="col">左：現在の運用環境<\/th><th scope="col">右：保存した設定（運用環境）<\/th>/);
  assert.match(html, /アプリ 398 ・ saved\.cybozu\.com/);
  assert.match(html, /設定の版：左 12 ／ 右 7/);
  assert.match(html, /datetime="2026-10-20T01:00:00Z"/);
  assert.match(html, /datetime="2026-10-28T01:00:00Z"/);
  assert.match(html, /data-cl-action="save-production"[^>]*>運用環境を保存<\/button>/);
  assert.match(html, /data-cl-action="save-preview"[^>]*>動作テスト環境を保存<\/button>/);
  assert.match(html, /追加・変更・削除は左から右への違い/);
  assert.doesNotMatch(html, /data-cl-cross-app|data-cl-action="restore"|data-cl-action="apply"/);
  assert.deepEqual({ result, savedFile }, before);
});

test('別アプリの比較は履歴と区別し、同名項目の照合と両方のアプリを示す', () => {
  const result = savedComparison(true);
  const html = render({ result, savedFile: { filename: 'other-app.json', source: result.source.after }, comparisonTarget: 'file' });
  assert.match(html, /data-cl-cross-app/);
  assert.match(html, /変更履歴ではありません/);
  assert.match(html, /一覧・グラフ・アプリアクションは同じ名前で照合/);
  assert.match(html, /アプリ 398 ・ saved\.cybozu\.com/);
  assert.match(html, /アプリ 399 ・ current\.cybozu\.com/);
  assert.match(html, /比較できていません/);
  assert.match(tagOf(html, 'data-cl-action="explain"'), / disabled/);
  assert.match(html, /AI説明は環境どうしの比較が対象/);
  assert.doesNotMatch(tagOf(render(), 'data-cl-action="explain"'), / disabled/, '従来の環境間比較の説明は維持');
});

test('保存ファイルの読込中は比較・保存・環境選択を止め、選択したファイルは表示する', () => {
  const result = savedComparison();
  const html = render({ result, savedFile: { filename: 'loading.json', source: result.source.after }, importing: true });
  for (const action of ['refresh','explain','open-file','save-production','save-preview']) {
    assert.match(tagOf(html, 'data-cl-action="' + action + '"'), / disabled/);
  }
  assert.match(html, /<select[^>]*data-cl-target[^>]* disabled/);
  assert.match(html, /<input type="file"[^>]* disabled/);
  assert.match(html, /保存ファイルを読み込んでいます…/);
  assert.match(html, /loading\.json/);
  assert.doesNotMatch(html, /設定を読み込んでいます…|設定を保存しています…/);
});

test('保存ファイル名・取得元・環境の表示でファイル内のHTMLを実行しない', () => {
  const attack = '<img src=x onerror="alert(1)">';
  const result = savedComparison(true);
  result.source.beforeLabel = attack;
  result.source.afterLabel = attack;
  for (const value of [result.source.before, result.source.after]) {
    value.domain = attack; value.appId = attack; value.capturedAt = attack; value.revision = attack;
  }
  const html = render({ result, savedFile: { filename: attack, source: result.source.after } });
  assert.doesNotMatch(html, /<img|onerror="alert/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
});

test('保存したアプリと現在のアプリは個別の名前・環境・取得日時を示し、保存日時と混ぜない', () => {
  const result = savedComparison(true), savedFile = {
    filename: 'before.json', source: result.source.after, appName: '保存時の見積管理', savedAt: '2026-10-21T02:00:00Z'
  };
  const currentSources = { production: { ...result.source.before, appName: '今の請求管理' } };
  const html = render({ result, savedFile, currentSources, comparisonTarget:'file' });
  const left = originOf(html,'before'), right = originOf(html,'after');
  assert.match(left, /今の請求管理/);
  assert.match(left, /アプリ 399 ・ current\.cybozu\.com/);
  assert.match(left, /datetime="2026-10-28T01:00:00Z"/);
  assert.match(right, /保存時の見積管理/);
  assert.match(right, /アプリ 398 ・ saved\.cybozu\.com/);
  assert.match(right, /設定の取得：[\s\S]*datetime="2026-10-20T01:00:00Z"/);
  assert.match(right, /ファイル保存：[\s\S]*datetime="2026-10-21T02:00:00Z"/);
  assert.doesNotMatch(left, /保存時の見積管理|ファイル保存/); assert.doesNotMatch(right, /今の請求管理/);
  assert.match(left.slice(0,left.indexOf('<details')), /今の請求管理/, '現在のアプリ名は常時表示');
  assert.match(right.slice(0,right.indexOf('<details')), /保存時の見積管理/, '保存側のアプリ名も常時表示');
  assert.match(right, /<details class="ktcl-origin-info"[^>]*><summary>取得情報<\/summary>/, '取得日時は折りたたんで表示');
  const reading = render({result:null,savedFile,comparisonTarget:'file',reading:true});
  assert.doesNotMatch(reading,/今の請求管理/);
  assert.match(originOf(reading,'before'),/アプリ情報は未取得/);
  assert.match(originOf(reading,'after'),/保存時の見積管理/);
});

test('環境間のアプリ名を混ぜず、未取得の名前をファイル名や他環境から推測しない', () => {
  const currentSources = {
    production: {appId:'398', domain:'test.cybozu.com', environment:'production', appName:'公開中の名前'},
    preview: {appId:'398', domain:'test.cybozu.com', environment:'preview', appName:'変更予定の名前'}
  };
  const html = render({currentSources});
  assert.match(html, /左：現在の運用環境[\s\S]*公開中の名前[\s\S]*右：比較する設定[\s\S]*変更予定の名前/);
  assert.match(render({savedFile:{filename:'アプリ名ではない.json',source:savedComparison().source.after},result:null,comparisonTarget:'file'}), /アプリ名は未取得/);
});

test('常時表示するアプリ名と保存日時もHTMLとして解釈しない', () => {
  const attack='<img src=x onerror="alert(1)">',result=savedComparison();
  const html=render({result,savedFile:{filename:attack,source:result.source.after,appName:attack,savedAt:attack},
    currentSources:{production:{...result.source.before,appName:attack}}});
  assert.doesNotMatch(html,/<img|onerror="alert/);
  assert.match(html,/&lt;img/);
});


test('保存ファイルを保持していても比較先が動作テスト環境なら保存側を混ぜない', () => {
  const fileResult=savedComparison(),savedFile={filename:'held.json',source:fileResult.source.after,appName:'保存時の名前'};
  const currentSources={
    production:{...fileResult.source.before,appName:'公開中の名前'},
    preview:{...fileResult.source.before,environment:'preview',appName:'動作テストの名前'}
  };
  const html=render({savedFile,currentSources,comparisonTarget:'preview'});
  const left=originOf(html,'before'),right=originOf(html,'after');
  assert.match(left,/左：現在の運用環境[\s\S]*公開中の名前/);
  assert.match(right,/右：比較する設定[\s\S]*動作テストの名前/);
  assert.match(right,/value="preview" selected/);
  assert.doesNotMatch(html,/held\.json|保存時の名前|data-cl-file-comparison/);
  assert.doesNotMatch(tagOf(html,'data-cl-action="explain"'),/ disabled/);
});

test('保存ファイルが未選択なら比較前と表示し、変更なしの結果や古いファイルにしない', () => {
  const currentSources={production:{domain:'current.cybozu.com',appId:'399',environment:'production',appName:'今のアプリ'}};
  const html=View.render({result:null,comparisonTarget:'file',currentSources,localEdits:{available:true,files:[]}});
  assert.match(originOf(html,'before'),/左：現在の運用環境[\s\S]*今のアプリ/);
  assert.match(originOf(html,'after'),/保存した設定ファイルを選んでください。/);
  assert.match(originOf(html,'after'),/value="file" selected/);
  assert.match(originOf(html,'after'),/data-cl-action="open-file"/);
  assert.doesNotMatch(html,/比較できた範囲に変更はありません|data-cl-result-category|data-cl-entry/);
  assert.match(tagOf(html,'data-cl-action="explain"'),/ disabled/);
});
