// ページ期限切れへの対応（2026-10-15・指示書「ページ期限切れへの対応と C3 検証の切り分け」§1・§2）。有料の AI は使わない。
//
// 実機（2026-10-15）: 約 5 時間開いたままのページで kintone.proxy が CB_CS01（ページの有効期限）で失敗し、health と Access Token の更新が通らず
//   「AI 利用できません」になった。再読み込みは作成途中の会話を失う。
//
// 検証内容:
//   §P1 transport: kintone.proxy の CB_CS01 → 同じ要求（同じ見出し・本文）を Gateway へ 1 回だけ直接送る。直接も届かない・直接をすでに試した・
//        直接送れない → PAGE_EXPIRED（再試行しない）。中断は中断のまま。ほかの proxy の失敗は今まで通り（GAIA_PR03 は TIMEOUT・それ以外はそのまま）
//   §P2 接続の更新（実際の createSession・createDefaultTransport。kintone.proxy はいつも CB_CS01）: 正規の直接の更新（保存した requestId のまま）・
//        応答の消失（同じ Refresh を別の requestId で使わない → 次は同じ requestId で回復・family を失効させない）・同時の更新（このタブの中で 1 回・
//        タブ間はロックで 1 つずつで失効しない）・認証の失効（SESSION_EXPIRED・接続情報を消し接続先は残す）・CORS で直接も送れない（PAGE_EXPIRED・自動の再試行なし）
//   §P3 検証の上限の記録（KTAiBudget）: Access Token の取得・更新で止まった失敗（tokenStage）は AI を呼んでいない → 確保を解放（有料の呼び出しを 1 回実行した扱いにしない）
//   §P4 会話: 生成の前の接続の更新が PAGE_EXPIRED → 止める理由は page（終了不明にしない）・完成した C1 / C2 と計画を残す・失敗した C3 の記録を残す・
//        作成途中のカードに「このページの有効期限が切れ…」と「作成済みの内容はこの画面に残っています。再読み込みすると、この会話は失われます。」・
//        回復後の［残りの JavaScript を作る］は C3 だけ（C1 / C2 は流用・計画の AI 0 回）
//   §P5 画面: health が PAGE_EXPIRED でも、ヘッダーは「AI ページの有効期限切れ」（「利用できません」・契約切れにしない）・接続の欄の契約は「このページからは確かめられません」・
//        回復しない操作（接続解除・再接続）を勧めない・生成済みの検証結果を消さない
//
// 実行方法: node tests/ai-page-expired.test.js
'use strict';
process.on('unhandledRejection', (e) => { if (/kintone is not defined/.test(String(e && e.message))) return; console.error(e); process.exit(1); });
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
//   簡素化（2026-10-17）: 反映できるかは、最新の版なら会話の今の判定、前の版なら最終案の記録で確かめる（tests/helpers/final-state.js）
const FS = require('./helpers/final-state.js');
const T = loadToolkit();
const { KTAiConversation, KTAiClient, KTAiBudget, KTAiChatUi, KTContextUi } = T;
const { assert, state } = makeAssert();
const { createNewFlowKit } = require('./helpers/new-flow.js');
const K = createNewFlowKit(T);
const { clone, makeConvC, makeGenerate, stripC, finalHtml } = K;
const C = KTAiClient.ERROR_CODES;
const I = KTAiConversation.INTENT;
async function section(fn) { try { await fn(); } catch (e) { assert(false, `例外: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' / ') : e}`); } }
const HOST = 't.cybozu.com';
const PAGE_TEXT = 'このページの有効期限が切れ、AIとの接続を更新できません。作成済みの内容はこの画面に残っています。再読み込みすると、この会話は失われます。';
/** kintone.proxy の実際の失敗（2026-10-15 の実機で受けた形: JSON の文字列） */
const CB_CS01 = JSON.stringify({ code: 'CB_CS01', messageType: 'text', success: false, id: 'x', message: 'ページの有効期限が切れています。ページを再読み込みしてください。' });
const jsonResponse = (status, obj) => ({ status, headers: { get: (k) => (/content-type/i.test(k) ? 'application/json' : null) }, text: async () => JSON.stringify(obj) });
const visibleText = (h) => stripC(String(h).replace(/<details[\s\S]*?<\/details>/g, ''));

