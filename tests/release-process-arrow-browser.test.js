'use strict';
// Real Toolkit theme + process serializer + bundled Mermaid, with all network blocked.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = process.env.KT_ARROW_OUTPUT || path.join(root, 'tests/.build/process-arrow');
function playwright() {
  try { return require(process.env.PLAYWRIGHT_MODULE || 'playwright'); }
  catch { return require(path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
}
function bundle() {
  const source = fs.readFileSync(process.env.KT_SRC || path.join(root, 'kintoneAppToolkit.user.js'), 'utf8')
    .replace('waitReady().then(() => startToolkit());', '');
  const end = source.lastIndexOf('})();'); assert.ok(end > 0);
  return source.slice(0, end) + '\nglobalThis.ArrowTest={mountRoot,buildProcessMermaid};\n' + source.slice(end);
}
function contrast(a, b) {
  const luminance = color => color.match(/[\d.]+/g).slice(0, 3).map(n => {
    n = Number(n) / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4;
  }).reduce((v, n, i) => v + n * [.2126, .7152, .0722][i], 0);
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}
for (const colorScheme of ['dark', 'light']) test(`Health process arrows remain readable: ${colorScheme}`, async () => {
  const browser = await playwright().chromium.launch({channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true});
  try {
    const context = await browser.newContext({colorScheme, viewport: {width:1440,height:900}, serviceWorkers:'block'});
    const unexpected = [], errors = [];
    await context.route('**/*', route => {
      const url = route.request().url();
      if (url === 'https://process-arrow.test.invalid/') return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="ja"><meta charset="utf-8"><body></body></html>'});
      if (url.startsWith('https://www.google.com/s2/favicons?')) return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg"/>'});
      unexpected.push(url); return route.abort();
    });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    await page.goto('https://process-arrow.test.invalid/');
    await page.evaluate(() => { localStorage.setItem('ktTemplatesMovedNotice.v1','1'); localStorage.setItem('ktToolkitFull.v1','1'); });
    await page.addScriptTag({content:bundle()});
    await page.addScriptTag({path:path.join(root,'dist/extension/vendor/mermaid/mermaid.min.js')});
    await page.evaluate(async () => {
      const shell = ArrowTest.mountRoot();
      const names = ['下書き','内容確認','承認待ち','差し戻し','完了'];
      const status = {states:Object.fromEntries(names.map((name,index)=>[name,{name,index}])), actions:[
        {from:names[0],to:names[1],name:'申請する'}, {from:names[1],to:names[2],name:'承認へ回す'},
        {from:names[1],to:names[3],name:'差し戻す'}, {from:names[2],to:names[4],name:'承認して完了'},
        {from:names[2],to:names[1],name:'再確認を依頼'}, {from:names[3],to:names[1],name:'修正して再申請'}]};
      const health = shell.querySelector('#view-health');
      health.innerHTML = '<h2>Process Analysis (Flow & Distribution)</h2><div id="kt-process-diagram"><div class="mermaid"></div></div><div id="other-diagram" class="mermaid"></div>';
      health.querySelector('#kt-process-diagram .mermaid').textContent = ArrowTest.buildProcessMermaid(status);
      health.querySelector('#other-diagram').textContent = 'flowchart LR\n A[Other] --> B[Diagram]';
      shell.ktTabs.switchTab('health');
      mermaid.initialize({startOnLoad:false,securityLevel:'antiscript'});
      await mermaid.run({nodes:[...health.querySelectorAll('.mermaid')]});
    });
    const result = await page.evaluate(() => {
      const diagram = document.querySelector('#kt-process-diagram');
      let background = 'rgb(255, 255, 255)';
      for(let el=diagram;el;el=el.parentElement) {
        const value=getComputedStyle(el).backgroundColor;
        if(value!=='rgba(0, 0, 0, 0)' && value!=='transparent') {background=value;break;}
      }
      return {background, nodes:diagram.querySelectorAll('.node').length,
        lines:[...diagram.querySelectorAll('.flowchart-link')].map(el=>{
          const style=getComputedStyle(el), id=style.markerEnd.match(/#([^"\)]+)/)?.[1];
          const marker=id && document.getElementById(id)?.querySelector('path');
          return {stroke:style.stroke,width:parseFloat(style.strokeWidth),marker:marker?getComputedStyle(marker).fill:null};
        }), otherStroke:getComputedStyle(document.querySelector('#other-diagram .flowchart-link')).stroke,
        nodeFill:getComputedStyle(diagram.querySelector('.node rect')).fill,
        otherNodeFill:getComputedStyle(document.querySelector('#other-diagram .node rect')).fill,
        labels:[...diagram.querySelectorAll('.edgeLabel')].map(el=>el.textContent.trim()).filter(Boolean)};
    });
    result.contrasts=result.lines.map(line=>contrast(line.stroke,result.background));
    fs.mkdirSync(output,{recursive:true});
    fs.writeFileSync(path.join(output,colorScheme+'.json'),JSON.stringify(result,null,2));
    await page.screenshot({path:path.join(output,colorScheme+'.png')});
    assert.equal(result.nodes,5,'all stages remain'); assert.equal(result.lines.length,6,'all transitions including returns remain');
    assert.equal(new Set(result.labels).size,6,'all action labels remain');
    assert.equal(result.otherStroke,'rgb(51, 51, 51)','unrelated Mermaid diagrams are unchanged');
    assert.equal(result.nodeFill,result.otherNodeFill,'stage colors are unchanged');
    for(const [i,line] of result.lines.entries()) {
      assert.equal(line.marker,line.stroke,'arrowhead matches its connecting line');
      assert.ok(line.width>=2,'line width is at least 2px');
      assert.ok(result.contrasts[i]>=3,`arrow contrast ${result.contrasts[i].toFixed(2)} must be >=3`);
    }
    assert.deepEqual(unexpected,[],'no AI, kintone or other network calls'); assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
});
