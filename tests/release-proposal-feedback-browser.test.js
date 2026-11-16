'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
let browser;
test.before(async () => {
  let pw; try { pw = require('playwright'); } catch { pw = require(path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
  browser = await pw.chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
});
test.after(async () => { await browser?.close(); });
const INITIAL = { reply: '配置と入力条件を選択してください。', intent: 'propose', proposal: {
  behaviors: [{ id: 'B1', text: '出発地と到着地を入力できるようにする', origin: 'user' }, { id: 'B2', text: '経費合計を一覧に表示する', origin: 'suggestion' }, { id: 'B3', text: '申請者へ通知する', origin: 'suggestion' }],
  decisions: [{ id: 'Q1', blocking: true, question: '出発地と到着地をどこに配置しますか？', options: ['手段の後', '末尾'] }, { id: 'Q2', blocking: true, question: '入力漏れがある場合は保存を止めますか？', options: ['保存を止める', '保存を許可する'] }],
  assumptions: [], cannot: [], approach: { standard: [], js: [] }
}, turn: { ops: [], answers: [], requirementOps: [] } };
async function mounted(t, connection = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [], network = [];
  t.after(async () => { await page.close(); assert.deepEqual(errors, []); assert.deepEqual(network, []); });
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => { network.push(route.request().url()); return route.abort(); });
  await page.setContent('<!doctype html><html lang="ja"><meta charset="utf-8"><body style="margin:0"><div id="host" style="height:100vh"></div></body></html>');
  for (const file of ['release-utils.js', 'release-workflow-diagram.js', 'release-workflow-overview.js']) await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../src', file), 'utf8') });
  await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../src/release-workspace.js'), 'utf8') + '\nwindow.Workspace = KTReleaseWorkspace;' });
  await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../src/release-view.js'), 'utf8') + '\nwindow.View = KTReleaseView;' });
  await page.evaluate(async ({ initial, connection }) => {
    window.calls = []; window.mode = 'normal'; window.gates = 0; window.recoveryCalls = 0;
    const recovered = structuredClone(initial); recovered.reply = '回答を回収しました。'; recovered.proposal.behaviors[1].origin = 'user'; recovered.turn.answers = [{ id: 'Q1', text: '手段の後' }, { id: 'Q2', text: '交通費のときだけ必須にしてください。' }];
    window.controller = Workspace.create({ loadBase: async () => ({ ok: true, stamp: 'same' }), services: {
      propose: async args => {
        calls.push({ method: 'propose', text: args.text, requestPurpose: args.requestPurpose });
        if (mode === 'fail') throw Error('固定の通信失敗');
        if (mode === 'lost') { const record = { version: 1, kind: 'propose', body: JSON.stringify({ contractVersion: '2.1', meta: { requestId: 'feedback-test', product: 'toolkit' }, payload: { app: { id: 'test-only' } } }), inputHash: 'test-hash', facts: [] }; await args.onRecoveryPrepared(record); throw Object.assign(Error('受取前に通信が切れました'), { code: 'TRANSPORT_ERROR', recovery: record }); }
        if (mode === 'wait') await new Promise(resolve => window.releaseReply = resolve);
        const r = structuredClone(initial);
        if (calls.length > 1) { r.reply = '回答と改善提案を反映しました。'; r.proposal.behaviors[1].origin = 'user'; r.turn.answers = [{ id: 'Q1', text: '手段の後' }, { id: 'Q2', text: '交通費のときだけ必須にしてください。' }]; }
        return r;
      }, recover: async () => { recoveryCalls++; return structuredClone(recovered); }, validateRecovery: async () => true, plan: async () => { calls.push({ method: 'plan' }); throw Error('計画を呼ばない'); }, generate: async () => { calls.push({ method: 'generate' }); throw Error('生成しない'); }
    }, execution: { apply: async () => { calls.push({ method: 'write' }); throw Error('反映しない'); } } });
    await controller.send('経費申請の入力を改善したいです。');
    window.view = View.create(document.querySelector('#host'), { controller, connection, beforeSend: async () => { gates++; return true; } });
  }, { initial: INITIAL, connection });
  return page;
}
const input = page => page.locator('#kt-release-input');
const answer = (page, id) => page.locator('[data-release-decision="' + id + '"]');
const choose = page => page.locator('[data-release-action="answer"][data-release-id="Q1"]').filter({ hasText: '手段の後' });
const send = page => page.locator('[data-release-action="send"]');
async function fillAnswers(page) {
  await choose(page).click();
  await answer(page, 'Q2').fill('交通費のときだけ必須にしてください。');
  await page.locator('[data-release-suggestion="B2"]').check();
  await input(page).fill('モバイルにも同じ動作を適用してください。');
}

test('質問を選択・編集してもチャットと入力DOMを作り直さず、広さ・文章・フォーカスを保持する', async t => {
  const page = await mounted(t);
  await input(page).fill('入力途中の追加指示');
  await page.evaluate(() => {
    window.oldChat = document.querySelector('#kt-release-input'); oldChat.style.height = '280px';
    window.oldLog = document.querySelector('.ktr-chat-log'); window.oldQuestion = document.querySelector('[data-release-decision="Q2"]');
    window.logHeight = oldLog.getBoundingClientRect().height; window.logText = oldLog.textContent;
  });
  await choose(page).click();
  assert.equal(await choose(page).getAttribute('aria-pressed'), 'true');
  assert.equal(await answer(page, 'Q1').inputValue(), '手段の後');
  await answer(page, 'Q2').focus(); await answer(page, 'Q2').pressSequentially('交通費だけ必須に変更', { delay: 1 });
  const state = await page.evaluate(() => ({
    sameChat: oldChat === document.querySelector('#kt-release-input'), sameLog: oldLog === document.querySelector('.ktr-chat-log'), sameQuestion: oldQuestion === document.querySelector('[data-release-decision="Q2"]'),
    height: oldChat.style.height, text: oldChat.value, logStable: oldLog.textContent === logText, logHeight: oldLog.getBoundingClientRect().height, expectedLogHeight: logHeight,
    focused: document.activeElement === oldQuestion, position: oldQuestion.selectionStart, draft: oldQuestion.value, calls, answers: controller.getState().answers
  }));
  assert.equal(state.sameChat, true); assert.equal(state.sameLog, true); assert.equal(state.sameQuestion, true);
  assert.equal(state.height, '280px'); assert.equal(state.text, '入力途中の追加指示'); assert.equal(state.logStable, true);
  assert.equal(state.logHeight, state.expectedLogHeight); assert.equal(state.focused, true); assert.equal(state.position, state.draft.length);
  assert.equal(state.calls.length, 1); assert.deepEqual(state.answers, []);
  assert.equal(await send(page).textContent(), 'まとめて送信');
  assert.equal(await page.locator('[data-release-action="adopt"]').isDisabled(), true);
});

test('質問2件・改善選択・自由文をまとめて相談1回に送り、連打や個別選択では追加送信しない', async t => {
  const page = await mounted(t); await fillAnswers(page);
  assert.equal(await page.evaluate(() => calls.length), 1);
  await page.evaluate(() => { mode = 'wait'; const button = document.querySelector('[data-release-action="send"]'); button.click(); button.click(); });
  await page.waitForFunction(() => typeof window.releaseReply === 'function');
  assert.equal(await page.evaluate(() => calls.length), 2);
  assert.equal(await send(page).isDisabled(), true);
  await page.evaluate(() => releaseReply());
  await page.waitForFunction(() => controller.getState().version === 2);
  const result = await page.evaluate(() => ({ calls, gates, state: controller.getState() }));
  assert.equal(result.gates, 1); assert.equal(result.calls.length, 2); assert.equal(result.calls[1].requestPurpose, 'consultation');
  for (const part of [INITIAL.proposal.decisions[0].question, INITIAL.proposal.decisions[1].question, '手段の後', '交通費のときだけ必須にしてください。', '経費合計を一覧に表示する', 'モバイルにも同じ動作を適用してください。']) assert.equal(result.calls[1].text.split(part).length - 1, 1, part);
  assert.ok(!result.calls[1].text.includes('申請者へ通知する'));
  assert.equal(await input(page).inputValue(), ''); assert.deepEqual(result.state.decisionDrafts, {}); assert.deepEqual(result.state.selectedSuggestionIds, []);
  assert.equal(result.state.answers.length, 2); assert.equal(await page.locator('[data-release-action="adopt"]').isDisabled(), false);
});

test('通信失敗後も回答と選択は保持し、送信済み自由文は履歴だけに残す', async t => {
  const page = await mounted(t); await fillAnswers(page);
  await page.evaluate(() => { mode = 'fail'; }); await send(page).click();
  await page.waitForFunction(() => controller.getState().error?.message.includes('固定の通信失敗'));
  assert.equal(await answer(page, 'Q1').inputValue(), '手段の後');
  assert.equal(await answer(page, 'Q2').inputValue(), '交通費のときだけ必須にしてください。');
  assert.equal(await page.locator('[data-release-suggestion="B2"]').isChecked(), true);
  assert.equal(await input(page).inputValue(), '');
  assert.ok((await page.evaluate(()=>controller.getState().messages.filter(m=>m.role==='user').at(-1).text)).includes('モバイルにも同じ動作を適用してください。'));
  assert.equal(await page.evaluate(() => calls.length), 2); assert.equal(await send(page).isDisabled(), false);
  assert.equal(await page.locator('[data-release-action="adopt"]').isDisabled(), true);
  await input(page).fill('モバイルにも同じ動作を適用してください。');
  await page.evaluate(() => { mode = 'normal'; }); await send(page).click();
  await page.waitForFunction(() => controller.getState().version === 2);
  const requests = await page.evaluate(() => calls.filter(c => c.method === 'propose'));
  assert.equal(requests.length, 3); assert.equal(requests[1].text, requests[2].text);
});

for (const changed of ['', '次に相談したい別の内容', 'モバイルにも同じ動作を適用してください。']) test('一括回答を無料回収し、後から入力した下書きを同文でも消さない: ' + changed, async t => {
  const page = await mounted(t); await fillAnswers(page);
  await page.evaluate(() => { mode = 'lost'; }); await send(page).click();
  await page.waitForFunction(() => controller.getState().phase !== 'consulting' && !!controller.getState().responseRecovery);
  assert.equal(await input(page).inputValue(), '');
  assert.ok((await page.evaluate(()=>controller.getState().messages.filter(m=>m.role==='user').at(-1).text)).includes('モバイルにも同じ動作を適用してください。'));
  const restored = await page.evaluate(async changed => {
    const saved = JSON.parse(JSON.stringify(controller.exportSession()));
    const ok = await controller.restoreSession(saved);
    if (changed) view.setDraft(changed);
    return { ok, kind: controller.getState().responseRecovery.action, pending: controller.getState().decisionDrafts };
  }, changed);
  assert.equal(restored.ok, true); assert.equal(restored.kind, 'updateSuggestions'); assert.equal(Object.keys(restored.pending).length, 2);
  await page.locator('[data-release-action="recover-response"]').click();
  await page.waitForFunction(() => controller.getState().responseRecovery === null);
  const after = await page.evaluate(() => ({ calls, recoveryCalls, state: controller.getState() }));
  assert.equal(after.calls.length, 2); assert.equal(after.recoveryCalls, 1); assert.equal(after.state.answers.length, 2);
  assert.deepEqual(after.state.decisionDrafts, {}); assert.deepEqual(after.state.selectedSuggestionIds, []);
  assert.equal(after.state.messages.filter(m => m.role === 'user').length, 2);
  assert.equal(await input(page).inputValue(), changed);
  assert.equal(await page.locator('[data-release-action="adopt"]').isDisabled(), !!changed);
});


test('資料モードのままでも明示した回答は相談1回にまとめ、資料枠がなくても相談枠で送れる', async t => {
  const page = await mounted(t, { connected: true, available: true, canDocument: false, canConsult: true,
    usage: { version: 4, operationCosts: { consultation: 1, document: 2, final: 3 }, credits: { limit: 100, used: 99, reserved: 0, remaining: 1 } } });
  await page.evaluate(() => controller.setRequestPurpose('document'));
  assert.equal(await send(page).isDisabled(), true);
  await input(page).fill('モバイルにも適用してください。');
  await page.evaluate(() => {
    window.documentChat = document.querySelector('#kt-release-input'); documentChat.style.height = '275px';
    window.documentLog = document.querySelector('.ktr-chat-log'); window.documentLogText = documentLog.textContent;
  });
  await choose(page).click();
  await answer(page, 'Q2').fill('交通費のときだけ必須にしてください。');
  const before = await page.evaluate(() => ({ calls: calls.length, sameInput: documentChat === document.querySelector('#kt-release-input'), sameLog: documentLog === document.querySelector('.ktr-chat-log'),
    height: documentChat.style.height, text: documentChat.value, logText: documentLog.textContent, expectedLogText: documentLogText, purpose: controller.getState().requestPurpose }));
  assert.equal(before.calls, 1); assert.equal(before.sameInput, true); assert.equal(before.sameLog, true);
  assert.equal(before.height, '275px'); assert.equal(before.text, 'モバイルにも適用してください。'); assert.equal(before.logText, before.expectedLogText);
  assert.equal(before.purpose, 'document', '選択だけで資料モードそのものを変えない');
  assert.equal(await send(page).textContent(), 'まとめて送信'); assert.equal(await send(page).isDisabled(), false);
  assert.match(await page.locator('.ktr-compose-actions .ktr-note').innerText(), /送信ごとに1クレジット/);
  await send(page).click(); await page.waitForFunction(() => controller.getState().version === 2);
  const requests = await page.evaluate(() => calls);
  assert.equal(requests.length, 2); assert.equal(requests[1].requestPurpose, 'consultation');
  for (const text of [INITIAL.proposal.decisions[0].question, '手段の後', INITIAL.proposal.decisions[1].question, '交通費のときだけ必須にしてください。', 'モバイルにも適用してください。']) assert.equal(requests[1].text.split(text).length - 1, 1, text);
  assert.equal(await input(page).inputValue(), '');
});