// =========================================================
console.log('\n--- §P1. transport: kintone.proxy の CB_CS01 → 同じ要求を 1 回だけ直接。届かなければ PAGE_EXPIRED ---');
(async () => {
await section(async () => {
  const proxyCalls = [], fetchCalls = [];
  const kintoneApi = { proxy: async (...a) => { proxyCalls.push(a); throw CB_CS01; } };
  const fetchFn = async (url, init) => { fetchCalls.push({ url, init }); return jsonResponse(200, { ok: true }); };
  const send = KTAiClient.createDefaultTransport({ kintoneApi, fetchFn });
  const marks = [];
  const headers = { 'X-Kintone-Domain': HOST, 'Content-Type': 'application/json' };
  const r = await send({ url: 'https://gw.test/v2/token/exchange', method: 'POST', headers, body: '{"grantType":"refresh_token","requestId":"rf_same-0001"}', mark: (k, v) => marks.push([k, v]) });
  assert(r.status === 200 && r.via === 'direct' && proxyCalls.length === 1 && fetchCalls.length === 1 && fetchCalls[0].url === 'https://gw.test/v2/token/exchange' && fetchCalls[0].init.method === 'POST' && fetchCalls[0].init.body === '{"grantType":"refresh_token","requestId":"rf_same-0001"}' && JSON.stringify(fetchCalls[0].init.headers) === JSON.stringify(headers), `P1-1: CB_CS01 → 同じ URL・方法・見出し・本文（同じ requestId）で 1 回だけ直接送る: ${JSON.stringify({ via: r.via, proxy: proxyCalls.length, fetch: fetchCalls.length })}`);
  assert(marks.some(([k, v]) => k === 'via' && v === 'proxy') && marks.filter(([k, v]) => k === 'via').slice(-1)[0][1] === 'direct', `P1-2: 経路の印は proxy → direct（受けた経路は direct）: ${JSON.stringify(marks)}`);
});
await section(async () => {
  let fetchN = 0, proxyN = 0;
  const send = KTAiClient.createDefaultTransport({ kintoneApi: { proxy: async () => { proxyN += 1; throw CB_CS01; } }, fetchFn: async () => { fetchN += 1; throw new TypeError('Failed to fetch'); } });
  let err = null; try { await send({ url: 'https://gw.test/v2/health', method: 'GET', headers: {}, body: '' }); } catch (e) { err = e; }
  assert(err && err.code === C.PAGE_EXPIRED && err.message === PAGE_TEXT && err.details && err.details.direct === 'failed' && proxyN === 1 && fetchN === 1, `P1-3: 直接も届かない（CORS・通信の制限）→ PAGE_EXPIRED（proxy 1 回・直接 1 回。再試行しない）: ${JSON.stringify({ code: err && err.code, proxyN, fetchN })}`);
});
await section(async () => {
  let fetchN = 0, proxyN = 0;
  const send = KTAiClient.createDefaultTransport({ kintoneApi: { proxy: async () => { proxyN += 1; throw CB_CS01; } }, fetchFn: async () => { fetchN += 1; throw new TypeError('Failed to fetch'); } });
  let err = null; try { await send({ url: 'https://gw.test/v2/review', method: 'POST', headers: {}, body: '{}', preferDirect: true }); } catch (e) { err = e; }
  assert(err && err.code === C.PAGE_EXPIRED && err.details.direct === 'failed' && fetchN === 1 && proxyN === 1, `P1-4: 長い要求（直接を先に試した）→ すぐ失敗して proxy も CB_CS01 → 直接をもう一度は送らない（PAGE_EXPIRED）: ${JSON.stringify({ fetchN, proxyN })}`);
  const send2 = KTAiClient.createDefaultTransport({ kintoneApi: { proxy: async () => { throw CB_CS01; } }, fetchFn: null });
  let err2 = null; try { await send2({ url: 'https://gw.test/v2/health', method: 'GET', headers: {}, body: '' }); } catch (e) { err2 = e; }
  assert(err2 && err2.code === C.PAGE_EXPIRED && err2.details.direct === 'unavailable', 'P1-5: 直接送れない環境（fetch が無い）→ PAGE_EXPIRED（direct unavailable）');
});
await section(async () => {
  let fetchN = 0;
  const gaia = KTAiClient.createDefaultTransport({ kintoneApi: { proxy: async () => { throw 'GAIA_PR03 kintoneとプロキシーAPIとの通信がタイムアウトしました'; } }, fetchFn: async () => { fetchN += 1; return jsonResponse(200, {}); } });
  let e1 = null; try { await gaia({ url: 'https://gw.test/v2/health', method: 'GET', headers: {}, body: '' }); } catch (e) { e1 = e; }
  const other = KTAiClient.createDefaultTransport({ kintoneApi: { proxy: async () => { throw { code: 'CB_VA01', message: '入力内容が正しくありません。' }; } }, fetchFn: async () => { fetchN += 1; return jsonResponse(200, {}); } });
  let e2 = null; try { await other({ url: 'https://gw.test/v2/health', method: 'GET', headers: {}, body: '' }); } catch (e) { e2 = e; }
  assert(e1 && e1.code === C.TIMEOUT && e2 && e2.code === 'CB_VA01' && fetchN === 0, `P1-6: ほかの kintone.proxy の失敗は今まで通り（GAIA_PR03 は TIMEOUT・それ以外はそのまま投げる。直接は送らない）: ${JSON.stringify({ e1: e1 && e1.code, e2: e2 && e2.code, fetchN })}`);
  const objErr = KTAiClient.createDefaultTransport({ kintoneApi: { proxy: async () => { throw { code: 'CB_CS01', message: 'ページの有効期限が切れています。' }; } }, fetchFn: async () => jsonResponse(200, { ok: true }) });
  const r3 = await objErr({ url: 'https://gw.test/v2/health', method: 'GET', headers: {}, body: '' });
  assert(r3.via === 'direct', 'P1-7: 失敗が object（{ code: CB_CS01 }）でも見分ける');
  const aborting = KTAiClient.createDefaultTransport({ kintoneApi: { proxy: async () => { throw CB_CS01; } }, fetchFn: async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; } });
  let e4 = null; try { await aborting({ url: 'https://gw.test/v2/health', method: 'GET', headers: {}, body: '' }); } catch (e) { e4 = e; }
  assert(e4 && e4.name === 'AbortError' && e4.code !== C.PAGE_EXPIRED, 'P1-8: 直接の送信の中断（取り消し・時間切れ）は中断のまま（PAGE_EXPIRED にしない）');
});

// =========================================================
console.log('\n--- §P2. 接続の更新（実際の createSession・createDefaultTransport。kintone.proxy はいつも CB_CS01）---');
const makeStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), dump: () => [...m.entries()].map(([k, v]) => `${k}=${v}`).join('\n') }; };
/**
 * 偽の Gateway（fetch。直接の経路）。refresh_token grant は rotation・同じ requestId の再送は猶予内なら同じ pair・別の requestId での再使用は family を失効（契約 14・Phase 8.5）。
 *   ctl.loseNext = 次の refresh を Gateway では処理したが応答を client に届けない（通信の途中で消える）
 */
