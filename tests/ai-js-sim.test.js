// 段階 C（C1）模擬イベント KTJsSim: 純関数（代表条件・レコード・無限ループ対策・判定）＋ 隔離環境の runtime（Node では vm の別 context）
//
// 検証内容（実機の結果が分かっている素材で固定する: p21-bfc-replay / stage-a-edit-lock / rc-e2e-replay）:
//   §1 純関数: 無限ループ対策の差し込み（directive を壊さない）・代表条件（同じ条件の組・各値 × 画面・合わないステータス・新設・既存の対象・空・保存時・12 件まで）・レコードの形
//   §2 R12: 排他の最小ケース（ステータス不明は error ＋ return / 承認待ちは disabled）→ 競合なし
//   §3 R13: 同じ経路の無条件の error と disabled → 競合（block）。別ファイルの disabled と候補の error → 競合（候補が関与）
//   §4 R15: 編集制限コード（両承認待ち・通常編集・一覧編集・明細・保存禁止・既存制御）→ 全件合格。既存の承認済みのロックは注記・保存時の入力チェックは候補と無関係
//   §5 未確認: 無限ループ → 未確認（例外にしない）・通信（kintone.api / fetch）→ 未確認・構文エラー → 未確認。例外 → sim-exception（block・ファイルと行）
//   §6 実機の再生: rc-e2e S2_V3（作成画面の undefined を見逃し保存できた）→ 不合格（block）、S2_V2 → 合格。BFC（getFieldElement が null で警告が出なかった）→ 不合格。
//      p21 GENERATED（!disabled で分けた警告）→ 承認済みの既存ロックと競合しない。分けないと競合（block）
//   §7 判定の形: review.sim の形・feedback の失敗の構造化・候補の hash・Gateway に渡す cases の形
//
// 実行方法: node tests/ai-js-sim.test.js
'use strict';
// 隔離環境（vm）の中で生成した JS が待たずに捨てた通信の Promise（模擬では reject）は、Node では未処理の reject になる。通信を止めた印（ktSimNet）のものだけ無視する
process.on('unhandledRejection', (e) => { if (e && e.ktSimNet) return; console.error(e); process.exit(1); });
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const { makeVmBackend } = require('./helpers/js-sim-vm.js');
const T = loadToolkit();
const { KTJsSim, KTCodeReview, KTModernJs, KTScan, KTDeps } = T;
const { assert, state } = makeAssert();
const R = require('./fixtures/p21-bfc-replay.js');
const SA = require('./fixtures/stage-a-edit-lock.js');
const E2E = require('./fixtures/rc-e2e-replay.js');
const clone = (v) => JSON.parse(JSON.stringify(v));
const backend = makeVmBackend({ timeoutMs: 2000 });
async function section(fn) { try { await fn(); } catch (e) { assert(false, `例外: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' / ') : e}`); } }
const check = (sim, name) => (sim.checks || []).find(x => x.name === name) || null;
/** 不合格の検査があるか（sim-control は合格のときも info で入るので、名前だけで見ない） */
const bad = (sim, name) => { const c = (sim.checks || []).find(x => x.name === name && !x.ok); return !!c; };
const INTERNAL = /\bS[0-9]+\b|\b[BAQ][0-9]+\b/;

// ---- アプリの定義: App 353 のフィールド ＋ プロセス管理（stage-a-edit-lock と同じ）----
const DATA = { appId: '353', fields: clone(R.FIELDS), status: clone(SA.STATUS), layout: [] };
const STATUS_NOW = { enable: true, states: { '作成中': { name: '作成中', index: '0', assignee: { type: 'ONE', entities: [] } }, '承認待ち': { name: '承認待ち', index: '1', assignee: { type: 'ONE', entities: [] } }, '承認済み': { name: '承認済み', index: '2', assignee: { type: 'ONE', entities: [] } } }, actions: [] };
const DATA_NOW = { appId: '353', fields: clone(R.FIELDS), status: clone(STATUS_NOW), layout: [] };
const handler = (events, body) => `(function () {\n  'use strict';\n  kintone.events.on(${JSON.stringify(events).replace(/"/g, "'")}, function (event) {\n    const record = event.record;\n${body}\n    return event;\n  });\n})();`;
const EDIT = ['app.record.edit.show'];
const cust = (o = {}) => ({ customizationId: 'C1', requirement: '承認待ちでは金額を編集不可にする', strategy: 'NEW_JS_FILE', platform: ['desktop'], events: EDIT, fields: [{ code: 'ステータス', access: 'READ' }, { code: 'amount', access: 'CONTROL', condition: 'ステータス in ("承認待ち")' }], apis: [], existingFiles: [], ...o });
const gen = (code, o = {}) => ({ strategy: 'NEW_JS_FILE', targetFile: 'lock.js', summary: 's', code, patch: null, events: EDIT, fields: [{ code: 'amount', access: 'CONTROL' }], apis: [], ...o });
const existing = (name, text) => ({ name, target: 'desktop', text, sourceAvailable: true, analyzed: true });
const simNew = (code, c = cust(), { otherFiles = [], data = DATA_NOW } = {}) => KTJsSim.simulate({ customization: c, generated: gen(code), review: { finalCode: code }, existingSource: null, otherFiles, data, backend });

