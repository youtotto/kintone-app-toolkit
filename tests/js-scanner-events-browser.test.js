'use strict';
// Actual Scanner UI and existing KTScan analysis; all browser requests stay local.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..');
const origin = 'https://scanner.test.invalid/';
function playwright() {
  try { return require(process.env.PLAYWRIGHT_MODULE || 'playwright'); }
  catch { return require(path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
}
function bundle() {
  const source = fs.readFileSync(process.env.KT_SRC || path.join(root, 'kintoneAppToolkit.user.js'), 'utf8')
    .replace('waitReady().then(() => startToolkit());', '');
  const end = source.lastIndexOf('})();'); assert.ok(end >= 0);
  return source.slice(0, end) + '\nglobalThis.ScannerTest={mountRoot,renderScanner,KTApi,KTScan};\n' + source.slice(end);
}
async function mount(page) {
  await page.evaluate(async () => {
    const T = ScannerTest;
    window.calls = { customize: 0, download: 0, analysis: 0, run: 0 };
    window.kintone = { app: { getId: () => 398 }, api: { url: value => value } };
    window.sources = {
      pc: "kintone.events.on(['app.record.edit.show', 'app.record.create.show'], function(event){return event;});",
      candidate: "const events=['app.record.edit.show']; kintone.events.on(events, function(event){return event;});",
      mobile: "kintone.events.on('mobile.app.record.edit.show', function(event){return event;});",
      escaped: "kintone.events.on('app.record.edit.show', function(event){return event;});",
      style: '.memo {color:blue}'
    };
    const file = (name, fileKey) => ({ type: 'FILE', file: { name, fileKey, size: '120' } });
    window.customizeFixture = {
      revision: '7', scope: 'ALL',
      desktop: { js: [file('shared.js', 'pc'), file('candidate.js', 'candidate'), file('unsafe<img src=x onerror=alert(1)>.js', 'escaped'),
        {type:'URL',url:'https://external.test.invalid/skipped.js'}], css: [file('style.css', 'style')] },
      mobile: { js: [file('shared.js', 'mobile')], css: [] }
    };
    T.KTApi.getCustomize = async () => { calls.customize++; return { source: 'preview', data: structuredClone(customizeFixture) }; };
    T.KTApi.downloadFile = async key => { calls.download++; return sources[key]; };
    const build = T.KTScan.buildPayload, run = T.KTScan.run;
    T.KTScan.buildPayload = (...args) => { calls.analysis++; return build(...args); };
    T.KTScan.run = (...args) => { calls.run++; return run(...args); };
    localStorage.setItem('ktToolkitFull.v1', '1');
    T.KTScan.setAutoEnabled(false);
    window.shell = T.mountRoot();
    window.scannerData = {appId:398, fields:{memo:{type:'SINGLE_LINE_TEXT',code:'memo',label:'備考'}},
      layout:[{type:'ROW',fields:[{type:'SINGLE_LINE_TEXT',code:'memo'}]}],customize:customizeFixture};
    await T.renderScanner(shell, scannerData);
    shell.ktTabs.switchTab('field-scanner');
  });
}
async function scan(page, options = {force:true}) {
  const result = await page.evaluate(options => ScannerTest.KTScan.run(options), options);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}
async function browserCase(run) {
  const browser = await playwright().chromium.launch({channel:process.env.BROWSER_CHANNEL || 'msedge',headless:true});
  const errors=[], unexpected=[];
  const context = await browser.newContext({viewport:{width:1440,height:900},serviceWorkers:'block',colorScheme:'dark'});
  try {
    await context.route('**/*',route => {
      const url=route.request().url();
      if(url===origin)return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="ja"><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%}</style><body></body></html>'});
      if(url.startsWith('https://www.google.com/s2/favicons?'))return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg"/>'});
      unexpected.push(url);return route.abort();
    });
    const page=await context.newPage();page.setDefaultTimeout(5000);
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(origin);await page.addScriptTag({content:bundle()});await mount(page);
    await run(page);
    assert.deepEqual(errors,[],'ブラウザーの実行エラーがない');
    assert.deepEqual(unexpected,[],'外部URL・AI・kintoneへの通信がない');
  } finally { await context.close();await browser.close(); }
}
const cards = page => page.locator('#fs-event-results article[data-fs-event]');

test('JS Scanner: イベントから使用JSへ絞り込み、解析・取得を増やさずファイル詳細へ移る',{timeout:45000},async()=>{
  await browserCase(async page=>{
    await scan(page);
    await page.locator('#fs-view').selectOption('event');
    assert.equal(await page.locator('#fs-event-view').isVisible(),true);
    assert.equal(await page.locator('#fs-file-view').isVisible(),false);
    assert.equal(await page.locator('#fs-table-wrap').isVisible(),false);
    assert.deepEqual(await cards(page).evaluateAll(els=>els.map(el=>el.dataset.fsEvent)),[
      'app.record.create.show','app.record.edit.show','mobile.app.record.edit.show'
    ]);
    const pc=page.locator('#fs-event-results article[data-fs-event="app.record.edit.show"]');
    const pcText=await pc.innerText();
    assert.match(pcText,/shared\.js/);assert.match(pcText,/candidate\.js/);
    assert.match(pcText,/PC/);assert.doesNotMatch(pcText,/モバイル/);
    assert.match(pcText,/登録の記述あり/);assert.match(pcText,/登録の候補/);
    const mobile=page.locator('#fs-event-results article[data-fs-event="mobile.app.record.edit.show"]');
    assert.match(await mobile.innerText(),/shared\.js/);assert.match(await mobile.innerText(),/モバイル/);
    assert.equal(await page.locator('#fs-event-results img').count(),0,'ファイル名をHTMLとして解釈しない');
    assert.match(pcText,/unsafe<img src=x onerror=alert\(1\)>\.js/);
    const notes=await page.locator('#fs-event-notes').innerText();
    assert.match(notes,/skipped\.js/);assert.match(notes,/未確認|解析|取得/);
    assert.match(notes,/限りません|限ら|未使用/);
    fs.mkdirSync(path.join(root,'tests/.build/js-scanner-events'),{recursive:true});
    await page.screenshot({path:path.join(root,'tests/.build/js-scanner-events/event-origin.png'),fullPage:true});
    await page.setViewportSize({width:760,height:900});
    const narrow = await page.locator('#fs-event-view').evaluate(el=>({client:el.clientWidth,scroll:el.scrollWidth}));
    assert.ok(narrow.scroll <= narrow.client + 1,'狭幅でもイベントの一覧に横はみ出しがない: '+JSON.stringify(narrow));
    await page.setViewportSize({width:1440,height:900});
    const before=await page.evaluate(()=>structuredClone(calls));
    await page.locator('#fs-event-search').fill('mobile.app.record.edit');
    assert.deepEqual(await cards(page).evaluateAll(els=>els.map(el=>el.dataset.fsEvent)),['mobile.app.record.edit.show']);
    await page.locator('#fs-event-search').fill('does.not.exist');
    assert.equal(await cards(page).count(),0);
    assert.ok((await page.locator('#fs-event-results').innerText()).trim(),'検索に該当しないことを表示する');
    assert.match(await page.locator('#fs-event-notes').innerText(),/skipped\.js/,'絞り込みで未確認のファイルを隠さない');
    await page.locator('#fs-event-search').fill('');
    await page.locator('#fs-event-select').selectOption('app.record.edit.show');
    assert.equal(await cards(page).count(),1);
    await page.locator('#fs-event-select').selectOption('');
    assert.equal(await cards(page).count(),3);
    await page.locator('#fs-view').selectOption('field');
    assert.equal(await page.locator('#fs-table-wrap').isVisible(),true);
    assert.equal(await page.locator('#fs-event-view').isVisible(),false);
    await page.locator('#fs-view').selectOption('event');
    const detail=mobile.locator('button[data-fs-file-index]').first(), index=await detail.getAttribute('data-fs-file-index');
    await detail.click();
    assert.equal(await page.locator('#fs-view').inputValue(),'file');
    const file=page.locator('#fs-file-view article[data-fs-file-index="'+index+'"]');
    assert.equal(await file.isVisible(),true);assert.match(await file.innerText(),/shared\.js/);
    assert.equal(await file.evaluate(el=>document.activeElement===el),true,'該当ファイルへキーボードのフォーカスも移す');
    assert.deepEqual(await page.evaluate(()=>calls),before,'検索・選択・切替・詳細表示だけでは再解析も再取得もしない');
  });
});

test('JS Scanner: 本文を省いたキャッシュ・旧イベント形式を使い、表示選択を復元する',{timeout:45000},async()=>{
  await browserCase(async page=>{
    await scan(page);
    await page.locator('#fs-view').selectOption('event');
    const before=await page.evaluate(()=>structuredClone(calls));
    await page.evaluate(()=>{
      const key='ktScanCache.v1.398', cache=JSON.parse(localStorage.getItem(key));
      if(cache.payload.files.some(file=>Object.hasOwn(file,'text')))throw Error('Cache should omit source text');
      cache.payload.fileEvents['desktop:js:shared.js']=['app.record.edit.show','app.record.create.show'];
      localStorage.setItem(key,JSON.stringify(cache));
    });
    await page.reload();await page.addScriptTag({content:bundle()});await mount(page);
    assert.equal(await page.locator('#fs-view').inputValue(),'event','保存した表示モードで開く');
    const result=await scan(page,{});
    assert.equal(result.fromCache,true);
    assert.equal(await cards(page).count(),3,'本文のないキャッシュにもイベントが残る');
    const pc=page.locator('#fs-event-results article[data-fs-event="app.record.edit.show"]');
    assert.match(await pc.innerText(),/shared\.js/);assert.match(await pc.innerText(),/登録の記述あり/);
    const cachedCalls=await page.evaluate(()=>calls);
    assert.equal(cachedCalls.analysis,0,'キャッシュの表示にコード解析をやり直さない');
    assert.equal(cachedCalls.download,0,'キャッシュの表示に本文を取得し直さない');
    assert.equal(cachedCalls.customize,1,'既存のキャッシュ照合だけ行う');
    assert.equal(before.analysis,1);
  });
});

test('JS Scanner: イベント未検出とCSSのみを区別し、前の結果を残さない',{timeout:45000},async()=>{
  await browserCase(async page=>{
    await scan(page);await page.locator('#fs-view').selectOption('event');
    assert.equal(await cards(page).count(),3);
    await page.evaluate(()=>{
      sources.pc='const message="no event registration";';
      customizeFixture.desktop.js=[{type:'FILE',file:{name:'shared.js',fileKey:'pc',size:'40'}}];
      customizeFixture.mobile.js=[];
    });
    await scan(page);
    assert.equal(await cards(page).count(),0);
    assert.match(await page.locator('#fs-event-results').innerText(),/検出|見つか|イベント/);
    assert.match(await page.locator('#fs-event-notes').innerText(),/限りません|限ら|未使用/);
    await page.locator('#fs-kinds').selectOption('css');
    await scan(page);
    assert.equal(await cards(page).count(),0);
    assert.match(await page.locator('#fs-event-results').innerText(),/JavaScript|JS|CSS/,'CSSだけの結果ではJavaScriptの対象範囲を知らせる');
    assert.doesNotMatch(await page.locator('#fs-event-notes').innerText(),/skipped\.js/,'以前のスキャンの未解析ファイルを混ぜない');
  });
});


test('JS Scanner: 同一画面の同名JSは登録先を断定せず、既存キー衝突の未確認範囲を残す',{timeout:45000},async()=>{
  await browserCase(async page=>{
    await page.evaluate(()=>{
      sources.pc="kintone.events.on('app.record.edit.show',function(event){return event;});";
      sources.sameName="kintone.events.on('app.record.create.show',function(event){return event;});";
      customizeFixture.desktop.js=[
        {type:'FILE',file:{name:'shared.js',fileKey:'pc',size:'80'}},
        {type:'FILE',file:{name:'shared.js',fileKey:'sameName',size:'80'}}
      ];
      customizeFixture.mobile.js=[];
    });
    await scan(page);await page.locator('#fs-view').selectOption('event');
    const payload=await page.evaluate(()=>ScannerTest.KTScan.getLastPayload());
    assert.equal(payload.files.filter(file=>file.target==='desktop'&&file.name==='shared.js').length,2);
    assert.deepEqual(payload.fileEvents['desktop:js:shared.js'],[{name:'app.record.create.show',direct:true}],
      '本物の既存解析では同名キーが後のファイルで上書きされ、ここから前のイベントを補えない');
    const group=page.locator('#fs-event-results article[data-fs-event="app.record.create.show"]');
    assert.equal(await group.count(),1);
    const text=await group.innerText();
    assert.equal((text.match(/shared\.js/g)||[]).length,1,'同じ解析キーを二つの別ファイルの確定結果として並べない');
    assert.match(text,/2/,'同名の本数を残す');
    assert.match(text,/登録先は未確認/);
    assert.doesNotMatch(text,/登録の記述あり/,'どちらのファイルにも登録されているとは断定しない');
    assert.equal(await group.locator('button[data-fs-file-index]').count(),0,'特定できないファイルへ詳細リンクを作らない');
    const notes=await page.locator('#fs-event-notes').innerText();
    assert.match(notes,/shared\.js/);assert.match(notes,/同名/);assert.match(notes,/2/);
    assert.match(notes,/特定|未確認|不完全/);
    await page.locator('#fs-event-search').fill('missing.event');
    assert.equal(await cards(page).count(),0);
    assert.match(await page.locator('#fs-event-notes').innerText(),/shared\.js/,'検索結果が0件でも同名ファイルの未確認を残す');
  });
});
