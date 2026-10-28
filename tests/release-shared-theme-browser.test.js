'use strict';
// Real mountRoot + Fields + Plugins + release workspace. Every request is served locally or aborted.
// KT_SRC and KT_RELEASE_VIEW_SRC allow the same assertions against a previous build.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { loadToolkit } = require('./helpers/load-toolkit.js');
const { makeEnvGetter } = require('./helpers/dev-base-fake.js');
const root = path.resolve(__dirname, '..');
const output = path.resolve(process.env.KT_THEME_OUTPUT || path.join(root, 'tests/.build/release-shared-theme'));
const scenes = [
  { name: 'full-1440', width: 1440, height: 900, full: true, zoom: 1, split: true },
  { name: 'full-110', width: 1440, height: 900, full: true, zoom: 1.1, split: true },
  { name: 'panel-1280', width: 1440, height: 900, full: false, zoom: 1.1, split: true },
  { name: 'narrow-390', width: 390, height: 844, full: true, zoom: 1.1, split: false },
];
const fixture = {
  phase: 'idle', taskId: 1, version: 0, runs: [], answers: [], artifacts: [],
  messages: [
    { id: 1, role: 'user', text: '備考の入力方法と、担当者への引き継ぎ手順を説明してください。' },
    { id: 2, role: 'assistant', text: 'アプリの説明を作りました。内容を確認してから資料として保存できます。' },
  ],
  explanationId: 'theme-explanation',
  explanations: [{ id: 'theme-explanation', title: '案件管理の使い方', sections: [{
    heading: '入力と引き継ぎ', paragraphs: ['備考には対応内容を入力します。次の担当者が確認できるように記録してください。'], items: [],
    table: { columns: ['項目', '説明'], rows: [['備考', '対応内容と引き継ぐ情報を入力します。']] }, evidenceIds: [],
  }], unknowns: [], facts: [] }],
};
function playwright() {
  try { return require(process.env.PLAYWRIGHT_MODULE || 'playwright'); }
  catch { return require(path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
}
function bundle() {
  let source = fs.readFileSync(process.env.KT_SRC || path.join(root, 'kintoneAppToolkit.user.js'), 'utf8')
    .replace('waitReady().then(() => startToolkit());', '');
  if (process.env.KT_RELEASE_VIEW_SRC) {
    const start = source.indexOf('const KTReleaseView ='), end = source.indexOf('/* Browser composition.', start);
    assert.ok(start >= 0 && end > start, 'release view replacement boundaries');
    source = source.slice(0, start) + fs.readFileSync(process.env.KT_RELEASE_VIEW_SRC, 'utf8') + '\n' + source.slice(end);
  }
  const end = source.lastIndexOf('})();'); assert.ok(end >= 0);
  return source.slice(0, end) + '\nglobalThis.ThemeTest={mountRoot,renderFields,renderPlugins,renderCustomize,mountReleaseWorkspace,mountReleaseConfigLens,KTAiClient};\n' + source.slice(end);
}
async function inspect(page, selectors) {
  return page.evaluate(selectors => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const rgba = value => { context.clearRect(0, 0, 1, 1); context.fillStyle = value; context.fillRect(0, 0, 1, 1); const n = context.getImageData(0, 0, 1, 1).data; return [n[0], n[1], n[2], n[3] / 255]; };
    const over = (fg, bg) => { const a = fg[3]; return [0, 1, 2].map(i => fg[i] * a + bg[i] * (1 - a)).concat(1); };
    const background = el => {
      if (!el) return [255, 255, 255, 1];
      const c = rgba(getComputedStyle(el).backgroundColor);
      return c[3] >= 1 ? c : over(c, background(el.parentElement));
    };
    const luminance = rgb => rgb.slice(0, 3).map(n => { n /= 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4; }).reduce((n, v, i) => n + v * [.2126, .7152, .0722][i], 0);
    const box = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height, clientWidth: el.clientWidth, scrollWidth: el.scrollWidth }; };
    const samples = selectors.flatMap(selector => [...document.querySelectorAll(selector)].filter(el => el.getClientRects().length).map(el => {
      const s = getComputedStyle(el), bg = background(el), fg = over(rgba(s.color), bg), a = luminance(fg), b = luminance(bg);
      return { selector, disabled: !!el.disabled, text: (el.textContent || el.value || '').trim().slice(0, 50), color: s.color, background: s.backgroundColor, effectiveBackground: bg.slice(0, 3), font: s.fontFamily, fontSize: parseFloat(s.fontSize), contrast: (Math.max(a, b) + .05) / (Math.min(a, b) + .05), ...box(el) };
    }));
    const bounds = Object.fromEntries(['#kt-toolkit', '#kt-toolkit > .bar', '#kt-toolkit > .body', '.ktr-workspace', '.ktr-layout', '.ktr-conversation', '.ktr-current', '#kt-release-input', 'dialog[open]'].map(selector => [selector, document.querySelector(selector)]).filter(([, el]) => el?.getClientRects().length).map(([selector, el]) => [selector, box(el)]));
    return { samples, bounds, width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth, bodyDirectDialog: document.querySelector('dialog[open]')?.parentElement === document.body };
  }, selectors);
}
async function actionAppearance(page, selector) {
  return page.locator(selector).evaluate(el => {
    const style=getComputedStyle(el), keys=['fontFamily','fontSize','fontWeight','lineHeight','padding','borderRadius','borderColor','borderWidth','color','backgroundColor','height','minHeight','opacity','cursor','filter','outlineStyle','outlineWidth','outlineColor','outlineOffset'];
    return { disabled:el.disabled, ...Object.fromEntries(keys.map(key=>[key,style[key]])) };
  });
}
async function compareActionState(page, kind, pluginSelector, customizeSelector) {
  const samples=[];
  for(const [tab,selector] of [['plugins',pluginSelector],['customize',customizeSelector]]) {
    await page.locator('#tab-'+tab).click();
    await page.mouse.move(0,0);
    const button=page.locator(selector);
    if(kind==='hover') await button.hover();
    if(kind==='focus') { await button.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab'); assert.equal(await button.evaluate(el=>el.matches(':focus-visible')),true); }
    samples.push(await actionAppearance(page,selector));
  }
  assert.deepEqual(samples[0],samples[1],'PluginsとCustomizeの'+kind+'の操作ボタンを揃える');
  return samples[0];
}
const normalSelectors = ['#kt-toolkit', '#tab-fields', '#tab-ai', '#fi-copy', '#fi-search', '#fi-type', '#view-fields th', '#view-fields td'];
const aiSelectors = ['#kt-toolkit', '#tab-ai', '.ktr-workspace', '.ktr-environment', '.ktr-speaker', '.ktr-message p', '.ktr-stage-header', '.ktr-explanation th', '.ktr-explanation td', '.ktr-document-tabs button[aria-pressed="true"]', '.ktr-workspace button:not(:disabled)', '#kt-release-input'];
const dialogSelectors = ['dialog[open]', 'dialog[open] h2', 'dialog[open] p', 'dialog[open] small', 'dialog[open] summary', 'dialog[open] button:not(:disabled)', 'dialog[open] [data-document-create]', 'dialog[open] textarea'];
function audit(normal, ai, dialog, scene) {
  const failures = [], check = (condition, message) => { if (!condition) failures.push(message); };
  const sample = (set, selector, predicate = () => true) => set.samples.find(s => s.selector === selector && predicate(s));
  const shell = sample(normal, '#kt-toolkit'), workspace = sample(ai, '.ktr-workspace'), modal = sample(dialog, 'dialog[open]');
  for (const key of ['color', 'background', 'font']) {
    check(shell[key] === workspace[key], `通常タブとAI画面の${key}が揃う: ${shell[key]} / ${workspace[key]}`);
    check(workspace[key] === modal[key], `AI画面とbody直下dialogの${key}が揃う: ${workspace[key]} / ${modal[key]}`);
  }
  const normalButton = sample(normal, '#fi-copy'), aiButton = sample(ai, '.ktr-workspace button:not(:disabled)', s => s.text === '資料を作る');
  const dialogButton = sample(dialog, 'dialog[open] button:not(:disabled)', s => s.text === '閉じる');
  for (const key of ['color', 'background', 'font']) {
    check(normalButton[key] === aiButton[key], `通常ボタンとAIボタンの${key}が揃う`);
    check(aiButton[key] === dialogButton[key], `AIボタンとdialogボタンの${key}が揃う`);
  }
  const selected = sample(ai, '#tab-ai'), primary = sample(ai, '.ktr-workspace button:not(:disabled)', s => s.text === '送信');
  check(!!primary, '送信ボタンが有効');
  const otherSelected = sample(normal, '#tab-fields'), documentSelected = sample(ai, '.ktr-document-tabs button[aria-pressed="true"]'), dialogPrimary = sample(dialog, 'dialog[open] [data-document-create]');
  for (const key of ['color', 'background']) {
    check(selected[key] === otherSelected[key], `通常タブとAI選択タブの${key}が揃う`);
    if (primary) check(primary[key] === dialogPrimary[key], `AI画面とdialogの主ボタンの${key}が揃う`);
  }
  check(selected.color === documentSelected.color, '選択タブと選択資料のアクセント色が揃う');
  for (const [name, set] of [['Fields', normal], ['AI', ai], ['dialog', dialog]]) {
    for (const s of set.samples) {
      check(s.disabled || s.contrast >= 4.5, `${name} ${s.selector}「${s.text}」の文字コントラスト ${s.contrast.toFixed(2)} < 4.5`);
      check(s.width > 0 && s.height > 0, `${name} ${s.selector}の文字領域が潰れない`);
    }
    check(set.documentWidth <= set.width + 1, `${name}: ページに横はみ出しがない`);
  }
  for (const selector of ['#kt-toolkit', '#kt-toolkit > .bar', '.ktr-workspace', '.ktr-layout', '.ktr-conversation', '.ktr-current']) {
    const b = ai.bounds[selector];
    check(b.x >= -1 && b.right <= ai.width + 1, `${selector}: 画面幅に収まる`);
    check(b.scrollWidth <= b.clientWidth + 1, `${selector}: 横はみ出しがない (${b.scrollWidth}/${b.clientWidth})`);
  }
  const left = ai.bounds['.ktr-conversation'], right = ai.bounds['.ktr-current'], input = ai.bounds['#kt-release-input'];
  check(scene.split ? right.x >= left.right && Math.abs(right.y - left.y) < 3 : right.y >= left.bottom - 2, '相談と結果の左右pane／縦積みを維持する');
  check(input.x >= left.x - 1 && input.right <= left.right + 1, '入力欄が相談pane内に収まる');
  const d = dialog.bounds['dialog[open]'];
  check(dialog.bodyDirectDialog, '本物のdialogがbody直下に開く');
  check(d.x >= 14 && d.right <= dialog.width - 14 && d.y >= 14 && d.bottom <= dialog.height - 14, 'dialogが画面内に収まる');
  check(d.scrollWidth <= d.clientWidth + 1, 'dialogに横はみ出しがない');
  for (const s of dialog.samples.filter(s => /button|textarea/.test(s.selector))) check(s.x >= d.x && s.right <= d.right + 1, 'dialog内の操作部品が収まる');
  return failures;
}

test('本物のToolkit shell・AI Assistant・body直下dialogの共通テーマと画面幅', { timeout: 120000 }, async t => {
  fs.mkdirSync(output, { recursive: true });
  const production = { appId: '310', fields: { memo: { code: 'memo', label: '備考', type: 'MULTI_LINE_TEXT', required: false } }, layout: [], views: { views: {} }, customize: { scope: 'ALL', desktop: { js: [], css: [] }, mobile: { js: [], css: [] } } };
  const preview = structuredClone(production); preview.fields.memo.required = true;
  const settingsFixture = await loadToolkit().KTDevBase.loadForRelease({
    appId: '310', now: () => Date.parse('2026-10-28T01:00:00Z'),
    ...makeEnvGetter({ production, preview, revisions: { production: '1', preview: '2' }, fail: { 'production:field/acl': new Error('固定の権限不足') } })
  });
  const browser = await playwright().chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
  try {
    for (const scene of scenes) for (const colorScheme of ['light', 'dark']) await t.test(`${scene.name}-${colorScheme}`, async () => {
      const label = `${scene.name}-${colorScheme}`, unexpected = [], errors = [];
      const context = await browser.newContext({ viewport: { width: scene.width, height: scene.height }, colorScheme, serviceWorkers: 'block' });
      try {
        await context.route('**/*', route => {
          const url = route.request().url();
          if (url === 'https://shared-theme.test.invalid/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="ja"><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%}body{font:12px "Times New Roman",serif;background:#e8edf2;color:#202020}button,input,textarea,select{font:11px "Times New Roman",serif}</style><body></body></html>' });
          if (url.startsWith('https://www.google.com/s2/favicons?')) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' });
          unexpected.push(url); return route.abort();
        });
        const page = await context.newPage(); page.setDefaultTimeout(5000); page.on('pageerror', error => errors.push(error.message));
        await page.goto('https://shared-theme.test.invalid/');
        await page.evaluate(scene => { localStorage.setItem('ktTemplatesMovedNotice.v1', '1'); localStorage.setItem('ktToolkitFull.v1', scene.full ? '1' : '0'); localStorage.setItem('ktToolkitFullZoom.v1', String(scene.zoom)); }, scene);
        await page.addScriptTag({ content: bundle() });
        await page.evaluate(async ({ fixture, settingsFixture }) => {
          const T = ThemeTest, C = T.KTAiClient;
          const shell = window.shell = T.mountRoot();
          await T.renderFields(shell, { appId: '310', fields: { memo: { type: 'MULTI_LINE_TEXT', code: 'memo', label: '備考', required: false } }, layout: [] });
          const host = document.createElement('div'); host.id = 'kt-ai-host'; host.className = 'kt-flex-column'; host.style.height = '100%'; shell.querySelector('#view-ai').appendChild(host);
          window.serviceCalls = [];
          const denied = name => () => { serviceCalls.push(name); throw Error('UI試験では呼び出し禁止: ' + name); };
          const health = { ok: true, supportedContractVersions: [C.CONTRACT_VERSION], entitlements: [{ product: C.PRODUCT, features: [C.FEATURE, C.FEATURE_PLANNER] }], registry: { [C.PRODUCT]: {
            [C.FEATURE]: { implemented: true, promptVersions: [C.PROMPT_VERSION], conversation: [...C.CONVERSATION_MARKS, 'releaseWorkspace', 'appExplanation', 'discussionMetadata'] },
            [C.FEATURE_PLANNER]: { implemented: true, promptVersions: [C.PLANNER_PROMPT_VERSION], ...C.PLANNER_MARKS, requirementOps: [...C.PLANNER_MARKS.requirementOps, 'releaseWorkspace', 'formLayoutPlacement', 'fieldMaintenance'] },
          } } };
          const client = { getHealth: async () => health, propose: denied('AI.propose'), plan: denied('AI.plan'), generate: denied('AI.generate') };
          window.work = T.mountReleaseWorkspace(host, { appId: '310', settings: C.createSettingsStore(), session: { client, status: () => ({ connected: true, apiBase: 'https://gateway.test.invalid' }) },
            loadDevBase: denied('kintone.loadBase'), executor: { api: new Proxy({}, { get: (_, name) => denied('kintone.' + String(name)) }) },
            getInputs: () => ({ data: { appId: '310', appName: '案件管理', fields: {} }, deps: {}, scan: { files: [] } }), copyText: denied('clipboard'), downloadText: denied('download'),
            openConfigLens: () => shell.ktTabs.switchTab('config-lens') });
          window.lensReads = 0;
          window.configLens = T.mountReleaseConfigLens(shell.querySelector('#view-config-lens'), {
            loadBase: async () => { lensReads++; return structuredClone(settingsFixture); },
            domain: 'fixture.cybozu.com', localEdits: () => [], downloadText: denied('download'),
            explain: denied('AI.explain'), canRead: () => true,
            isVisible: () => shell.querySelector('#tab-config-lens').classList.contains('active') && !shell.ktPanel.isMini()
          });
          shell.ktTabs.onSwitch(id => { if (id === 'config-lens') configLens.onVisible(); });
          await work.refreshCapability();
          // Seed the rendered state only; no service or kintone operation creates this fixture.
          work.controller.getState = () => structuredClone(fixture); work.view.render();
          shell.ktTabs.onSwitch(id => { if (id === 'ai') work.onVisible(); });
          shell.ktTabs.switchTab('fields');
        }, { fixture, settingsFixture });
        const normal = await inspect(page, normalSelectors);
        await page.screenshot({ path: path.join(output, label + '-fields.png'), fullPage: true });
        await page.locator('#tab-ai').click();
        const draft = '入力途中の引き継ぎ相談を残します。';
        await page.locator('#kt-release-input').fill(draft);
        await page.locator('#tab-fields').click();
        assert.equal(await page.locator('#view-ai').isVisible(), false);
        await page.locator('#tab-ai').click();
        assert.equal(await page.locator('#kt-release-input').inputValue(), draft, 'タブ移動で入力draftを保持');
        assert.equal(await page.locator('#kt-toolkit .tabs .active').count(), 1, '選択タブは一つ');
        assert.match(await page.locator('#tab-ai').getAttribute('class'), /active/);
        const ai = await inspect(page, aiSelectors);
        await page.screenshot({ path: path.join(output, label + '-ai.png'), fullPage: true });
        await page.locator('[data-release-action="documents"]').click();
        const dialog = await inspect(page, dialogSelectors);
        await page.screenshot({ path: path.join(output, label + '-dialog.png'), fullPage: true });
        await page.locator('dialog[open] [data-close]').click();
        assert.equal(await page.locator('#kt-release-input').inputValue(), draft, 'dialogを閉じても入力draftを保持');

        // Actual shell tab and the same independent Config Lens mount. These
        // reads use a fixed snapshot; opening/filtering the free tab calls no AI.
        assert.equal(await page.evaluate(() => lensReads), 0, 'Config Lens初期化だけでは設定を取得しない');
        await page.locator('[data-release-action="pending-changes"]').click();
        await page.waitForFunction(() => !document.querySelector('#view-config-lens [data-cl-action="refresh"]')?.disabled && !!document.querySelector('#view-config-lens [data-cl-category="fields"]'));
        assert.equal(await page.locator('#view-config-lens').isVisible(), true, 'AI内入口から共通shellの独立タブへ移動する');
        assert.equal(await page.locator('#view-ai').isVisible(), false);
        assert.match(await page.locator('#tab-config-lens').getAttribute('class'), /active/);
        assert.equal(await page.locator('#kt-toolkit .tabs .active').count(), 1);
        for (const action of ['refresh', 'save-production', 'save-preview', 'explain']) {
          const button = page.locator('#view-config-lens [data-cl-action="' + action + '"]');
          assert.equal(await button.count(), 1, 'Config Lensの' + action + 'を一つ残す');
          assert.equal(await button.isVisible(), true, 'Config Lensの' + action + 'を画面から操作できる');
          assert.equal(await button.isEnabled(), true, '取得後は' + action + 'を操作できる');
          assert.equal(await button.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, action + 'の文を切らず折り返す');
        }
        assert.match(await page.locator('#view-config-lens [data-cl-summary]').innerText(), /変更\s*1件/);
        assert.match((await page.locator('#view-config-lens .ktcl-source').allTextContents()).join(' '), /運用環境.*1.*動作テスト環境.*2/);
        assert.match(await page.locator('#view-config-lens [data-cl-category="aclField"]').innerText(), /未確認/);
        await page.locator('.ktcl-view').evaluate(view => { for (let node = view; node && node !== document.body; node = node.parentElement) node.scrollTop = 0; });
        const lensOverview = await page.locator('.ktcl-view').evaluate(view => {
          const top = view.getBoundingClientRect().top;
          const box = selector => {
            const rect = view.querySelector(selector)?.getBoundingClientRect();
            return rect ? { top: rect.top - top, bottom: rect.bottom - top, height: rect.height } : null;
          };
          return { viewportWidth: innerWidth, viewWidth: view.clientWidth, headerHeight: box('.ktcl-shell')?.top, header: box('.ktcl-header'), source: box('.ktcl-source'), summary: box('[data-cl-summary]') };
        });
        await page.screenshot({ path: path.join(output, label + '-config-lens-overview.png'), fullPage: true });
        await page.locator('#view-config-lens [data-cl-category="fields"]').click();
        await page.locator('#view-config-lens .ktcl-entry > summary').click();
        const lensSelectors = ['#kt-toolkit', '#tab-config-lens', '.ktcl-view', '.ktcl-header p', '.ktcl-source', '.ktcl-overview', '.ktcl-view button:not(:disabled)', '.ktcl-navigation small', '.ktcl-entry th', '.ktcl-entry td', '.ktcl-kind', '.ktcl-notes summary'];
        const lens = await inspect(page, lensSelectors), lensFailures = [];
        const shellSample = normal.samples.find(sample => sample.selector === '#kt-toolkit');
        const lensSample = lens.samples.find(sample => sample.selector === '.ktcl-view');
        for (const key of ['color', 'background', 'font']) assert.equal(lensSample[key], shellSample[key], 'Config Lensと共通shellの' + key + 'が揃う');
        for (const sample of lens.samples) {
          if (!sample.disabled && sample.contrast < 4.5) lensFailures.push(sample.selector + '「' + sample.text + '」のコントラスト ' + sample.contrast.toFixed(2));
          if (sample.width <= 0 || sample.height <= 0) lensFailures.push(sample.selector + ' の領域が潰れている');
        }
        assert.ok(lens.documentWidth <= lens.width + 1, 'Config Lensがページを横にはみ出させない');
        assert.equal(await page.locator('.ktcl-view').evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
        await page.screenshot({ path: path.join(output, label + '-config-lens.png'), fullPage: true });
        await page.locator('#tab-fields').click(); await page.locator('#tab-config-lens').click();
        assert.equal(await page.evaluate(() => lensReads), 1, 'タブへ戻るだけで保存済み比較を取り直さない');
        assert.equal(await page.locator('#view-config-lens [data-cl-category="fields"]').getAttribute('aria-pressed'), 'true');
        assert.equal(await page.locator('#view-config-lens .ktcl-entry').evaluate(el => el.open), true, '設定詳細の開閉をタブ移動で保持する');
        await page.locator('#tab-ai').click();
        assert.equal(await page.locator('#kt-release-input').inputValue(), draft, 'Config Lensへ移動してもAIの下書きを保持する');
        assert.equal(await page.locator('.ktr-message').count(), 2, '会話表示を保持する');
        fs.writeFileSync(path.join(output, label + '-config-lens-measurements.json'), JSON.stringify({ lens, lensOverview, lensFailures }, null, 2));
        assert.deepEqual(lensFailures, []);

        // Actual Customize buttons, without loading code or settings. Monaco only supplies its local editor surface.
        await page.evaluate(async()=>{
          window.loadMonaco=async()=>({_kintoneFieldsReady:true,editor:{create(host){
            const area=document.createElement('textarea'); area.style.cssText='width:100%;height:100%;box-sizing:border-box'; host.appendChild(area);
            const dispose=()=>({dispose(){}});
            return {getValue:()=>area.value,getModel:()=>null,onDidChangeModelContent:dispose,onDidChangeCursorSelection:dispose,layout(){},updateOptions(){},dispose(){area.remove();}};
          }}});
          await ThemeTest.renderCustomize(shell,{fields:{}},'310',{autoLoad:false});
        });
        // Render the actual Plugins tab with read-only responses; never register or deploy.
        const outsideBefore = await page.evaluate(() => {
          const probe = document.createElement('div'); probe.id = 'host-theme-probe'; probe.style.cssText = 'position:absolute;left:-10000px';
          probe.innerHTML = '<button class="btn">Host button</button><div class="kt-row">Host row</div><span class="kt-pill">Host tag</span><span class="kt-muted">Host note</span><span class="kt-danger">Host error</span>';
          document.body.appendChild(probe);
          window.pluginHostStyle = () => [...probe.children].map(el => { const c=getComputedStyle(el); return { color:c.color,background:c.backgroundColor,border:c.border,width:c.width,padding:c.padding,opacity:c.opacity,lineHeight:c.lineHeight }; });
          return pluginHostStyle();
        });
        await page.evaluate(async () => {
          window.pluginReads = []; window.pluginWrites = [];
          const api = async (url, method, params) => {
            if (method !== 'GET') { pluginWrites.push({url,method}); throw Error('Plugin write forbidden'); }
            pluginReads.push(url);
            if (!['/k/v1/app/plugins.json','/k/v1/preview/app/plugins.json'].includes(url)) throw Error('Unexpected plugin read '+url);
            return {plugins: (url.includes('/preview/') ? ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'] : ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']).map(id=>({id}))};
          };
          api.url = url => url;
          window.kintone = {api, app:{getId:()=>310}, system:{getPermissions:async()=>true}};
          await ThemeTest.renderPlugins(shell,{appId:'310',plugins:{plugins:[
            {id:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',name:'入力サポート',description:'入力内容を確認するプラグイン',version:'1.0'},
            {id:'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',name:'確認サポート',description:'確認する対象を案内するプラグイン',version:'2.0'},
            {id:'cccccccccccccccccccccccccccccccc',name:'一覧サポート',description:'一覧の確認を支援するプラグイン',version:'1.1'}
          ]}});
          shell.ktTabs.switchTab('plugins');
        });
        const pluginSelectors = ['#kt-toolkit','#kt-plg-reload','#kt-plg-deploy','#kt-plg-add','#kt-plg-search','#kt-plg-status','#kt-plg-log','#kt-plg-diff','#kt-plg-prod','#kt-plg-prev','#kt-plg-catalog','#kt-plugins .kt-row','#kt-plugins .kt-pill','#kt-plugins .kt-muted'];
        const plugins = await inspect(page, pluginSelectors);
        const pluginPalette = await page.evaluate(() => {
          const shellStyle=getComputedStyle(document.querySelector('#kt-toolkit'));
          const probe=document.createElement('div'); probe.style.background=shellStyle.getPropertyValue('--kt-soft'); document.body.appendChild(probe);
          const soft=getComputedStyle(probe).backgroundColor; probe.remove(); return {soft};
        });
        await page.screenshot({ path:path.join(output,label+'-plugins.png'), fullPage:true });
        const pluginFailures = [];
        for(const selector of ['#kt-plg-status','#kt-plg-log','#kt-plg-diff']) {
          assert.equal(plugins.samples.find(s=>s.selector===selector).background,pluginPalette.soft,selector+'は共通テーマの補助背景');
        }
        const fieldsButton=normal.samples.find(s=>s.selector==='#fi-copy'),pluginButton=plugins.samples.find(s=>s.selector==='#kt-plg-reload');
        for(const key of ['color','background','font']) assert.equal(pluginButton[key],fieldsButton[key],'Pluginsのボタンを通常タブと揃える: '+key);
        for(const sample of plugins.samples) {
          if(!sample.disabled && sample.contrast<4.5) pluginFailures.push(sample.selector+' '+sample.text+' のコントラスト '+sample.contrast.toFixed(2));
          if(sample.width<=0||sample.height<=0) pluginFailures.push(sample.selector+' の領域が潰れている');
        }
        assert.ok(plugins.documentWidth<=plugins.width+1,'Pluginsがページを横にはみ出させない');
        const actionStates={};
        for(const kind of ['normal','hover','focus']) actionStates[kind]=await compareActionState(page,kind,'#kt-plg-deploy','#kt-customize-deploy');
        actionStates.disabled=await compareActionState(page,'disabled','#kt-plg-add','#kt-customize-register');
        assert.equal(actionStates.normal.disabled,false);assert.equal(actionStates.disabled.disabled,true);
        assert.equal(actionStates.normal.fontSize,'12px');assert.equal(actionStates.normal.minHeight,'32px');
        assert.match(await page.locator('#kt-plg-status').innerText(),/運用環境: 1.*動作テスト環境: 2/s);
        assert.match(await page.locator('#kt-plg-diff').innerText(),/運用環境のみ: 0.*動作テスト環境のみ: 1/s);
        assert.equal(await page.locator('#kt-plg-deploy').innerText(),'運用環境へ反映');
        assert.equal(await page.locator('#kt-plg-add').innerText(),'動作テスト環境に追加');
        assert.equal(await page.locator('#kt-plg-reload').innerText(),'再取得');
        assert.match(await page.locator('#kt-plg-deploy').getAttribute('title'),/未反映の変更全体/);
        await page.locator('#tab-customize').click();
        assert.equal(await page.locator('.kt-customize-actionbar').evaluate(el=>[...el.querySelectorAll('button')].every(button=>button.getBoundingClientRect().right<=el.getBoundingClientRect().right+1&&button.scrollWidth<=button.clientWidth+1)),true,'Customizeの長い操作名を切らない');
        await page.locator('#tab-plugins').click();
        for(const selector of ['#kt-plg-reload','#kt-plg-deploy','#kt-plg-add']) assert.equal(await page.locator(selector).evaluate(el=>el.scrollWidth<=el.clientWidth+1&&el.getBoundingClientRect().right<=document.querySelector('#kt-toolkit').getBoundingClientRect().right+1),true,'Pluginsの長い操作名を切らない');
        await page.mouse.move(0,0);
        // Searching and choosing a row remain local UI actions, not registrations.
        await page.locator('#kt-plg-search').fill('一覧サポート');
        assert.equal(await page.locator('#kt-plg-catalog .kt-row').count(),1);
        await page.locator('#kt-plg-catalog .kt-row').hover();
        const hovered=await inspect(page,['#kt-plg-catalog .kt-row']);
        assert.equal(hovered.samples[0].background,pluginPalette.soft,'hoverも共通テーマの補助背景');
        assert.ok(hovered.samples[0].contrast>=4.5,'hover時も読める');
        await page.locator('#kt-plg-catalog input[type="checkbox"]').check();
        assert.equal(await page.locator('#kt-plg-add').isEnabled(),true,'選択により追加ボタンを有効にできる');
        assert.deepEqual(await page.evaluate(()=>pluginWrites),[],'選択だけでは登録・deployしない');
        assert.deepEqual(await page.evaluate(()=>pluginReads),['/k/v1/app/plugins.json','/k/v1/preview/app/plugins.json'],'検索・選択で再取得しない');
        assert.deepEqual(await page.evaluate(()=>pluginHostStyle()),outsideBefore,'PluginsのCSSをホスト側の同名classへ漏らさない');

        if(scene.name==='full-1440') {
          await page.evaluate(async()=>{kintone.system.getPermissions=async()=>false;await ThemeTest.renderPlugins(shell,{appId:'310'});});
          assert.match(await page.locator('#view-plugins').innerText(),/システム管理者/);
          assert.equal(await page.locator('#view-plugins button').count(),0,'権限なしでは登録・反映の操作を出さない');
          const deniedView=await inspect(page,['#view-plugins > div','#view-plugins > div > div']);
          assert.ok(deniedView.samples.every(s=>s.contrast>=4.5),'権限なしの説明も読める');
          assert.deepEqual(await page.evaluate(()=>pluginReads),['/k/v1/app/plugins.json','/k/v1/preview/app/plugins.json'],'権限なしでは追加取得しない');
          await page.screenshot({path:path.join(output,label+'-plugins-denied.png'),fullPage:true});
        }

        await page.locator('#tab-fields').click();
        const fieldsAfter=await inspect(page,normalSelectors);
        assert.deepEqual(fieldsAfter.samples,normal.samples,'Pluginsを開いてもFieldsの表示を変えない');
        await page.locator('#tab-ai').click();
        const aiAfter=await inspect(page,aiSelectors);
        assert.deepEqual(aiAfter.samples,ai.samples,'Pluginsを開いてもAI Assistantの表示を変えない');
        fs.writeFileSync(path.join(output,label+'-plugins-measurements.json'),JSON.stringify({plugins,hovered,pluginFailures,actionStates},null,2));
        assert.deepEqual(pluginFailures,[]);

        const failures = audit(normal, ai, dialog, scene);
        if ((await page.locator('#tab-ai').innerText()).trim() !== 'AI Assistant') failures.unshift('タブ表示名は AI Assistant');
        fs.writeFileSync(path.join(output, label + '-measurements.json'), JSON.stringify({ scene, colorScheme, normal, ai, dialog, failures }, null, 2));
        assert.deepEqual(await page.evaluate(() => serviceCalls), [], 'AI・kintone・保存への呼び出しはゼロ');
        assert.deepEqual(unexpected, [], '外部ネットへの要求はゼロ'); assert.deepEqual(errors, []);
        assert.deepEqual(failures, []);
        await page.evaluate(() => { configLens.dispose(); work.dispose(); });
      } finally { await context.close(); }
    });
  } finally { await browser.close(); }
});