function makeDirectGateway({ now = () => Date.now(), accessTtlSec = 2700 } = {}) {
  const access = new Map(), refresh = new Map();
  const calls = [];
  let seq = 0;
  const ctl = { loseNext: false, revokedAll: false, cors: false };
  const issue = () => {
    const a = `AT-${++seq}`, r = `RT-${++seq}`;
    const aExp = new Date(now() + accessTtlSec * 1000).toISOString(), rExp = new Date(now() + 14 * 86400 * 1000).toISOString();
    access.set(a, aExp); refresh.set(r, { exp: rExp, used: false });
    return { ok: true, contractVersion: '2.1', tokenType: 'Bearer', accessToken: a, expiresAt: aExp, expiresInSec: accessTtlSec, refreshToken: r, refreshExpiresAt: rExp, scope: { product: 'toolkit', feature: 'assistant-qa', domain: HOST } };
  };
  const err = (status, code) => jsonResponse(status, { ok: false, contractVersion: '2.1', error: { code, message: code, requestId: 'e-1' } });
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, method: init.method, headers: { ...(init.headers || {}) }, body: init.body || '' });
    if (ctl.cors) throw new TypeError('Failed to fetch');
    if ((init.headers || {})['X-Kintone-Domain'] !== HOST) return err(403, 'AUTH_DOMAIN_MISMATCH');
    if (/\/v2\/token\/exchange$/.test(url)) {
      const b = JSON.parse(init.body);
      const r = refresh.get(b.refreshToken);
      if (!r || ctl.revokedAll) return err(401, 'AUTH_INVALID_TOKEN');
      if (r.used) {
        if (b.requestId && r.rid === b.requestId && r.issued) return jsonResponse(200, { ...r.issued, reissued: true });
        ctl.revokedAll = true; access.clear();
        return err(401, 'AUTH_INVALID_TOKEN');
      }
      const issued = issue();
      r.used = true; r.rid = b.requestId || null; r.issued = b.requestId ? issued : null;
      if (ctl.loseNext) { ctl.loseNext = false; throw new TypeError('network error'); }   // Gateway では回転済み・応答は届かない
      return jsonResponse(200, issued);
    }
    const bearer = ((init.headers || {}).Authorization || '').replace(/^Bearer /, '');
    if (!access.has(bearer)) return err(401, 'AUTH_INVALID_TOKEN');
    if (/\/v2\/health$/.test(url)) return jsonResponse(200, { ok: true, supportedContractVersions: ['2.0', '2.1'], entitlements: [{ product: 'toolkit', features: ['assistant-qa'] }] });
    return err(404, 'NOT_FOUND');
  };
  return { fetchFn, calls, access, refresh, ctl, seed: () => { const p = issue(); access.delete(p.accessToken); return p; } };
}
function mkSession(gw, { storage = makeStorage(), locks = null, proxy = null } = {}) {
  const proxyCalls = [];
  const kintoneApi = { proxy: proxy || (async (...a) => { proxyCalls.push(a[0]); throw CB_CS01; }) };
  const store = KTAiClient.createSettingsStore({ storage, host: HOST });
  const transport = KTAiClient.createDefaultTransport({ kintoneApi, fetchFn: gw.fetchFn });
  const session = KTAiClient.createSession({ store, hostname: HOST, transport, apiBase: 'https://gw.test', locks });
  return { session, store, storage, proxyCalls };
}
const seedStore = (s, gw) => { const p = gw.seed(); s.store.save({ apiBase: 'https://gw.test', refreshToken: p.refreshToken, refreshExpiresAt: p.refreshExpiresAt, scope: p.scope, connectedAt: new Date().toISOString() }); return p; };
await section(async () => {
  const gw = makeDirectGateway();
  const s = mkSession(gw);
  const p0 = seedStore(s, gw);
  const h = await s.session.client.getHealth();
  const ex = gw.calls.find(c => /token\/exchange$/.test(c.url));
  const body = ex ? JSON.parse(ex.body) : null;
  const hc = gw.calls.find(c => /health$/.test(c.url));
  const cfg = s.store.load();
  assert(h && h.ok === true && s.proxyCalls.length === 2 && gw.calls.length === 2 && body && body.grantType === 'refresh_token' && body.refreshToken === p0.refreshToken && /^[A-Za-z0-9_-]{8,128}$/.test(body.requestId) && ex.headers['X-Kintone-Domain'] === HOST && hc && /^Bearer AT-/.test(hc.headers.Authorization), `P2-1: 正規の直接の更新: 更新（proxy CB_CS01 → 直接）→ health（proxy CB_CS01 → 直接）。認証の条件（Refresh・requestId・X-Kintone-Domain・Bearer）は経路で変わらない: ${JSON.stringify({ proxy: s.proxyCalls.length, direct: gw.calls.map(c => c.url.replace('https://gw.test', '')) })}`);
  assert(cfg.refreshToken && cfg.refreshToken !== p0.refreshToken && !cfg.refreshAttempt && !/AT-/.test(s.storage.dump()), 'P2-2: 回転した新しい Refresh を保存し、進行中の requestId は消す（Access Token は保存しない）');
});
await section(async () => {
  const gw = makeDirectGateway();
  const s = mkSession(gw);
  const p0 = seedStore(s, gw);
  gw.ctl.loseNext = true;
  let err = null; try { await s.session.client.getHealth(); } catch (e) { err = e; }
  const c1 = s.store.load();
  const rid1 = c1.refreshAttempt && c1.refreshAttempt.requestId;
  assert(err && err.code === C.PAGE_EXPIRED && err.tokenStage === true && c1.refreshToken === p0.refreshToken && rid1 && JSON.parse(gw.calls[0].body).requestId === rid1 && s.session.status().connected === true, `P2-3: 更新の応答が消えた（Gateway では回転済み）→ PAGE_EXPIRED（接続の更新の前で止まった印）。旧 Refresh と送った requestId を保持（別の requestId で再利用しない）: ${JSON.stringify({ code: err && err.code, tokenStage: err && err.tokenStage, kept: c1.refreshToken === p0.refreshToken, rid1 })}`);
  const h = await s.session.client.getHealth();
  const exs = gw.calls.filter(c => /token\/exchange$/.test(c.url)).map(c => JSON.parse(c.body));
  const c2 = s.store.load();
  assert(h.ok === true && exs.length === 2 && exs[1].requestId === rid1 && exs[1].refreshToken === p0.refreshToken && gw.ctl.revokedAll === false && !c2.refreshAttempt && c2.refreshToken !== p0.refreshToken, `P2-4: 次の更新は同じ Refresh・同じ requestId で再送 → Gateway は同じ pair（猶予内）→ 回復。family は失効しない: ${JSON.stringify({ rids: exs.map(x => x.requestId), revoked: gw.ctl.revokedAll })}`);
});
await section(async () => {
  const gw = makeDirectGateway();
  const s = mkSession(gw);
  seedStore(s, gw);
  const [a, b] = await Promise.all([s.session.client.getHealth(), s.session.client.getHealth()]);
  const exN = gw.calls.filter(c => /token\/exchange$/.test(c.url)).length;
  assert(a.ok && b.ok && exN === 1 && gw.ctl.revokedAll === false, `P2-5: このタブの中の同時の更新は 1 回（経路を切り替えても二重に送らない）: ${JSON.stringify({ exN })}`);
  //   タブ間: Web Locks（ここでは 1 つずつ実行する偽のロック）の中で接続情報を読み直す → 後のタブは回転後の Refresh を使い、再使用で失効しない
  const gw2 = makeDirectGateway();
  const storage = makeStorage();
  let chain = Promise.resolve();
  const locks = { request: (name, opts, fn) => { const run = chain.then(() => fn()); chain = run.catch(() => { }); return run; } };
  const t1 = mkSession(gw2, { storage, locks }), t2 = mkSession(gw2, { storage, locks });
  seedStore(t1, gw2);
  const [x, y] = await Promise.all([t1.session.client.getHealth(), t2.session.client.getHealth()]);
  const ex2 = gw2.calls.filter(c => /token\/exchange$/.test(c.url)).map(c => JSON.parse(c.body).refreshToken);
  assert(x.ok && y.ok && gw2.ctl.revokedAll === false && ex2.length === 2 && ex2[0] !== ex2[1], `P2-6: 2 つのタブの同時の更新: ロックで 1 つずつ・後のタブは回転後の Refresh を使う（同じ Refresh を別の requestId で使わない・失効しない）: ${JSON.stringify({ ex2, revoked: gw2.ctl.revokedAll })}`);
});
await section(async () => {
  const gw = makeDirectGateway();
  const s = mkSession(gw);
  seedStore(s, gw);
  gw.ctl.revokedAll = true;
  let err = null; try { await s.session.client.getHealth(); } catch (e) { err = e; }
  const cfg = s.store.load();
  assert(err && err.code === C.SESSION_EXPIRED && err.tokenStage === true && s.session.status().connected === false && !cfg.refreshToken && cfg.apiBase === 'https://gw.test' && KTAiClient.errorText(err.code) !== PAGE_TEXT, `P2-7: 認証の失効（直接の更新が AUTH_INVALID_TOKEN）→ 今まで通り SESSION_EXPIRED・接続情報を消す（接続先は残す）。ページの有効期限の文にしない: ${JSON.stringify({ code: err && err.code })}`);
});
await section(async () => {
  const gw = makeDirectGateway();
  const s = mkSession(gw);
  const p0 = seedStore(s, gw);
  gw.ctl.cors = true;
  let e1 = null, e2 = null;
  try { await s.session.client.getHealth(); } catch (e) { e1 = e; }
  const after1 = { proxy: s.proxyCalls.length, direct: gw.calls.length };
  try { await s.session.client.getHealth(); } catch (e) { e2 = e; }
  const cfg = s.store.load();
  assert(e1 && e1.code === C.PAGE_EXPIRED && e1.message === PAGE_TEXT && e2 && e2.code === C.PAGE_EXPIRED && after1.proxy === 1 && after1.direct === 1 && s.proxyCalls.length === 2 && gw.calls.length === 2 && cfg.refreshToken === p0.refreshToken && cfg.refreshAttempt && JSON.parse(gw.calls[0].body).requestId === JSON.parse(gw.calls[1].body).requestId, `P2-8: CORS などで直接も送れない → PAGE_EXPIRED。1 回の操作につき proxy 1 回・直接 1 回（自動の再試行なし）。次の操作も同じ requestId（Refresh は保持）: ${JSON.stringify({ after1, total: { proxy: s.proxyCalls.length, direct: gw.calls.length } })}`);
});

