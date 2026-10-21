// 承認の取り消しの知らせの文（2026-10-21。画面の流れ・固定の応答。有料の AI は呼ばない）
//
// 検証内容: 最終案のカードの［動作テスト環境へ反映］を途中で止めたとき、会話に出る承認の取り消しの知らせは
//   「最終案の承認を取り消しました。」＋理由の一文＋次の手 の形で、句読点を重ねない（「、。」にしない）・文の間に空白を入れない。
//   理由は句点で終わる一文（「…ためです。」）にそろえ、会話の組み立て（joinReason）はそのままつなぐ。
//   反映の途中の知らせは、押したときに出る結果のカードの下に出るので、次の手は「次の手は上の結果のカードにまとめています。」で結果のカードを指す
//   （結果のカードと同じ次の手を知らせに書かない）
//   §R1 JavaScript の登録の準備で止まった（設定を書いた後、書いた直後の取り直しの前に、別の作業者がカスタマイズを変えた）
//   §R2 JavaScript を登録できなかった（ファイルのアップロードの失敗）
//   §R3 設定の手順が途中で止まった（フィールドの追加の失敗。もとから一文の理由は変えない）
//   §R4 承認の後に動作テスト環境の設定が変わった（押す前に別の作業者がカスタマイズを変えた）: 知らせは承認の取り消しの 1 つだけで、変わったことを一度だけ言う
//       （前は計画の作り直しをすすめる知らせが続けて出て、同じ理由を繰り返していた）。反映の途中なので、作り直しの次の手は結果のカードだけに書く。
//       反映が終わった後に変わったとき（反映の途中でない）は、知らせの中で作り直しを案内する
//   §R5 最終案を作った後に設定が変わった（承認の前。会話の approveFinal）: 承認は無いので、計画の作り直しをすすめる知らせだけで、変わったことを一度だけ言う。
//       理由を渡さない markStale は既定の一文で言う
//   §R6 反映を途中で止めるときの理由（applyFinal の revoke に渡す文）と、承認を外すときの理由（markStale に渡す文）は、どれも空か句点で終わる一文
//       （画面から作りにくい止め方も含めて、本体の文で確かめる）
//
// 実行方法: node tests/ai-revoke-notice.test.js（KT_SRC=<別ビルド> で修正前の版に対して走らせると RED になる）
'use strict';
const fs = require('fs');
const path = require('path');
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const T = loadToolkit();
const { createNewFlowKit } = require('./helpers/new-flow.js');
const K = createNewFlowKit(T);
const { assert, state } = makeAssert();
async function section(fn) { try { await fn(); } catch (e) { assert(false, `例外: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' / ') : e}`); } }
/** 会話の知らせ（data.kind）の文 */
const noticesOf = (m, kind) => m.msgs().filter(x => x.data && x.data.kind === kind).map(x => String(x.text || ''));
/** 句読点を重ねない・句読点の後ろに空白を入れない */
const tidy = (t) => !/[、。][、。]/.test(t) && !/[、。] /.test(t);
/** 会話の画面（描いた HTML の文）に出ているか */
const shown = (m, text) => K.stripC(m.chat()).includes(text);
const NEXT = '次の手は上の結果のカードにまとめています。';
/** 知らせが結果のカード（押したときに出す「動作テスト環境へ反映します。」のカード）より下に出ているか（会話の画面の HTML の順） */
const belowCard = (m, text) => { const h = m.chat(); const c = h.lastIndexOf('kt-ai-final-apply-card'), i = h.indexOf(text); return c >= 0 && i > c; };
/** 別の作業者が動作テスト環境のカスタマイズに JavaScript（URL）を足した */
const otherJs = (m) => { m.mock.st.customize.desktop.js.push({ type: 'URL', url: 'https://example.com/other.js' }); m.mock.st.revision += 1; };
const runOf = (r) => ({ stage: r.run && r.run.stage, stop: r.run && r.run.stop && r.run.stop.text, writes: r.writes });

