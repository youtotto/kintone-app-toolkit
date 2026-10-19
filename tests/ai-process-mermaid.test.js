// プロセス図（Mermaid）の構文と描画の回帰テスト（2026-10-04・実機の App 349 で発見）
//
// 検証内容:
//   1. 矢印のラベルの構文: 既存のアクションに条件 not in ("") を付ける計画で、検証ペインの After が「Syntax error in text」になった。
//      引用符の無い矢印のラベル（-->|…|）に半角のかっこがあると Mermaid 10.9.8 は構文エラーになる（実機のページの Mermaid で確認）。
//      ノード・矢印のラベルは引用符で囲み、中の " は #quot;、# は #35;、` は #96; にする（KTPlanReview.processMermaid とヘルスタブの図）
//   2. 図の大きさ: 同じ画面で Before の図が 16px に潰れた。描き始めた後（Mermaid の描画を待つ間）にペインが隠れると、
//      ペインの中で測る mermaid.run は大きさを 0 と計算する。mermaid.render（ページの body の一時的な要素で測る）で描き、SVG を枠に入れる。
//      描けなかった図は Mermaid のエラー画像ではなく、理由とコードを出す
//   2026-10-19: 計画のプロセス図は右の「確認結果」のタブ（廃止）から、右の「変更内容」の［プロセス管理の変更前後（図）］の中へ移した（開いたときに描く）
//
// Node では Mermaid を動かせないので、構文エラーの原因（引用符の無いラベル・ラベルの中の生の "）が無いことを行の形で確かめる。
// 実機のページの Mermaid 10.9.8 では、かっこ・[ ]・{ }・|・;・#・%%・矢印の記号など 36 種類を、引用符つきのラベルで描けることを確かめた。
//
// 実行方法: node tests/ai-process-mermaid.test.js（KT_SRC=<別ビルド> で修正前の版に対して走らせると RED になる）
'use strict';
const { loadToolkit, makeAssert } = require('./helpers/load-toolkit.js');
const { withDevBase } = require('./helpers/dev-base-fake.js');
const { makeFakeHost } = require('./helpers/fake-dom.js');
const FX = require('./fixtures/ai-context-app.js');
const { assert, state } = makeAssert();

// 修正前の版（KT_SRC）には無い関数を呼んでも落ちない（失敗として数える）
const safe = (fn, fallback = null) => { try { return fn(); } catch (e) { return fallback; } };
const tick = () => new Promise((r) => setTimeout(r, 0));

// flowchart の行の形: ノードは S<n>["…"]、矢印は S<n> --> / ==> S<n>（ラベルは |"…"|）、強調は linkStyle / style。ラベルの中に生の " は無い
const NODE = /^ {2}S\d+\["[^"]*"\]$/;
const EDGE = /^ {2}S\d+ (?:-->|==>)(?:\|"[^"]*"\|)? S\d+$/;
const DECO = /^ {2}(?:linkStyle \d+ |style S\d+ )/;
const badLines = (code) => String(code || '').split('\n').slice(1).filter((l) => !(NODE.test(l) || EDGE.test(l) || DECO.test(l)));

const T = loadToolkit();
const PR = T.KTPlanReview;

