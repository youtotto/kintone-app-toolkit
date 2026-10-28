/* Browser-local session lifecycle. Storage failures never erase the active workspace. */
'use strict';
const KTReleaseHistorySession = (() => {
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const failure = (code, message) => Object.assign(new Error(message), { code });
  const editedFiles = payload => (payload?.editor?.files || []).filter(file => file.isNew || typeof file.registeredText !== 'string' || file.text !== file.registeredText);
  function signature(payload) {
    const value = clone(payload), state = value?.session?.state;
    if (state) { delete state.explanationId; delete state.resultRunId; }
    if (value?.editor) { const files = editedFiles(value); for (const file of files) delete file.viewState; value.editor = files.length ? { version: value.editor.version, files } : null; }
    return JSON.stringify(value);
  }
  function hasContent(payload) {
    const s = payload?.session?.state || {};
    return !!(payload?.draft || editedFiles(payload).length || s.messages?.length || s.explanations?.length || s.runs?.length || s.proposal || s.plan);
  }
  function create({ store, capture, restore, verifyAccess, canSwitch = () => true, onStatus = () => {}, now = () => Date.now(), makeId = () => globalThis.crypto.randomUUID(), debounceMs = 450 } = {}) {
    let current = null, lastSignature = '', dirty = false, timer = null, disposed = false, suppress = false, switching = false;
    let queue = Promise.resolve(), status = { state: 'saved', message: '' };
    const notify = (state, message = '') => { status = { state, message, completed: current?.completedAt != null, pinned: !!current?.pinned }; onStatus({ ...status }); };
    const serial = work => { const next = queue.catch(() => {}).then(work); queue = next; return next; };
    const requireUnchanged = expected => {
      if (signature(capture()) !== expected) throw failure('HISTORY_EDITED', '読み込み中に内容が変わったため、会話の切り替えを止めました。追記は残しています。');
    };
    const report = error => {
      dirty = true;
      notify('error', error?.code === 'HISTORY_CONFLICT' ? '別のタブで保存内容が変わりました。手元の内容は残っています。書き出してから会話を開き直してください。'
        : error?.code === 'HISTORY_LIMIT' || error?.name === 'QuotaExceededError' ? '保存容量が足りません。手元の内容は残っています。保存した会話を整理してください。'
        : error?.message || 'ブラウザーに保存できませんでした。画面の内容は残っています。');
    };
    async function saveCurrent({ completedAt, pinned, snapshot } = {}) {
      const payload = snapshot || clone(capture()), nextSignature = signature(payload);
      if (!current && !hasContent(payload)) { lastSignature = nextSignature; dirty = false; notify('saved'); return current; }
      const changed = nextSignature !== lastSignature;
      if (!changed && completedAt === undefined && pinned === undefined && current) { dirty = false; notify('saved', 'このブラウザーに保存済み'); return current; }
      await verifyAccess(false);
      const s = payload.session.state;
      const title = s.goal || s.messages?.find(m => m.role === 'user')?.text || s.explanations?.[0]?.title || '作業中の会話';
      const prior = current?.expiresAt && current.expiresAt <= now() && (changed || pinned === true || completedAt !== undefined) ? null : current;
      const saved = await store.save({ id: prior?.id || makeId(), revision: prior?.revision ?? null,
        title: String(title).slice(0, 120), payload, completedAt: completedAt !== undefined ? completedAt : changed ? null : current?.completedAt ?? null,
        pinned: pinned !== undefined ? pinned : !!current?.pinned });
      current = saved; lastSignature = nextSignature;
      dirty = signature(capture()) !== nextSignature;
      notify(dirty ? 'saving' : 'saved', dirty ? '保存しています…' : 'このブラウザーに保存済み');
      if (dirty && !disposed) schedule();
      return current;
    }
    function schedule() { clearTimeout(timer); timer = setTimeout(() => { timer = null; flush().catch(() => {}); }, debounceMs); }
    function changed() {
      if (suppress || disposed) return;
      dirty = true; notify('saving', '保存しています…'); schedule();
    }
    function flush() {
      clearTimeout(timer); timer = null;
      return serial(async () => { try { return await saveCurrent(); } catch (error) { report(error); throw error; } });
    }
    async function list() {
      await verifyAccess(true);
      const entries = await store.list(), usage = await store.usage();
      await verifyAccess(false);
      return { entries, usage, currentId: current?.id || null };
    }
    async function open(id) {
      if (switching || !canSwitch()) return false;
      switching = true;
      try {
        await flush(); requireUnchanged(lastSignature);
        const before = signature(capture());
        await verifyAccess(false);
        const saved = await store.load(id);
        await verifyAccess(false); requireUnchanged(before);
        if (!saved) throw failure('HISTORY_MISSING', '保存期間を過ぎたか、別のタブで削除された会話です。');
        if (!canSwitch()) return false;
        suppress = true;
        const ok = await restore(clone(saved.payload));
        if (!ok) throw failure('HISTORY_OPEN_FAILED', '現在のアプリと保存内容を確認できません。開いていた会話と編集は残しています。');
        current = Object.fromEntries(Object.entries(saved).filter(([key]) => key !== 'payload'));
        lastSignature = signature(capture()); dirty = false;
        notify('saved', current.completedAt != null ? '保存した会話を表示しています' : 'このブラウザーに保存済み');
        return true;
      } catch (error) { report(error); return false; }
      finally { suppress = false; switching = false; }
    }
    async function beforeNewTask() {
      if (switching || !canSwitch()) return false;
      switching = true;
      try { await flush(); requireUnchanged(lastSignature); current = null; lastSignature = ''; dirty = false; notify('saved'); return true; }
      catch (error) { report(error); return false; } finally { switching = false; }
    }
    async function markComplete() {
      if (switching || !canSwitch()) return false;
      return serial(async () => { try { await saveCurrent({ completedAt: now() }); return !!current; } catch (error) { report(error); return false; } });
    }
    async function setPinned(entry, value) {
      if (switching || !canSwitch()) return false;
      await verifyAccess(true);
      if (entry.id === current?.id) return serial(async () => {
        try { await saveCurrent({ pinned: value, completedAt: !value && current.completedAt != null ? now() : current.completedAt }); return true; }
        catch (error) { report(error); return false; }
      });
      const saved = await store.load(entry.id);
      await verifyAccess(false);
      if (!saved || saved.revision !== entry.revision) throw failure('HISTORY_CONFLICT', '別のタブで保存内容が変わりました。一覧を取り直してください。');
      await store.save({ ...saved, pinned: value, completedAt: !value && saved.completedAt != null ? now() : saved.completedAt }); return true;
    }
    async function remove(entry) {
      if (entry.id === current?.id) throw failure('HISTORY_ACTIVE', '開いている会話は削除できません。別の会話へ移動してから削除してください。');
      await verifyAccess(true); return store.remove(entry.id, entry.revision);
    }
    function dispose() { const snapshot = clone(capture()); disposed = true; clearTimeout(timer); timer = null; return serial(() => saveCurrent({ snapshot })).catch(error => { report(error); }).finally(() => store.close()); }
    return { changed, flush, list, open, beforeNewTask, markComplete, setPinned, remove, dispose, initialize: () => store.prune().catch(error => { report(error); }),
      getStatus: () => ({ ...status }), getCurrent: () => clone(current), isDirty: () => dirty, exportCurrent: () => clone(capture()), isSwitching: () => switching };
  }
  return { create, signature, hasContent };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = { KTReleaseHistorySession };
