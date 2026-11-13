// KTContext のサイズ計測（§19）
//
// 150 / 400 フィールド程度の生成データで、
//   full DEPS（KTDeps.toJSON）／ L0（App Overview）／ field focused L1（＋JS 解析あり）
// の JSON byte・文字数・token 近似を比較し、Context Builder による削減量を出す。
// あわせて目標（L0 ≒ 1〜2k tokens / L1 ≒ 5〜12k tokens / L2 < 20k tokens）に収まることを確認する。
//
// 実行方法: node tests/ai-context-size.test.js（終了コード 0 = 成功、1 = 失敗）
'use strict';
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const { buildScanPayload } = require('./helpers/scan-payload.js');

const { KTDeps, KTScan, KTContext } = loadToolkit();
const { assert, state } = makeAssert();
const NOW = '2026-10-01T00:00:00.000Z';

/** N フィールドのアプリ設定（prefetchAppData の戻り値と同じ形）を生成する */
function generateApp(n, appId) {
  const fields = {};
  const sys = (type, code) => ({ type, code, label: code, noLabel: false });
  Object.assign(fields, {
    'レコード番号': sys('RECORD_NUMBER', 'レコード番号'), '作成者': sys('CREATOR', '作成者'), '更新者': sys('MODIFIER', '更新者'),
    'ステータス': { type: 'STATUS', code: 'ステータス', label: 'ステータス', enabled: true },
  });
  const types = ['SINGLE_LINE_TEXT', 'NUMBER', 'DATE', 'DROP_DOWN', 'USER_SELECT', 'MULTI_LINE_TEXT', 'CHECK_BOX'];
  const codes = [];
  for (let i = 0; i < n; i++) {
    const code = `field_${String(i).padStart(3, '0')}`;
    const type = types[i % types.length];
    fields[code] = { type, code, label: `項目${i}（${type === 'NUMBER' ? '金額' : type === 'DATE' ? '日付' : '文字'}）`, noLabel: false, required: i % 9 === 0, unique: i % 17 === 0 };
    if (type === 'DROP_DOWN' || type === 'CHECK_BOX') fields[code].options = { A: { label: 'A', index: '0' }, B: { label: 'B', index: '1' } };
    codes.push(code);
  }
  // 計算式（NUMBER を参照するチェーン）
  const numbers = codes.filter(c => fields[c].type === 'NUMBER');
  for (let i = 0; i + 1 < numbers.length && i < Math.floor(n / 10); i += 2) {
    const code = `calc_${i}`;
    fields[code] = { type: 'CALC', code, label: `計算${i}`, expression: `${numbers[i]} + ${numbers[i + 1]}`, noLabel: false };
    codes.push(code);
  }
  // ルックアップ・関連レコード
  fields.customer_lookup = { type: 'SINGLE_LINE_TEXT', code: 'customer_lookup', label: '顧客参照', noLabel: false,
    lookup: { relatedApp: { app: '900' }, relatedKeyField: 'code', fieldMappings: codes.slice(0, 5).map((c, i) => ({ field: c, relatedField: `src_${i}` })) } };
  fields.quotes = { type: 'REFERENCE_TABLE', code: 'quotes', label: '見積一覧', noLabel: false,
    referenceTable: { relatedApp: { app: '901' }, condition: { field: codes[0], relatedField: 'customer' }, displayFields: ['a', 'b'] } };
  // 一覧（各 20 フィールド表示・条件・ソート）
  const views = {};
  const viewCount = Math.max(5, Math.floor(n / 15));
  for (let v = 0; v < viewCount; v++) {
    const start = (v * 7) % codes.length;
    const shown = codes.slice(start, start + 20);
    views[`一覧${v}`] = { id: String(100 + v), name: `一覧${v}`, type: 'LIST', fields: shown,
      filterCond: `${codes[0]} = "x" and ${codes[(v + 1) % codes.length]} != ""`, sort: `${codes[0]} asc, ${codes[(v + 2) % codes.length]} desc` };
  }
  // 通知・プロセス・ACL（先頭フィールドを多用する＝field focus の L1 を重くする）
  const entity = (code) => ({ entity: { type: 'FIELD_ENTITY', code } });
  const perRecord = { notifications: Array.from({ length: Math.max(3, Math.floor(n / 30)) }, (_, i) => ({
    title: `通知${i}`, filterCond: `${codes[0]} = "x" and ${codes[i % codes.length]} != ""`,
    targets: [entity(codes[4]), { entity: { type: 'USER', code: 'u' } }],
  })) };
  const status = { enable: true, states: { '未処理': { name: '未処理', index: '0', assignee: { type: 'ONE', entities: [entity(codes[4])] } }, '完了': { name: '完了', index: '1', assignee: { type: 'ONE', entities: [] } } },
    actions: [{ name: '完了する', from: '未処理', to: '完了', filterCond: `${codes[0]} != ""` }] };
  const recordAcl = { rights: Array.from({ length: 4 }, (_, i) => ({ filterCond: `${codes[0]} = "r${i}"`, entities: [entity(codes[4])] })) };
  const fieldAcl = { rights: [{ code: codes[0], entities: [entity(codes[4])] }] };
  const customize = { scope: 'ALL',
    desktop: { js: [{ type: 'FILE', file: { name: 'common.js', fileKey: 'k1' } }, { type: 'FILE', file: { name: 'detail.js', fileKey: 'k2' } }], css: [] },
    mobile: { js: [{ type: 'FILE', file: { name: 'common.js', fileKey: 'k3' } }], css: [] } };
  return { appId, fields, layout: [], settings: { name: `生成アプリ${n}` }, views: { views }, reports: { reports: {} },
    perRecordNotify: perRecord, generalNotify: { notifications: [] }, reminderNotify: { notifications: [] },
    status, recordAcl, fieldAcl, appAcl: { rights: [] }, actions: { actions: {} }, customize, appPlugins: { plugins: [] } };
}

