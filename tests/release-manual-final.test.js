'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { KTReleaseView } = require('../src/release-view.js');

const adopted = {
  behaviors: [{ id: 'B1', text: '商品ごとの受注履歴を確認する' }],
  approach: { standard: ['表示列に作成日時を追加し、作成日時の降順にする。'] }
};
const manual = { actionType: 'REQUIRE_CONFIRMATION', title: '受注履歴の設定', proposal: { details: ['管理者がフォームで変更する。'] } };
function render(phase, steps, changes = []) {
  return KTReleaseView.render({ phase, plan: { steps }, adopted, prepared: { ok: true, changes }, artifacts: [], runs: [], messages: [] });
}
test('retains the manual step and the accepted values without offering a write', () => {
  const html = render('unchanged', [manual]);
  assert.match(html, /手動での設定・確認が残っています/);
  assert.match(html, /管理者がフォームで変更する/);
  assert.match(html, /表示列に作成日時を追加し、作成日時の降順/);
  assert.doesNotMatch(html, /現在の内容で実現しています|data-release-action="apply"/);
});
test('keeps manual instructions alongside automatic changes', () => {
  const html = render('review', [manual], [{ kind: 'setting', title: '備考欄を追加する' }]);
  assert.match(html, /管理者がフォームで変更する/);
  assert.match(html, /表示列に作成日時を追加し、作成日時の降順/);
  assert.match(html, /data-release-action="apply"/);
});
test('does not imply completion when a plan omitted the adopted change', () => {
  const html = render('unchanged', []);
  assert.match(html, /自動で反映する変更はありません/);
  assert.match(html, /表示列に作成日時を追加し、作成日時の降順/);
  assert.doesNotMatch(html, /現在の内容で実現しています|手動での設定・確認が残っています/);
});
