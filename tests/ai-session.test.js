// KTAiClient.createSession（Phase 5）: Customer Token → token exchange → 短命 Access Token（memory）＋ Refresh Token（store）
//
// 検証内容:
//   - connect: exchange（customer_token grant）に 1 回だけ Customer Token を送り、保存しない
//   - /v2 の呼び出しは Access Token（Bearer）で行う
//   - Access Token の期限（60 秒前）→ refresh_token grant で自動更新（rotation・store 更新）
//   - サーバの AUTH_TOKEN_EXPIRED → refresh して 1 回だけ再試行
//   - Refresh 失敗（401）→ SESSION_EXPIRED・接続情報を破棄 / 未接続 → NOT_CONNECTED
//   - exchange unauthorized（403）→ 何も保存しない
//   - 旧形式（localStorage の Customer Token）の移行
//   - store / 以後の request に生の Customer / Access Token が残らない
//
// 実行方法: node tests/ai-session.test.js
'use strict';
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const { KTAiClient } = loadToolkit();
const { assert, state } = makeAssert();
const C = KTAiClient.ERROR_CODES;

const makeStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), dump: () => [...m.entries()].map(([k, v]) => `${k}=${v}`).join('\n') }; };

/** Gateway の exchange / health / review を模す transport（KV の代わりに Map） */
function makeGateway({ customerToken = 'CUSTOMER-TOKEN-1', now = () => Date.now(), accessTtlSec = 2700, refreshTtlSec = 1209600, failExchange = null } = {}) {
  const access = new Map(), refresh = new Map();
  const reqs = [];
  let seq = 0;
  const issue = () => {
    const a = `AT-${++seq}`, r = `RT-${++seq}`;
    const aExp = new Date(now() + accessTtlSec * 1000).toISOString(), rExp = new Date(now() + refreshTtlSec * 1000).toISOString();
    access.set(a, aExp); refresh.set(r, { exp: rExp, used: false });
    return { ok: true, contractVersion: '2.1', tokenType: 'Bearer', accessToken: a, expiresAt: aExp, expiresInSec: accessTtlSec, refreshToken: r, refreshExpiresAt: rExp, scope: { product: 'toolkit', feature: 'assistant-qa', domain: 'h', tokenId: `at_${seq}`, familyId: 'fam' } };
  };
  const err = (status, code) => ({ status, body: JSON.stringify({ ok: false, contractVersion: '2.1', error: { code, message: code, requestId: 'e-1' } }) });
  const transport = async (req) => {
    reqs.push(req);
    const bearer = (req.headers.Authorization || '').replace(/^Bearer /, '');
    if (req.url.endsWith('/v2/token/exchange')) {
      const b = JSON.parse(req.body);
      if (failExchange) return err(failExchange.status, failExchange.code);
      if (b.grantType === 'customer_token') return bearer === customerToken ? { status: 200, body: JSON.stringify(issue()) } : err(401, 'AUTH_INVALID_TOKEN');
      const r = refresh.get(b.refreshToken);
      if (!r || r.used) return err(401, 'AUTH_INVALID_TOKEN');
      if (Date.parse(r.exp) <= now()) return err(401, 'AUTH_TOKEN_EXPIRED');
      r.used = true;
      return { status: 200, body: JSON.stringify(issue()) };
    }
    const exp = access.get(bearer);
    if (!exp) return err(401, 'AUTH_INVALID_TOKEN');
    if (Date.parse(exp) <= now()) return err(401, 'AUTH_TOKEN_EXPIRED');
    if (req.url.endsWith('/v2/health')) return { status: 200, body: JSON.stringify({ ok: true, supportedContractVersions: ['2.0', '2.1'], entitlements: [{ product: 'toolkit', features: ['assistant-qa'] }], registry: { toolkit: { 'assistant-qa': { implemented: true, promptVersions: ['1'] } } }, auth: { type: 'access_token' } }) };
    return err(404, 'NOT_FOUND');
  };
  return { transport, reqs, access, refresh };
}

