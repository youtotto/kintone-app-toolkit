// 新しい流れ（依頼 → 仮案 → 採用 → 計画 → 生成 → 最終案 → 承認 → 反映の準備）を偽の services で通す共有の部品（C-1 第 3 段・2026-10-08）。
//   tests/ai-flow-redesign.test.js の部品（台本・偽の計画と生成工程・会話コントローラの偽 services・画面の偽 client）を、同じ本文のまま共通にしたもの。
//   古い確認の流れ（質問カード・仕様の確定・従来の生成）を前提にしたテストを移し替えるときに使う。
//
// 使い方:
//   const { loadToolkit } = require('./helpers/load-toolkit.js');
//   const { createNewFlowKit } = require('./helpers/new-flow.js');
//   const T = loadToolkit();
//   const K = createNewFlowKit(T);
//   // 会話コントローラ（偽 services）: 仮案 → 採用 → 計画 → 生成工程 → 最終案。台本の 4 発言で採用まで進む
//   const x = K.makeConvC({ planImpl: (args) => K.planJs(args, { cust: K.custOf(['lock']) }), generate: K.makeGenerate({ sequence: ['good'] }) });
//   await K.adoptC(x);                                   // 採用 → 最終案（x.c.activePlan().final）
//   K.approveC(x);                                       // 承認（x.c.approveFinal と同じ。承認できなければ理由）
//   // 画面（mountAiWorkspace と偽 client）: health に proposal。K.mount({ planImpl, generateImpl, health })
//   const m = K.mount();
//   const v = await K.adoptOnScreen(m);                  // 台本の 4 発言 → 最終案のカード
//   const { approved, exec, js } = await K.prepareOnScreen(m);   // ［この内容で反映する］→ 反映の準備（startExecutor / startJsRegister。書き込みはしない）
//   //   K.HEALTH の conversation から 'proposal' を外すと「接続先が非対応」の経路（計画・生成・登録に進まない）
//   //   計画の偽物: K.planJs（JavaScript あり。cust・questions・requirementOps を変えられる）・K.PLAN_V1（画面用。設定の手順だけ）・K.planOk / planFail / planThrow
//   // 台本（K.script）の発言: 課長・部長の承認者を選ぶ運用にしたい / 100円未満は部長不要、100万円以上は必要 / 7営業日で。会社独自の休業日は今回はなし / おすすめで
//   //   （K.adoptC がこの 4 つを送る）。偽の生成工程の候補は K.CAND（good・bad・badChecked・warn・value・lockonly・locksave）
'use strict';
const { makeFakeHost } = require('./fake-dom.js');
const FX = require('../fixtures/ai-context-app.js');
const { buildScanPayload } = require('./scan-payload.js');
const { makeKintoneMock } = require('./kintone-preview-mock.js');

/**
 * @param {object} T loadToolkit() の結果
 * @returns {object} 部品（NAMES の名前）
 */
