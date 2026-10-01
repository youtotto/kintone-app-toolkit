// tokenless connect（Browser Authorization Session）: KTAiClient.createConnectFlow ＋ mountAiDocsPanel の接続 UI
//
// 検証内容:
//   - PKCE: verifier は memory のみ・Gateway には S256 challenge だけ・complete で verifier を送る
//   - start → authorizeUrl（Gateway 生成）を別タブで開く → status を polling（pending → authorized）→ complete → session.adopt
//   - Access は memory・Refresh だけ永続 / reload 後は Refresh で復帰（Wix ログインを再要求しない）
//   - popup blocked → 「Nest Recのページを開く」で再度開ける
//   - cancel / denied / expired / 不明 session / Gateway 停止（transient は継続、連続失敗で中止）
//   - disconnect: local を消し、Gateway の /v2/connect/disconnect で family を失効
//   - UI: 本番は「Nest Rec AIに接続」だけ（Customer Token 入力欄なし）、接続中の表示、接続完了、無料機能は影響なし
//   - credential 文字列（Access / Refresh / verifier）が UI・store に出ない
//
// 実行方法: node tests/ai-connect.test.js
'use strict';
const nodeCrypto = require('crypto');
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const { makeFakeHost } = require('./helpers/fake-dom.js');
const { KTAiClient, mountAiDocsPanel, KTDeps, KTScan, KTContext } = loadToolkit();
const { assert, state } = makeAssert();
const C = KTAiClient.ERROR_CODES;
const cryptoObj = nodeCrypto.webcrypto;

const makeStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), dump: () => [...m.entries()].map(([k, v]) => `${k}=${v}`).join('\n') }; };
const b64url = (b) => Buffer.from(b).toString('base64url');
const sha256 = (t) => b64url(nodeCrypto.createHash('sha256').update(t).digest());