// =========================================================
console.log('\n--- §P3. 検証の上限の記録: 接続の更新で止まった失敗は AI を呼んでいない → 確保を解放 ---');
await section(async () => {
  const pe = new KTAiClient.AiClientError({ code: C.PAGE_EXPIRED, message: PAGE_TEXT }); pe.tokenStage = true;
  const te = new KTAiClient.AiClientError({ code: C.TRANSPORT_ERROR, message: 'x' }); te.tokenStage = true;
  const plainT = new KTAiClient.AiClientError({ code: C.TRANSPORT_ERROR, message: 'x' });
  assert(KTAiBudget.preAiOf(pe) === true && KTAiBudget.preAiOf(te) === true && KTAiBudget.preAiOf(plainT) === false, 'P3-1: preAiOf: 接続の更新で止まった失敗（tokenStage）は AI を呼ぶ前。送った後の切断（印なし）は今まで通り AI を呼んだ扱い（終了不明）');
  //   実際の client（getToken が PAGE_EXPIRED を投げる）を KTAiBudget で包み、生成を 1 回送る
  const storage = makeStorage();
  storage.setItem(`ktAi.budget.v1.${HOST}`, JSON.stringify({ id: 'v1', limitUsd: 5, maxCalls: 100, createdAt: '2026-10-15T00:00:00Z' }));
  const budget = KTAiBudget.create({ storage, host: HOST, locks: null, sessionId: 'p-page' });
  let fetchN = 0;
  const client = KTAiClient.createAiClient({ apiBase: 'https://gw.test', hostname: HOST, getToken: async () => { const e = new KTAiClient.AiClientError({ code: C.PAGE_EXPIRED, message: PAGE_TEXT }); throw e; }, transport: KTAiClient.createDefaultTransport({ kintoneApi: null, fetchFn: async () => { fetchN += 1; return jsonResponse(200, {}); } }) });
  const wrapped = budget.wrap(client, { limits: () => null });
  let err = null; try { await wrapped.generate({ ctx: { customization: { customizationId: 'C3' }, size: { bytes: 2000 } } }); } catch (e) { err = e; }
  const led = JSON.parse(storage.getItem(`ktAi.budgetLedger.v1.${HOST}.v1`) || 'null');
  const entry = led && led.entries ? led.entries.slice(-1)[0] : null;
  assert(err && err.code === C.PAGE_EXPIRED && err.tokenStage === true && fetchN === 0 && entry && entry.status === 'released' && entry.reservedUsd === 0 && entry.reservedCalls === 0, `P3-2: 生成の前の接続の更新が PAGE_EXPIRED → Gateway へは送らない・確保は解放（有料の呼び出し 0 回・終了不明にしない）: ${JSON.stringify({ code: err && err.code, fetchN, entry: entry && [entry.status, entry.reservedUsd, entry.reservedCalls, entry.reason] })}`);
});

