'use strict';
// Real IndexedDB in an offline browser: no AI, kintone, or server write occurs.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { KTReleaseHistory: H } = require('../src/release-history.js');
const source = fs.readFileSync(path.join(__dirname, '../src/release-history.js'), 'utf8');
const scope = { domain: 'tenant.cybozu.com', appId: '310', userId: 'user-a', environment: 'production' };

test('履歴は厳密なスコープと有限の保存条件を要求する', () => {
  for (const bad of [{}, { ...scope, userId: '' }, { ...scope, environment: null }]) assert.throws(() => H.create({ scope: bad }), { code: 'HISTORY_INVALID' });
  assert.throws(() => H.create({ scope, maxBytes: Infinity }), { code: 'HISTORY_INVALID' });
  assert.equal(H.DEFAULT_MAX_BYTES, 20 * 1024 * 1024);
});

test('実際の IndexedDB で履歴・失敗時の保持・容量を検証する', { timeout: 120000 }, async t => {
  let pw; try { pw = require(process.env.PLAYWRIGHT_MODULE || 'playwright'); } catch { pw = require(path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
  const browser = await pw.chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
  const unexpected = [], errors = [];
  try {
    const context = await browser.newContext();
    await context.route('**/*', route => {
      if (route.request().url() === 'https://history.test.invalid/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>履歴の確認</title>' });
      unexpected.push(route.request().url()); return route.abort();
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto('https://history.test.invalid/');
    await page.addScriptTag({ content: source + '\nglobalThis.H = KTReleaseHistory;' });
    await page.evaluate(scope => {
      window.scope = scope; window.stores = []; window.clock = 1800000000000;
      window.make = (dbName, options = {}) => { const store = H.create({ dbName, scope, now: () => clock, ...options }); stores.push(store); return store; };
      window.item = (id, payload = { messages: [{ text: '会話' }] }) => ({ id, revision: null, title: '履歴 ' + id, payload, completedAt: null, pinned: false });
      window.codeOf = promise => promise.then(() => null, error => error.code);
      window.records = async name => {
        const db = await new Promise((resolve, reject) => { const r = indexedDB.open(name, 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
        try { return await new Promise((resolve, reject) => { const tx = db.transaction(['entries', 'payloads']); const out = {}; for (const key of ['entries', 'payloads']) { const r = tx.objectStore(key).getAll(); r.onsuccess = () => { out[key] = r.result; }; } tx.oncomplete = () => resolve(out); tx.onerror = () => reject(tx.error); }); } finally { db.close(); }
      };
    }, scope);

    await t.test('一覧はメタデータのみ、選択時だけ本文を読み、再接続後も復元する', async () => {
      const result = await page.evaluate(async () => {
        const store = make('history-list');
        const code = '/* 保存する長いコード */\n' + 'const value = 1;\n'.repeat(200);
        const payload = { messages: [{ text: '会話', code }, { code }], artifacts: [{ code }], tuple: [0, 1], special: JSON.parse('{"__proto__":{"safe":true}}') };
        const saved = await store.save(item('one', payload));
        const reads = [], originalGet = IDBObjectStore.prototype.get, originalGetAll = IDBObjectStore.prototype.getAll;
        IDBObjectStore.prototype.get = function (...args) { reads.push(this.name); return originalGet.apply(this, args); };
        IDBObjectStore.prototype.getAll = function (...args) { reads.push(this.name); return originalGetAll.apply(this, args); };
        let list; try { list = await store.list(); } finally { IDBObjectStore.prototype.get = originalGet; IDBObjectStore.prototype.getAll = originalGetAll; }
        store.close(); const again = make('history-list'); const loaded = await again.load('one'); const disk = await records('history-list');
        return { saved, list, reads, matches: JSON.stringify(loaded.payload) === JSON.stringify(payload), dictionary: disk.payloads[0].body.strings.length, scope: disk.entries[0].scope, usage: await again.usage(), metadataKeys: Object.keys(list[0]).sort(), prototypeSafe: !({}).safe };
      });
      assert.equal(result.saved.revision, 1); assert.equal(result.matches, true); assert.equal(result.dictionary, 1);
      assert.deepEqual(result.reads, []); assert.equal(result.prototypeSafe, true);
      assert.deepEqual(result.metadataKeys, ['bytes', 'completedAt', 'expiresAt', 'id', 'pinned', 'revision', 'title', 'updatedAt'].sort());
      assert.equal(result.usage.bytes, result.saved.bytes); assert.equal(result.usage.count, 1); assert.equal(result.usage.maxBytes, 20 * 1024 * 1024);
    });

    await t.test('完了から30日・閲覧不延長・作業中と固定の保護・再開・固定解除', async () => {
      const result = await page.evaluate(async () => {
        clock = 1800000000000; const start = clock, store = make('history-expiry');
        let done = await store.save({ ...item('done'), completedAt: clock });
        await store.save(item('working')); let pinned = await store.save({ ...item('pinned'), completedAt: clock, pinned: true });
        clock += H.TTL - 1; const viewed = await store.load('done');
        done = await store.save({ ...item('done'), revision: done.revision, completedAt: start, title: '題名だけ変更' });
        clock++; const afterBoundary = await store.list(); const diskAfter = await records('history-expiry');
        clock += 100 * H.TTL;
        pinned = await store.save({ ...item('pinned'), revision: pinned.revision, completedAt: start, pinned: false });
        const deadline = clock + H.TTL, unpinnedExpiry = pinned.expiresAt;
        clock += H.TTL - 1; const beforeUnpinExpiry = await store.load('pinned');
        pinned = await store.save({ ...item('pinned'), revision: pinned.revision, completedAt: null });
        clock = deadline + H.TTL; const afterReopen = await store.list();
        return { viewedExpiry: viewed.expiresAt, editedExpiry: done.expiresAt, expected: start + H.TTL, afterBoundary: afterBoundary.map(x => x.id), diskEntries: diskAfter.entries.map(x => x.id), diskPayloads: diskAfter.payloads.length, unpinnedExpiry, deadline, beforeUnpinExpiry: !!beforeUnpinExpiry, reopened: pinned, afterReopen: afterReopen.map(x => x.id) };
      });
      assert.equal(result.viewedExpiry, result.expected); assert.equal(result.editedExpiry, result.expected);
      assert.deepEqual(result.afterBoundary.sort(), ['pinned', 'working']); assert.deepEqual(result.diskEntries.sort(), ['pinned', 'working']); assert.equal(result.diskPayloads, 2);
      assert.equal(result.unpinnedExpiry, result.deadline); assert.equal(result.beforeUnpinExpiry, true); assert.equal(result.reopened.completedAt, null); assert.equal(result.reopened.expiresAt, null);
      assert.deepEqual(result.afterReopen.sort(), ['pinned', 'working']);
    });

    await t.test('全scopeを分離し、同じdomainとuserの全app/envだけ容量を共有する', async () => {
      const result = await page.evaluate(async () => {
        clock = 1800000000000;
        const a = make('history-scope'), b = make('history-scope', { scope: { ...scope, appId: '311' } }), env = make('history-scope', { scope: { ...scope, environment: 'preview' } });
        const user = make('history-scope', { scope: { ...scope, userId: 'user-b' } }), domain = make('history-scope', { scope: { ...scope, domain: 'other.cybozu.com' } });
        const saved = await a.save(item('private-a')); await b.save(item('private-b')); await env.save(item('private-env')); await user.save(item('private-user')); await domain.save(item('private-domain'));
        const isolated = await Promise.all([b.load('private-a'), env.load('private-a'), user.load('private-a'), domain.load('private-a')]);
        const deniedDelete = await b.remove('private-a', saved.revision), counts = await Promise.all([a, b, env, user, domain].map(s => s.usage().then(u => u.count)));
        await b.save({ ...item('expired-other-app'), completedAt: clock });
        await user.save({ ...item('expired-other-user'), completedAt: clock });
        clock += H.TTL; await a.prune(); const beforeSave = await records('history-scope');
        await a.save(item('new')); const afterSave = await records('history-scope');
        return { isolated, deniedDelete, counts, listA: (await a.list()).map(x => x.id), beforeSave: beforeSave.entries.map(x => x.id), afterSave: afterSave.entries.map(x => x.id) };
      });
      assert.deepEqual(result.isolated, [null, null, null, null]); assert.equal(result.deniedDelete, false); assert.deepEqual(result.counts, [3, 3, 3, 1, 1]);
      assert.deepEqual(result.listA.sort(), ['new', 'private-a']); assert.ok(result.beforeSave.includes('expired-other-app'));
      assert.ok(!result.afterSave.includes('expired-other-app')); assert.ok(result.afterSave.includes('expired-other-user'));
    });

    await t.test('独立した2接続の同時更新は一方だけ成功し、古い削除や新規保存で上書きしない', async () => {
      const result = await page.evaluate(async () => {
        const a = make('history-cas'), b = make('history-cas'); const first = await a.save(item('one'));
        const outcomes = await Promise.allSettled([a.save({ ...item('one', { winner: 'a' }), revision: first.revision }), b.save({ ...item('one', { winner: 'b' }), revision: first.revision })]);
        const latest = await a.load('one');
        return { outcomes: outcomes.map(x => ({ status: x.status, code: x.reason?.code, revision: x.value?.revision })), latest, staleDelete: await codeOf(a.remove('one', 1)), staleNew: await codeOf(a.save(item('one'))), stillThere: await a.load('one') };
      });
      assert.equal(result.outcomes.filter(x => x.status === 'fulfilled').length, 1); assert.equal(result.outcomes.find(x => x.status === 'rejected').code, 'HISTORY_CONFLICT');
      assert.equal(result.latest.revision, 2); assert.equal(result.staleDelete, 'HISTORY_CONFLICT'); assert.equal(result.staleNew, 'HISTORY_CONFLICT'); assert.deepEqual(result.latest, result.stillThere);
    });

    await t.test('削除再作成後の古いrevisionと非同期待ち中のinput変更を防ぐ', async () => {
      const result = await page.evaluate(async () => {
        const store = make('history-recreate'); const first = await store.save(item('one'));
        await store.remove('one', first.revision); const recreated = await store.save(item('one', { text: '再作成' }));
        const staleWrite = await codeOf(store.save({ ...item('one', { text: '古い画面からの保存' }), revision: first.revision }));
        const staleDelete = await codeOf(store.remove('one', first.revision));
        const input = item('snapshot', { text: '開始時点' }); const saving = store.save(input);
        input.id = 'changed'; input.title = '変更後'; input.payload.text = '変更後'; input.pinned = true;
        const saved = await saving;
        return { first, recreated, staleWrite, staleDelete, saved, loaded: await store.load('snapshot'), changed: await store.load('changed') };
      });
      assert.ok(result.recreated.revision > result.first.revision); assert.equal(result.staleWrite, 'HISTORY_CONFLICT'); assert.equal(result.staleDelete, 'HISTORY_CONFLICT');
      assert.equal(result.saved.id, 'snapshot'); assert.equal(result.saved.title, '履歴 snapshot'); assert.equal(result.saved.pinned, false); assert.deepEqual(result.loaded.payload, { text: '開始時点' }); assert.equal(result.changed, null);
    });
    await t.test('容量超過・ネイティブquota例外・非同期abortでも本文とメタデータを共に戻す', async () => {
      const result = await page.evaluate(async () => {
        clock = 1800000000000; const store = make('history-failure', { maxBytes: 6000 });
        const first = await store.save(item('one', { text: '前回保存' }));
        const over = await codeOf(store.save({ ...item('one', { text: 'x'.repeat(10000) }), revision: 1 }));
        const afterLimit = await store.load('one');
        const original = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (...args) { if (this.name === 'payloads') throw new DOMException('quota test', 'QuotaExceededError'); return original.apply(this, args); };
        let quota; try { quota = await codeOf(store.save({ ...item('one', { text: 'quota後' }), revision: 1 })); } finally { IDBObjectStore.prototype.put = original; }
        const afterQuota = await store.load('one');
        IDBObjectStore.prototype.put = function (...args) { const req = original.apply(this, args); if (this.name === 'payloads') req.addEventListener('success', () => this.transaction.abort()); return req; };
        let abort; try { abort = await codeOf(store.save({ ...item('one', { text: 'abort後' }), revision: 1 })); } finally { IDBObjectStore.prototype.put = original; }
        const afterAbort = await store.load('one');
        await store.save({ ...item('old'), completedAt: clock }); clock += H.TTL;
        const overWithPrune = await codeOf(store.save(item('huge', { text: 'x'.repeat(10000) })));
        const disk = await records('history-failure');
        return { first, over, quota, abort, afterLimit, afterQuota, afterAbort, overWithPrune, ids: disk.entries.map(x => x.id), payloadCount: disk.payloads.length };
      });
      assert.equal(result.over, 'HISTORY_LIMIT'); assert.equal(result.quota, 'HISTORY_LIMIT'); assert.equal(result.abort, 'HISTORY_SAVE_FAILED');
      for (const loaded of [result.afterLimit, result.afterQuota, result.afterAbort]) { assert.equal(loaded.revision, 1); assert.deepEqual(loaded.payload, { text: '前回保存' }); assert.equal(loaded.bytes, result.first.bytes); }
      assert.equal(result.overWithPrune, 'HISTORY_LIMIT'); assert.deepEqual(result.ids.sort(), ['old', 'one']); assert.equal(result.payloadCount, 2);
    });

    await t.test('無効なJSONや深い構造は拒否し、フィールドコードは解釈しない', async () => {
      const result = await page.evaluate(async () => {
        const store = make('history-validation'), circular = {}; circular.self = circular;
        let deep = {}; for (let i = 0; i < 70; i++) deep = { next: deep };
        let getterCalls = 0; const getter = {}; Object.defineProperty(getter, 'value', { get() { getterCalls++; return 'should not run'; }, enumerable: true });
        const payloads = [circular, deep, { x: undefined }, { x: NaN }, { fn() {} }, getter, new Date(), [,,]];
        const codes = []; for (let i = 0; i < payloads.length; i++) codes.push(await codeOf(store.save(item(String(i), payloads[i]))));
        const fields = { fields: { password: { code: 'password', type: 'SINGLE_LINE_TEXT' }, accessToken: { code: 'accessToken', label: 'フィールド名' }, API_KEY: { code: 'API_KEY' } } };
        await store.save(item('field-codes', fields));
        return { codes, getterCalls, count: (await store.usage()).count, restored: JSON.stringify((await store.load('field-codes')).payload) === JSON.stringify(fields) };
      });
      assert.deepEqual(result.codes, Array(8).fill('HISTORY_INVALID')); assert.equal(result.getterCalls, 0); assert.equal(result.count, 1); assert.equal(result.restored, true);
    });

    await t.test('大きい会話のコード重複を辞書化し、20MiBを全app合算で守る', async () => {
      const result = await page.evaluate(async () => {
        const store = make('history-measure');
        const code = '/* 長いカスタマイズコード */\n' + 'const value = "synthetic";\n'.repeat(8000);
        const payload = { messages: Array.from({ length: 60 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: '会話 ' + i + ' あいうえお'.repeat(100), code })), artifacts: [{ code }, { code }] };
        const rawBytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
        const saved = await store.save(item('large', payload)); const restored = await store.load('large');
        const capA = make('history-cap'), capB = make('history-cap', { scope: { ...scope, appId: '311' } });
        const block = 'x'.repeat(1024 * 1024); let count = 0, stopped;
        for (let i = 0; i < 22; i++) { const target = i % 2 ? capA : capB; const error = await codeOf(target.save(item(String(i), { text: block + i }))); if (error) { stopped = error; break; } count++; }
        const usage = await capA.usage();
        return { rawBytes, storedBytes: saved.bytes, reduction: 1 - saved.bytes / rawBytes, restored: JSON.stringify(restored.payload) === JSON.stringify(payload), count, stopped, usage, otherAppUsage: await capB.usage() };
      });
      assert.equal(result.restored, true); assert.ok(result.rawBytes > 10 * 1024 * 1024); assert.ok(result.reduction > 0.95);
      assert.equal(result.stopped, 'HISTORY_LIMIT'); assert.equal(result.count, 19); assert.equal(result.usage.count, 19); assert.ok(result.usage.bytes <= 20 * 1024 * 1024); assert.deepEqual(result.usage, result.otherAppUsage);
      t.diagnostic('容量計測: ' + JSON.stringify(result));
    });
    await page.evaluate(() => stores.forEach(store => store.close()));
    assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
