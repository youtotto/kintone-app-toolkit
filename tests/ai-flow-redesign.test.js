// 会話フローの再設計 段階 B（仮案の会話。設計書 §2.1〜2.3・§2.7、契約 13 §11）: 要望 → 仮案 → 返事（採用／一部採用／不採用／修正／相談／雑談）
//
// 検証内容:
//   §B0 仮案の応答の検証と正規化（KTAiClient.validateProposal）・仮案の Context（KTContext.buildProposal）・決定的な前段（classifyDraft）
//   §B1 会話コントローラ（偽 services.propose。発言の文で台本を引く）で R01〜R08 と「ありがとう」「うーん」を 1 本の会話として固定する
//        R01 仮案 1 つ・先に必要な判断 1 件 / R02 中間の扱いを 1 問・数字は不変 / R03 期限の日数と休業日を別の key で記録・以後は再質問しない /
//        R04 通知先と条件の両方が動作と要件に残る / R05 決定事項に統合・同じ範囲を再確認しない / R06「おすすめで」は推奨を採用（おまかせ）・再要求なし /
//        R08 質問は仮案を変えず計画を作らない / 相づちは何も変えない / R07「通知は不要、期限は 5 営業日、ほかは採用」を 1 回で不採用・変更・採用（intent adopt）
//   §B2 画面（mountAiWorkspace の偽 client。health に proposal・ask / propose は SSE を模擬）: 部分表示 → 仮案のカード（ボタン・回答欄・内部の番号を出さない）→
//        回答欄 → 決定事項に記録してから AI へ → ［一部採用］は案内だけ → ［採用］で従来の計画へ（要件の台帳と仮案の対応を引き継ぐ）/ 能力が無ければ従来の流れ
//   §B3 独立レビューの指摘（2026-10-07）: 採用 → 計画の失敗で open に戻る・［再試行］は「採用します」で仮案から作り直す / 計画の AI に要件と決定事項を構造化して渡し
//        合成文を台帳に入れない / 不採用の要件の取り消しは項目 id の対応（補助は内容の文字の重なり 7 割）/ 回答済みの key の再出現は「再確認」/ intent propose は新しい仮案 /
//        採用語（承認します・確定・それで・お願いします）と相づち（はい・OK）の分類 / 仮案の応答待ちの質問は並べて答える
//   §B4 画面: 採用 → 計画の失敗 → 右の見出し・詳細・カードの文 → ［再試行］→ 計画ができたら畳む / 回答欄（data-dkey）のフォーカスの復元
//   §B6 段階 B 修正後の確認（2026-10-07）: 仮案で答えた決定事項が最初の計画（revision 無し）の Context に入り、計画の系列の台帳に回答済みとして入る（計画の AI の再質問は
//        openQuestions に出ず reasked に記録・差分更新でも decisions に入る）/ 仮案の AI の応答待ち中はカードのボタン・回答欄を出さず案内だけ / 版の表示用の goal は依頼文の 1 行目
//        （Gateway へ送る goal は 2 行のまま）/ 最終案の作成中の質問の要約は「採用した仮案（最終案を作成中）」/ 仮案が無いときの相づち・制止・短い否定は PROPOSE にしない（言い切りは 8 字以上）
//
// 実行方法: node tests/ai-flow-redesign.test.js
'use strict';
process.on('unhandledRejection', (e) => { if (/kintone is not defined/.test(String(e && e.message))) return; console.error(e); process.exit(1); });
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const { makeFakeHost } = require('./helpers/fake-dom.js');
const T = loadToolkit();
const { KTDeps, KTScan, KTContext, KTAiClient, KTAiAnswers, KTAiConversation, KTAiChatUi, KTAiWorkspaceViewModel: VM, mountAiWorkspace } = T;
const { assert, state } = makeAssert();
const FX = require('./fixtures/ai-context-app.js');
const { buildScanPayload } = require('./helpers/scan-payload.js');
const { makeKintoneMock } = require('./helpers/kintone-preview-mock.js');

const tick = () => new Promise(r => setTimeout(r, 0));
const ticks = async (n = 6) => { for (let i = 0; i < n; i++) await tick(); };
async function section(fn) { try { await fn(); } catch (e) { assert(false, `例外: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' / ') : e}`); } }
const clone = (v) => JSON.parse(JSON.stringify(v));
/** 会話に内部の番号・英字のコードが出ていないか（仮案の項目の id・key・requestId） */
const INTERNAL = /\b[BAQ][0-9]+\b|approval\.|deadline\.|notify\.|lock\.|scope\.|requestId|\bR[0-9]+「|\bE[0-9]+\b/;
const outsideDetails = (html) => String(html).replace(/<details[\s\S]*?<\/details>/g, '');

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