// =========================================================
console.log('\n--- §P4. 会話: C3 の前の接続の更新が PAGE_EXPIRED → 止める理由 page・C1 / C2 と計画を残す・回復後は C3 だけ ---');
const CUST1 = K.custOf(['lock']);
const CUST2 = K.custOf(['lock'], { customizationId: 'C2', requirement: '承認待ちでは金額を編集不可にする（2 つ目の画面）' });
const CUST3 = K.custOf(['lock'], { customizationId: 'C3', requirement: '承認待ちでは金額を編集不可にする（3 つ目の画面）' });
const planJs3 = (args) => {
  const r = K.planJs(args, { cust: CUST1 });
  for (const c of [CUST2, CUST3]) {
    r.plan.steps.push({ id: c.customizationId, actionType: 'CUSTOMIZATION_REQUIRED', targetKind: 'JS', targetRef: null, title: c.customizationId === 'C2' ? 'モバイルの編集制御' : 'モバイルの入力チェック', spec: { customizationId: c.customizationId }, dependsOn: [] });
    r.plan.customizations.push(clone(c));
    r.review.steps.push({ stepId: c.customizationId, status: 'VALID', safety: 'PLAN_ONLY', customization: clone(c), codeGeneration: { supported: true, strategy: 'NEW_JS_FILE', reason: null }, issues: [] });
    r.review.executionReadiness.planOnlySteps.push(c.customizationId);
  }
  return r;
};
function stagedGenerate(plan) {
  const base = makeGenerate({ sequence: ['good'] });
  const seen = [], n = {};
  const impl = async (args) => {
    const cid = args.customizationId;
    n[cid] = (n[cid] || 0) + 1;
    const list = plan[cid] || ['good'];
    const what = list[Math.min(n[cid] - 1, list.length - 1)];
    seen.push({ cid, what });
    if (what === 'page') { const e = new KTAiClient.AiClientError({ code: C.PAGE_EXPIRED, message: PAGE_TEXT, details: { pageExpired: true, direct: 'failed' } }); e.tokenStage = true; throw e; }
    return base.impl(args);
  };
  return { impl, calls: base.calls, seen, count: (cid) => seen.filter(x => x.cid === cid).length };
}
const sendUntilAdopt = async (x) => { for (const s of K.REQUESTS.slice(0, 3)) await x.c.send(s); return x.c.send(K.REQUESTS[3]); };
const restButtonOf = (h) => { const m = /<button[^>]*data-act="choice"[^>]*data-intent="GENERATE_CODE"[^>]*>([^<]*)<\/button>/.exec(h); return m ? { html: m[0], disabled: /\sdisabled/.test(m[0]) } : null; };
await section(async () => {
  const gen = stagedGenerate({ C1: ['good'], C2: ['good'], C3: ['page', 'good'] });
  const x = makeConvC({ planImpl: planJs3, generate: gen });
  await sendUntilAdopt(x);
  const v = x.c.activePlan();
  const inc = v.final && v.final.incomplete;
  assert(v.generated.C1.status === 'verified' && v.generated.C2.status === 'verified' && v.generated.C3.status === 'failed' && v.generated.C3.failure.reason === C.PAGE_EXPIRED && v.generated.C3.failure.stop === 'page' && !v.generated.C3.failure.endUnknown && inc && inc.kind === 'page' && inc.stoppedAt === 'C3' && FS.readyOf(v) === false, `P4-1: C3 の前の接続の更新が PAGE_EXPIRED → 止める理由 page（終了不明にしない）。C1 / C2 は検証済みのまま・C3 の失敗の記録を残す: ${JSON.stringify({ C3: v.generated.C3.failure, inc })}`);
  const h = finalHtml(x), vis = visibleText(h);
  const b = restButtonOf(h);
  assert(/JavaScript・モバイルの編集制御はできました。モバイルの入力チェックの作成中に、このページの有効期限が切れ、AIとの接続を更新できませんでした。/.test(vis) && /作成済みの内容はこの画面に残っています。再読み込みすると、この会話は失われます。/.test(vis) && /残り 1 件から再開できます。/.test(vis) && b && !b.disabled && !/接続解除|Nest Rec AIに接続|再読み込みしてください|契約/.test(vis) && !/PAGE_EXPIRED|CB_CS01|token/i.test(vis), `P4-2: 作成途中のカード: できたもの・止めたもの・ページの有効期限の理由・作成済みの内容が残ること・再読み込みで会話が失われること（再読み込みや再接続を勧めない。内部の値・契約の語は出さない）: ${vis.replace(/\s+/g, ' ').slice(0, 300)}`);
  assert(x.calls.ask.length === 0 && (v.openQuestions || []).length === 0 && !x.c.messages().some(m => m.type === 'ERROR'), 'P4-3: 失敗を新しい確認（質問・エラーのカード）に変えない');
  const hashes = [v.generated.C1.candidateHash, v.generated.C2.candidateHash];
  //   回復した後（接続の更新が通る）に［残りの JavaScript を作る］→ C3 だけ
  await x.c.send('コードを作って', { intentOverride: I.GENERATE_CODE, displayText: '残りの JavaScript を作る' });
  const v2 = x.c.activePlan();
  assert(x.calls.plan.length === 1 && gen.count('C1') === 1 && gen.count('C2') === 1 && gen.count('C3') === 2 && v2.generated.C1.reused === true && v2.generated.C2.reused === true && v2.generated.C1.candidateHash === hashes[0] && v2.generated.C2.candidateHash === hashes[1] && v2.generated.C3.status === 'verified' && FS.readyOf(v2) === true, `P4-4: 回復後の［残りの JavaScript を作る］→ 計画の AI 0 回・C1 / C2 は流用（検証結果もそのまま）・C3 だけ生成 → 承認できる最終案: ${JSON.stringify({ plans: x.calls.plan.length, seen: gen.seen.map(s => `${s.cid}:${s.what}`) })}`);
});
await section(async () => {
  const S = KTAiConversation;
  const te = new KTAiClient.AiClientError({ code: C.TRANSPORT_ERROR, message: 'x' }); te.tokenStage = true;
  const pe = new KTAiClient.AiClientError({ code: C.PAGE_EXPIRED, message: PAGE_TEXT });
  const se = new KTAiClient.AiClientError({ code: C.SESSION_EXPIRED, message: 'x' }); se.tokenStage = true;
  assert(S.stopKindOf(pe) === 'page' && S.stopKindOf(te) === 'token' && S.stopKindOf(se) === 'auth' && S.stopKindOf(new KTAiClient.AiClientError({ code: C.TRANSPORT_ERROR, message: 'x' })) === 'disconnected' && S.STOP_KINDS.includes('page') && S.STOP_KINDS.includes('token') && !S.stopEndUnknown('page') && !S.stopEndUnknown('token') && S.callEndOf(pe) === 'error', 'P4-5: 止める理由: PAGE_EXPIRED → page・接続の更新の通信の失敗 → token・更新で認証が切れた → auth（どれも終了不明にしない）。送った後の切断は今まで通り disconnected');
  assert(typeof S.STOP_REASON_JA.page === 'string' && typeof S.STOP_REASON_JA.token === 'string' && /AI には送っていません/.test(S.STOP_REASON_JA.token), 'P4-6: 理由の文がある（接続の更新の失敗は「AI には送っていません」と書く）');
});

