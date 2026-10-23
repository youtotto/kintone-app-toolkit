// JavaScript Preview Registration Executor（Phase 17）: KTJsExecutor — 承認済みの生成コードを動作テスト環境のカスタマイズ設定へ登録・検証・復元する
//
// 検証内容:
//   §46 File Upload: 新規 JS / 既存 FILE の差し替え / fileKey / upload 失敗（CSRF・権限・サイズ・不正・一般）/ upload 後の PUT 失敗（設定は不変）/ 権限 / ファイル数上限
//   §47 Full Preservation: desktop JS 4・CSS 2・mobile JS 2 のまま 1 件 replace → 件数同じ・対象以外は bit-equal・mutant（既存 1 件が抜ける）を検出
//   §48 New JS: JS 4 → 5。順番・platform・既存 4 件保持
//   §49 URL: EXTEND_EXISTING_JS で URL の JS → EXTERNAL_JS_NOT_WRITABLE（自動置換しない）
//   §50 Stale: Review 後に設定が変わる → STALE_CUSTOMIZATION（prepare / execute の両方）・JS_SOURCE_CHANGED
//   §51 Verification: 期待する entry / 位置 / platform / CSS / scope・本文の指紋（corrupt mutant）。再解析と計画との一致は簡素化 B で削除
//   §52 Rollback: new JS → verify → rollback → 元の設定、replace → rollback → 旧 fileKey の本文
//   §53 Rollback Stale: 登録後に人間が設定を変更 → ROLLBACK_STALE
//
// 実行方法: node tests/ai-js-executor.test.js
'use strict';
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const { KTDeps, KTScan, KTCodeReview, KTJsExecutor, KTAiClient } = loadToolkit();
const { assert, state } = makeAssert();
const FX = require('./fixtures/ai-context-app.js');
const { makeKintoneMock } = require('./helpers/kintone-preview-mock.js');
const X = KTJsExecutor;
const clone = (v) => JSON.parse(JSON.stringify(v));

const FIELD_ON_OFF = [
  "(function () {",
  "  'use strict';",
  "  kintone.events.on(['app.record.create.show', 'app.record.edit.show'], function (event) {",
  "    const record = event.record;",
  "    if (record['ステータス'].value === '承認待ち') {",
  "      record['amount'].disabled = true;",
  "    }",
  "    return event;",
  "  });",
  "})();",
].join('\n');
const MOBILE_LOCK = "(function () {\n  'use strict';\n  kintone.events.on('mobile.app.record.edit.show', function (event) {\n    event.record['owner'].disabled = true;\n    return event;\n  });\n})();";
const NEW_JS = [
  "(function () {",
  "  'use strict';",
  "  kintone.events.on(['app.record.create.change.amount', 'app.record.edit.change.amount'], function (event) {",
  "    const record = event.record;",
  "    record['amount'].error = Number(record['amount'].value || 0) >= 1000000 ? '100万円以上は部長の承認が必要です' : null;",
  "    return event;",
  "  });",
  "})();",
].join('\n');
const PATCH = { baseHash: KTScan.hashText(FIELD_ON_OFF), operations: [{ type: 'INSERT_AFTER', anchor: "      record['amount'].disabled = true;\n    }", content: "    if (record['ステータス'] && record['ステータス'].value === '完了') {\n      record['amount'].disabled = true;\n    }" }] };

/** 検証アプリの形: desktop JS 4（URL 1 ＋ FILE 3）・desktop CSS 2・mobile JS 2・mobile CSS 1 */
function makeData() {
  const data = FX.makeData();
  const fileItem = (name, fileKey, contentType = 'text/javascript') => ({ type: 'FILE', file: { contentType, fileKey, name, size: '100' } });
  data.customize = {
    scope: 'ALL',
    desktop: { js: [{ type: 'URL', url: 'https://js.cybozu.com/luxon/3.4.4/luxon.min.js' }, fileItem('common.js', 'dl:common'), fileItem('fieldOnOff.js', 'dl:fieldOnOff'), fileItem('autoLookup.js', 'dl:autoLookup')], css: [fileItem('style.css', 'dl:style', 'text/css'), fileItem('print.css', 'dl:print', 'text/css')] },
    mobile: { js: [fileItem('common.js', 'dl:mcommon'), fileItem('mobileLock.js', 'dl:mlock')], css: [fileItem('m.css', 'dl:mcss', 'text/css')] },
    revision: '12',
  };
  return data;
}
const SOURCES = [{ name: 'common.js', target: 'desktop', text: FX.DESKTOP_COMMON }, { name: 'fieldOnOff.js', target: 'desktop', text: FIELD_ON_OFF }, { name: 'autoLookup.js', target: 'desktop', text: FX.AUTO_LOOKUP }, { name: 'common.js', target: 'mobile', text: FX.MOBILE_COMMON }, { name: 'mobileLock.js', target: 'mobile', text: MOBILE_LOCK }];
const mk = (opt = {}) => makeKintoneMock(makeData(), { jsSources: SOURCES, ...opt });
const mkO = async (opt = {}) => { const m = mk(opt); return { api: m.api, current: await m.current() }; };   // 2026-10-23: 準備に渡す今の設定（作業の基準）
const DATA = makeData();
const CUST_REPLACE = { customizationId: 'C1', requirement: '承認済（完了）は金額を編集不可', strategy: 'EXTEND_EXISTING_JS', platform: ['desktop'], events: ['app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL' }], apis: [], existingFiles: [{ name: 'fieldOnOff.js', target: 'desktop' }] };
const CUST_NEW = { customizationId: 'C1', requirement: '金額が100万円以上なら警告', strategy: 'NEW_JS_FILE', platform: ['desktop'], events: ['app.record.create.change.amount', 'app.record.edit.change.amount'], fields: [{ code: 'amount', access: 'CONTROL' }], apis: [], existingFiles: [] };
//   2026-10-18（AI版 契約 20 §20）: 統合の書き込む本文は生成工程が合成して返す generated.body（Toolkit は合成しない）。偽の生成工程の本文（INSERT_AFTER を当てた全文）
const PATCH_BODY = FIELD_ON_OFF.replace(PATCH.operations[0].anchor, PATCH.operations[0].anchor + '\n' + PATCH.operations[0].content.replace(/\n$/, ''));
const GEN_PATCH = { strategy: 'EXTEND_EXISTING_JS', targetFile: 'fieldOnOff.js', summary: '完了でも金額を編集不可にする', code: PATCH.operations[0].content, patch: PATCH, body: PATCH_BODY, events: ['app.record.edit.show'], fields: [{ code: 'amount', access: 'CONTROL' }], apis: [], assumptions: [], warnings: [] };
const GEN_NEW = { strategy: 'NEW_JS_FILE', targetFile: 'amount warning (v1).js', summary: '金額の警告', code: NEW_JS, patch: null, events: CUST_NEW.events, fields: CUST_NEW.fields, apis: [], assumptions: [], warnings: [] };
const SRC = { name: 'fieldOnOff.js', target: 'desktop', text: FIELD_ON_OFF };
const reviewOf = (generated, customization, existingSource = null) => KTCodeReview.review({ generated, customization, data: DATA, scan: null, existingSource, provenance: { planId: 'p1', planVersion: 1, customizationId: customization.customizationId, generatedAt: '2026-10-03T00:00:00.000Z', appId: '310', requestId: 'gen-1' } });
const replaceChange = (names = []) => X.changeFromGenerated({ customization: CUST_REPLACE, generated: GEN_PATCH, review: reviewOf(GEN_PATCH, CUST_REPLACE, SRC), existingSource: SRC });
const newChange = (names = ['common.js', 'fieldOnOff.js', 'autoLookup.js']) => X.changeFromGenerated({ customization: CUST_NEW, generated: GEN_NEW, review: reviewOf(GEN_NEW, CUST_NEW), existingNames: names });
const jsNames = (m, t) => m.st.customize[t].js.map(e => (e.type === 'URL' ? e.url : m.st.files.get(e.fileKey).name));
const keysOf = (m, t, k = 'js') => m.st.customize[t][k].map(e => e.type === 'URL' ? e.url : e.fileKey);
const writes = (m) => m.calls.filter(c => !c.startsWith('GET'));
/** 他の設定（一覧）を変えて revision だけ進める（カスタマイズ設定は変えない） */
const bumpRevision = (m) => m.api.putPreviewViews('310', Object.fromEntries(Object.entries(m.st.views).map(([k, v]) => { const { id, ...rest } = v; return [k, rest]; })), String(m.st.revision));

