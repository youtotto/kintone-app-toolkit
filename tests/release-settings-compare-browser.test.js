'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { loadToolkit } = require('./helpers/load-toolkit.js');
const { makeEnvGetter } = require('./helpers/dev-base-fake.js');
const { KTReleaseSettingsExport: Export } = require('../src/release-settings-export.js');
const root = path.resolve(__dirname, '..'), clone = value => JSON.parse(JSON.stringify(value));

test('保存→ファイル比較→環境切替・再読込を無料で行い、別アプリ・未取得・競合を混ぜない', { timeout: 120000 }, async () => {
  let pw; try { pw = require(process.env.PLAYWRIGHT_MODULE || 'playwright'); }
  catch { pw = require(path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
  const prod = { appId: '398', appName: '保存比較', settings: { name: '保存比較', description: '' },
    fields: { memo: { type: 'SINGLE_LINE_TEXT', code: 'memo', label: '備考', required: false } },
    layout: [{ type: 'ROW', fields: [{ code: 'memo', type: 'SINGLE_LINE_TEXT' }] }],
    views: { views: { all: { id: '1', name: 'すべて', type: 'LIST', fields: ['memo'], sort: 'memo asc' } } },
    adminNotes: { content: '', includeInTemplateAndDuplicates: false } };
  const prev = clone(prod);
  const T = loadToolkit(), calls = [], unexpected = [], errors = [], downloads = [];
  let revision = '2', hold = false, releaseRead, failCurrent = false;
  const load = async () => {
    const get = makeEnvGetter({ production: prod, preview: prev, revisions: { production: '1', preview: revision },
      fail: failCurrent ? { 'preview:app/views': new Error('fixture unavailable') } : {} });
    const result = await T.KTDevBase.loadForRelease({ appId: '398', ...get });
    calls.push(...get.calls);
    if (hold) { hold = false; await new Promise(resolve => { releaseRead = resolve; }); }
    return clone(result);
  };
  const original = Export.create(await load(), { environment: 'production', domain: 'fixture.cybozu.com' });
  prev.fields.memo.required = true;
  prev.fields.deadline = { type: 'DATE', code: 'deadline', label: '確認期限', required: false };
  prev.adminNotes.content = '<img src=x onerror=alert(1)>管理メモ';
  const browser = await pw.chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
    await context.route('**/*', route => {
      if (route.request().url() === 'https://settings.test.invalid/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="ja"><meta charset="utf-8"><body style="margin:0"><div id="lens"></div><textarea id="chat">未送信の相談</textarea><textarea id="code">手元のコード</textarea></body></html>' });
      unexpected.push(route.request().url()); return route.abort();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(7000); page.on('pageerror', e => errors.push(e.message));
    await page.exposeFunction('loadBase', load);
    await page.exposeFunction('download', (filename, text) => downloads.push({ filename, document: JSON.parse(text) }));
    await page.goto('https://settings.test.invalid/');
    let source = fs.readFileSync(path.join(root, 'kintoneAppToolkit.user.js'), 'utf8').replace('waitReady().then(() => startToolkit());', '');
    const end = source.lastIndexOf('})();');
    source = source.slice(0, end) + '\nglobalThis.mountLensTest=mountReleaseConfigLens;\n' + source.slice(end);
    await page.addScriptTag({ content: source });
    await page.evaluate(() => {
      window.aiCalls = 0; window.visible = true;
      window.lens = mountLensTest(document.querySelector('#lens'), {
        domain: 'fixture.cybozu.com', loadBase: window.loadBase, isVisible: () => visible,
        localEdits: () => [{ name: 'draft.js', target: 'desktop', state: 'edited', text: '手元のコード' }],
        downloadText: window.download, explain: () => { aiCalls++; }
      });
      return lens.onVisible();
    });
    const pane = () => page.locator('#lens');
    const action = name => pane().locator('[data-cl-action="' + name + '"]');
    const ready = () => page.waitForFunction(() => !document.querySelector('[data-cl-action="refresh"]').disabled);
    const upload = async (document, filename = 'old-settings.json') => {
      const chooser = page.waitForEvent('filechooser');
      await action('open-file').click();
      await (await chooser).setFiles({ name: filename, mimeType: 'application/json', buffer: Buffer.from(typeof document === 'string' ? document : JSON.stringify(document)) });
      await ready();
    };
    const category = async id => { await pane().locator('[data-cl-category="' + id + '"]').click(); return pane().locator('[data-cl-result-category="' + id + '"]'); };

    await action('save-production').click(); await ready();
    assert.equal(downloads.length, 1);
    assert.equal(downloads[0].document.source.appId, '398');
    const readCount = calls.length;
    await upload(downloads[0].document);
    assert.equal(calls.length, readCount, '取得済み設定とファイルの比較は再取得を伴わない');
    assert.equal(await action('explain').isDisabled(), true, '保存ファイルを通常のAI比較へ流さない');
    let fields = await category('fields');
    assert.equal(await fields.locator('.ktcl-entry').count(), 2);
    await fields.locator('.ktcl-entry > summary').first().click();
    assert.match(await fields.innerText(), /保存ファイル（運用環境）/);
    assert.match(await fields.innerText(), /現在のアプリ（動作テスト環境）/);
    await pane().locator('[data-cl-environment]').selectOption('production');
    fields = await category('fields');
    assert.equal(await fields.locator('.ktcl-entry').count(), 0);
    assert.match(await fields.innerText(), /変更はありません/);
    await pane().locator('[data-cl-environment]').selectOption('preview');
    await action('save-preview').click(); await ready();
    assert.equal(downloads[1].document.source.environment, 'preview');
    assert.equal(downloads[1].document.settings.fields.properties.memo.required, true, '保存ファイルではなく現在設定を再保存する');

    const other = clone(original.document);
    other.source.appId = '900'; other.source.domain = 'other.cybozu.com';
    other.settings.views.views.all.id = '789';
    other.settings.adminNotes.content = '<img src=x onerror=alert(1)>保存側';
    other.coverage.find(row => row.id === 'layout').status = 'unavailable';
    await upload(other, '<saved>.json');
    assert.equal(await pane().locator('[data-cl-cross-app]').count(), 1);
    assert.match(await pane().locator('.ktcl-provenance').textContent(), /other.cybozu.com \/ アプリ 900/);
    assert.match(await (await category('views')).innerText(), /変更はありません/);
    assert.match(await (await category('layout')).innerText(), /比較できていません/);
    const notes = await category('notes'); await notes.locator('summary').click();
    assert.match(await notes.innerText(), /保存側/);
    assert.equal(await pane().locator('img').count(), 0);
    assert.equal(await pane().locator('[data-cl-action="restore"],[data-cl-action="apply"]').count(), 0);
    const out = path.join(__dirname, '.build/release-settings-compare'); fs.mkdirSync(out, { recursive: true });
    await page.screenshot({ path: path.join(out, 'saved-compare-wide.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await pane().evaluate(el => el.scrollWidth <= el.clientWidth + 2), true);
    await page.screenshot({ path: path.join(out, 'saved-compare-narrow.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });

    // Cancelling a selection keeps the previous result, while an invalid file
    // clears it so its differences cannot appear to belong to the new file.
    await pane().locator('[data-cl-file]').setInputFiles([]);
    assert.equal(await pane().locator('[data-cl-cross-app]').count(), 1);
    await upload('{broken');
    assert.match(await pane().locator('[data-cl-error]').innerText(), /JSONを読み取れません/);
    assert.equal(await pane().locator('[data-cl-category]').count(), 0);
    assert.equal(await action('explain').isDisabled(), true);
    await upload(original.document);
    assert.equal(await pane().locator('[data-cl-cross-app]').count(), 0);
    failCurrent = true; await action('refresh').click(); await ready();
    assert.match(await (await category('views')).innerText(), /現在のアプリ.*取得できていない/);
    assert.equal(await pane().locator('.ktcl-filename').innerText(), 'old-settings.json');

    // An invalidated delayed acquisition must not be published after a tab
    // switch. The selected file survives and compares against the next read.
    failCurrent = false; hold = true; releaseRead = null;
    await action('refresh').click();
    while (!releaseRead) await new Promise(resolve => setTimeout(resolve, 10));
    await page.evaluate(() => { visible = false; lens.markStale(); });
    revision = '3'; releaseRead(); await ready();
    assert.equal(await pane().locator('[data-cl-category]').count(), 0);
    await page.evaluate(() => { visible = true; return lens.onVisible(); }); await ready();
    assert.match(await pane().locator('.ktcl-provenance').textContent(), /設定の版 3/);
    assert.equal(await pane().locator('.ktcl-filename').innerText(), 'old-settings.json');
    await action('environment-mode').click();
    assert.equal(await pane().locator('[data-cl-file-comparison]').count(), 0);
    assert.equal(await action('explain').isDisabled(), false);
    assert.match(await pane().innerText(), /運用環境の版 1 → 動作テスト環境の版 3/);

    // Late file text must not restore a selection invalidated during reading.
    await page.evaluate(() => {
      const originalText = File.prototype.text;
      File.prototype.text = async function () {
        const text = await originalText.call(this);
        await new Promise(resolve => { window.releaseFile = resolve; });
        return text;
      };
    });
    await pane().locator('[data-cl-file]').setInputFiles({ name: 'late.json', mimeType: 'application/json', buffer: Buffer.from(original.text) });
    await page.waitForFunction(() => typeof window.releaseFile === 'function');
    await page.evaluate(() => { visible = false; lens.markStale(); releaseFile(); }); await ready();
    assert.equal(await pane().locator('.ktcl-filename').count(), 0);
    assert.equal(await pane().locator('[data-cl-category]').count(), 0);
    assert.equal(await page.locator('#chat').inputValue(), '未送信の相談');
    assert.equal(await page.locator('#code').inputValue(), '手元のコード');
    assert.equal(await page.evaluate(() => aiCalls), 0);
    assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
    assert.ok(calls.every(call => /^\/k\/v1\/(preview\/)?(app\/|record\/acl|field\/acl)/.test(call)));
    await page.evaluate(() => lens.dispose()); await context.close();
  } finally { await browser.close(); }
});
