'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { KTReleaseCustomize: C } = require('../src/release-customize.js');
const clone = value => JSON.parse(JSON.stringify(value));
const file = (name, key) => ({ type: 'FILE', file: { name, fileKey: key } });
const url = value => ({ type: 'URL', url: value });
const documentOf = extra => ({ name: 'lock.js', fileKey: 'pc-lock', target: 'desktop', kind: 'js', environment: 'preview', registeredText: 'before', ...extra });
function fixture() {
  let settings = { revision: '10', scope: 'ADMIN',
    desktop: { js: [url('https://example.test/first.js'), file('lock.js', 'pc-lock'), file('last.js', 'pc-last')], css: [file('theme.css', 'pc-css')] },
    mobile: { js: [file('lock.js', 'mobile-lock')], css: [url('https://example.test/mobile.css')] } };
  const bodies = new Map([['pc-lock', 'before'], ['pc-last', 'last'], ['pc-css', 'theme'], ['mobile-lock', 'mobile']]);
  const uploads = new Map(), events = [], changes = [];
  const api = {
    async getCustomize(app, options) { events.push(['get', app, options]); return { source: 'preview', data: clone(settings) }; },
    async uploadFile(name, content, mime) { events.push(['upload', name, content, mime]); const key = 'upload-' + uploads.size; uploads.set(key, { name, content }); return key; },
    async putPreviewCustomize(app, payload) {
      events.push(['put', app, clone(payload)]);
      assert.equal(payload.revision, settings.revision);
      const result = clone(payload); delete result.app;
      for (const target of ['desktop', 'mobile']) for (const kind of ['js', 'css']) result[target][kind] = payload[target][kind].map(entry => {
        if (entry.type === 'URL') return clone(entry);
        const upload = uploads.get(entry.file.fileKey);
        if (upload) { const readKey = 'download-' + entry.file.fileKey; bodies.set(readKey, upload.content); return file(upload.name, readKey); }
        const current = settings[target][kind].find(item => item.file?.fileKey === entry.file.fileKey);
        assert.ok(current, 'untouched entries retain their registered key'); return clone(current);
      });
      result.revision = String(Number(settings.revision) + 1); settings = result;
      return { revision: settings.revision };
    },
    async downloadFile(key) { events.push(['download', key]); return bodies.get(key); },
    async deploy(app, options) { events.push(['deploy', app, clone(options)]); },
    async waitDeploy(app) { events.push(['wait', app]); return 'SUCCESS'; }
  };
  const controller = C.createManualRegistration({ appId: '398', api, onChanged: change => changes.push(change) });
  return { api, controller, events, changes, bodies, get settings() { return settings; } };
}
const writes = f => f.events.filter(event => ['upload', 'put', 'deploy'].includes(event[0]));
const code = expected => error => error.code === expected;

test('登録の確認は読み取りだけ。確認した本文・位置と4一覧を保ち、読み戻し後だけ成功する', async () => {
  const f = fixture(), doc = documentOf(), original = clone(f.settings);
  const content = ' \r\nconst memo = "備考";\r\n ';
  const prepared = await f.controller.prepareRegistration({ document: doc, content });
  assert.equal(prepared.position, 1); assert.deepEqual(writes(f), []); assert.deepEqual(f.changes, []);
  doc.name = 'changed-after-confirm.js'; doc.registeredText = 'modified';
  const result = await f.controller.register(prepared);
  assert.equal(result.kind, 'registered'); assert.equal(result.document.name, 'lock.js');
  assert.equal(result.document.registeredText, content); assert.equal(result.document.fileKey, 'download-upload-0');
  assert.equal(f.events.find(event => event[0] === 'upload')[2], content);
  assert.deepEqual(f.settings.desktop.js.map(item => item.file?.name || item.url), original.desktop.js.map(item => item.file?.name || item.url));
  assert.deepEqual(f.settings.desktop.css, original.desktop.css); assert.deepEqual(f.settings.mobile, original.mobile);
  assert.equal(f.settings.scope, 'ADMIN'); assert.equal(f.events.find(event => event[0] === 'put')[2].revision, '10');
  assert.equal(f.events.some(event => event[0] === 'deploy'), false);
  assert.deepEqual(f.changes, Array(2).fill({ preview: true, production: false, what: 'customize' }));
  await assert.rejects(f.controller.register(prepared), code('NOT_PREPARED'));
});

