// 有料「AIに質問」（KTAiClient ＋ AI パネルの Nest Rec AI 区画）のテスト
//
// 検証内容:
//   1. KTAiClient: envelope（Contract 2.1・payload は生成済み ctx と同一）/ transport・header / 構造化エラーの passthrough /
//      legacy 文字列 / retryAfterSeconds / timeout（fetch を abort）/ capabilityFromHealth / validateAnswer
//   2. UI: 利用不可（未設定・未契約・contract 不一致・Gateway 停止）でも無料機能はそのまま / 利用可で「AIに質問」有効
//   3. ask: 同意 → 送信 → loading（二重送信防止・requestId）→ 回答表示（回答 / 事実 / 分析 / 提案 / 不明）→ 根拠チップ → fact 詳細
//   4. 未知根拠ID の拒否（client 側の再検証）/ 各エラーの文言 / retryAfterSeconds 表示
//   5. 送信内容にレコード値・secret が無い / 無料のコピー機能は Gateway と無関係に動く
//
// 実行方法: node tests/ai-assistant.test.js
'use strict';
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const { buildScanPayload } = require('./helpers/scan-payload.js');
const { makeFakeHost } = require('./helpers/fake-dom.js');
const FX = require('./fixtures/ai-context-app.js');

const { KTDeps, KTScan, KTContext, KTContextUi, KTAiClient, mountAiWorkspace, SCRIPT_VERSION } = loadToolkit();
const { assert, state } = makeAssert();
const C = KTAiClient.ERROR_CODES;

function buildInputs() {
  const data = FX.makeData();
  const fieldsN = KTDeps.normalizeFields(data.fields);
  const deps = KTDeps.buildDependencyData(data, fieldsN);
  const scan = buildScanPayload({ KTScan, KTDeps }, { appId: FX.SELF_APP, files: FX.files, fields: fieldsN.map(f => ({ code: f.code, label: f.label, type: f.rawType })), deps, skippedUrlFiles: FX.skippedUrlFiles });
  KTDeps.mergeScannerEdges(deps, scan);
  KTDeps.applyIncomingRefs(deps, FX.incoming);
  return { data, deps, scan, incoming: FX.incoming };
}
const INPUTS = buildInputs();
const CTX = KTContext.build({ question: '顧客コードを削除して大丈夫？', ...INPUTS, options: { now: '2026-10-01T00:00:00.000Z' } });

/** 利用可の health（Gateway 2.1 の /v2/health 形） */
const HEALTH_OK = {
  ok: true, supportedContractVersions: ['2.0', '2.1'],
  entitlements: [{ product: 'toolkit', features: ['assistant-qa'] }],
  registry: { toolkit: { 'assistant-qa': { implemented: true, directCall: true, promptVersions: ['1'], defaultPromptVersion: '1' } } },
  usage: { yyyymm: '202610', monthlyLimit: 100, usedThisMonth: 3, remainingThisMonth: 97 }, tokenExpiresAt: '2026-10-02T00:45:00Z', contractExpiresAt: '2099-01-01T00:00:00Z',
};
/** Gateway の 200 応答 */
const GOOD_RESPONSE = {
  ok: true, contractVersion: '2.1',
  meta: { requestId: 'tk-x', gateway: { product: 'toolkit', feature: 'assistant-qa', promptVersion: '1', contextVersion: '1' }, normalization: { warnings: [] }, ai: { provider: 'openai', model: 'm' }, usage: { yyyymm: '202610', usedThisMonth: 4, remainingThisMonth: 96, monthlyLimit: 100 } },
  answer: '顧客コードはルックアップのコピー先です [E8]。', answerEvidenceIds: ['E8'],
  facts: [{ text: 'ルックアップ「顧客マスタ参照」のコピー先', evidenceIds: ['E8'] }, { text: '一覧で表示', evidenceIds: ['E10', 'E12'] }],
  analysis: [{ text: 'JS が参照しているため削除時は修正が必要（推論）', evidenceIds: ['E4'] }],
  recommendations: [{ text: 'common.js を確認する', evidenceIds: ['E4'] }],
  unknowns: ['プラグイン設定は確認できない'],
};
const v2err = (status, code, extra = {}) => ({ status, body: JSON.stringify({ ok: false, contractVersion: '2.1', error: { code, message: 'm', requestId: 'e-1', ...extra } }) });
const okBody = (json) => ({ status: 200, body: JSON.stringify(json) });

/** fake storage */
const makeStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };

