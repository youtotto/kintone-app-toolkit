'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { loadToolkit } = require('./helpers/load-toolkit.js');
const { makeKintoneMock } = require('./helpers/kintone-preview-mock.js');

const toolkit = loadToolkit();
const { KTPlanExecutor, KTJsExecutor, KTScan } = toolkit;
const { KTReleaseExecution } = process.env.KT_EXECUTION_SRC ? require(process.env.KT_EXECUTION_SRC) : toolkit;
const hash = async value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const name = 'before.js';
const registeredKey = 'test-registered-key';
const priorSource = '// 変更前の動作\r\nconst saved = "🐱";\r\n';
const nextSource = '// 変更後の動作\nconst saved = "after";\n';
const copy = value => JSON.parse(JSON.stringify(value));
const writes = m => m.calls.filter(call => !call.startsWith('GET'));
const externalUrl = 'https://fixture.invalid/script.js?token=not-for-history';

async function setup({ fileBytes = Buffer.byteLength(priorSource) } = {}) {
  const oldRegistration = { type: 'FILE', file: { name, fileKey: registeredKey, size: String(fileBytes) } };
  const mock = makeKintoneMock({
    fields: {}, views: { views: {} },
    customize: {
      scope: 'ADMIN',
      desktop: { js: [{ type: 'URL', url: externalUrl }, oldRegistration], css: [{ type: 'FILE', file: { name: 'fixture.css', fileKey: 'test-css-key' } }] },
      mobile: { js: [], css: [] },
    }
  }, { jsSources: [{ name, target: 'desktop', text: priorSource }] });
  const loadBase = async () => ({ ok: true, current: await mock.current() });
  const service = KTReleaseExecution.create({ appId: '310', api: mock.api, loadBase,
    currentOf: base => base.current, planExecutor: KTPlanExecutor, jsExecutor: KTJsExecutor, hash });
  const plan = { steps: [{ id: 'C1', actionType: 'CUSTOMIZATION_REQUIRED', spec: { customizationId: 'C1' }, dependsOn: [] }],
    proposedFields: [], customizations: [{ customizationId: 'C1' }] };
  const operation = { action: 'replace', targetPlatform: 'desktop', targetFile: name, contentHash: await hash(nextSource),
    baseHash: KTScan.hashText(priorSource), targetExistingFileId: registeredKey };
  const generated = { strategy: 'EXTEND_EXISTING_JS', body: nextSource };
  const artifacts = [{
    customizationId: 'C1', title: 'JSの変更',
    result: { generated, artifactOutcome: { state: 'ready', operations: [operation] } },
  }];
  const prepared = await service.prepare({ plan, artifacts, base: await loadBase() });
  assert.equal(prepared.ok, true, JSON.stringify(prepared.reasons));
  const result = await service.apply({ prepared });
  assert.equal(result.status, 'complete', JSON.stringify(result.reasons));
  return { mock, service, prepared, result };
}

function archived({ prepared, result, historyRollback }) {
  return { archived: true, status: 'complete', prepared: { changes: copy(prepared.changes) }, result: { status: result.status, written: result.written }, historyRollback: copy(historyRollback) };
}

test('履歴に他の登録情報を残さず、日本語・補助文字・改行を含む元のバイトを復元する', async () => {
  const f = await setup();
  const historyRollback = await f.service.captureHistoryRollback(f.prepared, f.result);
  assert.ok(historyRollback);
  const record = JSON.stringify(historyRollback);
  for (const secret of [registeredKey, externalUrl, 'test-css-key', nextSource]) assert.equal(record.includes(secret), false);
  const run = archived({ ...f, historyRollback });
  const rb = await f.service.prepareRollback(run);
  assert.equal(rb.ok, true, JSON.stringify(rb.reasons));
  const restored = await f.service.rollback({ run, prepared: rb });
  assert.equal(restored.status, 'complete', JSON.stringify(restored.reasons || restored.files?.message));
  assert.equal(f.mock.st.customize.scope, 'ADMIN');
  const current = await f.mock.api.getPreviewCustomize('310');
  assert.equal(current.desktop.css[0].file.fileKey, 'test-css-key');
  assert.equal(current.desktop.js[0].url, externalUrl);
  assert.equal(current.mobile.js.length, 0);
  assert.equal(current.desktop.js[1].file.name, name);
  const restoredSource = await f.mock.api.downloadFile(current.desktop.js[1].file.fileKey);
  assert.deepEqual(Buffer.from(restoredSource, 'utf8'), Buffer.from(priorSource, 'utf8'));
  assert.deepEqual(writes(f.mock), ['POST file', 'PUT customize', 'POST file', 'PUT customize']);
});

test('別のJS登録が確認後に変わった場合は元に戻さない', async () => {
  const f = await setup();
  const historyRollback = await f.service.captureHistoryRollback(f.prepared, f.result);
  assert.ok(historyRollback);
  const run = archived({ ...f, historyRollback });
  const rb = await f.service.prepareRollback(run);
  assert.equal(rb.ok, true, JSON.stringify(rb.reasons));
  f.mock.st.customize.mobile.js.push({ type: 'URL', url: 'https://fixture.invalid/another.js' });
  f.mock.st.revision++;
  const restored = await f.service.rollback({ run, prepared: rb });
  assert.notEqual(restored.status, 'complete');
  assert.deepEqual(writes(f.mock), ['POST file', 'PUT customize']);
});

test('登録前の文字列と元ファイルのバイト数が違えば、履歴からの復元情報を作らない', async () => {
  const f = await setup({ fileBytes: Buffer.byteLength(priorSource) + 3 });
  assert.equal(await f.service.captureHistoryRollback(f.prepared, f.result), null);
});