(async () => {
// =========================================================
console.log('\n--- §R1. JavaScript の登録の準備で止まった ---');
await section(async () => {
  //   混在（承認メモの追加・一覧の追加・承認メモを編集不可にする JavaScript）。設定を書いた後、書いた直後の取り直し（after-apply）の前に別の作業者が
  //   カスタマイズを変えた → 登録の準備で止まる（JavaScript は書き込まない）
  let mref = null;
  const loader = K.loadDevBaseFromMock(() => mref.mock);
  const gen = K.screenGenerate({ field: 'approval_memo', targetFile: 'memoLock.js' });
  const m = K.mount({ health: K.HEALTH_V, planImpl: K.planImplOf(K.screenPlan('mixed')), generateImpl: gen.impl,
    extra: { loadDevBase: (a = {}) => { if (a.reason === 'after-apply') otherJs(mref); return loader(a); } } });
  mref = m;
  await K.ticks();
  await K.adoptOnScreen(m); await K.ticks(20);
  const r = await K.applyOnScreen(m);
  const revoked = noticesOf(m, 'approval-revoked');
  const want = `最終案の承認を取り消しました。JavaScript の登録の準備で止まったためです。${NEXT}`;
  assert(r.clicked && r.run && r.run.stage === 'stopped' && r.run.stop.text === 'JavaScript の登録の準備で止まりました。' && JSON.stringify(r.writes) === JSON.stringify(['POST fields', 'PUT views']) && !r.v.approval,
    `R1-1: 設定を書いた後にカスタマイズが変わると、JavaScript の登録の準備で止まる（JavaScript は書き込まない・承認を外す）: ${JSON.stringify(runOf(r))}`);
  assert(revoked.length === 1 && revoked[0] === want && tidy(revoked[0]) && shown(m, want) && belowCard(m, want),
    `R1-2: 取り消しの知らせは「…止まったためです。」の一文でつなぐ（「、。」にしない。会話の画面も同じ文で、結果のカードの下に出る）: ${JSON.stringify(revoked)}`);
});

// =========================================================
console.log('\n--- §R2. JavaScript を登録できなかった ---');
await section(async () => {
  //   混在。設定を書いた後に JavaScript のファイルのアップロードが失敗した（偽の kintone の failUpload）→ 一部だけ反映（カスタマイズは PUT しない）
  const { m } = await K.mountFinal({ kind: 'mixed' });
  const r = await K.applyOnScreen(m, { before: () => { m.mock.ctl.failUpload = 'GENERIC'; } });
  const revoked = noticesOf(m, 'approval-revoked');
  const want = `最終案の承認を取り消しました。JavaScript を登録できなかったためです。${NEXT}`;
  assert(r.clicked && r.run && r.run.stage === 'stopped' && r.run.partial === true && r.run.stop.text === 'JavaScript を登録できませんでした。' && JSON.stringify(r.writes) === JSON.stringify(['POST fields', 'PUT views', 'POST file']) && !r.v.approval,
    `R2-1: アップロードが失敗すると一部だけ反映で止まる（カスタマイズは PUT しない・承認を外す）: ${JSON.stringify(runOf(r))}`);
  assert(revoked.length === 1 && revoked[0] === want && tidy(revoked[0]) && shown(m, want) && belowCard(m, want),
    `R2-2: 取り消しの知らせは「…登録できなかったためです。」の一文でつなぐ（「、。」にしない。会話の画面も同じ文で、結果のカードの下に出る）: ${JSON.stringify(revoked)}`);
});

// =========================================================
console.log('\n--- §R3. 設定の手順が途中で止まった ---');
await section(async () => {
  //   混在。承認メモのフィールドの追加が失敗した（偽の kintone の failAddField）→ 止まった後の環境で JavaScript を登録しない
  const { m } = await K.mountFinal({ kind: 'mixed' });
  const r = await K.applyOnScreen(m, { before: () => { m.mock.ctl.failAddField = 'approval_memo'; } });
  const revoked = noticesOf(m, 'approval-revoked');
  const want = `最終案の承認を取り消しました。設定の手順が途中で止まったため、止まった後の環境で反映を続けないようにしました。${NEXT}`;
  assert(r.clicked && r.run && r.run.stage === 'stopped' && r.run.stop.text === '設定の手順が途中で止まりました。' && !r.writes.some(w => /file|customize/.test(w)) && !r.v.approval,
    `R3-1: フィールドの追加が失敗すると、JavaScript を登録せずに止まる（承認を外す）: ${JSON.stringify(runOf(r))}`);
  assert(revoked.length === 1 && revoked[0] === want && tidy(revoked[0]) && shown(m, want) && belowCard(m, want),
    `R3-2: もとから一文の理由は、そのまま取り消しの知らせにつなぐ（結果のカードの下に出る）: ${JSON.stringify(revoked)}`);
});

// =========================================================
console.log('\n--- §R4. 承認の後に動作テスト環境の設定が変わった ---');
await section(async () => {
  //   JavaScript だけ。承認の欄の準備の後（押す前）に別の作業者がカスタマイズを変えた → 押した直後の取り直しで止める（書き込み 0）。
  //   知らせは承認の取り消しの 1 つだけ（計画は STALE にする）。反映の途中なので、作り直しの次の手は結果のカードだけに書き、知らせはそれを指す
  const { m } = await K.mountFinal({ kind: 'js' });
  const r = await K.applyOnScreen(m, { before: () => otherJs(m) });
  const revoked = noticesOf(m, 'approval-revoked'), stale = noticesOf(m, 'stale');
  const reason = '承認の後に動作テスト環境の設定が変わりました。';
  const want = `最終案の承認を取り消しました。${reason}${NEXT}`;
  const chat = K.stripC(m.chat());
  assert(r.clicked && r.run && r.run.stage === 'stopped' && r.run.stop.text === '承認の欄の準備の後に、動作テスト環境の設定が変わりました。何も書き込まずに止めました。' && !r.writes.length && !r.v.approval && r.v.status === 'STALE',
    `R4-1: 押す前にカスタマイズが変わると、何も書き込まずに止める（承認を外し、計画は STALE）: ${JSON.stringify({ ...runOf(r), status: r.v && r.v.status })}`);
  assert(revoked.length === 1 && revoked[0] === want && tidy(revoked[0]) && shown(m, want) && belowCard(m, want),
    `R4-2: 承認を外す知らせは「最終案の承認を取り消しました。」＋変わったことの一文＋上の結果のカードを指す文（結果のカードの下に出る）: ${JSON.stringify(revoked)}`);
  assert(!stale.length && chat.split(reason).length - 1 === 1 && !chat.includes('現在の計画は最新の設定で作り直すことをおすすめします') && /最新の設定で最終案を作り直します/.test(r.card) && !/作り直/.test(revoked[0] || ''),
    `R4-3: 計画の作り直しをすすめる知らせを続けて出さない（変わったことは会話の中で一度だけ）。作り直しの次の手は結果のカードだけに書く: ${JSON.stringify({ stale, times: chat.split(reason).length - 1, card: r.card.slice(0, 200) })}`);
});
await section(async () => {
  //   JavaScript だけ。反映が終わった後（承認は残る）に別の作業者がカスタマイズを変え、［再取得］で取り直した → 反映の途中ではないので、
  //   知らせの中で作り直しを案内する（結果のカードを指さない）
  const { m } = await K.mountFinal({ kind: 'js' });
  const r = await K.applyOnScreen(m);
  const had = !!(r.v && r.v.approval);
  otherJs(m);
  await m.panel.refreshDevBase({ reason: 'manual' }); await K.ticks(20);
  const revoked = noticesOf(m, 'approval-revoked');
  const want = '最終案の承認を取り消しました。承認の後に動作テスト環境の設定が変わりました。最新の設定で最終案を作り直してください（同じ依頼をもう一度送ると作り直します）。';
  assert(r.run && r.run.stage === 'done' && r.run.ok && had && !r.v.approval && revoked.length === 1 && revoked[0] === want && tidy(revoked[0]) && shown(m, want),
    `R4-4: 反映が終わった後に変わったとき（反映の途中でない）は、知らせの中で作り直しを案内する: ${JSON.stringify({ stage: r.run && r.run.stage, had, revoked })}`);
});

// =========================================================
console.log('\n--- §R5. 最終案を作った後に設定が変わった（承認の前）---');
await section(async () => {
  //   会話: 最終案を作った後に作業の基準が変わった → 承認せず計画を STALE にする。承認は無いので、計画の作り直しをすすめる知らせだけ（変わったことは一度だけ）
  const notices = (c) => c.messages().filter(x => x.data && ['approval-revoked', 'stale'].includes(x.data.kind)).map(x => `${x.data.kind}:${x.text}`);
  const x = K.makeConvC();
  await K.adoptC(x);
  const v = x.c.activePlan();
  const r = x.c.approveFinal(K.approveArgs(v, { baseStamp: { fingerprint: 'fp-2' } }));
  const want = 'stale:最終案を作った後に動作テスト環境の設定が変わりました。現在の計画は最新の設定で作り直すことをおすすめします。';
  assert(r.ok === false && r.reason === 'BASE_CHANGED' && !v.approval && v.status === 'STALE' && JSON.stringify(notices(x.c)) === JSON.stringify([want]),
    `R5-1: 承認の前に変わったときは、計画の作り直しをすすめる知らせだけで、変わったことを一度だけ言う: ${JSON.stringify(notices(x.c))}`);
  //   理由を渡さない markStale（承認した最終案）: 既定の一文で言う（知らせは 1 つ）
  const y = K.makeConvC();
  await K.adoptC(y);
  const a = K.approveC(y);
  y.c.markStale();
  const wantY = 'approval-revoked:最終案の承認を取り消しました。動作テスト環境の設定が変更されました。最新の設定で最終案を作り直してください（同じ依頼をもう一度送ると作り直します）。';
  assert(a.ok && !y.c.activePlan().approval && y.c.activePlan().status === 'STALE' && JSON.stringify(notices(y.c)) === JSON.stringify([wantY]),
    `R5-2: 理由を渡さない markStale は既定の一文で言い、知らせは 1 つ: ${JSON.stringify({ approved: a.ok, notices: notices(y.c) })}`);
});

// =========================================================
console.log('\n--- §R6. 理由の文の決まり（本体の文）---');
await section(async () => {
  //   画面から作りにくい止め方（反映の直前の確かめ・準備を始められない・承認の後の登録の内容の変化・途中の例外など）の理由も、句点で終わる一文にそろえる
  const src = fs.readFileSync(process.env.KT_SRC || path.join(__dirname, '..', 'kintoneAppToolkit.user.js'), 'utf8');
  const reasonsOf = (re) => [...src.matchAll(re)].map(x => x[1]);
  const revokes = reasonsOf(/\brevoke\('([^']*)'\)/g), stales = reasonsOf(/\bmarkStale\('([^']*)'\)/g);
  const bad = [...revokes, ...stales].filter(t => t !== '' && !/。$/.test(t));
  assert(revokes.length > 0 && stales.length > 0 && !bad.length,
    `R6-1: 反映を途中で止める理由（revoke ${revokes.length} か所）と承認を外す理由（markStale ${stales.length} か所）は、空か句点で終わる一文: ${JSON.stringify(bad)}`);
});

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