function createNewFlowKit(T) {
  const { KTDeps, KTScan, KTContext, KTAiClient, KTAiAnswers, KTAiConversation, KTAiChatUi, mountAiWorkspace } = T;
  void KTContext; void KTAiAnswers;
  const tick = () => new Promise(r => setTimeout(r, 0));
  const ticks = async (n = 6) => { for (let i = 0; i < n; i++) await tick(); };
  const clone = (v) => JSON.parse(JSON.stringify(v));
  // ---- 入力（ai-two-pane と同じ形）----
  function buildInputs() {
    const data = FX.makeData();
    const fieldsN = KTDeps.normalizeFields(data.fields);
    const deps = KTDeps.buildDependencyData(data, fieldsN);
    const fieldRows = fieldsN.map(f => ({ code: f.code, label: f.label, type: f.rawType }));
    const scan = buildScanPayload({ KTScan, KTDeps }, { appId: FX.SELF_APP, files: FX.files, fields: fieldRows, deps, skippedUrlFiles: FX.skippedUrlFiles });
    scan.results = KTScan.analyze({ fields: fieldRows, files: FX.files.filter(f => f.kind === 'js'), snippet: { before: 24, after: 48 } });
    KTDeps.mergeScannerEdges(deps, scan);
    KTDeps.applyIncomingRefs(deps, FX.incoming);
    return { data, deps, scan, incoming: FX.incoming };
  }
  const INPUTS = buildInputs();
  // ---- 仮案の台本（発言の文で引く。項目の id は前回の仮案から key / 文で探す） ----
  const META = { requestId: 'pp-1', usage: { usedThisMonth: 2, monthlyLimit: 20 }, normalization: { warnings: [] }, ai: { model: 'm', latencyMs: 40, streamed: true, firstTextMs: 9, usage: { input_tokens: 2000, output_tokens: 500, input_tokens_details: { cached_tokens: 300 }, output_tokens_details: { reasoning_tokens: 50 } } } };
  const B = (text, origin = 'ai') => ({ text, origin });
  const A = (key, label, text, changeHint = '') => ({ key, label, text, changeHint });
  const Q = (key, label, question, options, recommendation, impact, blocking) => ({ key, label, question, options, recommendation, impact, blocking });
  const APPROVER = A('approval.approver_field', '承認者の指定方法', '承認者はユーザー選択フィールド「課長承認者」「部長承認者」を新設して指定する', '既存のフィールドを使うこともできます');
  const ROUTE = A('approval.route', '承認の順序', '課長承認の後に部長承認（順番は固定）', '同時承認にもできます');
  const BASE = A('deadline.base', '期限の起算日', '期限は申請日の翌営業日から数える', '申請日当日から数えることもできます');
  const CSV = A('scope.csv_api', 'CSV・API の扱い', 'CSV の読み込みと API 経由の更新は使わない前提（画面の操作だけを制御する）', '使う場合は別の対策が要ります');
  const Q_THRESHOLD = Q('approval.threshold', '部長承認の条件', '部長承認は金額に関係なく常に必要ですか、一定金額以上のときだけですか', ['常に必要', '一定金額以上のときだけ'], '一定金額以上のときだけ', '承認ルートの分岐と、金額の条件の設定が変わります', true);
  const Q_MIDDLE = Q('approval.threshold_middle', '中間の金額の扱い', '100円以上100万円未満の申請に部長承認は必要ですか', ['必要', '不要'], '不要', '中間の金額の承認ルートが変わります', true);
  const Q_DAYS = Q('deadline.days', '承認の期限', '承認の期限は申請から何営業日にしますか', ['3営業日', '5営業日', '7営業日'], '5営業日', '期限超過の判定日が変わります', false);
  const Q_HOLIDAYS = Q('deadline.holidays', '休業日の扱い', '期限の計算で会社独自の休業日を考慮しますか', ['考慮する', '考慮しない'], '考慮しない', '期限の日付の計算方法が変わります', false);
  const Q_LOCK = Q('lock.scope', '編集不可の対象', '申請中に編集できなくする対象は全員ですか、申請者以外ですか', ['全員', '申請者以外'], '全員', '申請者が申請中に修正できるかが変わります', false);
  const Q_TIMING = Q('notify.timing', '部長への通知のタイミング', '部長への通知は課長承認の直後に送りますか、期限の前日に送りますか', ['課長承認の直後', '期限の前日'], '', '部長が気づく時点が変わります', true);
  const B_SELECT = B('申請時に課長と部長の承認者をユーザー選択で指定する', 'user');
  const B_ROUTE = B('承認は課長 → 部長の順に進み、それぞれの承認者だけが承認できる');
  const B_UNDER = B('100円未満の申請は部長承認を省く', 'user');
  const B_OVER = B('100万円以上の申請は部長承認を必要とする', 'user');
  const B_NOTIFY_TO = B('承認依頼の通知は現在の承認者へ送る', 'user');
  const B_NOTIFY_IF = B('課長承認中で100万円以上の申請は部長にも通知する', 'user');
  const B_LOCK = B('申請中のレコードは編集できないようにする', 'user');
  const STD = ['プロセス管理のステータス（申請中・課長承認待ち・部長承認待ち・承認済み）と承認アクション', '承認者フィールドの追加'];
  const req = (op, o) => ({ op, target: '', condition: '', behavior: '', exceptions: [], decision: 'decided', disposition: 'adopted', sourceQuotes: [], planRefs: [], note: '', ...o });
  const idBy = (list, pred) => { const x = (list || []).find(pred); return x ? x.id : null; };
  const reqIdBy = (reqs, re) => (reqs || []).filter(r => r.decision !== 'revoked' && re.test(`${r.condition} ${r.behavior}`)).map(r => r.id);
  /**
   * 台本: utterance と前回の仮案・要件から Gateway の応答（契約の形）を作る。見つからなければ null（テストの失敗にする）
   */
  function script({ utterance: u, previous: p, requirements: reqs }) {
    const prevB = (p && p.behaviors) || [], prevA = (p && p.assumptions) || [], prevD = (p && p.decisions) || [];
    if (/課長・部長の承認者を選ぶ運用/.test(u)) return { reply: '課長と部長を申請ごとに選んで承認する流れにできます。承認ルートはプロセス管理で、承認者の指定はユーザー選択フィールドで行います。部長承認を金額で分けるかだけ先に決めてください。', intent: 'propose',
      proposal: { behaviors: [B_SELECT, B_ROUTE], assumptions: [APPROVER, ROUTE], decisions: [Q_THRESHOLD], approach: { standard: STD, js: [] }, cannot: [] },
      turn: { ops: [], answers: [], requirementOps: [req('add', { target: '承認', condition: '申請時', behavior: '課長と部長の承認者を選んで承認する', sourceQuotes: ['課長・部長の承認者を選ぶ運用にしたい'], planRefs: ['B1'] })] } };
    if (/100円未満は部長不要/.test(u)) return { reply: '100円未満は部長承認なし、100万円以上は部長承認ありで進めます。その間（100円以上100万円未満）の扱いだけ決めてください。期限と休業日は、あとで決めても進められます。', intent: 'update',
      proposal: { behaviors: [B_SELECT, B_ROUTE, B_UNDER, B_OVER], assumptions: [APPROVER, ROUTE], decisions: [Q_MIDDLE, Q_DAYS, Q_HOLIDAYS], approach: { standard: STD, js: [] }, cannot: [] },
      turn: { ops: [{ id: idBy(prevB, b => /課長と部長の承認者/.test(b.text)), op: 'adopt', text: '', quote: '' }], answers: [{ id: idBy(prevD, d => d.key === 'approval.threshold'), kind: 'value', text: '100円未満は不要、100万円以上は必要', quote: '100円未満は部長不要、100万円以上は必要' }],
        requirementOps: [req('add', { target: '部長承認', condition: '100万円以上', behavior: '部長承認を必要とする', sourceQuotes: ['100万円以上は必要'], planRefs: ['B4'] }), req('add', { target: '部長承認', condition: '100円未満', behavior: '部長承認を省く', sourceQuotes: ['100円未満は部長不要'], planRefs: ['B3'] })] } };
    if (/7営業日/.test(u) && /休業日/.test(u)) return { reply: '期限は 7 営業日、会社独自の休業日は考慮しない前提で進めます。残りは中間の金額の扱いだけです。', intent: 'update',
      proposal: { behaviors: [B_SELECT, B_ROUTE, B_UNDER, B_OVER], assumptions: [APPROVER, ROUTE, A('deadline.days', '承認の期限', '承認の期限は申請から 7 営業日（土日祝のみ除く）', '日数は変えられます'), BASE], decisions: [Q_MIDDLE], approach: { standard: STD, js: [] }, cannot: [] },
      turn: { ops: [], answers: [{ id: idBy(prevD, d => d.key === 'deadline.days'), kind: 'value', text: '7営業日', quote: '7営業日' }, { id: idBy(prevD, d => d.key === 'deadline.holidays'), kind: 'value', text: '会社独自の休業日は考慮しない', quote: '会社独自の休業日は今回はなし' }],
        requirementOps: [req('add', { target: '承認の期限', condition: '申請から', behavior: '7 営業日以内に承認する（土日祝のみ除く）', sourceQuotes: ['7営業日'], planRefs: ['A3'] })] } };
    if (/現在の承認者へ/.test(u)) return { reply: '承認依頼の通知は現在の承認者に送り、課長承認中で 100 万円以上の申請は部長にも通知します。', intent: 'update',
      proposal: { behaviors: [B_SELECT, B_ROUTE, B_UNDER, B_OVER, B_NOTIFY_TO, B_NOTIFY_IF], assumptions: [APPROVER, ROUTE, A('deadline.days', '承認の期限', '承認の期限は申請から 7 営業日（土日祝のみ除く）', '日数は変えられます'), BASE], decisions: [Q_MIDDLE], approach: { standard: [...STD, '承認依頼の通知（レコードの条件通知）'], js: [] }, cannot: [] },
      turn: { ops: [], answers: [], requirementOps: [req('add', { target: '通知', condition: '承認依頼のとき', behavior: '現在の承認者へ通知する', sourceQuotes: ['現在の承認者へ'], planRefs: ['B5'] }), req('add', { target: '通知', condition: '課長承認中で100万円以上', behavior: '部長にも通知する', sourceQuotes: ['課長承認中で100万円以上なら部長にも通知'], planRefs: ['B6'] })] } };
    if (/申請中は編集不可/.test(u)) return { reply: '申請中はレコードを編集できないようにします（JavaScript で制御）。CSV・API 経由の更新は使わない前提で、画面の操作だけを対象にします。編集不可の対象が全員か申請者以外かだけ決めてください。', intent: 'update',
      proposal: { behaviors: [B_SELECT, B_ROUTE, B_UNDER, B_OVER, B_NOTIFY_TO, B_NOTIFY_IF, B_LOCK], assumptions: [APPROVER, ROUTE, A('deadline.days', '承認の期限', '承認の期限は申請から 7 営業日（土日祝のみ除く）', '日数は変えられます'), BASE, CSV], decisions: [Q_MIDDLE, Q_LOCK], approach: { standard: [...STD, '承認依頼の通知（レコードの条件通知）'], js: ['申請中のステータスでフィールドの編集を止める（レコード編集画面）'] }, cannot: [] },
      turn: { ops: [], answers: [], requirementOps: [req('add', { target: 'レコードの編集', condition: '申請中', behavior: '編集できないようにする', sourceQuotes: ['申請中は編集不可'], planRefs: ['B7'] })] } };
    if (/^全員で/.test(u)) return { reply: '申請中は全員が編集できないようにします。部長への通知のタイミングだけ決めてください。', intent: 'update',
      proposal: { behaviors: [B_SELECT, B_ROUTE, B_UNDER, B_OVER, B_NOTIFY_TO, B_NOTIFY_IF, B_LOCK], assumptions: [APPROVER, ROUTE, A('deadline.days', '承認の期限', '承認の期限は申請から 7 営業日（土日祝のみ除く）', '日数は変えられます'), BASE, CSV], decisions: [Q_MIDDLE, Q_TIMING], approach: { standard: [...STD, '承認依頼の通知（レコードの条件通知）'], js: ['申請中のステータスでフィールドの編集を止める（レコード編集画面）'] }, cannot: [] },
      turn: { ops: [], answers: [{ id: idBy(prevD, d => d.key === 'lock.scope'), kind: 'value', text: '全員', quote: '全員で' }], requirementOps: [] } };
    if (/おすすめで/.test(u)) return { reply: '中間の金額はおすすめどおり部長承認なしで進めます。部長への通知のタイミングだけ決めてください。', intent: 'update',
      proposal: { behaviors: [B_SELECT, B_ROUTE, B_UNDER, B_OVER, B_NOTIFY_TO, B_NOTIFY_IF, B_LOCK], assumptions: [APPROVER, ROUTE, A('deadline.days', '承認の期限', '承認の期限は申請から 7 営業日（土日祝のみ除く）', '日数は変えられます'), BASE, CSV, A('approval.threshold_middle', '中間の金額', '100円以上100万円未満は部長承認なし（おすすめ）', '必要にもできます')], decisions: [Q_TIMING], approach: { standard: [...STD, '承認依頼の通知（レコードの条件通知）'], js: ['申請中のステータスでフィールドの編集を止める（レコード編集画面）'] }, cannot: [] },
      turn: { ops: [], answers: [], requirementOps: [] } };
    if (/違いが気になる/.test(u)) return { reply: '5 営業日にすると、7 営業日より 2 営業日早く期限超過の判定になります。承認者への通知の時点は変わりません。', intent: 'question', proposal: { behaviors: [], assumptions: [], decisions: [], approach: { standard: [], js: [] }, cannot: [] }, turn: { ops: [], answers: [], requirementOps: [] } };
    if (/通知は不要/.test(u)) return { reply: '通知は外し、期限は 5 営業日に変えて、ほかは採用します。', intent: 'adopt',
      proposal: { behaviors: [B_SELECT, { ...B_ROUTE, origin: 'user' }, B_UNDER, B_OVER, B_LOCK], assumptions: [APPROVER, ROUTE, A('deadline.days', '承認の期限', '承認の期限は申請から 5 営業日（土日祝のみ除く）', '日数は変えられます'), BASE, CSV, A('approval.threshold_middle', '中間の金額', '100円以上100万円未満は部長承認なし（おすすめ）', '必要にもできます')], decisions: [], approach: { standard: STD, js: ['申請中のステータスでフィールドの編集を止める（レコード編集画面）'] }, cannot: [] },
      turn: {
        ops: [
          ...prevB.filter(b => /通知/.test(b.text)).map(b => ({ id: b.id, op: 'reject', text: '', quote: '通知は不要' })),
          { id: idBy(prevA, a => a.key === 'deadline.days'), op: 'modify', text: '承認の期限は申請から 5 営業日（土日祝のみ除く）', quote: '期限は5営業日' },
          ...prevD.filter(d => d.key === 'notify.timing').map(d => ({ id: d.id, op: 'reject', text: '', quote: '通知は不要' })),
          ...prevB.filter(b => !/通知/.test(b.text)).map(b => ({ id: b.id, op: 'adopt', text: '', quote: 'ほかは採用' })),
        ],
        answers: [],
        requirementOps: [
          ...reqIdBy(reqs, /通知/).map(id => req('revoke', { id, sourceQuotes: ['通知は不要'] })),
          ...reqIdBy(reqs, /営業日/).map(id => req('update', { id, target: '承認の期限', condition: '申請から', behavior: '5 営業日以内に承認する（土日祝のみ除く）', sourceQuotes: ['期限は5営業日'], planRefs: ['A3'] })),
        ],
      } };
    return null;
  }
  /** 契約の形の応答 → Toolkit の client.propose が返す形（validateProposal を通す） */
  const normalized = (raw, requestId = 'pp-1') => { const v = KTAiClient.validateProposal({ ok: true, contractVersion: '2.1', meta: META, ...raw }); if (!v.ok) throw new Error(`台本の形が不正: ${v.errors[0].message}`); return { ...v.normalized, requestId, clientWarnings: v.warnings }; };
  /** 計画の AI の成功の応答（最小の計画。turn に coverage 無し） */
  const planOk = (args) => ({ plan: { goal: args.goal, assessment: { summary: '承認の流れを設定します。' }, steps: [], customizations: [], provisionals: [], questions: [] }, ctx: null, review: null, gatewayPlan: null, turn: { reply: '計画を作りました。', requirementOps: [], utteranceCoverage: [] } });
  const planFail = () => ({ plan: null, message: '計画を作れませんでした（テスト）', reason: 'TEST' });
  const planThrow = () => { throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' }); };
  const gateMk = () => { let open; const p = new Promise(r => { open = r; }); return { p, open }; };
  const HEALTH = { ok: true, supportedContractVersions: ['2.0', '2.1'], entitlements: [{ product: 'toolkit', features: ['assistant-qa', 'change-planner', 'customization-generator'] }], registry: { toolkit: { 'assistant-qa': { implemented: true, promptVersions: ['1'], conversation: ['requirements', 'brief', 'stream', 'proposal'] }, 'change-planner': { implemented: true, promptVersions: ['1'] }, 'customization-generator': { implemented: true, promptVersions: ['1'] } } }, usage: { monthlyLimit: 20, usedThisMonth: 1 } };
  const spec = (o) => ({ name: null, from: null, to: null, filterCond: null, assignees: [], targets: [], events: [], timingField: null, daysLater: null, time: null, fields: [], sort: null, sourceApp: null, keyField: null, mappings: [], fieldType: null, required: null, options: [], destApp: null, accessibility: null, entities: [], customizationId: null, ...o });
  const mkStep = (id, actionType, targetKind, targetRef, sp, extra = {}) => ({ id, actionType, targetKind, targetRef, targetExists: null, title: `${id} ${actionType}`, proposal: { summary: '', details: [] }, spec: spec(sp), dependsOn: [], reason: '', evidenceIds: [], confidence: 'INFERRED', alternativeId: null, validation: { status: 'ok', issues: [] }, execution: { mode: 'PLAN_ONLY', supported: false, reason: 'x' }, ...extra });
  const PLAN_META = { requestId: 'pl-1', gateway: { product: 'toolkit', feature: 'change-planner', promptVersion: '1', contextVersion: 'planner-1' }, normalization: { warnings: [] }, ai: { model: 'm', latencyMs: 30, usage: { input_tokens: 500, output_tokens: 200 } }, usage: { usedThisMonth: 1, monthlyLimit: 20 } };
  const PLAN_V1 = (goal) => ({ ok: true, contractVersion: '2.1', meta: PLAN_META, plan: { goal, assessment: { summary: '承認者の一覧を追加します。', usableExistingFields: [], usableExistingSettings: [], missingCapabilities: [], uncertainties: [] }, relevantFields: [], proposedFields: [], steps: [mkStep('P1', 'ADD_VIEW', 'VIEW', '承認待ち一覧', { name: '承認待ち一覧', fields: ['owner', 'case_name'], filterCond: 'owner in (LOGINUSER())', sort: 'due_date asc' }, { title: '一覧「承認待ち一覧」を追加' })], alternatives: [], impact: [], questions: [], unknowns: [], planConfidence: 'INFERRED' } });
  const answerFor = (ctx, text) => ({ ok: true, contractVersion: '2.1', meta: { requestId: 'qa-1', usage: { usedThisMonth: 2, monthlyLimit: 20 }, normalization: { warnings: [] } }, answer: text, facts: [], analysis: [], recommendations: [], unknowns: [] });
  const makeStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
  const gate = () => { let open; const p = new Promise(r => { open = r; }); return { p, open }; };
  function mount({ health = HEALTH, proposeGate = null, planImpl = null, generateImpl = null, extra = null } = {}) {
    const storage = makeStorage();
    const settings = KTAiClient.createSettingsStore({ storage, host: 't.cybozu.com' });
    settings.setConsent(true);
    const calls = { ask: [], plan: [], propose: [] };
    const clock = { t: 1000000 };
    const mx = { planImpl };   // 計画の client の差し替え（失敗・途中で止める。null なら PLAN_V1 を返す）
    const client = {
      async getHealth() { return health; },
      async ask({ ctx, requestId }) { calls.ask.push({ ctx }); const v = KTAiClient.validateAnswer(answerFor(ctx, '答えです。'), ctx); return { ...v.normalized, requestId, clientWarnings: v.warnings }; },
      async plan({ ctx, requestId }) { calls.plan.push({ ctx }); clock.t += 30000; if (mx.planImpl) return mx.planImpl({ ctx, requestId }); const v = KTAiClient.validatePlan(PLAN_V1(ctx.goal), ctx); return { ...v.normalized, requestId, clientWarnings: v.warnings }; },
      async propose({ ctx, requestId, onText = null }) {
        calls.propose.push({ ctx, stream: typeof onText === 'function' });
        const raw = script({ utterance: ctx.question, previous: ctx.conversation.proposal, requirements: ctx.conversation.requirements });
        if (!raw) throw new Error(`台本がありません: ${ctx.question}`);
        // SSE を模擬: 最初の文字 → （止める）→ 全文
        clock.t += 2500; if (onText) onText(raw.reply.slice(0, 10));
        if (proposeGate) await proposeGate.p;
        clock.t += 4500; if (onText) onText(raw.reply);
        return normalized(raw, requestId);
      },
      async generate(a) { if (generateImpl) return generateImpl(a); throw new Error('not used'); },
    };
    const session = { status() { return { connected: true, apiBase: 'https://gw.test', refreshExpiresAt: '2099-01-01T00:00:00Z', scope: { product: 'toolkit', feature: 'assistant-qa,change-planner,customization-generator', domain: 't.cybozu.com' } }; }, async migrateLegacy() { return false; }, async refresh() { return {}; }, async disconnect() { return { revoked: true }; }, client };
    const flow = { start: async () => ({}), cancel() { }, reopen: () => false, state: () => ({ phase: 'idle' }), isRunning: () => false };
    const host = makeFakeHost();
    const mock = makeKintoneMock(INPUTS.data, { jsSources: [] });
    const panel = mountAiWorkspace(host, { getInputs: () => INPUTS, copyText: async () => true, downloadText: () => { }, colors: { border: '#ccc', bg: '#fff' }, settings, session, hostname: 't.cybozu.com', connectFlow: flow, executor: { api: mock.api, appId: '341' }, now: () => clock.t, clock: () => clock.t, ...(extra || {}) });
    const $ = (id) => host.querySelector(`#${id}`);
    return Object.assign(mx, { host, panel, $, calls, clock, mock, conv: () => panel.conversation(), chat: () => $('kt-ai-chat').innerHTML, msgs: () => panel.conversation().state.messages });
  }
  const clickChat = (m, act, extra = {}) => m.$('kt-ai-chat').dispatch({ type: 'click', target: { dataset: { act, ...extra } } });
  const RP = require('../fixtures/p21-bfc-replay.js');
  const { KTCodeReview } = T;
  const DATA_C = { appId: '353', fields: clone(RP.FIELDS), status: { enable: true, states: { '作成中': { name: '作成中', index: '0', assignee: { type: 'ONE', entities: [] } }, '承認待ち': { name: '承認待ち', index: '1', assignee: { type: 'ONE', entities: [] } }, '承認済み': { name: '承認済み', index: '2', assignee: { type: 'ONE', entities: [] } } }, actions: [] }, layout: [] };
  const LABELS_C = { amount: '金額', 'ステータス': 'ステータス', memo: '備考' };
  const custOf = (effects, o = {}) => ({ customizationId: 'C1', requirement: '承認待ちでは金額を編集不可にする', whyStandardInsufficient: 'ステータスで切り替えるアクセス権は無い', strategy: 'NEW_JS_FILE', implementation: 'JAVASCRIPT', platform: ['desktop'], events: ['app.record.edit.show'], fields: [{ code: 'ステータス', access: 'READ' }, { code: 'amount', access: 'CONTROL', condition: 'ステータス in ("承認待ち")', ...(effects ? { effects } : {}) }], apis: [], existingFiles: [], risks: [], questions: [], dependsOn: [], evidenceIds: [], ...o });
  const CUST_C1 = custOf(['lock']);
  const ST_C = "record['ステータス'] && record['ステータス'].value === '承認待ち'";
  const handlerC = (body, evs = ['app.record.edit.show']) => `(function () {\n  'use strict';\n  kintone.events.on(${JSON.stringify(evs)}, function (event) {\n    const record = event.record;\n${body}\n    return event;\n  });\n})();`;
  const GOOD = handlerC(`    if (${ST_C}) record['amount'].disabled = true;`);
  const BAD = handlerC("    record['amount'].disabled = true;\n    record['amount'].error = '確認してください';");
  const WARN = handlerC(`    record['amount'].error = (${ST_C}) ? '承認待ちの金額です' : null;`);
  const VALUE = handlerC(`    if (${ST_C}) record['amount'].value = 0;`);
  const LOCKSAVE = `(function () {\n  'use strict';\n  kintone.events.on(['app.record.edit.show'], function (event) {\n    const record = event.record;\n    if (${ST_C}) record['amount'].disabled = true;\n    return event;\n  });\n  kintone.events.on(['app.record.edit.submit'], function (event) {\n    const record = event.record;\n    if (${ST_C}) event.error = '承認待ちのレコードは保存できません';\n    return event;\n  });\n})();`;
  /** 候補（偽の生成工程が最後に返したもの）と、その性質 */
  const CAND = {
    good: { code: GOOD, has: { amount: ['lock'] } },
    bad: { code: BAD, has: { amount: ['lock', 'warn'] }, fails: ['amount|lock'], failMsg: '承認待ちの編集画面で、エラー表示のため編集不可が取り消されました' },
    //   §0d.1（2026-10-08）: 同じ候補を今の契約の Gateway が分類した形（同じ表示のイベントで error と編集不可 → check behavior・candidate-error-same-event。
    //   AI版 worker/test/cases/required-effects.mjs の §0d.1 S7 と同じ分類）
    badChecked: { code: BAD, has: { amount: ['lock', 'warn'] }, fails: ['amount|lock'], failMsg: '承認待ちの編集画面で、エラー表示のため編集不可が取り消されました', check: { 'amount|lock': { check: 'behavior', checkReason: ['candidate-error-same-event'] } } },
    warn: { code: WARN, has: { amount: ['warn'] } },
    value: { code: VALUE, has: { amount: ['set-value'] } },
    lockonly: { code: GOOD, has: { amount: ['lock'] } },
    locksave: { code: LOCKSAVE, has: { amount: ['lock', 'block-save'] } },
  };
  /** §0c.7: 生成工程が必須の効果の検証に対応している印（health の customization-generator.verification。すべて揃って対応） */
  //   §0c.9（2026-10-08）: caseSide（代表条件の side と、効果のイベントごとの合う / 合わない）も印に加えた
  //   §0c.10（2026-10-08）: Gateway の eventCases・loadFaithful・registrationCheck・emptyCase・hideCondition も印に加えた（12 個）
  const GEN_EFFECT_FEATURES = ['requiredEffects', 'effectGroups', 'relatedOmitted', 'appFields', 'saveDialog', 'reasonCategory', 'caseSide', 'eventCases', 'loadFaithful', 'registrationCheck', 'emptyCase', 'hideCondition', 'registrationCounts', 'caseCoverage'];
  const EXPECT_OF = { lock: 'lock', warn: 'warn', 'block-save': 'block-save', 'set-value': 'set-value', 'show-hide': 'show-hide' };
  /** §0c.9: 「合わない」側の期待（Gateway の behavior-cases の neg） */
  const NOMATCH_OF = { lock: 'not-locked', warn: 'not-warned', 'block-save': 'save-allowed', 'set-value': 'value-unchanged', 'show-hide': 'show-hide' };
  /** 偽の生成工程の verification（契約 20 §5・§0c.3 の 5 の形）。env = 動作テストを実行できない理由（timeout など）。supported:false は旧い接続先（requiredEffects・behavior を返さない） */
  //   §0c.6 の回帰用: statusOverride = 必須の効果の status を上書き（unchecked など）/ extraCases = 足す代表条件 / caseReason = 実行できない代表条件の理由（代表条件ごと）
  function fakeVerification(cand, requiredEffects, { env = null, repairs = 0, stoppedBy = null, supported = true, candidateHash, dropCaseFor = null, statusOverride = null, extraCases = [], caseReason = null } = {}) {
    const req = Array.isArray(requiredEffects) ? requiredEffects : [];
    const has = (x) => (cand.has[x.field] || []).includes(x.effect);
    //   §0d.1（2026-10-08）: cand.check（`フィールド|効果` → { check, checkReason }）があれば、今の契約の Gateway と同じく効果ごとの確かめ方とイベントごとの有無も返す
    //   （checkReason は Toolkit の正規化の後の形 = 語の配列。raw: true なら Gateway の応答そのものの形 = 先頭の理由の文字列 checkReason と全部の配列 checkReasons。
    //   KTAiClient.validateGenerated を通す偽物で使う。cand.check が無ければ check を返さない旧い形のまま）
    const checkOf = (x) => { const k = cand.check && cand.check[`${x.field}|${x.effect}`]; return k ? { check: k.check, ...(k.raw ? { checkReason: k.checkReason[0], checkReasons: [...k.checkReason] } : { checkReason: [...k.checkReason] }), events: (Array.isArray(x.events) ? x.events : []).map(ev => ({ event: ev, status: has(x) ? 'present' : 'missing' })) } : {}; };
    const re = req.map(x => ({ requirementId: x.requirementId, requirementIds: x.requirementIds, field: x.field, effect: x.effect, status: statusOverride || (has(x) ? 'present' : 'missing'), ...checkOf(x) }));
    const uniq = [...new Map(req.map(x => [`${x.field}|${x.effect}`, x])).values()].filter(x => `${x.field}|${x.effect}` !== dropCaseFor);
    //   §0c.9: Gateway と同じく、効果のイベントごとに「合う」（side match）と、条件つきなら「合わない」（side nomatch）を 1 件ずつ作る。不合格の候補は「合う」側で fail
    let n = 0;
    const cases = uniq.flatMap((x) => {
      const evs = Array.isArray(x.events) && x.events.length ? x.events : [null];
      return evs.flatMap(ev => (x.condition ? ['match', 'nomatch'] : ['match']).map(side => {
        const base = { id: `K${++n}`, requirementId: x.requirementId, requirementIds: x.requirementIds, field: x.field, effect: x.effect, expect: side === 'match' ? EXPECT_OF[x.effect] : NOMATCH_OF[x.effect], side, kind: side, ...(ev ? { event: ev } : {}) };
        if (env) return { ...base, verdict: 'not-run', observed: null, message: '隔離環境で実行できませんでした', ...(caseReason ? { reason: caseReason } : {}) };
        const fail = side === 'match' && (!has(x) || (cand.fails || []).includes(`${x.field}|${x.effect}`));
        return { ...base, verdict: fail ? 'fail' : 'pass', observed: {}, message: fail ? (cand.failMsg || `${x.field} は期待した動きになりませんでした`) : '期待どおり' };
      }));
    });
    cases.push(...extraCases);
    const missing = re.filter(x => x.status === 'missing');
    const machine = [{ name: 'syntax', ok: true, severity: 'info', message: '構文エラーなし' }, { name: 'modern-js', ok: true, severity: 'info', message: '新しいコードに var はありません' }, ...(supported && req.length ? [{ name: 'required-effects', ok: !missing.length, severity: missing.length ? 'block' : 'info', message: missing.length ? `要件未達（${missing.map(x => `${x.field}: ${x.effect}`).join('、')}の処理がありません）` : '必須の効果の処理があります' }] : [])];
    return { version: '1', candidateHash, sameAsPrevious: false, passed: !machine.some(m => !m.ok && m.severity === 'block'), machine,
      ...(supported ? { requiredEffects: re, behavior: { status: env ? 'not-run' : cases.some(c => c.verdict === 'fail') ? 'failed' : 'passed', reason: env, cases } } : {}),
      repairs: { count: repairs, reasons: [], stoppedBy }, unverified: ['実機での動作'] };
  }
  /** JS ありの計画（C1）。questions / cust / turn（requirementOps）/ gatewayPlan で変える */
  const planJs = (args, { questions = [], cust = CUST_C1, summary = '承認待ちでは金額を編集不可にします。', requirementOps = [], gatewayPlan = null } = {}) => ({
    plan: { goal: args.goal, assessment: { summary }, steps: [{ id: 'C1', actionType: 'CUSTOMIZATION_REQUIRED', targetKind: 'JS', targetRef: null, title: 'JavaScript', spec: { customizationId: 'C1' }, dependsOn: [] }], customizations: [clone(cust)], provisionals: [{ id: 'V1', choice: '編集不可の間は入力欄を灰色にする', changeHint: '' }], questions, unknowns: [], impact: [{ targetRef: 'amount', description: '承認待ちの間、金額は変更できません' }], solution: 'CUSTOMIZATION' },
    ctx: null, gatewayPlan, turn: { reply: '計画を作りました。承認待ちの間だけ金額を編集不可にします。', requirementOps, utteranceCoverage: [] },
    review: { base: { baseVersion: '1', env: 'preview', ok: true, fingerprint: 'fp-1', revision: { preview: '10' } }, steps: [{ stepId: 'C1', status: 'VALID', safety: 'PLAN_ONLY', customization: clone(cust), codeGeneration: { supported: true, strategy: cust.strategy, reason: null }, issues: [] }], executionReadiness: { safeSteps: [], reviewSteps: [], blockedSteps: [], planOnlySteps: ['C1'] }, warnings: [] },
  });
  /**
   * 偽の生成（Gateway の customization-generator）。sequence = 呼び出しごとの候補（CAND のキー）。repairs / stoppedBy = 生成工程の 1 依頼の中の修復。
   * 呼び出しごとに Toolkit が渡した必須の効果（requiredEffects）・feedback の有無を記録する
   */
  function makeGenerate({ sequence = ['good'], gate = null, env = null, repairs = 0, stoppedBy = null, supported = true, dropCaseFor = null, existingSource = null, generatedOf = null, relatedOmitted = null, statusOverride = null, extraCases = [], caseReason = null } = {}) {
    const calls = [];
    const impl = async (args) => {
      const n = calls.length;
      calls.push({ cid: args.customizationId, feedback: args.feedback ? clone(args.feedback) : null, verification: !!args.verification, requiredEffects: clone(args.requiredEffects || null), previous: args.previous ? { candidateHash: args.previous.candidateHash } : null });
      if (gate) await gate.p;
      const which = sequence[Math.min(n, sequence.length - 1)];
      const cand = CAND[which];
      const cust = (args.version.plan.customizations || []).find(x => x.customizationId === args.customizationId) || CUST_C1;
      const generated0 = generatedOf ? generatedOf(cust) : null;
      //   §0d.3（2026-10-08）: 記法の修正（var → const など）は生成工程（Gateway の modern-js.mjs。Toolkit の KTModernJs と同じ本体）が検証の前に行う。
      //   この偽の生成工程も検証の前に直して gatewayChecks.modernJs に記録する（Toolkit の画面の generate は検証の後のコードを書き換えない）
      const gwFixed = generated0 ? T.KTModernJs.fixGenerated({ generated: generated0, existingSource }) : null;
      const generated = generated0 ? (gwFixed && gwFixed.fixed.length ? { ...gwFixed.generated, gatewayChecks: { ...(gwFixed.generated.gatewayChecks || {}), modernJs: { fixed: gwFixed.fixed.map(f => ({ line: f.line, rule: f.rule, name: f.name })) } } } : generated0) : { strategy: 'NEW_JS_FILE', targetFile: 'lock.js', summary: '承認待ちでは金額を編集不可にします。', code: cand.code, patch: null, events: cust.events, fields: [{ code: 'amount', access: 'CONTROL' }], apis: [], assumptions: [], warnings: [], coverage: [{ requirementId: 'C1', status: 'MET', note: '', text: cust.requirement }] };
      const review = KTCodeReview.review({ generated, customization: cust, plan: args.version.plan, data: clone(DATA_C), scan: null, existingSource });
      const candidateHash = KTScan.candidateHashOf({ strategy: generated.strategy, targetFile: generated.targetFile, code: generated.code, patch: generated.patch, customizationId: 'C1' });
      return { ok: true, generated, review, ctx: { size: { approxTokens: 1000 } }, existingSource, inputHash: `h${n}`, verification: fakeVerification(cand, args.requiredEffects, { env, repairs, stoppedBy, supported, candidateHash, dropCaseFor, statusOverride, extraCases, caseReason }), candidateHash, requirementIds: [{ id: 'C1', kind: 'customization', text: cust.requirement }], ...(relatedOmitted ? { relatedOmitted: clone(relatedOmitted) } : {}) };
    };
    return { impl, calls };
  }
  /** 段階 C の偽 services（仮案 → 採用 → 計画 → 生成と検証（生成工程）→ 最終案） */
  function makeConvC({ planImpl = (args) => planJs(args), generate = makeGenerate(), feedback = true, storage = null, planGate = null, materials = '見ている設定: ステータス 3 件・通知 0 件・既存の JavaScript 0 ファイル', supported = true } = {}) {
    const calls = { propose: [], plan: [], ask: [] };
    let t = 1000;
    const x = { planImpl };
    const services = {
      conversationFeatures: () => ['requirements', 'brief', 'stream', 'proposal'], revisionModes: () => ['full'],
      generatorFeatures: () => ['requirementId', 'cases', ...(feedback ? ['feedback'] : []), ...(supported ? (Array.isArray(supported) ? supported : GEN_EFFECT_FEATURES) : [])], plannerFeatures: () => ['reply'],
      materials: () => materials,
      fieldLabels: () => LABELS_C,
      async customizeRevision() { return '42'; },
      async propose(args) { calls.propose.push({ utterance: args.utterance }); const raw = script(args); if (!raw) return { ok: false, reason: 'NO_SCRIPT', message: `台本がありません: ${args.utterance}` }; t += 3000; if (typeof args.onText === 'function') args.onText(raw.reply.slice(0, 12)); await tick(); t += 4000; if (typeof args.onText === 'function') args.onText(raw.reply); return { ok: true, proposal: normalized(raw, `pp-${calls.propose.length}`), ctx: { facts: [] }, perf: { baseWaitMs: 0, contextMs: 5, requestMs: 7000 } }; },
      async ask(args) { calls.ask.push({ question: args.question }); t += 2000; return { ok: true, answer: { answer: '答えです。', facts: [], analysis: [], recommendations: [], unknowns: [] }, ctx: { facts: [] } }; },
      async plan(args) { calls.plan.push({ goal: args.goal, revision: !!args.revision, onText: typeof args.onText === 'function', request: args.revision ? args.revision.request : null, focus: args.revision && Array.isArray(args.revision.focus) ? [...args.revision.focus] : null }); if (typeof args.onText === 'function') { t += 3000; args.onText('承認待ちの間だけ金額を'); } if (planGate) await planGate.p; t += 27000; if (typeof args.onText === 'function') args.onText('承認待ちの間だけ金額を編集不可にします。'); return x.planImpl(args); },
      async generate(args) { t += 20000; return generate.impl(args); },
      readiness() { return null; },
    };
    const c = KTAiConversation.create({ services, now: () => '2026-10-07T00:00:00.000Z', clock: () => t, storage });
    Object.assign(x, { c, calls, services, gen: generate, clock: () => t, advance: (ms) => { t += ms; }, kinds: () => c.messages().map(m => m.data?.kind || m.type), finals: () => c.messages().filter(m => m.type === 'FINAL'), last: () => c.messages()[c.messages().length - 1] });
    return x;
  }
  const adoptC = async (x) => { for (const s of ['課長・部長の承認者を選ぶ運用にしたい', '100円未満は部長不要、100万円以上は必要', '7営業日で。会社独自の休業日は今回はなし']) await x.c.send(s); return x.c.send('おすすめで'); };
  const finalHtml = (x, m = x.finals().slice(-1)[0]) => KTAiChatUi.messageHtml(m, { plans: new Map(x.c.planHistory().map(v => [`${v.planId}:${v.version}`, v])), activePlan: x.c.activePlan(), answerState: x.c.answerContext(), ledger: x.c.ledger(), answers: new Map() });
  const stripC = (h) => String(h).replace(/<br\s*\/?>/g, '\n').replace(/<\/(div|li)>/g, '\n').replace(/<[^>]*>/g, '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

  // ---- C-1 第 3 段（2026-10-08）: 新しい流れを最後（承認 → 反映の準備）まで通す部品（ほかのテストを移し替えるときに使う）----
  /** 台本で採用まで進む 4 つの発言（adoptC・adoptOnScreen が送る） */
  const REQUESTS = ['課長・部長の承認者を選ぶ運用にしたい', '100円未満は部長不要、100万円以上は必要', '7営業日で。会社独自の休業日は今回はなし', 'おすすめで'];
  /** 会話コントローラ: いまの最終案を承認する（承認できないときは理由を返す） */
  const approveC = (x, { baseStamp = undefined } = {}) => { const v = x.c.activePlan(); return v ? x.c.approveFinal({ planId: v.planId, version: v.version, baseStamp }) : { ok: false, reason: 'NO_PLAN' }; };
  /** 画面: 台本の 4 つの発言で仮案 → 採用 → 最終案まで進める（mount の結果 m） */
  const adoptOnScreen = async (m, { requests = REQUESTS } = {}) => { for (const s of requests) { await m.panel.send(s); await ticks(10); } await ticks(8); return m.conv().activePlan(); };
  /**
   * 画面: 最終案のカードの［この内容で反映する］で承認し、反映の準備（設定の手順は startExecutor・JavaScript は startJsRegister）まで進める。
   *   承認できない最終案はボタンを押しても承認されない（approved: false）。準備は書き込まない（最終確認の前で止まる）
   * @returns {{ v, approved, exec, js }}
   */
  const prepareOnScreen = async (m) => {
    const v = m.conv().activePlan();
    if (!v || !v.final) return { v, approved: false, exec: null, js: null };
    await clickChat(m, 'final-approve', { plan: v.planId, version: String(v.version) }); await ticks(4);
    const approved = !!(v.approval && m.conv().approvalValid().ok);
    const hasSteps = (v.plan && Array.isArray(v.plan.steps) ? v.plan.steps : []).some(st => st && st.actionType !== 'CUSTOMIZATION_REQUIRED');
    const exec = hasSteps ? await m.panel.startExecutor() : null; await ticks(4);
    if (exec) m.panel.cancelExecutor();
    const js = Object.keys(v.generated || {}).length ? await m.panel.startJsRegister(v) : null; await ticks(4);
    return { v, approved, exec, js };
  };

  return { tick, ticks, clone, buildInputs, INPUTS, META, B, A, Q, APPROVER, ROUTE, BASE, CSV, Q_THRESHOLD, Q_MIDDLE, Q_DAYS, Q_HOLIDAYS, Q_LOCK, Q_TIMING, B_SELECT, B_ROUTE, B_UNDER, B_OVER, B_NOTIFY_TO, B_NOTIFY_IF, B_LOCK, STD, req, idBy, reqIdBy, script, normalized, planOk, planFail, planThrow, gateMk, HEALTH, spec, mkStep, PLAN_META, PLAN_V1, answerFor, makeStorage, gate, mount, clickChat, RP, KTCodeReview, DATA_C, LABELS_C, custOf, CUST_C1, ST_C, handlerC, GOOD, BAD, WARN, VALUE, LOCKSAVE, CAND, GEN_EFFECT_FEATURES, EXPECT_OF, NOMATCH_OF, fakeVerification, planJs, makeGenerate, makeConvC, adoptC, finalHtml, stripC, REQUESTS, approveC, adoptOnScreen, prepareOnScreen };
}

module.exports = { createNewFlowKit };