// =========================================================
console.log('\n--- §P5. 画面: ヘッダー・接続の欄・状態の文（「利用できません」・契約切れにまとめない）---');
await section(async () => {
  const cap = { available: false, reason: C.PAGE_EXPIRED };
  const st = KTContextUi.capabilityStatusText(cap);
  const head = stripC(KTAiChatUi.headerHtml({ app: { name: 'P', id: 1 }, connection: { paidEnabled: true, connected: true, available: false, checking: false, reason: C.PAGE_EXPIRED, text: st } }));
  const headOther = stripC(KTAiChatUi.headerHtml({ app: { name: 'P', id: 1 }, connection: { paidEnabled: true, connected: true, available: false, checking: false, reason: C.TRANSPORT_ERROR, text: '' } }));
  const lines = stripC(KTContextUi.sessionLinesHtml({ connected: true, scope: { domain: HOST }, refreshExpiresAt: '2099-01-01T00:00:00Z' }, cap));
  assert(st === PAGE_TEXT && KTAiClient.ERROR_TEXT.PAGE_EXPIRED === PAGE_TEXT && !/契約|接続してください/.test(st), `P5-1: 状態の文は指示書の文のまま（契約・再接続を勧めない）: ${st}`);
  assert(/AI ページの有効期限切れ/.test(head) && !/AI 利用できません/.test(head) && /AI 利用できません/.test(headOther), `P5-2: ヘッダーは「AI ページの有効期限切れ」（ほかの理由は今まで通り「利用できません」）: ${head.replace(/\s+/g, ' ').slice(0, 160)}`);
  assert(/契約—（このページからは確かめられません）/.test(lines.replace(/\s+/g, '')) && /対処接続解除・再接続では回復しません/.test(lines.replace(/\s+/g, '')) && (lines.match(/有効期限が切れ、AIとの接続/g) || []).length === 1, `P5-3: 接続の欄: 契約の欄にページの文を出さない・回復しない操作を勧めない（文は AI Assistant の欄に 1 回）: ${lines.replace(/\s+/g, ' ')}`);
  assert(KTAiClient.errorCategory(C.PAGE_EXPIRED) === 'page' && KTAiClient.CATEGORY_JA.page === 'ページの有効期限' && KTAiClient.errorCategory(C.SESSION_EXPIRED) === 'auth', 'P5-4: エラーの種類は page（接続・認証や契約の種類にしない）');
});
await section(async () => {
  //   レビューの指摘 4（2026-10-15）: health の取得が PAGE_EXPIRED になっても、生成済みの検証結果・承認できる最終案を消さない（画面の能力の取り直し）
  const flag = { page: false };
  const pageErr = () => new KTAiClient.AiClientError({ code: C.PAGE_EXPIRED, message: PAGE_TEXT, details: { pageExpired: true, direct: 'failed' } });
  const sg = K.screenGenerate({ field: 'case_name', targetFile: 'caseLock.js' });
  const m = K.mount({ health: K.HEALTH_V, planImpl: K.planImplOf(K.screenPlan('js')), generateImpl: sg.impl, clientWrap: (c) => ({ ...c, getHealth: async () => { if (flag.page) throw pageErr(); return c.getHealth(); } }) });
  await K.ticks();
  const v0 = await K.adoptOnScreen(m); await K.ticks(20);
  const before = v0 && v0.final ? { approvable: FS.readyOf(v0), gen: Object.fromEntries(Object.entries(v0.generated || {}).map(([k, r]) => [k, r && r.status])) } : null;
  flag.page = true;
  const cap = await m.panel.refreshCapability({ force: true }); await K.ticks(4);
  const v1 = m.conv().activePlan();
  const after = v1 && v1.final ? { approvable: FS.readyOf(v1), gen: Object.fromEntries(Object.entries(v1.generated || {}).map(([k, r]) => [k, r && r.status])) } : null;
  const head = stripC(m.$('kt-ai-header').innerHTML);
  assert(before && before.approvable === true && cap && cap.available === false && cap.reason === C.PAGE_EXPIRED && after && JSON.stringify(after) === JSON.stringify(before) && v1 === v0, `P5-5: health が PAGE_EXPIRED になっても、生成済みの検証結果と承認できる最終案はそのまま（会話・計画も同じもの）: ${JSON.stringify({ before, after, cap })}`);
  assert(/AI ページの有効期限切れ/.test(head) && !/AI 利用できません/.test(head), `P5-6: 画面のヘッダーは「AI ページの有効期限切れ」: ${head.replace(/\s+/g, ' ').slice(0, 120)}`);
});

