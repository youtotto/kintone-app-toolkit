'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
let browser;
test.before(async () => {
  let pw; try { pw = require('playwright'); } catch { pw = require(path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
  browser = await pw.chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
});
test.after(async () => { await browser?.close(); });
const initial = { reply: '追加提案を選べます。', intent: 'propose', proposal: {
  behaviors: [{ id: 'B1', text: '承認済みの備考は編集不可にする', origin: 'user' }, { id: 'B2', text: '備考を一覧に表示する', origin: 'suggestion' }, { id: 'B3', text: '確認担当者へ通知する', origin: 'suggestion' }, { id: 'B4', text: '担当者ごとの一覧を追加する', origin: 'suggestion' }],
  assumptions: [{ id: 'A1', text: '現在の担当者を使います' }], cannot: ['モバイルの実際の画面では未確認です'], approach: { standard: [], js: [] },
  decisions: [{ id: 'Q1', blocking: true, question: '誰が確認しますか？', options: ['現在の担当者'] }]
}, turn: { ops: [], answers: [], requirementOps: [] } };
const updated = JSON.parse(JSON.stringify(initial)); updated.reply = '選んだ2件を案へ追加しました。'; updated.intent = 'update';
updated.proposal.behaviors[1].origin = 'user'; updated.proposal.behaviors[2].origin = 'user';
async function mounted(t) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }), errors = [], network = [];
  t.after(async () => { assert.deepEqual(errors, []); assert.deepEqual(network, []); await page.close(); });
  page.on('pageerror', e => errors.push(e.message)); await page.route('**/*', r => { network.push(r.request().url()); return r.abort(); });
  await page.setContent('<!doctype html><html lang="ja"><meta charset="utf-8"><title>追加提案の確認</title><body style="margin:0"><div id="host" style="height:100vh"></div></body></html>');
  for (const file of ['release-utils.js', 'release-workflow-diagram.js', 'release-workflow-overview.js']) await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../src', file), 'utf8') });
  await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../src/release-workspace.js'), 'utf8') + '\nwindow.Workspace = KTReleaseWorkspace;' });
  await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../src/release-view.js'), 'utf8') + '\nwindow.View = KTReleaseView;' });
  await page.evaluate(async ({ initial, updated }) => {
    window.calls = []; window.gates = 0; window.mode = 'normal'; window.gateMode = 'allow'; window.initial = initial; window.updated = updated;
    window.controller = Workspace.create({ loadBase: async () => { calls.push({ method: 'read' }); return { ok: true, stamp: 'preview:1' }; }, services: {
      propose: async args => { calls.push({ method: 'propose', text: args.text }); if (mode === 'fail') throw Error('固定の通信失敗'); if (mode === 'wait') await new Promise(resolve => window.releaseReply = resolve); return structuredClone(calls.filter(c => c.method === 'propose').length === 1 ? initial : updated); },
      plan: async () => { calls.push({ method: 'plan' }); throw Error('この確認では計画を作りません'); }, generate: async () => { throw Error('生成しません'); }
    }, execution: { apply: async () => { calls.push({ method: 'write' }); throw Error('書き込みません'); } } });
    await controller.send('承認済みの備考を編集不可にしてください');
    window.view = View.create(document.querySelector('#host'), { controller, beforeSend: async () => { gates++; if (gateMode === 'wait') await new Promise(resolve => window.releaseGate = resolve); return gateMode !== 'deny'; } });
  }, { initial, updated });
  return page;
}
const check = (page, id) => page.locator(`[data-release-suggestion="${id}"]`);
const update = page => page.locator('[data-release-action="send"]');

