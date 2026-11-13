/* Coordinates preview-only writes using the same approved operations and real readback. */
'use strict';
const KTReleaseExecution = (() => {
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const messageOf = item => item?.message || item?.summary || '';
  const good = prepared => !prepared || prepared.status === 'PREPARED';
  const pending = prepared => (prepared?.changes || prepared?.steps || []).filter(s => s.status === 'PENDING');
  const isJavaScript = step => ['CUSTOMIZATION_REQUIRED', 'CUSTOMIZE_JS'].includes(step.actionType);
  const settingWritten = result => !!result?.steps?.filter(s => !isJavaScript(s)).some(s => ['APPLIED', 'VERIFIED', 'VERIFY_FAILED'].includes(s.status) || (s.status === 'FAILED' && !!s.partial));
  const settingUnknown = result => !!result?.steps?.filter(s => !isJavaScript(s)).some(s => s.status === 'FAILED' && !s.partial && s.reason === 'API_ERROR' && !/^(GAIA_|CB_)/.test(s.error?.code || '') && !(s.error?.status >= 400 && s.error?.status < 500));
  const fileUnknown = result => !!result?.put && result.put.ok !== true && result.previewUnchanged !== true;
  const requiredWarnings = prepared => (prepared?.warnings || []).filter(w => w.code !== 'OTHER_CHANGES_SINCE_EXECUTION' && w.code !== 'CUSTOMIZE_REVISION_ADVANCED');
  function create({ appId, api, loadBase, currentOf, planExecutor, jsExecutor, hash }) {
    const toCurrent = b => b.current || currentOf(b);
    function fileOperations(artifacts, plan) {
      const dependencies = {
        fields: (plan.proposedFields || []).map(f => ({ code: f.suggestedCode, stepId: (plan.steps || []).find(s => s.actionType === 'ADD_FIELD' && [s.targetRef, s.spec?.fieldCode, s.spec?.temporaryId].includes(f.temporaryId))?.id })),
        statuses: (plan.steps || []).filter(s => s.actionType === 'ADD_PROCESS_STATUS').map(s => ({ name: s.spec?.name || s.spec?.statusName || s.spec?.status?.name, stepId: s.id })).filter(s => s.name)
      };
      return artifacts.flatMap(a => {
        const outcome = a.result?.artifactOutcome, g = a.result?.generated || a.result;
        if (outcome?.state !== 'ready') throw new Error('検証が終わっていないJavaScriptがあります。');
        const code = g.strategy === 'EXTEND_EXISTING_JS' ? g.body : g.code;
        return (outcome.operations || []).map((op, i) => {
          if (!['create', 'replace', 'unchanged'].includes(op.action)) throw new Error('JavaScriptの登録方法を確認できません。');
          return ({
          id: a.customizationId + '-' + i, customizationId: a.customizationId, kind: op.action === 'create' ? 'ADD_FILE' : 'REPLACE_FILE',
          target: op.targetPlatform, name: op.targetFile, code, contentHash: op.contentHash, baseHash: op.baseHash || null,
          sourceId: op.targetExistingFileId || null, expectedUnchanged: op.action === 'unchanged', summary: a.title,
          verification: { accepted: true, contentHash: op.contentHash },
          dependsOn: dependencies
        }); });
      });
    }
    function fileIdentityReasons(operations, current) {
      return operations.filter(op => op.kind === 'REPLACE_FILE').flatMap(op => {
        const list = current.customize?.[op.target]?.js || [];
        const targets = list.filter(e => e.type === 'FILE' && (e.file?.name || e.name) === op.name);
        const key = targets[0]?.file?.fileKey || targets[0]?.fileKey;
        return op.sourceId && targets.length === 1 && key === op.sourceId ? [] : [{ code: 'FILE_TARGET_CHANGED', message: `更新する「${op.name}」が、JavaScriptを作成したときのファイルと一致しません。` }];
      });
    }
    function unchangedReasons(operations, prepared) {
      if (!good(prepared)) return [];
      return operations.filter(op => op.expectedUnchanged && !prepared?.changes?.some(c => c.changeId === op.id && c.status === 'SKIPPED' && c.reason === 'JS_UNCHANGED'))
        .map(op => ({ code: 'UNCHANGED_BODY_MISMATCH', message: `変更なしとされた「${op.name}」の本文が、現在のファイルと一致しません。登録していません。` }));
    }
    // Collapse the single customization PUT, then order explicit plan dependencies.
    function registrationOrder(steps, operations) {
      const js = steps.filter(isJavaScript), ids = new Set(js.map(s => s.id));
      if (!steps.some(s => !isJavaScript(s) && (s.dependsOn || []).some(id => ids.has(id)))) return { steps, ids: [] };
      const invalid = (code, message) => ({ steps, ids: [], reasons: [{ code, message }] });
      if (js.some(s => !operations.some(o => o.customizationId === (s.spec?.customizationId || s.id))))
        return invalid('REGISTRATION_MISSING', '先に必要なJavaScriptの検証済みの登録内容がありません。');
      const group = {}, nodes = new Map(), key = id => ids.has(id) ? group : id;
      for (const step of steps) {
        const k = key(step.id), n = nodes.get(k) || { steps: [], deps: new Set() };
        n.steps.push(step);
        for (const d of step.dependsOn || []) if (key(d) !== k || !ids.has(step.id)) n.deps.add(key(d));
        nodes.set(k, n);
      }
      const additions = new Set(operations.flatMap(o => [...(o.dependsOn?.fields || []), ...(o.dependsOn?.statuses || [])].map(x => x.stepId).filter(Boolean)));
      additions.forEach(id => nodes.get(group).deps.add(key(id)));
      const visiting = new Set(), done = new Set(), ordered = [];
      const visit = k => {
        if (done.has(k)) return;
        if (visiting.has(k)) throw new Error('cycle');
        if (!nodes.has(k)) throw new Error('missing');
        visiting.add(k); for (const d of nodes.get(k).deps) visit(d);
        visiting.delete(k); done.add(k); ordered.push(...nodes.get(k).steps);
      };
      try { for (const k of nodes.keys()) visit(k); }
      catch (e) { return invalid(e.message === 'cycle' ? 'REGISTRATION_ORDER_CONFLICT' : 'DEPENDENCY_MISSING',
        e.message === 'cycle' ? 'JavaScriptの一括登録の前後に、両立しない設定の依存関係があります。登録を複数回に分ける計画はまだ反映できません。' : '先に必要な手順が計画にありません。'); }
      return { steps: ordered, ids: js.map(s => s.id) };
    }
    async function prepare({ plan, artifacts, base, previousBase = null }) {
      const current = toCurrent(base), operations = fileOperations(artifacts, plan);
      if (previousBase && artifacts.length) {
        const verificationBasis = value => ({ fields: value.fields?.properties || {},
          status: { enable: value.status?.enable ?? false, states: value.status?.states ?? null, actions: value.status?.actions ?? null },
          scope: value.customize?.scope ?? null,
          files: (value.files || []).map(f => ({ target: f.target, name: f.name, text: f.text ?? null, sourceAvailable: f.sourceAvailable === true })),
          registrations: Object.fromEntries(['desktop', 'mobile'].map(target => [target, (value.customize?.[target]?.js || []).map(f => ({ type: f.type, name: f.file?.name ?? f.name ?? null, url: f.url ?? null }))])) });
        if (await hash(verificationBasis(toCurrent(previousBase))) !== await hash(verificationBasis(current))) {
          return { ok: false, settings: null, files: null, operations, changes: [], confirmations: [], unchanged: [], reasons: [{ code: 'VERIFICATION_CONTEXT_CHANGED',
            message: 'JavaScriptの検証に使ったフィールド・プロセス管理・登録済みJavaScriptが変わりました。このコードはそのまま反映できません。最新の設定で変更案を作り直してください。' }] };
        }
      }
      const identityReasons = fileIdentityReasons(operations, current);
      if (identityReasons.length) return { ok: false, settings: null, files: null, operations, changes: [], confirmations: [], unchanged: [], reasons: identityReasons };
      const order = registrationOrder(plan.steps || [], operations);
      if (order.reasons) return { ok: false, settings: null, files: null, operations, changes: [], confirmations: [], unchanged: [], reasons: order.reasons };
      const settings = await planExecutor.prepareOperations({ appId, operations: order.steps, registrationStepIds: order.ids, proposedFields: plan.proposedFields || [], requireFieldPlacement: true }, { api, current });
      const files = operations.length ? await jsExecutor.prepareFiles({ appId, operations, deferDependencies: true }, { api, current }) : null;
      const unchangedChecks = unchangedReasons(operations, files);
      const changes = [
        ...pending(settings).map(s => ({ id: s.stepId, kind: 'setting', title: s.title || '設定の変更', technicalSummary: s.prepared?.summary || '', placementDescription: s.prepared?.placementDescription || '', before: clone(s.prepared?.before ?? null), after: clone(s.prepared?.after ?? s.prepared?.expect ?? s.prepared?.payload), actionType: s.actionType })),
        ...pending(files).map(s => ({ id: s.changeId, kind: 'javascript', title: operations.find(o => o.id === s.changeId)?.summary || s.name, file: s.name, target: s.target, operation: s.kind }))
      ];
      if (order.ids.length) {
        const ranks = new Map(settings.steps.map((s, i) => [s.stepId, i]));
        const registrationRank = settings.steps.findIndex(s => order.ids.includes(s.stepId));
        changes.sort((a, b) => (a.kind === 'javascript' ? registrationRank : ranks.get(a.id)) - (b.kind === 'javascript' ? registrationRank : ranks.get(b.id)));
      }
      const confirmations = [
        ...(settings.steps || []).flatMap(s => (s.warnings || []).map((w, i) => ({ key: s.stepId + '-' + i, message: messageOf(w) }))),
        ...(files?.confirmations || []),
        ...(settings.warnings || []).map((w, i) => ({ key: 'settings-' + i, message: messageOf(w) })),
        ...(files?.warnings || []).map((w, i) => ({ key: 'files-' + i, message: messageOf(w) }))
      ].filter(x => x.message);
      return { ok: good(settings) && good(files) && !unchangedChecks.length, settings, files, operations, changes, confirmations,
        unchanged: (files?.unchanged || []).map(x => ({ title: x.name, message: x.message || '既存の内容と同じため、登録しません。' })),
        reasons: [...(settings.blockers || []), ...(files?.blockers || []), ...unchangedChecks].map(x => ({ code: x.code, message: x.message })) };
    }
    async function apply({ prepared, onProgress = () => {} }) {
      let settings = null, files = null, filesPrepared = prepared.files, writeInFlight = false, registrationFailure = null, registeredSnapshot = null;
      function resultRows() {
        const fileRows = (files?.steps || []).map(s => ({ title: s.name, status: s.status, message: s.message }));
        const ids = prepared.settings?.registrationStepIds || [];
        let inserted = false;
        const rows = (settings?.steps || []).flatMap(s => {
          const row = { title: s.title, status: s.status, message: s.message };
          if (!ids.includes(s.stepId)) return [row];
          const batch = inserted ? [] : fileRows;
          inserted = true;
          return s.status === 'FAILED' || !fileRows.length ? [...batch, row] : batch;
        });
        return inserted ? rows : [...rows, ...fileRows];
      }
      const result = (status, message) => ({ status, message, settings, files, filesPrepared,
        written: status === 'unknown' ? null : settingWritten(settings) || !!files?.put?.ok,
        rows: resultRows() });
      // Guard each later setting write against a concurrent replacement of the
      // prerequisite scripts. The mutation uses the same revision that was checked.
      const settingApi = { ...api };
      for (const name of ['addPreviewFields', 'updatePreviewFields', 'deletePreviewFields', 'putPreviewLayout', 'putPreviewViews', 'putPreviewGeneralNotifications', 'putPreviewPerRecordNotifications', 'putPreviewReminders', 'putPreviewStatus', 'putPreviewActions']) {
        if (typeof api[name] !== 'function') continue;
        settingApi[name] = async (app, body, revision) => {
          if (registeredSnapshot) {
            const current = jsExecutor.snapshotOf(await api.getPreviewCustomize(app));
            if (jsExecutor.diffSnapshots(registeredSnapshot, current).length)
              throw Object.assign(new Error('先に登録したJavaScriptが変更されたため、後続の設定変更を止めました。'), { code: 'REGISTERED_JAVASCRIPT_CHANGED' });
            if (revision == null || String(revision) !== String(current.revision))
              throw Object.assign(new Error('JavaScriptの登録を確認する間に設定が変わりました。後続の設定は変更していません。'), { code: 'REGISTRATION_REVISION_CHANGED' });
          }
          return api[name](app, body, revision);
        };
      }
      async function register() {
        if (!prepared.operations.length) return null;
        // Settings writes advance the common revision. Re-read actual state and preserve
        // the approved customization list/content before preparing its write.
        const fresh = await loadBase({ reason: 'before-registration' });
        if (!fresh?.ok) return result(settingWritten(settings) ? 'partial' : 'failed', '現在の設定を取得できないため、JavaScriptの登録を止めました。');
        const identityReasons = fileIdentityReasons(prepared.operations, toCurrent(fresh));
        if (identityReasons.length) return { ...result(settingWritten(settings) ? 'partial' : 'failed', 'JavaScriptの登録先が変わったため、登録を止めました。'), reasons: identityReasons };
        filesPrepared = await jsExecutor.prepareFiles({ appId, operations: prepared.operations,
          expectedRevision: prepared.files.snapshot?.revision, expectedContent: prepared.files.contentFingerprint,
          deferDependencies: false }, { api, current: toCurrent(fresh) });
        if (!good(filesPrepared)) return { ...result(settingWritten(settings) ? 'partial' : 'failed', '設定の反映後、JavaScriptを登録できませんでした。'), reasons: filesPrepared.blockers };
        const unchangedChecks = unchangedReasons(prepared.operations, filesPrepared);
        if (unchangedChecks.length) return { ...result(settingWritten(settings) ? 'partial' : 'failed', '変更なしとされたJavaScriptの本文が変わったため、登録を止めました。'), reasons: unchangedChecks };
        const sameOperations = await hash(pending(filesPrepared).map(s => [s.changeId, s.kind, s.target, s.name, s.verifiedContentHash || s.contentHash, s.baseHash, s.position]));
        const approvedOperations = await hash(pending(prepared.files).map(s => [s.changeId, s.kind, s.target, s.name, s.verifiedContentHash || s.contentHash, s.baseHash, s.position]));
        if (sameOperations !== approvedOperations) return result(settingWritten(settings) ? 'partial' : 'failed', '承認したJavaScriptと登録する内容が変わったため、登録を止めました。');
        if (await hash(filesPrepared.confirmations || []) !== await hash(prepared.files.confirmations || []) || await hash(requiredWarnings(filesPrepared)) !== await hash(requiredWarnings(prepared.files))) return result(settingWritten(settings) ? 'partial' : 'failed', 'JavaScriptの確認事項が変わったため、登録を止めました。内容を確認し直してください。');
        if (!pending(filesPrepared).length) { registeredSnapshot = clone(filesPrepared.snapshot); return null; }
        writeInFlight = true;
        files = await jsExecutor.executePreview(filesPrepared, { api, acknowledged: (prepared.files.confirmations || []).map(c => c.key),
          onProgress: execution => { files = execution; onProgress({ stage: 'javascript', status: execution.status }); } });
        writeInFlight = false;
        if (files.status !== 'DONE') return result(fileUnknown(files) ? 'unknown' : settingWritten(settings) || files.put?.ok ? 'partial' : files.previewUnchanged === true ? 'failed' : 'unknown', 'JavaScriptの登録結果を確認してください。完了していない内容があります。');

        registeredSnapshot = clone(files.actualAfterRaw);
        return null;
      }
      try {
        if (!prepared.ok) return result('failed', '反映する準備ができていません。');
        if (pending(prepared.settings).length) {
          writeInFlight = true;
          settings = await planExecutor.executePreview(prepared.settings, { api: settingApi,
            registerJavaScript: async () => {
              registrationFailure = await register();
              return registrationFailure ? { ok: false, message: registrationFailure.message } : { ok: true, revision: files?.afterRevision || filesPrepared?.snapshot?.revision };
            }, onProgress: (step, execution) => { settings = execution; onProgress({ stage: 'settings', title: step.title, status: step.status }); } });
          writeInFlight = false;
          if (registrationFailure) return { ...result(registrationFailure.status, registrationFailure.message), reasons: registrationFailure.reasons };
          if (settings.status !== 'DONE') return result(settingUnknown(settings) ? 'unknown' : settingWritten(settings) || files?.put?.ok ? 'partial' : 'failed', '設定の反映を完了できませんでした。反映した内容と、止まった手順を確認してください。');
        }
        if (!prepared.settings?.registrationStepIds?.length || !pending(prepared.settings).length) {
          const failed = await register();
          if (failed) return failed;
        }
        return result('complete', '動作テスト環境に反映しました。kintoneの画面で動作を確認してください。');
      } catch (error) {
        return { ...result(writeInFlight ? 'unknown' : settingWritten(settings) || files?.put?.ok ? 'partial' : 'failed', '反映の途中で処理を完了できませんでした。結果を確認してから次の操作を選んでください。'),
          error: { code: error?.code, message: error?.message } };
      }
    }
    async function recheckApply(run) {
      const original = run.result;
      let settings = clone(original?.settings || null), files = clone(original?.files || null);
      const answer = (status, recoveryState, message, written = null, reasons = []) => ({
        ...clone(original), status, recoveryState, message, written, retryable: status !== 'unknown',
        settings, files, reasons: [...(original?.reasons || []), ...reasons],
        rows: (run.prepared?.changes || []).map(change => {
          const step = change.kind === 'javascript' ? files?.steps?.find(x => x.changeId === change.id) : settings?.steps?.find(x => x.stepId === change.id);
          return { title: change.title || change.file, status: step?.status || 'SKIPPED', message: step?.message || 'この変更は実行していません。' };
        })
      });
      const unknown = message => answer('unknown', 'unknown', message);
      const changed = message => answer('unknown', 'changed', message, null, [{ code: 'APPLY_RESULT_CHANGED', message }]);
      if (!original || original.status !== 'unknown' || run.rollback || !run.prepared?.ok ||
          (run.prepared.settings && (run.prepared.settings.appId !== String(appId) || run.prepared.settings.env !== 'preview')) ||
          (run.prepared.files && (run.prepared.files.appId !== String(appId) || run.prepared.files.env !== 'preview')) ||
          (settings && (settings.appId !== String(appId) || settings.env !== 'preview')) ||
          (files && (files.appId !== String(appId) || files.env !== 'preview')))
        return unknown('対象の反映の記録を確認できません。');
      let settingsRevision = null, filesRevision = null;
      try {
        if (settings) {
          if (typeof planExecutor.recheckPreview !== 'function') return unknown('設定の送信記録を照合する処理がありません。');
          const checked = await planExecutor.recheckPreview(settings, run.prepared.settings, { api });
          if (checked.state === 'changed') return changed(checked.message);
          if (checked.state === 'unknown') return unknown(checked.message);
          settings = checked.execution; settingsRevision = checked.current?.fields?.revision;
        } else if (pending(run.prepared.settings).length) return unknown('設定の処理が止まった位置を確認できません。');
        const basis = original.filesPrepared || run.prepared.files;
        if (basis?.snapshot) {
          if (basis.appId !== String(appId) || basis.env !== 'preview' || (files && (files.executionId !== basis.executionId || jsExecutor.diffSnapshots(files.snapshot, basis.snapshot).length)))
            return unknown('承認したJavaScriptと登録の記録が一致しません。');
          const actual = await api.getPreviewCustomize(String(appId)), current = jsExecutor.snapshotOf(actual);
          filesRevision = current.revision;
          const before = files?.snapshot || basis.snapshot;
          if (!jsExecutor.diffSnapshots(before, current).length) {
            if (files?.put?.ok) return changed('登録済みのJavaScriptが、登録前の状態へ変更されています。');
            if (files) {
              files.previousOutcome ||= { status: files.status, put: clone(files.put), verification: clone(files.verification), error: clone(files.error), actualAfterRaw: clone(files.actualAfterRaw), afterRevision: files.afterRevision };
              files.previewUnchanged = true; files.status = 'FAILED';
              files.readback = { observed: true, state: 'not-applied', revision: current.revision };
              for (const step of files.steps || []) { step.status = 'FAILED'; step.reason = 'READBACK_NOT_APPLIED'; step.message = '現在の登録内容は、反映前のJavaScriptと一致しています。'; }
            }
          } else {
            if (!files?.put || !files.steps?.length || files.steps.some(s => !s.uploadKey))
              return changed('現在のJavaScriptが、登録前の記録と異なります。');
            const intended = jsExecutor.buildAfter(before, files.steps, Object.fromEntries(files.steps.map(s => [s.changeId, s.uploadKey])));
            if (jsExecutor.diffSnapshots(intended, current, { compareFileKey: false }).length)
              return changed('現在のJavaScriptの名前・対象・順序が、承認した登録内容と異なります。');
            const observed = clone(files), downloaded = {};
            for (const step of observed.steps) {
              const entry = current[step.target]?.js?.[step.position];
              if (!entry?.fileKey || typeof api.downloadFile !== 'function') return unknown('登録したJavaScriptの本文を照合できません。');
              downloaded[entry.fileKey] = await api.downloadFile(entry.fileKey);
              if (typeof downloaded[entry.fileKey] !== 'string') return unknown('登録したJavaScriptの本文を取得できません。');
              step.previousOutcome ||= { status: step.status, reason: step.reason, message: step.message, verification: clone(step.verification) };
              step.status = 'APPLIED';
            }
            observed.verification = jsExecutor.verifyAfter(observed, actual, { downloaded });
            if (!observed.verification.ok) return changed('現在のJavaScriptの本文または登録内容が、承認した内容と異なります。');
            observed.previousOutcome ||= { status: files.status, put: clone(files.put), verification: clone(files.verification), error: clone(files.error), actualAfterRaw: clone(files.actualAfterRaw), afterRevision: files.afterRevision };
            observed.put = { ...observed.put, ok: true, confirmedByReadback: true };
            observed.previewUnchanged = false; observed.status = 'DONE'; observed.actualAfterRaw = current; observed.afterRevision = current.revision;
            observed.readback = { observed: true, state: 'applied', revision: current.revision };
            for (const step of observed.steps) { step.reason = 'READBACK_MATCH'; step.message = '現在のJavaScriptが、承認した本文・対象・順序と一致しています。'; }
            files = observed;
          }
        } else if ((run.prepared.changes || []).some(c => c.kind === 'javascript')) return unknown('登録前のJavaScriptの記録がありません。');
        // Revisions are a consistency guard, not evidence that a request succeeded.
        const end = settingsRevision != null ? await api.getPreviewFields(String(appId)) : filesRevision != null ? await api.getPreviewCustomize(String(appId)) : null;
        if (!end || [settingsRevision, filesRevision].filter(x => x != null).some(x => String(x) !== String(end.revision)))
          return unknown('確認の途中で設定が変わったため、反映結果を確定できません。');
        const rows = answer('', '', '').rows, written = settingWritten(settings) || !!files?.put?.ok;
        if (!rows.length) return unknown('照合する変更内容がありません。');
        if (rows.every(row => row.status === 'VERIFIED')) return answer('complete', 'applied', '現在の設定とJavaScriptが、承認した反映内容と一致しています。', true);
        return written ? answer('partial', 'partial', '一部は承認した内容と一致し、残りは反映されていません。続きの書き込みは行っていません。', true) :
          answer('failed', 'not-applied', '現在の設定に、この反映の変更は入っていません。書き込みの再実行は行っていません。', false);
      } catch (error) {
        return { ...unknown('現在の設定を取得できず、反映の結果を確認できません。'), error: { ...clone(original.error), recheck: { code: error?.code, message: error?.message } } };
      }
    }
    // A completed script restoration remains part of this run when a later setting
    // restoration fails. Its exact readback must still match before skipping it.
    async function restoredFileReasons(run, restored) {
      if (!restored) return [];
      if (restored.status !== 'ROLLED_BACK_VERIFIED' || restored.verification?.restoredToSnapshot !== true ||
        restored.executionId !== run.result?.files?.executionId || restored.appId !== String(appId) ||
        restored.env !== run.result?.files?.env || !restored.restoredSnapshot) {
        return [{ code: 'ROLLBACK_EVIDENCE_MISMATCH', message: '戻し済みのJavaScriptの記録と、対象の反映が一致しません。' }];
      }
      const current = jsExecutor.snapshotOf(await api.getPreviewCustomize(String(appId)));
      return jsExecutor.diffSnapshots(restored.restoredSnapshot, current).length
        ? [{ code: 'ROLLBACK_STALE', message: 'JavaScriptを戻した後にカスタマイズ設定が変更されたため、残りの復元を止めました。現在の設定を確認してください。' }] : [];
    }
    async function prepareRollback(run) {
      const r = run.result;
      if (!r || r.status === 'unknown' || r.written == null || run.rollback?.status === 'unknown' || settingUnknown(r.settings) || fileUnknown(r.files)) return { ok: false, files: null, settings: null, changes: [], confirmations: [], reasons: [{ code: 'RESULT_UNKNOWN', message: '反映または復元の結果を確認できないため、自動では元に戻せません。現在の設定を確認してください。' }] };
      const restoredFiles = run.rollback?.files?.status === 'ROLLED_BACK_VERIFIED' ? clone(run.rollback.files) : null;
      const restoredReasons = await restoredFileReasons(run, restoredFiles);
      if (restoredReasons.length) return { ok: false, files: null, settings: null, restoredFiles, changes: [], confirmations: [], reasons: restoredReasons };
      const files = r.files?.put?.ok && !restoredFiles ? await jsExecutor.prepareRollback(clone(r.files), { api }) : null;
      const settings = settingWritten(r.settings) ? await planExecutor.prepareRollback(clone(r.settings), run.prepared.settings, { api }) : null;
      // Setting notes can describe the projected result of an earlier rollback step,
      // not the current settings. Keep those changes visible for approval; only the
      // verified script readback proves a change is already restored here.
      const restoredChanges = restoredFiles ? (run.prepared.changes || []).filter(change => change.kind === 'javascript') : [];
      return { ok: !!(files || settings) && good(files) && good(settings), files, settings, restoredFiles, restoredChanges,
        changes: (run.prepared.changes || []).filter(change => !restoredChanges.includes(change)), reasons: [...(files?.blockers || []), ...(settings?.blockers || [])],
        confirmations: [...(files?.warnings || []), ...(settings?.warnings || [])] };
    }
    // Observe transport outcomes even when an existing executor catches the error.
    function rollbackTransport() {
      const state = { written: false, uncertain: false };
      const rejected = e => /^(GAIA_|CB_)/.test(e?.code || '') || (e?.status >= 400 && e?.status < 500);
      const tracked = new Proxy(api, { get(target, key) {
        const fn = target[key]; if (typeof fn !== 'function') return fn;
        const read = String(key).startsWith('get') || key === 'downloadFile';
        const write = !read && key !== 'uploadFile';
        return async (...args) => {
          try { const result = await fn.apply(target, args); if (write) state.written = true; return result; }
          catch (error) { if ((write && !rejected(error)) || (read && state.written)) state.uncertain = true; throw error; }
        };
      } });
      return { api: tracked, state };
    }
    async function recheckRollback(run) {
      let files = clone(run.rollback?.files || null), settings = clone(run.rollback?.settings || null);
      const answer = (status, recoveryState, message, retryable = false, reasons = []) => ({ status, recoveryState, message, retryable, files, settings, reasons });
      const r = run.result;
      if (!run.rollback || !r || r.status === 'unknown' || !r.written ||
          (r.files && (r.files.appId !== String(appId) || r.files.env !== 'preview')) ||
          (r.settings && (r.settings.appId !== String(appId) || r.settings.env !== 'preview'))) {
        return answer('unknown', 'unknown', '対象の反映と復元の記録を確認できません。', false, [{ code: 'ROLLBACK_EVIDENCE_MISMATCH', message: '復元の対象を確認してください。' }]);
      }
      const states = [];
      try {
        if (r.files?.put?.ok) {
          const execution = r.files, before = execution.snapshot, after = execution.actualAfterRaw;
          if (!before || !after) return answer('unknown', 'unknown', 'JavaScriptの反映前後の記録がありません。');
          const current = jsExecutor.snapshotOf(await api.getPreviewCustomize(String(appId)));
          // A replacement receives a new file key. Compare its exact saved source;
          // every untouched entry must retain its identity and position.
          let restored = !jsExecutor.diffSnapshots(before, current, { compareFileKey: false }).length;
          if (restored) for (const target of ['desktop', 'mobile']) for (const kind of ['js', 'css']) {
            const entries = before[target]?.[kind] || [];
            for (let i = 0; i < entries.length; i++) {
              const entry = entries[i], actual = current[target][kind][i];
              if (entry.type !== 'FILE') continue;
              const replacement = kind === 'js' && execution.steps?.find(st => st.kind === 'REPLACE_FILE' && st.target === target && st.name === entry.name && st.position === i);
              if (replacement) {
                if (typeof replacement.currentSource !== 'string' || typeof api.downloadFile !== 'function') return answer('unknown', 'unknown', '戻す前のJavaScript本文を照合できません。');
                if (await api.downloadFile(actual.fileKey) !== replacement.currentSource) restored = false;
              } else if (entry.fileKey !== actual.fileKey) restored = false;
            }
          }
          if (restored) {
            files = { ...files, executionId: execution.executionId, appId: execution.appId, env: execution.env,
              status: 'ROLLED_BACK_VERIFIED', afterRollbackRevision: current.revision, restoredSnapshot: clone(current),
              verification: { restoredToSnapshot: true }, message: '現在のJavaScriptは反映前の内容と一致しています。' };
            states.push('restored');
          } else if (!jsExecutor.diffSnapshots(after, current).length) {
            files = { ...files, status: 'ROLLBACK_PENDING', restoredSnapshot: null, verification: null, message: 'JavaScriptは反映後の内容のままです。' };
            states.push('applied');
          } else return answer('partial', 'changed', 'JavaScriptが反映前後の記録と異なります。自動では元に戻しません。', false, [{ code: 'ROLLBACK_STALE', message: '現在のJavaScriptを確認してください。' }]);
        }
        if (settingWritten(r.settings)) {
          const checked = await planExecutor.prepareRollback(clone(r.settings), run.prepared.settings, { api, observe: true });
          settings = clone(checked);
          if (!good(checked)) {
            const unavailable = (checked.blockers || []).some(b => ['FETCH_FAILED', 'PERMISSION_DENIED', 'NO_SNAPSHOT', 'NO_ACTUAL_AFTER'].includes(b.code));
            return answer(unavailable ? 'unknown' : 'partial', unavailable ? 'unknown' : 'changed', unavailable ? '現在の設定を取得できず、復元の結果を確認できません。' : '反映前後の記録と異なる設定があります。自動では元に戻しません。', false, checked.blockers || []);
          }
          if (!Array.isArray(checked.observations) || checked.observations.length !== checked.steps.length) return answer('unknown', 'unknown', '設定の復元結果を照合できません。');
          const restored = checked.observations.filter(o => o.restored).length;
          settings.steps = checked.steps.map(step => ({ ...step, status: checked.observations.find(o => o.stepId === step.stepId)?.restored ? 'ROLLBACK_VERIFIED' : 'ROLLBACK_PENDING' }));
          settings.status = restored === checked.steps.length ? 'ROLLED_BACK_VERIFIED' : 'PREPARED';
          settings.verification = { restoredToSnapshot: restored === checked.steps.length };
          states.push(restored === checked.steps.length ? 'restored' : restored ? 'partial' : 'applied');
        }
        if (!states.length) return answer('unknown', 'unknown', '復元の対象を確認できません。');
        if (states.every(s => s === 'restored')) return answer('complete', 'restored', '現在の設定を確認し、この反映の変更が元に戻っていることを確認しました。');
        return answer('partial', states.every(s => s === 'applied') ? 'applied' : 'partial', states.every(s => s === 'applied') ? 'この反映の変更は、まだ元に戻っていません。戻す内容をもう一度確認できます。' : '一部の変更は元に戻っています。残りの内容をもう一度確認できます。', true);
      } catch (error) {
        return { ...answer('unknown', 'unknown', '現在の設定を取得できず、復元の結果を確認できません。'), error: { code: error?.code, message: error?.message } };
      }
    }
    async function rollback({ run, prepared, onProgress = () => {} }) {
      let files = clone(prepared.restoredFiles || null), settings = null, writeInFlight = false;
      const transport = rollbackTransport();
      const unknown = () => ({ status: 'unknown', files, settings, recoveryState: 'unknown', retryable: false, message: '復元の結果を確認できません。もう一度戻す前に、現在の設定を確認してください。' });
      try {
        if (!prepared.ok || run.result?.written == null || run.result?.status === 'unknown' || run.rollback?.status === 'unknown' ||
          (!!files !== (run.rollback?.files?.status === 'ROLLED_BACK_VERIFIED')) ||
          (prepared.files && (prepared.files.executionId !== run.result.files?.executionId || prepared.files.appId !== String(appId))) ||
          (prepared.settings && (prepared.settings.executionId !== run.result.settings?.executionId || prepared.settings.appId !== String(appId))) ||
          (files && (prepared.files || await hash(files) !== await hash(run.rollback?.files || null)))) return { status: 'failed', message: '元に戻す準備と対象の反映が一致しません。' };
        const restoredReasons = await restoredFileReasons(run, files);
        if (restoredReasons.length) return { status: 'partial', files, reasons: restoredReasons, message: 'JavaScriptを戻した後に設定が変わったため、残りを戻していません。' };
        if (prepared.files) {
          let readback = null;
          const rollbackApi = { ...transport.api, async getPreviewCustomize(...args) { const current = await transport.api.getPreviewCustomize(...args); readback = clone(current); return current; } };
          writeInFlight = true;
          files = await jsExecutor.executeRollback(prepared.files, { api: rollbackApi, execution: clone(run.result.files), onProgress: result => { files = result; onProgress(result); } });
          writeInFlight = false;
          if (transport.state.uncertain) return unknown();
          // Preserve the same response that the existing executor verified, not a later
          // read which could already contain another person's change.
          if (files.status === 'ROLLED_BACK_VERIFIED' && String(readback?.revision) === String(files.afterRollbackRevision)) files.restoredSnapshot = jsExecutor.snapshotOf(readback);
          if (files.status !== 'ROLLED_BACK_VERIFIED') return { status: 'partial', files, message: 'JavaScriptを戻す処理を完了できませんでした。設定を戻す処理は行っていません。' };
        }
        if (prepared.settings) {
          // Recheck after restoring scripts; revision changes alone must not reject the
          // settings rollback, but unrelated setting edits must still be detected.
          const checked = await planExecutor.prepareRollback(clone(run.result.settings), run.prepared.settings, { api });
          if (!good(checked)) return { status: 'partial', files, reasons: checked.blockers, message: '設定が変わったため、設定を戻す処理を止めました。' };
          if (await hash(requiredWarnings(checked)) !== await hash(requiredWarnings(prepared.settings))) return { status: files ? 'partial' : 'failed', files, message: '元に戻す際の確認事項が変わったため、設定を戻す処理を止めました。内容を確認し直してください。' };
          writeInFlight = true;
          settings = await planExecutor.executeRollback(checked, { api: transport.api, execution: clone(run.result.settings), onProgress: (step, result) => { settings = result; onProgress(step); } });
          writeInFlight = false;
          if (transport.state.uncertain) return unknown();
          if (settings.status !== 'ROLLED_BACK_VERIFIED') return { status: 'partial', files, settings, message: '設定を戻す処理を完了できませんでした。' };
        }
        return { status: 'complete', files, settings, message: 'この反映で変更した内容を元に戻しました。' };
      } catch (error) {
        return { status: writeInFlight ? 'unknown' : files ? 'partial' : 'failed', files, settings,
          message: writeInFlight ? '復元の結果を確認できません。再度戻さず、現在の設定を確認してください。' : '残りを戻すための確認を完了できませんでした。戻し済みの記録は残っています。',
          error: { code: error?.code, message: error?.message } };
      }
    }
    return { prepare, apply, prepareRollback, rollback, recheckRollback, recheckApply };
  }
  return { create };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = { KTReleaseExecution };
