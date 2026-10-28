'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { KTReleaseHistorySession: HistorySession } = require('../src/release-history-session.js');

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const blank = () => ({ version: 1, session: { state: { messages: [], explanations: [], runs: [] } }, draft: '', editor: null });
const content = text => ({ ...blank(), draft: text, session: { state: { messages: [{ role: 'user', text }], explanations: [], runs: [], goal: text } } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const metadata = entry => { const { payload, ...result } = clone(entry); return result; };

function fixture({ selection = { id: 'older' }, initial = blank() } = {}) {
  let payload = clone(initial), selected = clone(selection), time = 10000, nextId = 0, access = true, selectFailures = 0;
  const saved = new Map(), barriers = new Map(), statuses = [];
  const calls = { load: [], list: 0, save: [], select: [], restore: 0, applied: 0, close: 0, access: [] };
  const wait = async name => {
    const gate = barriers.get(name);
    if (gate) { barriers.delete(name); gate.started.resolve(); await gate.release.promise; }
  };
  const store = {
    async prune() {},
    async getSelection() { await wait('getSelection'); return clone(selected); },
    async select(id) {
      calls.select.push(id);
      await wait('select');
      if (selectFailures > 0) { selectFailures--; throw Object.assign(Error('selection unavailable'), { code: 'HISTORY_SAVE_FAILED' }); }
      if (id !== null && !saved.has(id)) throw Object.assign(Error('missing selection'), { code: 'HISTORY_INVALID' });
      selected = { id }; return clone(selected);
    },
    async load(id) { calls.load.push(id); await wait('load'); return clone(saved.get(id)) || null; },
    async list() { calls.list++; return [...saved.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(metadata); },
    async usage() { return { bytes: 0, maxBytes: 100000, count: saved.size }; },
    async save(value, options = {}) {
      calls.save.push({ value: clone(value), options: clone(options) });
      await wait('save');
      const previous = saved.get(value.id);
      if ((previous?.revision ?? null) !== value.revision) throw Object.assign(Error('conflict'), { code: 'HISTORY_CONFLICT' });
      const entry = { ...clone(value), revision: (previous?.revision || 0) + 1, updatedAt: time,
        expiresAt: value.completedAt === null || value.pinned ? null : previous?.completedAt === value.completedAt ? previous.expiresAt : value.completedAt + 30 * 86400000 };
      saved.set(value.id, entry); if (options.activate !== false) selected = { id: value.id }; return metadata(entry);
    },
    async remove(id) { return saved.delete(id); },
    close() { calls.close++; }
  };
  const manager = HistorySession.create({
    store, capture: () => payload,
    restore: async (value, options) => {
      calls.restore++; await wait('restore');
      if (!options.shouldContinue()) return false;
      payload = clone(value); calls.applied++; return true;
    },
    verifyAccess: async force => { calls.access.push(force); if (!access) throw Error('access changed'); },
    canSwitch: () => true, onStatus: status => statuses.push(status), now: () => time,
    makeId: () => 'new-' + ++nextId, debounceMs: 1000000
  });
  const seed = (id, updatedAt, extra = {}) => saved.set(id, {
    id, revision: 1, title: id, updatedAt, completedAt: null, expiresAt: null, pinned: false, bytes: 100, payload: content(id + ' content'), ...clone(extra)
  });
  seed('older', 100); seed('newer', 200);
  return {
    manager, store, saved, calls, statuses, seed,
    pause(name) { const gate = { started: deferred(), release: deferred() }; barriers.set(name, gate); return gate; },
    get payload() { return payload; }, set payload(value) { payload = value; },
    get selected() { return clone(selected); }, set selectFailures(value) { selectFailures = value; },
    set access(value) { access = value; }, set time(value) { time = value; }
  };
}

test('startup restores the last selected older history without saving the blank workspace', async t => {
  const f = fixture(), before = clone([...f.saved]); t.after(() => f.manager.dispose());
  const starting = f.manager.initialize();
  assert.equal(f.manager.initialize(), starting); assert.equal(f.manager.ready(), starting);
  assert.equal(f.manager.isInitializing(), true); assert.equal(f.manager.isSwitching(), true);
  assert.equal(await starting, true);
  assert.equal(f.manager.getCurrent().id, 'older'); assert.equal(f.payload.draft, 'older content');
  assert.deepEqual(f.calls.load, ['older']); assert.equal(f.calls.list, 0); assert.equal(f.calls.save.length, 0);
  assert.deepEqual([...f.saved], before); assert.deepEqual(f.selected, { id: 'older' });
  assert.equal(f.calls.applied, 1); assert.equal(f.manager.isInitializing(), false); assert.equal(f.manager.isSwitching(), false);
});

test('an explicit empty selection stays blank while legacy missing selection restores newest', async t => {
  await t.test('explicit new conversation', async t => {
    const f = fixture({ selection: { id: null } }); t.after(() => f.manager.dispose());
    assert.equal(await f.manager.initialize(), false); await f.manager.flush();
    assert.deepEqual(f.payload, blank()); assert.equal(f.manager.getCurrent(), null); assert.deepEqual(f.selected, { id: null });
    assert.equal(f.calls.list, 0); assert.deepEqual(f.calls.load, []); assert.equal(f.calls.save.length, 0); assert.deepEqual(f.calls.select, []);
  });
  await t.test('legacy scope', async t => {
    const f = fixture({ selection: null }); t.after(() => f.manager.dispose());
    assert.equal(await f.manager.initialize(), true); assert.equal(f.manager.getCurrent().id, 'newer');
    assert.equal(f.calls.list, 1); assert.deepEqual(f.calls.load, ['newer']); assert.equal(f.calls.save.length, 0); assert.deepEqual(f.selected, { id: 'newer' });
  });
});

test('a deleted or expired selected history does not fall back to another history', async t => {
  const f = fixture({ selection: { id: 'missing' } }), before = clone([...f.saved]); t.after(() => f.manager.dispose());
  assert.equal(await f.manager.initialize(), false); await f.manager.flush();
  assert.deepEqual(f.payload, blank()); assert.equal(f.manager.getCurrent(), null); assert.deepEqual(f.selected, { id: 'missing' });
  assert.deepEqual(f.calls.load, ['missing']); assert.equal(f.calls.list, 0); assert.equal(f.calls.save.length, 0); assert.equal(f.calls.restore, 0);
  assert.deepEqual([...f.saved], before);
});

test('typing while startup loads keeps the new input and saves it under a new identity', async t => {
  const f = fixture(), gate = f.pause('load'), older = clone(f.saved.get('older')); t.after(() => f.manager.dispose());
  const starting = f.manager.initialize(); await gate.started.promise;
  f.payload.draft = 'new input during startup'; f.manager.changed(); gate.release.resolve();
  assert.equal(await starting, false); assert.equal(f.calls.restore, 0); assert.equal(f.payload.draft, 'new input during startup');
  assert.equal(f.manager.getCurrent(), null); assert.deepEqual(f.saved.get('older'), older);
  await f.manager.flush();
  assert.equal(f.manager.getCurrent().id, 'new-1'); assert.equal(f.saved.get('new-1').payload.draft, 'new input during startup');
  assert.deepEqual(f.selected, { id: 'new-1' }); assert.deepEqual(f.saved.get('older'), older);
});

test('editing and undoing while startup finds its selection still cancels restoration', async t => {
  const f = fixture(), gate = f.pause('getSelection'), before = clone([...f.saved]); t.after(() => f.manager.dispose());
  const starting = f.manager.initialize(); await gate.started.promise;
  f.payload.draft = 'temporary input'; f.manager.changed(); f.payload.draft = ''; f.manager.changed(); gate.release.resolve();
  assert.equal(await starting, false); assert.equal(f.calls.restore, 0); assert.deepEqual(f.calls.load, []); assert.deepEqual(f.payload, blank());
  await f.manager.flush(); assert.equal(f.calls.save.length, 0); assert.deepEqual([...f.saved], before); assert.deepEqual(f.selected, { id: 'older' });
});

test('input during async restoration cancels through shouldContinue, including input then undo', async t => {
  for (const undo of [false, true]) await t.test(undo ? 'input then undo' : 'new input', async t => {
    const f = fixture(), gate = f.pause('restore'), before = clone([...f.saved]); t.after(() => f.manager.dispose());
    const starting = f.manager.initialize(); await gate.started.promise;
    f.payload.draft = 'input while restoring'; f.manager.changed();
    if (undo) { f.payload.draft = ''; f.manager.changed(); }
    gate.release.resolve();
    assert.equal(await starting, false); assert.equal(f.calls.applied, 0); assert.equal(f.manager.getCurrent(), null);
    assert.equal(f.payload.draft, undo ? '' : 'input while restoring'); assert.deepEqual([...f.saved], before);
    await f.manager.flush();
    if (undo) { assert.equal(f.calls.save.length, 0); assert.deepEqual(f.selected, { id: 'older' }); }
    else { assert.equal(f.saved.get('new-1').payload.draft, 'input while restoring'); assert.deepEqual(f.selected, { id: 'new-1' }); }
  });
});

test('an access change during startup load prevents revealing the stored payload', async t => {
  const f = fixture(), gate = f.pause('load'), before = clone([...f.saved]); t.after(() => f.manager.dispose());
  const starting = f.manager.initialize(); await gate.started.promise; f.access = false; gate.release.resolve();
  assert.equal(await starting, false); assert.equal(f.calls.restore, 0); assert.deepEqual(f.payload, blank()); assert.equal(f.manager.getCurrent(), null);
  assert.equal(f.manager.getStatus().state, 'error'); assert.equal(f.calls.save.length, 0); assert.deepEqual([...f.saved], before);
  f.access = true;
});

test('disposing during restoration invalidates shouldContinue and leaves saved work untouched', async () => {
  const f = fixture(), gate = f.pause('restore'), before = clone([...f.saved]);
  const starting = f.manager.initialize(); await gate.started.promise;
  const disposed = f.manager.dispose(); gate.release.resolve();
  assert.equal(await starting, false); await disposed;
  assert.equal(f.calls.applied, 0); assert.deepEqual(f.payload, blank()); assert.equal(f.manager.getCurrent(), null);
  assert.equal(f.calls.close, 1); assert.equal(f.calls.save.length, 0); assert.deepEqual(f.calls.select, []); assert.deepEqual([...f.saved], before);
});

test('selection failure after opening retains the restored current history and flush retries only the pointer', async t => {
  const f = fixture(); t.after(() => f.manager.dispose()); await f.manager.initialize();
  f.selectFailures = 1;
  assert.equal(await f.manager.open('newer'), false);
  assert.equal(f.manager.getCurrent().id, 'newer'); assert.equal(f.payload.draft, 'newer content'); assert.deepEqual(f.selected, { id: 'older' });
  assert.equal(f.manager.getStatus().state, 'error'); assert.equal(f.manager.isDirty(), true); assert.equal(f.calls.save.length, 0);
  const restoredRevision = f.manager.getCurrent().revision;
  await f.manager.flush();
  assert.deepEqual(f.selected, { id: 'newer' }); assert.equal(f.manager.getCurrent().revision, restoredRevision); assert.equal(f.calls.save.length, 0);
  assert.equal(f.manager.isDirty(), false); assert.equal(f.manager.getStatus().state, 'saved'); assert.deepEqual(f.calls.select, ['older', 'newer', 'newer']);
});

test('selection failure during legacy startup keeps restored content and is retryable', async t => {
  const f = fixture({ selection: null }); t.after(() => f.manager.dispose()); f.selectFailures = 1;
  assert.equal(await f.manager.initialize(), false); assert.equal(f.manager.getCurrent().id, 'newer'); assert.equal(f.payload.draft, 'newer content');
  assert.equal(f.selected, null); assert.equal(f.manager.getStatus().state, 'error'); assert.equal(f.calls.save.length, 0);
  await f.manager.flush(); assert.deepEqual(f.selected, { id: 'newer' }); assert.equal(f.calls.save.length, 0); assert.equal(f.manager.isDirty(), false);
});

test('pinning another history preserves the current selection and workspace', async t => {
  const f = fixture(); t.after(() => f.manager.dispose()); await f.manager.initialize();
  const current = f.manager.getCurrent(), workspace = clone(f.payload);
  assert.equal(await f.manager.setPinned(metadata(f.saved.get('newer')), true), true);
  assert.equal(f.saved.get('newer').pinned, true); assert.deepEqual(f.selected, { id: 'older' }); assert.deepEqual(f.manager.getCurrent(), current); assert.deepEqual(f.payload, workspace);
  assert.equal(f.calls.save.length, 1); assert.deepEqual(f.calls.save[0].options, { activate: false });
});

test('saving view-only snapshot changes persists selection and cursor without reopening completed work', async t => {
  const f = fixture(), savedPayload = content('completed work'); t.after(() => f.manager.dispose());
  savedPayload.session.state.explanationId = 'summary'; savedPayload.session.state.resultRunId = 'run-1';
  savedPayload.editor = { version: 1, active: 'pc', files: [{ name: 'custom.js', text: 'edited code', registeredText: 'original code', viewState: { selection: [0, 0] } }] };
  f.seed('older', 100, { payload: savedPayload, completedAt: 500, expiresAt: 500 + 30 * 86400000 });
  await f.manager.initialize(); const completed = f.manager.getCurrent().completedAt, expiry = f.manager.getCurrent().expiresAt;
  f.payload.session.state.explanationId = 'details'; f.payload.session.state.resultRunId = 'run-2';
  f.payload.editor.active = 'mobile'; f.payload.editor.files[0].viewState = { selection: [3, 8], scrollTop: 120 };
  f.manager.changed(); await f.manager.flush();
  assert.equal(f.manager.getCurrent().completedAt, completed); assert.equal(f.manager.getCurrent().expiresAt, expiry); assert.equal(f.calls.save.length, 1);
  assert.deepEqual(f.saved.get('older').payload, f.payload); assert.deepEqual(f.selected, { id: 'older' }); assert.equal(f.manager.isDirty(), false);
});

test('edits autosaved before initialization remain saved without restoring or resaving', async t => {
  const f = fixture(); t.after(() => f.manager.dispose());
  f.payload.editor = { version: 1, active: 'pc', files: [{ name: 'custom.js', text: 'early customization', registeredText: 'original code' }] };
  f.manager.changed(); await f.manager.flush();
  const current = f.manager.getCurrent(), workspace = clone(f.payload), saved = clone([...f.saved]);
  assert.equal(current.id, 'new-1'); assert.equal(f.calls.save.length, 1);
  assert.equal(await f.manager.initialize(), false);
  assert.equal(f.manager.getStatus().state, 'saved'); assert.equal(f.manager.isDirty(), false); assert.equal(f.manager.isInitializing(), false);
  assert.deepEqual(f.manager.getCurrent(), current); assert.deepEqual(f.payload, workspace); assert.deepEqual([...f.saved], saved);
  assert.equal(f.calls.save.length, 1); assert.equal(f.calls.restore, 0); assert.deepEqual(f.selected, { id: 'new-1' });
});

test('a second view-only change during save stays dirty and is saved without extending completion', async t => {
  const f = fixture(), initial = content('completed work'); t.after(() => f.manager.dispose());
  initial.session.state.explanationId = 'summary';
  f.seed('older', 100, { payload: initial, completedAt: 500, expiresAt: 500 + 30 * 86400000 });
  await f.manager.initialize(); const completed = f.manager.getCurrent().completedAt, gate = f.pause('save');
  f.payload.session.state.explanationId = 'details'; f.manager.changed();
  const saving = f.manager.flush(); await gate.started.promise;
  f.payload.session.state.explanationId = 'latest view'; f.manager.changed(); gate.release.resolve();
  await saving;
  assert.equal(f.saved.get('older').payload.session.state.explanationId, 'details'); assert.equal(f.payload.session.state.explanationId, 'latest view');
  assert.equal(f.manager.isDirty(), true); assert.equal(f.manager.getCurrent().completedAt, completed);
  await f.manager.flush();
  assert.equal(f.saved.get('older').payload.session.state.explanationId, 'latest view'); assert.equal(f.calls.save.length, 2);
  assert.equal(f.manager.getCurrent().completedAt, completed); assert.equal(f.manager.isDirty(), false);
});

test('new conversation stays cancelled when edits finish saving while clearing selection is pending', async t => {
  const f = fixture(); t.after(() => f.manager.dispose()); await f.manager.initialize();
  const activeId = f.manager.getCurrent().id, gate = f.pause('select');
  const changing = f.manager.beforeNewTask(); await gate.started.promise;
  f.payload.draft = 'input made while starting a new conversation';
  f.payload.editor = { version: 1, active: 'pc', files: [{ name: 'custom.js', text: 'latest edit', registeredText: 'original code' }] };
  f.manager.changed(); await f.manager.flush();
  assert.equal(f.saved.get(activeId).payload.draft, 'input made while starting a new conversation');
  assert.equal(f.saved.get(activeId).payload.editor.files[0].text, 'latest edit');
  const savedRevision = f.manager.getCurrent().revision;
  gate.release.resolve();
  assert.equal(await changing, false); assert.equal(f.manager.getCurrent().id, activeId);
  assert.equal(f.payload.draft, 'input made while starting a new conversation'); assert.equal(f.payload.editor.files[0].text, 'latest edit');
  await f.manager.flush();
  assert.deepEqual(f.selected, { id: activeId }); assert.equal(f.manager.getCurrent().revision, savedRevision);
  assert.equal(f.calls.save.length, 1); assert.equal(f.manager.isDirty(), false);
});