test('実ブラウザーで複数の追加提案をキーボードで選び、一度だけ更新し、必須質問と制約を保持する', async t => {
  const page = await mounted(t); assert.equal(await page.locator('[data-release-action="update-suggestions"]').count(), 0);
  await check(page, 'B2').focus(); await page.keyboard.press('Space');
  assert.equal(await check(page, 'B2').isChecked(), true);
  assert.equal(await check(page, 'B2').evaluate(el => document.activeElement === el), true);
  await check(page, 'B3').check();
  assert.deepEqual(await page.evaluate(() => calls.map(c => c.method)), ['read', 'propose']);
  assert.equal(await page.locator('[data-release-action="adopt"]').isDisabled(), true);
  const suggestions = page.locator('[data-release-panel="suggestions"]');
  assert.equal(await suggestions.getByText('誰が確認しますか？').count(), 0);
  assert.equal(await suggestions.getByText('モバイルの実際の画面では未確認です').count(), 0);
  await page.locator('#kt-release-input').fill('モバイルでも同じ内容にしてください'); assert.equal(await update(page).isDisabled(), false);
  await page.evaluate(() => { mode = 'wait'; }); await update(page).click();
  await page.waitForFunction(() => typeof window.releaseReply === 'function');
  assert.equal(await check(page, 'B4').isDisabled(), true);
  await page.evaluate(() => window.releaseReply());
  await page.waitForFunction(() => controller.getState().version === 2);
  const result = await page.evaluate(() => ({ calls, state: controller.getState(), gates }));
  assert.equal(result.gates, 1); assert.equal(result.calls.filter(c => c.method === 'propose').length, 2);
  const text = result.calls.filter(c => c.method === 'propose')[1].text;
  assert.match(text, /モバイルでも同じ内容にしてください/); assert.match(text, /備考を一覧に表示する/); assert.match(text, /確認担当者へ通知する/); assert.doesNotMatch(text, /担当者ごとの一覧を追加/);
  assert.equal(result.calls.filter(c => ['plan', 'write'].includes(c.method)).length, 0);
  assert.deepEqual(result.state.proposal.decisions, initial.proposal.decisions); assert.deepEqual(result.state.proposal.cannot, initial.proposal.cannot);
  assert.equal(await check(page, 'B2').count(), 0); assert.equal(await check(page, 'B3').count(), 0); assert.equal(await check(page, 'B4').isChecked(), false);
  assert.equal(await update(page).textContent(), '送信'); assert.equal(await page.locator('[data-release-action="adopt"]').isDisabled(), true);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await check(page, 'B4').check(); assert.equal(await check(page, 'B4').isChecked(), true);
});

test('接続前の確認を通し、取消・二重押下・古い版の操作では追加送信しない', async t => {
  const page = await mounted(t); await check(page, 'B2').check();
  await page.evaluate(() => { gateMode = 'deny'; }); await update(page).click();
  assert.equal(await page.evaluate(() => calls.filter(c => c.method === 'propose').length), 1);
  assert.equal(await check(page, 'B2').isChecked(), true);
  await page.evaluate(() => { gateMode = 'wait'; });
  await page.evaluate(() => { const b = document.querySelector('[data-release-action="send"]'); b.click(); b.click(); });
  await page.waitForFunction(() => typeof window.releaseGate === 'function');
  assert.equal(await page.evaluate(() => gates), 2); assert.equal(await check(page, 'B2').isDisabled(), true);
  await page.evaluate(() => { controller.newTask(); gateMode = 'allow'; releaseGate(); });
  await page.waitForFunction(() => controller.getState().phase === 'idle');
  assert.equal(await page.evaluate(() => calls.filter(c => c.method === 'propose').length), 1);
  assert.equal(await page.locator('#kt-release-input').inputValue(), '');
});

test('一括送信の失敗は選択と会話本文を保持し、入力欄へ戻さず古い案の作成を止める', async t => {
  const page = await mounted(t); await check(page, 'B2').check();
  await page.locator('#kt-release-input').fill('モバイルにも対応してください');
  await page.evaluate(() => { mode = 'fail'; }); await update(page).click();
  await page.waitForFunction(() => controller.getState().error?.message.includes('固定の通信失敗'));
  const value = await page.locator('#kt-release-input').inputValue(); assert.equal(value, ''); assert.ok((await page.evaluate(()=>controller.getState().messages.filter(m=>m.role==='user').at(-1).text)).includes('モバイルにも対応してください'));
  assert.doesNotMatch(value, /確認担当者へ通知する/); assert.equal(await page.locator('[data-release-action="adopt"]').isDisabled(), true);
  assert.equal(await update(page).isDisabled(), false); assert.equal(await check(page, 'B2').isChecked(), true);
  assert.equal(await page.evaluate(() => controller.getState().proposalPending), true);
  assert.equal(await page.evaluate(() => calls.filter(c => c.method === 'propose').length), 2);
});


test('接続前の確認中に入力された修正は捨てず、追加提案の更新を送らない', async t => {
  const page = await mounted(t); await check(page, 'B2').check();
  await page.evaluate(() => { gateMode = 'wait'; }); await update(page).click();
  await page.waitForFunction(() => typeof window.releaseGate === 'function');
  await page.locator('#kt-release-input').fill('通知先はもう一度相談します');
  await page.evaluate(() => { gateMode = 'allow'; releaseGate(); });
  await page.waitForFunction(() => document.querySelector('[data-release-suggestion="B2"]').disabled === false);
  assert.equal(await page.locator('#kt-release-input').inputValue(), '通知先はもう一度相談します');
  assert.equal(await check(page, 'B2').isChecked(), true); assert.equal(await update(page).isDisabled(), false);
  assert.equal(await page.evaluate(() => calls.filter(c => c.method === 'propose').length), 1);
});