test('新しいCSSは選んだ一覧の末尾だけに追加し、既存の同名ファイルを上書きしない', async () => {
  const f = fixture(), original = clone(f.settings);
  const prepared = await f.controller.prepareRegistration({ document: documentOf({ name: 'new.css', target: 'mobile', kind: 'css', isNew: true, fileKey: null }), content: '\n/* keep */\n' });
  const result = await f.controller.register(prepared);
  assert.equal(result.document.kind, 'css'); assert.equal(f.events.find(event => event[0] === 'upload')[3], 'text/css');
  assert.deepEqual(f.settings.desktop, original.desktop); assert.deepEqual(f.settings.mobile.js, original.mobile.js);
  assert.deepEqual(f.settings.mobile.css[0], original.mobile.css[0]); assert.equal(f.settings.mobile.css[1].file.name, 'new.css');
  const before = writes(f).length;
  await assert.rejects(f.controller.prepareRegistration({ document: documentOf({ name: 'new.css', target: 'mobile', kind: 'css', isNew: true }), content: 'other' }), code('STALE_DOCUMENT'));
  assert.equal(writes(f).length, before);
});

test('既存ファイルの差し替え・削除・同名重複と運用環境からの入力を登録前に止める', async () => {
  for (const mutate of [
    f => { f.settings.desktop.js[1].file.fileKey = 'external'; },
    f => { f.settings.desktop.js.splice(1, 1); },
    f => { f.settings.desktop.js.push(file('lock.js', 'duplicate')); }
  ]) {
    const f = fixture(); mutate(f);
    await assert.rejects(f.controller.prepareRegistration({ document: documentOf(), content: 'next' }), code('STALE_DOCUMENT'));
    assert.deepEqual(writes(f), []);
  }
  const f = fixture();
  await assert.rejects(f.controller.prepareRegistration({ document: documentOf({ environment: 'production' }), content: 'next' }), code('INVALID_DOCUMENT'));
  assert.deepEqual(f.events, []);
});

test('動作テスト環境を取得できない場合に運用環境の設定を代用しない', async () => {
  const f = fixture();
  f.api.getCustomize = async () => ({ source: 'production', data: f.settings });
  await assert.rejects(f.controller.prepareRegistration({ document: documentOf(), content: 'next' }), code('PREVIEW_UNAVAILABLE'));
  await assert.rejects(f.controller.prepareDeploy(), code('PREVIEW_UNAVAILABLE'));
  assert.deepEqual(writes(f), []);
});

test('一覧や版の欠落した応答では確認を作らない', async () => {
  for (const mutate of [f => { delete f.settings.mobile.css; }, f => { delete f.settings.revision; }, f => { f.settings.desktop.js[1] = { type: 'FILE', file: { name: 'lock.js' } }; }]) {
    const f = fixture(); mutate(f);
    await assert.rejects(f.controller.prepareDeploy(), code('INVALID_SETTINGS'));
    assert.deepEqual(writes(f), []);
  }
});

test('確認後の設定変更と同じ版での一覧の変化も書き込み前に止める', async () => {
  for (const mutate of [f => { f.settings.revision = '11'; }, f => { f.settings.mobile.css.push(url('https://example.test/added.css')); }]) {
    const f = fixture(), prepared = await f.controller.prepareRegistration({ document: documentOf(), content: 'next' });
    mutate(f);
    await assert.rejects(f.controller.register(prepared), error => error.code === 'STALE_SETTINGS' && error.writeAttempted === false);
    assert.deepEqual(writes(f), []); assert.deepEqual(f.changes, []);
  }
});

test('空のアップロード結果・PUT失敗は成功にせず、再使用を止めて取得済み状態を失効する', async () => {
  for (const phase of ['upload', 'put']) {
    const f = fixture(), prepared = await f.controller.prepareRegistration({ document: documentOf(), content: '' });
    if (phase === 'upload') f.api.uploadFile = async () => '';
    else f.api.putPreviewCustomize = async () => { throw new Error('PUT timeout'); };
    await assert.rejects(f.controller.register(prepared), error => error.writeAttempted === true);
    assert.ok(f.changes.length); assert.equal(f.events.some(event => event[0] === 'deploy'), false);
    await assert.rejects(f.controller.register(prepared), code('NOT_PREPARED'));
  }
});

test('登録後の位置・本文・無関係な設定の不一致と再取得失敗を成功にしない', async () => {
  for (const corrupt of [
    f => { f.settings.desktop.js.reverse(); },
    f => { f.bodies.set('download-upload-0', 'wrong'); },
    f => { f.settings.mobile.css = []; },
    f => { f.settings.scope = 'NONE'; },
    f => { f.api.getCustomize = async () => { throw new Error('read failed'); }; }
  ]) {
    const f = fixture(), prepared = await f.controller.prepareRegistration({ document: documentOf(), content: 'next' });
    const put = f.api.putPreviewCustomize;
    f.api.putPreviewCustomize = async (...args) => { const result = await put(...args); corrupt(f); return result; };
    await assert.rejects(f.controller.register(prepared), error => error.code === 'VERIFY_FAILED' && error.writeAttempted === true);
    assert.ok(f.changes.length);
  }
});