/** Gateway の connect / exchange / health を模す transport（D1 の代わりに Map） */
function makeGateway({ now = () => Date.now(), ttlSec = 600, pollSec = 2, authorizeUrl = 'https://www.nestrec.com/ai-connect', down = false } = {}) {
  const sessions = new Map();
  const access = new Map(), refresh = new Map(), revokedFamilies = new Set();
  const reqs = [];
  let seq = 0;
  const err = (status, code, extra = {}) => ({ status, body: JSON.stringify({ ok: false, contractVersion: '2.1', error: { code, message: code, requestId: 'e-1', ...extra } }) });
  const issue = (familyId) => {
    const a = `v1.AT-${++seq}.sig`, r = `v1.RT-${++seq}.sig`;
    const aExp = new Date(now() + 2700 * 1000).toISOString(), rExp = new Date(now() + 14 * 86400 * 1000).toISOString();
    access.set(a, { exp: aExp, familyId }); refresh.set(r, { exp: rExp, used: false, familyId });
    return { ok: true, contractVersion: '2.1', tokenType: 'Bearer', accessToken: a, expiresAt: aExp, expiresInSec: 2700, refreshToken: r, refreshExpiresAt: rExp, scope: { customerId: 'wix-1', domain: 'h', product: 'toolkit', feature: 'assistant-qa', tokenId: `at_${seq}`, familyId }, customer: { plan: 'pro', monthlyLimit: 100, expiresAt: '2099-01-01T00:00:00Z' } };
  };
  const transport = async (req) => {
    reqs.push(req);
    if (down) throw new Error('ECONNREFUSED');
    const u = new URL(req.url);
    const b = req.body ? JSON.parse(req.body) : {};
    if (u.pathname === '/v2/connect/start') {
      if (b.codeChallengeMethod !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(b.codeChallenge || '')) return err(422, 'INVALID_ENVELOPE');
      if (b.domain !== req.headers['X-Kintone-Domain']) return err(403, 'AUTH_DOMAIN_MISMATCH');
      const sessionId = `cs_${++seq}_${'x'.repeat(20)}`;
      sessions.set(sessionId, { status: 'PENDING', challenge: b.codeChallenge, domain: b.domain, exp: now() + ttlSec * 1000 });
      return { status: 200, body: JSON.stringify({ ok: true, sessionId, authorizeUrl: `${authorizeUrl}?session=${sessionId}`, expiresAt: new Date(now() + ttlSec * 1000).toISOString(), pollIntervalSeconds: pollSec }) };
    }
    if (u.pathname === '/v2/connect/status') {
      const s = sessions.get(u.searchParams.get('session'));
      if (!s) return err(404, 'NOT_FOUND');
      const st = (s.status === 'PENDING' || s.status === 'AUTHORIZED') && now() >= s.exp ? 'expired' : s.status.toLowerCase();
      return { status: 200, body: JSON.stringify({ ok: true, status: st, pollIntervalSeconds: pollSec }) };
    }
    if (u.pathname === '/v2/connect/complete') {
      const s = sessions.get(b.sessionId);
      if (!s) return err(404, 'NOT_FOUND');
      if (s.status === 'CONSUMED') return err(401, 'AUTH_INVALID_TOKEN', { detail: { status: 'consumed' } });
      if (s.status !== 'AUTHORIZED') return err(422, 'INVALID_ENVELOPE', { detail: { status: s.status.toLowerCase() } });
      if (sha256(b.codeVerifier || '') !== s.challenge) return err(401, 'AUTH_INVALID_TOKEN', { detail: { reason: 'pkce_mismatch' } });
      s.status = 'CONSUMED';
      return { status: 200, body: JSON.stringify(issue(`fam_${b.sessionId}`)) };
    }
    if (u.pathname === '/v2/connect/disconnect') {
      const r = refresh.get(b.refreshToken);
      if (!r) return err(401, 'AUTH_INVALID_TOKEN');
      revokedFamilies.add(r.familyId);
      return { status: 200, body: JSON.stringify({ ok: true, revoked: ['family'] }) };
    }
    if (u.pathname === '/v2/token/exchange') {
      const r = refresh.get(b.refreshToken);
      if (!r || r.used || revokedFamilies.has(r.familyId)) return err(401, 'AUTH_INVALID_TOKEN');
      r.used = true;
      return { status: 200, body: JSON.stringify(issue(r.familyId)) };
    }
    const bearer = (req.headers.Authorization || '').replace(/^Bearer /, '');
    const a = access.get(bearer);
    if (!a || revokedFamilies.has(a.familyId)) return err(401, 'AUTH_INVALID_TOKEN');
    if (u.pathname === '/v2/health') return { status: 200, body: JSON.stringify({ ok: true, supportedContractVersions: ['2.0', '2.1'], entitlements: [{ product: 'toolkit', features: ['assistant-qa'] }], registry: { toolkit: { 'assistant-qa': { implemented: true, promptVersions: ['1'] } } }, usage: { yyyymm: '202610', monthlyLimit: 100, usedThisMonth: 6, remainingThisMonth: 94 }, tokenExpiresAt: '2026-10-02T00:45:00Z', contractExpiresAt: '2099-01-01T00:00:00Z', auth: { type: 'access_token' } }) };
    return err(404, 'NOT_FOUND');
  };
  return { transport, reqs, sessions, access, refresh, revokedFamilies, approve: (sid) => { sessions.get(sid).status = 'AUTHORIZED'; }, deny: (sid) => { sessions.get(sid).status = 'DENIED'; } };
}
const sleepNone = async () => { };
const sleepTick = () => new Promise(r => setTimeout(r, 0));   // UI テストでは外側（テスト側）が割り込めるよう macrotask で待つ
const tick = () => new Promise(r => setTimeout(r, 0));

