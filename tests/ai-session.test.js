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
function makeGateway({ customerToken = 'CUSTOMER-TOKEN-1', now = () => Date.now(), accessTtlSec = 2700, refreshTtlSec = 1209600, failExchange = null, replayGraceSec = 1800 } = {}) {
  const access = new Map(), refresh = new Map();
  const reqs = [];
  let seq = 0;
  const ctl = { hangNext: false, lastRefreshBody: null };   // hangNext: 次の refresh の応答を落とす（通信断 / タブ スリープ。Gateway 側では rotation 済み）
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
      ctl.lastRefreshBody = b;
      if (!r) return err(401, 'AUTH_INVALID_TOKEN');
      if (r.used) {
        // Phase 8.5: 同じ requestId の再送は猶予内なら同じ pair（それ以外は family 失効 = 401 reused）
        if (b.requestId && r.rid === b.requestId && r.issued && now() - r.usedAt <= replayGraceSec * 1000) return { status: 200, body: JSON.stringify({ ...r.issued, reissued: true }) };
        for (const x of refresh.values()) x.used = true; access.clear();
        return { status: 401, body: JSON.stringify({ ok: false, contractVersion: '2.1', error: { code: 'AUTH_INVALID_TOKEN', message: 'reused', detail: { reason: 'reused' } } }) };
      }
      if (Date.parse(r.exp) <= now()) return err(401, 'AUTH_TOKEN_EXPIRED');
      const issued = issue();
      r.used = true; r.usedAt = now(); r.rid = b.requestId || null; r.issued = b.requestId ? issued : null;
      if (ctl.hangNext) { ctl.hangNext = false; return new Promise(() => {}); }   // 応答が client に届かない
      return { status: 200, body: JSON.stringify(issued) };
    }
    const exp = access.get(bearer);
    if (!exp) return err(401, 'AUTH_INVALID_TOKEN');
    if (Date.parse(exp) <= now()) return err(401, 'AUTH_TOKEN_EXPIRED');
    if (req.url.endsWith('/v2/health')) return { status: 200, body: JSON.stringify({ ok: true, supportedContractVersions: ['2.0', '2.1'], entitlements: [{ product: 'toolkit', features: ['assistant-qa'] }], registry: { toolkit: { 'assistant-qa': { implemented: true, promptVersions: ['1'], conversation: ['requirements', 'brief', 'stream', 'proposal', 'suggestion', 'adoptQuote', 'itemIds'] } } }, auth: { type: 'access_token' } }) };
    return err(404, 'NOT_FOUND');
  };
  return { transport, reqs, access, refresh, ctl };
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
  assert(ex.url === 'https://gw.test/v2/token/exchange' && ex.method === 'POST' && ex.headers.Authorization === 'Bearer CUSTOMER-TOKEN-1' && ex.headers['X-Kintone-Domain'] === 'h' && JSON.parse(ex.body).grantType === 'customer_token' && JSON.parse(ex.body).product === 'toolkit' && JSON.parse(ex.body).feature === 'assistant-qa,change-planner,customization-generator', 'exchange request（Bearer = Customer Token・grantType・product / feature（assistant-qa,change-planner,customization-generator の 3 つを要求。Phase 16）・domain）');
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
  // 2026-10-05 で意図して更新: 接続情報は消すが、接続先（apiBase）は残す（消すと既定の production に戻った）
  assert(session.status().connected === false && !/RT-|refreshToken":"[^"]/.test(storage.dump()) && store.load().apiBase === 'https://gw.test', 'disconnect → 接続情報を消す（接続先は残す）');
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

console.log('\n--- 6. Refresh robustness（Phase 8.5: 応答喪失 ≠ replay）---');
{
  // lost response: refresh の応答が届かない（timeout）→ 旧 Refresh を捨てず、同じ requestId で再送 → 同じ pair
  let t = Date.now();
  const storage = makeStorage();
  const store = KTAiClient.createSettingsStore({ storage, host: 'h' });
  const gw = makeGateway({ now: () => t, accessTtlSec: 120 });
  const session = KTAiClient.createSession({ store, hostname: 'h', transport: gw.transport, apiBase: 'https://gw.test', nowFn: () => t, timeoutMs: 30 });
  await session.connect('CUSTOMER-TOKEN-1');
  t += 70 * 1000;
  gw.ctl.hangNext = true;
  let err = null; try { await session.client.getHealth(); } catch (e) { err = e; }
  const c1 = store.load();
  assert(err && err.code === C.TIMEOUT && session.status().connected === true && c1.refreshToken === 'RT-2', 'refresh の timeout → 接続情報を捨てない（旧 Refresh を保持・接続済みのまま）');
  assert(c1.refreshAttempt && /^[A-Za-z0-9_-]{8,128}$/.test(c1.refreshAttempt.requestId) && c1.refreshAttempt.at, 'refresh 要求の requestId を接続情報と一緒に保存（Gateway の形式に合う）');
  const rid = c1.refreshAttempt.requestId;
  assert(gw.ctl.lastRefreshBody.requestId === rid, 'refresh 要求に requestId を送る');
  const h = await session.client.getHealth();
  assert(h.ok && gw.ctl.lastRefreshBody.requestId === rid && gw.reqs.filter(r => r.url.endsWith('/exchange')).length === 3, '次の呼び出しで同じ requestId により再送 → 同じ pair で回復（connect + refresh + 再送 = exchange 3 回）');
  const c2 = store.load();
  assert(c2.refreshToken === 'RT-4' && !c2.refreshAttempt, '回復後は新しい Refresh を保存し、requestId は消す');
  t += 70 * 1000;
  await session.client.getHealth();
  assert(gw.ctl.lastRefreshBody.requestId && gw.ctl.lastRefreshBody.requestId !== rid && store.load().refreshToken === 'RT-6', '次の refresh は別の requestId');
}
{
  // identical retry after reload: ページ再読込（新しい session）でも保存した requestId で再送する
  let t = Date.now();
  const storage = makeStorage();
  const store = KTAiClient.createSettingsStore({ storage, host: 'h' });
  const gw = makeGateway({ now: () => t, accessTtlSec: 120 });
  const s1 = KTAiClient.createSession({ store, hostname: 'h', transport: gw.transport, apiBase: 'https://gw.test', nowFn: () => t, timeoutMs: 30 });
  await s1.connect('CUSTOMER-TOKEN-1');
  t += 70 * 1000;
  gw.ctl.hangNext = true;
  try { await s1.client.getHealth(); } catch (e) { }
  const rid = store.load().refreshAttempt.requestId;
  const s2 = KTAiClient.createSession({ store: KTAiClient.createSettingsStore({ storage, host: 'h' }), hostname: 'h', transport: gw.transport, apiBase: 'https://gw.test', nowFn: () => t, timeoutMs: 30 });
  const h = await s2.client.getHealth();
  assert(h.ok && gw.ctl.lastRefreshBody.requestId === rid && gw.ctl.lastRefreshBody.refreshToken === 'RT-2' && s2.status().connected, '再読込後の session も同じ requestId・同じ旧 Refresh で再送して回復');
}
{
  // true replay: Gateway が reused と判定（別の requestId）→ SESSION_EXPIRED・接続情報を破棄（無限に再送しない）
  let t = Date.now();
  const storage = makeStorage();
  const store = KTAiClient.createSettingsStore({ storage, host: 'h' });
  const gw = makeGateway({ now: () => t, accessTtlSec: 120 });
  const session = KTAiClient.createSession({ store, hostname: 'h', transport: gw.transport, apiBase: 'https://gw.test', nowFn: () => t, timeoutMs: 30 });
  await session.connect('CUSTOMER-TOKEN-1');
  t += 70 * 1000;
  gw.ctl.hangNext = true;
  try { await session.client.getHealth(); } catch (e) { }
  store.save({ ...store.load(), refreshAttempt: { requestId: 'rf_someone-else-0001', at: new Date(t).toISOString() } });
  let err = null; try { await session.client.getHealth(); } catch (e) { err = e; }
  // 2026-10-05 で意図して更新: 接続先（apiBase）は残す
  assert(err && err.code === C.SESSION_EXPIRED && session.status().connected === false && !/RT-|refreshAttempt/.test(storage.dump()) && store.load().apiBase === 'https://gw.test', 'Gateway が reused（family 失効）→ SESSION_EXPIRED・接続情報を破棄（接続先は残す）');
}
{
  // browser sleep: 猶予（Gateway 側 30 分）内に起きれば回復、超えれば失効（client はループしない）
  let t = Date.now();
  const storage = makeStorage();
  const store = KTAiClient.createSettingsStore({ storage, host: 'h' });
  const gw = makeGateway({ now: () => t, accessTtlSec: 120, replayGraceSec: 1800 });
  const session = KTAiClient.createSession({ store, hostname: 'h', transport: gw.transport, apiBase: 'https://gw.test', nowFn: () => t, timeoutMs: 30 });
  await session.connect('CUSTOMER-TOKEN-1');
  t += 70 * 1000;
  gw.ctl.hangNext = true;
  try { await session.client.getHealth(); } catch (e) { }
  t += 29 * 60 * 1000;
  const h = await session.client.getHealth();
  assert(h.ok && session.status().connected, '猶予内（29 分）の再送は回復');
  t += 70 * 1000;
  gw.ctl.hangNext = true;
  try { await session.client.getHealth(); } catch (e) { }
  t += 2 * 60 * 60 * 1000;
  let err = null; try { await session.client.getHealth(); } catch (e) { err = e; }
  assert(err && err.code === C.SESSION_EXPIRED && session.status().connected === false, '猶予後（2 時間）の再送は Gateway が失効 → SESSION_EXPIRED（再接続が必要）');
}
{
  // 通信断（TRANSPORT_ERROR）でも同様に保持して再送。成功した refresh は attempt を残さない
  let t = Date.now();
  const storage = makeStorage();
  const store = KTAiClient.createSettingsStore({ storage, host: 'h' });
  const gw = makeGateway({ now: () => t, accessTtlSec: 120 });
  let drop = false;
  const transport = async (req) => { if (drop) { drop = false; throw new Error('network down'); } return gw.transport(req); };
  const session = KTAiClient.createSession({ store, hostname: 'h', transport, apiBase: 'https://gw.test', nowFn: () => t, timeoutMs: 30 });
  await session.connect('CUSTOMER-TOKEN-1');
  t += 70 * 1000;
  drop = true;
  let err = null; try { await session.client.getHealth(); } catch (e) { err = e; }
  const rid = store.load().refreshAttempt?.requestId;
  assert(err && err.code === C.TRANSPORT_ERROR && store.load().refreshToken === 'RT-2' && rid, '通信断 → 旧 Refresh と requestId を保持');
  const h = await session.client.getHealth();
  assert(h.ok && gw.ctl.lastRefreshBody.requestId === rid && !store.load().refreshAttempt, '再送（Gateway は未使用なので通常発行）→ 回復・attempt を消す');
  assert(!storage.dump().includes('AT-') && !storage.dump().includes('CUSTOMER-TOKEN'), 'store に Access / Customer Token は無い');
}

// 2026-10-05 の実機（App 353・staging）: 再読み込みで 2 つのタブがほぼ同時に refresh し、Gateway が再使用（refresh_reuse）として family を失効した。
// その Refresh の拒否で接続情報を消すとき接続先（apiBase）も消え、既定の production に戻ったまま［Nest Rec AIに接続］が production へ送られた
console.log('\n--- 7. 接続先（apiBase）の保持 ---');
try {
  const storage = makeStorage();
  const store = KTAiClient.createSettingsStore({ storage, host: 'h' });
  store.save({ apiBase: 'https://staging.test', refreshToken: 'r', refreshExpiresAt: '2099-01-01T00:00:00Z', scope: { product: 'toolkit' }, connectedAt: 'c', refreshAttempt: { requestId: 'rf_1', at: 'x' } });
  store.clearTokens();
  const c = store.load();
  assert(c.apiBase === 'https://staging.test' && c.refreshToken === '' && c.scope === null && !c.refreshAttempt, 'clearTokens: 接続情報（Refresh・scope・進行中の要求）だけを消し、接続先は残す');
  const storage2 = makeStorage(); const store2 = KTAiClient.createSettingsStore({ storage: storage2, host: 'h' });
  store2.clearTokens();
  assert(storage2.getItem('ktAi.v2.h') === null && store2.load().apiBase === KTAiClient.DEFAULT_API_BASE, 'clearTokens: 接続先を保存していなければ何も残さない（既定の接続先のまま）');
  // Refresh が拒否された（SESSION_EXPIRED）後も接続先は staging のまま。次の［接続］も staging へ
  const gw = makeGateway();
  const s3 = makeStorage(); const st3 = KTAiClient.createSettingsStore({ storage: s3, host: 'h' });
  const session = KTAiClient.createSession({ store: st3, hostname: 'h', transport: gw.transport });   // apiBase は store から
  await session.connect('CUSTOMER-TOKEN-1', { apiBase: 'https://staging.test' });
  st3.save({ ...st3.load(), refreshToken: 'RT-unknown' });   // Gateway が知らない Refresh（拒否される）
  let err = null; try { await session.refresh(); } catch (e) { err = e; }
  assert(err && err.code === C.SESSION_EXPIRED && session.status().connected === false && session.status().apiBase === 'https://staging.test' && st3.load().apiBase === 'https://staging.test', `Refresh の拒否 → SESSION_EXPIRED・接続は切れるが接続先は staging のまま: ${session.status().apiBase}`);
  const flowReqs = [];
  const flow = KTAiClient.createConnectFlow({ session, hostname: 'h', transport: async (req) => { flowReqs.push(req.url); return { status: 503, body: JSON.stringify({ ok: false, contractVersion: '2.1', error: { code: 'UPSTREAM_ERROR', message: 'x' } }) }; }, openUrl: () => true, sleep: async () => { }, cryptoObj: require('crypto').webcrypto });
  try { await flow.start(); } catch (e) { }
  assert(flowReqs.length >= 1 && flowReqs.every(u => u.startsWith('https://staging.test/')), `その後の［Nest Rec AIに接続］は staging へ送る（既定の production へ送らない）: ${flowReqs.join(' ')}`);
  await session.disconnect();
  assert(st3.load().apiBase === 'https://staging.test' && st3.load().refreshToken === '', '接続解除の後も接続先は残す');
} catch (e) { assert(false, `例外: ${e && e.message}`); }

console.log('\n--- 8. タブ間の refresh（Web Locks で 1 つずつ・ロックの中で読み直す） ---');
try {
  const storage = makeStorage();   // 同じ kintone の 2 つのタブは同じ localStorage を見る
  const mk = () => KTAiClient.createSettingsStore({ storage, host: 'h' });
  let t = Date.parse('2026-10-05T00:00:00Z');
  const gw = makeGateway({ now: () => t, accessTtlSec: 120 });
  let releaseFirst = null, held = 0;
  const sentRefresh = [];   // client が送った refresh（Gateway に届く前に数える）
  const transport = async (req) => {
    if (req.url.endsWith('/v2/token/exchange') && JSON.parse(req.body).grantType === 'refresh_token') sentRefresh.push(JSON.parse(req.body).refreshToken);
    if (req.url.endsWith('/v2/token/exchange') && JSON.parse(req.body).grantType === 'refresh_token' && !held++) await new Promise(r => { releaseFirst = r; });   // 最初の refresh の応答を待たせる
    return gw.transport(req);
  };
  // Web Locks の代わり（同じ名前の要求を 1 つずつ実行する）
  const names = [];
  const queues = new Map();
  const locks = { request(name, opts, fn) { names.push(name); const prev = queues.get(name) || Promise.resolve(); const run = prev.then(() => fn()); queues.set(name, run.catch(() => { })); return run; } };
  const tabA = KTAiClient.createSession({ store: mk(), hostname: 'h', transport, apiBase: 'https://gw.test', nowFn: () => t, locks });
  const tabB = KTAiClient.createSession({ store: mk(), hostname: 'h', transport, apiBase: 'https://gw.test', nowFn: () => t, locks });
  await tabA.connect('CUSTOMER-TOKEN-1');
  t += 70 * 1000;   // Access の期限が近い（両方のタブが refresh する）
  const refreshBodies = () => gw.reqs.filter(r => r.url.endsWith('/v2/token/exchange')).map(r => JSON.parse(r.body)).filter(b => b.grantType === 'refresh_token');
  const pA = tabA.client.getHealth();
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
  const pB = tabB.client.getHealth();   // タブ B は、タブ A の refresh の途中で読み込まれた
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
  const beforeRelease = sentRefresh.length;   // A の refresh を待たせている間に、B は送っていない
  releaseFirst();
  const [hA, hB] = await Promise.all([pA, pB]);
  const bodies = refreshBodies();
  assert(beforeRelease === 1 && bodies.length === 2 && bodies[0].refreshToken !== bodies[1].refreshToken && hA.ok && hB.ok && tabA.status().connected && tabB.status().connected, `タブ B はタブ A の refresh が終わるまで待ち、A が回転した新しい Refresh で更新する（同じ Refresh を 2 回送らない）: ${beforeRelease} / ${bodies.map(b => b.refreshToken).join(' → ')}`);
  assert(names.length >= 2 && names.every(n => n === 'ktAi.refresh:ktAi.v2.h'), `ロックの名前は保存の名前（同じ kintone の画面どうしで同じ）: ${[...new Set(names)].join(',')}`);
} catch (e) { assert(false, `例外: ${e && e.message}`); }

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
