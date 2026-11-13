'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { loadToolkit } = require('./helpers/load-toolkit.js');
const { makeEnvGetter } = require('./helpers/dev-base-fake.js');
const { KTReleaseSettingsExport: Export } = require('../src/release-settings-export.js');
const root = path.resolve(__dirname, '..'), clone = value => JSON.parse(JSON.stringify(value));

test('運用環境を左に固定し、同じ画面で動作テストと保存ファイルを選んで比較する', { timeout: 120000 }, async () => {
  let pw; try { pw = require(process.env.PLAYWRIGHT_MODULE || 'playwright'); }
  catch { pw = require(path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
  const prod = { appId: '398', appName: '現在の運用アプリ', settings: { name: '現在の運用アプリ', description: '' },
    fields: { memo: { type: 'SINGLE_LINE_TEXT', code: 'memo', label: '備考', required: false } },
    layout: [{ type: 'ROW', fields: [{ code: 'memo', type: 'SINGLE_LINE_TEXT' }] }],
    views: { views: { all: { id: '1', name: 'すべて', type: 'LIST', fields: ['memo'], sort: 'memo asc' } } },
    adminNotes: { content: '', includeInTemplateAndDuplicates: false } };
  const prev = clone(prod);
  prev.appName = '現在の動作テストアプリ'; prev.settings.name = '現在の動作テストアプリ';
  const T = loadToolkit(), calls = [], unexpected = [], errors = [], downloads = [];
  let revision = '2', productionRevision = '1', hold = false, releaseRead, failCurrent = false;
  const load = async () => {
    const get = makeEnvGetter({ production: prod, preview: prev, revisions: { production: productionRevision, preview: revision },
      fail: failCurrent ? { 'production:app/views': new Error('fixture unavailable') } : {} });
    const result = await T.KTDevBase.loadForRelease({ appId: '398', ...get });
    calls.push(...get.calls);
    if (hold) { hold = false; await new Promise(resolve => { releaseRead = resolve; }); }
    return clone(result);
  };
  const original = Export.create(await load(), { environment: 'production', domain: 'fixture.cybozu.com' });
  original.document.settings.settings.name = '保存時のアプリ';
  original.document.source.capturedAt = '2026-10-01T02:03:04.000Z';
  original.document.savedAt = '2026-10-02T03:04:05.000Z';
  original.document.settings.fields.properties.memo.required = true;
  original.document.settings.fields.properties.archived = { type: 'SINGLE_LINE_TEXT', code: 'archived', label: '保存ファイルだけの項目', required: false };
  original.text = JSON.stringify(original.document);
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
    const origin = side => pane().locator('section[data-cl-origin="' + side + '"]');
    const visibleOrigin = async side => {
      const card = origin(side);
      assert.equal(await card.isVisible(), true, side + 'の比較対象は開く操作なしで見える');
      assert.equal(await card.evaluate(el => !!el.closest('details:not([open])')), false);
      return card.innerText();
    };
    const ready = () => page.waitForFunction(() => !document.querySelector('[data-cl-action="refresh"]').disabled);
    const upload = async (document, filename = 'old-settings.json') => {
      const chooser = page.waitForEvent('filechooser');
      await action('open-file').click();
      await (await chooser).setFiles({ name: filename, mimeType: 'application/json', buffer: Buffer.from(typeof document === 'string' ? document : JSON.stringify(document)) });
      await ready();
    };
    const category = async id => { await pane().locator('[data-cl-category="' + id + '"]').click(); return pane().locator('[data-cl-result-category="' + id + '"]'); };


    const target = () => origin('after').locator('[data-cl-target]');
    assert.deepEqual(await target().locator('option').evaluateAll(nodes => nodes.map(el => el.value)), ['preview', 'file'], '比較相手は動作テストと保存ファイルの2種類だけ');
    assert.equal(await pane().locator('[data-cl-environment],[data-cl-action="environment-mode"]').count(), 0, '別画面へ戻る操作や保存ファイル対動作テストの選択を置かない');
    assert.match(await visibleOrigin('before'), /左.*運用環境/);
    assert.match(await origin('before').innerText(), /現在の運用アプリ/);
    assert.match(await visibleOrigin('after'), /現在の動作テストアプリ/);
    await action('save-production').click(); await ready();
    assert.equal(downloads.length, 1);
    assert.equal(downloads[0].document.source.appId, '398');
    const readCount = calls.length;
    await target().selectOption('file');
    assert.equal(await pane().locator('[data-cl-category]').count(), 0, 'ファイル未選択の結果に環境間の差を残さない');
    assert.match(await visibleOrigin('before'), /現在の運用アプリ/);
    assert.match(await visibleOrigin('after'), /ファイル/);
    assert.equal(await origin('after').locator('[data-cl-action="open-file"]').isVisible(), true);
    assert.equal(await action('explain').isDisabled(), true);
    await upload(downloads[0].document, 'fresh-production.json');
    assert.match(await pane().locator('[data-cl-summary]').innerText(), /変更はありません/, '保存した運用設定を運用と比較すれば差はない');
    await upload(original.document);
    await origin('after').locator('.ktcl-origin-info > summary').click();
    const savedOrigin = await visibleOrigin('after');
    assert.match(savedOrigin, /保存時のアプリ/);
    assert.match(savedOrigin, /fixture.cybozu.com/);
    assert.match(savedOrigin, /アプリ 398/);
    assert.match(savedOrigin, /運用環境/);
    assert.match(savedOrigin, /old-settings.json/);
    assert.match(savedOrigin, /取得[\s\S]*2026[/-]10[/-]0?1/);
    assert.match(savedOrigin, /保存[\s\S]*2026[/-]10[/-]0?2/);
    assert.deepEqual(await origin('after').locator('time').evaluateAll(nodes => nodes.map(el => el.getAttribute('datetime'))), ['2026-10-01T02:03:04.000Z', '2026-10-02T03:04:05.000Z'], '設定取得とファイル保存の日時を取り違えない');
    await origin('before').locator('.ktcl-origin-info > summary').click();
    const currentOrigin = await visibleOrigin('before');
    assert.match(currentOrigin, /左.*運用環境/);
    assert.match(currentOrigin, /現在の運用アプリ/);
    assert.match(currentOrigin, /fixture.cybozu.com/);
    assert.match(currentOrigin, /アプリ 398/);
    assert.match(currentOrigin, /取得/);
    assert.equal(calls.length, readCount, '取得済み設定とファイルの比較は再取得を伴わない');
    assert.equal(await action('explain').isDisabled(), true, '保存ファイルを通常のAI比較へ流さない');
    let fields = await category('fields');
    assert.equal(await fields.locator('.ktcl-entry').count(), 2);
    await fields.locator('.ktcl-entry > summary').first().click();
    const table = fields.locator('table').first();
    assert.match(await table.locator('thead').innerText(), /左.*運用環境[\s\S]*右.*保存/);
    assert.deepEqual(await table.locator('tbody tr').first().locator('td').allTextContents(), ['いいえ', 'はい'], '運用が左、保存ファイルが右で値を逆転させない');
    await pane().locator('[data-cl-kind="added"]').click();
    assert.match(await pane().locator('[data-cl-result-category="fields"]').innerText(), /保存ファイルだけの項目/);
    assert.doesNotMatch(await pane().locator('[data-cl-result-category="fields"]').innerText(), /確認期限/);
    const beforeSwitch = calls.length;
    await target().selectOption('preview');
    assert.equal(await pane().locator('[data-cl-category="fields"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await pane().locator('[data-cl-kind="added"]').getAttribute('aria-pressed'), 'true');
    assert.match(await visibleOrigin('before'), /現在の運用アプリ/);
    assert.match(await visibleOrigin('after'), /現在の動作テストアプリ/);
    assert.match(await pane().locator('[data-cl-result-category="fields"]').innerText(), /確認期限/);
    assert.equal(await action('explain').isDisabled(), false);
    await target().selectOption('file');
    assert.equal(await pane().locator('[data-cl-category="fields"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await pane().locator('[data-cl-kind="added"]').getAttribute('aria-pressed'), 'true');
    assert.match(await visibleOrigin('after'), /old-settings.json/);
    assert.match(await pane().locator('[data-cl-result-category="fields"]').innerText(), /保存ファイルだけの項目/);
    assert.equal(calls.length, beforeSwitch, '比較相手の切替だけでは再取得しない');
    await pane().locator('[data-cl-kind="all"]').click();
    await action('save-preview').click(); await ready();
    assert.equal(downloads[1].document.source.environment, 'preview');
    assert.equal(downloads[1].document.settings.fields.properties.memo.required, true, '保存ファイルではなく現在設定を再保存する');

    const other = clone(original.document);
    other.source.appId = '900'; other.source.domain = 'other.cybozu.com';
    other.settings.settings.name = '別アプリの保存設定 ' + '長いアプリ名'.repeat(12);
    other.settings.views.views.all.id = '789';
    other.settings.adminNotes.content = '<img src=x onerror=alert(1)>保存側';
    other.coverage.find(row => row.id === 'layout').status = 'unavailable';
    await upload(other, '<saved>.json');
    assert.equal(await pane().locator('[data-cl-cross-app]').count(), 1);
    assert.match(await visibleOrigin('after'), /別アプリの保存設定/);
    await origin('after').locator('.ktcl-origin-info > summary').click();
    assert.match(await origin('after').innerText(), /other.cybozu.com/);
    assert.match(await origin('after').innerText(), /アプリ 900/);
    assert.match(await visibleOrigin('before'), /現在の運用アプリ/);
    assert.match(await origin('before').innerText(), /アプリ 398/);
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
    for (const side of ['before', 'after']) {
      await visibleOrigin(side);
      assert.equal(await origin(side).evaluate(el => el.scrollWidth <= el.clientWidth + 2), true, side + 'の長い情報も狭い画面からはみ出さない');
    }
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
    assert.match(await (await category('views')).innerText(), /現在.*取得できていない/);
    assert.equal(await pane().locator('.ktcl-filename').innerText(), 'old-settings.json');

    // An invalidated delayed acquisition must not be published after a tab
    // switch. The selected file survives and compares against the next read.

    const previousCapturedAt = await origin('before').locator('time').getAttribute('datetime');
    failCurrent = false; hold = true; releaseRead = null;
    await action('refresh').click();
    while (!releaseRead) await new Promise(resolve => setTimeout(resolve, 10));
    assert.match(await visibleOrigin('after'), /保存時のアプリ/);
    assert.doesNotMatch(await visibleOrigin('before'), /現在の運用アプリ/, '再取得中に前の取得情報を現在の情報として表示しない');
    assert.equal(await origin('before').locator('time[datetime="' + previousCapturedAt + '"]').count(), 0);
    await page.evaluate(() => { visible = false; lens.markStale(); });
    productionRevision = '3'; releaseRead(); await ready();
    assert.equal(await pane().locator('[data-cl-category]').count(), 0);
    assert.doesNotMatch(await visibleOrigin('before'), /現在の運用アプリ/);
    assert.equal(await origin('before').locator('time[datetime="' + previousCapturedAt + '"]').count(), 0);
    await page.evaluate(() => { visible = true; return lens.onVisible(); }); await ready();
    assert.match(await visibleOrigin('before'), /現在の運用アプリ/);
    await pane().locator('.ktcl-provenance > summary').click();
    assert.match(await pane().locator('.ktcl-provenance').innerText(), /設定の版：左 3 ／ 右 1/);
    await pane().locator('.ktcl-provenance > summary').click();
    assert.equal(await pane().locator('.ktcl-filename').innerText(), 'old-settings.json');
    await target().selectOption('preview');
    assert.equal(await pane().locator('[data-cl-file-comparison]').count(), 0);
    assert.equal(await action('explain').isDisabled(), false);
    assert.match(await visibleOrigin('before'), /現在の運用アプリ/);
    assert.match(await visibleOrigin('after'), /現在の動作テストアプリ/);
    await target().selectOption('file');
    assert.match(await visibleOrigin('after'), /old-settings.json/, '別の比較相手を選んでも保存ファイルを保持');

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