// =========================================================
console.log('\n--- §P6. 要求の前後の境界: 接続の更新の前で止まった失敗だけに印。送った後の失敗には付けない ---');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
await section(async () => {
  //   (a) Gateway が AUTH_TOKEN_EXPIRED（AI は呼んでいない）→ 接続の更新が失敗 → 印あり
  const expired = jsonResponse(401, { ok: false, error: { code: 'AUTH_TOKEN_EXPIRED', message: 'expired' } });
  const ca = KTAiClient.createAiClient({ apiBase: 'https://gw.test', hostname: HOST, getToken: async () => 'AT-old', onAuthExpired: async () => { throw new KTAiClient.AiClientError({ code: C.PAGE_EXPIRED, message: PAGE_TEXT, details: { pageExpired: true, direct: 'failed' } }); }, transport: async () => ({ status: 401, body: await expired.text() }) });
  let ea = null; try { await ca.getHealth(); } catch (e) { ea = e; }
  assert(ea && ea.code === C.PAGE_EXPIRED && ea.tokenStage === true && KTAiConversation.stopKindOf(ea) === 'page' && KTAiBudget.preAiOf(ea) === true, `P6-1: AUTH_TOKEN_EXPIRED の後の接続の更新の失敗には印（AI を呼んでいない・確保を解放）: ${JSON.stringify({ code: ea && ea.code, tokenStage: ea && ea.tokenStage })}`);
  //   (b) 更新は成功 → 再送した要求が送った後に切れた → 印なし（AI を呼んだかもしれない。終了不明）
  let n = 0;
  const cb = KTAiClient.createAiClient({ apiBase: 'https://gw.test', hostname: HOST, getToken: async () => (n ? 'AT-new' : 'AT-old'), onAuthExpired: async () => { n += 1; return true; }, transport: async () => { if (!n) return { status: 401, body: await expired.text() }; throw new TypeError('network error'); } });
  let eb = null; try { await cb.getHealth(); } catch (e) { eb = e; }
  assert(eb && eb.code === C.TRANSPORT_ERROR && eb.tokenStage !== true && KTAiConversation.stopKindOf(eb) === 'disconnected' && KTAiBudget.preAiOf(eb) === false, `P6-2: 更新の後に再送した要求が送った後に切れた → 印を付けない（切断・終了不明・確保は解放しない）: ${JSON.stringify({ code: eb && eb.code, tokenStage: eb && eb.tokenStage })}`);
  //   (c) 更新は成功したが、再送の時間が残っていない → 印あり（再送していない）・理由の文は「接続の更新の途中で止まりました」（更新できなかったとは書かない）
  const cc = KTAiClient.createAiClient({ apiBase: 'https://gw.test', hostname: HOST, timeoutMs: 40, getToken: async () => 'AT', onAuthExpired: async () => { await sleep(80); return true; }, transport: async () => ({ status: 401, body: await expired.text() }) });
  let ec = null; try { await cc.getHealth(); } catch (e) { ec = e; }
  assert(ec && ec.code === C.TIMEOUT && ec.tokenStage === true && KTAiConversation.stopKindOf(ec) === 'token' && /接続の更新の途中で止まりました/.test(KTAiConversation.STOP_REASON_JA.token) && !/更新できませんでした/.test(KTAiConversation.STOP_REASON_JA.token) && KTAiBudget.preAiOf(ec) === true, `P6-3: 更新の後に再送の時間が残っていない → 印あり（再送していない）・理由は「接続の更新の途中で止まりました」: ${JSON.stringify({ code: ec && ec.code, kind: KTAiConversation.stopKindOf(ec) })}`);
});
await section(async () => {
  //   (d) AI を呼ぶ要求（kintone.proxy を先に使う質問）: proxy の CB_CS01 → 直接送った後に失敗 → PAGE_EXPIRED（印なし）→ 通信の切断（終了不明）・確保は解放しない
  const client = KTAiClient.createAiClient({ apiBase: 'https://gw.test', hostname: HOST, getToken: async () => 'AT', transport: KTAiClient.createDefaultTransport({ kintoneApi: { proxy: async () => { throw CB_CS01; } }, fetchFn: async () => { throw new TypeError('network error'); } }) });
  let e = null; try { await client.getHealth(); } catch (x) { e = x; }
  assert(e && e.code === C.PAGE_EXPIRED && e.tokenStage !== true && e.details.direct === 'failed' && KTAiConversation.stopKindOf(e) === 'disconnected' && KTAiConversation.stopEndUnknown(KTAiConversation.stopKindOf(e)) && KTAiBudget.preAiOf(e) === false, `P6-4: 接続の更新の前でない PAGE_EXPIRED（直接送った後に失敗）は、AI に届いた可能性がある → 切断・終了不明（確保は解放しない）: ${JSON.stringify({ code: e && e.code, kind: e && KTAiConversation.stopKindOf(e) })}`);
  const pe = new KTAiClient.AiClientError({ code: C.PAGE_EXPIRED, message: PAGE_TEXT, details: { pageExpired: true, direct: 'unavailable' } });
  assert(KTAiConversation.stopKindOf(pe) === 'page', 'P6-5: 直接送れなかった（unavailable）PAGE_EXPIRED は page（Gateway へは何も送っていない）');
});

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
if (state.failed) process.exit(1);
})();
