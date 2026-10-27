'use strict';
// Product controller/view in an offline browser; services and writes are fixed fixtures.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');

test('計画の仮決定・結果の読取確認・検証不能から相談する操作を実ブラウザーで確認する', { timeout: 60000 }, async () => {
  let pw; try { pw = require('playwright'); } catch { pw = require(path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
  const browser = await pw.chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
  const errors = [], network = [], out = path.join(__dirname, '.build/release-result-actions');
  fs.mkdirSync(out, { recursive: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', r => r.request().url() === 'https://release.test.invalid/' ? r.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="ja"><meta charset="utf-8"><body style="margin:0"><div id="host" style="height:100vh"></div></body></html>' }) : (network.push(r.request().url()), r.abort()));
    await page.goto('https://release.test.invalid/');
    for (const file of ['release-workspace.js', 'release-view.js']) await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../src', file), 'utf8') });
    await page.evaluate(() => {
      window.calls = { ai: 0, apply: 0, read: 0, rollback: 0, rollbackRead: 0 }; window.unverified = false; window.purposes = [];
      const proposal = { behaviors: [{ id: 'B1', text: '承認待ちの一覧を追加する', origin: 'user' }], decisions: [], assumptions: [], cannot: ['画面からの操作だけが対象です。'] };
      window.controller = KTReleaseWorkspace.create({ loadBase: async () => ({ ok: true, stamp: 'fixed' }), services: {
        propose: async ({ requestPurpose }) => { calls.ai++; purposes.push(requestPurpose); return requestPurpose === 'document'
          ? { reply: '資料を作りました。', intent: 'question', proposalUnchanged: true, explanation: { title: '今の作業の資料', sections: [{ heading: '未確認', paragraphs: ['編集制御の動作は確認できていません。'], items: [], evidenceIds: [] }], unknowns: [] } }
          : { reply: '変更案を確認してください。', proposal }; },
        plan: async () => { calls.ai++; return { plan: { steps: [], customizations: unverified ? [{ customizationId: 'C1', requirement: '備考の編集制御', risks: [], questions: [] }] : [],
          provisionals: [{ id: 'V1', topic: '対象', choice: '一覧からの編集にも同じ制御を適用します。', reason: '同じ項目を一覧から変更できるためです。', changeHint: '一覧の編集は対象外にしたい、と相談してください。' }] } }; },
        generate: async () => { calls.ai++; return { artifactOutcome: { version: 'artifact-outcome-1', state: 'unverified', message: '模擬テストの環境がこの処理に対応していません。', reasonCodes: ['sandbox-outdated'], operations: [] } }; }
      }, execution: {
        prepare: async () => ({ ok: true, changes: [{ kind: 'setting', title: '承認待ちの一覧を追加' }], confirmations: ['既存の一覧は変更しません。'] }),
        apply: async () => { calls.apply++; return { status: 'unknown', written: null, message: '通信が途切れて結果を受け取れませんでした。' }; },
        prepareRollback: async () => ({ ok: true, changes: [{ title: '一覧を元へ戻す' }], confirmations: [] }),
        rollback: async () => { calls.rollback++; return { status: 'unknown', message: '復元の応答がありません' }; },
        recheckRollback: async run => { calls.rollbackRead++; return { ...run.rollback, status: 'complete', message: '復元結果を確認しました' }; },
        recheckApply: async run => { calls.read++; await new Promise(resolve => { window.finishRead = resolve; }); return { ...run.result, status: 'complete', written: true, recoveryState: 'applied', message: '読み戻した設定は反映する内容と一致しました。' }; }
      } });
      window.view = KTReleaseView.create(document.querySelector('#host'), { controller });
    });
    const send = async text => { await page.locator('#kt-release-input').fill(text); await page.locator('[data-release-action="send"]').click(); };
    await send('承認待ちの一覧を追加してください');
    await page.locator('[data-release-action="adopt"]').click();
    await page.waitForFunction(() => controller.getState().phase === 'review');
    assert.equal(await page.getByRole('heading', { name: '計画で決めたこと', exact: true }).isVisible(), true);
    assert.equal(await page.getByText('一覧からの編集にも同じ制御を適用します。', { exact: true }).isVisible(), true);
    assert.equal(await page.getByText('既存の一覧は変更しません。', { exact: true }).isVisible(), true);
    await page.getByText('変更したいとき', { exact: true }).click();
    assert.equal(await page.getByText('一覧の編集は対象外にしたい、と相談してください。', { exact: true }).isVisible(), true);
    await page.setViewportSize({ width: 390, height: 900 });
    await page.locator('[data-release-action="apply"]').scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(out, 'narrow-plan-decisions.png') });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('[data-release-action="apply"]').click();
    await page.waitForFunction(() => controller.getState().phase === 'result');
    const before = await page.evaluate(() => ({ ...calls }));
    await page.locator('#kt-release-input').fill('未送信の次の相談');
    await page.locator('[data-release-action="recheck-apply"]').click();
    await page.waitForFunction(() => controller.getState().phase === 'checking-result' && typeof finishRead === 'function');
    assert.equal(await page.locator('#kt-release-input').isDisabled(), true);
    assert.match(await page.locator('.ktr-current h2').first().innerText(), /反映結果を確認しています/);
    assert.doesNotMatch(await page.locator('.ktr-phase').innerText(), /復元/);
    await page.evaluate(() => finishRead());
    await page.waitForFunction(() => controller.getState().phase === 'result');
    assert.equal(await page.locator('#kt-release-input').inputValue(), '未送信の次の相談');
    assert.match(await page.locator('.ktr-current').innerText(), /読み戻した設定は反映する内容と一致/);
    assert.equal(await page.locator('[data-release-action="recheck-apply"]').count(), 0);
    assert.deepEqual(await page.evaluate(() => calls), { ...before, read: before.read + 1 });
    await page.screenshot({ path: path.join(out, 'rechecked-result.png') });
    await page.locator('#kt-release-input').fill('');
    await page.locator('[data-release-action="request-rollback"]').click();
    await page.locator('[data-release-action="rollback"]').click();
    await page.locator('[data-release-action="new-task"]').click();
    await send('次の変更案を相談します');
    const currentTask = await page.evaluate(() => controller.getState()), beforeHistory = await page.evaluate(() => ({ ...calls }));
    await page.locator('[data-release-panel="runs"] > summary').click();
    await page.locator('[data-release-action="history"]').click();
    await page.locator('[data-release-action="recheck-rollback"]').click();
    assert.equal(await page.locator('.ktr-phase').innerText(), '過去の反映記録');
    assert.equal(await page.evaluate(() => controller.getState().phase), 'proposal');
    assert.deepEqual(await page.evaluate(() => controller.getState().proposal), currentTask.proposal);
    assert.deepEqual(await page.evaluate(() => calls), { ...beforeHistory, rollbackRead: beforeHistory.rollbackRead + 1 });
    await page.locator('[data-release-action="current"]').click();
    assert.equal(await page.locator('[data-release-action="adopt"]').isVisible(), true);
    await page.evaluate(() => { window.unverified = true; });
    await send('備考の編集制御を作ってください');
    await page.locator('[data-release-action="adopt"]').click();
    await page.waitForFunction(() => controller.getState().phase === 'incomplete');
    assert.equal(await page.getByRole('heading', { name: '検証できない内容があります', exact: true }).isVisible(), true);
    assert.equal(await page.locator('[data-release-action="resume"]').count(), 0);
    assert.equal(await page.locator('[data-release-action="apply"]').count(), 0);
    await page.locator('[data-release-purpose]').selectOption('document');
    await send('今の作業を資料にまとめて');
    await page.waitForFunction(() => controller.getState().explanations.length === 1);
    await page.locator('[data-release-action="show-changes"]').click();
    assert.equal(await page.locator('[data-release-purpose]').inputValue(), 'document');
    const stopped = await page.evaluate(() => ({ ...calls }));
    await page.locator('#kt-release-input').fill('対象を変えたいです');
    await page.locator('[data-release-action="focus-consultation"]').click();
    assert.equal(await page.locator('#kt-release-input').evaluate(el => el === document.activeElement), true);
    assert.equal(await page.locator('#kt-release-input').inputValue(), '対象を変えたいです');
    assert.equal(await page.locator('[data-release-purpose]').inputValue(), 'consultation');
    assert.deepEqual(await page.evaluate(() => calls), stopped);
    await page.screenshot({ path: path.join(out, 'unverified-consultation.png') });
    await page.locator('[data-release-action="send"]').click();
    await page.waitForFunction(() => controller.getState().phase === 'proposal');
    assert.equal(await page.evaluate(() => purposes.at(-1)), 'consultation');
    assert.deepEqual(errors, []); assert.deepEqual(network, []);
  } finally { await browser.close(); }
});
