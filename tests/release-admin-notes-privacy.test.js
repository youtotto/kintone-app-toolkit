'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { loadToolkit } = require('./helpers/load-toolkit.js');
const { makeEnvGetter } = require('./helpers/dev-base-fake.js');
const { KTReleaseContext: C } = require('../src/release-context.js');
const { KTReleaseEnvironmentDiff: D } = require('../src/release-environment-diff.js');
const { KTReleaseEnvironmentView: V } = require('../src/release-environment-view.js');
const { KTReleaseSettingsExport: E } = require('../src/release-settings-export.js');
const privateBefore = 'PRIVATE_ADMIN_NOTE_BEFORE', privateAfter = 'PRIVATE_ADMIN_NOTE_AFTER';
async function base() {
  const common = { fields: { adminNotes: { code: 'adminNotes', label: '通常の項目', type: 'SINGLE_LINE_TEXT' } }, settings: { name: '説明用', description: 'アプリの公開説明' } };
  const b = await loadToolkit().KTDevBase.loadForRelease({ appId: '398', ...makeEnvGetter({
    production: { ...common, adminNotes: { content: privateBefore, includeInTemplateAndDuplicates: false } },
    preview: { ...common, adminNotes: { content: privateAfter, includeInTemplateAndDuplicates: false } }
  }) });
  // Also protect the typed boundary if dataFrom starts carrying this setting later.
  b.data.adminNotes = { content: privateAfter, includeInTemplateAndDuplicates: false };
  return b;
}
function noPrivate(ctx) {
  assert.doesNotMatch(JSON.stringify(ctx), /PRIVATE_ADMIN_NOTE/);
}
test('資料・相談・計画は管理者メモを除外し、説明と同名の通常フィールドは残す', async () => {
  const b = await base();
  for (const requestPurpose of ['document', 'consultation']) {
    const ctx = C.proposal({ text: 'アプリを説明して', requestPurpose, base: b });
    noPrivate(ctx);
    assert.equal(ctx.facts.find(f => f.kind === 'settings').value.description, 'アプリの公開説明');
    assert.ok(ctx.facts.some(f => f.kind === 'field' && f.field.code === 'adminNotes'));
    assert.equal(ctx.coverage.adminNotes, false);
  }
  noPrivate(C.plan({ goal: '項目を見直す', base: b }));
  assert.equal(b.data.adminNotes.content, privateAfter);
});
test('差分のAI説明に管理者メモの本文・変更値を含めず、除外した範囲を知らせる', async () => {
  const b = await base(), diff = D.compare(b);
  assert.ok(diff.entries.some(e => e.categoryId === 'notes'));
  const ctx = C.proposal({ text: '差分を説明して', requestPurpose: 'document', base: b,
    environmentComparison: { key: V.keyOf(diff) } });
  noPrivate(ctx);
  assert.ok(!ctx.facts.some(f => f.kind === 'env-diff' && f.value.categoryId === 'notes'));
  const notes = ctx.facts.find(f => f.kind === 'env-diff-coverage').value.categories.find(c => c.id === 'notes');
  assert.equal(notes.status, 'excluded');
  assert.match(notes.warnings.join(''), /AI.*送信しません/);
  assert.equal(ctx.coverage.adminNotes, false);
});
test('Config Lensのローカル比較と両環境の設定保存にはメモを残す', async () => {
  const b = await base(), diff = D.compare(b);
  assert.match(JSON.stringify(diff.entries.filter(e => e.categoryId === 'notes')), /PRIVATE_ADMIN_NOTE_BEFORE/);
  assert.match(JSON.stringify(diff.entries.filter(e => e.categoryId === 'notes')), /PRIVATE_ADMIN_NOTE_AFTER/);
  for (const [environment, expected] of [['production', privateBefore], ['preview', privateAfter]]) {
    const saved = E.create(b, { environment, domain: 'example.cybozu.com', savedAt: '2026-10-29T00:00:00Z', appId: '398' });
    assert.ok(JSON.stringify(saved).includes(expected));
  }
});