(async () => {
console.log('\n--- 1. connect（exchange）---');
{
  const storage = makeStorage();
  const store = KTAiClient.createSettingsStore({ storage, host: 'h' });
  const gw = makeGateway();
  const session = KTAiClient.createSession({ store, hostname: 'h', transport: gw.transport, apiBase: 'https://gw.test' });
  assert(session.status().connected === false, '初期状態は未接続');
  let err = null; try { await session.client.getHealth(); } catch (e) { err = e; }
  assert(err && err.code === C.NOT_CONNECTED, '未接続で呼ぶと NOT_CONNECTED');
  const st = await session.connect('CUSTOMER-TOKEN-1');
  assert(st.connected && st.scope.product === 'toolkit' && st.refreshExpiresAt && gw.reqs.length === 1, 'connect → exchange 1 回・接続済み');
  const ex = gw.reqs[0];
  assert(ex.url === 'https://gw.test/v2/token/exchange' && ex.method === 'POST' && ex.headers.Authorization === 'Bearer CUSTOMER-TOKEN-1' && ex.headers['X-Kintone-Domain'] === 'h' && JSON.parse(ex.body).grantType === 'customer_token' && JSON.parse(ex.body).product === 'toolkit' && JSON.parse(ex.body).feature === 'assistant-qa,change-planner', 'exchange request（Bearer = Customer Token・grantType・product / feature（assistant-qa,change-planner の両方を要求）・domain）');
  const dump = storage.dump();
  assert(dump.includes('ktAi.v2.h') && dump.includes('RT-2') && !dump.includes('CUSTOMER-TOKEN-1') && !dump.includes('AT-1'), 'store には Refresh Token だけ（Customer / Access Token は保存しない）');
  const h = await session.client.getHealth();
  assert(h.ok && gw.reqs[1].headers.Authorization === 'Bearer AT-1', '/v2 は Access Token で呼ぶ');
  assert(gw.reqs.slice(1).every(r => r.headers.Authorization !== 'Bearer CUSTOMER-TOKEN-1'), 'exchange 以外に Customer Token を送らない');
  assert(session.status().accessExpiresAt && session.status().connected, 'status に access / refresh の期限');
}

console.log('\n--- 2. Access Token の期限 → 自動 refresh（rotation）---');
{
  let t = Date.now();
  const storage = makeStorage();
  const store = KTAiClient.createSettingsStore({ storage, host: 'h' });
  const gw = makeGateway({ now: () => t, accessTtlSec: 120 });
  const session = KTAiClient.createSession({ store, hostname: 'h', transport: gw.transport, apiBase: 'https://gw.test', nowFn: () => t });
  await session.connect('CUSTOMER-TOKEN-1');
  await session.client.getHealth();
  t += 70 * 1000;   // 期限の 60 秒前を過ぎた
  await session.client.getHealth();
  const kinds = gw.reqs.map(r => r.url.endsWith('/exchange') ? `X:${JSON.parse(r.body).grantType}` : `H:${r.headers.Authorization}`);
  assert(kinds.join(',') === 'X:customer_token,H:Bearer AT-1,X:refresh_token,H:Bearer AT-3', `期限前に refresh_token grant で更新してから呼ぶ（${kinds.join(',')}）`);
  const refreshReq = gw.reqs[2];
  assert(!refreshReq.headers.Authorization && JSON.parse(refreshReq.body).refreshToken === 'RT-2', 'refresh grant は Bearer 無し・body に Refresh Token');
  assert(storage.dump().includes('RT-4') && !storage.dump().includes('RT-2'), 'store の Refresh Token が rotation される');
  // 使用済み Refresh の再使用は Gateway が拒否 → SESSION_EXPIRED
  t += 70 * 1000;
  store.save({ ...store.load(), refreshToken: 'RT-2' });
  let err = null; try { await session.client.getHealth(); } catch (e) { err = e; }
  assert(err && err.code === C.SESSION_EXPIRED && session.status().connected === false && !storage.dump().includes('RT-'), 'Refresh が拒否されたら SESSION_EXPIRED・接続情報を破棄');
}

console.log('\n--- 3. サーバ側の AUTH_TOKEN_EXPIRED → refresh して 1 回だけ再試行 ---');
{
  const storage = makeStorage();
  const store = KTAiClient.createSettingsStore({ storage, host: 'h' });
  const gw = makeGateway();
  const session = KTAiClient.createSession({ store, hostname: 'h', transport: gw.transport, apiBase: 'https://gw.test' });
  await session.connect('CUSTOMER-TOKEN-1');
  gw.access.set('AT-1', '2020-01-01T00:00:00Z');   // サーバ側で失効
  const h = await session.client.getHealth();
  const kinds = gw.reqs.map(r => r.url.endsWith('/exchange') ? `X:${JSON.parse(r.body).grantType}` : `H:${r.headers.Authorization}`);
  assert(h.ok && kinds.join(',') === 'X:customer_token,H:Bearer AT-1,X:refresh_token,H:Bearer AT-3', `401 AUTH_TOKEN_EXPIRED → refresh → 再試行（${kinds.join(',')}）`);
  gw.access.set('AT-3', '2020-01-01T00:00:00Z');
  gw.refresh.forEach(r => { r.used = true; });
  let err = null; try { await session.client.getHealth(); } catch (e) { err = e; }
  assert(err && err.code === C.SESSION_EXPIRED, '再試行も失敗したら SESSION_EXPIRED（無限ループしない）');
}

console.log('\n--- 4. exchange unauthorized / disconnect / 旧形式の移行 ---');
{
  const storage = makeStorage();
  const store = KTAiClient.createSettingsStore({ storage, host: 'h' });
  const gw = makeGateway({ failExchange: { status: 403, code: 'PRODUCT_NOT_ENTITLED' } });
  const session = KTAiClient.createSession({ store, hostname: 'h', transport: gw.transport, apiBase: 'https://gw.test' });
  let err = null; try { await session.connect('CUSTOMER-TOKEN-1'); } catch (e) { err = e; }
  assert(err && err.code === C.PRODUCT_NOT_ENTITLED && session.status().connected === false && storage.dump() === '', 'exchange 403 → エラー・何も保存しない');
}
{
  const storage = makeStorage();
  const store = KTAiClient.createSettingsStore({ storage, host: 'h' });
  const gw = makeGateway();
  const session = KTAiClient.createSession({ store, hostname: 'h', transport: gw.transport, apiBase: 'https://gw.test' });
  await session.connect('CUSTOMER-TOKEN-1');
  session.disconnect();
  assert(session.status().connected === false && storage.dump() === '', 'disconnect → store を消す');
  let err = null; try { await session.client.getHealth(); } catch (e) { err = e; }
  assert(err && err.code === C.NOT_CONNECTED, '切断後は NOT_CONNECTED');
}
{
  const storage = makeStorage();
  storage.setItem('ktAi.v1.h', JSON.stringify({ apiBase: 'https://gw.test', customerToken: 'CUSTOMER-TOKEN-1' }));   // Phase 4 の保存形式
  const store = KTAiClient.createSettingsStore({ storage, host: 'h' });
  const gw = makeGateway();
  const session = KTAiClient.createSession({ store, hostname: 'h', transport: gw.transport });
  const migrated = await session.migrateLegacy();
  assert(migrated === true && session.status().connected && storage.getItem('ktAi.v1.h') === null && !storage.dump().includes('CUSTOMER-TOKEN-1') && storage.dump().includes('RT-'), '旧形式の Customer Token は exchange して削除（v2 は Refresh のみ）');
  assert(await session.migrateLegacy() === false, '2 回目は何もしない');
  const s2 = KTAiClient.createSession({ store: KTAiClient.createSettingsStore({ storage: makeStorage(), host: 'h' }), hostname: 'h', transport: gw.transport });
  assert(await s2.migrateLegacy() === false, '旧形式が無ければ false');
}

console.log('\n--- 4b. apiBase は毎回 store から解決する（session 生成時の既定値に固定しない）---');
{
  // 実機で発生: 空の store で session を作り、後から connect(token, { apiBase: staging }) すると
  // exchange は staging へ行くが、health / ask が session 生成時の既定（production）へ送られていた
  const storage = makeStorage();
  const store = KTAiClient.createSettingsStore({ storage, host: 'h' });
  const gw = makeGateway();
  const session = KTAiClient.createSession({ store, hostname: 'h', transport: gw.transport });   // apiBase 未指定・store も空
  await session.connect('CUSTOMER-TOKEN-1', { apiBase: 'https://staging.test' });
  await session.client.getHealth();
  assert(gw.reqs.length === 2 && gw.reqs[0].url === 'https://staging.test/v2/token/exchange' && gw.reqs[1].url === 'https://staging.test/v2/health', 'connect 時に指定した apiBase が exchange と health の両方に使われる（既定の production URL へ送らない）');
  assert(gw.reqs.every(r => !r.url.startsWith(KTAiClient.DEFAULT_API_BASE)), '既定 apiBase への request が 1 件も無い');
  // 旧形式の移行でも同じ（migrateLegacy は legacy の apiBase を使う）
  const storage2 = makeStorage();
  storage2.setItem('ktAi.v1.h', JSON.stringify({ apiBase: 'https://staging.test', customerToken: 'CUSTOMER-TOKEN-1' }));
  const gw2 = makeGateway();
  const s2 = KTAiClient.createSession({ store: KTAiClient.createSettingsStore({ storage: storage2, host: 'h' }), hostname: 'h', transport: gw2.transport });
  await s2.migrateLegacy();
  await s2.client.getHealth();
  assert(gw2.reqs.every(r => r.url.startsWith('https://staging.test/')), 'migrateLegacy 後の health も legacy の apiBase へ');
}

console.log('\n--- 5. 設定 store の形 ---');
{
  const storage = makeStorage();
  const store = KTAiClient.createSettingsStore({ storage, host: 'h' });
  const def = store.load();
  assert(def.apiBase === KTAiClient.DEFAULT_API_BASE && def.refreshToken === '' && def.scope === null && !('customerToken' in def), 'load の既定（customerToken フィールドは無い）');
  store.save({ apiBase: 'https://gw.test/', refreshToken: 'r', refreshExpiresAt: 'x', scope: { product: 'toolkit' }, connectedAt: 'c' });
  assert(store.load().apiBase === 'https://gw.test' && store.load().refreshToken === 'r', 'save / load（末尾スラッシュ除去）');
  store.clear();
  assert(store.load().refreshToken === '', 'clear');
}

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
