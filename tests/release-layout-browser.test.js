'use strict';
// The real Toolkit host is a column flexbox. These fixtures reproduce its dimensions
// and full-screen CSS zoom; all network traffic and all AI/kintone calls remain local.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { loadToolkit } = require('./helpers/load-toolkit.js');
const { devBaseLoaderOf } = require('./helpers/dev-base-fake.js');
const { makeKintoneMock } = require('./helpers/kintone-preview-mock.js');
const F = require('./helpers/release-workspace-fixture.js');
const root = path.resolve(__dirname, '..');
const cases = [
  { name: 'full', viewport: { width: 1536, height: 790 }, full: true, zoom: 1, split: true },
  { name: 'full-110', viewport: { width: 1536, height: 790 }, full: true, zoom: 1.1, split: true },
  { name: 'panel', viewport: { width: 1440, height: 900 }, full: false, zoom: 1, split: false },
  { name: 'narrow-110', viewport: { width: 390, height: 844 }, full: true, zoom: 1.1, split: false },
  { name: 'short-390-130', viewport: { width: 390, height: 600 }, full: true, zoom: 1.3, split: false, realShell: true },
  { name: 'short-320-130', viewport: { width: 320, height: 568 }, full: true, zoom: 1.3, split: false, realShell: true },
];
function html({ full, zoom, realShell }) {
  if (realShell) return '<!doctype html><html lang="ja"><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%}</style><body></body></html>';
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><title>Toolkit 幅の回帰確認</title>
  <style>
    html,body{margin:0;width:100%;height:100%;overflow:hidden}
    body{font:12px/1.5 "Times New Roman",serif;background:#e8edf2;color:#202020}
    button,textarea,select{font:11px "Times New Roman",serif}
    #kt-toolkit{position:fixed;right:16px;top:30px;width:900px;height:760px;max-height:calc(100vh - 60px);display:flex;flex-direction:column;background:#fff;border:1px solid #aab4c0;font:12px/1.5 ui-sans-serif,system-ui}
    #kt-toolkit.is-full{inset:0;width:auto;height:auto;max-height:none;border:0}
    #kt-toolkit .bar{display:flex;align-items:center;padding:10px 12px;border-bottom:1px solid #d5dde6;flex:none}
    #kt-toolkit .body{padding:12px;flex:1 1 0%;min-height:0;overflow:auto}
    #kt-toolkit.is-full>.bar,#kt-toolkit.is-full>.body{zoom:${zoom}}
    #kt-toolkit .body>.kt-fill-view{height:100%;min-height:0}
    #kt-toolkit .kt-flex-column{display:flex;flex-direction:column;min-width:0;min-height:0}
  </style><body><section id="kt-toolkit" class="${full ? 'is-full' : ''}"><header class="bar">開発支援</header><div class="body"><div id="view-ai" class="kt-fill-view"><div id="kt-ai-host" class="kt-flex-column" style="height:100%;min-height:0"></div></div></div></section></body></html>`;
}
function bundle() {
  const sourcePath = process.env.KT_LAYOUT_TOOLKIT_SOURCE || path.join(root, 'kintoneAppToolkit.user.js');
  const source = fs.readFileSync(sourcePath, 'utf8').replace('waitReady().then(() => startToolkit());', '');
  const end = source.lastIndexOf('})();');
  return source.slice(0, end) + '\nglobalThis.LayoutTest={mountReleaseWorkspace,mountRoot,KTAiClient};\n' + source.slice(end);
}
function data() {
  return { appId: '310', appName: '案件管理', fields: {
    memo: { type: 'MULTI_LINE_TEXT', code: 'memo', label: '備考', required: false },
    ステータス: { type: 'STATUS', code: 'ステータス', label: 'ステータス', enabled: true },
  }, layout: [], views: { views: {}, revision: '1' }, status: { enable: true, states: {
    作成中: { name: '作成中', index: '0', assignee: { type: 'ONE', entities: [] } },
    承認待ち: { name: '承認待ち', index: '1', assignee: { type: 'ONE', entities: [] } },
    承認済み: { name: '承認済み', index: '2', assignee: { type: 'ONE', entities: [] } },
  }, actions: [] }, customize: { scope: 'ALL', desktop: { js: [], css: [] }, mobile: { js: [], css: [] } } };
}
async function measure(page) {
  return page.evaluate(() => {
    const box = selector => {
      const el = document.querySelector(selector), r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height, clientWidth: el.clientWidth, scrollWidth: el.scrollWidth };
    };
    return { host: box('#kt-ai-host'), workspace: box('.ktr-workspace'), conversation: box('.ktr-conversation'), log: box('.ktr-chat-log'), composer: box('.ktr-composer'), current: box('.ktr-current'), input: box('#kt-release-input'),
      documentWidth: document.documentElement.scrollWidth, viewport: innerWidth };
  });
}
async function checkLayout(page, split, label) {
  const m = await measure(page);
  assert.ok(m.workspace.width >= m.host.width - 20, `${label}: workspace must use the flex host width: ${JSON.stringify(m)}`);
  assert.ok(m.workspace.width <= m.host.width + 1, `${label}: workspace exceeds host`);
  assert.ok(m.workspace.height >= m.host.height - 2, `${label}: workspace must cover the available height`);
  assert.ok(m.documentWidth <= m.viewport + 1, `${label}: document overflows horizontally`);
  assert.ok(m.host.scrollWidth <= m.host.clientWidth + 1, `${label}: host overflows horizontally`);
  if (split) {
    assert.ok(m.current.x >= m.conversation.right + 5, `${label}: current work stays to the right of the conversation: ${JSON.stringify(m)}`);
    assert.ok(Math.abs(m.current.y - m.conversation.y) < 4, `${label}: both fixed panels start together`);
    assert.ok(m.conversation.width > 300 && m.current.width > 300, `${label}: both panels remain readable`);
    assert.ok(m.log.height >= m.conversation.height * .6, `${label}: conversation keeps at least 60% for messages: ${JSON.stringify(m)}`);
    assert.ok(m.input.bottom <= m.conversation.bottom && m.composer.bottom <= m.workspace.bottom, `${label}: composer stays visible`);
    const outer = await page.locator('.ktr-conversation').evaluate(el => ({ client: el.clientHeight, scroll: el.scrollHeight }));
    assert.ok(outer.scroll <= outer.client + 1, `${label}: no nested outer conversation scroll`);
  } else {
    assert.ok(m.current.y >= m.conversation.bottom - 2, `${label}: both panels remain stacked: ${JSON.stringify(m)}`);
  }
  assert.equal(await page.locator('#kt-release-input').count(), 1, `${label}: one persistent input`);
  assert.ok(m.input.x >= m.conversation.x && m.input.right <= m.conversation.right + 1, `${label}: input stays in the conversation`);
}
async function fullyVisible(page, target, label) {
  await target.scrollIntoViewIfNeeded();
  const visible = await target.evaluate(el => {
    const r = el.getBoundingClientRect(), clips = []; let parent = el.parentElement;
    while (parent) { if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowY)) clips.push(parent.getBoundingClientRect()); parent = parent.parentElement; }
    return r.width > 0 && r.height > 0 && r.x >= -1 && r.right <= innerWidth + 1 && r.y >= -1 && r.bottom <= innerHeight + 1 && clips.every(c => r.top >= c.top - 1 && r.bottom <= c.bottom + 1);
  });
  assert.equal(visible, true, label);
}

async function checkShortSurface(page, label) {
  const scroll = await page.locator('.ktr-content').evaluate(el => ({ client: el.clientHeight, scroll: el.scrollHeight }));
  assert.ok(scroll.client > 200 && scroll.scroll > scroll.client, label + ': 相談と案を数行の窓へ圧縮しない');
  const candidates = ['#kt-release-input', '[data-release-action="send"]', '[data-release-action="adopt"]', '[data-release-action="apply"]'];
  for (const selector of candidates) {
    const target = page.locator(selector); if (!await target.count()) continue;
    await fullyVisible(page, target, label + ': 操作全体が見える ' + selector);
  }
  await page.locator('.ktr-header strong').scrollIntoViewIfNeeded();
}

function sameInputPosition(before, after, label) {
  for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(before[key] - after[key]) < 3, `${label}: input ${key} moved (${before[key]} -> ${after[key]})`);
}
async function checkDialog(page, { wide = false, label = '' } = {}) {
  const m = await page.locator('dialog[open]').evaluate(el => {
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    const controls = [...el.querySelectorAll('button,select,textarea')].filter(n => n.getClientRects().length).map(n => {
      const b = n.getBoundingClientRect(), c = getComputedStyle(n);
      return { tag: n.tagName, left: b.left, right: b.right, font: c.fontFamily, fontSize: parseFloat(c.fontSize), width: b.width };
    });
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, clientWidth: el.clientWidth, scrollWidth: el.scrollWidth,
      viewportWidth: innerWidth, viewportHeight: innerHeight, font: s.fontFamily, fontSize: parseFloat(s.fontSize),
      workspaceFont: getComputedStyle(document.querySelector('.ktr-workspace')).fontFamily, controls };
  });
  assert.ok(m.left >= 14 && m.right <= m.viewportWidth - 14, `${label}: dialog fits viewport width: ${JSON.stringify(m)}`);
  assert.ok(m.top >= 14 && m.bottom <= m.viewportHeight - 14, `${label}: dialog fits viewport height`);
  assert.ok(m.scrollWidth <= m.clientWidth + 1, `${label}: dialog has no horizontal overflow`);
  assert.equal(m.font, m.workspaceFont, `${label}: dialog uses the workspace font, not the page serif font`);
  assert.ok(m.fontSize >= 13, `${label}: dialog text is readable`);
  if (m.viewportWidth > 1000) assert.ok(wide ? m.width >= 850 : m.width >= 590 && m.width <= 720, `${label}: width suits dialog purpose (${m.width})`);
  for (const c of m.controls) {
    assert.ok(c.left >= m.left - 1 && c.right <= m.right + 1 && c.width > 0, `${label}: ${c.tag} fits dialog`);
    if (c.tag === 'BUTTON' || c.tag === 'SELECT') {
      assert.equal(c.font, m.font, `${label}: ${c.tag} inherits dialog font`);
      assert.ok(c.fontSize >= 13, `${label}: ${c.tag} has readable text`);
    }
  }
}

test('実ホストの幅・高さ・文字拡大とダイアログを固定応答で確認する', { timeout: 120000 }, async t => {
  let pw;
  try { pw = require(process.env.PLAYWRIGHT_MODULE || 'playwright'); }
  catch (_) { pw = require(path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
  const { describeRegistry } = await import(pathToFileURL(path.join(process.env.KT_AI_REPO || path.resolve(root, '../AI'), 'worker/src/v2/prompt-registry.mjs')).href);
  const health = { ok: true, supportedContractVersions: ['2.1'], registry: describeRegistry(), entitlements: [{ product: 'toolkit', features: ['assistant-qa', 'change-planner', 'customization-generator'] }] };
  const browser = await pw.chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
  try {
    for (const scene of cases) await t.test(scene.name, async () => {
      const context = await browser.newContext({ viewport: scene.viewport, serviceWorkers: 'block' });
      const unexpected = [], errors = [], calls = [], T = loadToolkit(), prod = data(), mock = makeKintoneMock(prod);
      const loadBase = devBaseLoaderOf({ KTDevBase: { load: T.KTDevBase.loadForRelease } }, { appId: '310', production: prod, mockRef: () => mock });
      const out = path.join(root, 'tests/.build/release-layout'); fs.mkdirSync(out, { recursive: true });
      try {
        await context.route('**/*', route => {
          if (route.request().url() === 'https://layout.test.invalid/') return route.fulfill({ contentType: 'text/html', body: html(scene) });
          if (route.request().url().startsWith('https://www.google.com/s2/favicons?')) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg"/>' });
          unexpected.push(route.request().url()); return route.abort();
        });
        const page = await context.newPage();
        page.on('pageerror', e => errors.push(e.message));
        await page.exposeFunction('testBase', loadBase);
        await page.exposeFunction('testApi', async (name, args) => mock.api[name](...args));
        await page.exposeFunction('testService', async (name, ctx) => {
          calls.push(name);
          if (name === 'getHealth') return health;
          if (name === 'propose') return F.proposal();
          if (name === 'plan') return F.plan();
          return F.generated(ctx.customization);
        });
        await page.goto('https://layout.test.invalid/');
        await page.evaluate(scene => { localStorage.setItem('ktToolkitFull.v1', scene.full ? '1' : '0'); localStorage.setItem('ktToolkitFullZoom.v1', String(scene.zoom)); }, scene);
        await page.addScriptTag({ content: bundle() });
        await page.evaluate(({ prod, names, scene }) => {
          if (scene.realShell) {
            const shell = LayoutTest.mountRoot(); shell.ktTabs.switchTab('ai');
            const host = document.createElement('div'); host.id = 'kt-ai-host'; host.className = 'kt-flex-column'; host.style.height = '100%';
            shell.querySelector('#view-ai').appendChild(host);
          }
          const client = Object.fromEntries(['getHealth', 'propose', 'plan', 'generate'].map(name => [name, input => window.testService(name, input?.ctx)]));
          window.work = LayoutTest.mountReleaseWorkspace(document.querySelector('#kt-ai-host'), {
            appId: '310', settings: LayoutTest.KTAiClient.createSettingsStore(),
            session: { client, status: () => ({ connected: true, apiBase: 'https://gateway.test.invalid' }) },
            loadDevBase: window.testBase, executor: { api: Object.fromEntries(names.map(name => [name, (...args) => window.testApi(name, args)])) },
            getInputs: () => ({ data: prod, deps: {}, scan: { files: [] } }), copyText: async () => {}, downloadText: () => {},
          });
          window.work.onVisible();
        }, { prod, names: Object.keys(mock.api), scene });
        const action = name => page.locator('[data-release-action="' + name + '"]').first();
        const phase = value => page.waitForFunction(v => window.work.controller.getState().phase === v, value);
        await page.waitForFunction(() => window.work.capability().available);
        await checkLayout(page, scene.split, scene.name + '/idle');
        if (scene.realShell) await checkShortSurface(page, scene.name + '/idle');
        const initialInput = (await measure(page)).input;
        assert.equal(await page.locator('#kt-release-input').count(), 1);
        assert.equal(await page.locator('[data-release-action="send"]').count(), 1);
        await action('connect').click(); await checkDialog(page, { label: scene.name + '/connection' });
        if (scene.zoom === 1.1) await page.screenshot({ path: path.join(out, scene.name + '-connection.png') });
        await page.locator('dialog [data-close]').click();
        const more = page.locator('.ktr-more>summary');
        await more.focus(); await more.press('Enter');
        await fullyVisible(page, action('details'), scene.name + '/その他のアプリ情報');
        await page.evaluate(() => work.view.render());
        assert.equal(await page.locator('.ktr-more').getAttribute('open'), '', '再描画でその他を閉じない');
        assert.equal(await more.evaluate(el => el === document.activeElement), true, 'その他のキーボード操作位置を保つ');
        await action('details').click(); await checkDialog(page, { wide: true, label: scene.name + '/details' });
        await page.locator('dialog [data-close]').click();
        await action('documents').click();
        await page.locator('dialog details[data-offline-materials] > summary').click();
        await page.locator('dialog button[data-offline-export]').click();
        await page.locator('dialog [data-make]').click();
        await checkDialog(page, { wide: true, label: scene.name + '/materials' });
        if (scene.zoom === 1.1) await page.screenshot({ path: path.join(out, scene.name + '-materials.png') });
        assert.ok((await page.locator('dialog [data-output]').inputValue()).length > 50);
        await page.locator('dialog [data-close]').click();
        assert.equal(calls.filter(n => n !== 'getHealth').length, 0);
        await page.locator('#kt-release-input').fill(F.REQUEST); await action('send').click();
        await page.locator('dialog [data-consent]').waitFor(); await checkDialog(page, { label: scene.name + '/consent' });
        await page.locator('dialog [data-consent]').click(); await phase('proposal');
        await checkLayout(page, scene.split, scene.name + '/proposal');
        if (scene.realShell) await checkShortSurface(page, scene.name + '/proposal');
        if (scene.split) sameInputPosition(initialInput, (await measure(page)).input, scene.name + '/proposal');
        assert.match(await page.locator('.ktr-chat-log').innerText(), /承認待ちの一覧を追加します/);
        assert.equal(await page.locator('[data-release-action="adopt"]').count(), 1);
        await action('adopt').click(); await phase('review');
        await checkLayout(page, scene.split, scene.name + '/review');
        if (scene.realShell) await checkShortSurface(page, scene.name + '/review');
        if (scene.split) sameInputPosition(initialInput, (await measure(page)).input, scene.name + '/review');
        assert.equal(await page.locator('[data-release-action="apply"]').count(), 1);
        assert.equal(await page.locator('.ktr-workspace main .ktr-primary').count(), 1);
        assert.equal(await page.locator('[data-release-action="consult"]').count(), 0);
        assert.equal(await page.locator('[data-release-action="current"]').count(), 0);
        const prepared = await page.evaluate(() => window.work.controller.getState().prepared.signature);
        await page.locator('#kt-release-input').fill('入力途中の文は残してください。');
        await page.locator('#kt-release-input').evaluate(el => el.setSelectionRange(2, 7));
        await page.evaluate(() => window.work.view.render());
        assert.equal(await page.locator('#kt-release-input').inputValue(), '入力途中の文は残してください。');
        assert.deepEqual(await page.locator('#kt-release-input').evaluate(el => [el.selectionStart, el.selectionEnd]), [2, 7]);
        assert.equal(await page.evaluate(() => window.work.controller.getState().prepared.signature), prepared);
        await checkLayout(page, scene.split, scene.name + '/review-editing');
        if (scene.name === 'full-110') {
          const count = calls.length;
          await page.setViewportSize({ width: 390, height: 844 });
          await checkLayout(page, false, scene.name + '/live-resize-narrow');
          await page.setViewportSize(scene.viewport);
          await checkLayout(page, true, scene.name + '/live-resize-wide');
          assert.equal(await page.evaluate(() => window.work.controller.getState().phase), 'review');
          assert.equal(calls.length, count, 'resizing must not make requests');
          assert.equal(await page.locator('[data-release-action="apply"]').count(), 1);
        }
        if (scene.realShell) {
          const requestCount = calls.length;
          for (const button of await page.locator('#kt-toolkit > .bar button').all()) {
            await fullyVisible(page, button, scene.name + ': 上部のタブと操作ボタンを切らない');
            await button.click({ trial: true });
          }
          await page.evaluate(() => { window.noticeState = { ...work.controller.getState(), error: { code: 'NETWORK_ERROR', message: '通信を確認できませんでした。' + '通知を最後まで読めることを確認します。'.repeat(50) } }; work.view.render(noticeState); });
          const notification = page.locator('[data-release-panel="header-notice"]');
          await fullyVisible(page, notification.locator('summary'), scene.name + ': 通知の見出しへ戻れる');
          await notification.locator('summary').click();
          const body = notification.locator('.ktr-header-notice-body');
          assert.ok(await body.evaluate(el => el.scrollHeight > el.clientHeight), '長文通知をスクロールできる');
          await fullyVisible(page, notification.locator('[data-release-action="close-notice"]'), scene.name + ': 通知の末尾と閉じる操作へ到達できる');
          await notification.locator('[data-release-action="close-notice"]').focus();
          const positions = await page.evaluate(() => [document.querySelector('.ktr-content').scrollTop, document.querySelector('.ktr-header-notice-body').scrollTop]);
          assert.ok(positions.every(value => value > 0), '外側と通知の本文を両方スクロールした状態を確かめる');
          await page.evaluate(() => work.view.render(noticeState));
          assert.equal(await notification.evaluate(el => el.open), true);
          assert.deepEqual(await page.evaluate(() => [document.querySelector('.ktr-content').scrollTop, document.querySelector('.ktr-header-notice-body').scrollTop]), positions, '通知を読んでいる間の再描画で二つのスクロール位置を保つ');
          assert.equal(await notification.locator('[data-release-action="close-notice"]').evaluate(el => el === document.activeElement), true);
          await page.screenshot({ path: path.join(out, scene.name + '-notice.png') });
          await notification.locator('[data-release-action="close-notice"]').click();
          await page.evaluate(() => work.view.render());
          assert.equal(await page.locator('#kt-release-input').inputValue(), '入力途中の文は残してください。');
          assert.equal(await page.evaluate(() => work.controller.getState().prepared.signature), prepared);
          assert.equal(calls.length, requestCount, '画面操作だけではAIを呼ばない');
        }
        fs.writeFileSync(path.join(out, scene.name + '-measurements.json'), JSON.stringify(await measure(page), null, 2));
        await page.screenshot({ path: path.join(out, scene.name + '.png'), fullPage: true });
        assert.equal(mock.calls.filter(c => !c.startsWith('GET')).length, 0);
        assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
        await page.evaluate(() => window.work.dispose());
      } finally { await context.close(); }
    });
  } finally { await browser.close(); }
});
