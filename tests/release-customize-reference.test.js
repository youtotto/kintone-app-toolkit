'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { KTReleaseCustomize: { referenceInfoOf } } = require('../src/release-customize.js');
const documentOf = extra => ({ name: 'lock.js', target: 'desktop', kind: 'js', environment: 'preview', fileKey: 'registered-1', registeredText: 'registered body', text: 'unsaved edits', ...extra });
const match = extra => ({ file: 'lock.js', target: 'desktop', kind: 'js', line: 3, access: 'READ', confidence: 'HIGH', ...extra });
const scanOf = extra => ({
  meta: { appId: '398', source: 'preview', scannedAt: '2026-10-26T01:00:00Z' },
  files: [{ name: 'lock.js', target: 'desktop', kind: 'js', fileKey: 'registered-1' }],
  results: [
    { code: 'memo', label: '備考', type: 'SINGLE_LINE_TEXT', matches: [match({ access: 'CONTROL', line: 7 }), match({ line: 3 }), match({ target: 'mobile', line: 40 })] },
    { code: 'amount', label: '金額', matches: [match({ file: 'other.js' })] },
    { code: 'memo', label: '備考', matches: [match({ line: 3, confidence: 'LOW' })] }
  ],
  fileEvents: { 'desktop:js:lock.js': [{ name: 'app.record.edit.show', direct: true }, { name: 'app.record.create.show', direct: false }],
    'mobile:js:lock.js': [{ name: 'mobile.app.record.edit.show', direct: true }] },
  unknownRefs: [{ code: 'not_found', confidence: 'LOW', files: [{ name: 'desktop:lock.js', lines: [9] }, { name: 'mobile:lock.js', lines: [10] }] }],
  ...extra
});
const info = (document = documentOf(), scan = scanOf(), extra = {}) => referenceInfoOf({ appId: 398, document, scan, ...extra });

test('同じアプリ・環境・登録ファイルの既存解析だけを集め、確度とイベントの推定を保持する', () => {
  const document = documentOf(), scan = scanOf(), before = JSON.stringify({ document, scan });
  const result = info(document, scan);
  assert.equal(result.status, 'ready'); assert.equal(result.basis, 'registered');
  assert.equal(result.source, 'preview'); assert.equal(result.scannedAt, scan.meta.scannedAt);
  assert.deepEqual(result.fields, [{ code: 'memo', label: '備考', type: 'SINGLE_LINE_TEXT', access: ['CONTROL', 'READ'], lines: [3, 7], confidence: ['HIGH', 'LOW'] }]);
  assert.deepEqual(result.events, scan.fileEvents['desktop:js:lock.js']);
  assert.deepEqual(result.unknownRefs, [{ code: 'not_found', confidence: 'LOW', lines: [9] }]);
  assert.equal(JSON.stringify({ document, scan }), before);
  result.events[0].direct = false; result.fields[0].lines.push(999); result.unknownRefs[0].lines.push(999);
  assert.equal(JSON.stringify({ document, scan }), before, '表示用の値を変えても解析結果を変えない');
});

test('本文を省いたキャッシュも同じfileKeyなら使い、fileKeyの無い旧キャッシュは使わない', () => {
  assert.equal(info().status, 'ready');
  const cached = scanOf(); delete cached.files[0].fileKey;
  assert.equal(info(documentOf(), cached).status, 'unavailable');
  cached.files[0].text = 'registered body';
  assert.equal(info(documentOf(), cached).status, 'ready');
});

test('本文比較は取得時の登録本文だけに使い、編集中の本文が一致しても旧結果を使わない', () => {
  const old = scanOf(); old.files[0].fileKey = 'old-key'; old.files[0].text = 'unsaved edits';
  assert.equal(info(documentOf(), old).status, 'unavailable');
  old.files[0].text = 'registered body';
  assert.equal(info(documentOf(), old).status, 'ready');
  const noBase = documentOf(); delete noBase.registeredText;
  assert.equal(info(noBase, old).status, 'unavailable');
  old.files[0].text = 'registered body\n';
  assert.equal(info(documentOf(), old).status, 'unavailable', '本文を正規化して同一扱いにしない');
});

test('アプリ・環境の違い、取得元不明、古い印では参照やタイミングを出さない', () => {
  for (const meta of [{ appId: 999, source: 'preview' }, { appId: 398, source: 'production' }, { appId: 398 }, { source: 'preview' }]) {
    const result = info(documentOf(), scanOf({ meta }));
    assert.equal(result.status, 'unavailable'); assert.deepEqual(result.fields, []); assert.deepEqual(result.events, []);
  }
  assert.equal(info(documentOf(), scanOf(), { stale: true }).status, 'stale');
  assert.equal(info(documentOf({ environment: 'unknown' })).status, 'unavailable');
  assert.equal(info(documentOf({ environment: 'production' }), scanOf({ meta: { appId: 398, source: 'production' } })).status, 'ready');
});

test('同名PC・モバイルは分け、同じ画面に同名が複数ある解析はfileKeyが一致しても使わない', () => {
  const scan = scanOf(); scan.files.push({ name: 'lock.js', target: 'mobile', kind: 'js', fileKey: 'mobile-key' });
  const mobile = info(documentOf({ target: 'mobile', fileKey: 'mobile-key' }), scan);
  assert.equal(mobile.status, 'ready'); assert.deepEqual(mobile.fields[0].lines, [40]);
  assert.deepEqual(mobile.events, [{ name: 'mobile.app.record.edit.show', direct: true }]);
  assert.deepEqual(mobile.unknownRefs[0].lines, [10]);
  scan.files.push({ ...scan.files[0], fileKey: 'duplicate-key' });
  assert.equal(info(documentOf(), scan).status, 'unavailable');
});

test('未取得・失敗・URL・新規・CSSを既存JavaScriptの解析済みにしない', () => {
  assert.equal(info(documentOf(), null).status, 'unavailable');
  assert.equal(info(null).status, 'unavailable');
  assert.equal(info(documentOf({ isNew: true })).status, 'unavailable');
  assert.equal(info(documentOf({ fileKey: null })).status, 'unavailable');
  assert.equal(info(documentOf({ kind: 'css' })).status, 'unsupported');
  for (const extra of [{ note: 'download failed' }, { analyzed: false }, { type: 'URL' }, { url: 'https://example.invalid/lock.js' }]) {
    const scan = scanOf(); Object.assign(scan.files[0], extra);
    assert.equal(info(documentOf(), scan).status, 'unavailable');
  }
  for (const extra of [{ results: null }, { fileEvents: null }, { files: [] }, { fileEvents: { 'desktop:js:lock.js': 'incomplete' } }]) {
    assert.equal(info(documentOf(), scanOf(extra)).status, 'unavailable');
  }
});

test('解析結果が空である場合と未解析を区別し、空の結果に実行や参照を補わない', () => {
  const result = info(documentOf(), scanOf({ results: [], fileEvents: {}, unknownRefs: [] }));
  assert.equal(result.status, 'ready'); assert.deepEqual(result.fields, []); assert.deepEqual(result.events, []);
});