/** JS 本文: 先頭 60 フィールドを読み書きする（JS からの参照を多数作る） */
function generateJs(codes, prefix) {
  const lines = ["(function () {", "  'use strict';", `  kintone.events.on('${prefix}app.record.edit.show', (event) => {`];
  for (const c of codes.slice(0, 60)) lines.push(`    const v_${c} = event.record['${c}'].value;`);
  for (const c of codes.slice(0, 20)) lines.push(`    event.record['${c}'].value = v_${c};`);
  lines.push('    return event;', '  });', '})();');
  return lines.join('\n');
}

function measureAll(n) {
  const data = generateApp(n, 7000 + n);
  const fieldsN = KTDeps.normalizeFields(data.fields);
  const deps = KTDeps.buildDependencyData(data, fieldsN);
  const codes = fieldsN.map(f => f.code);
  const files = [
    { name: 'common.js', target: 'desktop', kind: 'js', text: generateJs(codes, '') },
    { name: 'detail.js', target: 'desktop', kind: 'js', text: generateJs(codes.slice(10), '') },
    { name: 'common.js', target: 'mobile', kind: 'js', text: generateJs(codes, 'mobile.') },
  ];
  const scan = buildScanPayload({ KTScan, KTDeps }, { appId: data.appId, files, fields: fieldsN.map(f => ({ code: f.code, label: f.label, type: f.rawType })), deps });
  KTDeps.mergeScannerEdges(deps, scan);

  const full = KTContext.measureText(KTDeps.toJSON(deps));
  const l0 = KTContext.build({ data, deps, scan, options: { now: NOW } });
  const l1 = KTContext.build({ question: 'field_000 を削除して大丈夫？', data, deps, scan, options: { now: NOW } });
  const l1Loose = KTContext.build({ question: 'field_000 を削除して大丈夫？', data, deps, scan, options: { now: NOW, limits: { maxDependencyFacts: 10000, maxJsMatchFacts: 10000, maxFacts: 10000 } } });
  const l2 = KTContext.build({ focus: { type: 'file', id: 'desktop:js:common.js' }, data, deps, scan, options: { now: NOW } });
  // 2026-10-05: 通知の相談（関連設定の詳細・関係する JS）。フィールドの名前と一緒の通知の相談も（以前は上限が無く、通知の多いアプリで Gateway の 256 KiB を超えた）
  const notify = KTContext.build({ question: '承認漏れを防ぐ通知は足りている？', data, deps, scan, options: { now: NOW } });
  const notifyField = KTContext.build({ question: 'field_000 の通知を見直したい', data, deps, scan, options: { now: NOW } });
  const l1Md = KTContext.measureText(KTContext.toMarkdown(l1));
  const l1Prompt = KTContext.measureText(KTContext.toPrompt(l1));
  return { n, fieldCount: fieldsN.length, edgeCount: deps.edges.length, full, l0, l1, l1Loose, l2, l1Md, l1Prompt, notify, notifyField };
}

