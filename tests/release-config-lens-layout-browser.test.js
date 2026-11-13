'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {loadToolkit}=require('./helpers/load-toolkit.js');
const {makeEnvGetter}=require('./helpers/dev-base-fake.js');
const {KTReleaseSettingsExport:Export}=require('../src/release-settings-export.js');
const root=path.resolve(__dirname,'..'),clone=value=>JSON.parse(JSON.stringify(value));
test('無料の配置再現：行・寸法・グループ・テーブル、対応位置、倍率、保存ファイル、取得失敗', {timeout:120000},async()=>{
  let pw;try{pw=require('playwright');}catch{pw=require(path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));}
  const row=fields=>({type:'ROW',fields});
  const prod={appId:'398',fields:{
    name:{code:'name',type:'SINGLE_LINE_TEXT',label:'申請者',required:true},
    due:{code:'due',type:'DATE',label:'確認期限'},
    removed:{code:'removed',type:'SINGLE_LINE_TEXT',label:'旧担当'},
    group:{code:'group',type:'GROUP',label:'経理確認'},
    memo:{code:'memo',type:'MULTI_LINE_TEXT',label:'確認内容'},
    table:{code:'table',type:'SUBTABLE',label:'明細',fields:{amount:{code:'amount',type:'NUMBER',label:'金額'}}},
    choice:{code:'choice',type:'DROP_DOWN',label:'区分',noLabel:true,options:{b:{label:'経理',index:'1'},a:{label:'営業',index:'0'}}}
  },layout:[row([{type:'LABEL',elementId:'title',label:'<b>申請フォーム</b><br>受付・確認',size:{width:'500'}}]),
    row([{type:'SINGLE_LINE_TEXT',code:'name',size:{width:'240'}},{type:'DATE',code:'due',size:{width:'180'}},{type:'SINGLE_LINE_TEXT',code:'removed',size:{width:'200'}}]),
    {type:'GROUP',code:'group',layout:[row([{type:'MULTI_LINE_TEXT',code:'memo',size:{width:'420',innerHeight:'90'}}])]},
    {type:'SUBTABLE',code:'table',fields:[{type:'NUMBER',code:'amount',size:{width:'180'}}]},
    row([{type:'DROP_DOWN',code:'choice',size:{width:'240'}},{type:'SPACER',elementId:'space',size:{width:'150',height:'70'}},{type:'HR',elementId:'rule',size:{width:'160'}}]) ]};
  const prev=clone(prod);
  prev.layout[1].fields=[{type:'DATE',code:'due',size:{width:'180'}},{type:'SINGLE_LINE_TEXT',code:'name',size:{width:'320'}},{type:'FILE',code:'attachment',size:{width:'200'}}];
  delete prev.fields.removed;
  prev.fields.attachment={code:'attachment',type:'FILE',label:'申請書'};
  prev.fields.memo.required=true;
  const T=loadToolkit();let fail=false,stale=false,reads=0;
  const load=async()=>{reads++;const value=await T.KTDevBase.loadForRelease({appId:'398',...makeEnvGetter({production:prod,preview:prev,revisions:{production:'1',preview:'2'},fail:fail?{'preview:app/form/layout':new Error('fixture denied')}: {}})});if(stale)value.stale=true;return clone(value);};
  const saved=Export.create(await load(),{environment:'production',domain:'fixture.cybozu.com'}).document;
  const browser=await pw.chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});
  const unexpected=[],errors=[];const output=path.join(root,'tests/.build/config-lens-layout');fs.mkdirSync(output,{recursive:true});
  try{
    const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
    await context.route('**/*',route=>{if(route.request().url()==='https://layout.test.invalid/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="ja"><meta charset="utf-8"><body style="margin:0"><div id="lens"></div><textarea id="draft">未送信の相談</textarea></body></html>'});unexpected.push(route.request().url());return route.abort();});
    const page=await context.newPage();page.setDefaultTimeout(6000);page.on('pageerror',e=>errors.push(e.message));
    await page.exposeFunction('loadBase',load);await page.goto('https://layout.test.invalid/');
    let source=fs.readFileSync(path.join(root,'kintoneAppToolkit.user.js'),'utf8').replace('waitReady().then(() => startToolkit());','');
    const end=source.lastIndexOf('})();');source=source.slice(0,end)+'\nglobalThis.mountLens=mountReleaseConfigLens;\n'+source.slice(end);
    await page.addScriptTag({content:source});
    await page.evaluate(async()=>{window.aiCalls=0;window.lens=mountLens(document.querySelector('#lens'),{loadBase:window.loadBase,domain:'fixture.cybozu.com',explain:()=>{aiCalls++;},localEdits:()=>[]});await lens.onVisible();});
    await page.locator('[data-cl-category="layout"]').first().click();
    const side=i=>page.locator('[data-cl-layout-side="'+i+'"]');
    const field=(i,code)=>side(i).locator('[data-cl-layout-code="'+code+'"]');
    assert.equal(await side(0).count(),1);assert.equal(await side(1).count(),1);
    assert.match(await field(1,'name').getAttribute('class'),/ktcl-layout-changed/);
    assert.equal(await field(1,'name').innerText(),'申請者\nname · 文字列（1行）');
    assert.match(await field(0,'removed').getAttribute('class'),/ktcl-layout-deleted/);
    assert.match(await field(1,'attachment').getAttribute('class'),/ktcl-layout-added/);
    assert.equal(await field(1,'name').evaluate(el=>parseFloat(getComputedStyle(el).width)),320);
    assert.equal(await field(0,'name').evaluate(el=>parseFloat(getComputedStyle(el).width)),240);
    assert.equal(await field(0,'group').locator('[data-cl-layout-code="memo"]').count(),1);
    assert.equal(await field(0,'table').locator('.ktcl-layout-row [data-cl-layout-code="amount"]').count(),1);
    assert.equal(await field(0,'memo').locator('.ktcl-layout-input').evaluate(el=>parseFloat(getComputedStyle(el).minHeight)),90);
    assert.equal(await side(0).locator('[data-cl-layout-label]').innerText(),'申請フォーム\n受付・確認');
    assert.equal(await field(0,'choice').innerText(),'区分\nchoice · ドロップダウン');
    assert.equal(await field(0,'due').locator('.ktcl-layout-input').innerText(),'');
    assert.equal(await field(1,'attachment').locator('.ktcl-layout-input').innerText(),'');
    assert.equal(await page.locator('.ktcl-layout-badge').count(),0);
    assert.doesNotMatch(await side(0).innerText(),/要素ID：|幅 \d+|入力高|営業/);
    const coords=await field(0,'name').evaluate(el=>{const a=el.getBoundingClientRect(),b=el.nextElementSibling.getBoundingClientRect();return {top:a.top,otherTop:b.top,right:a.right,left:b.left};});
    assert.equal(coords.top,coords.otherTop);assert.ok(coords.left>coords.right);
    assert.equal(await page.locator('[data-cl-kind]').count(),0,'配置では本家と同じく変更種別フィルタを表示しない');
    const compact = await page.evaluate(()=>({originHeight:document.querySelector('.ktcl-origins').getBoundingClientRect().height,canvasTop:document.querySelector('.ktcl-layout-pair').getBoundingClientRect().top}));
    assert.ok(compact.originHeight<=70,'比較対象をコンパクトな2行に収める');
    assert.ok(compact.canvasTop<=260,'1440px幅では配置図を画面上部から表示する');
    assert.equal(await page.locator('.ktcl-origin-time').first().isVisible(),false);
    await page.locator('[data-cl-origin="before"] .ktcl-origin-info > summary').click();
    assert.equal(await page.locator('.ktcl-origin-time').first().isVisible(),true);
    await page.locator('[data-cl-origin="before"] .ktcl-origin-info > summary').click();
    await page.locator('.ktcl-layout-help > summary').click();
    assert.match(await page.locator('.ktcl-layout-help').innerText(),/未保存の編集・レコード値・JS/);
    await page.locator('.ktcl-layout-help > summary').click();
    fs.writeFileSync(path.join(output,'compact-measurements.json'),JSON.stringify(compact,null,2));
    await page.screenshot({path:path.join(output,'desktop.png'),fullPage:true});
    await page.locator('[data-cl-layout-zoom]').selectOption('100');
    assert.equal(await page.locator('.ktcl-layout-canvas').first().evaluate(el=>el.style.zoom),'1');
    assert.equal(await page.locator('button[data-cl-layout-match]').count(),0,'対応位置ボタンを置かない');
    await field(1,'memo').locator('.ktcl-layout-input').click();
    assert.equal(await page.locator('.ktcl-layout-selected').count(),2);
    assert.equal(await page.locator('.ktcl-layout-selected[data-cl-layout-code="memo"]').count(),2);
    assert.equal(await field(1,'memo').getAttribute('aria-pressed'),'true');
    assert.equal(await field(1,'group').getAttribute('aria-current'),'false','子項目クリックがグループ選択へ伝播しない');
    await field(0,'name').press('Enter');
    assert.equal(await page.locator('.ktcl-layout-selected[data-cl-layout-code="name"]').count(),2);
    await field(1,'amount').press('Space');
    assert.equal(await page.locator('.ktcl-layout-selected[data-cl-layout-code="amount"]').count(),2);
    await field(0,'group').locator('h4').first().click();
    assert.equal(await page.locator('.ktcl-layout-selected[data-cl-layout-code="group"]').count(),2);
    await field(1,'memo').locator('h4').click();
    await page.evaluate(()=>lens.onVisible());
    assert.equal(await page.locator('[data-cl-layout-zoom]').inputValue(),'100');
    assert.equal(await page.locator('.ktcl-layout-selected').count(),2);
    assert.equal(await field(0,'removed').count(),1,'再描画後も配置全体を表示');
    await page.locator('[data-cl-layout-zoom]').selectOption('75');
    await page.screenshot({path:path.join(output,'matching.png'),fullPage:true});
    for(const width of [760,390]){
      await page.setViewportSize({width,height:1000});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'ページを横にはみ出さない');
      const positions=await page.locator('.ktcl-layout-side').evaluateAll(nodes=>nodes.map(el=>({top:el.getBoundingClientRect().top,bottom:el.getBoundingClientRect().bottom})));
      assert.ok(positions[1].top>=positions[0].bottom,'狭い画面では左右を縦に並べる');
      if(width===390) assert.ok(await side(0).evaluate(el=>el.scrollWidth>el.clientWidth),'横長フォームはペイン内でスクロール');
      await page.screenshot({path:path.join(output,'width-'+width+'.png'),fullPage:true});
    }
    await page.setViewportSize({width:1440,height:1000});
    await page.locator('[data-cl-target]').selectOption('file');
    await page.locator('[data-cl-file]').setInputFiles({name:'saved.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(saved))});
    await side(1).waitFor();
    assert.equal(await field(1,'removed').count(),1);assert.equal(await field(1,'attachment').count(),0);
    assert.equal(await page.locator('.ktcl-layout-node.ktcl-layout-changed,.ktcl-layout-node.ktcl-layout-added,.ktcl-layout-node.ktcl-layout-deleted').count(),0,'差分なしのフォームも両側を表示');
    assert.match(await page.locator('.ktcl-layout-side').nth(1).innerText(),/保存した設定/);
    const hostile=clone(saved);hostile.settings.layout.layout[0].fields[0].label='<b>説明</b><img src="https://forbidden.invalid/x" onerror="window.injected=true"><script>window.injected=true</script><br>安全';
    await page.locator('[data-cl-file]').setInputFiles({name:'untrusted.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(hostile))});
    await page.waitForFunction(()=>document.querySelector('[data-cl-layout-side="1"] [data-cl-layout-label]')?.textContent==='説明\n安全');
    assert.equal(await side(1).locator('img,script').count(),0);assert.equal(await page.evaluate(()=>window.injected),undefined);
    await page.locator('[data-cl-target]').selectOption('preview');
    fail=true;await page.evaluate(()=>lens.refresh());
    assert.equal(await page.locator('[data-cl-layout-unavailable]').count(),1);assert.equal(await page.locator('.ktcl-layout-canvas').count(),0);
    fail=false;stale=true;await page.evaluate(()=>lens.refresh());
    assert.equal(await page.locator('[data-cl-layout-unavailable]').count(),1);assert.equal(await page.locator('.ktcl-layout-canvas').count(),0);
    assert.equal(await page.locator('#draft').inputValue(),'未送信の相談');
    assert.equal(await page.evaluate(()=>aiCalls),0);assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);
    assert.equal(reads,4,'表示・倍率・対応位置・ファイル比較では追加取得しない');
    await page.evaluate(()=>lens.dispose());
  }finally{await browser.close();}
});
