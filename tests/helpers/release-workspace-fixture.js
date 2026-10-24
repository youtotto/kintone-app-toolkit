'use strict';

// 新しい作業面の受入試験。接続先は持たず、AIの応答と実行部品だけを固定する。
// この依頼は試験用であり、実際のアプリ353への変更指示ではない。
const crypto = require('node:crypto');
const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const sha = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const REQUEST = '承認待ちの案件を確認する一覧を追加し、承認済みの備考はPCとモバイルで編集できなくしてください。';

function proposal(text = '承認待ちの一覧を追加します。承認済みの場合、備考をPCとモバイルで編集できなくします。') {
  return { reply: text, intent: 'propose', proposal: {
    behaviors: [{ id: 'B1', text: '承認待ちの一覧を追加する', origin: 'user' }, { id: 'B2', text: '承認済みの場合、備考をPCとモバイルで編集できなくする', origin: 'user' }],
    assumptions: [], decisions: [], approach: { standard: ['一覧の追加'], js: ['備考の編集制御'] }, cannot: [],
  }, turn: { ops: [], answers: [], requirementOps: [] }, usage: { usedThisMonth: 2, monthlyLimit: 600 }, ai: { usage: { input_tokens: 400, output_tokens: 100 } }, budgetMeta: { costUsd: 0.019 } };
}

function plan({ settings = true, platforms = ['desktop', 'mobile'] } = {}) {
  const customizations = platforms.map((platform, index) => ({
    customizationId: 'C' + (index + 1), requirement: `承認済みの備考を編集できなくします（${platform === 'desktop' ? 'PC' : 'モバイル'}）。`,
    strategy: 'NEW_JS_FILE', implementation: 'JAVASCRIPT', platform: [platform],
    events: [platform === 'desktop' ? 'app.record.edit.show' : 'mobile.app.record.edit.show'],
    fields: [{ code: 'ステータス', access: 'READ' }, { code: 'memo', access: 'CONTROL', effects: [{ effect: 'lock', condition: 'ステータス in ("承認済み")', events: [] }] }],
    apis: [], existingFiles: [], risks: [], questions: [], dependsOn: [], evidenceIds: [],
  }));
  const steps = settings ? [{ id: 'P1', title: '一覧「承認待ち」を追加', actionType: 'ADD_VIEW', targetKind: 'VIEW', targetRef: '承認待ち',
    spec: { name: '承認待ち', fields: ['memo'], filterCond: 'ステータス in ("承認待ち")', sort: '' }, dependsOn: [] }] : [];
  for (const c of customizations) steps.push({ id: c.customizationId, title: c.requirement, actionType: 'CUSTOMIZATION_REQUIRED', targetKind: 'JS', targetRef: null, spec: { customizationId: c.customizationId }, dependsOn: [] });
  return { goal: REQUEST, assessment: { summary: '一覧を追加し、承認済みの備考を編集できなくします。' }, solution: settings ? 'HYBRID' : 'CUSTOMIZATION',
    relevantFields: [], proposedFields: [], steps, customizations, alternatives: [], questions: [], unknowns: [], impact: [] };
}

function generated(customization, { state = 'ready', action = 'create', message = '', body = null } = {}) {
  const platform = customization.platform[0];
  const targetFile = platform === 'desktop' ? 'approved-memo.js' : 'mobile-approved-memo.js';
  const code = body == null ? `(function(){'use strict';kintone.events.on('${customization.events[0]}',function(event){event.record.memo.disabled=event.record['ステータス'].value==='承認済み';return event;});})();` : body;
  const bodyHash = crypto.createHash('sha256').update(JSON.stringify(['NEW_JS_FILE', targetFile, code, null, customization.customizationId])).digest('hex').slice(0, 16);
  return { strategy: 'NEW_JS_FILE', targetFile, summary: customization.requirement, code, body: code, patch: null, events: customization.events, fields: customization.fields,
    apis: [], assumptions: [], warnings: [], coverage: [],
    verification: { passed: state === 'ready', bodyHash, machine: [], requiredEffects: [], behavior: { status: state === 'ready' ? 'passed' : 'unchecked', cases: [] } },
    artifactOutcome: { version: 'artifact-outcome-1', state, scope: { customizationId: customization.customizationId }, reasonCodes: state === 'ready' ? [] : ['verification-incomplete'], message,
      verifiedBodyHash: state === 'ready' ? bodyHash : null,
      operations: state === 'ready' ? [{ action, targetPlatform: platform, targetFile, baseHash: null, bodyHash, contentHash: sha(code) }] : [] },
    usage: { usedThisMonth: 5, monthlyLimit: 600 }, ai: { usage: { input_tokens: 800, output_tokens: 200 } }, budgetMeta: { costUsd: 0.022 },
  };
}

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