const fmt = (m) => `${String(m.bytes).padStart(9)} bytes ${String(m.chars).padStart(8)} chars ${String(m.approxTokens).padStart(7)} tokens`;
const pct = (a, b) => `${(100 * (1 - a / b)).toFixed(1)}% 削減`;

for (const n of [150, 400]) {
  const r = measureAll(n);
  console.log(`\n=== ${n} フィールド生成アプリ（実フィールド数 ${r.fieldCount} / 依存関係 ${r.edgeCount} 件）===`);
  console.log(`  full DEPS JSON        : ${fmt(r.full)}`);
  console.log(`  L0 App Overview       : ${fmt(r.l0.size)}  （${pct(r.l0.size.bytes, r.full.bytes)}）`);
  console.log(`  L1 field focus（既定）: ${fmt(r.l1.size)}  （${pct(r.l1.size.bytes, r.full.bytes)}） facts=${r.l1.facts.length} truncation=${JSON.stringify(r.l1.truncation.sections.map(s => `${s.name}:${s.included}/${s.total}`))}`);
  console.log(`  L1 field focus（無制限）: ${fmt(r.l1Loose.size)}  facts=${r.l1Loose.facts.length}`);
  console.log(`  L2 file focus（既定） : ${fmt(r.l2.size)}  facts=${r.l2.facts.length}`);
  console.log(`  L1 Markdown           : ${fmt(r.l1Md)}`);
  console.log(`  L1 Prompt             : ${fmt(r.l1Prompt)}`);

  assert(r.l0.size.approxTokens <= 2000, `[${n}] L0 は 2k tokens 以内（approx ${r.l0.size.approxTokens}）`);
  // 2026-10-05: JavaScript からの依存関係の fact に確かめ方（basis: code）を付けた分（400 フィールドで約 15 tokens）を見込み、目安の上限を 12.1k にした（目安は L1 ≒ 5〜12k）
  assert(r.l1.size.approxTokens <= 12100, `[${n}] L1（既定）は 12.1k tokens 以内（approx ${r.l1.size.approxTokens}）`);
  assert(r.l2.size.approxTokens <= 20000, `[${n}] L2（既定）は 20k tokens 以内（approx ${r.l2.size.approxTokens}）`);
  console.log(`  通知の相談            : ${fmt(r.notify.size)}  facts=${r.notify.facts.length}`);
  console.log(`  通知の相談（フィールド）: ${fmt(r.notifyField.size)}  facts=${r.notifyField.facts.length}`);
  assert(r.notify.size.bytes <= 64 * 1024 && r.notifyField.size.bytes <= 64 * 1024 && r.notify.facts.some(f => f.kind === 'overview') && r.notifyField.facts.some(f => f.kind === 'overview'), `[${n}] 通知の相談は 64 KiB 以内・概要は残る（${r.notify.size.bytes} / ${r.notifyField.size.bytes} bytes）`);
  assert(r.l1.size.bytes < r.full.bytes * 0.5, `[${n}] L1 は full DEPS の半分未満（${pct(r.l1.size.bytes, r.full.bytes)}）`);
  assert(r.l0.truncation.sections.some(s => s.name === 'app.fields' && s.total === r.fieldCount), `[${n}] L0 のフィールド一覧省略が記録される（全 ${r.fieldCount} 件）`);
  assert(r.l1Loose.facts.length >= r.l1.facts.length && (r.l1Loose.facts.length === r.l1.facts.length || r.l1.truncation.applied), `[${n}] 既定上限で省いた分は truncation に記録される`);
  assert(r.l1.focus.target && r.l1.focus.target.id === 'field_000', `[${n}] 生成データでも対象解決が機能する`);
}

console.log(`\n${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