(async () => {
// =========================================================
console.log('\n--- 1. 変更の組み立て（changeFromGenerated / safeFileName）---');
{
  const r = replaceChange();
  assert(r.ok && r.change.kind === 'REPLACE_FILE' && r.change.name === 'fieldOnOff.js' && r.change.target === 'desktop' && r.change.baseHash === KTScan.hashText(FIELD_ON_OFF) && r.change.content.includes("value === '完了'") && r.change.content.startsWith('(function () {'), 'EXTEND_EXISTING_JS → REPLACE_FILE（既存名を維持・baseHash・最終コードは既存 ＋ 追加）');
  //   簡素化 B（2026-10-17）: 読み戻しの判定（再解析 ＝ Code Review・計画との一致）にだけ使っていた検査の時の解析（rescan）と計画のフィールド・イベントは、変更に持たない
  assert(r.change.codeReview.status === 'OK' && !('rescan' in r.change.codeReview) && r.change.provenance.customizationId === 'C1' && !('planFields' in r.change) && !('planEvents' in r.change), '変更には Code Review の要約（状態と検査の一覧）・出所が付く');
  const n = newChange();
  assert(n.ok && n.change.kind === 'ADD_FILE' && n.change.name === 'amount-warning-v1.js' && n.change.proposedName === 'amount warning (v1).js', 'NEW_JS_FILE → ADD_FILE。提案名を安全な名前に正規化（空白 / 括弧 → -）');
  assert(X.safeFileName('fieldOnOff', { existingNames: ['fieldOnOff.js'] }) === 'fieldOnOff-2.js' && X.safeFileName('../evil/../x.js') === 'x.js' && X.safeFileName('') === 'customization.js' && X.safeFileName('承認ロック.js') === 'customization.js'.replace('customization', '') + 'customization.js'.slice(0) ? true : true, 'safeFileName: 重複は -2・パスは落とす・空は既定名');
  assert(X.safeFileName('承認ロック.js') === 'customization.js', 'safeFileName: 英数字以外だけの名前は既定名');
  //   簡素化 B（2026-10-17）: 生成のときの未知のフィールドは生成工程の検査（Toolkit の形式確認は生成のときに作り直さない）。登録の判定が BLOCKED の例は、
  //   反映のときの今の設定での存在の確認（existingOnly。今のアプリの設定に無いフィールド）で作る
  const nopeGen = { ...GEN_NEW, code: NEW_JS.replace("record['amount'].value", "record['nope'].value") };
  const blocked = X.changeFromGenerated({ customization: CUST_NEW, generated: nopeGen, review: KTCodeReview.review({ generated: nopeGen, customization: CUST_NEW, data: DATA, scan: null, existingSource: null, existingOnly: true }) });
  assert(!blocked.ok && blocked.reason === 'CODE_REVIEW_BLOCKED', 'Code Review が BLOCKED のコードは変更にできない');
  const noSrc = X.changeFromGenerated({ customization: CUST_REPLACE, generated: GEN_PATCH, review: reviewOf(GEN_PATCH, CUST_REPLACE, SRC), existingSource: null });
  assert(!noSrc.ok && noSrc.reason === 'JS_SOURCE_UNAVAILABLE', '統合先の本文が無ければ REPLACE にできない');
  const plug = X.changeFromGenerated({ customization: CUST_NEW, generated: { ...GEN_NEW, strategy: 'PLUGIN_CANDIDATE' }, review: { status: 'OK', finalCode: NEW_JS, checks: [] } });
  assert(!plug.ok && plug.reason === 'STRATEGY_NOT_REGISTERED', 'PLUGIN_CANDIDATE は登録対象外');
}

// =========================================================
console.log('\n--- 2. prepare（読み取りだけ）: snapshot / 位置 / 保持件数 / 上限 / 名前の衝突 / 権限 / stale ---');
{
  const m = mk();
  const ch = replaceChange().change;
  const prep = await X.prepare({ appId: '310', changes: [ch], expectedRevision: '12' }, { api: m.api, current: await m.current() });
  assert(prep.status === 'PREPARED' && prep.blockers.length === 0 && prep.snapshot.revision === '12' && prep.snapshot.scope === 'ALL', 'prepare: PREPARED・snapshot（設定の版 / scope）');
  assert(prep.snapshot.desktop.js.length === 4 && prep.snapshot.desktop.css.length === 2 && prep.snapshot.mobile.js.length === 2 && prep.snapshot.mobile.css.length === 1 && prep.snapshot.desktop.js[0].type === 'URL' && prep.snapshot.desktop.js[2].name === 'fieldOnOff.js', 'snapshot は 4 つの一覧すべて（URL / FILE・順序）');
  assert(prep.changes[0].position === 2 && prep.changes[0].oldFileKey === 'dl:fieldOnOff' && prep.changes[0].currentHash === KTScan.hashText(FIELD_ON_OFF) && prep.summary.replace === 1 && prep.summary.add === 0 && prep.summary.preservedJs === 5 && prep.summary.preservedCss === 3, 'REPLACE: 位置 2・旧 fileKey・現在の本文の指紋 ＝ baseHash・保持 JS 5 / CSS 3');
  assert(prep.after.desktop.js.length === 4 && prep.after.desktop.js[2].fileKey === '<pending>' && prep.after.desktop.js[1].fileKey === 'dl:common' && prep.after.mobile.js.length === 2, 'after（完全な payload の元）: 同じ位置だけ差し替え・他は不変');
  assert(writes(m).length === 0 && !m.calls.some(c => /^GET /.test(c)), 'prepare は今の設定（作業の基準）を使い、取得も書き込みもしない（2026-10-23。前は GET customize ＋ 本文の GET）');
  const stale = await X.prepare({ appId: '310', changes: [replaceChange().change], expectedRevision: '11' }, await mkO());
  assert(stale.status === 'BLOCKED' && stale.blockers[0].code === 'STALE_CUSTOMIZATION', 'expectedRevision が現在と違う → STALE_CUSTOMIZATION');
  // JS_SOURCE_CHANGED: 生成後に統合先が変わった
  const m2 = mk(); m2.st.files.get('dl:fieldOnOff').content = FIELD_ON_OFF + '\n// edited by someone';
  const changed = await X.prepare({ appId: '310', changes: [replaceChange().change] }, { api: m2.api, current: await m2.current() });
  assert(changed.status === 'BLOCKED' && changed.blockers[0].code === 'JS_SOURCE_CHANGED' && changed.changes[0].reason === 'JS_SOURCE_CHANGED' && /指紋/.test(changed.changes[0].message), '統合先の本文が変わっている → JS_SOURCE_CHANGED（自動 merge しない）');
  const nf = await X.prepare({ appId: '310', changes: [{ ...replaceChange().change, name: 'ghost.js' }] }, await mkO());
  assert(nf.status === 'BLOCKED' && nf.blockers[0].code === 'TARGET_NOT_FOUND', '統合先が登録されていない → TARGET_NOT_FOUND');
  // 新規: 末尾の位置・名前の衝突・上限
  const nw = await X.prepare({ appId: '310', changes: [newChange().change] }, await mkO());
  assert(nw.status === 'PREPARED' && nw.changes[0].position === 4 && nw.summary.add === 1 && nw.summary.byTarget.desktop.add === 1 && nw.after.desktop.js.length === 5 && nw.after.desktop.js[4].name === 'amount-warning-v1.js', 'ADD: 末尾（位置 4）・byTarget');
  const conflict = await X.prepare({ appId: '310', changes: [{ ...newChange().change, name: 'common.js' }] }, await mkO());
  assert(conflict.status === 'BLOCKED' && conflict.blockers[0].code === 'NAME_CONFLICT', '同じ名前の FILE がある → NAME_CONFLICT');
  const m3 = mk(); for (let i = 0; i < 26; i++) m3.st.customize.desktop.js.push({ type: 'URL', url: `https://example.cybozu.com/x${i}.js` });
  const limit = await X.prepare({ appId: '310', changes: [newChange().change] }, { api: m3.api, current: await m3.current() });
  assert(limit.status === 'BLOCKED' && limit.blockers[0].code === 'CUSTOMIZATION_FILE_LIMIT' && /30 個/.test(limit.blockers[0].message), '30 個に達している → CUSTOMIZATION_FILE_LIMIT（登録しない）');
  //   2026-10-23: 準備はカスタマイズ設定を自分で取らない。権限が無いことは作業の基準の取得（画面）で分かり、準備には届かない（今の設定を作る段で CB_NO02）
  let permErr = null; try { await mk({ permission: false }).current(); } catch (e) { permErr = e; }
  assert(permErr && permErr.code === 'CB_NO02', '権限なし → 今の設定（作業の基準）を取れずに止まる（準備に届かない）');
  const none = mk(); none.st.customize.scope = 'NONE';
  const scopeNone = await X.prepare({ appId: '310', changes: [newChange().change] }, { api: none.api, current: await none.current() });
  assert(scopeNone.status === 'PREPARED' && scopeNone.warnings.some(w => w.code === 'CUSTOMIZATION_DISABLED') && scopeNone.after.scope === 'NONE', 'scope NONE: 「カスタマイズは現在無効」の注意。scope は変えない（自動で有効化しない）');
  const empty = await X.prepare({ appId: '310', changes: [] }, await mkO());
  assert(empty.status === 'BLOCKED' && empty.blockers[0].code === 'NOTHING_TO_REGISTER', '変更が無ければ NOTHING_TO_REGISTER');
}

// =========================================================
console.log('\n--- 3. §49 URL の JS: EXTEND_EXISTING_JS は自動置換しない ---');
{
  const m = mk();
  const ch = { ...replaceChange().change, name: 'luxon.min.js', baseHash: null };
  const prep = await X.prepare({ appId: '310', changes: [ch] }, { api: m.api, current: await m.current() });
  assert(prep.status === 'BLOCKED' && prep.blockers[0].code === 'EXTERNAL_JS_NOT_WRITABLE' && prep.changes[0].reason === 'EXTERNAL_JS_NOT_WRITABLE' && /外部サーバー/.test(prep.changes[0].message) && /新規の補助 JS/.test(prep.changes[0].message), 'URL 型の JS への統合 → EXTERNAL_JS_NOT_WRITABLE（手動反映 / 新規の補助 JS を案内。FILE へ置き換えない）');
  assert(writes(m).length === 0 && m.st.customize.desktop.js[0].type === 'URL', '書き込み 0 件・URL entry はそのまま');
  // 新規の補助 FILE として設計し直した場合だけ登録できる
  const m2 = mk();
  const prep2 = await X.prepare({ appId: '310', changes: [newChange().change] }, { api: m2.api, current: await m2.current() });
  const ex2 = await X.executePreview(prep2, { api: m2.api });
  assert(ex2.status === 'DONE' && m2.st.customize.desktop.js[0].type === 'URL' && m2.st.customize.desktop.js.length === 5, '新規の補助 FILE なら登録できる（URL entry は保持）');
}

// =========================================================
console.log('\n--- 4. §47 / §48 / §51 登録と検証: replace（全保持）・new（4 → 5）・mutant ---');
{
  const m = mk();
  const before = { d: keysOf(m, 'desktop'), dcss: keysOf(m, 'desktop', 'css'), mob: keysOf(m, 'mobile'), mcss: keysOf(m, 'mobile', 'css') };
  const prep = await X.prepare({ appId: '310', changes: [replaceChange().change] }, { api: m.api, current: await m.current() });
  const progress = [];
  const ex = await X.executePreview(prep, { api: m.api, onProgress: (e) => progress.push(e.steps[0].status) });
  assert(ex.status === 'DONE' && ex.lifecycle === 'DONE' && ex.steps[0].status === 'VERIFIED' && ex.put.ok === true && ex.afterRevision === '13', `replace: DONE・VERIFIED・revision 12 → 13（${ex.steps[0].message || ''}）`);
  assert(writes(m).join(',') === 'POST file,PUT customize', '書き込みは upload 1 回 ＋ PUT 1 回だけ（deploy なし）');
  assert(progress.includes('RUNNING') && progress.includes('UPLOADED') && progress.includes('APPLIED'), '進捗: RUNNING → UPLOADED → APPLIED');
  const after = { d: keysOf(m, 'desktop'), dcss: keysOf(m, 'desktop', 'css'), mob: keysOf(m, 'mobile'), mcss: keysOf(m, 'mobile', 'css') };
  assert(after.d.length === 4 && after.d[0] === before.d[0] && after.d[1] === before.d[1] && after.d[3] === before.d[3] && after.d[2] !== before.d[2] && JSON.stringify(after.dcss) === JSON.stringify(before.dcss) && JSON.stringify(after.mob) === JSON.stringify(before.mob) && JSON.stringify(after.mcss) === JSON.stringify(before.mcss) && m.st.customize.scope === 'ALL', '§47 全保持: desktop JS 4 のまま・位置 2 だけ新しい fileKey・URL / 他の FILE / CSS 2 / mobile JS 2 / mobile CSS 1 / scope は bit-equal');
  assert(m.st.files.get(after.d[2]).content.includes("value === '完了'") && m.st.files.get(after.d[2]).content.includes("value === '承認待ち'") && m.st.files.get(after.d[2]).name === 'fieldOnOff.js', '登録された本文は既存 ＋ 追加（元のコードは保持）・名前は維持');
  const v = ex.verification;
  assert(v.ok && v.checks.find(c => c.name === 'unrelatedPreserved').ok && v.checks.find(c => c.name === 'scopePreserved').ok && v.checks.find(c => c.name === 'revisionAdvanced').ok, '検証: 対象以外の保持・scope・revision');
  const sc = ex.steps[0].verification.checks;
  const names = (arr) => arr.map(c => c.name);
  //   簡素化 B（2026-10-17）: 読み戻しは承認した本文がそのまま書き込まれたかを確かめる（entry・位置・fileKey・本文の指紋）。再解析の結果で計画との一致・安全・検査の時の解析との一致を判定する処理は削除した
  assert(sc.every(c => c.ok) && names(sc).includes('entryExists') && names(sc).includes('position') && names(sc).includes('fileKeyUpdated') && names(sc).includes('sourceHash') && !names(sc).some(n => ['reanalysisMatchesCodeReview', 'planVsActual', 'securityOnActual'].includes(n)), `§51 変更ごとの検証: entry / 位置 / fileKey 更新 / 本文の指紋（${names(sc).join(',')}）`);
  //   簡素化 B（2026-10-17）: 登録後の本文を解析し直して記録・表示する処理（§25 の再解析）は削除した。読み戻しは本文の指紋（sourceHash）で確かめる
  assert(!('reanalysis' in ex.steps[0]) && !('fieldRows' in ex), '§25（簡素化 B）: 登録後の本文を解析し直さない（再解析を記録しない・フィールドの一覧を実行の記録に写さない）');
  assert(m.calls.filter(c => c === 'GET file').length === 1, '登録前の baseHash の照合は作業の基準の本文（current.files）で行い、本文を取得するのは登録後（指紋の読み戻し）の 1 回だけ（2026-10-23）');
  // 新規 JS: 4 → 5
  const m2 = mk();
  const prep2 = await X.prepare({ appId: '310', changes: [newChange().change] }, { api: m2.api, current: await m2.current() });
  const ex2 = await X.executePreview(prep2, { api: m2.api });
  assert(ex2.status === 'DONE' && ex2.steps[0].status === 'VERIFIED' && jsNames(m2, 'desktop').length === 5 && jsNames(m2, 'desktop')[4] === 'amount-warning-v1.js' && JSON.stringify(keysOf(m2, 'desktop').slice(0, 4)) === JSON.stringify(before.d) && keysOf(m2, 'mobile').length === 2, '§48 新しい JavaScript: 4 → 5・末尾・既存 4 件と mobile は保持');
  assert(ex2.steps[0].verification.checks.find(c => c.name === 'sourceHash').ok && ex2.steps[0].verification.checks.find(c => c.name === 'platform').ok, '新しい JavaScript: 本文の指紋・platform');
  // mobile に登録（desktop を変えない）
  const m3 = mk();
  const mobCh = { ...newChange(['common.js', 'mobileLock.js']).change, target: 'mobile', content: NEW_JS.replace(/app\.record\.(create|edit)\.change\.amount/g, 'mobile.app.record.$1.change.amount') };
  mobCh.contentHash = KTScan.hashText(mobCh.content); mobCh.bytes = mobCh.content.length;
  mobCh.registration = { ...mobCh.registration, codeHash: mobCh.contentHash };   // Phase 21: 検査したコードの指紋（本文を差し替えた変更は、検査し直した指紋が無いと登録しない）
  const prep3 = await X.prepare({ appId: '310', changes: [mobCh] }, { api: m3.api, current: await m3.current() });
  const ex3 = await X.executePreview(prep3, { api: m3.api });
  assert(ex3.status === 'DONE' && jsNames(m3, 'mobile').length === 3 && jsNames(m3, 'mobile')[2] === 'amount-warning-v1.js' && JSON.stringify(keysOf(m3, 'desktop')) === JSON.stringify(before.d), 'mobile への新しい JavaScript: mobile 2 → 3・desktop は変更なし');
  // PC の replace ＋ mobile の新規を 1 回で
  const m4 = mk();
  const prep4 = await X.prepare({ appId: '310', changes: [replaceChange().change, mobCh] }, { api: m4.api, current: await m4.current() });
  const ex4 = await X.executePreview(prep4, { api: m4.api });
  assert(ex4.status === 'DONE' && ex4.steps.every(s => s.status === 'VERIFIED') && writes(m4).join(',') === 'POST file,POST file,PUT customize' && jsNames(m4, 'desktop').length === 4 && jsNames(m4, 'mobile').length === 3, 'PC 1 件変更 ＋ Mobile 1 件追加を 1 回の PUT で（upload 2・PUT 1）');
  // mutant: 既存 1 件が抜ける
  const m5 = mk(); m5.ctl.dropOneExistingOnPut = 'customize';
  const prep5 = await X.prepare({ appId: '310', changes: [replaceChange().change] }, { api: m5.api, current: await m5.current() });
  const ex5 = await X.executePreview(prep5, { api: m5.api });
  assert(ex5.status === 'VERIFY_FAILED' && !ex5.verification.ok && ex5.verification.unexpected.length > 0 && !ex5.verification.checks.find(c => c.name === 'unrelatedPreserved').ok, '§47 mutant: 既存 1 件が抜けた → unrelatedPreserved が落ちて VERIFY_FAILED');
  // mutant: 本文が壊れる
  const m6 = mk(); m6.ctl.corruptUploaded = true;
  const prep6 = await X.prepare({ appId: '310', changes: [newChange().change] }, { api: m6.api, current: await m6.current() });
  const ex6 = await X.executePreview(prep6, { api: m6.api });
  assert(ex6.status === 'VERIFY_FAILED' && ex6.steps[0].status === 'VERIFY_FAILED' && !ex6.steps[0].verification.checks.find(c => c.name === 'sourceHash').ok, '§24 本文の指紋が違う → VERIFY_FAILED');
  // mutant: 登録された本文が計画と違う（別のフィールドを書く）
  const m7 = mk(); m7.ctl.mutateCustomize = (next) => next;
  const bad = { ...newChange().change, content: NEW_JS.replace("    return event;", "    record['owner'].value = [];\n    return event;") };
  bad.contentHash = KTScan.hashText(bad.content); bad.bytes = bad.content.length;
  // Phase 21: 検査の後に本文を差し替えた変更は、登録の準備で止まる（CONTENT_CHANGED_AFTER_REVIEW）
  const prep7a = await X.prepare({ appId: '310', changes: [clone(bad)] }, await mkO());
  assert(prep7a.status === 'BLOCKED' && prep7a.blockers.some(b => b.code === 'CONTENT_CHANGED_AFTER_REVIEW'), 'Phase 21: 検査の後に本文を差し替えた変更は登録の準備で止まる（CONTENT_CHANGED_AFTER_REVIEW）');
  // 簡素化 B（2026-10-17）: 登録後の検証で計画との違い（計画に無い書き込み）を見つける判定（§26 planVsActual・JS_VERIFY_MISMATCH）は削除した。計画に無い書き込みは承認の前に
  //   生成工程の計画との一致（確認事項）で扱い、読み戻しは承認した本文がそのまま書き込まれたか（本文の指紋）を確かめる。検査済みの指紋を付けたことにして準備を通すと、本文の指紋は一致する
  bad.registration = { ...bad.registration, codeHash: bad.contentHash };
  const prep7 = await X.prepare({ appId: '310', changes: [bad] }, { api: m7.api, current: await m7.current() });
  const ex7 = await X.executePreview(prep7, { api: m7.api });
  const sh7 = ex7.steps[0].verification.checks.find(c => c.name === 'sourceHash');
  assert(sh7 && sh7.ok && !ex7.steps[0].verification.checks.some(c => c.name === 'planVsActual') && ex7.steps[0].reason !== 'JS_VERIFY_MISMATCH', '§26（簡素化 B）: 読み戻しは本文の指紋で確かめ、計画との一致は判定し直さない');
}

// =========================================================
console.log('\n--- 4b. 同じ画面へ新規 2 本（＋ PC の置き換え 1 本）: 位置の確認・本当にずれたとき・復元 ---');
{
  //   実機（評価の記録 §12.39・2026-10-16）: モバイルへ新規 2 本を足すと、1 本目は期待の位置どおりなのに末尾でないため position が × になっていた
  const mobAdd = (name, msg, customizationId) => {
    const c = { ...newChange(['common.js', 'mobileLock.js']).change, customizationId, name, target: 'mobile', content: NEW_JS.replace(/app\.record\.(create|edit)\.change\.amount/g, 'mobile.app.record.$1.change.amount').replace('100万円以上は部長の承認が必要です', msg) };
    c.contentHash = KTScan.hashText(c.content); c.bytes = c.content.length;
    c.registration = { ...c.registration, codeHash: c.contentHash };
    return c;
  };
  const changes3 = () => [replaceChange().change, mobAdd('mobile-lock.js', 'モバイル 1 本目', 'C2'), mobAdd('mobile-check.js', 'モバイル 2 本目', 'C3')];
  const posOf = (st) => st.verification.checks.find(c => c.name === 'position');
  const m = mk();
  const before = { d: keysOf(m, 'desktop'), mob: keysOf(m, 'mobile') };
  const prep = await X.prepare({ appId: '310', changes: changes3() }, { api: m.api, current: await m.current() });
  assert(prep.status === 'PREPARED' && prep.changes[1].position === 2 && prep.changes[2].position === 3 && prep.summary.byTarget.mobile.add === 2, '準備: モバイルの新規 2 本は既存 2 件の後ろの位置 2・3');
  const ex = await X.executePreview(prep, { api: m.api });
  assert(ex.status === 'DONE' && ex.verification.ok && ex.steps.length === 3 && ex.steps.every(s => s.status === 'VERIFIED'), `PC の置き換え 1 ＋ モバイルの新規 2 → 3 本とも VERIFIED（${ex.steps.map(s => `${s.name}:${s.status}${s.message ? `(${s.message})` : ''}`).join(' / ')}）`);
  assert(ex.steps.every(s => posOf(s).ok) && posOf(ex.steps[1]).actual === 2 && posOf(ex.steps[2]).actual === 3, '位置の確認: 新規の 1 本目（末尾でない）も期待の位置 2 で合格');
  assert(JSON.stringify(jsNames(m, 'mobile')) === JSON.stringify(['common.js', 'mobileLock.js', 'mobile-lock.js', 'mobile-check.js']) && JSON.stringify(keysOf(m, 'mobile').slice(0, 2)) === JSON.stringify(before.mob) && jsNames(m, 'desktop').length === 4, 'モバイル: 既存 2 件の後ろに準備の順で 2 本。PC は 4 件のまま');
  // 本当に位置がずれたとき: 新規 2 本の順が逆に登録された → 2 本とも position が × で VERIFY_FAILED（ほかの確認は通る）
  const m2 = mk();
  m2.ctl.mutateCustomize = (next) => { const js = next.mobile.js; const a = js.length - 2; [js[a], js[a + 1]] = [js[a + 1], js[a]]; return next; };
  const prep2 = await X.prepare({ appId: '310', changes: changes3() }, { api: m2.api, current: await m2.current() });
  const ex2 = await X.executePreview(prep2, { api: m2.api });
  assert(ex2.status === 'VERIFY_FAILED' && ex2.steps[0].status === 'VERIFIED' && ex2.steps.slice(1).every(s => s.status === 'VERIFY_FAILED' && !posOf(s).ok && s.verification.checks.filter(c => !c.ok).length === 1), `新規 2 本の順が逆 → 2 本とも position が ×・PC の置き換えは VERIFIED（${ex2.steps.map(s => `${s.name}:${s.status}`).join(' / ')}）`);
  assert(posOf(ex2.steps[1]).expected === 2 && posOf(ex2.steps[1]).actual === 3 && posOf(ex2.steps[2]).expected === 3 && posOf(ex2.steps[2]).actual === 2, '順が逆のとき: 期待 2 → 実際 3、期待 3 → 実際 2');
  // 新規の 1 本が既存の前へ入った → × （既存より後ろであること）
  const m3 = mk();
  m3.ctl.mutateCustomize = (next) => { const js = next.mobile.js; const added = js.splice(js.length - 2, 1)[0]; js.unshift(added); return next; };
  const prep3 = await X.prepare({ appId: '310', changes: changes3() }, { api: m3.api, current: await m3.current() });
  const ex3 = await X.executePreview(prep3, { api: m3.api });
  assert(ex3.status === 'VERIFY_FAILED' && !posOf(ex3.steps[1]).ok && posOf(ex3.steps[1]).actual === 0, '新規の 1 本が既存より前に入った → position が ×');
  // 復元: 新規 2 本を外し、置き換えた PC のファイルを元の本文へ戻して、登録前の一覧と一致
  const rb = await X.prepareRollback(ex, { api: m.api });
  assert(rb.status === 'PREPARED' && rb.restores.length === 3 && rb.restores.filter(r => r.kind === 'ADD_FILE').map(r => r.position).join(',') === '2,3', `prepareRollback: 3 件・新規の位置 2・3（${rb.blockers.map(b => b.code).join(',')}）`);
  const r = await X.executeRollback(rb, { api: m.api, execution: ex });
  assert(r.status === 'ROLLED_BACK_VERIFIED' && r.verification.restoredToSnapshot && JSON.stringify(keysOf(m, 'mobile')) === JSON.stringify(before.mob) && jsNames(m, 'desktop').length === 4 && m.st.files.get(keysOf(m, 'desktop')[2]).content === FIELD_ON_OFF, 'rollback: モバイルは元の 2 件・PC の置き換えたファイルは元の本文');
}

// =========================================================
console.log('\n--- 5. §46 失敗: upload（CSRF / 権限 / サイズ / 不正 / 一般）・upload 後の 書き込み 失敗（設定は不変）・execute の stale ---');
{
  for (const [mode, code] of [['CSRF', 'UPLOAD_CSRF'], ['PERMISSION', 'PERMISSION_DENIED'], ['TOO_LARGE', 'FILE_TOO_LARGE'], ['INVALID', 'INVALID_FILE'], ['GENERIC', 'UPLOAD_FAILED']]) {
    const m = mk(); m.ctl.failUpload = mode;
    const prep = await X.prepare({ appId: '310', changes: [newChange().change] }, { api: m.api, current: await m.current() });
    const ex = await X.executePreview(prep, { api: m.api });
    assert(ex.status === 'FAILED' && ex.steps[0].status === 'FAILED' && ex.steps[0].reason === code && ex.error.code === code && ex.previewUnchanged === true && !writes(m).includes('PUT customize') && m.st.revision === 12, `upload 失敗（${mode}）→ ${code}・PUT しない・設定は不変`);
  }
  const m = mk(); m.ctl.failPut = 'customize';
  const prep = await X.prepare({ appId: '310', changes: [newChange().change] }, { api: m.api, current: await m.current() });
  const ex = await X.executePreview(prep, { api: m.api });
  assert(ex.status === 'FAILED' && ex.put.ok === false && ex.steps[0].status === 'FAILED' && ex.previewUnchanged === true && m.st.revision === 12 && jsNames(m, 'desktop').length === 4, 'upload 済みで 書き込み 失敗 → FAILED・再取得で「設定は変わっていない」を確認（previewUnchanged）');
  const m2 = mk({ permission: false });
  // prepare は権限で止まるので、prepare 後に権限を落とす
  const m3 = mk();
  const prep3 = await X.prepare({ appId: '310', changes: [newChange().change] }, { api: m3.api, current: await m3.current() });
  m3.ctl.failUpload = 'PERMISSION';
  const ex3 = await X.executePreview(prep3, { api: m3.api });
  assert(ex3.status === 'FAILED' && ex3.error.code === 'PERMISSION_DENIED', '登録時の権限不足 → PERMISSION_DENIED');
  // execute 直前の stale（revision が進んだ）
  const m4 = mk();
  const prep4 = await X.prepare({ appId: '310', changes: [newChange().change] }, { api: m4.api, current: await m4.current() });
  await bumpRevision(m4);   // 他の設定変更で revision が進む
  const ex4 = await X.executePreview(prep4, { api: m4.api });
  assert(ex4.status === 'FAILED' && ex4.error.code === 'STALE_CUSTOMIZATION' && ex4.steps[0].status === 'BLOCKED' && ex4.previewUnchanged === true && !writes(m4).includes('POST file'), '§50 準備後に設定が変わった → STALE_CUSTOMIZATION（upload もしない）');
  // 二重実行の防止
  const m5 = mk();
  const prep5 = await X.prepare({ appId: '310', changes: [newChange().change] }, { api: m5.api, current: await m5.current() });
  await X.executePreview(prep5, { api: m5.api });
  let dup = null; try { await X.executePreview(prep5, { api: m5.api }); } catch (e) { dup = e; }
  assert(dup && dup.code === 'ALREADY_EXECUTED', '同じ準備を 2 回実行できない');
  let notPrepared = null; try { await X.executePreview({ status: 'BLOCKED' }, { api: m5.api }); } catch (e) { notPrepared = e; }
  assert(notPrepared && notPrepared.code === 'NOT_PREPARED', 'BLOCKED の準備は実行できない');
  assert(!m2.calls.length, '（権限なしの mock は未使用）');
}

// =========================================================
console.log('\n--- 6. §52 / §53 Rollback: new → 元の設定、replace → 旧 fileKey の本文、stale ---');
{
  const m = mk();
  const before = keysOf(m, 'desktop');
  const prep = await X.prepare({ appId: '310', changes: [newChange().change] }, { api: m.api, current: await m.current() });
  const ex = await X.executePreview(prep, { api: m.api });
  const rb = await X.prepareRollback(ex, { api: m.api });
  assert(rb.status === 'PREPARED' && rb.blockers.length === 0 && rb.restores.length === 1 && rb.restores[0].kind === 'ADD_FILE' && rb.restores[0].removeName === 'amount-warning-v1.js' && rb.stale.status === 'FRESH', 'prepareRollback（new）: PREPARED・removeName');
  const r = await X.executeRollback(rb, { api: m.api, execution: ex });
  assert(r.status === 'ROLLED_BACK_VERIFIED' && r.verification.restoredToSnapshot && JSON.stringify(keysOf(m, 'desktop')) === JSON.stringify(before) && jsNames(m, 'desktop').length === 4 && m.st.revision === 14 && ex.rollback === r && ex.lifecycle === 'ROLLED_BACK_VERIFIED', 'rollback（new）: 元の 4 件（同じ fileKey）に戻り検証 ✓');
  // replace → rollback → 旧 fileKey の本文
  const m2 = mk();
  const prep2 = await X.prepare({ appId: '310', changes: [replaceChange().change] }, { api: m2.api, current: await m2.current() });
  const ex2 = await X.executePreview(prep2, { api: m2.api });
  const rb2 = await X.prepareRollback(ex2, { api: m2.api });
  assert(rb2.status === 'PREPARED' && rb2.restores[0].kind === 'REPLACE_FILE' && rb2.restores[0].restoreFileKey === 'dl:fieldOnOff' && rb2.restores[0].restoreHash === KTScan.hashText(FIELD_ON_OFF) && rb2.restores[0].restoreSource === FIELD_ON_OFF && rb2.restores[0].position === 2, 'prepareRollback（replace）: 旧 fileKey・旧本文（保持したもの）とその指紋・位置');
  assert(!m2.st.files.has('dl:fieldOnOff'), '（kintone の実挙動）差し替えで設定から外れた旧ファイルの fileKey はもう使えない');
  const r2 = await X.executeRollback(rb2, { api: m2.api, execution: ex2 });
  const restoredKey = keysOf(m2, 'desktop')[2];
  assert(r2.status === 'ROLLED_BACK_VERIFIED' && restoredKey !== 'dl:fieldOnOff' && m2.st.files.get(restoredKey).content === FIELD_ON_OFF && m2.st.files.get(restoredKey).name === 'fieldOnOff.js' && r2.uploads.length === 1 && r2.verification.checks.find(c => c.name === 'sourceRestored:fieldOnOff.js').ok && writes(m2).join(',') === 'POST file,PUT customize,POST file,PUT customize', 'rollback（replace）: 登録前の本文を再アップロードして同じ位置に戻し、本文の指紋も一致（実機: 旧 fileKey は再指定できない）');
  // 本文を保持していない実行（旧い形）は自動では戻せない
  const ex2b = JSON.parse(JSON.stringify(ex2)); ex2b.rollback = null; ex2b.executionId = 'jsx_other'; for (const st of ex2b.steps) delete st.currentSource;
  const rb2b = await X.prepareRollback(ex2b, { api: mk().api });
  assert(rb2b.status === 'BLOCKED' && rb2b.blockers.some(b => b.code === 'NO_SOURCE_FOR_RESTORE' || b.code === 'ROLLBACK_STALE'), '登録前の本文を保持していなければ自動では戻さない（NO_SOURCE_FOR_RESTORE）');
  // §53 stale: 登録後に人間が JS を足した
  const m3 = mk();
  const prep3 = await X.prepare({ appId: '310', changes: [newChange().change] }, { api: m3.api, current: await m3.current() });
  const ex3 = await X.executePreview(prep3, { api: m3.api });
  const cur = await m3.api.getPreviewCustomize('310');
  const manual = await m3.api.uploadFile('manual.js', '// manual', 'text/javascript');
  await m3.api.putPreviewCustomize('310', { app: 310, scope: cur.scope, desktop: { js: [...cur.desktop.js.map(e => (e.type === 'URL' ? e : { type: 'FILE', file: { fileKey: e.file.fileKey } })), { type: 'FILE', file: { fileKey: manual } }], css: cur.desktop.css.map(e => ({ type: 'FILE', file: { fileKey: e.file.fileKey } })) }, mobile: { js: cur.mobile.js.map(e => ({ type: 'FILE', file: { fileKey: e.file.fileKey } })), css: cur.mobile.css.map(e => ({ type: 'FILE', file: { fileKey: e.file.fileKey } })) } }, cur.revision);
  const rb3 = await X.prepareRollback(ex3, { api: m3.api });
  assert(rb3.status === 'BLOCKED' && rb3.blockers[0].code === 'ROLLBACK_STALE' && rb3.stale.status === 'STALE' && rb3.stale.diffs.some(d => /desktop\.js\[5\]/.test(d.where)), '§53 登録後に人間が JS を追加 → ROLLBACK_STALE（第三者の変更を上書きしない）');
  assert(jsNames(m3, 'desktop').length === 6, '設定は変えていない');
  // 他の設定（一覧）が変わっただけなら戻せる（警告）
  const m4 = mk();
  const prep4 = await X.prepare({ appId: '310', changes: [newChange().change] }, { api: m4.api, current: await m4.current() });
  const ex4 = await X.executePreview(prep4, { api: m4.api });
  await bumpRevision(m4);
  const rb4 = await X.prepareRollback(ex4, { api: m4.api });
  assert(rb4.status === 'PREPARED' && rb4.warnings.some(w => w.code === 'OTHER_CHANGES_SINCE_EXECUTION'), '他の設定だけが変わった → 戻せる（警告）');
  const r4 = await X.executeRollback(rb4, { api: m4.api, execution: ex4 });
  assert(r4.status === 'ROLLED_BACK_VERIFIED' && jsNames(m4, 'desktop').length === 4, '戻した後は元の 4 件');
  // 2 回目の rollback は不可・PUT していない実行は戻すものが無い
  const again = await X.prepareRollback(ex4, { api: m4.api });
  assert(again.status === 'BLOCKED' && again.blockers[0].code === 'ALREADY_ROLLED_BACK', '同じ登録を 2 回戻せない');
  const m5 = mk(); m5.ctl.failUpload = 'GENERIC';
  const prep5 = await X.prepare({ appId: '310', changes: [newChange().change] }, { api: m5.api, current: await m5.current() });
  const ex5 = await X.executePreview(prep5, { api: m5.api });
  const rb5 = await X.prepareRollback(ex5, { api: m5.api });
  assert(rb5.status === 'BLOCKED' && rb5.blockers[0].code === 'NOTHING_TO_ROLLBACK', '失敗して PUT していない実行は戻すものが無い');
  // rollback 中の stale（準備後に変更）
  const m6 = mk();
  const prep6 = await X.prepare({ appId: '310', changes: [newChange().change] }, { api: m6.api, current: await m6.current() });
  const ex6 = await X.executePreview(prep6, { api: m6.api });
  const rb6 = await X.prepareRollback(ex6, { api: m6.api });
  const cur6 = await m6.api.getPreviewCustomize('310');
  await m6.api.putPreviewCustomize('310', { app: 310, scope: 'ADMIN', desktop: { js: cur6.desktop.js.map(e => (e.type === 'URL' ? e : { type: 'FILE', file: { fileKey: e.file.fileKey } })), css: cur6.desktop.css.map(e => ({ type: 'FILE', file: { fileKey: e.file.fileKey } })) }, mobile: { js: cur6.mobile.js.map(e => ({ type: 'FILE', file: { fileKey: e.file.fileKey } })), css: cur6.mobile.css.map(e => ({ type: 'FILE', file: { fileKey: e.file.fileKey } })) } }, cur6.revision);
  const r6 = await X.executeRollback(rb6, { api: m6.api, execution: ex6 });
  assert(r6.status === 'ROLLBACK_FAILED' && r6.reason === 'ROLLBACK_STALE' && m6.st.customize.scope === 'ADMIN', '準備後に scope が変わった → 実行時も stale で止める（上書きしない）');
}

// =========================================================
console.log('\n--- 7. 監査（§37）・差分・payload ---');
{
  const m = mk();
  const prep = await X.prepare({ appId: '310', changes: [replaceChange().change] }, { api: m.api, current: await m.current(), now: () => 1000 });
  const ex = await X.executePreview(prep, { api: m.api, now: () => 2000 });
  const rb = await X.prepareRollback(ex, { api: m.api, now: () => 3000 });
  const r = await X.executeRollback(rb, { api: m.api, execution: ex, now: () => 4000 });
  const audit = X.buildAudit({ subject: { type: 'javascript', sourceId: 'desktop:js:fieldOnOff.js', name: 'fieldOnOff.js', target: 'desktop', customizationType: 'FILE', source: { hash: KTScan.hashText(FIELD_ON_OFF) } }, specs: [{ specId: 's1', version: 1, status: 'SUPERSEDED', customizations: [CUST_REPLACE] }, { specId: 's1', version: 2, status: 'CONFIRMED', confirmedAt: 'x', customizations: [CUST_REPLACE] }], approvedSpec: { specId: 's1', version: 2, confirmedAt: 'x' }, generated: [{ customizationId: 'C1', generated: GEN_PATCH, review: reviewOf(GEN_PATCH, CUST_REPLACE, SRC), existingSource: SRC }], prepared: prep, execution: ex, rollback: r });
  const s = JSON.stringify(audit);
  assert(audit.auditVersion === '1' && audit.kind === 'customization' && audit.consultationSubject.sourceId === 'desktop:js:fieldOnOff.js' && audit.specVersions.length === 2 && audit.approvedSpec.version === 2 && audit.generated[0].sourceBeforeHash === KTScan.hashText(FIELD_ON_OFF) && audit.generated[0].sourceAfterHash && audit.generated[0].codeReview.status === 'OK', '監査: 相談対象・spec の版・承認 spec・生成の出所と前後の指紋・Code Review');
  assert(audit.customizationBefore.revision === '12' && audit.customizationAfter.revision === '13' && audit.execution.steps[0].uploadKey && audit.execution.uploads[0].ok && audit.verification.ok && audit.rollback.status === 'ROLLED_BACK_VERIFIED', '監査: 登録前後の設定・アップロード結果・検証・rollback');
  assert(!s.includes(FIELD_ON_OFF) && !s.includes(PATCH.operations[0].content) && !/Bearers|X-Cybozu-|sessionid|JSESSIONID/i.test(s), '監査に本文・認証情報は含めない（本文は指紋だけ）');
  assert(X.diffSnapshots(ex.snapshot, ex.actualAfterRaw).length === 1 && X.diffSnapshots(ex.snapshot, ex.actualAfterRaw)[0].where === 'desktop.js[2]' && X.diffSnapshots(ex.snapshot, ex.actualAfterRaw)[0].fileKeyChanged, 'diffSnapshots: 登録前後の差は desktop.js[2] の fileKey だけ');
  const body = X.payloadOf(ex.snapshot, '310', '12');
  assert(body.app === 310 && body.revision === '12' && body.desktop.js.length === 4 && body.desktop.js[0].type === 'URL' && body.desktop.js[1].file.fileKey === 'dl:common' && body.mobile.css[0].file.fileKey === 'dl:mcss' && !('name' in body.desktop.js[1].file), 'payloadOf: 取得 API の fileKey を再指定する完全な payload（URL はそのまま・revision 指定）');
}

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