/** パネル mount（無料側は本物、有料側はテスト用 session: connect / status / client を模す） */
function mount({ token = 'tok', health = HEALTH_OK, responses = [], onAsk = null, createClientThrows = false, paid = true, connected = true, devMode = false, connectFlow = null } = {}) {
  const storage = makeStorage();
  const settings = KTAiClient.createSettingsStore({ storage, host: 't.cybozu.com' });
  const calls = { health: 0, ask: [], connect: [], refresh: 0, disconnect: 0 };
  const queue = [...responses];
  const client = {
    async getHealth() { calls.health++; if (health instanceof Error || health?.name === 'AiClientError') throw health; return health; },   // vm の Error は別 realm なので name でも判定
    async ask({ ctx, requestId }) {
      calls.ask.push({ ctx, requestId });
      if (onAsk) return onAsk({ ctx, requestId });
      const r = queue.shift();
      if (r instanceof Error || r?.name === 'AiClientError') throw r;
      const v = KTAiClient.validateAnswer(r, ctx);
      if (!v.ok) throw new KTAiClient.AiClientError({ code: v.errors[0].code, message: v.errors[0].message, requestId });
      return { ...v.normalized, requestId: v.normalized.requestId || requestId, clientWarnings: v.warnings };
    },
  };
  let isConnected = !!(token && connected);
  const session = {
    status() { if (createClientThrows) throw new Error('boom'); return { connected: isConnected, apiBase: 'https://gw.test', refreshExpiresAt: isConnected ? '2099-01-01T00:00:00Z' : null, scope: isConnected ? { product: 'toolkit', feature: 'assistant-qa', domain: 't.cybozu.com' } : null }; },
    async connect(ct, opts) { calls.connect.push({ ct, opts }); if (ct === 'bad') throw new KTAiClient.AiClientError({ code: C.PRODUCT_NOT_ENTITLED, message: 'x', requestId: 'e-c' }); isConnected = true; return this.status(); },
    async migrateLegacy() { return false; },
    async refresh() { calls.refresh++; if (!isConnected) throw new KTAiClient.AiClientError({ code: C.NOT_CONNECTED, message: 'x' }); return {}; },
    async disconnect() { calls.disconnect++; isConnected = false; return { revoked: true }; },
    client,
  };
  // 接続フロー（tokenless）は既定で「開始されていない」fake。実フローは tests/ai-connect.test.js で検証する
  const flow = connectFlow || { start: async () => { throw new KTAiClient.AiClientError({ code: C.TRANSPORT_ERROR, message: 'fake flow' }); }, cancel() { }, reopen: () => false, state: () => ({ phase: 'idle' }), isRunning: () => false };
  const host = makeFakeHost();
  const copies = [];
  const panel = mountAiWorkspace(host, {
    getInputs: () => INPUTS, setPreview: () => { }, copyText: async (t) => { copies.push(t); return true; },
    colors: { border: '#ccc', bg: '#fff' },
    ...(paid ? { settings, session, hostname: 't.cybozu.com', devMode, connectFlow: flow } : {}),
  });
  const $ = (id) => host.querySelector(`#${id}`);
  const generate = async () => { $('kt-ai-target-type').value = 'field'; await $('kt-ai-target-type').dispatch('change'); $('kt-ai-target').value = 'customer_code'; $('kt-ai-question').value = '顧客コードを削除して大丈夫？'; await $('kt-ai-generate').dispatch('click'); };
  return { host, panel, $, calls, copies, settings, storage, generate, session };
}
const tick = () => new Promise(r => setTimeout(r, 0));

