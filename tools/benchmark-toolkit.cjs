'use strict';
// Offline, synthetic browser baseline. Does not exercise real kintone/AI latency.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const crypto = require('node:crypto'), assert = require('node:assert/strict');
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const root = path.resolve(option('--source-root', path.join(__dirname, '..')));
const output = option('--out', null), samples = Number(option('--samples', '9'));
if (!output || !Number.isSafeInteger(samples) || samples < 3) throw Error('Use --out <file> [--source-root <checkout>] [--samples >=3]');
let pw; try { pw = require(process.env.PLAYWRIGHT_MODULE || 'playwright'); }
catch { pw = require(path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
const file = path.join(root, 'kintoneAppToolkit.user.js'), raw = fs.readFileSync(file, 'utf8').replace(/\r\n/g,'\n');
let source = raw.replace('waitReady().then(() => startToolkit());', '');
assert.notEqual(source, raw, 'disable automatic network startup');
const end = source.lastIndexOf('})();'); assert.ok(end > 0);
source = source.slice(0, end) + '\nglobalThis.Bench={mountRoot,renderFields,KTReleaseView,KTReleaseWorkspace,KTReleaseHistory,KTReleaseHistorySession};\n' + source.slice(end);
const summarize = values => { const sorted = values.slice().sort((a,b)=>a-b); return { median: sorted[Math.floor(sorted.length/2)], p95: sorted[Math.ceil(sorted.length*.95)-1], min:sorted[0], max:sorted.at(-1) }; };
(async () => {
  const browser = await pw.chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
  const rows = [], errors = [], unexpected = [];
  try {
    // One discarded warm-up, then fresh contexts. Keep the machine otherwise idle.
    for (let iteration = -1; iteration < samples; iteration++) {
      const context = await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
      try {
        await context.route('**/*', route => {
          const url=route.request().url();
          if(url==='https://benchmark.test.invalid/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="ja"><meta charset="utf-8"><body></body></html>'});
          if(url==='https://www.google.com/s2/favicons?domain=https%3A%2F%2Fgithub.com%2Fyoutotto%2Fkintone-app-toolkit&sz=64')return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/>'});
          unexpected.push(url);return route.abort();
        });
        const page = await context.newPage(); page.on('pageerror', e=>errors.push(e.message));
        await page.goto('https://benchmark.test.invalid/');
        await page.evaluate(()=>{window.kintone={app:{getId:()=>310},getLoginUser:()=>({id:'benchmark-user'})};});
        // Start inside the browser, after transferring the source to it. Exclude
        // filesystem and automation transport time from script compilation/init.
        await page.evaluate(script=>{
          const start=performance.now(),tag=document.createElement('script');
          tag.textContent=script;document.head.appendChild(tag);
          window.scriptLoadMs=performance.now()-start;
        },source);
        const row = await page.evaluate(async () => {
          const out={scriptLoadMs:window.scriptLoadMs};
          const paint=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
          const timed=async(name,fn)=>{const at=performance.now();await fn();out[name]=performance.now()-at;};
          const T=Bench;
          await timed('panelFieldsPaintMs',async()=>{
            window.shell=T.mountRoot();
            const fields=Object.fromEntries(Array.from({length:500},(_,i)=>['field_'+i,{code:'field_'+i,type:'SINGLE_LINE_TEXT',label:'確認項目 '+i,required:false}]));
            await T.renderFields(shell,{appId:'310',fields,layout:[]});
            shell.ktTabs.switchTab('fields');await paint();
          });
          const denied=()=>{throw Error('Benchmark must not call services or write kintone');};
          const controller=T.KTReleaseWorkspace.create({services:{propose:denied,plan:denied,generate:denied},loadBase:denied,execution:{}});
          const session=controller.exportSession(), state=session.state;
          state.messages=Array.from({length:200},(_,i)=>({role:i%2?'assistant':'user',text:`確認 ${i}: `+'既存の設定と入力条件を維持し、変更内容を確認します。'.repeat(20)}));
          const payload={session,draft:'保存対象の下書き',editor:{version:1,files:Array.from({length:10},(_,i)=>({name:`draft-${i}.js`,isNew:true,text:'// 検証用の手編集\n'.repeat(1000)})),active:null}};
          out.payloadBytes=new TextEncoder().encode(JSON.stringify(payload)).length;
          controller.getState=()=>JSON.parse(JSON.stringify(state));
          const host=document.createElement('div');host.style.height='750px';shell.querySelector('#view-ai').appendChild(host);
          await timed('longConversationPaintMs',async()=>{window.view=T.KTReleaseView.create(host,{controller,connection:{connected:true,available:true}});shell.ktTabs.switchTab('ai');await paint();});
          shell.ktTabs.onSwitch(id=>{if(id==='ai')view.onVisible();});
          await timed('tabRoundTripPaintMs',async()=>{shell.ktTabs.switchTab('fields');await paint();shell.ktTabs.switchTab('ai');await paint();});
          const originalMessage=host.querySelector('.ktr-message'), originalInput=host.querySelector('#kt-release-input');
          await timed('fiveUnchangedRedrawsMs',()=>{for(let i=0;i<5;i++)view.render();});
          out.messageNodeRetained=Number(originalMessage===host.querySelector('.ktr-message'));
          out.inputNodeRetained=Number(originalInput===host.querySelector('#kt-release-input'));
          const store=T.KTReleaseHistory.create({scope:{domain:location.origin,appId:'310',userId:'benchmark-user',environment:'preview'},dbName:'benchmark-history'});
          const history=T.KTReleaseHistorySession.create({store,capture:()=>payload,restore:async()=>true,verifyAccess:async()=>true});
          await timed('firstHistorySaveMs',()=>history.flush());
          payload.draft+='追記';
          await timed('updatedHistorySaveMs',()=>history.flush());
          await timed('unchangedHistorySaveMs',()=>history.flush());
          await timed('tenUnchangedHistorySavesMs',async()=>{for(let i=0;i<10;i++)await history.flush();});
          // Count allocations separately from timings, restoring native JSON even on failure.
          const parse=JSON.parse,stringify=JSON.stringify;
          out.unchangedJsonParses=0;out.unchangedJsonStringifies=0;
          try {
            JSON.parse=function(...args){out.unchangedJsonParses++;return parse.apply(this,args);};
            JSON.stringify=function(...args){out.unchangedJsonStringifies++;return stringify.apply(this,args);};
            await history.flush();
          } finally {JSON.parse=parse;JSON.stringify=stringify;}
          const saved=await store.load(history.getCurrent().id);
          if(JSON.stringify(saved.payload)!==JSON.stringify(payload))throw Error('History round-trip mismatch');
          if(host.querySelectorAll('.ktr-message').length!==200)throw Error('Conversation truncated');
          out.domNodes=document.querySelectorAll('*').length;
          window.disposeBenchmark=async()=>{await history.dispose();view.dispose();};return out;
        });
        const cdp=await context.newCDPSession(page);
        await cdp.send('HeapProfiler.collectGarbage');await cdp.send('Performance.enable');
        const activeMetrics=await cdp.send('Performance.getMetrics');
        row.activeJsHeapBytes=activeMetrics.metrics.find(x=>x.name==='JSHeapUsedSize').value;
        await page.evaluate(async()=>{await window.disposeBenchmark();delete window.disposeBenchmark;});
        await cdp.send('HeapProfiler.collectGarbage');
        const metrics=await cdp.send('Performance.getMetrics');
        row.retainedJsHeapBytes=metrics.metrics.find(x=>x.name==='JSHeapUsedSize').value;
        if(iteration>=0)rows.push(row);
      } finally { await context.close(); }
    }
    assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
    const result={timestamp:new Date().toISOString(),sourceRoot:root,sourceSha256:crypto.createHash('sha256').update(raw).digest('hex'),sourceBytes:Buffer.byteLength(raw),browser:browser.version(),node:process.version,cpu:os.cpus()[0]?.model,samples,warmup:1,
      scope:'Isolated Edge, synthetic 500 fields / 200 messages / 10 editor drafts, real IndexedDB. Full app network startup and real AI latency excluded. Paint includes two animation frames. Active and disposed JS heap both measured after forced GC; not peak memory. capture returns the synthetic snapshot, excluding production exportSession work.',
      errors,unexpectedRequests:unexpected,summary:Object.fromEntries(Object.keys(rows[0]).map(k=>[k,summarize(rows.map(r=>r[k]))])),rows};
    fs.mkdirSync(path.dirname(path.resolve(output)),{recursive:true});fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');
    console.log(JSON.stringify({sourceBytes:result.sourceBytes,browser:result.browser,summary:result.summary},null,2));
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
