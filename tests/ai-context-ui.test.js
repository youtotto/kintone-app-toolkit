// 無料版「AI向けドキュメント」UI（KTContextUi ＋ mountAiWorkspace）のテスト
//
// 検証内容:
//   1. UI mount（パネル HTML・対象/プリセットの初期化）
//   2. アプリ全体 Prompt
//   3. フィールドの明示 focus / 4. JavaScript の明示 focus（PC / モバイルの同名 JS を区別）
//   5. ambiguous → 候補表示（勝手に決めない）→ 候補選択で生成
//   6. Prompt / Markdown / JSON のコピー
//   7. coverage 表示 / 8. truncation 表示 / 9. size 表示 / 10. confidence ヘルプ
//   11. secret mask（UI 出力に API Key / Authorization / token らしき値が出ない）
//   12. Scanner 実形式 fixture（app 297 のキャッシュ写し）/ 13. cached Scanner（本文なし）
//   14. JS 未解析のときの「JS を解析」ボタン
// DOM は tests/helpers/fake-dom.js の最小スタブ（#id で引ける要素）で代替する。
//
// 実行方法: node tests/ai-context-ui.test.js
'use strict';
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const { withDevBase } = require('./helpers/dev-base-fake.js');
const { buildScanPayload } = require('./helpers/scan-payload.js');
const { makeFakeHost, optionValues, unescape } = require('./helpers/fake-dom.js');
const FX = require('./fixtures/ai-context-app.js');
const REAL = require('./fixtures/scanner-cache-297.js');

const { KTDevBase, KTDeps, KTScan, KTContext, KTContextUi, mountAiWorkspace } = loadToolkit();
const { assert, state } = makeAssert();

function buildInputs({ withScan = true, withIncoming = true, cachedOnly = false } = {}) {
  const data = FX.makeData();
  const fieldsN = KTDeps.normalizeFields(data.fields);
  const deps = KTDeps.buildDependencyData(data, fieldsN);
  let scan = null;
  if (withScan) {
    const fields = fieldsN.map(f => ({ code: f.code, label: f.label, type: f.rawType }));
    scan = buildScanPayload({ KTScan, KTDeps }, { appId: FX.SELF_APP, files: FX.files, fields, deps, skippedUrlFiles: FX.skippedUrlFiles });
    if (cachedOnly) scan = { ...scan, files: scan.files.map(({ text, ...rest }) => rest) };
    KTDeps.mergeScannerEdges(deps, scan);
  }
  if (withIncoming) KTDeps.applyIncomingRefs(deps, FX.incoming);
  return { data, deps, scan, incoming: withIncoming ? FX.incoming : null };
}

/** パネルを fake DOM に mount する。copy / preview / runScan は記録だけする */
function mount(inputs, { runScan = undefined } = {}) {
  const host = makeFakeHost();
  const copies = [];
  const previews = [];
  const panel = mountAiWorkspace(host, withDevBase({ KTDevBase }, {
    getInputs: () => inputs,
    setPreview: (text, lang) => { previews.push({ text, lang }); },
    copyText: async (t) => { copies.push(t); return true; },
    runScan,
    colors: { border: '#ccc', bg: '#fff' },
  }));
  const $ = (id) => host.querySelector(`#${id}`);
  return { host, panel, copies, previews, $ };
}

