/* Presentation and explicit AI context for saved environment differences. */
'use strict';
const KTReleaseEnvironmentView = (() => {
  const core = typeof KTReleaseEnvironmentDiff !== 'undefined' ? KTReleaseEnvironmentDiff : require('./release-environment-diff.js').KTReleaseEnvironmentDiff;
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
  return { context, keyOf, canExplain, localEdits };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = { KTReleaseEnvironmentView };
