/* Read-only Config Lens tab. Reuses saved settings, structural comparison and
 * the existing AI explanation path; does not interpret requests or write kintone. */
'use strict';
function mountReleaseConfigLens(host, d) {
  let base = null, result = null, reading = false, sending = false, saving = false;
  let disposed = false, generation = 0, stale = false, error = '', notice = '';
  let selectedCategory = 'all', filter = 'all';
  const isVisible = () => !disposed && d.isVisible?.() !== false;
  const canRead = () => !disposed && d.canRead?.() !== false;
  const editsOf = () => KTReleaseEnvironmentView.localEdits(d.localEdits?.());
  function draw() {
    if (disposed) return;
    const navigationTop = host.querySelector('.ktcl-navigation')?.scrollTop || 0;
    const active = host.ownerDocument?.activeElement;
    const focus = active && host.contains(active) ? {
      action: active.getAttribute('data-cl-action'), category: active.getAttribute('data-cl-category'),
      kind: active.getAttribute('data-cl-kind')
    } : null;
    const openEntries = new Set(Array.from(host.querySelectorAll('details[open][data-cl-entry]')).map(e => e.getAttribute('data-cl-entry')));
    host.innerHTML = KTReleaseConfigLensView.render({ result, localEdits: editsOf(), busy: reading || sending || saving, reading, sending, saving,
      error, exportStatus: notice, selectedCategory, filter,
      canExplain: !!base?.ok && KTReleaseEnvironmentView.canExplain(result) && canRead(),
      canSaveProduction: !!base?.comparisonInputs?.production && canRead(),
      canSavePreview: !!base?.comparisonInputs?.preview && canRead() });
    for (const el of host.querySelectorAll('details[data-cl-entry]')) if (openEntries.has(el.getAttribute('data-cl-entry'))) el.open = true;
    const navigation = host.querySelector('.ktcl-navigation');
    if (navigation) navigation.scrollTop = navigationTop;
    if (focus) {
      const found = Array.from(host.querySelectorAll('[data-cl-action],[data-cl-category],[data-cl-kind]')).find(el =>
        focus.action ? el.getAttribute('data-cl-action') === focus.action : focus.category ? el.getAttribute('data-cl-category') === focus.category : el.getAttribute('data-cl-kind') === focus.kind);
      found?.focus?.({ preventScroll: true });
    }
  }
  async function read() {
    if (reading || sending || saving || !canRead() || !isVisible()) return;
    reading = true; stale = false; error = ''; notice = ''; base = null; result = null;
    const ticket = ++generation; draw();
    try {
      const loaded = await d.loadBase({ reason: 'config-lens', shouldContinue: () => isVisible() && generation === ticket });
      if (disposed || generation !== ticket) return;
      base = loaded; result = KTReleaseEnvironmentDiff.compare(base);
      if (base?.paused || ['paused', 'cancelled'].includes(String(base?.status || '').toLowerCase())) { base = null; result = null; }
    } catch (e) {
      if (!disposed && generation === ticket) error = e?.message || '設定を取得できませんでした。［取り直す］で再度確認してください。';
    } finally {
      reading = false;
      if (!disposed) { draw(); if (stale && isVisible()) read(); }
    }
  }
  async function clicked(event) {
    const button = event.target.closest?.('[data-cl-action],[data-cl-category],[data-cl-kind]');
    if (!button || !host.contains(button) || button.disabled) return;
    if (button.hasAttribute('data-cl-category')) { selectedCategory = button.getAttribute('data-cl-category'); draw(); return; }
    if (button.hasAttribute('data-cl-kind')) { filter = button.getAttribute('data-cl-kind'); draw(); return; }
    const action = button.getAttribute('data-cl-action');
    if (action === 'refresh') return read();
    if (reading || sending || saving || !base || !canRead()) return;
    if (action === 'save-production' || action === 'save-preview') {
      saving = true; error = ''; notice = ''; draw();
      try {
        const environment = action === 'save-production' ? 'production' : 'preview';
        const saved = KTReleaseSettingsExport.create(base, { environment, domain: d.domain, savedAt: new Date().toISOString() });
        await d.downloadText(saved.filename, saved.text, 'application/json');
        notice = (environment === 'production' ? '運用環境' : '動作テスト環境') + 'の取得済み設定を保存しました。'
          + (saved.complete === false ? '取得できなかった範囲もファイルに記録しています。' : '');
      } catch (e) { error = e?.message || '設定を保存できませんでした。'; }
      finally { saving = false; draw(); }
    }
    if (action === 'explain') {
      if (!base.ok || !KTReleaseEnvironmentView.canExplain(result) || typeof d.explain !== 'function') return;
      sending = true; error = ''; notice = ''; draw();
      try {
        const answer = await d.explain(result, editsOf());
        notice = answer?.message || (answer?.ok === false ? 'AIへの説明依頼は送信していません。' : 'AI Assistantで説明を確認できます。');
      } catch (e) { error = e?.message || 'AIへの説明依頼を送信できませんでした。'; }
      finally { sending = false; draw(); }
    }
  }
  host.addEventListener('click', clicked); draw();
  return {
    onVisible() { if (!isVisible()) return; if (!reading && (stale || !base)) return read(); draw(); },
    refresh: read,
    markStale() { generation++; stale = true; base = null; result = null; notice = ''; draw(); },
    dispose() { disposed = true; generation++; host.removeEventListener('click', clicked); }
  };
}
if (typeof module !== 'undefined' && module.exports) module.exports = { mountReleaseConfigLens };