(async () => {
// =========================================================
console.log('\n--- §1 純関数: 無限ループ対策・代表条件・レコード ---');
await section(() => {
  const ins = KTJsSim.instrument("(function () {\n  'use strict';\n  function f(n) { while (n > 0) n--; for (const x of [1]) { f(x); } }\n  const g = () => 1;\n  const h = (a) => { return a; };\n})();");
  assert(ins.ok && ins.guards === 5 && /'use strict';__ktSimGuard\(\);/.test(ins.text) && /while \(n > 0\) \{ __ktSimGuard\(\); n--; \}/.test(ins.text) && /for \(const x of \[1\]\) \{__ktSimGuard\(\); f\(x\); \}/.test(ins.text) && !/=> 1\s*\{/.test(ins.text), `1-1: ループの本体と関数の入口に上限の確認を差し込む（'use strict' の後・ブロックの無い本体は包む・式のアロー関数は触らない）: ${ins.text}`);
  const bad = KTJsSim.instrument('function (');
  assert(!bad.ok && bad.reason === 'SYNTAX' && /構文エラー/.test(bad.message) && !/Unexpected token/.test(bad.message), `1-2: 構文エラーは「未確認（構文）」の材料（英語の定型文は出さない）: ${bad.message}`);
  // 代表条件（R15 の実装仕様: 同じ条件の 5 フィールドは 1 つの組。既存 2 ファイル）
  const files = [existing('dealLock.js', SA.DEAL_LOCK), existing('dealValidate.js', SA.DEAL_VALIDATE)];
  const r = KTJsSim.casesFor({ customization: SA.CUSTOMIZATION, data: DATA, planned: { statuses: [{ name: '本部長承認待ち', stepId: 'P9' }], fields: [] }, existingFiles: files });
  const cs = r.cases;
  const of = (kind) => cs.filter(x => x.kind === kind);
  assert(cs.length <= 12 && cs.length >= 8 && cs.every((x, i) => x.id === `S${i + 1}`) && cs.every(x => x.targets.length === 5 && x.targets.some(t => t.code === 'items' && ['item_name', 'qty', 'unit_price'].every(c => t.cells.includes(c)))), `1-3: 1 候補あたり 12 件まで・同じ条件のフィールドは 1 つの組（テーブルは列のセルつき）: ${cs.length} 件 ${JSON.stringify(cs.map(x => [x.kind, x.event]))}`);
  assert(of('match').length === 4 && of('match').every(x => x.expect === 'disabled') && of('match').map(x => `${x.values['ステータス']}@${x.event}`).sort().join('|') === '課長承認待ち@app.record.edit.show|課長承認待ち@app.record.index.edit.show|部長承認待ち@app.record.edit.show|部長承認待ち@app.record.index.edit.show', `1-4: 条件の各値（課長承認待ち・部長承認待ち）× 通常編集・一覧編集 → 制御を期待: ${JSON.stringify(of('match').map(x => [x.values, x.event]))}`);
  assert(of('status-miss').length === 1 && of('status-miss')[0].values['ステータス'] === '作成中' && of('status-miss')[0].expect === 'not-disabled' && of('status-miss-planned').length === 1 && of('status-miss-planned')[0].values['ステータス'] === '本部長承認待ち', `1-5: 条件に合わないステータス（現在から 1 つ・新設から 1 つ）→ 制御しないことを期待: ${JSON.stringify([...of('status-miss'), ...of('status-miss-planned')].map(x => x.values))}`);
  assert(of('status-existing').length === 1 && of('status-existing')[0].values['ステータス'] === '承認済み' && of('status-existing')[0].expect === 'not-disabled' && /既存の JavaScript/.test(of('status-existing')[0].label), `1-6: 既存の dealLock.js がロックの対象にする承認済み → 候補は制御しない（既存の制御は注記）: ${JSON.stringify(of('status-existing').map(x => x.label))}`);
  const emp = of('empty')[0];
  assert(emp && emp.screen === 'create' && emp.event === 'app.record.create.show' && emp.record.amount && emp.record.amount.value === KTJsSim.UNDEF && !('ステータス' in emp.record) && !('レコード番号' in emp.record) && emp.record.items.value[0].value.qty.value === KTJsSim.UNDEF, `1-7: 空の値は作成画面（既存の create.show を使う）で undefined・システムフィールドは無い・明細のセルも空: ${JSON.stringify(emp && Object.keys(emp.record))}`);
  const sub = of('submit-existing')[0];
  assert(sub && sub.event === 'app.record.edit.submit' && sub.expect === 'no-error' && sub.record.amount.value === '1000', `1-8: 既存の保存時の入力チェック（dealValidate.js）の確認: 入力ありで保存できることを期待: ${JSON.stringify(sub && [sub.event, sub.expect])}`);
  const ed = of('match')[0];
  assert(ed.record['ステータス'].value === '課長承認待ち' && ed.record['ステータス'].type === 'STATUS' && ed.record.items.value[0].id === '1' && ed.record.items.value[0].value.qty.type === 'NUMBER' && ed.record.owner.value[0].code === 'sim-user' && ed.record['レコード番号'].value === '1' && ed.recordId === '1', `1-9: 編集画面のレコードはシステムフィールドつき・型ごとの値（テーブルは 1 行・ユーザー選択は模擬の利用者）: ${JSON.stringify(ed.record['ステータス'])}`);
  assert(cs.every(x => !INTERNAL.test(x.label)) && cs.every(x => /→/.test(x.label)) && /「金額」ほか 4 項目を制御/.test(of('match')[0].label), `1-10: 代表条件の文に内部の番号を出さない・対象はラベルで: ${of('match')[0].label}`);
  // 数値の境界（p21 BF-C の実装仕様: amount >= "1000000" and amount != "1000000"）
  const b = KTJsSim.casesFor({ customization: R.CUSTOMIZATION, data: DATA, existingFiles: [existing('dealLock.js', R.DEAL_LOCK)] }).cases;
  const bm = b.filter(x => x.kind === 'match'), bb = b.filter(x => /^boundary/.test(x.kind));
  assert(bm.length >= 2 && bm.every(x => x.values.amount === '1000001' && x.expect === 'disabled') && bb.some(x => x.values.amount === '1000000' && x.expect === 'not-disabled') && bb.some(x => x.values.amount === '999999' && x.expect === 'not-disabled') && b.some(x => x.kind === 'status-existing' && x.values['ステータス'] === '承認済み' && x.values.amount === '1000001' && x.expect === 'disabled'), `1-11: 数値の条件（>= と != の組）: 合う値 1000001・境界 1000000 と 999999 は合わない・既存の承認済みのロックとの組み合わせ（既存の制御でも制御として合格）: ${JSON.stringify(b.map(x => [x.kind, x.values.amount, x.values['ステータス'], x.expect]))}`);
  const chg = b.find(x => /\.change\.amount$/.test(x.event));
  assert(chg && chg.changes && chg.changes.field.value === chg.record.amount.value, '1-12: 値の変更のイベントには changes（変えたフィールドの値）を付ける');
  const gw = KTJsSim.casesForGateway(cs);
  assert(gw.length === cs.length && gw.every(x => x.id && x.event && ['disabled', 'not-disabled', 'error', 'no-error', 'value'].includes(x.expect) && !('record' in x) && x.note.length <= 300) && gw[0].condition && gw[0].condition.field === 'ステータス', `1-13: Gateway に渡す形（契約 20 §4）: record は送らない・語彙どおり: ${JSON.stringify(gw[0])}`);
  const h1 = KTJsSim.candidateHashOf({ strategy: 'NEW_JS_FILE', targetFile: 'a.js', code: 'x', customizationId: 'C1' }), h2 = KTJsSim.candidateHashOf({ strategy: 'NEW_JS_FILE', targetFile: 'a.js', code: 'x\r\n', customizationId: 'C1' }), h3 = KTJsSim.candidateHashOf({ strategy: 'NEW_JS_FILE', targetFile: 'a.js', code: 'y', customizationId: 'C1' });
  assert(/^[0-9a-f]{16}$/.test(h1) && h1 !== h3 && h2 === KTJsSim.candidateHashOf({ strategy: 'NEW_JS_FILE', targetFile: 'a.js', code: 'x\n', customizationId: 'C1' }), `1-14: 候補の hash は 16 桁・改行は LF に揃える・コードが変われば変わる: ${h1} ${h3}`);
});

// =========================================================
console.log('\n--- §2 R12: 排他の最小ケース → 競合なし ---');
await section(async () => {
  const sim = await simNew(handler(EDIT, "    const st = record['ステータス'] ? record['ステータス'].value : '';\n    if (!st) {\n      record['amount'].error = 'ステータスが不明です';\n      return event;\n    }\n    if (st === '承認待ち') {\n      record['amount'].disabled = true;\n    }"));
  assert(sim.backend === 'vm' && sim.passed === true && !check(sim, 'sim-conflict') && check(sim, 'sim-control') && check(sim, 'sim-control').ok && !check(sim, 'sim-exception') && !check(sim, 'sim-unverified'), `R12: 代表条件を実行しても error と disabled は同時に起きない → 競合なし・合格: ${JSON.stringify(sim.checks.map(x => [x.name, x.ok, x.message.slice(0, 80)]))}`);
  const m = sim.cases.find(x => x.event === 'app.record.edit.show' && x.expect === 'disabled');
  assert(m && m.verdict === 'pass' && m.observed.disabled.some(x => x.field === 'amount' && x.file === 'lock.js') && !m.observed.errors.length, `R12: 承認待ちの編集画面では amount が編集不可（候補）・エラー表示なし: ${JSON.stringify(m)}`);
  const miss = sim.cases.find(x => x.expect === 'not-disabled');
  assert(miss && miss.verdict === 'pass' && !miss.observed.disabled.length, `R12: 条件に合わないステータス（作成中）では制御しない: ${JSON.stringify(miss)}`);
  assert(sim.cases.every(x => !INTERNAL.test(x.message)) && typeof sim.durationMs === 'number' && /^[0-9a-f]{16}$/.test(sim.candidateHash), '表示用の文に内部の番号を出さない・時間と候補の hash を持つ');
});

// =========================================================
console.log('\n--- §3 R13: 実際の競合は検出する（同じ経路・別ファイル） ---');
await section(async () => {
  const both = await simNew(handler(EDIT, "    record['amount'].disabled = true;\n    record['amount'].error = '確認してください';"));
  const cf = check(both, 'sim-conflict');
  assert(both.passed === false && cf && cf.severity === 'block' && /作った JavaScript が「金額」にエラーを表示し、同じイベントで 作った JavaScript が「金額」を編集不可に/.test(cf.message) && /kintone はエラーを表示したイベントで編集不可・値の変更を取り消します/.test(cf.message), `R13: 同じ経路で無条件に disabled と error → 競合（block。実機の規則を文に）: ${cf && cf.message}`);
  assert(both.conflicts.length >= 1 && both.conflicts[0].candidateInvolved === true && KTJsSim.failuresForFeedback(both).some(f => f.kind === 'simulation' && /取り消す/.test(f.message)), 'R13: 修復の依頼に構造化した失敗（simulation）として入る');
  // 別ファイル: otherLock.js が承認待ちで disabled、候補（warn.js）が同じイベントで無条件に error
  const OTHER = "(function () {\n  'use strict';\n  kintone.events.on(['app.record.edit.show'], function (event) {\n    const record = event.record;\n    if (record['ステータス'] && record['ステータス'].value === '承認待ち') {\n      record['amount'].disabled = true;\n    }\n    return event;\n  });\n})();\n";
  const other = await simNew(handler(EDIT, "    record['amount'].error = '金額を確認してください';"), cust({ requirement: '金額に注意を出す', fields: [{ code: 'amount', access: 'CONTROL', condition: 'ステータス in ("承認待ち")' }] }), { otherFiles: [existing('otherLock.js', OTHER)] });
  const cf2 = check(other, 'sim-conflict');
  assert(other.passed === false && cf2 && cf2.severity === 'block' && /作った JavaScript が「金額」にエラーを表示し、同じイベントで 既存の otherLock\.js が「金額」を編集不可に/.test(cf2.message) && other.conflicts[0].candidateInvolved === true, `R13: 別ファイルの disabled と候補の error → 競合（別ファイルの実行順の推定ではなく、実際に同じイベントで両方が立った）: ${cf2 && cf2.message}`);
  // 既存ファイル同士の競合（候補は関与しない）: 候補は submit だけ。既存 2 ファイルが edit.show で error と disabled
  const OTHER_ERR = "(function () {\n  'use strict';\n  kintone.events.on(['app.record.edit.show'], function (event) {\n    event.record['amount'].error = '既存の注意';\n    return event;\n  });\n})();\n";
  const c3 = cust({ events: ['app.record.edit.submit'], fields: [{ code: 'amount', access: 'CONTROL', condition: 'ステータス in ("承認待ち")' }] });
  const third = await KTJsSim.simulate({ customization: c3, generated: gen("(function () {\n  'use strict';\n  kintone.events.on(['app.record.edit.submit'], function (event) {\n    if (!event.record['amount'].value) { event.record['amount'].error = '必須'; }\n    return event;\n  });\n})();", { events: ['app.record.edit.submit'] }), review: null, existingSource: null, otherFiles: [existing('otherLock.js', OTHER), existing('otherWarn.js', OTHER_ERR)], data: DATA_NOW, backend });
  assert(!check(third, 'sim-conflict') && check(third, 'sim-conflict-existing') && check(third, 'sim-conflict-existing').severity === 'review' && /作った JavaScript は関わっていません/.test(check(third, 'sim-conflict-existing').message) && third.conflicts.length === 0 && third.existingConflicts.length >= 1 && third.existingConflicts.every(x => x.candidateInvolved === false) && third.passed === true && KTJsSim.failuresForFeedback(third).every(f => !/取り消す/.test(f.message)), `R13（反証 B1）: 既存ファイル同士の競合は確認（sim-conflict-existing）で知らせ、作った JavaScript の判定・修復の依頼には入れない: ${JSON.stringify({ c: third.conflicts.length, e: third.existingConflicts.length, passed: third.passed })}`);
});

// =========================================================
console.log('\n--- §4 R15: 編集制限コード（両承認待ち・通常編集・一覧編集・明細・保存禁止・既存制御） ---');
await section(async () => {
  const g0 = SA.generatedOf(KTScan.hashText(SA.DEAL_LOCK));
  const src = { name: 'dealLock.js', target: 'desktop', text: SA.DEAL_LOCK };
  const rv = KTCodeReview.review({ generated: g0, customization: SA.CUSTOMIZATION, plan: null, data: clone(DATA), scan: null, existingSource: src });
  const files = [existing('dealLock.js', SA.DEAL_LOCK), existing('dealValidate.js', SA.DEAL_VALIDATE)];
  const sim = await KTJsSim.simulate({ customization: SA.CUSTOMIZATION, generated: g0, review: rv, existingSource: src, otherFiles: files, data: clone(DATA), backend });
  assert(sim.passed === true && sim.counts.fail === 0 && sim.counts.unverified === 0 && !check(sim, 'sim-conflict') && !check(sim, 'sim-exception') && check(sim, 'sim-control').ok, `R15: 全件合格・競合も例外も無い: ${JSON.stringify(sim.cases.map(x => [x.verdict, x.label.slice(0, 50), x.message.slice(0, 60)]))}`);
  const lock = (st, ev) => sim.cases.find(x => x.event === ev && x.expect === 'disabled' && new RegExp(st).test(x.label));
  for (const st of ['課長承認待ち', '部長承認待ち']) for (const ev of ['app.record.edit.show', 'app.record.index.edit.show']) {
    const x = lock(st, ev);
    assert(x && x.verdict === 'pass' && ['amount', 'item_name', 'qty', 'unit_price'].every(code => x.observed.disabled.some(d => d.field === code && d.file === 'dealLock.js')), `R15 両承認待ち × 通常編集 / 一覧編集: ${st}・${ev} で金額と明細のセルが編集不可: ${x && JSON.stringify(x.observed.disabled.map(d => d.field))}`);
  }
  const ex = sim.cases.find(x => /承認済み/.test(x.label));
  assert(ex && ex.verdict === 'pass' && ex.observed.disabled.some(d => d.field === 'amount') && /既存の dealLock\.js が「金額」を編集不可にしました（作った JavaScript は変えていません）/.test(ex.message), `R15 既存制御: 承認済みの既存のロックは残り、候補の制御ではないと注記: ${ex && ex.message}`);
  const miss = sim.cases.find(x => /作成中/.test(x.label));
  assert(miss && miss.verdict === 'pass' && !miss.observed.disabled.length, 'R15: 作成中では編集できる');
  const save = sim.cases.find(x => x.event === 'app.record.edit.submit');
  assert(save && save.verdict === 'pass' && !save.observed.errors.length && /保存できます/.test(save.message), `R15 保存禁止: 入力ありの保存は止まらない（既存の入力チェックは候補と別のイベント）: ${save && save.message}`);
  const emp = sim.cases.find(x => x.screen === 'create');
  assert(emp && emp.verdict === 'pass' && !emp.observed.errors.length && !emp.observed.disabled.length, `R15: 作成画面（ステータス無し・空の値）でも例外なく動く（既存の dealLock.js は存在を確かめている）: ${emp && emp.message}`);
  // 候補の登録の見分け: 統合した dealLock.js のうち新しい handler（2 つ目）だけが候補
  const prep = KTJsSim.prepareFiles({ candidate: { name: 'dealLock.js', target: 'desktop', finalText: rv.finalCode, strategy: 'EXTEND_EXISTING_JS', patch: g0.patch, existingText: SA.DEAL_LOCK }, otherFiles: files });
  assert(JSON.stringify(prep.candidateRegs) === '[1]' && prep.files.map(f => f.name).join() === 'dealValidate.js,dealLock.js' && prep.files[1].candidate && !prep.unverified.length, `R15: 統合先の中で patch が入れた登録だけを候補と見る・既存 → 候補の順: ${JSON.stringify([prep.candidateRegs, prep.files.map(f => f.name)])}`);
});

// =========================================================
console.log('\n--- §5 未確認（ループ・通信・構文）と例外 ---');
await section(async () => {
  const loop = await simNew(handler(EDIT, "    while (true) { record['amount'].value = String(Number(record['amount'].value) + 1); }"));
  const u = check(loop, 'sim-unverified');
  assert(loop.passed === false && !check(loop, 'sim-exception') && u && u.severity === 'review' && /ループの回数が上限を超えた/.test(u.message) && loop.cases.every(x => x.verdict === 'unverified'), `無限ループ → 未確認（例外にしない・vm の時間切れの前に上限で止める）: ${u && u.message}`);
  const net = await simNew(handler(EDIT, "    kintone.api(kintone.api.url('/k/v1/record', true), 'GET', { app: 1, id: 1 }).then(function (r) { record['amount'].disabled = true; });"));
  const un = check(net, 'sim-unverified');
  assert(net.passed === false && un && /外部との通信を試みる/.test(un.message) && /kintone\.api/.test(un.message) && !check(net, 'sim-exception'), `通信の試み（kintone.api）→ 未確認（失敗を返し、例外にはしない）: ${un && un.message}`);
  const fetchy = await simNew(handler(EDIT, "    fetch('https://example.com/').catch(function () {});\n    if (record['ステータス'].value === '承認待ち') record['amount'].disabled = true;"));
  assert(check(fetchy, 'sim-unverified') && /fetch/.test(check(fetchy, 'sim-unverified').message), 'fetch も通信の試み → 未確認');
  const syn = await simNew("(function () { kintone.events.on(['app.record.edit.show'], function (event) { return event; ); })();");
  assert(syn.passed === false && check(syn, 'sim-unverified') && /構文を解析できない/.test(check(syn, 'sim-unverified').message) && syn.cases.every(x => x.verdict === 'unverified'), `構文エラー → 未確認（構文）: ${check(syn, 'sim-unverified').message}`);
  const exc = await simNew(handler(EDIT, "    if (record['nope'].value === 'x') record['amount'].disabled = true;"));
  const ex = check(exc, 'sim-exception');
  assert(exc.passed === false && ex && ex.severity === 'block' && /lock\.js 5 行目/.test(ex.message) && /編集画面を開く/.test(ex.message) && /Cannot read properties of undefined|undefined/.test(ex.message), `例外（存在しないフィールドの .value）→ sim-exception（block・ファイル名と行・画面）: ${ex && ex.message}`);
  assert(exc.exceptions[0].candidate === true && KTJsSim.failuresForFeedback(exc).some(f => /例外/.test(f.observed)), '例外は候補の失敗として修復の依頼に入る');
  // 既存 JS の本文が無い → 未確認（最終案にしない材料）
  const noSrc = await simNew(handler(EDIT, "    if (record['ステータス'].value === '承認待ち') record['amount'].disabled = true;"), cust(), { otherFiles: [{ name: 'remote.js', target: 'desktop', text: null, sourceAvailable: false, events: ['app.record.edit.show'] }] });
  assert(noSrc.passed === true && !check(noSrc, 'sim-unverified') && check(noSrc, 'sim-existing') && check(noSrc, 'sim-existing').severity === 'review' && /本文の無い既存の JavaScript（remote\.js）/.test(check(noSrc, 'sim-existing').message) && noSrc.counts.pass >= 1 && noSrc.existingUnverified.some(u => u.code === 'SOURCE_MISSING'), `本文の無い既存 JS（URL 指定のライブラリなど）→ 未確認（既存）の確認。作った JavaScript が使わない限り最終案は止めない（反証 A4）: ${JSON.stringify(check(noSrc, 'sim-existing'))}`);
  // 非同期の handler（Promise を返す。仮想の setTimeout で解決）は待つ
  const asyncH = await simNew("(function () {\n  'use strict';\n  kintone.events.on(['app.record.edit.show'], function (event) {\n    return new kintone.Promise(function (resolve) { setTimeout(function () { if (event.record['ステータス'].value === '承認待ち') event.record['amount'].disabled = true; resolve(event); }, 100); });\n  });\n})();");
  assert(asyncH.passed === true && asyncH.cases.find(x => x.expect === 'disabled').observed.disabled.length === 1, `Promise を返す handler は仮想の時計で解決を待ってから観測する: ${JSON.stringify(asyncH.cases.map(x => [x.verdict, x.message.slice(0, 40)]))}`);
  // backend が無い → 未確認（BACKEND）
  const none = await KTJsSim.simulate({ customization: cust(), generated: gen(handler(EDIT, '')), review: null, otherFiles: [], data: DATA_NOW, backend: null });
  assert(none.passed === false && none.backend === null && none.unverified.some(x => x.code === 'BACKEND') && check(none, 'sim-unverified'), '隔離環境が無ければ未確認（合格にしない）');
});

// =========================================================
console.log('\n--- §6 実機の再生: rc-e2e S2_V3 / S2_V2・BFC（getFieldElement）・p21 GENERATED ---');
await section(async () => {
  const data = clone(DATA_NOW);
  data.fields.customer_category = { type: 'DROP_DOWN', code: 'customer_category', label: '顧客区分', options: { '新規': { label: '新規', index: '0' }, '既存': { label: '既存', index: '1' } }, defaultValue: '' };
  data.fields.referral_source = { type: 'SINGLE_LINE_TEXT', code: 'referral_source', label: '紹介元', defaultValue: '' };
  const edited = R.DEAL_VALIDATE.replace(/\s*$/, '') + '\n// 別の担当者のメモ（RC E2E: 外部からの変更の確認）\n';
  const src3 = { name: 'dealValidate.js', target: 'desktop', text: edited };
  const g3 = KTModernJs.fixGenerated({ generated: E2E.S2_V3.generated, existingSource: src3 });
  const rv3 = KTCodeReview.review({ generated: g3.generated, customization: E2E.S2_V3.customization, plan: null, data: clone(data), scan: null, existingSource: src3 });
  const sim3 = await KTJsSim.simulate({ customization: E2E.S2_V3.customization, generated: g3.generated, review: rv3, existingSource: src3, otherFiles: [existing('dealValidate.js', edited), existing('dealLock.js', R.DEAL_LOCK)], data, backend });
  const emp3 = sim3.cases.find(x => x.kind === 'empty');
  assert(emp3 && emp3.event === 'app.record.create.submit' && emp3.expect === 'error' && emp3.verdict === 'fail' && /保存できてしまいます/.test(emp3.message) && check(sim3, 'sim-control') && check(sim3, 'sim-control').severity === 'block', `S2_V3（実機 N2）: 作成画面の空の値（undefined）を見逃して保存できる → 不合格（block）: ${emp3 && emp3.message}`);
  const ok3 = sim3.cases.find(x => x.kind === 'submit-match' && x.event === 'app.record.edit.submit');
  assert(ok3 && ok3.verdict === 'pass' && /保存できます/.test(ok3.message), `S2_V3: 新規・紹介元ありの編集画面の保存は止まらない: ${ok3 && ok3.message}`);
  const fb3 = KTJsSim.failuresForFeedback(sim3);
  assert(fb3.length === 1 && fb3[0].kind === 'simulation' && fb3[0].event === 'app.record.create.submit' && fb3[0].caseId === emp3.id && /エラー表示（保存を止める）/.test(fb3[0].expected), `S2_V3: 修復の依頼は失敗したケースだけ（event・caseId・期待・観測）: ${JSON.stringify(fb3)}`);
  const src2 = { name: 'dealValidate.js', target: 'desktop', text: R.DEAL_VALIDATE };
  const g2 = KTModernJs.fixGenerated({ generated: E2E.S2_V2.generated, existingSource: src2 });
  const rv2 = KTCodeReview.review({ generated: g2.generated, customization: E2E.S2_V2.customization, plan: null, data: clone(data), scan: null, existingSource: src2 });
  const sim2 = await KTJsSim.simulate({ customization: E2E.S2_V2.customization, generated: g2.generated, review: rv2, existingSource: src2, otherFiles: [existing('dealValidate.js', R.DEAL_VALIDATE)], data, backend });
  assert(sim2.passed === true && sim2.cases.find(x => x.kind === 'empty').verdict === 'pass', `S2_V2（undefined も判定）: 作成画面の空の値でエラー表示 → 合格: ${JSON.stringify(sim2.cases.map(x => [x.kind, x.verdict]))}`);
  // BFC（実機 N3）: getFieldElement が作成・編集画面で null → 注意表示が出ない
  const srcB = { name: 'dealLock.js', target: 'desktop', text: R.DEAL_LOCK };
  const gB = KTModernJs.fixGenerated({ generated: E2E.BFC.generated, existingSource: srcB });
  const rvB = KTCodeReview.review({ generated: gB.generated, customization: E2E.BFC.customization, plan: null, data: clone(DATA_NOW), scan: null, existingSource: srcB });
  const simB = await KTJsSim.simulate({ customization: E2E.BFC.customization, generated: gB.generated, review: rvB, existingSource: srcB, otherFiles: [existing('dealLock.js', R.DEAL_LOCK)], data: clone(DATA_NOW), backend });
  assert(simB.passed === false && check(simB, 'sim-control') && check(simB, 'sim-control').severity === 'block' && simB.cases.filter(x => x.expect === 'disabled' && x.kind !== 'status-existing').every(x => x.verdict === 'fail') && simB.cases.find(x => x.kind === 'status-existing').verdict === 'pass' && !check(simB, 'sim-exception'), `BFC（実機 N3）: getFieldElement は null → 100 万円超でも警告が出ない → 不合格（例外にはならない）: ${JSON.stringify(simB.cases.map(x => [x.expect, x.verdict]))}`);
  // p21 GENERATED: !amount.disabled で分けた警告 → 承認済み（既存のロック）では警告を出さず競合しない。分けないと競合
  const rvG = KTCodeReview.review({ generated: R.GENERATED, customization: R.CUSTOMIZATION, plan: null, data: clone(DATA_NOW), scan: null, existingSource: srcB });
  const simG = await KTJsSim.simulate({ customization: R.CUSTOMIZATION, generated: R.GENERATED, review: rvG, existingSource: srcB, otherFiles: [existing('dealLock.js', R.DEAL_LOCK)], data: clone(DATA_NOW), backend });
  const approved = simG.cases.find(x => x.kind === 'status-existing');
  assert(simG.passed === true && !check(simG, 'sim-conflict') && approved && approved.verdict === 'pass' && approved.observed.disabled.some(d => d.field === 'amount') && !approved.observed.errors.length, `p21 GENERATED: 承認済みでは既存のロックが効き、候補は警告を出さない（競合なし）。作成中・100 万円超では警告: ${JSON.stringify(simG.cases.map(x => [x.kind, x.verdict, x.message.slice(0, 40)]))}`);
  const warn = simG.cases.find(x => x.kind === 'match' && x.event === 'app.record.edit.show');
  assert(warn && warn.verdict === 'pass' && warn.observed.errors.some(e => e.field === 'amount') && warn.warnOnly === true && /警告の表示だけで、編集不可にはなりません/.test(warn.message) && check(simG, 'sim-warning-only') && check(simG, 'sim-warning-only').severity === 'review', `p21 GENERATED: 100 万円超（作成中）の編集画面で警告（error）→ 合格だが「警告だけ（編集は止まりません）」の確認を付ける（反証 A5: 警告だけを編集不可と言わない）: ${warn && warn.message}`);
  const unguarded = { ...R.GENERATED, code: R.GENERATED.code.replace(' && !amount.disabled', ''), patch: { ...R.GENERATED.patch, operations: R.GENERATED.patch.operations.map(o => ({ ...o, content: o.content.replace(' && !amount.disabled', '') })) } };
  const rvU = KTCodeReview.review({ generated: unguarded, customization: R.CUSTOMIZATION, plan: null, data: clone(DATA_NOW), scan: null, existingSource: srcB });
  const simU = await KTJsSim.simulate({ customization: R.CUSTOMIZATION, generated: unguarded, review: rvU, existingSource: srcB, otherFiles: [existing('dealLock.js', R.DEAL_LOCK)], data: clone(DATA_NOW), backend });
  const cfU = check(simU, 'sim-conflict');
  assert(simU.passed === false && cfU && cfU.severity === 'block' && /承認済み/.test(cfU.message) && /作った JavaScript が「金額」にエラーを表示し、同じイベントで 既存の dealLock\.js が「金額」を編集不可に/.test(cfU.message), `p21 GENERATED（分けない）: 承認済みの編集画面で既存のロックと候補の警告が同時に立つ → 競合（block）: ${cfU && cfU.message}`);
});

// =========================================================
console.log('\n--- §7 判定の形（review.sim）と KTCodeReview への取り込み ---');
await section(async () => {
  const code = handler(EDIT, "    if (record['ステータス'].value === '承認待ち') record['amount'].disabled = true;");
  const rv = KTCodeReview.review({ generated: gen(code), customization: cust(), plan: null, data: clone(DATA_NOW), scan: null, existingSource: null });
  const sim = await simNew(code);
  assert(sim.version === '1' && Array.isArray(sim.cases) && sim.cases.every(x => 'id' in x && 'event' in x && 'label' in x && 'expect' in x && ['pass', 'fail', 'unverified'].includes(x.verdict) && x.observed && Array.isArray(x.observed.errors) && Array.isArray(x.observed.disabled) && Array.isArray(x.observed.values) && typeof x.message === 'string') && Array.isArray(sim.unverified) && typeof sim.durationMs === 'number', `7-1: review.sim の形（candidateHash・backend・cases[]・unverified・durationMs）: ${JSON.stringify(Object.keys(sim))}`);
  const merged = KTCodeReview.attachSim(rv, sim);
  const reg = merged.registration;
  assert(merged.sim === sim && merged.checks.some(x => x.name === 'sim-control' && x.ok) && merged.checks.some(x => x.name === 'sim') && !reg.unverified.some(u => u.code === 'RUNTIME_NOT_RUN') && reg.unverified.some(u => u.code === 'SIM_VERIFIED' && /模擬イベント/.test(u.message) && /実機/.test(u.message)) && reg.verdict === 'RUNTIME_UNVERIFIED', `7-2: attachSim: 検査に sim-* を足し、登録の unverified の RUNTIME_NOT_RUN を「模擬イベントで確認（実機は未確認）」に置き換える: ${JSON.stringify(reg.unverified)}`);
  const bad = await simNew(handler(EDIT, "    record['amount'].disabled = true;\n    record['amount'].error = 'x';"));
  const mergedBad = KTCodeReview.attachSim(KTCodeReview.review({ generated: gen(handler(EDIT, "    record['amount'].disabled = true;\n    record['amount'].error = 'x';")), customization: cust(), plan: null, data: clone(DATA_NOW), scan: null, existingSource: null }), bad);
  assert(mergedBad.status === 'BLOCKED' && mergedBad.registration.verdict === 'BLOCKED' && mergedBad.registration.blockers.some(b => b.code === 'sim-conflict'), `7-3: 競合は登録不可（blockers に sim-conflict）: ${JSON.stringify(mergedBad.registration.blockers.map(b => b.code))}`);
  const unv = await simNew(handler(EDIT, "    kintone.api('/k/v1/record', 'GET', {});"));
  const mergedUnv = KTCodeReview.attachSim(KTCodeReview.review({ generated: gen(handler(EDIT, "    kintone.api('/k/v1/record', 'GET', {});")), customization: cust(), plan: null, data: clone(DATA_NOW), scan: null, existingSource: null }), unv);
  assert(mergedUnv.registration.unverified.some(u => u.code === 'SIM_UNVERIFIED') && mergedUnv.checks.some(x => x.name === 'sim-unverified' && x.severity === 'review'), `7-4: 未確認は unverified（SIM_UNVERIFIED）と sim-unverified（確認）に残る: ${JSON.stringify(mergedUnv.registration.unverified.map(u => u.code))}`);
  const list = KTJsSim.checklistOf(KTJsSim.casesFor({ customization: cust(), data: DATA_NOW }).cases, sim);
  assert(list.length === sim.cases.length && list.every(x => ['pass', 'fail', 'unverified', 'todo'].includes(x.state) && !INTERNAL.test(x.label)), `7-5: 進みのカード用のチェックリスト（結果が出たものから埋まる）: ${JSON.stringify(list.slice(0, 2))}`);
  assert(typeof KTJsSim.runtimeSource() === 'string' && /__ktSim/.test(KTJsSim.runtimeSource()) && /allow-scripts/.test(KTJsSim.iframeBackend.toString()) && /Content-Security-Policy/.test(KTJsSim.iframeBackend.toString()) && /ev\.source !== iframe\.contentWindow/.test(KTJsSim.iframeBackend.toString()), '7-6: runtime は文字列で取り出せる。ブラウザの backend は sandbox="allow-scripts" の iframe・CSP の meta・event.source の確認を持つ（実機の CSP は未確認）');
});

// =========================================================
console.log('\n--- §8 段階 C-1 の反証レビューの回帰（隔離環境・誤判定・代表条件・従来の流れ） ---');
//   正しさ A1〜A7・B1〜B3・D（偽の結果）、指示との一致 A4〜A6 の probe / scen を固定する
const vm = require('vm');
const SUB = ['app.record.edit.submit', 'app.record.create.submit'];
const LOCK = "    if (record['ステータス'] && record['ステータス'].value === '承認待ち') record['amount'].disabled = true;";
const handlerNoRet = (events, body) => `(function () {\n  'use strict';\n  kintone.events.on(${JSON.stringify(events).replace(/"/g, "'")}, function (event) {\n    const record = event.record;\n${body}\n  });\n})();`;
/** 本物の iframeBackend が作る srcdoc と、親の message の受け口を取り出す（偽の document / window。生成した JS は実行しない） */
function captureIframe({ nonce = 'nonce-test-1', timeoutMs = 50 } = {}) {
  const cap = { srcdoc: null, listener: null, removed: false };
  const contentWindow = {};
  const iframe = { setAttribute(k, v) { cap[k] = v; }, style: {}, remove() { cap.removed = true; }, contentWindow, set srcdoc(v) { cap.srcdoc = v; } };
  const doc = { createElement: () => iframe, body: { appendChild() { } } };
  const win = { addEventListener(type, fn) { if (type === 'message') cap.listener = fn; }, removeEventListener() { cap.listener = null; }, postMessage() { } };
  const be = KTJsSim.iframeBackend({ document: doc, window: win, timeoutMs, nonce: () => nonce });
  return { be, cap, contentWindow };
}
// ---- A1: ブラウザの隔離環境で location などを全体に代入しない（各ファイルを関数で包んで引数で差し替える）----
await section(async () => {
  // runtime を、location・localStorage・sessionStorage・navigator の代入を記録する全体（iframe の window の代わり）で動かす
  const sets = [];
  const sandbox = {};
  for (const k of KTJsSim.WRAP_PARAMS) Object.defineProperty(sandbox, k, { get() { if (k === 'localStorage' || k === 'sessionStorage') throw new Error('SecurityError: sandbox'); return { real: k }; }, set(v) { sets.push(k); }, configurable: false, enumerable: true });
  const ctx = vm.createContext(sandbox);
  new vm.Script(KTJsSim.runtimeSource()).runInContext(ctx, { timeout: 2000 });
  assert(sets.length === 0 && typeof ctx.__ktSim === 'object' && Object.isFrozen(ctx.__ktSim) && ctx.__ktSim.scope && ctx.__ktSim.scope.location.href === 'about:srcdoc', `A1-1: runtime は location・localStorage・sessionStorage・navigator に代入しない（iframe で location に代入すると別の URL へ移動して結果が届かない）。模擬は __ktSim.scope で渡す: 代入 ${JSON.stringify(sets)}`);
  // 本物の backend が作る srcdoc: 各ファイルを関数で包み、引数で模擬を渡す。location への代入の文が無い
  const { be, cap } = captureIframe();
  const existingTxt = "function isPending(r) { return !!(r['ステータス'] && r['ステータス'].value === '承認待ち'); }\nvar seen = localStorage.getItem('k') || location.pathname;\n";
  const candTxt = "(function(){ 'use strict'; kintone.events.on(['app.record.edit.show'], function(event){ localStorage.setItem('k', 'v'); var h = location.href; if (isPending(event.record)) event.record['amount'].disabled = true; return event; }); })();";
  const sTimeout = await KTJsSim.simulate({ customization: cust(), generated: gen(candTxt), review: { finalCode: candTxt }, otherFiles: [existing('helper.js', existingTxt)], data: DATA_NOW, backend: be });
  const html = cap.srcdoc || '';
  const wraps = (html.match(/\(function \(location, localStorage, sessionStorage, navigator\) \{/g) || []).length;
  assert(wraps === 2 && /\}\)\.call\(this, __ktSim\.scope\.location, __ktSim\.scope\.localStorage, __ktSim\.scope\.sessionStorage, __ktSim\.scope\.navigator\);/.test(html) && !/(^|[^.\w])(G|window|self|globalThis)\.location\s*=[^=]/.test(html) && !/asg\(\s*'(location|localStorage|sessionStorage|navigator)'/.test(html) && cap.sandbox === 'allow-scripts', `A1-2: srcdoc の各ファイルは関数で包み、location などを引数で差し替える（全体への代入の文が無い）: 包んだ数 ${wraps}`);
  assert(/"nonce\\":\\"nonce-test-1\\"|nonce\\\\":\\\\"nonce-test-1/.test(html) && /__ktSim\.finish\(\)/.test(html) && !/parent\.postMessage\(__ktSim\.resultJson\(\)/.test(html), 'A1-3: 結果は一回限りの印（nonce）つきで送る（install に印・最後は __ktSim.finish）');
  // 時間内に読み込みの合図も無ければ「実行できなかった」（BLOCKED）。作った JavaScript の問題とは言わない
  assert(sTimeout.passed === false && sTimeout.unverified.some(u => u.code === 'BLOCKED') && !sTimeout.unverified.some(u => u.code === 'TIMEOUT') && KTJsSim.failuresForFeedback(sTimeout).length === 0, `A1-4: 合図の無い時間切れは「隔離環境でスクリプトを実行できませんでした」（修復は頼まない）: ${JSON.stringify(sTimeout.unverified.map(u => u.code))}`);
  // vm でも同じ包み方で動く: 既存の一番外の function を別ファイル（作った JavaScript）から使える・localStorage と location は模擬
  const shared = await KTJsSim.simulate({ customization: cust(), generated: gen(candTxt), review: { finalCode: candTxt }, otherFiles: [existing('helper.js', existingTxt)], data: DATA_NOW, backend });
  assert(shared.passed === true && !shared.exceptions.length && shared.cases.find(x => x.expect === 'disabled').verdict === 'pass', `A1-5: 包んでも一番外の宣言は別ファイルから使える（全体の値として置く）。localStorage・location は模擬: ${JSON.stringify(shared.cases.map(x => [x.verdict, x.message.slice(0, 40)]))}`);
});
// ---- D: 生成した JavaScript が先に送った偽の結果（印の無い・違う通知）は受け取らない ----
await section(async () => {
  const { be, cap, contentWindow } = captureIframe({ nonce: 'nonce-real', timeoutMs: 2000 });
  const p = be.run({ runtimeSource: 'void 0;', files: [], inputJson: JSON.stringify({ appId: '1', cases: [] }) });
  const send = (data) => cap.listener && cap.listener({ source: contentWindow, data: JSON.stringify(data) });
  send({ version: '1', finished: true, cases: [{ id: 'S1' }] });                        // 旧い形（印なし）
  send({ kt: 'forged', result: { version: '1', finished: true, cases: [{ id: 'S1' }] } });   // 違う印
  cap.listener && cap.listener({ source: {}, data: JSON.stringify({ kt: 'nonce-real', result: { version: '1', finished: true, cases: [{ id: 'S9' }] } }) });   // 別の窓から
  send({ kt: 'nonce-real', ready: true });
  send({ kt: 'nonce-real', result: { version: '1', finished: true, cases: [{ id: 'S2' }], loadErrors: [], network: [] } });
  const r = await p;
  assert(r && r.cases && r.cases[0].id === 'S2' && cap.removed === true, `D-1: 一回限りの印が合う通知だけを結果にする（偽の結果・別の窓の通知は捨てる）: ${JSON.stringify(r && r.cases)}`);
  const rt = KTJsSim.runtimeSource();
  assert(/Object\.freeze\(api\)/.test(rt) && /if \(!P \|\| !nonce \|\| posted \|\| !S\.finished\) return;/.test(rt) && /currentScript/.test(rt) && !/state: S/.test(rt), 'D-2: runtime の窓口は凍結・結果は全部のケースの後に 1 回だけ・印を含む script は文書から外す・内部の状態は出さない');
});
// ---- A2: 標準的な通信の書き方（Promise を返す）は未確認。例外・制御の欠落・修復の依頼にしない ----
await section(async () => {
  const api = await simNew(handlerNoRet(EDIT, `    return kintone.api(kintone.api.url('/k/v1/records', true), 'GET', { app: 1 }).then(function () {\n${LOCK}\n      return event;\n    });`));
  assert(api.passed === false && !check(api, 'sim-exception') && !bad(api, 'sim-control') && check(api, 'sim-unverified') && /外部との通信/.test(check(api, 'sim-unverified').message) && api.exceptions.length === 0 && KTJsSim.failuresForFeedback(api).length === 0 && api.cases.filter(x => x.handlers).every(x => x.verdict === 'unverified'), `A2-1: kintone.api の Promise を返す handler → 未確認（通信を止めた失敗は例外に数えない・修復の依頼 0 件）: ${JSON.stringify(api.checks.filter(x => !x.ok).map(x => x.name))}`);
  const micro = await simNew("(function(){ kintone.events.on(['app.record.edit.show'], function(event){ function f(){ return Promise.resolve().then(f); } return f(); }); })();");
  const swallow = await simNew("(function(){ kintone.events.on(['app.record.edit.show'], function(event){ for(;;){ try { (function(){})(); } catch(e) {} } }); })();");
  assert([micro, swallow].every(s => !bad(s, 'sim-control') && check(s, 'sim-unverified') && KTJsSim.failuresForFeedback(s).length === 0), 'A2-2: 終わらない非同期・上限を握りつぶすループも未確認だけ（制御の欠落の文を出さない）');
});
// ---- A3: 保存時の入力チェック（error）と既存 JS の保存時の値の設定は競合にしない ----
await section(async () => {
  const cReq = cust({ requirement: '金額が空なら保存できない', events: SUB, fields: [{ code: 'amount', access: 'CONTROL', condition: '' }] });
  const candReq = handler(SUB, "    if (record['amount'].value === '' || record['amount'].value === undefined) record['amount'].error = '必須です';");
  const calc = existing('calc.js', handler(SUB, "    if (record['memo']) record['memo'].value = '保存時に設定';"));
  const s = await KTJsSim.simulate({ customization: cReq, generated: gen(candReq, { events: SUB }), review: { finalCode: candReq }, otherFiles: [calc], data: DATA_NOW, backend });
  assert(s.passed === true && !check(s, 'sim-conflict') && s.conflicts.length === 0 && KTJsSim.failuresForFeedback(s).length === 0, `A3: submit の error と既存の value は競合ではない（保存が止まるだけ。競合の判定は表示・変更のイベント）: ${JSON.stringify(s.checks.filter(x => !x.ok).map(x => x.name))}`);
});
// ---- A4: 読み込み時のループの回数はファイルごと。作った JavaScript の読み込みで上限に達したら未確認（修復しない）----
await section(async () => {
  const big = (n) => `(function(){ var t = []; for (var i = 0; i < ${n}; i++) { t.push(i); } })();`;
  const one = await simNew(handler(EDIT, LOCK), cust(), { otherFiles: [existing('table.js', big(12000))] });
  const two = await simNew(handler(EDIT, LOCK), cust(), { otherFiles: [existing('t1.js', big(6000)), existing('t2.js', big(6000))] });
  assert(two.passed === true && !bad(two, 'sim-control') && one.passed === true && !bad(one, 'sim-control') && check(one, 'sim-existing') && /既存の table\.js: 読み込み時にループの回数が上限を超えました/.test(check(one, 'sim-existing').message), `A4-1: 既存 JS の読み込み時の重い処理は持ち越さない（6,000 回 × 2 本は合格）。既存の 1 本が上限なら未確認（既存）で、作った JavaScript は判定する: ${JSON.stringify([one.passed, two.passed])}`);
  const candLoop = await simNew(`${big(20000)}\n${handler(EDIT, LOCK)}`);
  assert(candLoop.passed === false && candLoop.unverified.some(u => u.code === 'LOOP') && !bad(candLoop, 'sim-control') && KTJsSim.failuresForFeedback(candLoop).length === 0, `A4-2: 作った JavaScript の読み込み時に上限 → 未確認（修復は頼まない）: ${JSON.stringify(candLoop.checks.filter(x => !x.ok).map(x => x.name))}`);
});
// ---- A5: 条件に使うフィールド自身の「空」のケースは空（作成画面は undefined）。期待も空の値で計算する ----
await section(async () => {
  const cs = KTJsSim.casesFor({ customization: R.CUSTOMIZATION, data: clone(DATA_NOW) }).cases;
  const emp = cs.find(x => x.kind === 'empty');
  assert(emp && emp.screen === 'create' && emp.record.amount.value === KTJsSim.UNDEF && !('amount' in emp.values) && emp.expect === 'not-disabled', `A5: 「金額」が条件（金額 > 100 万）にも使われるとき、空のケースは金額を空にして（作成画面は undefined）、期待は「制御しない」: ${JSON.stringify(emp && { v: emp.values, rec: emp.record.amount, expect: emp.expect })}`);
  assert(KTJsSim.termHolds({ field: 'amount', op: '>=', value: { kind: 'str', v: '1000000' } }, '') === false, '前提: 空の値は大小の比較に当てはまらない');
});
// ---- A6: Gateway に渡す代表条件は 1 つのフィールドの条件（複数のフィールドの値を 1 つの values に混ぜない）----
await section(async () => {
  const files = [existing('dealLock.js', R.DEAL_LOCK)];
  const cs = KTJsSim.casesFor({ customization: R.CUSTOMIZATION, data: clone(DATA_NOW), existingFiles: files }).cases;
  const gw = KTJsSim.casesForGateway(cs);
  const ex = gw.find((x, i) => cs[i].kind === 'status-existing'), em = gw.find((x, i) => cs[i].kind === 'empty');
  assert(ex && ex.condition.field === 'amount' && ex.condition.op === 'in' && ex.condition.values.length === 1 && ex.condition.values[0] === '1000001' && /ほかの条件: ステータス in \("承認済み"\)/.test(ex.note), `A6-1: 複数のフィールドのケースは代表の 1 フィールドだけを condition に、残りは note に: ${JSON.stringify(ex)}`);
  assert(em && em.condition.field === 'amount' && em.condition.op === 'is' && Array.isArray(em.condition.values) && em.condition.values.length === 0, `A6-2: 空のケースは is と空の配列: ${JSON.stringify(em && em.condition)}`);
  assert(gw.every(x => x.condition === null || (typeof x.condition.field === 'string' && typeof x.condition.op === 'string' && Array.isArray(x.condition.values))), '契約 20 §4 の形（{ field, op, values } | null）は変えない');
});
// ---- B1 / 指示 A4: 既存の JavaScript だけの問題（競合・例外・読み込みエラー・本文の無い URL 指定）は未確認（既存）で、作った JavaScript を止めない ----
await section(async () => {
  const good = handler(EDIT, LOCK);
  const jq = await simNew(good, cust(), { otherFiles: [existing('ui.js', "(function(){ kintone.events.on('app.record.edit.show', function(e){ $('.x').hide(); return e; }); })();")] });
  const jqLoad = await simNew(good, cust(), { otherFiles: [existing('ui3.js', "$(function(){ console.log('ready'); });")] });
  const url = await simNew(good, cust(), { otherFiles: [{ name: 'https://cdn.example.com/jquery.min.js', target: 'desktop', text: null, sourceAvailable: false }] });
  assert([jq, jqLoad, url].every(s => s.passed === true && !check(s, 'sim-exception') && !check(s, 'sim-unverified') && check(s, 'sim-existing') && check(s, 'sim-existing').severity === 'review' && KTJsSim.failuresForFeedback(s).length === 0), `B1-1: 既存 JS の handler の例外・読み込みエラー・本文の無い URL 指定は未確認（既存）（確認）。作った JavaScript は合格のまま: ${JSON.stringify([jq, jqLoad, url].map(s => [s.passed, (check(s, 'sim-existing') || {}).message]))}`);
  // 作った JavaScript が本文の無いライブラリを使う（定義されていない名前）→ 作った JavaScript の未確認（例外・修復にしない）
  const usesLib = await simNew(handler(EDIT, `    $('.x').hide();\n${LOCK}`), cust(), { otherFiles: [{ name: 'https://cdn.example.com/jquery.min.js', target: 'desktop', text: null, sourceAvailable: false }] });
  assert(usesLib.passed === false && !check(usesLib, 'sim-exception') && check(usesLib, 'sim-unverified') && /本文の無い既存の JavaScript（ライブラリ）を使っています/.test(check(usesLib, 'sim-unverified').message) && KTJsSim.failuresForFeedback(usesLib).length === 0, `B1-2: 作った JavaScript がライブラリを使う → 未確認（作った JavaScript の誤りと断定しない）: ${JSON.stringify(usesLib.checks.filter(x => !x.ok).map(x => [x.name, x.message.slice(0, 60)]))}`);
  // 既存 JS が作った JavaScript の編集不可を取り消す（既存の無条件の error）は、作った JavaScript が関わる競合（kintone の規則）
  const cancelled = await simNew(good, cust(), { otherFiles: [existing('warnB.js', handler(EDIT, "    record['memo'].error = '注意';"))] });
  assert(cancelled.passed === false && check(cancelled, 'sim-conflict') && cancelled.conflicts[0].candidateInvolved === true, '前提: 既存の error で作った JavaScript の編集不可が取り消される組み合わせは競合（block）');
});
// ---- B2: 後の handler が error を null に戻したら競合ではない（最後に返した event の状態で判定）/ B3: event を返さない handler の変更は反映しない ----
await section(async () => {
  const cleared = await simNew(handler(EDIT, `    record['amount'].error = null;\n${LOCK}`), cust(), { otherFiles: [existing('warn.js', handler(EDIT, "    record['amount'].error = '既存の注意';"))] });
  assert(cleared.passed === true && !check(cleared, 'sim-conflict') && cleared.conflicts.length === 0, `B2: 前の handler の error を後の handler が null に戻す → 最後の event に error が無いので競合ではない: ${JSON.stringify(cleared.checks.filter(x => !x.ok).map(x => x.name))}`);
  const noRet = await simNew(handlerNoRet(EDIT, LOCK));
  const lock = noRet.cases.find(x => x.expect === 'disabled');
  assert(noRet.passed === false && lock.verdict === 'fail' && lock.observed.disabled.length === 0 && check(noRet, 'sim-control') && check(noRet, 'sim-control').severity === 'block', `B3: return event の無い handler の disabled は反映しない（返された event の変更だけを見る）→ 制御の欠落: ${lock && lock.message}`);
});
// ---- 指示 A5 / A6: 警告だけは「編集不可」と言わない（確認に回す）。競合したケースは不合格「エラー表示で取り消されます」----
await section(async () => {
  const warnOnly = await simNew(handler(EDIT, "    if (record['ステータス'] && record['ステータス'].value === '承認待ち') record['amount'].error = '承認待ちのため金額は変更できません';"));
  const m = warnOnly.cases.find(x => x.kind === 'match');
  assert(m && m.warnOnly === true && /警告の表示だけで、編集不可にはなりません/.test(m.message) && check(warnOnly, 'sim-warning-only') && check(warnOnly, 'sim-warning-only').severity === 'review' && /要件が「編集できなくする」なら満たしていません/.test(check(warnOnly, 'sim-warning-only').message), `指示 A5: 警告（error）だけの候補 → 「警告だけ（編集は止まりません）」と印を付け確認に回す（編集不可で合格とは言わない）: ${m && m.message}`);
  const bad = await simNew(handler(EDIT, "    record['amount'].disabled = true;\n    record['amount'].error = '確認してください';"));
  const fails = bad.cases.filter(x => x.conflict);
  assert(fails.length >= 1 && fails.every(x => x.verdict === 'fail' && /エラー表示で取り消されます/.test(x.message)) && bad.counts.fail >= fails.length && KTJsSim.failuresForFeedback(bad).filter(f => /取り消す/.test(f.message)).length === bad.conflicts.length, `指示 A6: 競合したケースは不合格（「エラー表示で取り消されます」）。修復の依頼は競合 1 件につき 1 つ: ${JSON.stringify(bad.cases.map(x => [x.verdict, x.message.slice(0, 50)]))}`);
  assert(bad.checks.every(x => !/候補|amount/.test(x.message)) && bad.cases.every(x => !/候補|「amount」/.test(x.message)), '指示 B7: 模擬の文は「作った JavaScript」とフィールドのラベル（フィールドコードを出さない）');
});
// ---- A7: 模擬の結果が無い review（従来の流れ・登録前の再検査で模擬が動かない）では、同じ handler の無条件の error と disabled は登録不可のまま ----
await section(async () => {
  const code = handler(EDIT, `${LOCK}\n    record['amount'].error = '金額を確認してください';`);
  const rv = KTCodeReview.review({ generated: gen(code), customization: cust(), plan: null, data: clone(DATA_NOW), scan: null, existingSource: null });
  const ce = rv.checks.find(x => x.name === 'error-cancels-edit');
  assert(rv.status === 'BLOCKED' && ce && ce.severity === 'block' && ce.simDecides === true && rv.registration.verdict === 'BLOCKED', `A7-1: 模擬の結果が無いときは従来どおり登録不可（同じ handler で条件の外の error と disabled）: ${ce && ce.message}`);
  const sim = await simNew(code);
  const merged = KTCodeReview.attachSim(rv, sim);
  assert(merged.checks.find(x => x.name === 'error-cancels-edit').severity === 'review' && merged.checks.some(x => x.name === 'sim-conflict' && x.severity === 'block'), 'A7-2: 模擬イベントが動いたら確認に下げ、実際の競合は sim-conflict（block）で判定する');
  const excl = handler(EDIT, "    if (record['ステータス'].value === '承認待ち') { record['amount'].disabled = true; } else { record['amount'].error = '確認'; }");
  const rvE = KTCodeReview.review({ generated: gen(excl), customization: cust(), plan: null, data: clone(DATA_NOW), scan: null, existingSource: null });
  // 確認 1: 静的な排他の解析はしない（改訂 2）。模擬の結果が無い間は登録不可、模擬が動けば模擬の結果（競合なし）で判定する
  assert(rvE.checks.find(x => x.name === 'error-cancels-edit').severity === 'block' && rvE.registration.verdict === 'BLOCKED', 'A7-3: 条件で分けた error（else の枝）も、模擬の結果が無い間は登録不可（静的な排他の解析では下げない）');
  const mergedE = KTCodeReview.attachSim(rvE, await simNew(excl));
  assert(mergedE.checks.find(x => x.name === 'error-cancels-edit').severity === 'review' && !mergedE.checks.some(x => x.name === 'sim-conflict') && mergedE.registration.verdict !== 'BLOCKED', `A7-3b: 模擬イベントが動いたら模擬の結果で判定（else の枝は同時に起きない → 競合なし・登録不可にしない）: ${mergedE.registration.verdict}`);
});

// =========================================================
console.log('\n--- 段階 C-1 修正後の確認（確認 1・3・4・7）---');
const GOOD_LOCK_C1F = handler(EDIT, "    if (record['ステータス'] && record['ステータス'].value === '承認待ち') record['amount'].disabled = true;");
// ---- 確認 1: 従来の流れの退行。模擬の結果が無い review は HEAD と同じ登録不可、模擬が動いたら模擬の結果で判定 ----
await section(async () => {
  const ST = "(record['ステータス'] ? record['ステータス'].value : '')";
  const LK = `    if (${ST} === '承認待ち') record['amount'].disabled = true;`;
  const CASES = {
    '同じ handler で条件に関係なく error と disabled': handler(EDIT, `${LK}\n    record['amount'].error = '注意';`),
    '同じ条件の中で error と disabled': handler(EDIT, `    if (${ST} === '承認待ち') { record['amount'].disabled = true; record['amount'].error = '承認待ち'; }`),
    '同じファイルの別の handler で条件に関係なく error': `(function(){ 'use strict'; kintone.events.on(['app.record.edit.show'], function(event){ const record = event.record; ${LK.trim()} return event; }); kintone.events.on(['app.record.edit.show'], function(event){ event.record['amount'].error = '注意'; return event; }); })();`,
    'event.error と disabled': handler(EDIT, `${LK}\n    if (${ST} === '承認待ち') event.error = '承認待ちです';`),
  };
  const c = cust({ requirement: 'r' });
  for (const [name, code] of Object.entries(CASES)) {
    const rv = KTCodeReview.review({ generated: gen(code), customization: c, plan: null, data: clone(DATA_NOW), scan: null, existingSource: null });
    const ce = rv.checks.find(x => x.name === 'error-cancels-edit');
    assert(rv.registration.verdict === 'BLOCKED' && ce && ce.severity === 'block' && ce.simDecides === true, `確認 1: ${name} → 模擬の結果が無い review は HEAD と同じ登録不可: ${rv.registration.verdict}`);
    // 隔離環境を用意できない（どのケースも動かない）模擬の結果を付けても、判定は形式確認のまま（登録不可）
    const noRun = await KTJsSim.simulate({ customization: c, generated: gen(code), review: { finalCode: code }, existingSource: null, otherFiles: [], data: DATA_NOW, backend: null });
    assert(KTCodeReview.simRan(noRun) === false && KTCodeReview.attachSim(rv, noRun, { customization: c }).checks.find(x => x.name === 'error-cancels-edit').severity === 'block', `確認 1: ${name} → 模擬が実行できなかった結果では下げない（登録不可のまま）`);
    // 模擬が動いたら、error-cancels-edit は確認に下げ、実際の競合は sim-conflict（登録不可）で判定する
    const sim = await KTJsSim.simulate({ customization: c, generated: gen(code), review: { finalCode: code }, existingSource: null, otherFiles: [], data: DATA_NOW, backend });
    const merged = KTCodeReview.attachSim(rv, sim, { customization: c });
    assert(KTCodeReview.simRan(sim) && merged.checks.find(x => x.name === 'error-cancels-edit').severity === 'review' && merged.checks.some(x => x.name === 'sim-conflict' && !x.ok && x.severity === 'block') && merged.registration.verdict === 'BLOCKED', `確認 1: ${name} → 模擬が動いたら模擬の結果（実際の競合 sim-conflict）で登録不可: ${JSON.stringify(merged.registration.blockers.map(b => b.code))}`);
  }
  // 模擬が動き、実際には重ならない書き方（else-if で分けた）は模擬の結果で登録不可にしない
  const elseIf = handler(EDIT, "    if (!record['ステータス']) { record['amount'].error = '不明'; } else if (record['ステータス'].value === '承認待ち') { record['amount'].disabled = true; }");
  const rvX = KTCodeReview.review({ generated: gen(elseIf), customization: c, plan: null, data: clone(DATA_NOW), scan: null, existingSource: null });
  const simX = await KTJsSim.simulate({ customization: c, generated: gen(elseIf), review: { finalCode: elseIf }, existingSource: null, otherFiles: [], data: DATA_NOW, backend });
  const mX = KTCodeReview.attachSim(rvX, simX, { customization: c });
  assert(rvX.registration.verdict === 'BLOCKED' && mX.registration.verdict !== 'BLOCKED' && !mX.checks.some(x => x.name === 'sim-conflict'), `確認 1: else-if で分けた書き方は、模擬の結果が無い間は登録不可・模擬が動いたら競合なしで登録不可にしない: ${rvX.registration.verdict} → ${mX.registration.verdict}`);
});
// ---- 確認 4: 隔離環境の制限（SecurityError・ページの移動）は環境が原因の未確認（修復を頼まない）。理由を分ける ----
await section(async () => {
  // iframe の中と同じく、全体の値を経由した保存領域の読み取りが SecurityError になる環境（vm の別 context の上に用意する）
  const vm = require('vm');
  const sandboxed = ({ navigate = false } = {}) => ({
    kind: 'vm', available: true,
    async run({ runtimeSource, files, inputJson }) {
      const ctx = vm.createContext({}, { microtaskMode: 'afterEvaluate' });
      const g = vm.runInContext('globalThis', ctx);
      Object.defineProperty(g, 'localStorage', { get() { const e = new Error("Failed to read the 'localStorage' property from 'Window': The document is sandboxed"); e.name = 'SecurityError'; throw e; }, configurable: false });
      Object.defineProperty(g, 'window', { get() { return g; }, configurable: false });
      let navigated = false;
      Object.defineProperty(g, 'location', { get() { return { href: 'about:srcdoc', set href(v) { navigated = true; } }; }, set(v) { navigated = true; }, configurable: false });
      const runIn = (code, filename) => new vm.Script(code, { filename }).runInContext(ctx, { timeout: 2000 });
      runIn(runtimeSource, 'rt.js'); runIn(`__ktSim.install(${JSON.stringify(inputJson)});`, 'install.js');
      for (const f of files) { runIn(`__ktSim.beginFile(${JSON.stringify(f.name)});`, 'b.js'); try { runIn(f.text, f.name); } catch (e) { runIn(`__ktSim.fileError(${JSON.stringify(f.name)}, ${JSON.stringify({ message: String(e && e.message), name: e && e.name })});`, 'fe.js'); } }
      runIn('__ktSim.runAll();', 'run.js');
      // ページを移動させた候補は、ブラウザでは結果が返らず時間切れになる（その形を返す）
      if (navigate && navigated) return { version: '1', finished: false, failure: null, loadErrors: [], cases: [], network: [], timedOut: true, blocked: false };
      return JSON.parse(runIn('__ktSim.resultJson();', 'res.js'));
    },
  });
  const ls = handler(EDIT, "    const k = window.localStorage.getItem('x');\n    if (record['ステータス'] && record['ステータス'].value === '承認待ち') record['amount'].disabled = true;");
  const sLs = await KTJsSim.simulate({ customization: cust(), generated: gen(ls), review: { finalCode: ls }, existingSource: null, otherFiles: [], data: DATA_NOW, backend: sandboxed() });
  assert(!sLs.checks.some(x => x.name === 'sim-exception') && !sLs.checks.some(x => x.name === 'sim-control' && !x.ok && x.severity === 'block') && sLs.unverified.some(u => u.code === 'SANDBOX') && sLs.counts.unverified === sLs.cases.length && KTJsSim.failuresForFeedback(sLs).length === 0, `確認 4: SecurityError は環境が原因の未確認（例外・制御の欠落にせず、修復を頼まない）: ${JSON.stringify(sLs.checks.filter(x => !x.ok).map(x => x.name))}`);
  assert(/隔離環境では確かめられない書き方（ブラウザの保存領域/.test(sLs.cases[0].message) && /隔離環境では確かめられない書き方/.test(KTJsSim.UNVERIFIED_REASON_JA.SANDBOX), `確認 4: 理由は「隔離環境では確かめられない書き方」: ${sLs.cases[0].message}`);
  // 読み込み時（handler の外）の SecurityError も同じ
  const lsLoad = `const SAVED = window.localStorage.getItem('x');\n${GOOD_LOCK_C1F}`;
  const sLoad = await KTJsSim.simulate({ customization: cust(), generated: gen(lsLoad), review: { finalCode: lsLoad }, existingSource: null, otherFiles: [], data: DATA_NOW, backend: sandboxed() });
  assert(!sLoad.checks.some(x => x.name === 'sim-exception') && sLoad.unverified.some(u => u.code === 'SANDBOX') && KTJsSim.failuresForFeedback(sLoad).length === 0, `確認 4: 読み込み時の SecurityError も環境が原因の未確認: ${JSON.stringify(sLoad.unverified.map(u => u.code))}`);
  // ページの移動（window.location.href への代入）による時間切れは「ページの移動」と理由を分ける（時間切れ・実行できないとは言わない）
  const nav = handler(EDIT, "    if (record['ステータス'] && record['ステータス'].value === '承認待ち') record['amount'].disabled = true;\n    window.location.href = '/k/1/';");
  const sNav = await KTJsSim.simulate({ customization: cust(), generated: gen(nav), review: { finalCode: nav }, existingSource: null, otherFiles: [], data: DATA_NOW, backend: sandboxed({ navigate: true }) });
  assert(sNav.unverified.some(u => u.code === 'NAVIGATION') && !sNav.unverified.some(u => u.code === 'TIMEOUT') && /ページの移動/.test(sNav.cases[0].message) && KTJsSim.failuresForFeedback(sNav).length === 0, `確認 4: ページの移動による時間切れは「隔離環境では確かめられない書き方（ページの移動）」: ${JSON.stringify(sNav.unverified.map(u => u.code))} ${sNav.cases[0] && sNav.cases[0].message}`);
  assert(KTJsSim.navigatesIn(nav) === true && KTJsSim.navigatesIn("location.assign('/x');") === true && KTJsSim.navigatesIn(handler(EDIT, '    const p = location.pathname;')) === false, '確認 4: ページを移動させる書き方の見分け（代入・assign。読み取りは移動ではない）');
  // 移動の書き方が無い時間切れは従来どおり「時間内に結果が返らなかった」
  const slow = { kind: 'vm', available: true, async run() { return { version: '1', finished: false, failure: null, loadErrors: [], cases: [], network: [], timedOut: true, blocked: false }; } };
  const sSlow = await KTJsSim.simulate({ customization: cust(), generated: gen(GOOD_LOCK_C1F), review: { finalCode: GOOD_LOCK_C1F }, existingSource: null, otherFiles: [], data: DATA_NOW, backend: slow });
  assert(sSlow.unverified.some(u => u.code === 'TIMEOUT') && !sSlow.unverified.some(u => u.code === 'NAVIGATION'), '確認 4: 移動の書き方が無い時間切れは従来どおり TIMEOUT');
  // ブラウザの backend: 移動の合図（navigated）を受けたら時間切れを待たずに終える
  const { be, cap, contentWindow } = captureIframe({ nonce: 'n-nav', timeoutMs: 5000 });
  const pr = be.run({ runtimeSource: 'void 0', files: [], inputJson: '{}' });
  cap.listener({ source: contentWindow, data: JSON.stringify({ kt: 'n-nav', navigated: true }) });
  const out = await pr;
  assert(out && out.navigated === true && out.timedOut === true && out.blocked === false, `確認 4: iframe の backend は移動の合図で終える（navigated）: ${JSON.stringify(out)}`);
  assert(/pagehide/.test(KTJsSim.runtimeSource()) && /navigated: true/.test(KTJsSim.runtimeSource()), '確認 4: runtime はページを離れる前に移動の合図を送る');
});
// ---- 確認 3: 会話に出す条件の文・例外の文 ----
await section(() => {
  assert(KTJsSim.conditionJa('ステータス in ("承認待ち")') === 'ステータスが「承認待ち」' && KTJsSim.conditionJa('ステータス in ("承認待ち", "承認済み")') === 'ステータスが「承認待ち」か「承認済み」' && KTJsSim.conditionJa('amount >= 100 and ステータス not in ("完了")', { labels: { amount: '金額' } }) === '金額が100以上、かつステータスが「完了」以外' && KTJsSim.conditionJa('((') === '計画の条件', `確認 3: 条件式を日本語の文に（ラベルを使う。読めない条件は「計画の条件」）: ${KTJsSim.conditionJa('amount >= 100 and ステータス not in ("完了")', { labels: { amount: '金額' } })}`);
  assert(KTJsSim.exceptionJa("Cannot read properties of undefined (reading 'value')") === '値の無い項目を読もうとしました（無いフィールド・この画面に無い値）' && KTJsSim.exceptionJa("Cannot read properties of null (reading 'x')").startsWith('値の無い項目を読もうとしました') && KTJsSim.exceptionJa('foo is not defined') === '定義されていない名前を使っています' && KTJsSim.exceptionJa('x.y is not a function') === '関数ではないものを呼び出しています' && KTJsSim.exceptionJa('Something odd happened in the code') === '実行時のエラー（詳細は右の検証結果）', '確認 3: よく出る例外は日本語に・ほかの英語の例外文は「実行時のエラー（詳細は右の検証結果）」');
  const t = KTJsSim.exceptionsInTextJa("制御なし。例外: Cannot read properties of undefined (reading 'value')／既存の a.js: 例外（Weird failure in library）");
  assert(!/[A-Za-z]{4,}/.test(t) && /例外: 値の無い項目を読もうとしました/.test(t) && /例外（実行時のエラー（詳細は右の検証結果））/.test(t), `確認 3: 文の中の例外の部分だけを置き換える: ${t}`);
});
// ---- 確認 7: JavaScript で直せない制約（行の追加・削除）を NOT_MET と申告 → 登録不可のまま修復を頼まない（SUBTABLE_ROWS で示す）----
await section(() => {
  const rv = (note) => KTCodeReview.review({ generated: gen(GOOD_LOCK_C1F, { coverage: [{ requirementId: 'C1', status: 'NOT_MET', note, text: '承認待ちでは明細を編集不可' }] }), customization: cust({ requirement: '承認待ちでは明細を編集不可' }), plan: { customizations: [cust()], steps: [] }, data: clone(DATA_NOW), scan: null, existingSource: null });
  const rows = rv('テーブルの行の追加・削除は JavaScript では止められない');
  const cu = rows.checks.find(x => x.name === 'coverage-unmet');
  assert(rows.registration.verdict === 'BLOCKED' && cu && cu.severity === 'block' && cu.noRepair === true && cu.limit === 'SUBTABLE_ROWS' && rows.coverage.notAchieved.some(x => x.code === 'SUBTABLE_ROWS'), `確認 7: 行の追加・削除を理由にした NOT_MET は登録不可のまま・修復の対象外（noRepair）・達成範囲に SUBTABLE_ROWS: ${JSON.stringify(cu)}`);
  const other = rv('一部の条件を満たせない').checks.find(x => x.name === 'coverage-unmet');
  assert(other && other.severity === 'block' && !other.noRepair, '確認 7: ほかの理由の NOT_MET は従来どおり修復の対象');
});

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})();