// =========================================================
(async () => {
console.log('\n--- §B0. 仮案の応答の検証と正規化・仮案の Context・決定的な前段 ---');
await section(async () => {
  const raw = { ok: true, contractVersion: '2.1', meta: META, reply: ' 結論です。 ', intent: 'adopt',
    proposal: { behaviors: [{ id: 'x9', text: '動作 1', origin: 'user' }, { id: 'x8', text: '', origin: 'ai' }, { text: '動作 2', origin: 'bogus' }], assumptions: [{ key: 'Deadline Days', label: 'l', text: '前提', changeHint: '' }, { key: 'deadline_days', text: '前提 2' }],
      decisions: [{ key: '期限', question: 'Q1?', blocking: true, options: ['a', 'b', 'c', 'd', 'e', 'f'] }, { key: 'k2', question: 'Q2?', blocking: true }, { key: 'k3', question: 'Q3?', blocking: true }, { key: 'k4', question: '' }], approach: { standard: ['s'], js: ['j'] }, cannot: ['c'] },
    turn: { ops: [{ id: 'B1', op: 'adopt' }, { id: 'Q1', op: 'modify', text: 'x' }, { id: 'Q2', op: 'reject' }, { id: 'B2', op: 'modify', text: '' }, { id: 'A1', op: 'nope' }], answers: [{ id: 'Q1', kind: 'value', text: '' }, { id: 'Q2', kind: 'delegated', text: '' }, { id: 'B1', kind: 'value', text: 'x' }], requirementOps: [{ op: 'add', behavior: 'b' }] } };
  const v = KTAiClient.validateProposal(raw);
  const n = v.normalized;
  assert(v.ok && n.reply === '結論です。' && n.proposal.behaviors.map(b => b.id).join(',') === 'B1,B2' && n.proposal.behaviors[1].origin === 'ai', `B0-1: id は B1… に振り直し・空の項目は外す・origin は user / ai: ${JSON.stringify(n.proposal.behaviors)}`);
  assert(n.proposal.assumptions.map(a => a.key).join(',') === 'deadline_days,deadline_days_2' && n.proposal.decisions.map(d => d.key).join(',') === 'other,k2,k3', `B0-2: key の正規化（小文字・空白は _）と重複（_2）・空は other: ${n.proposal.assumptions.map(a => a.key)} / ${n.proposal.decisions.map(d => d.key)}`);
  assert(n.proposal.decisions.filter(d => d.blocking).length === 2 && n.proposal.decisions[0].options.length === 5 && n.intent === 'update', `B0-3: blocking は 2 件まで・options は 5 件・blocking が残る adopt は update に: ${n.intent}`);
  assert(n.turn.ops.map(o => `${o.id}:${o.op}`).join(',') === 'B1:adopt,Q2:reject' && n.turn.answers.map(a => `${a.id}:${a.kind}`).join(',') === 'Q2:delegated' && n.turn.requirementOps.length === 1, `B0-4: 判断への ops は reject だけ・空の modify と語彙外の op は外す・空の value の answer は外す: ${JSON.stringify(n.turn)}`);
  assert(v.warnings.some(w => w.code === 'PROPOSAL_BLOCKING_LIMIT') && v.warnings.some(w => w.code === 'PROPOSAL_KEY_DUPLICATE') && v.warnings.some(w => w.code === 'PROPOSAL_ADOPT_WITH_BLOCKING') && v.warnings.some(w => w.code === 'PROPOSAL_OP_ON_DECISION'), `B0-5: 直した点は clientWarnings に残す: ${v.warnings.map(w => w.code).join(',')}`);
  const v2 = KTAiClient.validateProposal({ ok: true, contractVersion: '2.1', meta: META, reply: 'r', intent: 'bogus', proposal: {}, turn: { ops: [{ id: 'B1', op: 'adopt' }] } });
  assert(v2.ok && v2.normalized.intent === 'unclear' && v2.normalized.proposalUnchanged === true && v2.normalized.turn.ops.length === 0, 'B0-6: 語彙外の intent は unclear（仮案を変えない。turn は外す）');
  assert(!KTAiClient.validateProposal({ ok: true, contractVersion: '2.1', meta: META, reply: '', intent: 'propose' }).ok && !KTAiClient.validateProposal({ ok: false }).ok, 'B0-7: reply が無い・ok でないときは失敗');
  // 仮案の Context: KTContext v1 の形・conversation.mode・facts を絞る（目安 12k 字）
  const ctx = KTContext.buildProposal({ utterance: '金額が100万円以上なら部長承認にして、承認後は金額を編集できなくしたい', previous: null, requirements: [], decisions: [{ id: 'dd1', key: 'deadline.days', label: '期限', answer: '7営業日', kind: 'value' }], data: INPUTS.data, deps: INPUTS.deps, scan: INPUTS.scan, incoming: INPUTS.incoming, options: { now: '2026-10-07T00:00:00.000Z' } });
  assert(ctx.contextVersion === '1' && ctx.question.startsWith('金額が100万円以上') && ctx.conversation.mode === 'proposal' && ctx.conversation.proposal === null && ctx.conversation.decisions[0].key === 'deadline.days' && Array.isArray(ctx.conversation.requirements), 'B0-8: KTContext v1 の形で question = 今回の発言・conversation = { mode proposal, proposal, decisions, requirements }');
  const kinds = new Set(ctx.facts.map(f => f.kind));
  assert(ctx.facts.every((f, i) => f.id === `E${i + 1}`) && kinds.has('overview') && ctx.facts.some(f => f.kind === 'field' && f.field && f.field.code === 'amount') && kinds.has('js-file') && ctx.size.chars <= 12000 && ctx.size.chars >= 2000, `B0-9: 根拠ID は E1…・概要・関連フィールド（金額）・既存 JS の要約を含み 12k 字以内: ${ctx.size.chars} 字 / ${[...kinds].join(',')}`);
  assert(!ctx.conversation.brief && !ctx.planContext && JSON.stringify(ctx.facts).length < JSON.stringify(KTContext.buildPlan({ goal: ctx.question, data: INPUTS.data, deps: INPUTS.deps, scan: INPUTS.scan, incoming: INPUTS.incoming }).facts).length, 'B0-10: brief / planContext は付けない。計画の Context より小さい');
  // 決定的な前段
  const c = KTAiConversation.classifyDraft;
  const noDraft = { activePlan: null, draft: null, draftDecisions: [] };
  const open = { activePlan: null, draftDecisions: [], draft: { id: 'd1', status: 'open', items: { behaviors: [], assumptions: [], decisions: [{ id: 'Q1', key: 'k', question: 'q', recommendation: 'rec', blocking: true }], approach: { standard: [], js: [] }, cannot: [] } } };
  const openNoRec = { ...open, draft: { ...open.draft, items: { ...open.draft.items, decisions: [{ id: 'Q1', key: 'k', question: 'q', recommendation: '', blocking: true }] } } };
  assert(c('課長・部長の承認者を選ぶ運用にしたい', noDraft)?.intent === 'PROPOSE' && c('このフィールドは何に使ってる？', noDraft) === null && c('ありがとう', noDraft) === null && c('反映して', noDraft) === null && c('承認済みでは金額を編集不可', noDraft)?.intent === 'PROPOSE', 'B0-11: 計画も仮案も無い: 依頼は PROPOSE・質問 / 相づち / 操作の命令は従来');
  assert(c('ありがとう', open)?.reason === 'DRAFT_SMALLTALK' && c('うーん', open)?.reason === 'DRAFT_SMALLTALK' && c('5営業日にすると何が変わる？', open) === null, 'B0-12: 仮案が open: 相づちは何もしない・質問文だけは従来の QA');
  assert(c('それでお願いします', open)?.intent === 'DRAFT_REPLY' && c('それでお願いします', { ...open, draftDecisions: [{ key: 'k', answer: 'x' }] })?.intent === 'ADOPT_DRAFT' && c('採用します', { ...open, draftDecisions: [{ key: 'k', answer: 'x' }] })?.reason === 'ADOPT_WORDS', 'B0-13: 明確な採用語: 先に必要な判断が残っていれば AI に聞き直させ、無ければ ADOPT_DRAFT');
  assert(c('おすすめで', open)?.intent === 'ADOPT_DRAFT' && c('おすすめで', open)?.delegated[0].kind === 'delegated' && c('おすすめで', openNoRec)?.reason === 'DELEGATE_WITH_OPEN', 'B0-14:「おすすめで」: 推奨を採用（おまかせ）。推奨の無い先に必要な判断が残れば AI へ');
  assert(c('通知は不要、期限は5営業日、ほかは採用', open)?.intent === 'DRAFT_REPLY' && c('この案は採用しません', open)?.intent === 'DRAFT_REPLY' && c('ほかは採用で', open)?.intent === 'DRAFT_REPLY', 'B0-15: 修正の語を含む文・不採用は DRAFT_REPLY（AI に読ませる）');
  assert(c('何か', { ...noDraft, activePlan: { status: 'ACTIVE' } }) === null && c('採用します', { ...open, activePlan: { status: 'ACTIVE' } }) === null, 'B0-16: 計画があるときは従来どおり（null）');
});

// =========================================================
console.log('\n--- §B1. 会話コントローラ: R01〜R08 と「ありがとう」「うーん」を 1 本の会話として（偽 services.propose） ---');
/**
 * 偽 services。withPlan = true で services.plan を付ける（既定は計画を作らない応答）。planImpl で差し替え（x.planImpl = … で後から変えられる）。
 * proposeGate を渡すと、仮案の AI の応答を途中で止められる（応答待ちの間の発言の検証）。台本は scriptFn（既定は script）
 */
function makeConv({ features = ['requirements', 'brief', 'stream', 'proposal'], withPlan = false, planImpl = null, proposeGate = null, scriptFn = script } = {}) {
  const calls = { propose: [], ask: [], plan: [] };
  let t = 1000;
  const x = { planImpl };
  const services = {
    conversationFeatures: () => features,
    revisionModes: () => ['full'],
    async propose(args) {
      calls.propose.push({ utterance: args.utterance, previous: clone(args.previous), decisions: clone(args.decisions), requirements: clone(args.requirements), working: args.working });
      const raw = scriptFn(args);
      if (!raw) return { ok: false, reason: 'NO_SCRIPT', message: `台本がありません: ${args.utterance}` };
      t += 3000; if (typeof args.onText === 'function') args.onText(raw.reply.slice(0, 12)); await tick();
      if (proposeGate) await proposeGate.p;
      t += 4000; if (typeof args.onText === 'function') args.onText(raw.reply);
      return { ok: true, proposal: normalized(raw, `pp-${calls.propose.length}`), ctx: { facts: [] }, perf: { baseWaitMs: 0, contextMs: 5, requestMs: 7000 } };
    },
    async ask(args) { calls.ask.push({ question: args.question, conversation: clone(args.conversation) }); t += 2000; return { ok: true, answer: { answer: '5 営業日にすると判定が 2 営業日早くなります。', facts: [], analysis: [], recommendations: [], unknowns: [] }, ctx: { facts: [] } }; },
    readiness() { return null; },
    ...(withPlan || planImpl ? { async plan(args) { calls.plan.push({ goal: args.goal, decisions: clone(args.decisions ?? null), requirements: clone(args.requirements ?? null), revision: args.revision ? true : false }); t += 30000; return x.planImpl ? x.planImpl(args) : { plan: null, message: '（テスト: 計画は作らない）', reason: 'TEST' }; } } : {}),
  };
  const c = KTAiConversation.create({ services, now: () => '2026-10-07T00:00:00.000Z', clock: () => t });
  Object.assign(x, { c, calls, services, kinds: () => c.messages().map(m => m.data?.kind || m.type), last: () => c.messages()[c.messages().length - 1], draft: () => c.draft(), ledger: (id) => c.state.ledgers.get(id) || null });
  return x;
}
/** 計画の AI の成功の応答（最小の計画。turn に coverage 無し） */
const planOk = (args) => ({ plan: { goal: args.goal, assessment: { summary: '承認の流れを設定します。' }, steps: [], customizations: [], provisionals: [], questions: [] }, ctx: null, review: null, gatewayPlan: null, turn: { reply: '計画を作りました。', requirementOps: [], utteranceCoverage: [] } });
const planFail = () => ({ plan: null, message: '計画を作れませんでした（テスト）', reason: 'TEST' });
const planThrow = () => { throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' }); };
const gateMk = () => { let open; const p = new Promise(r => { open = r; }); return { p, open }; };
await section(async () => {
  const x = makeConv();
  const { c, calls } = x;
  const draft = () => c.draft();
  const keys = () => c.draftDecisions().map(d => d.key);
  const openKeys = () => (draft().items.decisions || []).map(d => d.key);
  const behaviorTexts = () => draft().items.behaviors.map(b => b.text);
  const reqs = () => c.requirements();
  assert(c.proposalOn() === true && c.classify('課長・部長の承認者を選ぶ運用にしたい').intent === 'PROPOSE', 'R01-0: health の conversation に proposal があるので仮案の経路');

  // R01
  const r1 = await c.send('課長・部長の承認者を選ぶ運用にしたい');
  assert(r1.ok && r1.intent === 'PROPOSE' && calls.propose.length === 1 && calls.plan.length === 0 && calls.propose[0].previous === null && calls.propose[0].decisions.length === 0, 'R01-1: 新しい依頼は仮案の AI へ（計画の AI・先回りの返答は呼ばない。前回の仮案は null）');
  assert(draft() && draft().status === 'open' && draft().rev === 1 && draft().request === '課長・部長の承認者を選ぶ運用にしたい' && draft().items.behaviors.length === 2 && draft().items.decisions.filter(d => d.blocking).length === 1 && draft().items.decisions.length === 1, `R01-2: 仮案 1 つ・先に必要な判断 1 件: ${JSON.stringify(draft().items.decisions.map(d => d.key))}`);
  const cards = c.messages().filter(m => m.type === 'DRAFT');
  assert(cards.length === 1 && cards[0].data.draftId === draft().id && cards[0].data.rev === 1 && /課長と部長を申請ごとに選んで/.test(cards[0].data.reply), 'R01-3: 仮案のカード（MSG.DRAFT）が 1 枚');
  assert(reqs().length === 1 && reqs()[0].decision === 'decided' && /課長と部長の承認者/.test(reqs()[0].behavior), `R01-4: 要件は仮案の台帳（鍵は仮案の id）に decided で入る: ${JSON.stringify(reqs())}`);
  const t1 = c.metrics().timings.slice(-1)[0];
  assert(t1.intent === 'PROPOSE' && t1.firstTextMs === 3000 && t1.doneMs === 7000 && t1.aiCalls === 1 && t1.calls[0].kind === 'propose' && t1.ai && t1.ai.model === 'm' && t1.ai.outputTokens === 500, `R01-5: 計測（firstTextMs / doneMs / ai）: ${JSON.stringify(t1)}`);
  assert(!c.messages().some(m => m.type === 'LOADING'), 'R01-6: 逐次表示の吹き出しは完了で外れる');

  // R02
  const r2 = await c.send('100円未満は部長不要、100万円以上は必要');
  assert(r2.ok && r2.intent === 'DRAFT_REPLY' && calls.propose.length === 2 && calls.propose[1].previous && calls.propose[1].previous.decisions[0].id === 'Q1' && calls.propose[1].previous.behaviors.length === 2, 'R02-1: 返事は前回の仮案（id 付き）と一緒に仮案の AI へ');
  assert(draft().rev === 2 && openKeys().join(',') === 'approval.threshold_middle,deadline.days,deadline.holidays' && draft().items.decisions.filter(d => d.blocking).length === 1 && behaviorTexts().some(s => /100円未満/.test(s)) && behaviorTexts().some(s => /100万円以上/.test(s)), `R02-2: 中間の扱いだけ 1 問（先に必要）・数字は不変: ${openKeys()} / ${behaviorTexts().join('｜')}`);
  assert(keys().includes('approval.threshold') && c.draftDecisions().find(d => d.key === 'approval.threshold').answer === '100円未満は不要、100万円以上は必要' && draft().items.behaviors[0].origin === 'user', 'R02-3: 前回の判断への回答は key 付きの決定事項に・採用した項目は origin user');
  assert(reqs().filter(r => r.decision !== 'revoked').length === 3 && c.messages().filter(m => m.type === 'DRAFT').length === 2, 'R02-4: 要件 3 件・仮案のカードは新しい 1 枚（前のカードは畳む側）');
  const prevCard = c.messages().filter(m => m.type === 'DRAFT')[0];
  assert(/kt-ai-old-card/.test(KTAiChatUi.messageHtml(prevCard, { draft: draft(), draftDecisions: c.draftDecisions() })) && /前の仮案 — このあと直した案があります/.test(KTAiChatUi.messageHtml(prevCard, { draft: draft(), draftDecisions: c.draftDecisions() })), 'R02-5: 前の仮案のカードは 1 行に畳む');

  // R03
  const r3 = await c.send('7営業日で。会社独自の休業日は今回はなし');
  assert(r3.ok && r3.intent === 'DRAFT_REPLY' && c.draftDecisions().find(d => d.key === 'deadline.days')?.answer === '7営業日' && c.draftDecisions().find(d => d.key === 'deadline.holidays')?.answer === '会社独自の休業日は考慮しない', `R03-1: 期限の日数と休業日を別の key で記録: ${JSON.stringify(c.draftDecisions().map(d => [d.key, d.answer]))}`);
  assert(openKeys().join(',') === 'approval.threshold_middle' && draft().items.assumptions.some(a => a.key === 'deadline.days'), 'R03-2: 回答済みの判断は仮案から消え、前提（7 営業日）になる');

  // R04
  const r4 = await c.send('現在の承認者へ。課長承認中で100万円以上なら部長にも通知');
  assert(r4.ok && behaviorTexts().some(s => /現在の承認者へ/.test(s)) && behaviorTexts().some(s => /課長承認中で100万円以上/.test(s)) && reqs().some(r => /現在の承認者/.test(r.behavior)) && reqs().some(r => /課長承認中で100万円以上/.test(r.condition) && /部長にも通知/.test(r.behavior)), `R04-1: 通知先と条件の両方が動作と要件に残る: ${behaviorTexts().slice(-2).join('｜')}`);
  assert(calls.propose[3].decisions.map(d => d.key).sort().join(',') === 'approval.threshold,deadline.days,deadline.holidays' && calls.propose[3].requirements.length >= 4, 'R04-2: 仮案の AI には決定事項（key 付き）と要件の台帳を毎回渡す');

  // R05
  await c.send('申請中は編集不可にして。CSV・APIは使わない');
  assert(openKeys().join(',') === 'approval.threshold_middle,lock.scope' && draft().items.assumptions.some(a => a.key === 'scope.csv_api') && draft().items.approach.js.length === 1, 'R05-1: 編集不可は JavaScript の進め方・CSV / API は前提として保持（判断にはしない）');
  const r5 = await c.send('全員で');
  assert(r5.ok && r5.intent === 'DRAFT_REPLY' && c.draftDecisions().find(d => d.key === 'lock.scope')?.answer === '全員' && openKeys().join(',') === 'approval.threshold_middle,notify.timing', 'R05-2:「全員で」は決定事項に統合され、同じ範囲（編集不可の対象）は再確認しない');

  // R06
  const r6 = await c.send('おすすめで');
  const mid = c.draftDecisions().find(d => d.key === 'approval.threshold_middle');
  assert(r6.ok && r6.intent === 'DRAFT_REPLY' && r6.reason === 'DELEGATE_WITH_OPEN' && mid && mid.kind === 'delegated' && mid.answer === '不要', `R06-1:「おすすめで」は推奨のある判断を採用（おまかせ）。推奨の無い先に必要な判断が残るので AI に残りだけ聞かせる: ${JSON.stringify(mid)}`);
  assert(calls.propose[6].decisions.some(d => d.key === 'approval.threshold_middle' && d.kind === 'delegated') && openKeys().join(',') === 'notify.timing' && draft().status === 'open', 'R06-2: おまかせの決定事項を AI に渡し、再要求されない（残りは通知のタイミングだけ）');
  const nPropose6 = calls.propose.length, rev6 = draft().rev, nReq6 = reqs().length;

  // R08（質問は従来の QA。仮案の要約を文脈に添える）
  const r8 = await c.send('5営業日にすると何が変わる？');
  assert(r8.ok && r8.intent === 'ASK' && calls.ask.length === 1 && calls.plan.length === 0 && calls.propose.length === nPropose6 && draft().rev === rev6, 'R08-1: 質問は仮案を変えず、計画の作成を始めない（質問の AI へ）');
  const cv = calls.ask[0].conversation;
  assert(cv.plan && /採用前の仮案/.test(cv.plan.summary) && cv.plan.questions.some(q => /部長への通知/.test(q.question)) && cv.plan.provisionals.some(p => p.topic === 'deadline.days') && cv.requirements.length === nReq6, `R08-2: 質問の AI に仮案の要約（動作・前提・残る判断・要件）を添える: ${JSON.stringify(cv.plan).slice(0, 160)}`);
  // 質問の形ではないが AI が相談（question）と読んだ発言: 仮案は変えない（proposalUnchanged）
  const r8b = await c.send('5営業日と7営業日の違いが気になる');
  assert(r8b.ok && r8b.intent === 'DRAFT_REPLY' && r8b.draft && r8b.draft.unchanged === true && draft().rev === rev6 && x.last().data?.kind === 'draft-reply' && /2 営業日早く/.test(x.last().text) && c.messages().filter(m => m.type === 'DRAFT').length === 7, 'R08-3: AI が相談と読んだときは仮案も要件も変えず、返事だけ（新しいカードは出さない）');

  // 相づち
  const ra = await c.send('ありがとう');
  const rb = await c.send('うーん');
  assert(ra.intent === 'GENERAL' && ra.reason === 'DRAFT_SMALLTALK' && rb.reason === 'DRAFT_SMALLTALK' && calls.propose.length === nPropose6 + 1 && draft().rev === rev6 && reqs().length === nReq6 && c.draftDecisions().length === 5, 'R-相づち:「ありがとう」「うーん」は AI を呼ばず、仮案・要件・決定事項を変えない');
  assert(/いつでもどうぞ/.test(x.last().text) && !INTERNAL.test(x.last().text), '相づちへの返事は短い案内だけ');

  // R07
  const r7 = await c.send('通知は不要、期限は5営業日、ほかは採用');
  assert(r7.ok && r7.intent === 'DRAFT_REPLY' && r7.draft && r7.draft.intent === 'adopt' && draft().status === 'adopted' && draft().adoptedBy === 'AI_ADOPT', `R07-1: 1 回の発言で不採用・変更・採用（intent adopt）→ 仮案は adopted: ${JSON.stringify(r7.draft)} / ${draft().status}`);
  const h = draft().history.slice(-1)[0];
  assert(h.applied.rejected.length === 2 && h.applied.modified.length === 1 && h.applied.adopted.length >= 3 && h.applied.dismissed.length === 1, `R07-2: 適用した返事（不採用 2・変更 1・採用 3 以上・不要になった判断 1）: ${JSON.stringify(h.applied)}`);
  assert(draft().rejected.length === 2 && draft().rejected.every(r => /通知/.test(r.text)) && !behaviorTexts().some(s => /通知/.test(s)) && draft().items.decisions.length === 0, 'R07-3: 不採用の項目は仮案から外れ、不採用として残る');
  const revoked = reqs().filter(r => r.decision === 'revoked');
  assert(revoked.length === 2 && revoked.every(r => /通知/.test(`${r.condition}${r.behavior}`)) && reqs().some(r => r.decision !== 'revoked' && /5 営業日/.test(r.behavior)) && !reqs().some(r => r.decision !== 'revoked' && /7 営業日/.test(r.behavior)), `R07-4: 通知の要件は revoke・期限の要件は 5 営業日に更新: ${JSON.stringify(reqs().map(r => [r.id, r.decision, r.behavior]))}`);
  assert(c.draftDecisions().find(d => d.key === 'deadline.days')?.answer === '承認の期限は申請から 5 営業日（土日祝のみ除く）' && c.draftDecisions().find(d => d.key === 'deadline.days').history.length === 1, 'R07-5: key のある前提の変更は、同じ key の決定事項も更新（前の答えは履歴に）');
  assert(x.last().data?.kind === 'draft-adopted' && /この案で進めます/.test(x.last().text) && calls.plan.length === 0, 'R07-6: services.plan が無いときは採用の案内だけ（最終案の作成は段階 C）');
  const t7 = c.metrics().timings.slice(-1)[0];
  assert(t7.intent === 'DRAFT_REPLY' && t7.ackMs != null && t7.firstTextMs === 3000 && t7.doneMs >= 7000, `R07-7: 計測: ${JSON.stringify({ intent: t7.intent, ackMs: t7.ackMs, firstTextMs: t7.firstTextMs, doneMs: t7.doneMs })}`);
  // 以後の台本で再質問が無かったこと（R03 / R05 / R06 の key）
  //   記録済みの決定事項（AI に渡す decisions）の key が、同じ呼び出しの前回の仮案の判断に残っていないこと（Toolkit が回答済みの key を仮案から外す）
  const reasked = calls.propose.flatMap((p, i) => { const done = new Set(p.decisions.map(d => d.key)); return (p.previous ? p.previous.decisions : []).filter(d => done.has(d.key)).map(d => `${i}:${d.key}`); });
  assert(reasked.length === 0 && calls.propose.slice(-1)[0].decisions.map(d => d.key).sort().join(',') === 'approval.threshold,approval.threshold_middle,deadline.days,deadline.holidays,lock.scope', `R03/R05: 回答済みの key は以後の仮案に判断として出ない（決定事項は 5 件を毎回渡す）: ${reasked.join(',')}`);
  // 表示: 内部の番号・key を出さない
  const view = { draft: draft(), draftDecisions: c.draftDecisions(), draftAnswers: new Map() };
  const html = c.messages().filter(m => m.type === 'DRAFT').map(m => KTAiChatUi.messageHtml(m, view)).join('');
  //   内部の番号・key の検査は details の中も含める（services.plan が無い採用は「採用しました（最終案はこのあと作ります）」）
  assert(!INTERNAL.test(html.replace(/data-[a-z]+="[^"]*"/g, '')) && /仮案 — 採用しました（最終案はこのあと作ります）/.test(html) && !/採用して最終案を作っています/.test(html), `表示: 内部の番号・key を出さない（details の中も）・採用した仮案は 1 行に畳む: ${(html.replace(/data-[a-z]+="[^"]*"/g, '').match(INTERNAL) || [])[0]}`);
  // 右ペインの詳細
  const sum = KTAiChatUi.draftSummaryHtml(draft(), { decisions: c.draftDecisions() });
  assert(/必要な判断/.test(sum) && sum.indexOf('必要な判断') < sum.indexOf('実現する動作') && /不採用にした項目/.test(sum) && /進め方/.test(sum) && /判断の経緯/.test(sum) && !INTERNAL.test(sum.replace(/data-[a-z]+="[^"]*"/g, '')), '右の詳細: 必要な判断を先に・不採用・進め方・判断の経緯');
});
// 採用の引き継ぎ（services.plan があるとき: 段階 B では従来の計画の作成へ。goal に採用した方針と決定事項）
await section(async () => {
  const x = makeConv({ withPlan: true });
  const { c, calls } = x;
  await c.send('課長・部長の承認者を選ぶ運用にしたい');
  await c.send('100円未満は部長不要、100万円以上は必要');
  const r = await c.send('採用します');
  assert(r.intent === 'DRAFT_REPLY' && r.reason === 'ADOPT_WITH_OPEN' && calls.plan.length === 0, '採用-1: 先に必要な判断が残る間は「採用します」でも採用にしない（AI に聞き直させる。台本が無いのでここでは失敗）');
  const x2 = makeConv({ withPlan: true });
  await x2.c.send('課長・部長の承認者を選ぶ運用にしたい');
  await x2.c.send('100円未満は部長不要、100万円以上は必要');
  await x2.c.send('7営業日で。会社独自の休業日は今回はなし');
  const r2 = await x2.c.send('おすすめで');
  //   goal は元の依頼文 ＋ 採用した方針 1 行だけ（決定事項・前提・不採用の長文は合成しない。決定事項と要件は構造化して渡す）。計画を作れなかったので仮案は open のまま
  const p0 = x2.calls.plan[0];
  assert(r2.intent === 'ADOPT_DRAFT' && r2.reason === 'DELEGATE' && x2.calls.plan.length === 1 && x2.c.draft().status === 'open' && x2.c.draft().planFailed && p0.goal.startsWith('課長・部長の承認者を選ぶ運用にしたい\n採用した方針:') && !/決定事項:|前提（変えてよい点）|不採用/.test(p0.goal) && p0.goal.length < 600, `採用-2:「おすすめで」で残る判断が無ければ採用 → 計画の依頼（goal は依頼文 ＋ 方針 1 行。失敗したら open のまま）: ${p0.goal.slice(0, 200)}`);
  const t = x2.c.metrics().timings.slice(-1)[0];
  assert(t.intent === 'ADOPT_DRAFT' && t.ackMs != null && t.calls.some(k => k.kind === 'plan'), `採用-3: 計測（ADOPT_DRAFT・calls に plan）: ${JSON.stringify({ intent: t.intent, calls: t.calls.map(k => k.kind) })}`);
  const dec = p0.decisions || [];
  assert(dec.length === 4 && dec.every((d, i) => d.id === `D${i + 1}` && d.source === 'chat' && d.status === 'answered') && dec.find(d => d.key === 'approval.threshold').topic === 'approver' && dec.find(d => d.key === 'deadline.days').topic === 'timing' && dec.find(d => d.key === 'deadline.holidays').topic === 'timing' && dec.find(d => d.key === 'approval.threshold_middle').delegated === true && !/おまかせ/.test(dec.find(d => d.key === 'approval.threshold_middle').answer) && dec.every(d => d.kind === 'question' && d.question), `採用-4: 決定事項は計画の AI に構造化して渡す（id D…・topic は key から・おまかせは別の印）: ${JSON.stringify(dec)}`);
  assert(Array.isArray(p0.requirements) && p0.requirements.length >= 4 && p0.requirements.every(r => /^R[0-9]+$/.test(r.id)) && p0.requirements.some(r => r.decision === 'decided' && /課長と部長の承認者/.test(r.behavior)), `採用-5: 要件の台帳も渡す: ${JSON.stringify(p0.requirements.map(r => [r.id, r.decision]))}`);
});
// 能力が無いときは従来の流れ（仮案の経路に入らない）
await section(async () => {
  const x = makeConv({ features: ['requirements', 'brief'], withPlan: true });
  const r = await x.c.send('課長・部長の承認者を選ぶ運用にしたい');
  assert(x.c.proposalOn() === false && r.intent === 'PLAN' && x.calls.propose.length === 0 && x.calls.plan.length === 1 && x.c.draft() === null, 'B5-1: health に proposal が無ければ従来の計画の経路（services.propose を呼ばない）');
  const y = makeConv({ features: ['requirements', 'brief', 'proposal'], withPlan: true });
  y.services.propose = undefined;
  const ry = await y.c.send('課長・部長の承認者を選ぶ運用にしたい');
  assert(y.c.proposalOn() === false && ry.intent === 'PLAN', 'B5-2: services.propose が無くても従来の経路');
});

// =========================================================
console.log('\n--- §B2. 画面: 偽 client（health に proposal・SSE の部分表示・カードのボタン・回答欄・採用で従来の計画へ） ---');
const HEALTH = { ok: true, supportedContractVersions: ['2.0', '2.1'], entitlements: [{ product: 'toolkit', features: ['assistant-qa', 'change-planner', 'customization-generator'] }], registry: { toolkit: { 'assistant-qa': { implemented: true, promptVersions: ['1'], conversation: ['requirements', 'brief', 'stream', 'proposal'] }, 'change-planner': { implemented: true, promptVersions: ['1'] }, 'customization-generator': { implemented: true, promptVersions: ['1'] } } }, usage: { monthlyLimit: 20, usedThisMonth: 1 } };
const spec = (o) => ({ name: null, from: null, to: null, filterCond: null, assignees: [], targets: [], events: [], timingField: null, daysLater: null, time: null, fields: [], sort: null, sourceApp: null, keyField: null, mappings: [], fieldType: null, required: null, options: [], destApp: null, accessibility: null, entities: [], customizationId: null, ...o });
const mkStep = (id, actionType, targetKind, targetRef, sp, extra = {}) => ({ id, actionType, targetKind, targetRef, targetExists: null, title: `${id} ${actionType}`, proposal: { summary: '', details: [] }, spec: spec(sp), dependsOn: [], reason: '', evidenceIds: [], confidence: 'INFERRED', alternativeId: null, validation: { status: 'ok', issues: [] }, execution: { mode: 'PLAN_ONLY', supported: false, reason: 'x' }, ...extra });
const PLAN_META = { requestId: 'pl-1', gateway: { product: 'toolkit', feature: 'change-planner', promptVersion: '1', contextVersion: 'planner-1' }, normalization: { warnings: [] }, ai: { model: 'm', latencyMs: 30, usage: { input_tokens: 500, output_tokens: 200 } }, usage: { usedThisMonth: 1, monthlyLimit: 20 } };
const PLAN_V1 = (goal) => ({ ok: true, contractVersion: '2.1', meta: PLAN_META, plan: { goal, assessment: { summary: '承認者の一覧を追加します。', usableExistingFields: [], usableExistingSettings: [], missingCapabilities: [], uncertainties: [] }, relevantFields: [], proposedFields: [], steps: [mkStep('P1', 'ADD_VIEW', 'VIEW', '承認待ち一覧', { name: '承認待ち一覧', fields: ['owner', 'case_name'], filterCond: 'owner in (LOGINUSER())', sort: 'due_date asc' }, { title: '一覧「承認待ち一覧」を追加' })], alternatives: [], impact: [], questions: [], unknowns: [], planConfidence: 'INFERRED' } });
const answerFor = (ctx, text) => ({ ok: true, contractVersion: '2.1', meta: { requestId: 'qa-1', usage: { usedThisMonth: 2, monthlyLimit: 20 }, normalization: { warnings: [] } }, answer: text, facts: [], analysis: [], recommendations: [], unknowns: [] });
const makeStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
const gate = () => { let open; const p = new Promise(r => { open = r; }); return { p, open }; };
function mount({ health = HEALTH, proposeGate = null, planImpl = null } = {}) {
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
    async generate() { throw new Error('not used'); },
  };
  const session = { status() { return { connected: true, apiBase: 'https://gw.test', refreshExpiresAt: '2099-01-01T00:00:00Z', scope: { product: 'toolkit', feature: 'assistant-qa,change-planner,customization-generator', domain: 't.cybozu.com' } }; }, async migrateLegacy() { return false; }, async refresh() { return {}; }, async disconnect() { return { revoked: true }; }, client };
  const flow = { start: async () => ({}), cancel() { }, reopen: () => false, state: () => ({ phase: 'idle' }), isRunning: () => false };
  const host = makeFakeHost();
  const mock = makeKintoneMock(INPUTS.data, { jsSources: [] });
  const panel = mountAiWorkspace(host, { getInputs: () => INPUTS, copyText: async () => true, downloadText: () => { }, colors: { border: '#ccc', bg: '#fff' }, settings, session, hostname: 't.cybozu.com', connectFlow: flow, executor: { api: mock.api, appId: '341' }, now: () => clock.t, clock: () => clock.t });
  const $ = (id) => host.querySelector(`#${id}`);
  return Object.assign(mx, { host, panel, $, calls, clock, conv: () => panel.conversation(), chat: () => $('kt-ai-chat').innerHTML, msgs: () => panel.conversation().state.messages });
}
const clickChat = (m, act, extra = {}) => m.$('kt-ai-chat').dispatch({ type: 'click', target: { dataset: { act, ...extra } } });
await section(async () => {
  const g = gate();
  const m = mount({ proposeGate: g });
  await ticks();
  const p = m.panel.send('課長・部長の承認者を選ぶ運用にしたい');
  await ticks(8);
  const during = m.chat();
  assert(m.calls.propose.length === 1 && m.calls.propose[0].stream === true && /kt-ai-streaming/.test(during) && /課長と部長を申請/.test(during) && !/kt-ai-draft-card/.test(during) && !/kt-ai-plan-card/.test(during), `B2-1: 仮案の AI の reply は SSE で部分表示（仮案のカード・変更案はまだ出ない）: ${during.slice(0, 200)}`);
  assert(/data-status="drafting">仮案を作成中</.test(m.$('kt-ai-ws-state').innerHTML) && m.conv().state.working === 'PROPOSE', `B2-1b: 右の見出しは「仮案を作成中」（応答待ちの間）: ${m.$('kt-ai-ws-state').innerHTML}`);
  // 応答待ちの間の発言: 質問は並べて答える（入力欄は空に）、それ以外は入力欄に残す（案内）
  m.$('kt-ai-input').value = 'CSVにも効きますか？';
  const rq1 = await m.panel.send('CSVにも効きますか？', { source: 'composer' });
  await ticks(4);
  assert(rq1 && rq1.asked === true && m.calls.ask.length === 1 && m.$('kt-ai-input').value === '' && m.calls.propose.length === 1, `B2-1c: 仮案の応答待ちの質問は並べて答える（入力欄は空に）: ${JSON.stringify(rq1)}`);
  m.$('kt-ai-input').value = '通知は不要';
  const rq2 = await m.panel.send('通知は不要', { source: 'composer' });
  assert(rq2 === null && m.$('kt-ai-input').value === '通知は不要' && /仮案を作っています。この文は仮案ができてから/.test(m.$('kt-ai-composer-note') ? m.$('kt-ai-composer-note').textContent : m.host.innerHTML), 'B2-1d: 仮案の応答待ちの返事・指示は入力欄に残し、案内を出す');
  g.open(); await p; await ticks(8);
  const ctx0 = m.calls.propose[0].ctx;
  assert(ctx0.conversation.mode === 'proposal' && ctx0.question === '課長・部長の承認者を選ぶ運用にしたい' && ctx0.conversation.proposal === null && Array.isArray(ctx0.facts) && ctx0.facts[0].id === 'E1' && ctx0.size.chars <= 12000 && !ctx0.planContext && ctx0.conversation.brief === undefined, `B2-2: 送った Context は KTContext.buildProposal（mode proposal・絞った facts）: ${ctx0.size.chars} 字`);
  const chat = m.chat();
  const card = (chat.match(/<div class="kt-ai-card kt-ai-draft-card[\s\S]*?まだ何も反映していません[\s\S]*?<\/div>/) || [''])[0];
  assert(/仮案ができました。/.test(chat) && /実現する動作/.test(chat) && /判断が必要な点/.test(chat) && /先に決めたいこと/.test(chat) && /おすすめ：一定金額以上のときだけ/.test(chat) && /こちらの提案で進める点が 2 件あります/.test(chat), 'B2-3: 仮案のカード: 結論 → 実現する動作 → 判断が必要な点（おすすめ）→ 前提');
  assert(/data-act="draft-adopt"[^>]*>採用</.test(chat) && /data-act="draft-partial"[^>]*>一部採用</.test(chat) && /data-act="draft-reject"[^>]*>不採用</.test(chat) && /data-act="draft-answer"[^>]*>回答を送る</.test(chat) && /class="kt-ai-qa-input kt-ai-draft-input" data-dkey="/.test(chat), 'B2-4: 入力の補助ボタン［採用］［一部採用］［不採用］と回答欄（カードの中）');
  //   仮案のカードは details の中（前提・判断の経緯）も含めて検査する（質問の答えのカードの「詳細情報」の requestId は従来の監査用の表示なので、会話全体は details の外で見る）
  const draftHtmlAll = m.msgs().filter(x => x.type === 'DRAFT').map(x => KTAiChatUi.messageHtml(x, { draft: m.conv().draft(), draftDecisions: m.conv().draftDecisions(), draftAnswers: new Map() })).join('').replace(/data-[a-z]+="[^"]*"/g, '');
  assert(!INTERNAL.test(outsideDetails(chat).replace(/data-[a-z]+="[^"]*"/g, '')) && !INTERNAL.test(draftHtmlAll) && /<details/.test(draftHtmlAll) && !/kt-ai-plan-card/.test(chat) && !/kt-ai-questions-card/.test(chat) && !/kt-ai-streaming/.test(chat), `B2-5: 会話に内部の番号・key を出さない（仮案のカードは details の中も）。確認事項のカード・変更案のカードは出ない: ${(draftHtmlAll.match(INTERNAL) || outsideDetails(chat).replace(/data-[a-z]+="[^"]*"/g, '').match(INTERNAL) || [])[0]}`);
  const sum = m.$('kt-ai-change-summary').innerHTML;
  assert(/必要な判断（1 件）/.test(sum) && /先に必要/.test(sum) && /実現する動作/.test(sum) && /こちらの提案で進める点/.test(sum) && /進め方/.test(sum) && m.$('kt-ai-pane-plan-empty').style.display === 'none', `B2-6: 右「変更内容」に仮案の詳細（必要な判断を先に）: ${sum.slice(0, 160)}`);
  assert(/data-status="draft">仮案</.test(m.$('kt-ai-ws-state').innerHTML), `B2-7: 右の見出しの状態: 仮案: ${m.$('kt-ai-ws-state').innerHTML}`);
  const t1 = m.panel.metrics().timings.slice(-1)[0];
  assert(t1.intent === 'PROPOSE' && t1.firstTextMs === 2500 && t1.doneMs === 7000 && t1.ai && t1.ai.model === 'm' && t1.perf && t1.perf.requestMs === 7000, `B2-8: 計測（画面の時計）: ${JSON.stringify({ intent: t1.intent, firstTextMs: t1.firstTextMs, doneMs: t1.doneMs, perf: t1.perf })}`);
  // ［一部採用］は入力欄に案内を出すだけ
  await clickChat(m, 'draft-partial', { draft: m.conv().draft().id });
  assert(/変えたい点を書いてください/.test(m.$('kt-ai-input').placeholder) && m.calls.propose.length === 1, 'B2-9:［一部採用］は入力欄の案内だけ（送らない）');
  // 回答欄 → 決定事項に記録してから AI へ
  const d1 = m.conv().draft();
  const q = d1.items.decisions[0];
  await m.$('kt-ai-chat').dispatch({ type: 'input', target: { dataset: { dkey: `${d1.id}:${q.key}`, draft: d1.id, did: q.id }, value: '100円未満は部長不要、100万円以上は必要' } });
  await clickChat(m, 'draft-answer', { draft: d1.id });
  await ticks(10);
  const ctx1 = m.calls.propose[1].ctx;
  const userMsgs = m.msgs().filter(x => x.type === 'USER');
  assert(m.calls.propose.length === 2 && ctx1.conversation.decisions.some(x => x.key === 'approval.threshold' && x.answer === '100円未満は部長不要、100万円以上は必要') && /100円未満は部長不要/.test(ctx1.question) && ctx1.conversation.proposal.behaviors.length === 2 && ctx1.conversation.proposal.decisions.length === 0, 'B2-10: 回答欄の回答は決定事項（key 付き）に記録してから、「回答: …」を含む発言として仮案の AI へ（回答済みの判断は前回の仮案から外す）');
  assert(userMsgs.slice(-1)[0].data?.displayText === '判断が必要な点への回答です。' && /判断が必要な点への回答です。/.test(m.chat()) && !/100円以上100万円未満の申請に部長承認は必要ですか[\s\S]*100円以上100万円未満の申請に部長承認は必要ですか[\s\S]*100円以上100万円未満/.test(outsideDetails(m.chat())), 'B2-11: 吹き出しは「判断が必要な点への回答です。」だけ');
  assert(m.conv().draft().rev === 2 && /仮案を直しました。/.test(m.chat()) && (m.chat().match(/kt-ai-draft-card is-old/g) || []).length === 1 && /前の仮案 — このあと直した案があります/.test(m.chat()) && /決めたこと：/.test(m.chat()), 'B2-12: 仮案のカードは置き換え（前の仮案は 1 行に畳む）。決めたことを示す');
  // ［採用］: 先に必要な判断（中間の金額）が残る → AI に聞き直させる（台本が無いので失敗の表示。採用にはならない）
  // → 残りの判断に答えてから採用
  await m.panel.send('7営業日で。会社独自の休業日は今回はなし'); await ticks(8);
  await m.panel.send('おすすめで'); await ticks(12);
  const dAfter = m.conv().draft();
  assert(dAfter.status === 'adopted' && m.calls.plan.length === 1 && m.calls.propose.length === 3 && m.conv().activePlan() && m.conv().activePlan().fromDraft && m.conv().activePlan().fromDraft.id === dAfter.id, `B2-13:「おすすめで」で残る判断が無ければ採用 → 従来の計画の作成へ（版に fromDraft）: ${dAfter.status} / plan ${m.calls.plan.length}`);
  assert(/採用した方針:/.test(m.calls.plan[0].ctx.goal) && m.conv().requirements().some(r => /課長と部長の承認者/.test(r.behavior)) && m.conv().requirements().length >= 4, 'B2-14: 要件の台帳は仮案の id から計画の planId へ引き継ぐ。goal に採用した方針');
  const chat2 = m.chat();
  assert(/仮案 — 採用して変更案を作りました/.test(chat2) && !/採用して最終案を作っています/.test(chat2) && /kt-ai-plan-card/.test(chat2) && !/data-act="draft-adopt"/.test(chat2) && /この案で進めます/.test(chat2) && dAfter.planId === m.conv().activePlan().planId, 'B2-15: 採用した仮案は 1 行に畳み（「採用して変更案を作りました」）、変更案のカードが出る（仮案のボタンは消える）');
  //   採用した仮案からの計画の Context: 要件の台帳は渡る。合成した依頼文は台帳の利用者の原文に入らない（未解決の要件も出ない）
  const lgP = m.conv().state.ledgers.get(m.conv().activePlan().planId);
  assert(Array.isArray(m.calls.plan[0].ctx.requirements) && m.calls.plan[0].ctx.requirements.length >= 4 && !(lgP.userTexts || []).some(s => /採用した方針/.test(s)) && !m.msgs().some(x => x.data?.kind === 'requirements-unresolved'), `B2-14b: 要件は Context に渡り、合成文は台帳に入らない: ${JSON.stringify(lgP.userTexts)}`);
  assert(/<h3>/.test(m.$('kt-ai-change-summary').innerHTML) && !/仮案（採用前）/.test(m.$('kt-ai-change-summary').innerHTML) && /data-status="ready">未反映</.test(m.$('kt-ai-ws-state').innerHTML), 'B2-16: 右は従来の変更内容の要約に戻る・状態は未反映');
  const tA = m.panel.metrics().timings.slice(-1)[0];
  assert(tA.intent === 'ADOPT_DRAFT' && tA.calls.map(c => c.kind).join(',') === 'plan' && tA.doneMs >= 30000, `B2-17: 採用の計測（calls に plan・doneMs）: ${JSON.stringify({ intent: tA.intent, calls: tA.calls.map(c => c.kind), doneMs: tA.doneMs })}`);
  // 計画ができた後は従来どおり（仮案の経路に入らない）
  const r = await m.panel.send('一覧の名前は承認待ちにして'); await ticks(8);
  assert(r && r.intent === 'REVISE_PLAN' && m.calls.propose.length === 3, 'B2-18: 計画がある（最終案の後）は従来の修正の経路');
});
// ［採用］［不採用］のボタンの文・新しい会話で仮案が消える
await section(async () => {
  const m = mount();
  await ticks();
  await m.panel.send('課長・部長の承認者を選ぶ運用にしたい'); await ticks(8);
  await clickChat(m, 'draft-adopt', { draft: m.conv().draft().id }); await ticks(8);
  const u = m.msgs().filter(x => x.type === 'USER').slice(-1)[0];
  assert(u.text === '採用します' && m.conv().draft().status === 'open' && m.calls.plan.length === 0, 'B2-19:［採用］は「採用します」を送る。先に必要な判断が残る間は採用にならない（AI に聞き直させる）');
  await clickChat(m, 'draft-reject', { draft: m.conv().draft().id }); await ticks(8);
  const u2 = m.msgs().filter(x => x.type === 'USER').slice(-1)[0];
  assert(u2.text === 'この案は採用しません' && m.conv().draft().status === 'open', 'B2-20:［不採用］は「この案は採用しません」を送る（AI が別の方向を聞き返す経路）');
  await clickChat(m, 'new-conv'); await ticks();
  assert(m.conv().draft() === null && m.conv().draftDecisions().length === 0 && m.$('kt-ai-change-summary').innerHTML === '' && /未作成/.test(m.$('kt-ai-ws-state').innerHTML), 'B2-21:［新しい会話］で仮案・決定事項・右の詳細は消える');
});
// 能力が無い health では従来の流れ（画面）
await section(async () => {
  const h = clone(HEALTH); h.registry.toolkit['assistant-qa'].conversation = ['requirements', 'brief', 'stream'];
  const m = mount({ health: h });
  await ticks();
  await m.panel.send('課長・部長の承認者を選ぶ運用にしたい'); await ticks(10);
  assert(m.calls.propose.length === 0 && m.calls.plan.length === 1 && m.conv().draft() === null && /kt-ai-plan-card/.test(m.chat()) && !/kt-ai-draft-card/.test(m.chat()), 'B5-3: health に proposal が無い画面は従来の計画の流れ（仮案のカードは出ない）');
});

// =========================================================
console.log('\n--- §B3. 独立レビューの指摘（2026-10-07）: 採用 → 計画の失敗 / 構造化した引き継ぎ / 不採用の取り消し / 再確認 / 新しい依頼 / 分類 / 応答待ち ---');
// 1. 採用 → 計画の作成の失敗で行き止まりにならない（open に戻る・履歴・［再試行］は「採用します」で仮案から作り直す・古い決定事項は新しい仮案に引き継がない）
await section(async () => {
  const x = makeConv({ planImpl: planFail });
  const { c, calls } = x;
  await c.send('課長・部長の承認者を選ぶ運用にしたい');
  await c.send('100円未満は部長不要、100万円以上は必要');
  await c.send('7営業日で。会社独自の休業日は今回はなし');
  const r = await c.send('おすすめで');
  const d = c.draft();
  const err = c.messages().filter(m => m.type === 'ERROR').slice(-1)[0];
  assert(r.intent === 'ADOPT_DRAFT' && r.ok === false && d.status === 'open' && d.planning === false && d.planFailed && d.planFailed.attempt === 1 && d.history.slice(-1)[0].kind === 'plan-failed' && !c.activePlan(), `B3-1: 計画を作れなかったら仮案は open に戻り、履歴に失敗を残す: ${d.status} / ${JSON.stringify(d.planFailed)}`);
  assert(err && err.data.retryText === '採用します' && err.data.intent === 'ADOPT_DRAFT' && /計画を作れませんでした（テスト）/.test(err.text), `B3-2: 失敗のカードの［再試行］は「採用します」（ADOPT_DRAFT）: ${JSON.stringify(err && err.data)}`);
  const view = { draft: d, draftDecisions: c.draftDecisions(), draftAnswers: new Map() };
  const cardHtml = KTAiChatUi.messageHtml(c.messages().filter(m => m.type === 'DRAFT').slice(-1)[0], view);
  assert(/仮案 — 採用（変更案の作成に失敗。再試行できます）/.test(cardHtml) && /data-act="draft-adopt"/.test(cardHtml) && !/kt-ai-old-card/.test(cardHtml), 'B3-3: 失敗した後の仮案のカードは開いたまま（もう一度採用できる）で、失敗したことを見出しに出す');
  const sumHtml = KTAiChatUi.draftSummaryHtml(d, { decisions: c.draftDecisions(), working: null });
  assert(/採用（変更案の作成に失敗。再試行できます）/.test(sumHtml) && !/最終案を作っています/.test(sumHtml) && /採用 → 変更案の作成に失敗/.test(sumHtml), 'B3-4: 右の詳細は失敗の文（「最終案を作っています」は出さない）。判断の経緯に失敗を残す');
  // ［再試行］（UI の handleAct 'retry' と同じ経路）: 仮案から作り直す（利用者の発言「おすすめで」を依頼文にしない）
  const rr = await c.send(err.data.retryText, { intentOverride: err.data.intent });
  assert(rr.intent === 'ADOPT_DRAFT' && calls.plan.length === 2 && calls.plan[1].goal === calls.plan[0].goal && calls.plan[1].goal.startsWith('課長・部長の承認者を選ぶ運用にしたい') && calls.plan[1].decisions.length === 4 && c.draft().planFailed.attempt === 2, `B3-5: ［再試行］は仮案（draftGoal ＋ 決定事項・要件）から作り直す: ${calls.plan[1].goal.slice(0, 60)}`);
  // もう一度「採用します」と言っても同じ（質問の AI に流れない）
  const ra = await c.send('採用します');
  assert(ra.intent === 'ADOPT_DRAFT' && ra.reason === 'ADOPT_WORDS' && calls.plan.length === 3 && calls.ask.length === 0, `B3-6: 失敗の後の「採用します」は採用（質問の AI に流れない）: ${ra.intent}/${ra.reason}`);
  // 計画の AI が直ったら: 採用 → adopted（計画が登録できた後）・畳んだカードの文・台帳に合成文が入らない・未解決の要件が出ない
  x.planImpl = planOk;
  const ok = await c.send('採用します');
  const d2 = c.draft(), v = c.activePlan();
  assert(ok.ok && d2.status === 'adopted' && d2.planId === v.planId && !d2.planFailed && v.fromDraft && v.fromDraft.id === d2.id && c.messages().some(m => m.type === 'PLAN'), `B3-7: 計画ができたら仮案は adopted（計画の登録の後）: ${d2.status}`);
  const lgP = c.state.ledgers.get(v.planId);
  assert(!(lgP.userTexts || []).some(s => /採用した方針|決定事項:/.test(s)) && !c.messages().some(m => m.data?.kind === 'requirements-unresolved') && c.requirements().every(r => r.decision !== 'undecided') && calls.plan[3].requirements.some(r => /課長と部長の承認者/.test(r.behavior)), `B3-8: 合成した依頼文は台帳の利用者の原文に入らず、未解決の要件も作らない: ${JSON.stringify(lgP.userTexts)}`);
  const cardDone = KTAiChatUi.messageHtml(c.messages().filter(m => m.type === 'DRAFT').slice(-1)[0], { draft: d2, draftDecisions: c.draftDecisions() });
  assert(/仮案 — 採用して変更案を作りました/.test(cardDone) && /kt-ai-old-card/.test(cardDone), 'B3-9: 計画ができた後の仮案のカードは「仮案 — 採用して変更案を作りました」に畳む');
  const t = c.metrics().timings.slice(-1)[0];
  assert(t.intent === 'ADOPT_DRAFT' && t.calls.map(k => k.kind).join(',') === 'plan', 'B3-10: 計測は従来どおり（calls に plan）');
});
// 1b. 計画の AI の例外（タイムアウト）でも同じ（open に戻る・再試行は ADOPT_DRAFT）。AI の intent adopt の経路（DRAFT_REPLY）でも
await section(async () => {
  const x = makeConv({ planImpl: planThrow });
  const { c, calls } = x;
  for (const s of ['課長・部長の承認者を選ぶ運用にしたい', '100円未満は部長不要、100万円以上は必要', '7営業日で。会社独自の休業日は今回はなし', '現在の承認者へ。課長承認中で100万円以上なら部長にも通知', '申請中は編集不可にして。CSV・APIは使わない', '全員で', 'おすすめで']) await c.send(s);
  const r7 = await c.send('通知は不要、期限は5営業日、ほかは採用');
  const d = c.draft();
  const err = c.messages().filter(m => m.type === 'ERROR').slice(-1)[0];
  assert(r7.intent === 'DRAFT_REPLY' && r7.ok === false && r7.error && r7.error.code === 'TIMEOUT' && d.status === 'open' && d.planFailed && calls.plan.length === 1, `B3-11: AI の intent adopt → 計画の例外でも仮案は open に戻る: ${d.status} / ${JSON.stringify(r7.error)}`);
  assert(err.data.retryText === '採用します' && err.data.intent === 'ADOPT_DRAFT' && err.data.retryable === true, `B3-12: 例外の失敗カードの［再試行］も「採用します」（ADOPT_DRAFT）: ${JSON.stringify(err.data)}`);
  const rr = await c.send(err.data.retryText, { intentOverride: err.data.intent });
  assert(rr.intent === 'ADOPT_DRAFT' && calls.plan.length === 2 && calls.plan[1].goal === calls.plan[0].goal && calls.plan[1].requirements.some(r => r.decision === 'revoked') && calls.plan[1].decisions.length === 5, `B3-13: ［再試行］は仮案から作り直す（取り消し済みの要件も渡す）: ${JSON.stringify(calls.plan[1].requirements.map(r => [r.id, r.decision]))}`);
});
// 1c. AI の intent adopt の経路でも、計画を作っている間は working PLAN（右の見出し「最終案を作成中」。右の詳細の「最終案を作っています」はその間だけ）
await section(async () => {
  const g = gateMk();
  const x = makeConv({ planImpl: async () => { await g.p; return planFail(); } });
  const { c } = x;
  for (const s of ['課長・部長の承認者を選ぶ運用にしたい', '100円未満は部長不要、100万円以上は必要', '7営業日で。会社独自の休業日は今回はなし', '現在の承認者へ。課長承認中で100万円以上なら部長にも通知', '申請中は編集不可にして。CSV・APIは使わない', '全員で', 'おすすめで']) await c.send(s);
  const p = c.send('通知は不要、期限は5営業日、ほかは採用');
  await ticks(8);
  const d = c.draft();
  const ws = VM.workStatus({ version: null, working: c.state.working, draft: d });
  const cardMid = KTAiChatUi.messageHtml(c.messages().filter(m => m.type === 'DRAFT').slice(-1)[0], { draft: d, draftDecisions: c.draftDecisions() });
  assert(c.isBusy() && c.state.working === 'PLAN' && d.planning === true && d.status === 'open' && ws.key === 'finalizing' && ws.label === '最終案を作成中', `B3-14: AI の intent adopt で計画を作っている間は working PLAN・右の見出し「最終案を作成中」: ${c.state.working} / ${JSON.stringify(ws)}`);
  assert(/仮案 — 採用して最終案を作っています/.test(cardMid) && !/data-act="draft-adopt"/.test(cardMid) && /最終案を作っています/.test(KTAiChatUi.draftSummaryHtml(d, { decisions: c.draftDecisions(), working: 'PLAN' })) && !/最終案を作っています/.test(KTAiChatUi.draftSummaryHtml(d, { decisions: c.draftDecisions(), working: null })), 'B3-15: 作っている間はカードを畳み、右の詳細の「最終案を作っています」は working PLAN のときだけ');
  const rq = await c.send('一覧の名前は承認待ちにして');
  assert(rq && rq.queued === true && rq.reason === 'QUEUED_DURING_PLAN', 'B3-16: 作っている間の指示は従来どおり積む');
  g.open(); await p; await ticks(4);
  assert(c.state.working === null && c.draft().status === 'open' && c.draft().planFailed && VM.workStatus({ version: null, working: null, draft: c.draft() }).key === 'draft', 'B3-17: 失敗の後は working null・見出しは「仮案」に戻る');
});
// 2. 計画ができたときの引き継ぎ: 合成文を台帳に入れない（S5 の再現）・requirements と decisions が渡る
await section(async () => {
  const x = makeConv({ planImpl: planOk });
  const { c, calls } = x;
  for (const s of ['課長・部長の承認者を選ぶ運用にしたい', '100円未満は部長不要、100万円以上は必要', '7営業日で。会社独自の休業日は今回はなし', '現在の承認者へ。課長承認中で100万円以上なら部長にも通知', '申請中は編集不可にして。CSV・APIは使わない', '全員で', 'おすすめで']) await c.send(s);
  const before = c.requirements().map(r => r.id);
  const r7 = await c.send('通知は不要、期限は5営業日、ほかは採用');
  const v = c.activePlan(), d = c.draft();
  const p0 = calls.plan[0];
  assert(r7.ok && v && d.status === 'adopted' && d.adoptedBy === 'AI_ADOPT' && d.planId === v.planId, `B3-18: 1 文で不採用・変更・採用 → 計画 → adopted: ${d.status}/${d.adoptedBy}`);
  assert(p0.goal.split('\n').length === 2 && p0.goal.startsWith('課長・部長の承認者を選ぶ運用にしたい') && /^採用した方針: /.test(p0.goal.split('\n')[1]) && !/通知/.test(p0.goal.split('\n')[1]) && !/決定事項|前提|不採用/.test(p0.goal), `B3-19: goal は依頼文 ＋ 採用した方針 1 行（不採用の通知は入らない）: ${p0.goal}`);
  assert(p0.decisions.length === 5 && p0.decisions.find(x => x.key === 'deadline.days').answer === '承認の期限は申請から 5 営業日（土日祝のみ除く）' && p0.decisions.find(x => x.key === 'lock.scope').answer === '全員' && p0.requirements.filter(r => r.decision === 'revoked').length === 2 && p0.requirements.some(r => r.decision !== 'revoked' && /5 営業日/.test(r.behavior)), `B3-20: 決定事項（5 件・最新の答え）と要件（取り消し 2 件を含む）を渡す: ${JSON.stringify(p0.decisions.map(x => [x.key, x.answer]))}`);
  const lgP = c.state.ledgers.get(v.planId);
  assert(c.requirements().map(r => r.id).join() === before.join() && !c.requirements().some(r => r.decision === 'undecided') && !(lgP.userTexts || []).some(s => /採用した方針/.test(s)) && !c.messages().some(m => m.data?.kind === 'requirements-unresolved'), `B3-21: 計画のターンで要件が増えない（合成文を未解決の要件にしない）・台帳の原文に合成文が無い: ${JSON.stringify(lgP.userTexts)}`);
});
// 4. 不採用の要件の取り消しは仮案の項目 id → 要件 id の対応で（id で引けないときだけ内容の文字の重なりで補う。短い動作の包含では取り消さない）
await section(async () => {
  const scriptRj = ({ utterance: u, previous: p }) => {
    const prevB = (p && p.behaviors) || [];
    if (/承認者を選ぶ/.test(u)) return { reply: '仮案です。', intent: 'propose', proposal: { behaviors: [B('申請時に承認者を選ぶ', 'user'), B('承認依頼のとき部長に通知する'), B('期限超過のとき申請者へ催促する')], assumptions: [], decisions: [], approach: { standard: ['プロセス管理'], js: [] }, cannot: [] },
      turn: { ops: [], answers: [], requirementOps: [
        req('add', { target: '承認', condition: '申請時', behavior: '承認者を選ぶ', sourceQuotes: ['承認者を選ぶ'], planRefs: ['B1'] }),
        req('add', { target: '通知', condition: '承認依頼のとき', behavior: '通知する', decision: 'proposed', planRefs: ['B2'] }),
        req('add', { target: '催促', condition: '期限超過のとき', behavior: '申請者へ催促する', decision: 'proposed' }),
        req('add', { target: '催促', condition: '', behavior: '催促する', decision: 'proposed' }),
      ] } };
    if (/文言を変えて/.test(u)) return { reply: '文言を変えました。', intent: 'update', proposal: { behaviors: [B('申請時に承認者を選ぶ', 'user'), B('承認依頼のとき部長に通知する'), B('期限超過のとき申請者へ催促する')], assumptions: [A('notify.text', '通知の文言', '通知の文言は「承認をお願いします」', '変えられます')], decisions: [], approach: { standard: ['プロセス管理'], js: [] }, cannot: [] }, turn: { ops: [], answers: [], requirementOps: [] } };
    if (/通知も催促も不要/.test(u)) return { reply: '通知と催促を外して採用します。', intent: 'adopt', proposal: { behaviors: [B('申請時に承認者を選ぶ', 'user')], assumptions: [], decisions: [], approach: { standard: ['プロセス管理'], js: [] }, cannot: [] },
      turn: { ops: [...prevB.filter(b => /通知|催促/.test(b.text)).map(b => ({ id: b.id, op: 'reject', text: '', quote: '通知も催促も不要' })), ...prevB.filter(b => !/通知|催促/.test(b.text)).map(b => ({ id: b.id, op: 'adopt', text: '', quote: 'ほかは採用' }))], answers: [], requirementOps: [] } };
    return null;
  };
  const x = makeConv({ scriptFn: scriptRj });
  const { c } = x;
  await c.send('課長・部長の承認者を選ぶ運用にしたい');
  const lg = x.ledger(c.draft().id);
  assert(JSON.stringify(lg.itemReqs) === JSON.stringify({ B1: ['R1'], B2: ['R2'] }), `B3-22: 要件の add の planRefs から「仮案の項目 id → 要件 id」の対応を台帳に持つ: ${JSON.stringify(lg.itemReqs)}`);
  await c.send('通知の文言を変えて');   // 項目の id は振り直されるが、同じ文の項目に対応を引き継ぐ
  assert(c.draft().rev === 2 && JSON.stringify(lg.itemReqs) === JSON.stringify({ B1: ['R1'], B2: ['R2'] }), `B3-23: 仮案を直しても（id の振り直し）同じ文の項目に対応を引き継ぐ: ${JSON.stringify(lg.itemReqs)}`);
  const r = await c.send('通知も催促も不要、ほかは採用');
  const reqs = c.requirements();
  const byId = (id) => reqs.find(e => e.id === id);
  assert(r.ok && byId('R1').decision === 'decided' && byId('R2').decision === 'revoked' && byId('R3').decision === 'revoked' && byId('R4').decision !== 'revoked', `B3-24: 不採用 → id の対応で R2 を取り消し、対応の無い R3 は内容の文字の重なり（7 割）で取り消し、短い動作だけの R4（「催促する」）は取り消さない: ${JSON.stringify(reqs.map(e => [e.id, e.decision]))}`);
  const raw = KTAiAnswers.requirementsOf(lg);
  assert(raw.find(e => e.id === 'R2').revokedBy.by === 'id' && raw.find(e => e.id === 'R3').revokedBy.by === 'overlap', `B3-25: 取り消しの根拠（id / overlap）を要件に残す: ${JSON.stringify(raw.map(e => [e.id, e.revokedBy && e.revokedBy.by]))}`);
});
// 6. 回答済みの key の判断を AI がもう一度出したら「再確認」（前の答えを添える。答えると同じ key を置き換える）。同じターンで答えたばかりの key は出さない
await section(async () => {
  const QD = Q('deadline.days', '承認の期限', '承認の期限は申請から何営業日にしますか', ['5営業日', '7営業日'], '5営業日', '期限超過の判定日が変わります', false);
  const scriptRc = ({ utterance: u, previous: p }) => {
    const prevD = (p && p.decisions) || [];
    if (/承認者を選ぶ/.test(u)) return { reply: '仮案です。', intent: 'propose', proposal: { behaviors: [B('申請時に承認者を選ぶ', 'user')], assumptions: [], decisions: [QD], approach: { standard: [], js: [] }, cannot: [] }, turn: { ops: [], answers: [], requirementOps: [] } };
    // 回答 → 決定事項に。AI が同じターンに同じ key の判断をまだ出している（読み落とし）→ 出さない
    if (/^7営業日/.test(u)) return { reply: '7 営業日で進めます。', intent: 'update', proposal: { behaviors: [B('申請時に承認者を選ぶ', 'user')], assumptions: [], decisions: [QD], approach: { standard: [], js: [] }, cannot: [] }, turn: { ops: [], answers: [{ id: idBy(prevD, d => d.key === 'deadline.days'), kind: 'value', text: '7営業日', quote: '7営業日' }], requirementOps: [] } };
    // 後のターンで AI が理由をつけて同じ key を出した → 再確認
    if (/起算日/.test(u)) return { reply: '起算日を翌営業日にすると期限が 1 日延びます。日数を確認させてください。', intent: 'update', proposal: { behaviors: [B('申請時に承認者を選ぶ', 'user')], assumptions: [A('deadline.base', '起算日', '期限は申請日の翌営業日から数える', '')], decisions: [{ ...QD, question: '起算日を翌営業日にしても、期限は 7 営業日のままでよいですか' }], approach: { standard: [], js: [] }, cannot: [] }, turn: { ops: [], answers: [], requirementOps: [] } };
    if (/^5営業日/.test(u)) return { reply: '5 営業日にします。', intent: 'update', proposal: { behaviors: [B('申請時に承認者を選ぶ', 'user')], assumptions: [A('deadline.base', '起算日', '期限は申請日の翌営業日から数える', ''), A('deadline.days', '期限', '期限は 5 営業日', '')], decisions: [], approach: { standard: [], js: [] }, cannot: [] }, turn: { ops: [], answers: [{ id: idBy(prevD, d => d.key === 'deadline.days'), kind: 'value', text: '5営業日', quote: '5営業日' }], requirementOps: [] } };
    return null;
  };
  const x = makeConv({ scriptFn: scriptRc });
  const { c, calls } = x;
  await c.send('課長・部長の承認者を選ぶ運用にしたい');
  await c.send('7営業日で');
  assert(c.draftDecisions().find(d => d.key === 'deadline.days').answer === '7営業日' && c.draft().items.decisions.length === 0 && c.draft().history.slice(-1)[0].hiddenDecisions.join() === 'deadline.days', 'B3-26: 同じターンで答えたばかりの key を AI がまだ出していたら出さない（hidden）');
  await c.send('起算日は翌営業日にして');
  const d = c.draft();
  const rc = d.items.decisions[0];
  const open = KTAiConversation.openDraftDecisions(d, c.draftDecisions());
  assert(d.items.decisions.length === 1 && rc.reconfirm === true && rc.previousAnswer === '7営業日' && open.length === 1 && open[0].key === 'deadline.days' && c.draftDecisions().length === 1, `B3-27: 後のターンで回答済みの key をもう一度出したら「再確認」として残す（決定事項は置き換えない）: ${JSON.stringify(rc)}`);
  const cardHtml = KTAiChatUi.messageHtml(c.messages().filter(m => m.type === 'DRAFT').slice(-1)[0], { draft: d, draftDecisions: c.draftDecisions(), draftAnswers: new Map() });
  assert(/再確認：前の答えは「7営業日」です/.test(cardHtml) && /data-dkey="/.test(cardHtml) && /再確認：前の答えは「7営業日」/.test(KTAiChatUi.draftSummaryHtml(d, { decisions: c.draftDecisions() })), 'B3-28: カードと右の詳細に「再確認」と前の答えを出す（回答欄あり。hidden で隠さない）');
  await c.send('5営業日にします');
  const prevSent = calls.propose[3].previous;
  const dd = c.draftDecisions().find(x => x.key === 'deadline.days');
  assert(prevSent.decisions.length === 1 && prevSent.decisions[0].key === 'deadline.days' && dd.answer === '5営業日' && dd.history.length === 1 && dd.history[0].answer === '7営業日' && KTAiConversation.openDraftDecisions(c.draft(), c.draftDecisions()).length === 0 && c.draftDecisions().length === 1, `B3-29: 再確認の判断は previous に残して AI へ渡し、答えたら同じ key を置き換える（前の答えは履歴に）: ${JSON.stringify(dd)}`);
});
// 7. 前回の仮案があるのに intent が propose なら新しい仮案（前の仮案は superseded。決定事項は引き継がない。前のカードは「前の仮案（別の依頼）」）
await section(async () => {
  const scriptNew = ({ utterance: u, previous: p }) => {
    const prevD = (p && p.decisions) || [];
    if (/承認者を選ぶ/.test(u)) return { reply: '仮案です。', intent: 'propose', proposal: { behaviors: [B('申請時に承認者を選ぶ', 'user')], assumptions: [], decisions: [Q_DAYS], approach: { standard: [], js: [] }, cannot: [] }, turn: { ops: [], answers: [], requirementOps: [req('add', { target: '承認', condition: '申請時', behavior: '承認者を選ぶ', sourceQuotes: ['承認者を選ぶ'], planRefs: ['B1'] })] } };
    if (/^7営業日/.test(u)) return { reply: '7 営業日で進めます。', intent: 'update', proposal: { behaviors: [B('申請時に承認者を選ぶ', 'user')], assumptions: [A('deadline.days', '期限', '期限は 7 営業日', '')], decisions: [], approach: { standard: [], js: [] }, cannot: [] }, turn: { ops: [], answers: [{ id: idBy(prevD, d => d.key === 'deadline.days'), kind: 'value', text: '7営業日', quote: '7営業日' }], requirementOps: [] } };
    if (/一覧も/.test(u)) return { reply: '一覧の仮案です。', intent: 'propose', proposal: { behaviors: [B('承認待ち一覧を追加する', 'user')], assumptions: [], decisions: [Q_DAYS], approach: { standard: [], js: [] }, cannot: [] }, turn: { ops: [], answers: [], requirementOps: [req('add', { target: '一覧', condition: '', behavior: '承認待ち一覧を追加する', sourceQuotes: ['一覧も作りたい'], planRefs: ['B1'] })] } };
    return null;
  };
  const x = makeConv({ scriptFn: scriptNew });
  const { c, calls } = x;
  await c.send('課長・部長の承認者を選ぶ運用にしたい');
  await c.send('7営業日で');
  const old = c.draft();
  const oldCard = c.messages().filter(m => m.type === 'DRAFT').slice(-1)[0];
  const r = await c.send('承認待ちの一覧も作りたい');
  const d = c.draft();
  assert(r.intent === 'DRAFT_REPLY' && r.draft.intent === 'propose' && d.id !== old.id && d.rev === 1 && d.request === '承認待ちの一覧も作りたい' && old.status === 'superseded' && old.supersededBy && c.draftDecisions().length === 0 && d.items.decisions.length === 1, `B3-30: intent propose なら新しい仮案（新しい id・request は今回の発言）。前の仮案は superseded・決定事項は引き継がない: ${d.id !== old.id} / ${old.status} / ${c.draftDecisions().length}`);
  assert(c.requirements().length === 1 && /一覧/.test(c.requirements()[0].behavior) && calls.propose[2].previous && calls.propose[2].previous.behaviors.length === 1, 'B3-31: 要件の台帳も新しい仮案のもの（前の仮案は AI に previous として渡した上で、AI が別の依頼と読んだ）');
  const html = KTAiChatUi.messageHtml(oldCard, { draft: d, draftDecisions: c.draftDecisions() });
  assert(/前の仮案（別の依頼）/.test(html) && /kt-ai-old-card/.test(html) && !/data-act="draft-adopt"/.test(html), 'B3-32: 前の仮案のカードは「前の仮案（別の依頼）」に畳む');
  // 新しい仮案の判断（期限）は、前の仮案での答え（7 営業日）が引き継がれないので未回答
  assert(KTAiConversation.openDraftDecisions(d, c.draftDecisions()).length === 1 && calls.propose[2].decisions.length === 1, 'B3-33: 新しい仮案の AI の呼び出しには前の決定事項を渡すが（AI が同じ依頼の続きと読む余地）、新しい仮案になったら持ち越さない');
});
// 8. 分類: 仮案が open のときの採用語と相づち・NO_PLAN の案内文
await section(async () => {
  const c = KTAiConversation.classifyDraft;
  const noOpen = { activePlan: null, draftDecisions: [], draft: { id: 'd1', status: 'open', items: { behaviors: [], assumptions: [], decisions: [], approach: { standard: [], js: [] }, cannot: [] } } };
  const withOpen = { ...noOpen, draft: { ...noOpen.draft, items: { ...noOpen.draft.items, decisions: [{ id: 'Q1', key: 'k', question: 'q', recommendation: '', blocking: true }] } } };
  const adoptWords = ['承認します', '確定', 'それで', 'お願いします', 'よろしくお願いします', '採用します', 'それでお願いします', 'これで確定で'];
  assert(adoptWords.every(s => c(s, noOpen)?.intent === 'ADOPT_DRAFT' && c(s, noOpen)?.reason === 'ADOPT_WORDS') && adoptWords.every(s => c(s, withOpen)?.reason === 'ADOPT_WITH_OPEN'), `B3-34: 採用語（承認します・確定・それで・お願いします・よろしくお願いします）は採用（先に必要な判断が残れば AI に聞き直させる）: ${adoptWords.map(s => `${s}:${c(s, noOpen)?.intent}/${c(s, noOpen)?.reason}`).join(' ')}`);
  assert(['はい', 'OK', 'ok', 'うん', '了解'].every(s => c(s, noOpen)?.reason === 'DRAFT_SMALLTALK' && c(s, noOpen)?.ack === true) && c('ありがとう', noOpen)?.reason === 'DRAFT_SMALLTALK' && !c('ありがとう', noOpen)?.ack, 'B3-35:「はい」「OK」単独は相づち（採用ではない。採用の言い方を案内する）');
  assert(c('通知は不要でお願いします', noOpen)?.intent === 'DRAFT_REPLY' && c('承認してください', noOpen)?.intent === 'ADOPT_DRAFT' && c('反映して', noOpen) === null && c('お願いします', { activePlan: null, draft: null, draftDecisions: [] }) === null, 'B3-36: 修正の語があれば AI へ・反映の命令は従来・仮案が無ければ「お願いします」は従来の相づち');
  const x = makeConv({ withPlan: true });
  await x.c.send('課長・部長の承認者を選ぶ運用にしたい');
  const n = x.calls.propose.length;
  const r1 = await x.c.send('はい');
  assert(r1.reason === 'DRAFT_SMALLTALK' && x.calls.propose.length === n && x.calls.plan.length === 0 && /採用するときは「採用します」/.test(x.last().text), `B3-37:「はい」は AI を呼ばず採用の言い方を案内: ${x.last().text}`);
  const r2 = await x.c.send('反映して');
  assert(r2.intent === 'GENERAL' && r2.reason === 'NO_PLAN' && /仮案への返事（採用・変えたい点・質問）/.test(x.last().text) && x.calls.plan.length === 0, `B3-38: 仮案 open のときの NO_PLAN の案内は仮案への返事を促す: ${x.last().text}`);
});
// 10. 仮案の AI の応答待ちの間: 質問は並べて答え、それ以外は入力欄に残す（null）。見出しは「仮案を作成中」
await section(async () => {
  const g = gateMk();
  const x = makeConv({ proposeGate: g });
  const { c, calls } = x;
  const p = c.send('課長・部長の承認者を選ぶ運用にしたい');
  await ticks(4);
  const ws = VM.workStatus({ version: null, working: c.state.working, draft: c.draft() });
  assert(c.isBusy() && c.canQueue() && c.state.working === 'PROPOSE' && c.state.workInbox && c.state.workInbox.kind === 'PROPOSE' && ws.key === 'drafting' && ws.label === '仮案を作成中', `B3-39: 応答待ちの間は working PROPOSE・見出し「仮案を作成中」: ${JSON.stringify(ws)}`);
  const rq = await c.send('CSVにも効きますか？');
  const rr = await c.send('通知は不要');
  const rg = await c.send('ありがとう');
  assert(rq && rq.asked === true && rq.reason === 'ASKED_WHILE_BUSY' && calls.ask.length === 1 && rr === null && rg === null, `B3-40: 質問は並べて答え（質問の AI へ）、返事・相づちは入力欄に残す（null）: ${JSON.stringify(rq)} / ${rr} / ${rg}`);
  assert(calls.ask[0].conversation.working === null && calls.ask[0].conversation.plan === null, 'B3-41: 質問の AI に渡す working は Gateway の語彙（null）。仮案はまだ無い');
  assert(/仮案を作っています。質問にはすぐ答えます/.test(KTAiChatUi.busyHintText('PROPOSE')) && /この文は仮案ができてから/.test(KTAiChatUi.busyHintText('PROPOSE', { accepted: false })), 'B3-42: 入力欄の案内（応答待ち）');
  g.open(); await p; await ticks(4);
  assert(c.draft() && c.draft().rev === 1 && c.state.workInbox === null && c.state.working === null && c.messages().filter(m => m.type === 'DRAFT').length === 1 && c.messages().some(m => m.data?.kind === 'aside-answer'), 'B3-43: 応答の後は仮案 1 枚・質問の答えのカード・作業の受け口は空');
});

// =========================================================
console.log('\n--- §B4. 画面: 採用 → 計画の失敗 → 再試行 / 回答欄のフォーカス ---');
await section(async () => {
  const pg = gateMk();
  const m = mount({ planImpl: async () => { await pg.p; throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' }); } });
  await ticks();
  await m.panel.send('課長・部長の承認者を選ぶ運用にしたい'); await ticks(8);
  await m.panel.send('100円未満は部長不要、100万円以上は必要'); await ticks(8);
  await m.panel.send('7営業日で。会社独自の休業日は今回はなし'); await ticks(8);
  const p = m.panel.send('おすすめで'); await ticks(10);
  assert(/data-status="finalizing">最終案を作成中</.test(m.$('kt-ai-ws-state').innerHTML) && /最終案を作っています/.test(m.$('kt-ai-change-summary').innerHTML) && /仮案 — 採用して最終案を作っています/.test(m.chat()) && !/data-act="draft-adopt"/.test(m.chat()), `B4-1: 計画を作っている間: 右の見出し「最終案を作成中」・右の詳細「最終案を作っています」・カードは畳む: ${m.$('kt-ai-ws-state').innerHTML}`);
  pg.open(); await p; await ticks(8);
  const err = m.msgs().filter(x => x.type === 'ERROR').slice(-1)[0];
  assert(m.conv().draft().status === 'open' && /data-status="draft">仮案</.test(m.$('kt-ai-ws-state').innerHTML) && /採用（変更案の作成に失敗。再試行できます）/.test(m.$('kt-ai-change-summary').innerHTML) && !/最終案を作っています/.test(m.$('kt-ai-change-summary').innerHTML), `B4-2: 失敗の後: 仮案は open・右の見出し「仮案」・右の詳細に失敗の文: ${m.$('kt-ai-ws-state').innerHTML}`);
  assert(err && err.data.intent === 'ADOPT_DRAFT' && err.data.retryText === '採用します' && /data-act="retry"/.test(m.chat()) && /仮案 — 採用（変更案の作成に失敗。再試行できます）/.test(m.chat()) && /data-act="draft-adopt"/.test(m.chat()), 'B4-3: 失敗のカードに［再試行］（採用します）・仮案のカードは開いたまま（採用のボタンあり）');
  await clickChat(m, 'retry', { text: err.data.retryText, intent: err.data.intent }); await ticks(8);
  assert(m.calls.plan.length === 2 && m.calls.plan[1].ctx.goal === m.calls.plan[0].ctx.goal && m.conv().draft().status === 'open' && m.conv().draft().planFailed.attempt === 2, 'B4-4: ［再試行］は仮案から作り直す（同じ依頼文）。また失敗したら open のまま');
  m.planImpl = null;   // 計画の AI が直った
  const u = m.msgs().filter(x => x.type === 'USER').length;
  await clickChat(m, 'draft-adopt', { draft: m.conv().draft().id }); await ticks(10);
  const d = m.conv().draft(), v = m.conv().activePlan();
  assert(m.msgs().filter(x => x.type === 'USER').length === u + 1 && v && d.status === 'adopted' && d.planId === v.planId && /仮案 — 採用して変更案を作りました/.test(m.chat()) && /kt-ai-plan-card/.test(m.chat()) && /data-status="ready">未反映</.test(m.$('kt-ai-ws-state').innerHTML) && /<h3>/.test(m.$('kt-ai-change-summary').innerHTML), `B4-5: ［採用］でもう一度 → 計画ができたら adopted・カードを畳む・右は変更内容に: ${d.status} / ${m.$('kt-ai-ws-state').innerHTML}`);
  // 回答欄（data-dkey）のフォーカスの復元: 描き直しの前に入力中だった回答欄へ戻す（Toolkit の sandbox の document.activeElement を仮に置く）
  const el = { dataset: { dkey: 'x:k' }, selectionStart: 2, focused: false, caret: null, focus() { this.focused = true; }, setSelectionRange(a) { this.caret = a; } };
  const chatEl = m.$('kt-ai-chat');
  const prevQSA = chatEl.querySelectorAll;
  const sbDoc = T.__sandbox.document;
  chatEl.querySelectorAll = (sel) => (sel === '.kt-ai-qa-input' ? [el] : []);
  sbDoc.activeElement = el;
  try { await m.panel.send('ありがとう'); await ticks(4); } finally { delete sbDoc.activeElement; chatEl.querySelectorAll = prevQSA; }
  assert(el.focused === true && el.caret === 2, 'B4-6: 仮案の回答欄（data-dkey）に入力中なら、描き直しの後にフォーカスとカーソルを戻す');
});

// =========================================================
console.log('\n--- §B6. 段階 B 修正後の確認（2026-10-07）: 決定事項が最初の計画に届く / 応答待ちのボタン / 表示用の goal / 作成中の要約 / 仮案が無いときの判定 ---');
/** 計画の AI が、仮案で答えた論点（期限の日数）をもう一度質問し、新しい論点（指定する画面）も質問する計画 */
const PLAN_QS = [{ id: 'Q1', question: '承認の期限は申請から何営業日にしますか', topic: 'timing' }, { id: 'Q2', question: '承認者はどの画面で指定しますか', topic: 'location' }];
const planReask = (args) => { const r = planOk(args); return { ...r, plan: { ...r.plan, questions: PLAN_QS } }; };
// 1. 会話: 採用 → 最初の計画の services.plan に決定事項（構造化）→ 計画の AI が同じ論点を質問しても openQuestions に出ない（reasked に記録）→ 台帳に回答済みとして入る → 差分更新でも decisions に入る
await section(async () => {
  const x = makeConv({ planImpl: planReask });
  const { c, calls } = x;
  for (const s of ['課長・部長の承認者を選ぶ運用にしたい', '100円未満は部長不要、100万円以上は必要', '7営業日で。会社独自の休業日は今回はなし']) await c.send(s);
  const r = await c.send('おすすめで');
  const v = c.activePlan();
  assert(r.ok && r.intent === 'ADOPT_DRAFT' && v && calls.plan.length === 1 && !calls.plan[0].revision && Array.isArray(calls.plan[0].decisions) && calls.plan[0].decisions.length === 4 && calls.plan[0].decisions.some(d => d.key === 'deadline.days' && d.answer === '7営業日'), `B6-1: 採用 → 最初の計画（revision 無し）の services.plan に仮案で答えた決定事項（4 件）を渡す: ${JSON.stringify((calls.plan[0] || {}).decisions)}`);
  const openTexts = (v.openQuestions || []).map(q => q.text), reasked = (v.reaskedQuestions || []).map(q => q.text);
  assert(openTexts.join('|') === '承認者はどの画面で指定しますか' && reasked.join('|') === '承認の期限は申請から何営業日にしますか', `B6-2: 計画の AI が仮案で答えた論点（期限の日数）をもう一度質問しても openQuestions に出ない（reasked に記録）。新しい論点だけ残る: open=${openTexts.join('|')} / reasked=${reasked.join('|')}`);
  const lg = c.ledger(v.planId);
  const carried = lg.filter(e => e.draftKey);
  assert(carried.length === 4 && carried.every(e => e.status === 'answered' && e.source === 'chat' && e.appliedInVersion === 1 && e.question && e.kind === 'question') && carried.find(e => e.draftKey === 'deadline.days').topics.join() === 'timing' && carried.find(e => e.draftKey === 'approval.threshold').topics.join() === 'approver' && carried.find(e => e.draftKey === 'approval.threshold').label === '部長承認の条件' && carried.find(e => e.draftKey === 'approval.threshold_middle').delegated === true && !carried.find(e => e.draftKey === 'deadline.days').delegated, `B6-3: 仮案の決定事項は計画の系列の台帳に回答済み（topics は key から・label・question・answer・delegated の印・最初の版に入れた）として入る: ${JSON.stringify(carried.map(e => [e.draftKey, e.topics, e.label, e.answer, e.delegated || false, e.appliedInVersion]))}`);
  assert(!c.messages().some(m => m.data?.kind === 'answers-ack') && c.answerContext().open.length === 1 && c.answerContext().open[0].text === '承認者はどの画面で指定しますか', `B6-4: 台帳に入れた決定事項は「まだ変更案に入っていない回答」にならず、未回答は新しい論点の 1 件だけ: ${JSON.stringify(c.answerContext().open.map(q => q.text))}`);
  // 表示用の goal（確認 3）: 版の goal は仮案の依頼文（1 行目）。Gateway へ送った goal（goalSent）は依頼文 ＋ 採用した方針の 2 行のまま
  assert(v.goal === '課長・部長の承認者を選ぶ運用にしたい' && v.goalSent === calls.plan[0].goal && v.goalSent.split('\n').length === 2 && /^採用した方針: /.test(v.goalSent.split('\n')[1]), `B6-5: 版の表示用の goal は仮案の依頼文の 1 行目。Gateway へ送る goal は今のまま（2 行）: ${JSON.stringify({ goal: v.goal, goalSent: v.goalSent })}`);
  // 差分更新: 送る goal は goalSent・決定事項（仮案の分を含む）を渡す
  const rr = await c.send('一覧の名前は承認待ちにして');
  const p1 = calls.plan[1];
  assert(rr.ok && rr.intent === 'REVISE_PLAN' && calls.plan.length === 2 && p1.revision === true && p1.goal === v.goalSent && (p1.decisions || []).some(d => d.topic === 'timing' && d.answer === '7営業日') && (p1.decisions || []).some(d => d.topic === 'approver' && d.answer === '100円未満は不要、100万円以上は必要') && (p1.decisions || []).length >= 4, `B6-6: 以後の差分更新でも仮案の決定事項が decisionsForContext に入り、goal は Gateway へ送ったもの（2 行）のまま: ${JSON.stringify({ goal: p1.goal.split('\n').length, decisions: (p1.decisions || []).map(d => [d.topic, d.answer]) })}`);
  const v2 = c.activePlan();
  assert(v2.version === 2 && v2.goal === '課長・部長の承認者を選ぶ運用にしたい' && v2.goalSent === v.goalSent && v2.fromDraft && v2.fromDraft.id === c.draft().id, `B6-7: 次の版も表示用の goal は 1 行目のまま（fromDraft を引き継ぐ）: ${JSON.stringify({ goal: v2.goal, version: v2.version })}`);
});
// 1b. 画面: Gateway に送る Planner Context（KTContextUi.generatePlan の ctx）に decisions が入る・右の見出しは依頼文の 1 行目・計画の AI の再質問は出ない
await section(async () => {
  const planWithQs = ({ ctx, requestId }) => { const raw = PLAN_V1(ctx.goal); raw.plan.questions = PLAN_QS; const v = KTAiClient.validatePlan(raw, ctx); if (!v.ok) throw new Error(v.errors[0].message); return { ...v.normalized, requestId, clientWarnings: v.warnings }; };
  const m = mount({ planImpl: planWithQs });
  await ticks();
  for (const s of ['課長・部長の承認者を選ぶ運用にしたい', '100円未満は部長不要、100万円以上は必要', '7営業日で。会社独自の休業日は今回はなし']) { await m.panel.send(s); await ticks(8); }
  await m.panel.send('おすすめで'); await ticks(12);
  const ctx = m.calls.plan[0] && m.calls.plan[0].ctx;
  const v = m.conv().activePlan();
  assert(v && ctx && !ctx.revision && Array.isArray(ctx.decisions) && ctx.decisions.length === 4 && ctx.decisions.every((d, i) => d.id === `D${i + 1}` && d.source === 'chat' && d.status === 'answered' && d.answer) && ctx.decisions.some(d => d.topic === 'timing' && d.answer === '7営業日') && ctx.decisions.some(d => d.topic === 'approver' && /部長承認/.test(d.question || '')), `B6-8: 採用後の最初の計画の Planner Context（Gateway に送る形）に decisions（D1…・topic・question・answer）が入る: ${JSON.stringify(ctx && ctx.decisions)}`);
  assert(ctx.goal.split('\n').length === 2 && v.goal === '課長・部長の承認者を選ぶ運用にしたい' && /<h3>課長・部長の承認者を選ぶ運用にしたい<\/h3>/.test(m.$('kt-ai-change-summary').innerHTML) && !/<h3>[^<]*採用した方針/.test(m.$('kt-ai-change-summary').innerHTML), `B6-9: 右ペインの見出しは依頼文の 1 行目（合成の 2 行にならない）。Context の goal は 2 行のまま: ${(m.$('kt-ai-change-summary').innerHTML.match(/<h3>[^<]*<\/h3>/) || [])[0]}`);
  const openTexts = (v.openQuestions || []).map(q => q.text), reasked = (v.reaskedQuestions || []).map(q => q.text);
  assert(openTexts.join('|') === '承認者はどの画面で指定しますか' && reasked.join('|') === '承認の期限は申請から何営業日にしますか' && !/承認の期限は申請から何営業日にしますか[\s\S]*data-qkey/.test(outsideDetails(m.chat())) && /承認者はどの画面で指定しますか/.test(m.chat()), `B6-10: 画面でも、仮案で答えた論点の再質問は確認事項に出ず、新しい論点だけ出る: open=${openTexts.join('|')} / reasked=${reasked.join('|')}`);
});
// 2. 画面: 仮案の AI の応答待ち中（working PROPOSE）は、仮案のカードの［採用］［一部採用］［不採用］と回答欄を出さず、短い案内を出す（カードは畳まない）
await section(async () => {
  const gm = { p: Promise.resolve() };   // 1 回目の仮案は止めない。2 回目の返事の応答だけ止める
  const m = mount({ proposeGate: gm });
  await ticks();
  await m.panel.send('課長・部長の承認者を選ぶ運用にしたい'); await ticks(8);
  const before = m.chat();
  assert(/data-act="draft-adopt"/.test(before) && /data-dkey="/.test(before) && !/仮案の返事を待っています/.test(before), 'B6-11: 応答を待っていないときは［採用］と回答欄がある');
  const g = gate(); gm.p = g.p;
  const p = m.panel.send('100円未満は部長不要、100万円以上は必要'); await ticks(8);
  const during = m.chat();
  const cardDuring = (during.match(/<div class="kt-ai-card kt-ai-draft-card[\s\S]*?<\/div>\s*<\/div>/) || [''])[0];
  assert(m.conv().state.working === 'PROPOSE' && !/data-act="draft-adopt"|data-act="draft-partial"|data-act="draft-reject"|data-act="draft-answer"/.test(during) && !/data-dkey="/.test(during) && /kt-ai-draft-card is-waiting/.test(during) && /仮案の返事を待っています/.test(during) && !/kt-ai-draft-card is-old/.test(during) && !INTERNAL.test(outsideDetails(during).replace(/data-[a-z]+="[^"]*"/g, '')), `B6-12: 応答待ち中は［採用］［一部採用］［不採用］と回答欄を出さず、「仮案の返事を待っています」の案内だけ（カードは畳まない）: ${cardDuring.slice(0, 160)}`);
  const users = m.msgs().filter(x => x.type === 'USER').length;
  await clickChat(m, 'draft-adopt', { draft: m.conv().draft().id }); await ticks(4);
  assert(m.msgs().filter(x => x.type === 'USER').length === users && m.calls.plan.length === 0 && m.calls.propose.length === 2, 'B6-13: 応答待ち中に古いカードの［採用］が押されても、送らない（計画も作らない）');
  g.open(); await p; await ticks(8);
  const after = m.chat();
  assert(m.conv().draft().rev === 2 && /data-act="draft-adopt"/.test(after) && /data-dkey="/.test(after) && !/仮案の返事を待っています/.test(after) && (after.match(/kt-ai-draft-card is-old/g) || []).length === 1, 'B6-14: 応答が届いたら新しいカードに［採用］と回答欄が戻り、前のカードは 1 行に畳む');
  const viewNoWorking = KTAiChatUi.messageHtml(m.msgs().filter(x => x.type === 'DRAFT').slice(-1)[0], { draft: m.conv().draft(), draftDecisions: m.conv().draftDecisions(), draftAnswers: new Map() });
  const viewWorking = KTAiChatUi.messageHtml(m.msgs().filter(x => x.type === 'DRAFT').slice(-1)[0], { draft: m.conv().draft(), draftDecisions: m.conv().draftDecisions(), draftAnswers: new Map(), working: 'PROPOSE' });
  assert(/data-act="draft-adopt"/.test(viewNoWorking) && !/data-act="draft-adopt"/.test(viewWorking) && /仮案の返事を待っています/.test(viewWorking) && /data-act="draft-adopt"/.test(KTAiChatUi.messageHtml(m.msgs().filter(x => x.type === 'DRAFT').slice(-1)[0], { draft: m.conv().draft(), draftDecisions: m.conv().draftDecisions(), draftAnswers: new Map(), working: 'PLAN' })), 'B6-15: draftCardHtml は view.working が PROPOSE のときだけ押せないボタンを出さない（PLAN は draft.planning で判定）');
});
// 4. 採用して最終案を作っている間の、質問の AI に渡す仮案の要約は「採用した仮案（最終案を作成中）」
await section(async () => {
  const g = gateMk();
  const x = makeConv({ planImpl: async () => { await g.p; return planOk({ goal: 'g' }); } });
  const { c, calls } = x;
  for (const s of ['課長・部長の承認者を選ぶ運用にしたい', '100円未満は部長不要、100万円以上は必要', '7営業日で。会社独自の休業日は今回はなし']) await c.send(s);
  const p = c.send('おすすめで');
  await ticks(6);
  const rq = await c.send('CSVにも効きますか？');
  const cv = calls.ask.slice(-1)[0].conversation;
  assert(rq && rq.asked === true && c.draft().planning === true && cv.plan && /^採用した仮案（最終案を作成中）: /.test(cv.plan.summary) && !/採用前の仮案/.test(cv.plan.summary) && cv.working === 'PLAN', `B6-16: 最終案を作っている間の質問には「採用した仮案（最終案を作成中）」の要約を添える: ${cv.plan && cv.plan.summary.slice(0, 60)} / ${cv.working}`);
  g.open(); await p; await ticks(4);
  assert(c.activePlan() && c.draft().status === 'adopted', 'B6-17: 計画ができたら adopted（要約は計画に切り替わる）');
  const y = makeConv();
  await y.c.send('課長・部長の承認者を選ぶ運用にしたい');
  await y.c.send('5営業日にすると何が変わる？');
  assert(/^採用前の仮案（まだ計画ではありません）: /.test(y.calls.ask[0].conversation.plan.summary), 'B6-18: 採用前は従来どおり「採用前の仮案（まだ計画ではありません）」');
});
// 5. 仮案が無いときの PROPOSE 判定: 相づち・制止・短い否定は従来の判定へ。言い切りの長さの条件は 8 字以上
await section(async () => {
  const cd = KTAiConversation.classifyDraft;
  const noDraft = { activePlan: null, draft: null, draftDecisions: [] };
  const notReq = ['問題ありません', 'ちょっと待って', 'やめる', 'やっぱりやめる', 'この案は採用しません', '結構です', '採用しません', 'やめて', '大丈夫です', '不採用で', '違います', 'いいえ'];
  assert(notReq.every(s => cd(s, noDraft) === null), `B6-19: 仮案が無いとき、相づち・制止・短い否定は PROPOSE にしない（従来の判定へ）: ${notReq.map(s => `${s}:${cd(s, noDraft)?.intent || 'null'}`).join(' ')}`);
  assert(cd('承認者は部長', noDraft) === null && cd('承認者は部長固定', noDraft)?.intent === 'PROPOSE' && cd('承認済みでは金額を編集不可', noDraft)?.intent === 'PROPOSE' && cd('通知は不要', noDraft)?.intent === 'PROPOSE' && cd('一覧も作りたい', noDraft)?.intent === 'PROPOSE', 'B6-20: 言い切りは 8 字以上で依頼と読む（要望の語があれば短くても依頼）');
  const open = { activePlan: null, draftDecisions: [], draft: { id: 'd1', status: 'open', items: { behaviors: [], assumptions: [], decisions: [], approach: { standard: [], js: [] }, cannot: [] } } };
  assert(cd('この案は採用しません', open)?.intent === 'DRAFT_REPLY' && cd('やっぱりやめる', open)?.intent === 'DRAFT_REPLY' && cd('問題ありません', open)?.intent === 'ADOPT_DRAFT', 'B6-21: 仮案が open のときの判定は変えない（不採用・やめるは AI へ、問題ありませんは採用語）');
  // 従来の会話の経路（仮案が無い）: 「ちょっと待って」で仮案の AI を呼ばない
  const x = makeConv({ withPlan: true });
  const r = await x.c.send('ちょっと待って');
  assert(r.intent !== 'PROPOSE' && x.calls.propose.length === 0 && x.calls.plan.length === 0, `B6-22: 「ちょっと待って」は仮案の AI も計画の AI も呼ばない: ${r.intent}/${r.reason}`);
});

console.log(`\n${state.passed} passed, ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})();
