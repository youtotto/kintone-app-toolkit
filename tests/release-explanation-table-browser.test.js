'use strict';
// The real Toolkit shell and shared styles are mounted; all network access is intercepted.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..');
const document = { id: 'table-explanation', title: 'アプリの説明', sections: [{
  heading: '項目', paragraphs: [], items: [],
  table: { columns: ['項目', '説明'], rows: [['備考', '引き継ぐ内容を入力します。']] }, evidenceIds: []
}], unknowns: [], facts: [] };
const state = { phase: 'idle', messages: [], runs: [], explanations: [document], explanationId: document.id };

function playwright() {
  try { return require(process.env.PLAYWRIGHT_MODULE || 'playwright'); }
  catch { return require(path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
}
function toolkitSource() {
  let source = fs.readFileSync(process.env.KT_SRC || path.join(root, 'kintoneAppToolkit.user.js'), 'utf8')
    .replace('waitReady().then(() => startToolkit());', '');
  const end = source.lastIndexOf('})();');
  assert.ok(end >= 0);
  return source.slice(0, end) + '\nglobalThis.TableShellTest={mountRoot};\n' + source.slice(end);
}
const workspaceSource = fs.readFileSync(process.env.KT_RELEASE_WORKSPACE_SRC || path.join(root, 'src/release-workspace.js'), 'utf8');
const viewSource = fs.readFileSync(process.env.KT_RELEASE_VIEW_SRC || path.join(root, 'src/release-view.js'), 'utf8')
  + '\nglobalThis.TableReleaseView=KTReleaseView;\n';

for (const colorScheme of ['dark', 'light']) {
  test('説明の表は本物の外枠と' + colorScheme + '配色を共有し、見出し固定の役割は維持する', { timeout: 45000 }, async () => {
    const browser = await playwright().chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme });
      const unexpected = [], errors = [];
      await context.route('**/*', route => {
        const url = route.request().url();
        if (url === 'https://table-styles.test.invalid/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="ja"><meta charset="utf-8"><body></body></html>' });
        // The production shell requests its public favicon. Supply a local image instead.
        if (url.startsWith('https://www.google.com/s2/favicons?')) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' });
        unexpected.push(url);
        return route.abort();
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto('https://table-styles.test.invalid/');
      await page.addScriptTag({ content: toolkitSource() });
      await page.addScriptTag({ content: workspaceSource });
      await page.addScriptTag({ content: viewSource });
      await page.evaluate(state => {
        const shell = TableShellTest.mountRoot();
        shell.querySelector('#view-fields').innerHTML = '<table id="unchanged-table"><thead><tr><th>既存の見出し</th></tr></thead><tbody><tr><td>既存の内容</td></tr></tbody></table>';
        shell.querySelector('#view-ai').innerHTML = TableReleaseView.render(state);
        shell.ktTabs.switchTab('ai');
      }, state);
      assert.equal(await page.locator('#kt-toolkit .ktr-explanation table').count(), 1);
      const actual = await page.evaluate(() => {
        const style = selector => {
          const s = getComputedStyle(document.querySelector(selector));
          return { color: s.color, background: s.backgroundColor, padding: s.padding,
            border: s.borderBottomColor, position: s.position, top: s.top };
        };
        return { th: style('.ktr-explanation th'), td: style('.ktr-explanation td'), other: style('#unchanged-table th'), workspace: style('.ktr-workspace'), button: style('#kt-toolkit .btn') };
      });
      assert.equal(actual.th.background, actual.other.background, '説明の見出し背景');
      assert.equal(actual.th.color, actual.workspace.color, '説明の見出し文字');
      assert.equal(actual.td.background, actual.workspace.background, '説明の本文背景');
      assert.equal(actual.td.color, actual.workspace.color, '説明の本文文字');
      for (const cell of [actual.th, actual.td]) {
        assert.equal(cell.padding, '9px 10px', '説明の表の余白');
        assert.equal(cell.border, actual.button.border, '説明の表の罫線');
        assert.equal(cell.position, 'static', '旧画面の見出し固定を継承しない');
        assert.equal(cell.top, 'auto');
      }
      assert.equal(actual.other.padding, '9px 10px');
      assert.equal(actual.other.position, 'sticky');
      assert.deepEqual(errors, []);
      assert.deepEqual(unexpected, []);
    } finally { await browser.close(); }
  });
}

