'use strict';
// Offline browser only. Real controller/client boundary; AI and kintone responses are fixtures.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), { pathToFileURL } = require('node:url');
const { loadToolkit } = require('./helpers/load-toolkit.js');
const { devBaseLoaderOf } = require('./helpers/dev-base-fake.js');
const { makeKintoneMock } = require('./helpers/kintone-preview-mock.js');
const F = require('./helpers/release-workspace-fixture.js'), E = require('./helpers/release-explanation-fixture.js');
const root = path.resolve(__dirname, '..');
const usage = (remaining = 4, reserved = 0) => ({ version: 4, plan: 'toolkit-light', yyyymm: '209910', resetsAt: '2099-10-31T15:00:00.000Z', timeZone: 'Asia/Tokyo', price: { monthlyJpy: 2480, taxIncluded: true }, operationCosts: { consultation: 1, document: 2, final: 3 }, credits: { limit: 100, used: 100 - remaining - reserved, reserved, remaining } });

test('相談1・資料2・最終案一式3を表示し、残0で複数JSと再開を完了でき、旧課金を誤使用しない', { timeout: 120000 }, async () => {
  let pw; try { pw = require(process.env.PLAYWRIGHT_MODULE || 'playwright'); } catch { pw = require(path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
  const { describeRegistry } = await import(require('./helpers/ai-repo.js').aiUrl('worker/src/v2/prompt-registry.mjs'));
  const health = { ok: true, supportedContractVersions: ['2.1'], registry: describeRegistry(), entitlements: [{ product: 'toolkit', features: ['assistant-qa', 'change-planner', 'customization-generator'] }] };
  const prod = { appId: '310', appName: '共通クレジットの確認', fields: { memo: { type: 'MULTI_LINE_TEXT', code: 'memo', label: '備考' } }, layout: [], views: { views: {}, revision: '1' }, status: { enable: false, states: {}, actions: [] }, customize: { scope: 'ALL', desktop: { js: [], css: [] }, mobile: { js: [], css: [] } } };
  const T = loadToolkit(), mock = makeKintoneMock(prod), loadBase = devBaseLoaderOf({ KTDevBase: { load: T.KTDevBase.loadForRelease } }, { appId: '310', production: prod, mockRef: () => mock });
  let current = usage(), failNext = false, failGenerateId = null, holdHealth = false, holdProposal = true;
  const bundles = new Map();
  let dropUsageNext = false, nextHealthHold = null, nextProposalHold = null;
  const proposalHeld = F.deferred(), healthHeld = F.deferred(), healthStarted = F.deferred(), calls = [], unexpected = [], errors = [];
  const requests = () => calls.filter(c => c.name !== 'getHealth');
  const browser = await pw.chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, serviceWorkers: 'block' });
    await context.route('**/*', route => { if (route.request().url() === 'https://credits.test.invalid/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="ja"><meta charset="utf-8"><div id="app" style="height:100vh"></div></html>' }); unexpected.push(route.request().url()); return route.abort(); });
    const page = await context.newPage(); page.setDefaultTimeout(7000); page.on('pageerror', e => errors.push(e.message));
    await page.exposeFunction('base', loadBase); await page.exposeFunction('api', (name, args) => mock.api[name](...args));
    await page.exposeFunction('service', async (name, ctx, finalBundleId) => {
      calls.push({ name, purpose: ctx?.requestPurpose, customizationId: ctx?.customization?.customizationId, finalBundleId });
      if (name === 'getHealth') { const snapshot = JSON.parse(JSON.stringify(current)); const held = nextHealthHold; nextHealthHold = null; if (held) { held.started.resolve(); await held.wait.promise; } if (holdHealth) { healthStarted.resolve(); await healthHeld.promise; } return { ...health, meta: { usage: snapshot } }; }
      if (name === 'propose' && holdProposal) await proposalHeld.promise;
      if (name === 'propose' && nextProposalHold) { const held = nextProposalHold; nextProposalHold = null; held.started.resolve(); await held.wait.promise; }
      if (failNext) { failNext = false; current = usage(1, 2); return { failure: { code: 'MONTHLY_LIMIT_EXCEEDED', details: { error: { detail: { bucket: 'credits', reason: 'QUOTA_RESERVED', usage: current } } } } }; }
      if (name === 'generate') {
        assert.ok(bundles.has(finalBundleId), '生成は計画から渡された一式の利用記録を使う');
        assert.ok(bundles.get(finalBundleId).includes(ctx.customization.customizationId), '同じ案のJavaScriptだけを作る');
        if (ctx.customization.customizationId === failGenerateId) { failGenerateId = null; return { failure: { code: 'NETWORK_ERROR', message: '一時的な接続エラー' } }; }
        return { ...F.generated(ctx.customization), usage: current };
      }
      const cost = name === 'plan' ? 3 : ctx.requestPurpose === 'document' ? 2 : 1;
      assert.ok(current.credits.remaining >= cost, '必要残数がある場合だけAI要求を送る');
      current.credits.remaining -= cost; current.credits.used += cost;
      const body = name === 'plan' ? F.plan({ settings: false }) : ctx.requestPurpose === 'document' ? E.response('資料の固定応答') : F.proposal();
      if (name === 'plan') {
        body.finalBundle = { version: 1, id: 'bundle-' + (bundles.size + 1), expiresAt: '2099-10-31T15:00:00.000Z' };
        bundles.set(body.finalBundle.id, body.customizations.map(c => c.customizationId));
      }
      if (dropUsageNext) { dropUsageNext = false; delete body.usage; return body; }
      return { ...body, usage: current };
    });
    await page.goto('https://credits.test.invalid/');
    let source = fs.readFileSync(path.join(root, 'kintoneAppToolkit.user.js'), 'utf8').replace('waitReady().then(() => startToolkit());', '');
    const end = source.lastIndexOf('})();'); source = source.slice(0, end) + '\nglobalThis.CreditsTest={mountReleaseWorkspace,KTAiClient};\n' + source.slice(end);
    await page.addScriptTag({ content: source });
    await page.evaluate(({ prod, names }) => {
      const settings = CreditsTest.KTAiClient.createSettingsStore(); settings.setConsent(true, 'release-raw-source-1'); window.copies = []; window.progressEvents = [];
      const client = Object.fromEntries(['getHealth', 'propose', 'plan', 'generate'].map(name => [name, async input => {
        if (name === 'generate') for (const stage of ['repair', 'verify']) { progressEvents.push(stage); input.onEvent?.({ stage }); }
        const r = await window.service(name, input?.ctx, input?.finalBundleId); if (r.failure) throw new CreditsTest.KTAiClient.AiClientError(r.failure); return r;
      }]));
      window.work = CreditsTest.mountReleaseWorkspace(document.querySelector('#app'), { appId: '310', settings, session: { client, status: () => ({ connected: true, apiBase: 'https://gateway.test.invalid' }) }, loadDevBase: window.base, executor: { api: Object.fromEntries(names.map(name => [name, (...args) => window.api(name, args)])) }, getInputs: () => ({ data: prod }), copyText: async text => copies.push(text) }); work.onVisible();
    }, { prod, names: Object.keys(mock.api) });
    const action = name => page.locator('[data-release-action="' + name + '"]').first();
    const phase = value => page.waitForFunction(v => work.controller.getState().phase === v, value);
    const open = async () => { await action('connect').click(); return page.locator('dialog'); };
    await page.waitForFunction(() => work.capability().available);
    await page.locator('#kt-release-input').fill(F.REQUEST); await action('send').click();
    holdHealth = true; await page.evaluate(() => { window.pendingHealth = work.refreshCapability(true); }); await healthStarted.promise;
    holdProposal = false; proposalHeld.resolve(); await phase('proposal'); healthHeld.resolve(); await page.evaluate(() => pendingHealth); holdHealth = false;
    assert.equal(await page.evaluate(() => work.capability().usage.credits.remaining), 3, '遅いhealthの残り4で完了応答の3を巻き戻さない');
    assert.match(await page.locator('.ktr-compose-actions').innerText(), /送信ごとに1クレジット/);
    await action('adopt').click(); await phase('review');
    assert.deepEqual(requests().map(c => c.name), ['propose', 'plan', 'generate', 'generate']);
    assert.equal(await page.evaluate(() => work.capability().usage.credits.remaining), 0);
    assert.deepEqual(await page.evaluate(() => progressEvents), ['repair', 'verify', 'repair', 'verify']);
    assert.equal(await action('send').isDisabled(), true); assert.equal(await action('apply').isEnabled(), true);
    const artifacts = await page.evaluate(() => work.controller.getState().artifacts);
    let dialog = await open(); assert.match(await dialog.locator('[data-usage-plan]').innerText(), /SOLO/);
    assert.match(await dialog.locator('[data-usage-credits]').innerText(), /残り 0 \/ 月 100.*利用済み 100・確保中 0/);
    assert.equal(await dialog.locator('[data-usage-bucket]').count(), 0);
    await dialog.getByText('クレジットの数え方', { exact: true }).click();
    assert.match(await dialog.innerText(), /最終案一式で3クレジット/);
    assert.match(await dialog.innerText(), /自動修復・確認では追加消費しません/); assert.match(await dialog.locator('[data-usage-price]').innerText(), /2,480円（税込）/); assert.doesNotMatch(await dialog.innerText(), /作成1回|相談1回|gpt-|token/i);
    const out = path.join(__dirname, '.build/release-credits'); fs.mkdirSync(out, { recursive: true }); await page.screenshot({ path: path.join(out, 'connection-credits.png') });
    await dialog.locator('[data-close]').click();
    await page.evaluate(() => work.controller.reprepare()); await phase('review'); assert.equal(requests().length, 4, '反映前の確認をやり直してもクレジット要求なし');
    await action('documents').click(); dialog = page.locator('dialog'); assert.equal(await dialog.locator('[data-document-create]').isDisabled(), true); assert.equal(await dialog.locator('[data-offline-export]').isEnabled(), true); await dialog.locator('[data-close]').click();
    current = usage(4); await page.evaluate(() => work.refreshCapability(true));
    await action('documents').click(); assert.match(await page.locator('[data-document-status]').innerText(), /2クレジット/); await page.locator('[data-document-create]').click();
    await page.waitForFunction(() => work.controller.getState().explanations.length === 1); assert.equal(await page.evaluate(() => work.capability().usage.credits.remaining), 2);
    assert.match(await page.locator('.ktr-compose-actions').innerText(), /送信ごとに2クレジット/);
    await page.locator('#kt-release-input').fill('資料を短くしてください'); await action('send').click(); await page.waitForFunction(() => work.controller.getState().explanations.length === 2);
    assert.equal(await page.evaluate(() => work.capability().usage.credits.remaining), 0); assert.equal(requests().length, 6, '資料作成も修正も各2クレジット、各1要求だけ');
    await action('copy-explanation').click(); assert.equal(await page.evaluate(() => copies.length), 1); assert.equal(requests().length, 6);
    assert.deepEqual(await page.evaluate(() => work.controller.getState().artifacts), artifacts);
    current = usage(2); await page.evaluate(() => work.refreshCapability(true)); failNext = true;
    await page.locator('#kt-release-input').fill('残す資料の修正文'); await action('send').click(); await page.waitForFunction(() => work.controller.getState().error?.code === 'MONTHLY_LIMIT_EXCEEDED');
    assert.equal(await page.locator('#kt-release-input').inputValue(), '残す資料の修正文');
    assert.equal(await action('send').isDisabled(), true); assert.match(await page.locator('.ktr-compose-actions').innerText(), /処理中の分を確保/);
    assert.equal(await page.evaluate(() => work.controller.getState().explanations.length), 2);
    assert.deepEqual(await page.evaluate(() => work.controller.getState().artifacts), artifacts);
    await action('focus-consultation').click(); assert.equal(await action('send').isEnabled(), true, '残1なら資料は作れなくても相談できる');
    const rolloverClock = Date.now(); await page.clock.install({ time: new Date(rolloverClock) }); await page.clock.pauseAt(new Date(rolloverClock + 1000));
    current = usage(0); current.resetsAt = new Date(rolloverClock + 1500).toISOString(); await page.evaluate(() => work.refreshCapability(true));
    await action('documents').click(); assert.equal(await page.locator('[data-document-create]').isDisabled(), true);
    current = usage(5); await page.clock.runFor(600); await page.clock.resume(); await page.waitForFunction(() => work.capability().usage.credits.remaining === 5);
    assert.equal(await page.locator('[data-document-create]').isEnabled(), true, '月替わりで開いた資料ダイアログも更新'); await page.locator('dialog [data-close]').click();
    assert.equal(await action('send').isEnabled(), true); assert.equal(await page.locator('#kt-release-input').inputValue(), '残す資料の修正文');
    await page.locator('#kt-release-input').fill(''); await page.evaluate(() => work.controller.newTask());
    current = usage(3); await page.evaluate(() => work.refreshCapability(true)); const partialStart = requests().length;
    await page.locator('#kt-release-input').fill(F.REQUEST); await action('send').click(); await phase('proposal');
    assert.equal(await action('adopt').isDisabled(), true, '相談後の残2では最終案を始めない');
    assert.match(await page.locator('.ktr-workspace').innerText(), /この操作には3クレジット必要です。残りは2クレジットです/);
    current = usage(3); await page.evaluate(() => work.refreshCapability(true)); failGenerateId = 'C2';
    assert.equal(await action('adopt').isEnabled(), true);
    await action('adopt').click(); await phase('incomplete');
    assert.deepEqual(requests().slice(partialStart).map(c => c.name), ['propose', 'plan', 'generate', 'generate']);
    const completed = await page.evaluate(() => work.controller.getState().artifacts.find(a => a.result?.artifactOutcome?.state === 'ready'));
    assert.ok(completed); assert.equal(await page.evaluate(() => work.capability().usage.credits.remaining), 0);
    assert.equal(await action('resume').isEnabled(), true, '同じ案の残りは残0でも再開できる');
    await action('resume').click(); await phase('review');
    assert.deepEqual(requests().slice(partialStart).map(c => c.name), ['propose', 'plan', 'generate', 'generate', 'generate']);
    assert.equal(requests().at(-1).customizationId, 'C2');
    assert.deepEqual(await page.evaluate(id => work.controller.getState().artifacts.find(a => a.customizationId === id), completed.customizationId), completed);
    assert.equal(await page.evaluate(() => work.capability().usage.credits.remaining), 0); assert.equal(await action('apply').isEnabled(), true);
    const finalGenerations = requests().slice(partialStart).filter(c => c.name === 'generate');
    assert.equal(new Set(finalGenerations.map(c => c.finalBundleId)).size, 1, '再開も同じ最終案の利用記録');
    assert.equal(current.credits.used, 100, 'JSの本数と再開で追加消費しない');
    current = { ...usage(10), version: 3 }; delete current.operationCosts; delete current.price;
    await page.evaluate(() => work.refreshCapability(true));
    const beforeOld = requests().length;
    assert.equal(await action('send').isDisabled(), true);
    await action('documents').click(); assert.equal(await page.locator('[data-document-create]').isDisabled(), true);
    assert.match(await page.locator('[data-document-status]').innerText(), /AIサービス.*更新/);
    await page.locator('dialog [data-close]').click();
    await page.evaluate(() => work.controller.send('旧方式へ送らない'));
    assert.equal(await page.evaluate(() => work.controller.getState().error?.code), 'CAPABILITY_OUTDATED');
    assert.equal(requests().length, beforeOld, '旧v3へ新方式としてAIを依頼しない');
    current = usage(5); await page.evaluate(() => work.refreshCapability(true));
    assert.equal(await action('send').isEnabled(), true, '有効なv4接続へ戻すと相談を再開できる');
    await page.evaluate(() => work.controller.newTask());
    const missingResponse = { started: F.deferred(), wait: F.deferred() }; nextProposalHold = missingResponse; dropUsageNext = true;
    await page.locator('#kt-release-input').fill(F.REQUEST); await action('send').click(); await missingResponse.started.promise;
    const staleHealth = { started: F.deferred(), wait: F.deferred() }; nextHealthHold = staleHealth;
    await page.evaluate(() => { window.pendingContractHealth = work.refreshCapability(true); }); await staleHealth.started.promise;
    missingResponse.wait.resolve(); await phase('proposal');
    assert.equal(await page.evaluate(() => work.capability().usage.credits.remaining), 5, '利用情報が欠けても最後に確認した残数を消さない');
    assert.equal(await action('send').isDisabled(), true); assert.equal(await action('adopt').isDisabled(), true, 'usage欠落後は新たな作成に進まない');
    staleHealth.wait.resolve(); await page.evaluate(() => pendingContractHealth);
    assert.equal(await action('send').isDisabled(), true, '欠落応答より古いhealthで契約不明の停止を解除しない');
    await action('documents').click(); assert.equal(await page.locator('[data-document-create]').isDisabled(), true);
    assert.match(await page.locator('[data-document-status]').innerText(), /AIサービス.*更新/); await page.locator('dialog [data-close]').click();
    const beforeMissing = requests().length;
    await page.evaluate(() => work.controller.send('利用状況が不明のまま送信しない'));
    assert.equal(await page.evaluate(() => work.controller.getState().error?.code), 'CAPABILITY_OUTDATED');
    assert.equal(requests().length, beforeMissing);
    await page.evaluate(() => work.refreshCapability(true));
    assert.equal(await page.evaluate(() => work.capability().usage.credits.remaining), 4, '新たに確認したv4の実残数へ回復する');
    assert.equal(await action('send').isEnabled(), true);
    current = { ...usage(99), version: 5 }; await page.evaluate(() => work.refreshCapability(true));
    assert.equal(await page.evaluate(() => work.capability().usage.credits.remaining), 4, '未知版のhealthで残数を置き換えない');
    assert.equal(await action('send').isDisabled(), true);
    const beforeUnknown = requests().length;
    await page.evaluate(() => work.controller.send('未知のクレジット契約では送信しない'));
    assert.equal(await page.evaluate(() => work.controller.getState().error?.code), 'CAPABILITY_OUTDATED'); assert.equal(requests().length, beforeUnknown);
    current = usage(4); await page.evaluate(() => work.refreshCapability(true));
    assert.equal(await action('send').isEnabled(), true, '未知版の停止も有効なv4の再接続で回復する');
    await action('documents').click(); assert.equal(await page.locator('[data-document-create]').isEnabled(), true); await page.locator('dialog [data-close]').click();

    assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
  } finally { await browser.close(); }
});