(async () => {
// =========================================================
console.log('\n--- 1. 検証ペインのプロセス図（KTPlanReview.processMermaid）: ラベルを引用符で囲む ---');
// 実機（App 349）の形: 既存の「申請する」の行き先を課長承認待ちに変え、条件 課長承認者 not in ("") and 部長承認者 not in ("") を付ける
const before = {
  states: [{ name: '申請前' }, { name: '承認待ち' }, { name: '承認済み' }],
  actions: [
    { name: '申請する', from: '申請前', to: '承認待ち', filterCond: '' },
    { name: '承認する', from: '承認待ち', to: '承認済み', filterCond: '' },
    { name: '差し戻す', from: '承認待ち', to: '申請前', filterCond: '' },
  ],
};
const after = {
  states: [...before.states, { name: '課長承認待ち', origin: 'proposed' }, { name: '部長承認待ち', origin: 'proposed' }],
  actions: [
    { name: '申請する', from: '申請前', to: '課長承認待ち', filterCond: '課長承認者 not in ("") and 部長承認者 not in ("")' },
    { name: '承認する', from: '承認待ち', to: '承認済み', filterCond: '' },
    { name: '差し戻す', from: '承認待ち', to: '申請前', filterCond: '' },
    { name: '課長が承認する', from: '課長承認待ち', to: '部長承認待ち', filterCond: 'amount >= "1000000"' },
    { name: '部長が承認する', from: '部長承認待ち', to: '承認済み', filterCond: '' },
  ],
};
const codeBefore = safe(() => PR.processMermaid(before), '');
const codeAfter = safe(() => PR.processMermaid(after, before), '');
{
  assert(badLines(codeBefore).length === 0 && /^flowchart LR\n/.test(codeBefore), `Before: ラベルは引用符で囲む: ${JSON.stringify(badLines(codeBefore))}`);
  assert(badLines(codeAfter).length === 0, `After: 引用符の無いラベル（構文エラーの原因）・ラベルの中の生の " が無い: ${JSON.stringify(badLines(codeAfter))}`);
  assert(codeAfter.includes('S0 ==>|"申請する [課長承認者 not in (#quot;#quot;) and 部長承認者 not in (#quot;#quot;)]"| S3'),
    `条件はそのまま表示する（" は #quot;。以前は " を消し [ ] も空白にしていた）: ${codeAfter.split('\n').find((l) => /申請する/.test(l))}`);
  assert(codeAfter.includes('|"課長が承認する [amount ≧ #quot;1000000#quot;]"|'), '比較の記号は従来どおり ≧ にする');
  // 強調（追加・変更）は従来どおり。linkStyle の番号は矢印の順番
  const edgeLines = codeAfter.split('\n').filter((l) => EDGE.test(l));
  const styled = [...codeAfter.matchAll(/linkStyle (\d+) stroke:#1a73e8,stroke-width:3px/g)].map((m) => Number(m[1]));
  assert(styled.length === 3 && styled.every((n) => /==>/.test(edgeLines[n] || '')) && /style S3 fill:#e3f0ff,stroke:#1a73e8/.test(codeAfter) && /style S4 fill:#e3f0ff/.test(codeAfter),
    `追加・変更の矢印（==>）だけを linkStyle で強調し、新しいステータスを塗る: ${JSON.stringify(styled)}`);
}
{
  // 記号の多い名前（半角のかっこ・#・バッククォート・< >・|・;・%%・改行・状態名の中の -->）
  const odd = {
    states: [{ name: '作成中 (A)' }, { name: '承認 #1' }, { name: 'x<y>z' }, { name: 'a --> b', origin: 'proposed' }],
    actions: [
      { name: '申請(課長)', from: '作成中 (A)', to: '承認 #1', filterCond: 'ステータス in ("承認済み", "完了")' },
      { name: 'a|b;c %% d `e`', from: '承認 #1', to: 'x<y>z', filterCond: '' },
      { name: '改行\nあり', from: 'x<y>z', to: '作成中 (A)', filterCond: '' },
      { name: '新しい', from: 'x<y>z', to: 'a --> b', filterCond: '' },
    ],
  };
  const oc = safe(() => PR.processMermaid(odd, { states: odd.states.slice(0, 3), actions: odd.actions.slice(0, 3) }), '');
  assert(badLines(oc).length === 0, `記号の多い名前でも、ラベルは引用符の中だけ: ${JSON.stringify(badLines(oc))}`);
  assert(oc.includes('S1["承認 #35;1"]') && oc.includes('|"a|b;c %% d #96;e#96;"|') && oc.includes('S2["x＜y＞z"]') && oc.includes('|"改行 あり"|') && oc.includes('|"申請(課長) [ステータス in (#quot;承認済み#quot;, #quot;完了#quot;)]"|'),
    '# は #35;・バッククォートは #96;（Markdown の文字列として扱わせない）・< > は全角（HTML として扱わせない）・改行は空白');
  const ls = [...oc.matchAll(/linkStyle (\d+) /g)].map((m) => Number(m[1]));
  assert(ls.length === 1 && ls[0] === 3, `linkStyle の番号は矢印の順番（追加した 4 本目 = 3）: ${JSON.stringify(ls)}`);
  assert(safe(() => PR.mermaidLabel('a "b" #c'), null) === '"a #quot;b#quot; #35;c"' && safe(() => PR.mermaidLabel(''), null) === '""', 'mermaidLabel: # を先に置き換える（#quot; を二重に置き換えない）');
}

// =========================================================
console.log('\n--- 2. ヘルスタブの図（Process Analysis）: アクション名に半角のかっこがあっても描ける ---');
{
  const build = T.buildProcessMermaid;
  const status = {
    enable: true,
    states: { '申請前': { name: '申請前', index: '0' }, '承認待ち': { name: '承認待ち', index: '1' }, '承認済み': { name: '承認済み', index: '2' } },
    actions: [
      { name: '申請する(課長)', from: '申請前', to: '承認待ち', filterCond: 'amount not in ("")' },
      { name: '承認する', from: '承認待ち', to: '承認済み' },
      { name: '', from: '承認待ち', to: '申請前' },
    ],
  };
  const code = typeof build === 'function' ? safe(() => build(status), '') : '';
  assert(typeof build === 'function' && badLines(code).length === 0 && /^flowchart LR\n/.test(code), `ラベルは引用符で囲む: ${JSON.stringify(badLines(code))}`);
  assert(code.includes('S0["申請前"]') && code.includes('S0 -->|"申請する(課長)"| S1') && code.includes('S1 -->|"承認する"| S2') && code.includes('S1 --> S0'), 'アクション名はそのまま（名前の無い矢印はラベルなし）');
}

// =========================================================
console.log('\n--- 3. 描画: mermaid.render（body で測る）で描き、描けなかった図は理由とコードを出す ---');
{
  const T4 = loadToolkit();
  const calls = { render: [], run: 0 };
  T4.__sandbox.mermaid = {
    // Mermaid と同じく、SVG は width 100%・max-width に本来の幅を入れて返す
    render: (id, code, container) => { calls.render.push({ id, code, container }); return /not in/.test(code) ? Promise.reject(new Error('Parse error on line 7:\n...申請する 課長承認者 not in (')) : Promise.resolve({ svg: `<svg id="${id}" width="100%" style="max-width: 741.234px;"></svg>` }); },
    run: () => { calls.run++; return Promise.resolve(); },
  };
  const host = makeFakeHost();
  const panel = T4.mountAiWorkspace(host, withDevBase(T4, { getInputs: () => ({ data: FX.makeData() }), copyText: async () => true, downloadText: () => { }, colors: { border: '#ccc', bg: '#fff' } }));
  // 子要素を持つ要素（理由とコードの表示を確かめる）。innerHTML に入れた SVG は querySelector('svg') で引ける（style の max-width だけを持つ）
  T4.__sandbox.document.createElement = (tag) => ({
    tagName: String(tag).toUpperCase(), style: {}, children: [], attrs: {}, className: '', textContent: '', innerHTML: '',
    setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.children.push(c); return c; }, addEventListener() { },
    querySelector(sel) { if (sel !== 'svg' || !/<svg/.test(this.innerHTML)) return null; if (!this._svg) { const m = this.innerHTML.match(/max-width:\s*([\d.]+)px/); this._svg = { style: { maxWidth: m ? `${m[1]}px` : '' } }; } return this._svg; },
  });
  const mk = (code) => ({ textContent: code, getClientRects() { return [{ width: 100 }]; }, replaceWith(d) { this.replaced = d; } });
  // 修正前の構文エラーになるコード（引用符の無いラベル）を After として描かせる
  const brokenAfter = 'flowchart LR\n  S0["申請前"]\n  S3["課長承認待ち"]\n  S0 ==>|申請する 課長承認者 not in () and 部長承認者 not in ()| S3';
  const okPre = mk(codeBefore || 'flowchart LR\n  S0["申請前"]'), badPre = mk(brokenAfter);
  //   右の「変更内容」の［プロセス管理の変更前後（図）］を開いた（toggle）ときに、その中の図を描く
  const procDetails = { open: true, querySelectorAll: (sel) => (sel === 'pre.kt-ai-mermaid' ? [okPre, badPre].filter((p) => !p.replaced) : []) };
  const $sum = host.querySelector('#kt-ai-change-summary');
  await $sum.dispatch({ type: 'toggle', target: { ...procDetails, open: false } });
  assert(calls.render.length === 0, `閉じたときは描かない: ${calls.render.length}`);
  await $sum.dispatch({ type: 'toggle', target: procDetails });
  await tick(); await tick();
  const d1 = okPre.replaced, d2 = badPre.replaced;
  assert(calls.run === 0 && calls.render.length === 2 && calls.render.every((c) => c.container === undefined),
    `mermaid.render で描く（ペインの中の要素を渡さず、ページの body で測る。ペインが隠れても大きさが 0 にならない）・mermaid.run は使わない: render ${calls.render.length} / run ${calls.run}`);
  assert(!!d1 && /^<svg id="kt-ai-mermaid-/.test(d1.innerHTML || '') && d1.attrs && d1.attrs['data-processed'] === 'true', '描けた図は SVG を枠に入れる');
  const svg1 = d1 && typeof d1.querySelector === 'function' ? d1.querySelector('svg') : null;
  assert(!!svg1 && svg1.style.minWidth === '741px', `図を縮めない: 本来の幅（max-width 741.234px）を最小の幅にする（枠より広ければ枠の中で横にスクロール）: ${svg1 && svg1.style.minWidth}`);
  const kids = (d2 && d2.children) || [];
  assert(!!d2 && d2.className === 'kt-ai-mermaid-fallback' && kids.some((c) => /^図を描けませんでした（Parse error on line 7:）。コードをそのまま表示します。$/.test(c.textContent)) && kids.some((c) => c.tagName === 'PRE' && c.textContent === brokenAfter),
    '描けなかった図は Mermaid のエラー画像ではなく、理由（1 行目）と元のコードを出す（もう一度描こうとしない class にする）');
  const ids = calls.render.map((c) => c.id);
  assert(ids.length === 2 && new Set(ids).size === 2 && ids.every((id) => /^kt-ai-mermaid-[0-9a-z]+-\d+$/.test(id)), `id はページの中で一意（Mermaid は同じ id の要素を消してから描く）: ${JSON.stringify(ids)}`);
  // 開き直しても、描いた図・理由を出した図をもう一度描かない
  await $sum.dispatch({ type: 'toggle', target: procDetails });
  await tick();
  assert(calls.render.length === 2, `描き直さない: ${calls.render.length}`);
}

// =========================================================
console.log('\n--- 4. 並べ方: Before / After を縦に並べる（実機: 横に並べると枠が半分の幅になり、図が縮んで文字が読めなかった）---');
{
  const { KTDeps } = T;
  const data = FX.makeData();
  const deps = KTDeps.buildDependencyData(data, KTDeps.normalizeFields(data.fields));
  const step = (id, actionType, targetKind, targetRef, details = [], extra = {}) => ({ id, actionType, targetKind, targetRef, title: `${id} ${actionType}`, proposal: { summary: '', details: details.map(([key, value]) => ({ key, value })) }, dependsOn: [], reason: '', evidenceIds: [], confidence: 'INFERRED', alternativeId: null, validation: { status: 'ok', issues: [] }, ...extra });
  const plan = {
    planVersion: '1', goal: 'g', assessment: { summary: '' }, relevantFields: [], proposedFields: [], alternatives: [], impact: [], questions: [], unknowns: [], planConfidence: 'INFERRED',
    steps: [
      step('P1', 'ADD_PROCESS_STATUS', 'PROCESS_STATUS', '部長承認待ち', [['作業者', 'approver']]),
      step('P2', 'ADD_PROCESS_ACTION', 'PROCESS_ACTION', '部長へ', [['遷移元', '承認待ち'], ['遷移先', '部長承認待ち'], ['条件', 'amount >= "1000000"']], { dependsOn: ['P1'] }),
    ],
  };
  const rv = safe(() => PR.review({ plan, data, deps, scan: null, incoming: null }), null);
  const h = rv ? String(safe(() => T.KTAiChatUi.changeSummaryHtml({ plan, review: rv }), '')) : '';
  const at = h.indexOf('<summary>プロセス管理の変更前後（図）</summary>');
  const end = at >= 0 ? h.indexOf('</details>', at) : -1;
  const sec = at >= 0 ? h.slice(at, end > at ? end : at + 4000) : '';
  assert(!!rv && rv.simulation.process.changed && /data-side="before"/.test(sec) && /data-side="after"/.test(sec), '前提: 右の「変更内容」の［プロセス管理の変更前後（図）］にプロセスの Before / After がある');
  assert(/display:grid/.test(sec) && !/flex:1 1/.test(sec) && !/flex-wrap/.test(sec), `Before / After は縦に並べる（横に並べない）: ${sec.slice(0, 160)}`);
  assert((sec.match(/min-width:0; overflow-x:auto;/g) || []).length === 2, '枠は横にスクロールできる（図は縮めない）');
  // =========================================================
  //   5（2026-10-19）. 開く操作から描画の呼び出しまで: 画面と同じ部品で作った変更内容の要約（この計画）の図のコードを、［プロセス管理の変更前後（図）］を開いたときに描く
  //   （偽の DOM は HTML を解析しないので、要約の HTML から図の枠と図のコードを取り出して、開いた枠の中の要素として渡す。実ブラウザーでは確かめていない）
  {
    const T5 = loadToolkit();
    const drawn = [];
    T5.__sandbox.mermaid = { render: (id, code) => { drawn.push(code); return Promise.resolve({ svg: `<svg id="${id}" width="100%" style="max-width: 320px;"></svg>` }); } };
    T5.__sandbox.document.createElement = (tag) => ({ tagName: String(tag).toUpperCase(), style: {}, children: [], attrs: {}, className: '', textContent: '', innerHTML: '', setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.children.push(c); return c; }, addEventListener() { }, querySelector() { return null; } });
    const host5 = makeFakeHost();
    T5.mountAiWorkspace(host5, withDevBase(T5, { getInputs: () => ({ data: FX.makeData() }), copyText: async () => true, downloadText: () => { }, colors: { border: '#ccc', bg: '#fff' } }));
    const $sum5 = host5.querySelector('#kt-ai-change-summary');
    const dec = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    const box = (h.match(/<details class="kt-ai-tech kt-ai-sum-process">[\s\S]*?<\/details>/) || [''])[0];
    const codes = [...box.matchAll(/<pre class="kt-ai-mermaid" data-side="(before|after)"[^>]*>([\s\S]*?)<\/pre>/g)].map((x) => ({ side: x[1], code: dec(x[2]) }));
    assert(box && codes.map((c) => c.side).join() === 'before,after' && codes.every((c) => /^flowchart LR\n/.test(c.code)) && /部長承認待ち/.test(codes[1].code), `前提: 変更内容の［プロセス管理の変更前後（図）］の中に Before / After の図のコードがある: ${JSON.stringify(codes.map((c) => c.code.split('\n')[0]))}`);
    $sum5.innerHTML = h;
    const pres = codes.map((c) => ({ textContent: c.code, getClientRects() { return [{ width: 100 }]; }, replaceWith(d) { this.replaced = d; } }));
    const opened = { open: true, querySelectorAll: (sel) => (sel === 'pre.kt-ai-mermaid' ? pres.filter((p) => !p.replaced) : []) };
    assert($sum5.listenerCount('toggle') === 1, '画面は右の「変更内容」の開閉（toggle）を受け取る');
    await $sum5.dispatch({ type: 'toggle', target: { ...opened, open: false } }); await tick();
    assert(drawn.length === 0 && pres.every((p) => !p.replaced), `閉じたときは描かない: ${drawn.length}`);
    await $sum5.dispatch({ type: 'toggle', target: opened }); await tick(); await tick();
    assert(drawn.length === 2 && drawn[0] === codes[0].code && drawn[1] === codes[1].code && pres.every((p) => p.replaced && /data-processed/.test(JSON.stringify(p.replaced.attrs || {}))), `［プロセス管理の変更前後（図）］を開くと、変更内容の Before / After の図のコードで描き、描いた図を枠に入れる: ${drawn.length}`);
  }
}

console.log(`\n${state.failed === 0 ? 'ALL PASSED' : 'FAILED'}: ${state.passed} passed / ${state.failed} failed`);
process.exit(state.failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