(async () => {
console.log('\n--- 1. PKCE ---');
{
  const p = await KTAiClient.createPkce({ cryptoObj });
  assert(/^[A-Za-z0-9_-]{43}$/.test(p.verifier) && /^[A-Za-z0-9_-]{43}$/.test(p.challenge) && p.challenge === sha256(p.verifier), 'verifier 32 byte / challenge = base64url(sha256(verifier))');
  const p2 = await KTAiClient.createPkce({ cryptoObj });
  assert(p2.verifier !== p.verifier, '毎回異なる');
  let threw = null; try { await KTAiClient.createPkce({ cryptoObj: null }); } catch (e) { threw = e; }
  assert(threw && threw.code === C.TRANSPORT_ERROR, 'crypto が無い環境では開始しない');
}

console.log('\n--- 2. connect flow（start → open → polling → complete → adopt）---');
{
  const storage = makeStorage();
  const store = KTAiClient.createSettingsStore({ storage, host: 'h' });
  const gw = makeGateway();
  const session = KTAiClient.createSession({ store, hostname: 'h', transport: gw.transport, apiBase: 'https://gw.test' });
  const opened = [];
  const states = [];
  // 2 回 pending を返してから承認する
  let polls = 0;
  const origTransport = gw.transport;
  let flow2 = null;
  const transport2 = async (req) => { if (req.url.includes('/v2/connect/status')) { polls++; if (polls === 3) gw.approve(flow2.state().sessionId); } return origTransport(req); };
  flow2 = KTAiClient.createConnectFlow({ session, hostname: 'h', transport: transport2, sleep: sleepNone, openUrl: (u) => { opened.push(u); return true; }, cryptoObj });
  const ex = await flow2.start({ onState: (st) => states.push(st.phase) });
  const startReq = gw.reqs.find(r => r.url.endsWith('/v2/connect/start'));
  const startBody = JSON.parse(startReq.body);
  assert(startReq.method === 'POST' && !startReq.headers.Authorization && startBody.domain === 'h' && startBody.product === 'toolkit' && startBody.feature === 'assistant-qa' && startBody.codeChallengeMethod === 'S256' && /^[A-Za-z0-9_-]{43}$/.test(startBody.codeChallenge), 'start: Bearer 無し・domain / product / feature / S256 challenge（Customer Token は送らない）');
  assert(opened.length === 1 && opened[0].startsWith('https://www.nestrec.com/ai-connect?session=cs_'), 'authorizeUrl（Gateway 生成）を別タブで開く');
  assert(polls === 3 && gw.reqs.filter(r => r.url.includes('/v2/connect/status')).length === 3, 'pending の間 polling を続け、authorized で止める');
  const completeReq = gw.reqs.find(r => r.url.endsWith('/v2/connect/complete'));
  const cb = JSON.parse(completeReq.body);
  assert(cb.sessionId === flow2.state().sessionId && sha256(cb.codeVerifier) === startBody.codeChallenge, 'complete: sessionId ＋ verifier（challenge と対応）');
  assert(JSON.stringify(states) === JSON.stringify(['starting', 'pending', 'completing', 'connected']), 'onState: starting → pending → completing → connected');
  assert(ex.accessToken && session.status().connected && session.status().scope.customerId === 'wix-1' && flow2.state().customer.plan === 'pro', 'session.adopt: 接続済み・scope / customer');
  const dump = storage.dump();
  assert(dump.includes(ex.refreshToken) && !dump.includes(ex.accessToken) && !dump.includes(cb.codeVerifier), 'Refresh だけ永続・Access と verifier は保存しない');
  const h = await session.client.getHealth();
  const healthReq = gw.reqs[gw.reqs.length - 1];
  assert(h.ok && healthReq.headers.Authorization === `Bearer ${ex.accessToken}`, '以後の /v2 は Access Token（memory）で呼ぶ');
  assert(!gw.reqs.some(r => (r.headers.Authorization || '').includes('RT-')), 'Refresh Token を Bearer に使わない');
  // reload 復帰: 新しい session（memory 無し）→ Refresh で Access を再取得。Wix の承認ページは開かない
  const s2 = KTAiClient.createSession({ store: KTAiClient.createSettingsStore({ storage, host: 'h' }), hostname: 'h', transport: gw.transport, apiBase: 'https://gw.test' });
  const before = opened.length;
  const h2 = await s2.client.getHealth();
  const exReq = gw.reqs.filter(r => r.url.endsWith('/v2/token/exchange')).pop();
  assert(h2.ok && JSON.parse(exReq.body).grantType === 'refresh_token' && opened.length === before && !gw.reqs.slice(-3).some(r => r.url.includes('/v2/connect/start')), 'reload 後は Refresh で自動復帰（承認ページ・start は呼ばない）');
  assert(s2.status().connected && storage.dump().includes('RT-') && !storage.dump().includes(ex.refreshToken), 'rotation: 新しい Refresh を保存し古いものは残らない');
  // disconnect: local を消し、Gateway の family を失効
  const rtBefore = store.load().refreshToken;
  const r = await s2.disconnect();
  const dReq = gw.reqs.filter(r => r.url.endsWith('/v2/connect/disconnect')).pop();
  assert(r.revoked === true && dReq && JSON.parse(dReq.body).refreshToken === rtBefore && !s2.status().connected && storage.dump() === '' && gw.revokedFamilies.size === 1, 'disconnect: /v2/connect/disconnect に Refresh を送って family 失効・local は空');
  let after = null; try { await s2.client.getHealth(); } catch (e) { after = e; }
  assert(after && after.code === C.NOT_CONNECTED, 'disconnect 後は NOT_CONNECTED');
  // 実機で発生: apiBase を store だけが持つ構成で disconnect すると、store.clear() の後に接続先が既定（production）に戻り、
  // 失効 request が別の Gateway へ飛んでいた。store を消す前の接続先へ送ること
  const st3 = makeStorage();
  const gw3 = makeGateway();
  const sess3 = KTAiClient.createSession({ store: KTAiClient.createSettingsStore({ storage: st3, host: 'h' }), hostname: 'h', transport: gw3.transport });   // apiBase は渡さない
  const flow3 = KTAiClient.createConnectFlow({ session: sess3, hostname: 'h', transport: gw3.transport, sleep: sleepNone, cryptoObj, openUrl: () => true });
  sess3.adopt({ accessToken: 'x', expiresAt: new Date(Date.now() + 1000).toISOString(), refreshToken: 'x', refreshExpiresAt: new Date(Date.now() + 1000).toISOString(), scope: {} }, { apiBase: 'https://staging.test' });
  await flow3.start({ onState: (st) => { if (st.phase === 'pending') gw3.approve(st.sessionId); } });
  const r3 = await sess3.disconnect();
  const d3 = gw3.reqs.filter(r => r.url.endsWith('/v2/connect/disconnect')).pop();
  assert(r3.revoked === true && d3 && d3.url === 'https://staging.test/v2/connect/disconnect', 'disconnect は store に保存していた接続先（staging）へ送る（既定 URL へ飛ばない）');
}

console.log('\n--- 3. popup blocked / cancel / denied / expired / 不明 / Gateway 停止 ---');
{
  const mk = (gwOpts = {}, flowOpts = {}) => {
    const storage = makeStorage();
    const session = KTAiClient.createSession({ store: KTAiClient.createSettingsStore({ storage, host: 'h' }), hostname: 'h', apiBase: 'https://gw.test' });
    const gw = makeGateway(gwOpts);
    const opened = [];
    const flow = KTAiClient.createConnectFlow({ session, hostname: 'h', transport: gw.transport, sleep: sleepNone, cryptoObj, openUrl: (u) => { opened.push(u); return flowOpts.blocked ? false : true; }, ...flowOpts });
    return { storage, session, gw, flow, opened };
  };
  {
    const t = mk({}, { blocked: true });
    const states = [];
    let n = 0;
    const p = t.flow.start({ onState: (s) => { states.push(s); if (s.phase === 'pending' && n++ === 0) { assert(s.popupBlocked === true, 'popup blocked を state で通知'); assert(t.flow.reopen() === false && t.opened.length === 2, 'reopen で同じ authorizeUrl をもう一度開く（block 時は false）'); t.gw.approve(s.sessionId); } } });
    const ex = await p;
    assert(ex.accessToken && t.session.status().connected, 'block されても承認後に接続できる');
  }
  {
    const t = mk();
    const p = t.flow.start({ onState: (s) => { if (s.phase === 'pending') t.flow.cancel(); } });
    let e = null; try { await p; } catch (x) { e = x; }
    assert(e && e.code === C.CONNECT_CANCELLED && !t.session.status().connected && t.flow.state().phase === 'failed' && t.flow.isRunning() === false, 'cancel → CONNECT_CANCELLED・未接続のまま');
    const again = t.flow.start({ onState: (s) => { if (s.phase === 'pending') t.gw.approve(s.sessionId); } });
    assert((await again).accessToken, 'cancel 後にもう一度開始できる');
  }
  {
    const t = mk();
    let e = null; try { await t.flow.start({ onState: (s) => { if (s.phase === 'pending') t.gw.deny(s.sessionId); } }); } catch (x) { e = x; }
    assert(e && e.code === C.CONNECT_DENIED && !t.session.status().connected && KTAiClient.errorText(C.CONNECT_DENIED).includes('キャンセル'), 'denied → CONNECT_DENIED');
  }
  {
    let now = Date.now();
    const t = mk({ now: () => now, ttlSec: 5 }, { nowFn: () => now });
    let e = null; try { await t.flow.start({ onState: (s) => { if (s.phase === 'pending') now += 6000; } }); } catch (x) { e = x; }
    assert(e && e.code === C.CONNECT_EXPIRED, 'session TTL 経過 → CONNECT_EXPIRED（polling を止める）');
  }
  {
    const t = mk();
    let e = null; try { await t.flow.start({ onState: (s) => { if (s.phase === 'pending') t.gw.sessions.delete(s.sessionId); } }); } catch (x) { e = x; }
    assert(e && e.code === C.NOT_FOUND, '不明 session（404）→ NOT_FOUND で中止');
  }
  {
    const t = mk({ down: true });
    let e = null; try { await t.flow.start(); } catch (x) { e = x; }
    assert(e && e.code === C.TRANSPORT_ERROR && t.opened.length === 0 && !t.session.status().connected, 'Gateway 停止: start で失敗（承認ページは開かない）');
    // polling 中の一時的な失敗は続行し、連続 6 回で中止
    const t2 = mk();
    let fails = 0;
    const orig = t2.gw.transport;
    const flaky = async (req) => { if (req.url.includes('/v2/connect/status') && fails < 3) { fails++; throw new Error('net'); } return orig(req); };
    const flow = KTAiClient.createConnectFlow({ session: t2.session, hostname: 'h', transport: flaky, sleep: sleepNone, cryptoObj, openUrl: () => true });
    const ex = await flow.start({ onState: (s) => { if (s.phase === 'pending') t2.gw.approve(s.sessionId); } });
    assert(ex.accessToken && fails === 3, 'polling の一時的な失敗（3 回）は続行して接続できる');
    const t3 = mk();
    const dead = async (req) => { if (req.url.includes('/v2/connect/status')) throw new Error('net'); return t3.gw.transport(req); };
    const flow3 = KTAiClient.createConnectFlow({ session: t3.session, hostname: 'h', transport: dead, sleep: sleepNone, cryptoObj, openUrl: () => true });
    let e3 = null; try { await flow3.start(); } catch (x) { e3 = x; }
    assert(e3 && e3.code === C.TRANSPORT_ERROR, '連続して失敗し続ける polling は中止（TRANSPORT_ERROR）');
  }
  {
    const t = mk();
    const orig = t.gw.transport;
    let rl = 0;
    const limited = async (req) => { if (req.url.includes('/v2/connect/status') && rl++ === 0) return { status: 429, body: JSON.stringify({ ok: false, contractVersion: '2.1', error: { code: 'RATE_LIMITED', message: 'm', requestId: 'e', retryAfterSeconds: 7 } }) }; return orig(req); };
    const waits = [];
    const flow = KTAiClient.createConnectFlow({ session: t.session, hostname: 'h', transport: limited, sleep: async (ms) => { waits.push(ms); }, cryptoObj, openUrl: () => true });
    await flow.start({ onState: (s) => { if (s.phase === 'pending') t.gw.approve(s.sessionId); } });
    assert(waits[0] === 2000 && waits[1] === 7000, 'polling 間隔は Gateway 指定（2 秒）に従い、429 の retryAfterSeconds で広げる');
  }
}

console.log('\n--- 4. UI（mountAiDocsPanel）---');
{
  const FX = require('./fixtures/ai-context-app.js');
  const { buildScanPayload } = require('./helpers/scan-payload.js');
  const data = FX.makeData();
  const fieldsN = KTDeps.normalizeFields(data.fields);
  const deps = KTDeps.buildDependencyData(data, fieldsN);
  const scan = buildScanPayload({ KTScan, KTDeps }, { appId: FX.SELF_APP, files: FX.files, fields: fieldsN.map(f => ({ code: f.code, label: f.label, type: f.rawType })), deps, skippedUrlFiles: FX.skippedUrlFiles });
  KTDeps.mergeScannerEdges(deps, scan);
  KTDeps.applyIncomingRefs(deps, FX.incoming);
  const INPUTS = { data, deps, scan, incoming: FX.incoming };
  const mountUi = ({ gwOpts = {}, blocked = false, devMode = false, storage = makeStorage() } = {}) => {
    const settings = KTAiClient.createSettingsStore({ storage, host: 'h' });
    const session = KTAiClient.createSession({ store: settings, hostname: 'h', apiBase: 'https://gw.test', transport: null });
    const gw = makeGateway(gwOpts);
    // session の client / refresh も fake Gateway を使う
    const session2 = KTAiClient.createSession({ store: settings, hostname: 'h', apiBase: 'https://gw.test', transport: gw.transport });
    const opened = [];
    const flow = KTAiClient.createConnectFlow({ session: session2, hostname: 'h', transport: gw.transport, sleep: sleepTick, cryptoObj, openUrl: (u) => { opened.push(u); return !blocked; } });
    const host = makeFakeHost();
    const copies = [];
    mountAiDocsPanel(host, { getInputs: () => INPUTS, setPreview: () => { }, copyText: async (t) => { copies.push(t); return true; }, colors: { border: '#ccc', bg: '#fff' }, settings, session: session2, hostname: 'h', connectFlow: flow, devMode });
    const $ = (id) => host.querySelector(`#${id}`);
    return { host, $, gw, flow, opened, storage, settings, session: session2, copies };
  };
  {
    const u = mountUi();
    await tick();
    assert(u.$('kt-ai-connect').style.display === 'flex' && u.$('kt-ai-connecting').style.display === 'none' && u.$('kt-ai-session').style.display === 'none' && u.$('kt-ai-dev').style.display === 'none' && u.$('kt-ai-conn-badge').textContent === '未接続', '未接続: 「Nest Rec AIに接続」だけ表示（Customer Token 入力欄・接続中表示は無し）');
    assert(u.host.innerHTML.includes('>Nest Rec AIに接続<') && u.host.innerHTML.includes('接続しなくても無料で利用できます'), '本番 UI の文言');
    // 接続ボタン → start → 承認待ち表示 → 承認 → 自動で接続完了
    let pendingSeen = null;
    const clickP = u.$('kt-ai-connect-start').dispatch('click');
    await tick(); await tick();
    pendingSeen = { connecting: u.$('kt-ai-connecting').style.display, text: u.$('kt-ai-connecting-text').textContent, badge: u.$('kt-ai-conn-badge').textContent, connect: u.$('kt-ai-connect').style.display };
    const sid = u.flow.state().sessionId;
    u.gw.approve(sid);
    await clickP; await tick(); await tick();
    assert(pendingSeen.connecting === 'flex' && pendingSeen.connect === 'none' && pendingSeen.text.includes('Nest Recで接続を確認しています') && pendingSeen.badge === '接続中', '接続中: 「Nest Recで接続を確認しています...」・接続ボタンは隠れる');
    assert(u.opened.length === 1 && u.opened[0].includes(`session=${sid}`), '承認ページを開く');
    assert(u.$('kt-ai-session').style.display === 'flex' && u.$('kt-ai-connecting').style.display === 'none' && u.$('kt-ai-conn-badge').textContent === '✓ 接続済み' && u.$('kt-ai-paid-status').textContent.includes('Nest Rec AIに接続しました') && u.$('kt-ai-ask').disabled === false, '接続完了: ✓ 接続済み・AIに質問が有効');
    const lines = u.$('kt-ai-session-lines').innerHTML;
    assert(lines.includes('AI Assistant') && lines.includes('利用可能') && lines.includes('接続先') && lines.includes('>h<') && lines.includes('契約') && lines.includes('有効（') && lines.includes('2099') && !lines.includes('2026/10/2') && lines.includes('AI利用') && lines.includes('6 / 100'), '接続後の表示: AI Assistant / 接続先 / 契約（契約の期限であって Access の期限ではない）/ AI利用');
    const allText = u.host.innerHTML + u.$('kt-ai-paid-status').textContent + lines;
    assert(!/AT-\d|RT-\d|v1\.AT|v1\.RT/.test(allText), 'UI に Access / Refresh の文字列が出ない');
    // 接続解除
    await u.$('kt-ai-session-disconnect').dispatch('click'); await tick(); await tick();
    assert(u.$('kt-ai-connect').style.display === 'flex' && u.$('kt-ai-session').style.display === 'none' && u.$('kt-ai-ask').disabled === true && u.gw.revokedFamilies.size === 1 && u.storage.dump() === '' && u.$('kt-ai-paid-status').textContent.includes('接続を解除しました'), '接続解除: UI は未接続へ・Gateway family 失効・local 消去');
  }
  {
    const u = mountUi({ blocked: true });
    await tick();
    const clickP = u.$('kt-ai-connect-start').dispatch('click');
    await tick(); await tick();
    assert(u.$('kt-ai-connecting-text').textContent.includes('ポップアップをブロック'), 'popup blocked: 案内文');
    await u.$('kt-ai-open-authorize').dispatch('click');
    assert(u.opened.length === 2, '「Nest Recのページを開く」で再度開く');
    u.gw.deny(u.flow.state().sessionId);
    await clickP; await tick();
    assert(u.$('kt-ai-connect').style.display === 'flex' && u.$('kt-ai-connecting').style.display === 'none' && u.$('kt-ai-paid-status').textContent.includes('[CONNECT_DENIED]') && u.$('kt-ai-conn-badge').textContent === '未接続', 'denied: 未接続に戻り文言を表示');
  }
  {
    const u = mountUi();
    await tick();
    const clickP = u.$('kt-ai-connect-start').dispatch('click');
    await tick(); await tick();
    await u.$('kt-ai-connect-cancel').dispatch('click');
    await clickP; await tick();
    assert(u.$('kt-ai-connect').style.display === 'flex' && u.$('kt-ai-paid-status').textContent.includes('[CONNECT_CANCELLED]'), 'キャンセル: 未接続に戻る');
    // 無料機能は接続処理に関係なく使える
    u.$('kt-ai-target-type').value = 'app'; await u.$('kt-ai-target-type').dispatch('change');
    await u.$('kt-ai-generate').dispatch('click');
    await u.$('kt-ai-copy-prompt').dispatch('click');
    assert(u.copies.length === 1 && u.copies[0].includes('## Context'), '無料機能（生成・コピー）は接続状態に関係なく動く');
  }
  {
    const u = mountUi({ gwOpts: { down: true } });
    await tick();
    await u.$('kt-ai-connect-start').dispatch('click'); await tick();
    assert(u.$('kt-ai-paid-status').textContent.includes('[TRANSPORT_ERROR]') && u.$('kt-ai-connect').style.display === 'flex', 'Gateway 停止: 文言を表示して未接続のまま');
    await u.$('kt-ai-generate').dispatch('click');
    await u.$('kt-ai-copy-md').dispatch('click');
    assert(u.copies.length === 1, 'Gateway 停止でも無料機能は使える');
  }
  {
    // reload 復帰: 接続済みの storage で mount し直すと Refresh で復帰（承認ページを開かない）
    const storage = makeStorage();
    const u1 = mountUi({ storage });
    await tick();
    const p = u1.$('kt-ai-connect-start').dispatch('click'); await tick(); await tick();
    u1.gw.approve(u1.flow.state().sessionId); await p; await tick();
    const settings = KTAiClient.createSettingsStore({ storage, host: 'h' });
    const session = KTAiClient.createSession({ store: settings, hostname: 'h', apiBase: 'https://gw.test', transport: u1.gw.transport });
    const opened = [];
    const flow = KTAiClient.createConnectFlow({ session, hostname: 'h', transport: u1.gw.transport, sleep: sleepTick, cryptoObj, openUrl: (x) => { opened.push(x); return true; } });
    const host = makeFakeHost();
    mountAiDocsPanel(host, { getInputs: () => INPUTS, setPreview: () => { }, copyText: async () => true, colors: { border: '#ccc', bg: '#fff' }, settings, session, hostname: 'h', connectFlow: flow });
    await tick(); await tick(); await tick();
    const $ = (id) => host.querySelector(`#${id}`);
    assert($('kt-ai-session').style.display === 'flex' && $('kt-ai-ask').disabled === false && opened.length === 0 && u1.gw.reqs.filter(r => r.url.endsWith('/v2/token/exchange')).length === 1, 'reload 後: Refresh で復帰・承認ページは開かない');
  }
  {
    const u = mountUi({ devMode: true });
    await tick();
    assert(u.$('kt-ai-dev').style.display === 'flex' && u.host.innerHTML.includes('開発モード'), 'dev mode: Customer Token の旧方式を表示できる');
  }
}

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
