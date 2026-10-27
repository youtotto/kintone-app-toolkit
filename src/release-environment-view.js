/* Presentation and explicit AI context for saved environment differences. */
'use strict';
const KTReleaseEnvironmentView = (() => {
  const core = typeof KTReleaseEnvironmentDiff !== 'undefined' ? KTReleaseEnvironmentDiff : require('./release-environment-diff.js').KTReleaseEnvironmentDiff;
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const stable = value => JSON.stringify(value, (_key, v) => v && !Array.isArray(v) && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
  // Compare the displayed snapshot with the fresh read used by the existing
  // explanation flow. A changed baseline must not silently change the subject.
  const keyOf = result => stable({ ...result, source: { ...result.source, loadedAt: null } });
  const canExplain = result => ['ok', 'partial'].includes(result?.status);
  function localEdits(value) {
    if (!Array.isArray(value)) return { available: false, files: [] };
    return { available: true, files: value.filter(f => ['new', 'edited', 'unknown'].includes(f?.state)).map(f => ({
      name: String(f.name || ''), kind: f.kind === 'css' ? 'css' : 'js', target: f.target === 'mobile' ? 'mobile' : 'desktop',
      environment: ['preview', 'production'].includes(f.environment) ? f.environment : 'unknown', state: f.state
    })) };
  }
  const localText = file => file.name + '（' + (file.target === 'mobile' ? 'モバイル' : 'PC') + '・' + ({ new: '新規作成・未登録', edited: '手元で編集中・未登録', unknown: '取得時との違いは未確認' }[file.state]) + '）';
  function render(result, edits) {
    const source = result.source, count = result.entries.length;
    const unavailable = result.unavailable.map(c => '<li><strong>' + esc(c.label) + '</strong>：' + esc(c.reasons.join(' ')) + '</li>').join('');
    const groups = result.categories.filter(c => c.entries.length).map(c => '<section class="ktr-env-category"><h3>' + esc(c.label) + ' <small>' + c.entries.length + '件</small></h3>' + c.entries.map(e => {
      const rows = e.rows.length ? e.rows : [{ path: [], before: e.before, after: e.after }];
      return '<details class="ktr-env-entry"><summary><span class="ktr-env-kind">' + esc({ added: '追加', changed: '変更', deleted: '削除' }[e.kind] || '変更') + '</span> ' + esc(e.label || e.code) + '</summary><div class="ktr-env-table"><table><thead><tr><th>項目</th><th>運用環境</th><th>動作テスト環境</th></tr></thead><tbody>' + rows.map(row => '<tr><th>' + esc(core.pathLabel(row.path) || e.label) + '</th><td><pre>' + esc(core.formatValue(row.before, row.path)) + '</pre></td><td><pre>' + esc(core.formatValue(row.after, row.path)) + '</pre></td></tr>').join('') + '</tbody></table></div></details>';
    }).join('') + '</section>').join('');
    return '<style>.ktr-env-category{margin:20px 0}.ktr-env-entry{border-bottom:1px solid var(--border,#485466);padding:10px 0}.ktr-env-entry summary{cursor:pointer;overflow-wrap:anywhere}.ktr-env-kind{font-size:.85em;font-weight:600}.ktr-env-table{overflow:auto;max-width:100%}.ktr-env-table table{width:100%;table-layout:fixed;border-collapse:collapse}.ktr-env-table th,.ktr-env-table td{text-align:left;vertical-align:top;padding:8px;border-bottom:1px solid var(--border,#485466);overflow-wrap:anywhere}.ktr-env-table th:first-child{width:24%}.ktr-env-table pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:300px;overflow:auto;margin:0;font:inherit}.ktr-env-coverage{margin:16px 0}.ktr-env-local{margin:20px 0;padding-top:12px;border-top:1px solid var(--border,#485466)}</style>' +
      '<p>運用環境 → 動作テスト環境の、保存済みの設定を比較しています。この会話以外で変更した内容も含みます。</p>' +
      '<p class="ktr-note">アプリ ' + esc(source.appId) + ' ／ 運用環境の版 ' + esc(source.productionRevision ?? '未確認') + ' → 動作テスト環境の版 ' + esc(source.previewRevision ?? '未確認') + '<br>取得日時：' + esc(source.loadedAt || '未確認') + '</p>' +
      '<p role="status"><strong>' + esc(canExplain(result) ? count ? '確認できた変更 ' + count + '件' : '比較できた範囲に変更はありません' : '変更を比較できませんでした') + '</strong>' + (unavailable ? '。比較できていない範囲があります。' : '') + '</p>' +
      groups + (unavailable ? '<details class="ktr-env-coverage"' + (!canExplain(result) ? ' open' : '') + '><summary>比較できていない範囲（' + result.unavailable.length + '項目）</summary><ul>' + unavailable + '</ul></details>' : '') +
      '<section class="ktr-env-local"><h3>手元の未登録編集</h3><p>上の変更一覧には含めていません。AIにはファイル名と編集状態だけを伝え、編集した本文は送りません。</p>' + (!edits.available ? '<p>この画面では編集状態を取得できていません。</p>' : edits.files.length ? '<ul>' + edits.files.map(f => '<li>' + esc(localText(f)) + '</li>').join('') + '</ul>' : '<p>このタブに未登録の編集はありません。</p>') + '</section>' +
      '<details><summary>比較の範囲について</summary><ul>' + result.limitations.map(text => '<li>' + esc(text) + '</li>').join('') + '</ul></details>';
  }
  function context(base, request) {
    const result = core.compare(base);
    if (!canExplain(result) || request.key !== keyOf(result)) throw Object.assign(new Error('表示後に設定または取得できる範囲が変わりました。未反映の変更一覧を取り直してから説明を依頼してください。AIにはまだ送信していません。'), { code: 'ENVIRONMENT_COMPARISON_CHANGED' });
    const edits = localEdits(request.localEdits?.available ? request.localEdits.files : null), facts = [];
    const add = (kind, statement, value) => facts.push({ id: 'E' + (facts.length + 1), kind, confidence: 'CERTAIN', statement, value });
    add('env-diff-coverage', '比較の対象・時点と未確認の範囲', { ...result.source, status: result.status,
      categories: result.categories.map(c => ({ id: c.id, label: c.label, status: c.status, warnings: c.warnings })), limitations: result.limitations });
    for (const entry of result.entries) add('env-diff', (result.categories.find(c => c.id === entry.categoryId)?.label || '') + '：' + entry.label, entry);
    for (const code of result.codeChanges || []) add('env-diff', 'JavaScriptの登録内容・本文の違い', { categoryId: 'customize', ...code });
    add('local-unregistered-edit', '環境の比較には含めない手元の編集', edits);
    if (facts.length > 500) throw Object.assign(new Error('比較結果が一度に送れる量を超えています。一覧は確認できますが、AIには送信していません。'), { code: 'CONTEXT_TOO_LARGE' });
    return { facts, coverage: { fields: result.categories.find(c => c.id === 'fields')?.status === 'ok', dependencies: false, javascript: result.categories.find(c => c.id === 'customize')?.status === 'ok', incoming: false, plugins: false, environmentComparison: { status: result.status, source: result.source, unavailable: result.unavailable }, localUnregisteredEdits: edits.available, recordData: false, runtime: false } };
  }
  return { render, context, keyOf, canExplain, localEdits };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = { KTReleaseEnvironmentView };