test('登録中の二重実行と運用反映を止める', async () => {
  const f = fixture(), registration = await f.controller.prepareRegistration({ document: documentOf(), content: 'next' });
  const deployment = await f.controller.prepareDeploy();
  let resume, started;
  const begun = new Promise(resolve => { started = resolve; }), upload = f.api.uploadFile;
  f.api.uploadFile = async (...args) => { started(); await new Promise(resolve => { resume = resolve; }); return upload(...args); };
  const running = f.controller.register(registration); await begun;
  await assert.rejects(f.controller.register(registration), code('BUSY'));
  await assert.rejects(f.controller.deploy(deployment), code('BUSY'));
  await assert.rejects(f.controller.prepareRegistration({ document: documentOf(), content: 'other' }), code('BUSY'));
  resume(); await running;
});

test('運用反映は別の確認に固定した版だけを反映し、完了確認まで待つ', async () => {
  const f = fixture(), prepared = await f.controller.prepareDeploy();
  assert.deepEqual(writes(f), []);
  const result = await f.controller.deploy(prepared);
  assert.equal(result.kind, 'deployed'); assert.equal(result.status, 'SUCCESS');
  assert.deepEqual(f.events.find(event => event[0] === 'deploy'), ['deploy', '398', { revision: '10' }]);
  assert.equal(f.events.at(-1)[0], 'wait');
  assert.deepEqual(f.changes, Array(2).fill({ preview: true, production: true, what: 'customize' }));
  await assert.rejects(f.controller.deploy(prepared), code('NOT_PREPARED'));
});

test('運用反映直前に版が変わったら反映しない。登録用確認は運用反映に使えない', async () => {
  const f = fixture(), prepared = await f.controller.prepareDeploy();
  f.settings.revision = '11';
  await assert.rejects(f.controller.deploy(prepared), code('STALE_SETTINGS'));
  const registration = await f.controller.prepareRegistration({ document: documentOf(), content: 'next' });
  await assert.rejects(f.controller.deploy(registration), code('NOT_PREPARED'));
  assert.deepEqual(writes(f), []);
});

test('反映受付の失敗・完了待ちの失敗・不明な状態を反映済みにしない', async () => {
  for (const phase of ['deploy', 'timeout', 'unknown']) {
    const f = fixture(), prepared = await f.controller.prepareDeploy();
    if (phase === 'deploy') f.api.deploy = async () => { throw new Error('deploy rejected'); };
    else if (phase === 'timeout') f.api.waitDeploy = async () => { throw new Error('Deploy timeout'); };
    else f.api.waitDeploy = async () => 'PROCESSING';
    await assert.rejects(f.controller.deploy(prepared), error => error.writeAttempted === true);
    assert.ok(f.changes.length);
  }
});


test('準備中に選択文書が変わっても呼出時点の文書を確認対象にする', async () => {
  const f = fixture(), doc = documentOf(), get = f.api.getCustomize;
  let resume;
  f.api.getCustomize = async (...args) => { await new Promise(resolve => { resume = resolve; }); return get(...args); };
  const pending = f.controller.prepareRegistration({ document: doc, content: 'next' });
  doc.name = 'different.js'; doc.fileKey = 'different'; resume();
  const prepared = await pending;
  assert.equal(prepared.name, 'lock.js'); assert.equal(prepared.position, 1);
});

test('アップロード中に別の変更が入ったら版を指定したPUTで拒否し、他の変更を保持する', async () => {
  const f = fixture(), prepared = await f.controller.prepareRegistration({ document: documentOf(), content: 'next' });
  const upload = f.api.uploadFile, put = f.api.putPreviewCustomize;
  let resume, started;
  const begun = new Promise(resolve => { started = resolve; });
  f.api.uploadFile = async (...args) => { started(); await new Promise(resolve => { resume = resolve; }); return upload(...args); };
  f.api.putPreviewCustomize = async (app, payload) => {
    if (payload.revision !== f.settings.revision) {
      f.events.push(['put-rejected', app, clone(payload)]);
      throw Object.assign(new Error('設定の版が一致しません。'), { code: 'GAIA_CO02' });
    }
    return put(app, payload);
  };
  const running = f.controller.register(prepared); await begun;
  f.settings.revision = '11';
  f.settings.mobile.css.push(url('https://example.test/concurrent.css'));
  const concurrent = clone(f.settings);
  resume();
  await assert.rejects(running, error => error.code === 'GAIA_CO02' && error.writeAttempted === true);
  assert.equal(f.events.find(event => event[0] === 'put-rejected')[2].revision, '10');
  assert.deepEqual(f.settings, concurrent);
  assert.equal(f.settings.desktop.js[1].file.fileKey, 'pc-lock');
  assert.equal(f.events.some(event => event[0] === 'deploy' || event[0] === 'download'), false);
  assert.ok(f.changes.length);
});