function fixture(Module, options = {}) {
  const calls = [], writes = [], rollbackWrites = [];
  let revision = 1, time = 100, sequence = 0;
  const p = options.plan || plan(options);
  const loadBase = async ({ reason } = {}) => {
    calls.push({ method: 'loadBase', reason, revision });
    if (options.loadBase) return options.loadBase({ reason, revision });
    return { ok: true, current: { revision: String(revision), fields: { properties: { memo: { type: 'MULTI_LINE_TEXT', code: 'memo', label: '備考' } } } },
      stamp: `preview:${revision}`, files: [], inputs: { data: { appId: 'test-only', name: '受入試験用アプリ', fields: {} }, deps: {}, scan: { files: [] } } };
  };
  const services = {
    async propose(args) { calls.push({ method: 'propose', text: args.text, previous: clone(args.previous) }); return options.propose ? options.propose(args) : proposal(args.previous ? '仮案を修正しました。内容を確かめてから作成を始めてください。' : undefined); },
    async plan(args) { calls.push({ method: 'plan', proposal: clone(args.proposal), goal: args.goal }); return options.makePlan ? options.makePlan(args) : { plan: clone(p) }; },
    async generate(args) { calls.push({ method: 'generate', id: args.customization.customizationId }); return options.generate ? options.generate(args) : generated(args.customization); },
  };
  const execution = {
    async prepare(args) {
      calls.push({ method: 'prepare', baseStamp: args.base.stamp });
      if (options.prepare) return options.prepare(args);
      const settings = args.plan.steps.filter(s => s.actionType !== 'CUSTOMIZATION_REQUIRED').map(s => ({ stepId: s.id, title: s.title }));
      const files = Object.values(args.artifacts || {}).flatMap(a => (a.artifactOutcome || a.result?.artifactOutcome || {}).operations || []).filter(o => o.action !== 'unchanged');
      return { ok: true, settings, files, changes: [...settings, ...files], confirmations: [], reasons: [], baseStamp: args.base.stamp,
        signature: sha(JSON.stringify([args.base.stamp, args.plan, files])) };
    },
    async apply(args) {
      calls.push({ method: 'apply', prepared: clone(args.prepared) });
      if (options.apply) return options.apply(args, { calls, writes });
      writes.push(...args.prepared.settings.map(s => ({ type: 'settings', stepId: s.stepId })), ...args.prepared.files.map(f => ({ type: 'file', ...f })));
      return { status: 'complete', id: `run-${++sequence}`, settings: clone(args.prepared.settings), files: clone(args.prepared.files), written: writes.length, message: '動作テスト環境に反映しました。' };
    },
    async prepareRollback(run) { calls.push({ method: 'prepareRollback', run: clone(run) }); return options.prepareRollback ? options.prepareRollback(run) : { ok: true, reasons: [], runId: run.id, signature: `restore:${run.id}` }; },
    async rollback(args) { calls.push({ method: 'rollback', run: clone(args.run) }); if (options.rollback) return options.rollback(args); rollbackWrites.push(args.run.id); return { status: 'complete', message: '反映前の状態に戻しました。' }; },
  };
  const controller = Module.create({ services, loadBase, execution, now: () => ++time });
  const count = method => calls.filter(c => c.method === method).length;
  return { controller, calls, writes, rollbackWrites, plan: p, count, bump: () => { revision += 1; }, execution, services, loadBase };
}

module.exports = { REQUEST, proposal, plan, generated, fixture, clone, deferred };
