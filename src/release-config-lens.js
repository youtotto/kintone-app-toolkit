/* Read-only Config Lens tab. Imported settings are comparison input only:
 * never apply them, fetch their URLs or pass them into the environment AI flow. */
'use strict';
function mountReleaseConfigLens(host, d) {
  let base = null, result = null, reading = false, sending = false, saving = false, importing = false;
  let disposed = false, generation = 0, stale = false, error = '', notice = '';
  let selectedCategory = 'all', filter = 'all', savedFile = null, comparisonTarget = 'preview';
  const isVisible = () => !disposed && d.isVisible?.() !== false;
  const canRead = () => !disposed && d.canRead?.() !== false;
  const busy = () => reading || sending || saving || importing;
  const editsOf = () => KTReleaseEnvironmentView.localEdits(d.localEdits?.());
  function compare() {
    result = null;
    if (!base || comparisonTarget === 'file' && !savedFile) return;
    try {
      result = comparisonTarget === 'file'
        ? KTReleaseSettingsCompare.compare(savedFile.document, base, { domain: d.domain })
        : KTReleaseEnvironmentDiff.compare(base);
    } catch (e) { error = e?.message || '設定を比較できませんでした。'; }
  }
  function draw() {
    if (disposed) return;
    const navigationTop = host.querySelector('.ktcl-navigation')?.scrollTop || 0;
    const active = host.ownerDocument?.activeElement;
    const focus = active && host.contains(active) ? {
      action: active.getAttribute('data-cl-action'), category: active.getAttribute('data-cl-category'),
      kind: active.getAttribute('data-cl-kind'), target: active.hasAttribute('data-cl-target')
    } : null;
    const openEntries = new Set(Array.from(host.querySelectorAll('details[open][data-cl-entry]')).map(e => e.getAttribute('data-cl-entry')));
    host.innerHTML = KTReleaseConfigLensView.render({ result, localEdits: editsOf(), busy: busy(), reading, sending, saving, importing,
      error, exportStatus: notice, selectedCategory, filter,
      savedFile: savedFile && { filename: savedFile.filename, source: savedFile.document.source,
        appName: savedFile.document.settings.settings?.name, savedAt: savedFile.document.savedAt }, comparisonTarget,
      currentSources: Object.fromEntries(['production', 'preview'].map(environment => [environment, base?.comparisonInputs?.[environment] ? {
        domain: d.domain, appId: base.appId, environment, appName: base.comparisonInputs[environment].settings?.name,
        revision: base.revision?.[environment], capturedAt: base.loadedAt
      } : null])),
      canExplain: comparisonTarget !== 'file' && !!base?.ok && KTReleaseEnvironmentView.canExplain(result) && canRead(),
      canSaveProduction: !!base?.comparisonInputs?.production && canRead(),
      canSavePreview: !!base?.comparisonInputs?.preview && canRead() });
    for (const el of host.querySelectorAll('details[data-cl-entry]')) if (openEntries.has(el.getAttribute('data-cl-entry'))) el.open = true;
    const navigation = host.querySelector('.ktcl-navigation');
    if (navigation) navigation.scrollTop = navigationTop;
    if (focus) {
      const found = Array.from(host.querySelectorAll('[data-cl-action],[data-cl-category],[data-cl-kind],[data-cl-target]')).find(el =>
        focus.action ? el.getAttribute('data-cl-action') === focus.action : focus.category ? el.getAttribute('data-cl-category') === focus.category :
          focus.kind ? el.getAttribute('data-cl-kind') === focus.kind : focus.target && el.hasAttribute('data-cl-target'));
      found?.focus?.({ preventScroll: true });
    }
  }
  async function read() {
    if (busy() || !canRead() || !isVisible()) return;
    reading = true; stale = false; error = ''; notice = ''; base = null; result = null;
    const ticket = ++generation; draw();
    try {
      const loaded = await d.loadBase({ reason: 'config-lens', shouldContinue: () => isVisible() && generation === ticket });
      if (disposed || generation !== ticket) return;
      if (!loaded?.paused && !['paused', 'cancelled'].includes(String(loaded?.status || '').toLowerCase())) {
        base = loaded; compare();
      }
    } catch (e) {
      if (!disposed && generation === ticket) error = e?.message || '設定を取得できませんでした。［取り直す］で再度確認してください。';
    } finally {
      reading = false;
      if (!disposed) { draw(); if (stale && isVisible()) read(); }
    }
  }
  async function changed(event) {
    const input = event.target;
    if (!host.contains(input) || busy() || !canRead()) return;
    if (input.hasAttribute('data-cl-target')) {
      if (!['preview', 'file'].includes(input.value)) return;
      comparisonTarget = input.value; error = ''; notice = '';
      compare(); draw(); if (!base) await read();
      return;
    }
    if (comparisonTarget !== 'file' || !input.hasAttribute('data-cl-file') || !input.files?.[0]) return;
    const file = input.files[0], ticket = ++generation;
    importing = true; error = ''; notice = ''; result = null; savedFile = null;
    draw();
    try {
      if (file.size > KTReleaseSettingsCompare.MAX_BYTES) throw new Error('設定ファイルは10MB以下のJSONを選んでください。');
      const text = await file.text();
      if (disposed || generation !== ticket) return;
      const document = KTReleaseSettingsCompare.parse(text);
      savedFile = { filename: file.name, document };
      compare();
    } catch (e) {
      if (!disposed && generation === ticket) error = e?.message || '設定ファイルを読み取れませんでした。';
    } finally {
      importing = false;
      if (!disposed) {
        draw();
        if (isVisible() && (stale || savedFile && !base)) read();
      }
    }
  }
  async function clicked(event) {
    const button = event.target.closest?.('[data-cl-action],[data-cl-category],[data-cl-kind]');
    if (!button || !host.contains(button) || button.disabled || busy()) return;
    if (button.hasAttribute('data-cl-category')) { selectedCategory = button.getAttribute('data-cl-category'); draw(); return; }
    if (button.hasAttribute('data-cl-kind')) { filter = button.getAttribute('data-cl-kind'); draw(); return; }
    const action = button.getAttribute('data-cl-action');
    if (action === 'refresh') return read();
    if (!canRead()) return;
    if (action === 'open-file' && comparisonTarget === 'file') {
      const input = host.querySelector('[data-cl-file]');
      if (input) { input.value = ''; input.click(); }
      return;
    }
    if (!base) return;
    if (action === 'save-production' || action === 'save-preview') {
      saving = true; error = ''; notice = ''; draw();
      try {
        const environment = action === 'save-production' ? 'production' : 'preview';
        const saved = KTReleaseSettingsExport.create(base, { environment, domain: d.domain, savedAt: new Date().toISOString() });
        await d.downloadText(saved.filename, saved.text, 'application/json');
        notice = '現在のアプリの' + (environment === 'production' ? '運用環境' : '動作テスト環境') + 'の取得済み設定を保存しました。'
          + (saved.complete === false ? '取得できなかった範囲もファイルに記録しています。' : '');
      } catch (e) { error = e?.message || '設定を保存できませんでした。'; }
      finally { saving = false; draw(); }
    }
    if (action === 'explain') {
      if (comparisonTarget === 'file' || !base.ok || !KTReleaseEnvironmentView.canExplain(result) || typeof d.explain !== 'function') return;
      sending = true; error = ''; notice = ''; draw();
      try {
        const answer = await d.explain(result, editsOf());
        notice = answer?.message || (answer?.ok === false ? 'AIへの説明依頼は送信していません。' : 'AI Assistantで説明を確認できます。');
      } catch (e) { error = e?.message || 'AIへの説明依頼を送信できませんでした。'; }
      finally { sending = false; draw(); }
    }
  }
  host.addEventListener('click', clicked); host.addEventListener('change', changed); draw();
  return {
    onVisible() { if (!isVisible()) return; if (!busy() && (stale || !base)) return read(); draw(); },
    refresh: read,
    markStale() { generation++; stale = true; base = null; result = null; notice = ''; draw(); },
    dispose() { disposed = true; generation++; host.removeEventListener('click', clicked); host.removeEventListener('change', changed); }
  };
}
if (typeof module !== 'undefined' && module.exports) module.exports = { mountReleaseConfigLens };