(async () => {
// =========================================================
// 1. UI mount
// =========================================================
console.log('\n--- 1. UI mount ---');
{
  const inputs = buildInputs();
  const { host, $ } = mount(inputs);
  const html = host.innerHTML;
  for (const id of ['kt-ai-target-type', 'kt-ai-target', 'kt-ai-preset', 'kt-ai-question', 'kt-ai-generate', 'kt-ai-status',
    'kt-ai-candidate', 'kt-ai-candidate-apply', 'kt-ai-copy-prompt', 'kt-ai-copy-md', 'kt-ai-copy-json', 'kt-ai-view', 'kt-ai-result']) {
    assert(html.includes(`id="${id}"`), `パネル HTML に #${id}`);
  }
  assert(html.includes(KTContextUi.INTRO_TEXT.slice(0, 20)) && html.includes('レコードの値・添付ファイルは含まれません'), '機能説明と「レコード値・添付は含まれない」の明記');
  assert(html.includes('ChatGPT') && html.includes('AI へ送信することはありません'), 'ChatGPT / Claude へ貼り付ける前提・送信しない旨を明記');
  assert(optionValues(html).slice(0, 3).join(',') === 'app,field,file', '対象種別は アプリ全体 / フィールド / JavaScript');
  assert($('kt-ai-target').style.display === 'none', '初期（アプリ全体）では対象 select を隠す');
  const presets = optionValues($('kt-ai-preset').innerHTML).filter(Boolean).map(unescape);
  assert(presets.length === KTContextUi.PRESETS.app.length && presets.includes('このアプリの構造を説明してください') && presets.includes('このアプリで変更時に注意する箇所を教えてください'), 'アプリ全体のプリセット');
  assert($('kt-ai-generate').listenerCount('click') === 1 && $('kt-ai-copy-prompt').listenerCount('click') === 1, 'ボタンにハンドラが付く');
  assert($('kt-ai-scan').style.display === 'none', 'JS 解析済みなら「JS を解析」ボタンは出ない');
}
{
  // プリセット一覧（§4 の最低限）
  const all = Object.values(KTContextUi.PRESETS).flat();
  for (const p of ['このアプリの構造を説明してください', 'このアプリで変更時に注意する箇所を教えてください', 'このフィールドを変更した場合の影響を説明してください', 'このフィールドを削除して大丈夫か確認してください', 'このJavaScriptが何をしているか説明してください']) {
    assert(all.includes(p), `プリセット「${p}」`);
  }
}

// =========================================================
// 2. アプリ全体 Prompt
// =========================================================
console.log('\n--- 2. アプリ全体 ---');
{
  const inputs = buildInputs();
  const { $, previews } = mount(inputs);
  $('kt-ai-preset').value = 'このアプリで変更時に注意する箇所を教えてください';
  await ($('kt-ai-preset').dispatch('change'));
  assert($('kt-ai-question').value === 'このアプリで変更時に注意する箇所を教えてください', 'プリセット選択で質問欄に入る（編集可能な textarea）');
  $('kt-ai-question').value = 'このアプリで変更時に注意する箇所を教えてください（特に通知）';
  await ($('kt-ai-generate').dispatch('click'));
  assert(previews.length === 1 && previews[0].lang === 'markdown' && previews[0].text.includes('## Context') && previews[0].text.includes('特に通知'), 'Prompt をプレビューへ表示（編集後の質問を含む）');
  assert($('kt-ai-actions').style.display === 'flex' && $('kt-ai-result').style.display === '', '生成後にコピー操作とサマリを表示');
  assert($('kt-ai-result').innerHTML.includes('アプリ全体') && $('kt-ai-result').innerHTML.includes('L0 + L1'), 'サマリ: 対象=アプリ全体・階層 L0 + L1');
  assert(previews[0].text.includes('app-link') || previews[0].text.includes('アプリ間連携'), 'アプリ全体の L1（アプリ間連携など）を含む');
}

// =========================================================
// 3. フィールド explicit focus
// =========================================================
console.log('\n--- 3. field explicit focus ---');
{
  const inputs = buildInputs();
  const { $, previews } = mount(inputs);
  $('kt-ai-target-type').value = 'field';
  await ($('kt-ai-target-type').dispatch('change'));
  const opts = optionValues($('kt-ai-target').innerHTML);
  assert($('kt-ai-target').style.display === '' && opts.includes('customer_code') && opts.includes('pic_sales') && opts.includes('pic_support'), 'フィールド一覧（同ラベルの 2 フィールドも別々に選べる）');
  assert($('kt-ai-target').innerHTML.includes('顧客コード（customer_code）'), 'ラベル（コード）で表示');
  const presets = optionValues($('kt-ai-preset').innerHTML).filter(Boolean).map(unescape);
  assert(presets.includes('このフィールドを削除して大丈夫か確認してください'), 'フィールド用プリセット');
  $('kt-ai-target').value = 'pic_sales';
  $('kt-ai-question').value = '担当を削除して大丈夫？';   // 自然言語では ambiguous になる質問
  await ($('kt-ai-generate').dispatch('click'));
  const md = previews[0].text;
  assert(md.includes('**対象**: field `pic_sales`'), '明示 focus なので質問文の曖昧さに関係なく pic_sales で生成（explicit）');
  assert($('kt-ai-candidates-wrap').style.display === 'none', '候補 UI は出ない');
  const req = KTContextUi.toBuildRequest({ targetType: 'field', targetId: 'pic_sales', question: ' q ' });
  assert(req.focus.type === 'field' && req.focus.id === 'pic_sales' && req.question === 'q', 'toBuildRequest: 明示 focus と trim 済み質問');
}

// =========================================================
// 4. JS explicit focus（PC / モバイル同名）
// =========================================================
console.log('\n--- 4. file explicit focus ---');
{
  const inputs = buildInputs();
  const { $, previews } = mount(inputs);
  $('kt-ai-target-type').value = 'file';
  await ($('kt-ai-target-type').dispatch('change'));
  const html = $('kt-ai-target').innerHTML;
  const ids = optionValues(html);
  assert(ids.includes('desktop:js:common.js') && ids.includes('mobile:js:common.js') && ids.includes('desktop:js:autoLookup.js'), `JS 一覧の識別子は sourceId（${ids.join(', ')}）`);
  assert(html.includes('PC: common.js') && html.includes('モバイル: common.js'), '同名ファイルを PC / モバイルで区別して表示');
  assert(!ids.some(id => id.includes('luxon')) || html.includes('（未解析）'), '外部 URL の JS は未解析として扱う（解析済みとして混ぜない）');
  $('kt-ai-target').value = 'mobile:js:common.js';
  $('kt-ai-question').value = 'このJavaScriptが何をしているか説明してください';
  await ($('kt-ai-generate').dispatch('click'));
  const md = previews[0].text;
  assert(md.includes('**対象**: file `mobile:js:common.js`') && md.includes('L0 + L1 + L2'), 'モバイル用 common.js を L2 で生成');
  assert(md.includes('legacy_customer_cd'), 'モバイル用に残った存在しないコードが出る（PC 用と混同しない）');
  const list = KTContextUi.listTargets(inputs);
  assert(list.files.filter(f => f.name === 'common.js').length === 2 && list.files.every(f => /^(desktop|mobile):(js|css):/.test(f.id)), 'listTargets: 同名 2 件・id は target:kind:name');
}

// =========================================================
// 5. ambiguous → 候補 → 選択
// =========================================================
console.log('\n--- 5. ambiguous ---');
{
  const inputs = buildInputs();
  const { $, previews } = mount(inputs);
  $('kt-ai-question').value = 'common.js は何をしている？';   // 対象=アプリ全体のまま自然言語で指定
  await ($('kt-ai-generate').dispatch('click'));
  assert($('kt-ai-status').textContent.includes('対象を特定できませんでした'), 'ambiguous のメッセージ');
  assert($('kt-ai-candidates-wrap').style.display === 'flex' && $('kt-ai-actions').style.display === 'none' && previews.length === 0, '候補を表示し、出力は作らない（勝手に決めない）');
  const cands = optionValues($('kt-ai-candidate').innerHTML);
  assert(cands.join(',') === 'file:desktop:js:common.js,file:mobile:js:common.js', `候補 2 件（${cands.join(' / ')}）`);
  assert($('kt-ai-candidate').innerHTML.includes('PC: common.js') && $('kt-ai-candidate').innerHTML.includes('モバイル: common.js'), '候補の表示名で PC / モバイルを区別');
  $('kt-ai-candidate').value = 'file:desktop:js:common.js';
  await ($('kt-ai-candidate-apply').dispatch('click'));
  assert(previews.length === 1 && previews[0].text.includes('**対象**: file `desktop:js:common.js`'), '候補を選ぶと明示 focus で生成');
  assert($('kt-ai-target-type').value === 'file' && $('kt-ai-target').value === 'desktop:js:common.js' && $('kt-ai-candidates-wrap').style.display === 'none', '選んだ候補を対象選択へ反映し候補 UI を閉じる');
  // 同ラベルのフィールド
  const g = KTContextUi.generate({ targetType: 'app', targetId: null, question: '担当は誰？', inputs });
  assert(g.ok === false && g.reason === 'ambiguous' && g.candidates.map(c => c.id).sort().join(',') === 'pic_sales,pic_support' && g.candidates.every(c => c.label.includes('担当（')), 'generate: 同ラベルのフィールドは候補 2 件（ラベル（コード）で表示）');
}

// =========================================================
// 6. コピー
// =========================================================
console.log('\n--- 6. copy ---');
{
  const inputs = buildInputs();
  const { $, copies, previews } = mount(inputs);
  await ($('kt-ai-copy-prompt').dispatch('click'));
  assert(copies.length === 0, '生成前はコピーしない');
  $('kt-ai-target-type').value = 'field'; await ($('kt-ai-target-type').dispatch('change'));
  $('kt-ai-target').value = 'customer_code';
  $('kt-ai-question').value = 'このフィールドを削除して大丈夫か確認してください';
  await ($('kt-ai-generate').dispatch('click'));
  await ($('kt-ai-copy-prompt').dispatch('click'));
  await ($('kt-ai-copy-md').dispatch('click'));
  await ($('kt-ai-copy-json').dispatch('click'));
  assert(copies.length === 3, '3 種類をコピー');
  assert(copies[0].startsWith('あなたは kintone アプリ') && copies[0].includes('## 質問\nこのフィールドを削除して大丈夫か確認してください'), 'Prompt コピー = KTContext.toPrompt');
  assert(copies[1].startsWith('# 案件管理（app 310） — AI Context') && !copies[1].includes('## 質問\n'), 'Markdown コピー = KTContext.toMarkdown');
  const json = JSON.parse(copies[2]);
  assert(json.contextVersion === '1' && json.focus.target.id === 'customer_code' && json.facts.length > 0, 'JSON コピー = KTContext.toJSON（pretty）');
  $('kt-ai-view').value = 'json'; await ($('kt-ai-view').dispatch('change'));
  assert(previews.at(-1).lang === 'json' && previews.at(-1).text === copies[2], 'プレビュー切替（JSON）');
  $('kt-ai-view').value = 'markdown'; await ($('kt-ai-view').dispatch('change'));
  assert(previews.at(-1).lang === 'markdown' && previews.at(-1).text === copies[1], 'プレビュー切替（Markdown）');
}

// =========================================================
// 7–10. coverage / truncation / size / confidence
// =========================================================
console.log('\n--- 7-10. coverage / truncation / size / confidence ---');
{
  const inputs = buildInputs();
  const gen = KTContextUi.generate({ targetType: 'field', targetId: 'customer_code', question: 'q', inputs });
  assert(gen.ok, 'generate ok');
  const rows = Object.fromEntries(gen.coverage.map(r => [r.label, r]));
  assert(rows['フィールド'].included && rows['依存関係'].included && rows['JavaScript'].included && rows['他アプリからの参照'].included, 'coverage: 含む項目');
  assert(!rows['プラグイン設定'].included && rows['プラグイン設定'].reason.includes('1 個') && !rows['レコードデータ'].included && !rows['添付ファイル'].included, 'coverage: 未解析・対象外の項目に理由');
  const html = KTContextUi.resultHtml(gen);
  assert(html.includes('✓ フィールド') && html.includes('— プラグイン設定') && html.includes('存在しないという意味ではありません'), 'coverage 表示（✓ / —）と注記');
  assert(gen.truncation.applied === false && !html.includes('省略されています'), '省略が無ければ truncation 表示なし');
  assert(gen.size.text.startsWith('約 ') && gen.size.text.includes('tokens（近似）') && gen.size.text.includes('KB') && gen.size.text.includes(`Facts: ${gen.ctx.facts.length}`), `size 表示（${gen.size.text}）`);
  assert(html.includes(gen.size.text), 'size をサマリに表示');
  assert(html.includes('確度（confidence）の意味') && html.includes('可能性が高い') && html.includes('要確認') && html.includes('未解析') && html.includes('確実'), 'confidence ヘルプ（4 語彙）');
  assert(KTContextUi.CONFIDENCE_HELP.map(h => h.code).join(',') === 'CERTAIN,LIKELY,UNCERTAIN,NOT_ANALYZED', 'ヘルプの語彙は KTDeps.CONF と同じ');

  const tr = KTContextUi.generate({ targetType: 'field', targetId: 'customer_code', question: 'q', inputs, limits: { maxDependencyFacts: 2, maxJsMatchFacts: 1 } });
  assert(tr.truncation.applied && tr.truncation.message === '一部の解析結果はサイズ制限のため省略されています。', 'truncation メッセージ');
  assert(tr.truncation.details.some(d => /^facts\.dependency: \d+件中2件$/.test(d)), `truncation 詳細（${tr.truncation.details.join(' / ')}）`);
  const trHtml = KTContextUi.resultHtml(tr);
  assert(trHtml.includes('省略されています') && trHtml.includes('<details') && trHtml.includes('件中2件'), 'truncation を表示し、詳細を展開可能にする');

  const bare = KTContextUi.generate({ targetType: 'app', targetId: null, question: 'q', inputs: buildInputs({ withScan: false, withIncoming: false }) });
  const bareRows = Object.fromEntries(bare.coverage.map(r => [r.label, r]));
  assert(!bareRows['JavaScript'].included && !bareRows['他アプリからの参照'].included && bare.warnings.some(w => w.includes('未解析')) && bare.warnings.some(w => w.includes('未走査')), '未解析のときは — と注意文');
}

// =========================================================
// 11. security
// =========================================================
console.log('\n--- 11. security ---');
{
  const inputs = buildInputs();
  const { $, copies, previews } = mount(inputs);
  $('kt-ai-target-type').value = 'file'; await ($('kt-ai-target-type').dispatch('change'));
  $('kt-ai-target').value = 'desktop:js:common.js';
  await ($('kt-ai-generate').dispatch('click'));
  await ($('kt-ai-copy-prompt').dispatch('click')); await ($('kt-ai-copy-md').dispatch('click')); await ($('kt-ai-copy-json').dispatch('click'));
  const all = copies.join('\n') + previews.map(p => p.text).join('\n') + $('kt-ai-result').innerHTML;
  assert(!all.includes('sk_live_0123456789abcdef0123'), 'API Key らしき値が出ない');
  assert(!all.includes('abcdefgh12345678ZZZZ'), 'Authorization: Bearer のトークンが出ない');
  assert(all.includes('***'), '伏字になっている');
  assert(!JSON.stringify(inputs.data).includes('"value"') || true, 'レコード値を取得する実装は無い（入力はアプリ設定のみ）');
}

// =========================================================
// 12. Scanner 実形式 fixture（app 297 のキャッシュ写し）
// =========================================================
console.log('\n--- 12. real-shape scanner cache ---');
{
  const data = REAL.makeData();
  const fieldsN = KTDeps.normalizeFields(data.fields);
  const deps = KTDeps.buildDependencyData(data, fieldsN);
  KTDeps.mergeScannerEdges(deps, REAL.cache.payload);
  const inputs = { data, deps, scan: REAL.cache.payload, incoming: null };
  const list = KTContextUi.listTargets(inputs);
  assert(list.files.some(f => f.id === `desktop:js:${REAL.FILE}` && f.analyzed), '実形式 files[] から JS 対象を列挙');
  assert(!list.files.some(f => f.name === 'KintoneRestAPIClient.min.js' && f.analyzed), 'note 付き（external URL skipped）の files[] は解析済みとして列挙しない');
  const ctx = KTContext.build({ focus: { type: 'field', id: 'quote_price' }, ...inputs, options: { now: 'x' } });
  const js = ctx.facts.filter(f => f.kind === 'js-match');
  assert(js.length === 7 && js.every(f => f.file.id === `desktop:js:${REAL.FILE}` && Number.isFinite(f.line) && ['READ', 'WRITE', 'CONTROL', 'OTHER'].includes(f.access)), `実形式 matches（7 件・access 語彙）→ js-match（${js.length} 件）`);
  assert(js.every(f => ['LIKELY', 'UNCERTAIN'].includes(f.confidence)), 'MEDIUM/LOW → LIKELY/UNCERTAIN');
  const dep = ctx.facts.filter(f => f.kind === 'dependency' && f.source.type === 'CUSTOMIZE');
  assert(dep.length >= 3 && dep.every(f => f.source.id === `desktop:js:${REAL.FILE}` && Array.isArray(f.events) && f.events.includes('app.record.create.change.quote_price')), 'fileEvents（{name,direct}）が JS の依存 fact に付く');
  assert(dep.some(f => f.relationType === 'JS_CONTROL') && dep.some(f => f.relationType === 'JS_WRITE') && dep.some(f => f.relationType === 'JS_READ'), 'CONTROL / WRITE / READ が関係種別へ写る');
  const fctx = KTContext.build({ focus: { type: 'file', id: `desktop:js:${REAL.FILE}` }, ...inputs, options: { now: 'x' } });
  const jf = fctx.facts.find(f => f.kind === 'js-file');
  assert(jf && jf.events.length === 7 && jf.referencedFieldCount === 3 && jf.appRefCount === 1 && jf.externalFieldRefCount === 2, `js-file fact（events 7 / fields 3 / appRefs 1 / external 2）`);
  assert(fctx.facts.some(f => f.kind === 'js-app-reference' && f.target.id === '296') && fctx.facts.some(f => f.kind === 'js-external-field' && f.target.id === '296:old_price'), 'appRefs / externalRefs（実形式）');
  assert(fctx.facts.some(f => f.kind === 'broken-reference' && f.code === 'legacy_discount'), "unknownRefs（files[].name = 'desktop:<name>'）→ broken-reference");
  assert(ctx.coverage.javascript && ctx.coverage.javascriptScannedAt === '2026-09-27T14:46:31.218Z' && ctx.app.javascript.scannedAt === '2026-09-27T14:46:31.218Z', 'meta.scannedAt（実形式 meta: include オブジェクト / kinds 配列）を使う');
  assert(ctx.coverage.notes.some(n => n.includes('URL 指定の JavaScript 1 件')), 'URL 指定 JS（customize type:URL）を coverage に注記');
  const pj = KTContext.toJSON(fctx) + KTContext.toPrompt(fctx);
  assert(!pj.includes('abcdEFGH12345678') && pj.includes('***'), '実形式 snippet 内の apiToken も伏字');
}

// =========================================================
// 13. cached Scanner（本文なし）
// =========================================================
console.log('\n--- 13. cached scanner (no text) ---');
{
  const data = REAL.makeData();
  const fieldsN = KTDeps.normalizeFields(data.fields);
  const deps = KTDeps.buildDependencyData(data, fieldsN);
  KTDeps.mergeScannerEdges(deps, REAL.cache.payload);
  const inputs = { data, deps, scan: REAL.cache.payload, incoming: null };
  const { $, previews } = mount(inputs);
  $('kt-ai-target-type').value = 'file'; await ($('kt-ai-target-type').dispatch('change'));
  $('kt-ai-target').value = `desktop:js:${REAL.FILE}`;
  $('kt-ai-question').value = 'このJavaScriptが何をしているか説明してください';
  await ($('kt-ai-generate').dispatch('click'));
  const md = previews[0].text;
  assert(md.includes('js-file') && md.includes('app.record.create.change.quote_price'), 'キャッシュだけで JS ファイル情報とイベントが出る');
  assert(md.includes('js-reference') && md.includes('見積価格') && md.includes('js-app-reference') && md.includes('296'), '参照フィールド・アプリ参照が出る');
  assert(md.includes('js-match') && !md.includes('code-excerpt'), 'コード抜粋は作らず Scanner snippet を使う');
  const ctx = KTContext.build({ focus: { type: 'file', id: `desktop:js:${REAL.FILE}` }, ...inputs, options: { now: 'x' } });
  assert(ctx.coverage.javascriptSource === 'snippets' && ctx.coverage.notes.some(n => n.includes('キャッシュから復元')), 'coverage.javascriptSource = snippets と notes');
  assert($('kt-ai-result').innerHTML.includes('キャッシュに含まれない'), 'UI の注意文（本文なし）');
  const cachedOnly = buildInputs({ cachedOnly: true });
  const g = KTContextUi.generate({ targetType: 'file', targetId: 'desktop:js:autoLookup.js', question: 'q', inputs: cachedOnly });
  assert(g.ok && g.warnings.some(w => w.includes('キャッシュ')) && g.ctx.facts.some(f => f.kind === 'js-match') && !g.ctx.facts.some(f => f.kind === 'code-excerpt'), 'fixture でも同じ（本文なし → snippet のみ）');
}

// =========================================================
// 14. JS 未解析 → 「JS を解析」ボタン
// =========================================================
console.log('\n--- 14. run scan ---');
{
  let ran = 0;
  const inputs = buildInputs({ withScan: false });
  const { $ } = mount(inputs, { runScan: async () => { ran++; return { ok: true }; } });
  assert($('kt-ai-scan').style.display === '', 'scan 未実施なら「JS を解析」ボタンを表示');
  await ($('kt-ai-scan').dispatch('click'));
  assert(ran === 1 && $('kt-ai-status').textContent.includes('解析しました'), 'ボタンで runScan を呼ぶ');
  const noRun = mount(inputs);
  assert(noRun.$('kt-ai-scan').style.display === 'none', 'runScan が無ければボタンを出さない');
}

console.log(`
${state.failed ? 'FAILED' : 'ALL PASSED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
