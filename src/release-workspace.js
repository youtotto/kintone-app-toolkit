/* Release workspace: explicit user actions, service outcomes, and one execution record.
 * No requirement-text interpretation or verification-case aggregation belongs here.
 */
'use strict';

const KTReleaseWorkspace = (() => {
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) : value;
  async function hash(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(stable(value));
    const bytes = new TextEncoder().encode(text);
    return [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
  }
  const stampOf = base => base?.stamp?.fingerprint || base?.stamp || base?.fingerprint || null;
  const errorOf = e => ({ code: e?.code || 'ERROR', message: e?.code === 'BUDGET_EXCEEDED' ? 'AIの利用上限に達したため、作成を止めました。できた内容は残っています。' : e?.message || '処理を完了できませんでした。', detail: clone(e?.details || null) });
  const busyPhases = new Set(['consulting', 'building', 'preparing', 'applying', 'rolling-back']);
  const questions = (proposal, answers = []) => (proposal?.decisions || []).filter(q => q.blocking && !q.answer && !answers.some(a => a.id === q.id && a.answer));
  const generatedBody = result => { const g = result?.generated || result; return g?.strategy === 'EXTEND_EXISTING_JS' ? g.body || '' : g?.code || ''; };
  // Alternatives are suggestions, not selected operations. Follow explicit IDs only.
  function mainPlan(value) {
    const plan = clone(value), excluded = new Set((plan.alternatives || []).flatMap(a => a.stepIds || []));
    const alternatives = plan.steps.filter(s => s.alternativeId || excluded.has(s.id));
    plan.steps = plan.steps.filter(s => !s.alternativeId && !excluded.has(s.id));
    const idOf = s => s.actionType === 'CUSTOMIZATION_REQUIRED' ? s.spec?.customizationId : null;
    const mainIds = new Set(plan.steps.map(idOf).filter(Boolean));
    const alternativeIds = new Set(alternatives.map(idOf).filter(Boolean));
    plan.customizations = (plan.customizations || []).filter(c => !c.alternativeId && (!alternativeIds.has(c.customizationId) || mainIds.has(c.customizationId)));
    plan.questions = [...(plan.questions || []), ...plan.customizations.flatMap(c => c.questions || [])];
    return plan;
  }
  function create({ services, loadBase, execution, now = () => Date.now(), onChange = null } = {}) {
    if (!services || !loadBase || !execution) throw new Error('作業に必要な部品がありません。');
    const state = { phase: 'idle', taskId: 1, version: 0, goal: '', proposal: null, answers: [], adopted: null, plan: null, artifacts: [], prepared: null, runs: [], resultRunId: null, messages: [], error: null, progress: '', rollback: null };
    let base = null, controller = null, epoch = 0, sequence = 0, pendingPlanQuestions = [];
    const listeners = new Set(onChange ? [onChange] : []);
    const emit = () => { const snapshot = clone(state); for (const fn of listeners) { try { fn(snapshot); } catch (e) { console.error(e); } } };
    const set = values => { Object.assign(state, values); emit(); };
    const available = () => !busyPhases.has(state.phase);
    const message = (role, text, facts = null) => { state.messages.push({ id: ++sequence, role, text, ...(facts ? { facts: clone(facts) } : {}) }); };
    const invalidate = () => { state.prepared = null; state.rollback = null; };
    async function getBase(reason) {
      const fresh = await loadBase({ reason });
      if (!fresh?.ok || !stampOf(fresh)) throw Object.assign(new Error(fresh?.message || '動作テスト環境の設定を取得できませんでした。'), { code: 'BASE_UNAVAILABLE' });
      return fresh;
    }
    async function activity(phase, work, failurePhase = 'blocked') {
      if (!available()) return false;
      const ticket = ++epoch;
      controller = new AbortController();
      set({ phase, error: null });
      try { await work(controller.signal, () => ticket === epoch); return true; }
      catch (e) { if (ticket === epoch) set({ phase: failurePhase, error: errorOf(e), progress: '' }); return false; }
      finally { if (ticket === epoch) controller = null; }
    }
    async function validateArtifact(result, customization) {
      const outcome = result?.artifactOutcome;
      if (!outcome || outcome.version !== 'artifact-outcome-1' || !['ready', 'incomplete', 'unverified', 'failed'].includes(outcome.state)) throw Object.assign(new Error('AIサービスから検証結果を受け取れませんでした。接続先を確認してください。'), { code: 'OUTCOME_REQUIRED' });
      if (outcome.scope?.customizationId && outcome.scope.customizationId !== customization.customizationId) throw Object.assign(new Error('別の変更に対する検証結果を受け取りました。'), { code: 'ARTIFACT_MISMATCH' });
      if (outcome.state === 'ready') {
        const code = generatedBody(result), digest = await hash(code);
        const verification = result.verification || result.generated?.verification;
        if (outcome.scope?.customizationId !== customization.customizationId) throw Object.assign(new Error('検証結果と変更の対象が一致しません。'), { code: 'ARTIFACT_MISMATCH' });
        if (!code || !outcome.verifiedBodyHash || verification?.bodyHash !== outcome.verifiedBodyHash || !Array.isArray(outcome.operations) || !outcome.operations.length || outcome.operations.some(op => op.contentHash !== digest || op.bodyHash !== outcome.verifiedBodyHash)) throw Object.assign(new Error('検証した内容と登録する内容の一致を確認できませんでした。'), { code: 'BODY_MISMATCH' });
      }
      return { customizationId: customization.customizationId, title: customization.requirement || customization.customizationId, result: clone(result) };
    }
    async function build(signal, live) {
      const all = state.plan.customizations || [];
      for (const c of all) {
        if (!live()) return;
        const old = state.artifacts.find(a => a.customizationId === c.customizationId);
        if (old?.result?.artifactOutcome?.state === 'ready') continue;
        set({ progress: c.requirement || 'JavaScriptを作成しています。' });
        try {
          const result = await services.generate({ customization: clone(c), plan: clone(state.plan), proposal: clone(state.adopted), answers: clone(state.answers), requests: state.messages.filter(m => m.role === 'user').map(m => m.text), version: state.version, base, signal,
            onProgress: p => { if (live() && p?.stage) set({ progress: p.stage === 'repair' ? 'JavaScriptを修正しています。' : p.stage === 'verify' ? 'JavaScriptを確認しています。' : c.requirement }); } });
          if (!live()) return;
          const artifact = await validateArtifact(result, c);
          if (!live()) return;
          state.artifacts = state.artifacts.filter(a => a.customizationId !== c.customizationId).concat(artifact);
          emit();
          if (artifact.result.artifactOutcome.state !== 'ready') break;
        } catch (e) {
          if (!live()) return;
          state.artifacts = state.artifacts.filter(a => a.customizationId !== c.customizationId).concat({ customizationId: c.customizationId, title: c.requirement, error: errorOf(e) });
          set({ phase: 'incomplete', error: errorOf(e), progress: '' });
          return;
        }
      }
      if (!live()) return;
      const unfinished = all.some(c => !state.artifacts.some(a => a.customizationId === c.customizationId && a.result?.artifactOutcome?.state === 'ready'));
      if (unfinished) { set({ phase: 'incomplete', progress: '' }); return; }
      await prepareInner(live);
    }
    async function prepareInner(live = () => true) {
      if ((state.plan?.customizations || []).some(c => !state.artifacts.some(a => a.customizationId === c.customizationId && a.result?.artifactOutcome?.state === 'ready'))) {
        set({ phase: 'incomplete', prepared: null, progress: '' }); return;
      }
      set({ phase: 'preparing', progress: '反映する内容を確認しています。' });
      const fresh = await getBase('prepare');
      if (!live()) return;
      if (stampOf(fresh) !== stampOf(base)) { set({ phase: 'blocked', prepared: null, error: { code: 'BASE_CHANGED', message: '作成中に設定が変わりました。最新の設定で変更案を作り直してください。' }, progress: '' }); return; }
      const prepared = await execution.prepare({ plan: clone(state.plan), artifacts: clone(state.artifacts), base: fresh });
      if (!live()) return;
      const signature = await hash({ plan: state.plan, artifacts: state.artifacts, baseStamp: stampOf(fresh), changes: prepared.changes, confirmations: prepared.confirmations });
      if (!live()) return;
      prepared.baseStamp = stampOf(fresh); prepared.signature = signature;
      base = fresh;
      set({ prepared, progress: '', phase: !prepared.ok ? 'blocked' : prepared.changes?.length ? 'review' : 'unchanged' });
    }
    async function send(text) {
      const value = String(text || '').trim(); if (!value || !available()) return false;
      if (state.runs.some(r => r.status === 'running')) return false;
      if (!state.goal) state.goal = value;
      invalidate(); message('user', value);
      return activity('consulting', async (signal, live) => {
        const fresh = await getBase('consult');
        if (!live()) return;
        const response = await services.propose({ text: value, previous: clone(state.proposal), pendingPlanQuestions: clone(state.plan?.questions || pendingPlanQuestions), answers: clone(state.answers), requests: state.messages.filter(m => m.role === 'user').map(m => m.text), base: fresh, signal });
        if (!live()) return;
        if (!response || typeof response.reply !== 'string') throw new Error('AIサービスの返答を受け取れませんでした。');
        message('assistant', response.reply, response.facts);
        for (const answer of response.turn?.answers || []) {
          const question = (state.proposal?.decisions || []).find(q => q.id === answer.id);
          if (question && answer.text) state.answers = state.answers.filter(a => a.id !== answer.id).concat({ id: answer.id, key: question.key, label: question.label, question: question.question || question.text || question.label, answer: answer.text, kind: answer.kind });
        }
        if (response.proposal && !response.proposalUnchanged) { state.proposal = clone(response.proposal); state.version++; }
        base = fresh; pendingPlanQuestions = [];
        // Model intent never authorizes plan generation or a kintone write.
        set({ phase: state.proposal ? 'proposal' : 'idle', plan: null, adopted: null, artifacts: [] });
      }, state.proposal ? 'proposal' : 'idle');
    }
    async function adopt() {
      if (!state.proposal || questions(state.proposal, state.answers).length || !available()) return false;
      invalidate(); pendingPlanQuestions = []; state.adopted = clone(state.proposal); state.artifacts = [];
      // Optional ideas are not adopted by the general create action.
      state.adopted.behaviors = (state.adopted.behaviors || []).filter(b => b.origin !== 'suggestion');
      return activity('building', async (signal, live) => {
        const fresh = await getBase('plan');
        if (!live()) return;
        base = fresh;
        set({ progress: '変更の計画を作成しています。' });
        const response = await services.plan({ proposal: clone(state.adopted), goal: state.goal, answers: clone(state.answers), requests: state.messages.filter(m => m.role === 'user').map(m => m.text), version: state.version, base, signal });
        if (!live()) return;
        const plan = response?.plan;
        if (!plan || !Array.isArray(plan.steps) || !Array.isArray(plan.customizations || [])) throw new Error('変更の計画を受け取れませんでした。');
        state.plan = mainPlan(plan);
        if (state.plan.questions.some(q => q && q.blocking !== false)) { set({ phase: 'blocked', progress: '', error: { code: 'PLAN_QUESTION', message: '変更案を作るために確認が必要です。内容を相談で伝えてください。' } }); return; }
        await build(signal, live);
      }, 'incomplete');
    }
    async function resume() {
      if (!state.plan || state.phase !== 'incomplete') return false;
      return activity('building', async (signal, live) => {
        const fresh = await getBase('resume');
        if (!live()) return;
        if (stampOf(fresh) !== stampOf(base)) throw Object.assign(new Error('設定が変わったため、残りだけを作成できません。最新の設定で変更案を作り直してください。'), { code: 'BASE_CHANGED' });
        await build(signal, live);
      }, 'incomplete');
    }
    async function apply() {
      if (state.phase !== 'review' || !state.prepared?.ok) return false;
      const approved = clone(state.prepared);
      return activity('applying', async (_, live) => {
        const fresh = await getBase('execute');
        if (!live()) return;
        if (stampOf(fresh) !== approved.baseStamp) { set({ phase: 'blocked', prepared: null, error: { code: 'BASE_CHANGED', message: '確認後に設定が変わりました。この案は反映していません。最新の設定で変更案を作り直してください。' } }); return; }
        const checked = await execution.prepare({ plan: clone(state.plan), artifacts: clone(state.artifacts), base: fresh });
        const sig = await hash({ plan: state.plan, artifacts: state.artifacts, baseStamp: stampOf(fresh), changes: checked.changes, confirmations: checked.confirmations });
        if (!checked.ok || sig !== approved.signature) { set({ phase: 'blocked', prepared: null, error: { code: 'APPROVAL_CHANGED', message: '承認した内容と反映する内容が一致しないため、反映していません。変更案を確認し直してください。' } }); return; }
        const run = { id: `run-${state.taskId}-${++sequence}`, at: now(), taskId: state.taskId, goal: state.goal, status: 'running', approval: { version: state.version, signature: sig, baseStamp: approved.baseStamp }, prepared: checked, result: null };
        state.runs.push(run); emit();
        try {
          run.result = await execution.apply({ prepared: checked, onProgress: progress => { run.progress = progress; emit(); } });
          run.status = run.result?.status || 'unknown';
        } catch (e) { run.status = 'unknown'; run.result = { status: 'unknown', written: null, message: '反映の結果を確認できません。再度反映せず、現在の状態を確認してください。', error: errorOf(e) }; }
        set({ phase: 'result', resultRunId: run.id, prepared: null, progress: '' });
      }, 'blocked');
    }
    async function requestRollback(runId) {
      const run = state.runs.find(r => r.id === runId);
      if (!run || !run.result?.written || run.rollback?.status === 'complete' || !available()) return false;
      return activity('preparing', async (_, live) => {
        const prepared = await execution.prepareRollback(clone(run));
        if (!live()) return;
        set({ phase: 'rollback-confirm', rollback: { runId, prepared }, progress: '' });
      }, 'result');
    }
    async function rollback(runId) {
      if (state.phase !== 'rollback-confirm' || state.rollback?.runId !== runId || !state.rollback.prepared?.ok) return false;
      const run = state.runs.find(r => r.id === runId), prepared = clone(state.rollback.prepared);
      if (!run) return false;
      return activity('rolling-back', async () => {
        try { run.rollback = await execution.rollback({ run: clone(run), prepared, onProgress: p => { run.progress = p; emit(); } }); }
        catch (e) { run.rollback = { status: 'unknown', message: '戻した結果を確認できません。', error: errorOf(e) }; }
        set({ phase: 'result', resultRunId: run.id, rollback: null });
      }, 'result');
    }
    return {
      getState: () => clone(state), subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      send, adopt, resume, apply, requestRollback, rollback,
      async prepare() { if (!state.plan || !available()) return false; return activity('preparing', async (_, live) => prepareInner(live)); },
      cancelRollback() { if (state.phase !== 'rollback-confirm') return false; set({ phase: 'result', rollback: null }); return true; },
      newTask() { if (!available()) return false; ++epoch; base = null; pendingPlanQuestions = []; Object.assign(state, { phase: 'idle', taskId: state.taskId + 1, version: 0, goal: '', proposal: null, answers: [], adopted: null, plan: null, artifacts: [], prepared: null, messages: [], error: null, progress: '', rollback: null }); emit(); return true; },
      cancel() {
        if (!['consulting','building','preparing'].includes(state.phase)) return false;
        const consulting = state.phase === 'consulting';
        ++epoch; controller?.abort(); controller = null; invalidate();
        // A cancelled revision request cannot resume the plan made before that request.
        if (consulting) {
          // Preserve only the question text/structure needed to resend the consultation.
          pendingPlanQuestions = clone(state.plan?.questions || pendingPlanQuestions);
          Object.assign(state, { plan: null, adopted: null, artifacts: [] });
        }
        set({ phase: state.plan ? 'incomplete' : state.proposal ? 'proposal' : 'idle', progress: '', error: { code: 'CANCELLED', message: consulting ? '相談を中断しました。案は更新していません。' : '作成を中断しました。できた内容は残っています。' } }); return true;
      },
    };
  }
  return { create, hash, stampOf, generatedBody, questions };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { KTReleaseWorkspace };