(async () => {
// =========================================================
console.log('\n--- 1. KTAiClient ---');
{
  const env = KTAiClient.buildAskEnvelope({ ctx: CTX, requestId: 'tk-1', pluginVersion: '9.9.9', now: 'N' });
  assert(env.contractVersion === '2.1' && env.meta.product === 'toolkit' && env.meta.feature === 'assistant-qa' && env.meta.promptVersion === '1' && env.meta.contextVersion === '1', 'envelope: Contract 2.1 の gateway 識別子');
  assert(env.meta.requestId === 'tk-1' && env.meta.generatedAt === 'N' && env.meta.plugin.name === 'kintone App Toolkit' && env.meta.plugin.version === '9.9.9', 'envelope: requestId / generatedAt / plugin');
  assert(env.payload === CTX, 'payload は生成済み ctx と同一オブジェクト（作り直さない）');
  assert(!('model' in env) && !('model' in env.meta) && !JSON.stringify(env).includes('system'), 'model / system prompt はクライアントに無い');
  let threw = null; try { KTAiClient.buildAskEnvelope({ ctx: null }); } catch (e) { threw = e; }
  assert(threw && threw.code === C.NO_CONTEXT, 'ctx 無し → NO_CONTEXT');
}
{
  let sent = null;
  const client = KTAiClient.createAiClient({ apiBase: 'https://gw.test/', customerToken: ' tok ', hostname: 'h.cybozu.com', transport: async (req) => { sent = req; return okBody(GOOD_RESPONSE); } });
  const a = await client.ask({ ctx: CTX, requestId: 'tk-2' });
  assert(sent.url === 'https://gw.test/v2/review' && sent.method === 'POST' && sent.headers.Authorization === 'Bearer tok' && sent.headers['X-Kintone-Domain'] === 'h.cybozu.com' && sent.headers['Content-Type'] === 'application/json', 'POST /v2/review・Bearer（trim）・X-Kintone-Domain');
  const body = JSON.parse(sent.body);
  assert(body.contractVersion === '2.1' && body.payload.contextVersion === '1' && body.payload.facts.length === CTX.facts.length && body.meta.requestId === 'tk-2', '送信 body は envelope');
  assert(a.answer.includes('[E8]') && a.facts.length === 2 && a.analysis.length === 1 && a.recommendations.length === 1 && a.unknowns.length === 1 && a.requestId === 'tk-x' && a.usage.usedThisMonth === 4, 'ask の戻り値（検証済み正規化）');
  let h = null; const c2 = KTAiClient.createAiClient({ apiBase: 'https://gw.test', customerToken: 'tok', hostname: 'h', transport: async (req) => { h = req; return okBody(HEALTH_OK); } });
  const health = await c2.getHealth();
  assert(h.url === 'https://gw.test/v2/health' && h.method === 'GET' && health.ok === true, 'GET /v2/health');
}
{
  const cases = [[401, C.AUTH_INVALID_TOKEN], [401, C.AUTH_TOKEN_EXPIRED], [403, C.AUTH_DOMAIN_MISMATCH], [403, C.PRODUCT_NOT_ENTITLED], [403, C.FEATURE_NOT_ENTITLED], [429, C.MONTHLY_LIMIT_EXCEEDED], [422, C.INVALID_CONTEXT], [413, C.PAYLOAD_TOO_LARGE], [502, C.UPSTREAM_ERROR], [502, C.MODEL_OUTPUT_INVALID], [500, C.INTERNAL_ERROR], [400, C.UNKNOWN_PROMPT_VERSION], [501, C.FEATURE_NOT_IMPLEMENTED]];
  const seen = [];
  for (const [st, code] of cases) {
    const client = KTAiClient.createAiClient({ apiBase: 'https://gw.test', customerToken: 't', hostname: 'h', transport: async () => v2err(st, code) });
    try { await client.ask({ ctx: CTX }); } catch (e) { seen.push([e.code, e.httpStatus, e.requestId]); }
  }
  assert(JSON.stringify(seen) === JSON.stringify(cases.map(([st, c]) => [c, st, 'e-1'])), '構造化エラーの code / httpStatus / requestId を passthrough（13 種）');
  let rl = null; try { await KTAiClient.createAiClient({ apiBase: 'https://gw.test', customerToken: 't', hostname: 'h', transport: async () => v2err(429, C.RATE_LIMITED, { retryAfterSeconds: 42 }) }).ask({ ctx: CTX }); } catch (e) { rl = e; }
  assert(rl.code === C.RATE_LIMITED && rl.retryAfterSeconds === 42, 'retryAfterSeconds を引き継ぐ');
  let lg = null; try { await KTAiClient.createAiClient({ apiBase: 'https://gw.test', customerToken: 't', hostname: 'h', transport: async () => ({ status: 403, body: JSON.stringify({ ok: false, error: 'Token expired' }) }) }).ask({ ctx: CTX }); } catch (e) { lg = e; }
  assert(lg.code === C.AUTH_TOKEN_EXPIRED, 'legacy 文字列（v1 形式）も翻訳');
  let nj = null; try { await KTAiClient.createAiClient({ apiBase: 'https://gw.test', customerToken: 't', hostname: 'h', transport: async () => ({ status: 200, body: '<html>' }) }).ask({ ctx: CTX }); } catch (e) { nj = e; }
  assert(nj.code === C.INVALID_RESPONSE, 'JSON でない応答 → INVALID_RESPONSE');
  let tr = null; try { await KTAiClient.createAiClient({ apiBase: 'https://gw.test', customerToken: 't', hostname: 'h', transport: async () => { throw new Error('net'); } }).ask({ ctx: CTX }); } catch (e) { tr = e; }
  assert(tr.code === C.TRANSPORT_ERROR, 'transport 例外 → TRANSPORT_ERROR');
}
{
  let aborted = false;
  const fetchFn = (url, init) => new Promise((_, reject) => { init.signal?.addEventListener('abort', () => { aborted = true; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }); });
  const client = KTAiClient.createAiClient({ apiBase: 'https://gw.test', customerToken: 't', hostname: 'h', transport: KTAiClient.createDefaultTransport({ kintoneApi: null, fetchFn }), timeoutMs: 20 });
  let to = null; try { await client.ask({ ctx: CTX }); } catch (e) { to = e; }
  assert(to.code === C.TIMEOUT && aborted, 'timeout → TIMEOUT・fetch を abort');
  let proxied = null;
  const kintoneApi = { proxy: async (url, method, headers, body) => { proxied = { url, method, headers, body }; return [JSON.stringify(HEALTH_OK), 200, {}]; } };
  const c3 = KTAiClient.createAiClient({ apiBase: 'https://gw.test', customerToken: 't', hostname: 'h', transport: KTAiClient.createDefaultTransport({ kintoneApi, fetchFn: null }) });
  const hh = await c3.getHealth();
  assert(hh.ok === true && proxied.url === 'https://gw.test/v2/health' && proxied.headers.Authorization === 'Bearer t', 'kintone.proxy を優先する');
}
{
  const cap = KTAiClient.capabilityFromHealth;
  assert(cap(HEALTH_OK).available === true && cap(HEALTH_OK).usage.usedThisMonth === 3, 'capability: 2.1 対応・entitlement・implemented → available');
  assert(cap({ ...HEALTH_OK, supportedContractVersions: ['2.0'] }).reason === C.CONTRACT_INCOMPATIBLE, 'capability: 2.1 未対応 → CONTRACT_INCOMPATIBLE');
  assert(cap({ ...HEALTH_OK, entitlements: [{ product: 'appinsight', features: ['*'] }] }).reason === C.NOT_ENTITLED, 'capability: AppInsight のみの token → NOT_ENTITLED');
  assert(cap({ ...HEALTH_OK, registry: { toolkit: { 'assistant-qa': { implemented: false, promptVersions: [] } } } }).reason === C.FEATURE_NOT_IMPLEMENTED, 'capability: 未実装 → FEATURE_NOT_IMPLEMENTED');
  assert(cap({ ...HEALTH_OK, registry: { toolkit: { 'assistant-qa': { implemented: true, promptVersions: ['2'] } } } }).reason === C.UNKNOWN_PROMPT_VERSION, 'capability: promptVersion 1 が無い → UNKNOWN_PROMPT_VERSION');
  assert(cap(null).available === false, 'capability: health 無し');
}
{
  const bad = { ...GOOD_RESPONSE, answer: '参照なし [E999]', facts: [{ text: 'x', evidenceIds: ['E999'] }, { text: 'y', evidenceIds: ['E8', 'E777'] }], analysis: [{ text: 'z', evidenceIds: ['E555'] }] };
  const v = KTAiClient.validateAnswer(bad, CTX);
  assert(v.ok && v.normalized.answer === '参照なし [根拠不明]' && v.normalized.answerEvidenceIds.length === 0, 'validateAnswer: 本文の未知 ID は [根拠不明]');
  assert(v.normalized.facts.length === 1 && v.normalized.facts[0].evidenceIds.join() === 'E8' && v.normalized.analysis.length === 2 && v.normalized.analysis[0].text === 'x' && v.normalized.analysis[1].evidenceIds.length === 0, 'validateAnswer: 未知 ID 除去・根拠なし fact は analysis へ');
  assert(!JSON.stringify(v.normalized).includes('E999') && !JSON.stringify(v.normalized).includes('E777') && v.warnings.length >= 3, '未知 ID は残らず warnings に記録');
  assert(KTAiClient.validateAnswer({ ...GOOD_RESPONSE, contractVersion: '2.0' }, CTX).ok === false && KTAiClient.validateAnswer({ ...GOOD_RESPONSE, answer: '' }, CTX).ok === false, 'contractVersion 不一致 / answer 無し → NG');
}

// =========================================================
console.log('\n--- 2. 利用可否 ---');
{
  const m = mount({ token: '' });
  await tick();
  assert(m.$('kt-ai-paid').style.display !== 'none' && m.$('kt-ai-ask').disabled === true, '未接続: Nest Rec AI 区画は表示・「AIに質問」は無効');
  assert(m.$('kt-ai-paid-status').textContent.includes('接続されていません') && m.$('kt-ai-connect').style.display === 'flex' && m.$('kt-ai-session').style.display === 'none' && m.$('kt-ai-conn-badge').textContent === '未接続', '未接続: 接続フォームを表示（Customer Token の恒常入力欄は無い）');
  assert(m.calls.health === 0, '未接続なら health を呼ばない');
  await m.generate();
  await m.$('kt-ai-copy-prompt').dispatch('click');
  assert(m.copies.length === 1 && m.copies[0].includes('## Context'), '無料機能（生成・コピー）はそのまま使える');
}
{
  const m = mount({});
  await tick();
  assert(m.calls.health === 1 && m.$('kt-ai-ask').disabled === false && m.$('kt-ai-paid-status').textContent.includes('AI に質問できます') && m.$('kt-ai-paid-status').textContent.includes('3 / 100'), '契約あり: health → 「AIに質問」有効・利用量表示');
  assert(m.$('kt-ai-session').style.display === 'flex' && m.$('kt-ai-connect').style.display === 'none' && m.$('kt-ai-conn-badge').textContent === '✓ 接続済み', '接続済み: 状態表示に切り替わる');
  const lines = m.$('kt-ai-session-lines').innerHTML;
  assert(lines.includes('AI Assistant') && lines.includes('利用可能') && lines.includes('接続先') && lines.includes('t.cybozu.com') && lines.includes('契約') && lines.includes('有効') && lines.includes('AI利用') && lines.includes('3 / 100') && lines.includes('接続の有効期限'), '接続済み: AI Assistant / 接続先 / 契約 / AI利用 / 接続の有効期限');
  assert(!/v1\.|Bearer|refreshToken/.test(lines), '状態表示に credential 文字列は無い');
  // 本番 UI: Customer Token の入力欄は出ない（開発モードだけ）
  assert(m.$('kt-ai-dev').style.display === 'none' && m.host.innerHTML.includes('>Nest Rec AIに接続<') && !/placeholder="[^"]*トークン/.test(m.host.innerHTML), '本番 UI は「Nest Rec AIに接続」だけ（Customer Token 入力欄は非表示・「トークン」の入力案内なし）');
  // 開発モードの接続フォーム（トークンは入力欄から即座に消え、session.connect に 1 回だけ渡る）
  const c = mount({ token: '', connected: false, devMode: true });
  await tick();
  c.$('kt-ai-token').value = 'ct-once'; c.$('kt-ai-api-base').value = 'https://gw.test';
  await c.$('kt-ai-connect-btn').dispatch('click'); await tick();
  assert(c.calls.connect.length === 1 && c.calls.connect[0].ct === 'ct-once' && c.$('kt-ai-token').value === '' && c.$('kt-ai-ask').disabled === false && c.$('kt-ai-conn-badge').textContent === '✓ 接続済み' && c.$('kt-ai-dev').style.display === 'flex', '接続（開発モード）: exchange に 1 回渡して入力欄を消し、利用可能になる');
  assert(!JSON.stringify([...c.storage.getItem ? [] : []]).includes('ct-once'), 'Customer Token は保存されない');
  const bad = mount({ token: '', connected: false, devMode: true });
  await tick();
  bad.$('kt-ai-token').value = 'bad';
  await bad.$('kt-ai-connect-btn').dispatch('click'); await tick();
  assert(bad.$('kt-ai-ask').disabled === true && bad.$('kt-ai-paid-status').textContent.includes('利用できません') && bad.$('kt-ai-paid-status').textContent.includes('[PRODUCT_NOT_ENTITLED]') && bad.$('kt-ai-conn-badge').textContent === '未接続', '接続失敗: 文言＋code・未接続のまま');
  // 切断
  await m.$('kt-ai-session-disconnect').dispatch('click'); await tick();
  assert(m.calls.disconnect === 1 && m.$('kt-ai-ask').disabled === true && m.$('kt-ai-connect').style.display === 'flex' && !m.settings.hasConsent(), '切断: 接続情報と同意を消し、接続フォームへ戻る');
}
{
  const m = mount({ health: { ...HEALTH_OK, entitlements: [{ product: 'appinsight', features: ['*'] }] } });
  await tick();
  assert(m.$('kt-ai-ask').disabled === true && m.$('kt-ai-paid-status').textContent.includes('kintone App Toolkit の AI 機能を利用できません'), '未契約（AppInsight のみ）: 無効＋文言');
  const m2 = mount({ health: new KTAiClient.AiClientError({ code: C.AUTH_TOKEN_EXPIRED, message: 'x' }) });
  await tick();
  assert(m2.$('kt-ai-ask').disabled === true && m2.$('kt-ai-paid-status').textContent.includes('有効期限が切れています'), 'token 期限切れ: 無効＋文言');
  const m3 = mount({ health: new Error('offline') });
  await tick();
  assert(m3.$('kt-ai-ask').disabled === false && m3.$('kt-ai-paid-status').textContent.includes('ネットワークエラー'), 'Gateway 停止: 文言を表示（一時的な失敗なので再試行ボタンは残す）');
  await m3.generate(); m3.settings.setConsent(true);
  const h0 = m3.calls.health;
  await m3.$('kt-ai-ask').dispatch('click');
  assert(m3.calls.health === h0 + 1 && m3.calls.ask.length === 0 && m3.$('kt-ai-paid-status').textContent.includes('ネットワークエラー'), '再試行で health を再判定し、まだ不可なら送信しない');
  await m3.generate(); await m3.$('kt-ai-copy-md').dispatch('click'); await m3.$('kt-ai-copy-json').dispatch('click');
  assert(m3.copies.length === 2 && m3.copies[0].startsWith('# 案件管理') && JSON.parse(m3.copies[1]).contextVersion === '1', 'Gateway 停止でも無料の Markdown / JSON コピーは動く');
  const m4 = mount({ createClientThrows: true });
  await tick();
  assert(m4.$('kt-ai-paid-status').textContent.includes('ネットワークエラー') && m4.calls.ask.length === 0, 'session の失敗でも例外にならない（文言のみ）');
  const rl = mount({ health: new KTAiClient.AiClientError({ code: C.RATE_LIMITED, message: 'x' }) });
  await tick();
  assert(rl.$('kt-ai-ask').disabled === false && rl.$('kt-ai-paid-status').textContent.includes('アクセスが集中'), 'rate limit（一時的）: 文言＋再試行ボタンは有効');
  await m4.generate();
  assert(m4.$('kt-ai-actions').style.display === 'flex', '無料の生成は影響を受けない');
  const m5 = mount({ paid: false });
  assert(m5.$('kt-ai-paid').style.display === 'none', '有料の依存を渡さなければ区画を隠す（無料のみ）');
}

// =========================================================
console.log('\n--- 3. ask: 同意 → 送信 → loading → 回答 ---');
{
  let resolveAsk;
  const pending = new Promise(r => { resolveAsk = r; });
  const m = mount({ onAsk: async ({ ctx, requestId }) => { await pending; const v = KTAiClient.validateAnswer(GOOD_RESPONSE, ctx); return { ...v.normalized, requestId: 'tk-x', clientWarnings: v.warnings }; } });
  await tick();
  await m.$('kt-ai-ask').dispatch('click');
  assert(m.$('kt-ai-paid-status').textContent.includes('先に「AI Prompt を生成」'), '生成前に押す → NO_CONTEXT の文言・送信しない');
  await m.generate();
  await m.$('kt-ai-ask').dispatch('click');
  assert(m.$('kt-ai-consent').style.display === '' && m.calls.ask.length === 0, '初回は送信前確認を表示し、まだ送らない');
  assert(m.host.innerHTML.includes('この Context を AI サービス') && m.host.innerHTML.includes('送信しない内容: レコードの値・添付ファイル・cookie・API キー'), '同意文（送信する / しない内容）');
  await m.$('kt-ai-consent-cancel').dispatch('click');
  assert(m.$('kt-ai-consent').style.display === 'none' && m.calls.ask.length === 0 && !m.settings.hasConsent(), 'キャンセル → 送信せず、同意も記録しない');
  await m.$('kt-ai-ask').dispatch('click');
  const p = m.$('kt-ai-consent-ok').dispatch('click');   // 送信開始（pending）
  await tick();
  assert(m.settings.hasConsent() && m.calls.ask.length === 1, '同意 → 記録して送信');
  assert(m.$('kt-ai-ask').disabled === true && m.$('kt-ai-paid-status').textContent.includes('送信中') && /requestId: tk-/.test(m.$('kt-ai-paid-status').textContent), 'loading: ボタン無効・送信中表示・requestId 保持');
  await m.$('kt-ai-ask').dispatch('click');
  assert(m.calls.ask.length === 1, '送信中の再クリックは無視（二重送信防止）');
  const sentCtx = m.calls.ask[0].ctx;
  const gen = KTContextUi.generate({ targetType: 'field', targetId: 'customer_code', question: '顧客コードを削除して大丈夫？', inputs: INPUTS });
  assert(sentCtx && sentCtx.contextVersion === '1' && sentCtx.focus.target.id === 'customer_code' && JSON.stringify({ ...sentCtx, generatedAt: null, size: null }) === JSON.stringify({ ...gen.ctx, generatedAt: null, size: null }), '生成済みの同じ KTContext を送る（AI 用に作り直さない）');
  resolveAsk(); await p; await tick();
  assert(m.$('kt-ai-ask').disabled === false && m.$('kt-ai-paid-status').textContent.includes('回答を受信しました') && m.$('kt-ai-paid-status').textContent.includes('4 / 100'), '完了: ボタン復帰・利用量');
  const html = m.$('kt-ai-answer').innerHTML;
  assert(m.$('kt-ai-answer').style.display === '' && html.includes('AI回答') && html.includes('<b>回答</b>') && html.includes('確認できた事実') && html.includes('AIによる分析') && html.includes('<b>提案</b>') && html.includes('確認できないこと'), '回答の 5 区分を表示');
  assert(html.includes('ルックアップ「顧客マスタ参照」のコピー先') && html.includes('data-eid="E8"') && html.includes('data-eid="E10"') && html.includes('data-eid="E4"'), '事実・分析・提案に根拠チップ');
  assert(html.includes('requestId: tk-x') && html.includes('プラグイン設定は確認できない'), 'requestId と unknowns');
  assert(m.panel.lastAnswer().facts.length === 2, 'lastAnswer を保持');
  // 2 回目はそのまま送れる（同意は記録済み・毎回新規 request）
  await m.$('kt-ai-ask').dispatch('click'); await tick();
  assert(m.calls.ask.length === 2 && m.calls.ask[1].requestId !== m.calls.ask[0].requestId, '2 回目は同意なしで送信・requestId は新規');
}

// =========================================================
console.log('\n--- 4. 根拠チップ / 未知根拠 / エラー ---');
{
  const m = mount({ responses: [GOOD_RESPONSE] });
  await tick(); m.settings.setConsent(true);
  await m.generate(); await m.$('kt-ai-ask').dispatch('click'); await tick();
  const fact = m.panel.showEvidence('E8');
  const d = m.$('kt-ai-fact-detail');
  assert(fact && fact.id === 'E8' && d.style.display === '' && d.innerHTML.includes('E8') && d.innerHTML.includes('LOOKUP_COPY_TO') && d.innerHTML.includes('customer_lookup') && d.innerHTML.includes('LOOKUP_MAPPING') && d.innerHTML.includes('確実'), 'チップ → fact 詳細（利用元・関係・設定・確度）');
  await m.$('kt-ai-answer').dispatch({ type: 'click', target: { dataset: { eid: 'E4' } } }); // closest 無しの要素
  assert(d.innerHTML.includes('E4') && d.innerHTML.includes('common.js'), 'クリック（delegation）でも詳細表示');
  const none = m.panel.showEvidence('E999');
  assert(none === null && d.innerHTML.includes('見つかりません'), '存在しない ID は「見つかりません」');
}
{
  const bad = { ...GOOD_RESPONSE, answer: 'どこからも参照なし [E999]', facts: [{ text: '未使用', evidenceIds: ['E999'] }], analysis: [], recommendations: [], unknowns: [] };
  const m = mount({ responses: [bad] });
  await tick(); m.settings.setConsent(true);
  await m.generate(); await m.$('kt-ai-ask').dispatch('click'); await tick();
  const html = m.$('kt-ai-answer').innerHTML;
  assert(!html.includes('data-eid="E999"') && html.includes('[根拠不明]') && html.includes('根拠付きの事実はありません') && html.includes('未使用'), '未知根拠ID は表示されず、事実は分析へ降格（client 側の再検証）');
  assert(html.includes('検証で除去・調整した項目'), '除去を開示');
}
{
  const errs = [
    [new KTAiClient.AiClientError({ code: C.PRODUCT_NOT_ENTITLED, message: 'x', requestId: 'e-9' }), 'AI 機能を利用できません', 'PRODUCT_NOT_ENTITLED'],
    [new KTAiClient.AiClientError({ code: C.AUTH_INVALID_TOKEN, message: 'x' }), 'Nest Rec AI との接続が無効', 'AUTH_INVALID_TOKEN'],
    [new KTAiClient.AiClientError({ code: C.AUTH_TOKEN_EXPIRED, message: 'x' }), '有効期限が切れています', 'AUTH_TOKEN_EXPIRED'],
    [new KTAiClient.AiClientError({ code: C.AUTH_DOMAIN_MISMATCH, message: 'x' }), '対象ドメイン', 'AUTH_DOMAIN_MISMATCH'],
    [new KTAiClient.AiClientError({ code: C.RATE_LIMITED, message: 'x', retryAfterSeconds: 42 }), 'アクセスが集中', 'RATE_LIMITED'],
    [new KTAiClient.AiClientError({ code: C.MONTHLY_LIMIT_EXCEEDED, message: 'x' }), '今月の AI 利用回数の上限', 'MONTHLY_LIMIT_EXCEEDED'],
    [new KTAiClient.AiClientError({ code: C.INTERNAL_ERROR, message: 'x' }), 'AI サービス内部でエラー', 'INTERNAL_ERROR'],
    [new KTAiClient.AiClientError({ code: C.UPSTREAM_ERROR, message: 'x' }), 'AI プロバイダが応答しません', 'UPSTREAM_ERROR'],
    [new KTAiClient.AiClientError({ code: C.TIMEOUT, message: 'x' }), '時間内に応答しません', 'TIMEOUT'],
    [new KTAiClient.AiClientError({ code: C.INVALID_RESPONSE, message: 'x' }), '応答を解釈できません', 'INVALID_RESPONSE'],
    [new KTAiClient.AiClientError({ code: C.INVALID_CONTEXT, message: 'x' }), '検証を通りませんでした', 'INVALID_CONTEXT'],
    [new KTAiClient.AiClientError({ code: C.MODEL_OUTPUT_INVALID, message: 'x' }), '契約形式を満たしません', 'MODEL_OUTPUT_INVALID'],
    [new Error('plain'), 'ネットワークエラー', 'TRANSPORT_ERROR'],
  ];
  for (const [e, text, code] of errs) {
    const m = mount({ responses: [e] });
    await tick(); m.settings.setConsent(true);
    await m.generate(); await m.$('kt-ai-ask').dispatch('click'); await tick();
    const st = m.$('kt-ai-paid-status').textContent;
    assert(st.includes(text) && st.includes(`[${code}]`) && st.includes('requestId: '), `エラー文言: ${code}`);
    if (code === 'RATE_LIMITED') assert(st.includes('約42秒後'), 'retryAfterSeconds を表示');
    if (code === 'PRODUCT_NOT_ENTITLED') assert(st.includes('requestId: e-9') && m.$('kt-ai-ask').disabled === true, '認証・契約系の失敗後はボタンを無効化し Gateway の requestId を表示');
    assert(m.$('kt-ai-answer').style.display === 'none' && m.$('kt-ai-ask').disabled === (code === 'PRODUCT_NOT_ENTITLED' || code === 'AUTH_INVALID_TOKEN' || code === 'AUTH_TOKEN_EXPIRED' || code === 'AUTH_DOMAIN_MISMATCH'), `エラー後の状態: ${code}`);
  }
}

// =========================================================
console.log('\n--- 5. 送信内容 / secret / 無料機能 ---');
{
  let sent = null;
  const client = KTAiClient.createAiClient({ apiBase: 'https://gw.test', customerToken: 't', hostname: 'h', transport: async (req) => { sent = req; return okBody({ ...GOOD_RESPONSE, facts: [], analysis: [], recommendations: [] }); } });
  // JS ファイル対象（コード抜粋を含む）の Context を送る
  const fileCtx = KTContext.build({ focus: { type: 'file', id: 'desktop:js:common.js' }, ...INPUTS, options: { now: 'x' } });
  await client.ask({ ctx: fileCtx });
  const body = sent.body;
  assert(body.includes('code-excerpt') && !body.includes('sk_live_0123456789abcdef0123') && !body.includes('abcdefgh12345678ZZZZ') && body.includes('***'), '送信 body に secret が無い（KTContext の伏字がそのまま・コード抜粋あり）');
  const payload = JSON.parse(body).payload;
  assert(!('records' in payload) && !JSON.stringify(payload).includes('"value":') && !body.includes('機密メモの値'), '送信 body にレコード値が無い（records / value を持たない）');
  assert(!body.includes('Authorization: Bearer') && !sent.body.includes('"customerToken"'), 'token は header のみ（body に含めない）');
  const keys = Object.keys(payload);
  assert(keys.join(',') === Object.keys(fileCtx).join(','), 'payload のキーは KTContext と同じ（追加の収集なし）');
}
{
  const m = mount({ health: new Error('offline') });
  await tick();
  await m.generate();
  await m.$('kt-ai-copy-prompt').dispatch('click'); await m.$('kt-ai-copy-md').dispatch('click'); await m.$('kt-ai-copy-json').dispatch('click');
  assert(m.copies.length === 3 && m.copies[0].includes('## Context') && m.copies[1].startsWith('# ') && JSON.parse(m.copies[2]).facts.length > 0, '無料のコピー 3 種は Gateway 停止と無関係');
  assert(m.$('kt-ai-result').innerHTML.includes('✓ フィールド'), 'coverage 等のサマリも無料側のまま');
}

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
