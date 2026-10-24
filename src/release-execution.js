/* Coordinates preview-only writes using the same approved operations and real readback. */
'use strict';
const KTReleaseExecution = (() => {
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const messageOf = item => item?.message || item?.summary || '';
  const good = prepared => !prepared || prepared.status === 'PREPARED';
  const pending = prepared => (prepared?.changes || prepared?.steps || []).filter(s => s.status === 'PENDING');
  const settingWritten = result => !!result?.steps?.some(s => ['APPLIED', 'VERIFIED', 'VERIFY_FAILED'].includes(s.status) || (s.status === 'FAILED' && !!s.partial));
  const settingUnknown = result => !!result?.steps?.some(s => s.status === 'FAILED' && !s.partial && s.reason === 'API_ERROR' && !/^(GAIA_|CB_)/.test(s.error?.code || '') && !(s.error?.status >= 400 && s.error?.status < 500));
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
    async function prepare({ plan, artifacts, base }) {
      const current = toCurrent(base), operations = fileOperations(artifacts, plan);
      const identityReasons = fileIdentityReasons(operations, current);
      if (identityReasons.length) return { ok: false, settings: null, files: null, operations, changes: [], confirmations: [], unchanged: [], reasons: identityReasons };
      const settings = await planExecutor.prepareOperations({ appId, operations: plan.steps || [], proposedFields: plan.proposedFields || [] }, { api, current });
      const files = operations.length ? await jsExecutor.prepareFiles({ appId, operations, deferDependencies: true }, { api, current }) : null;
      const unchangedChecks = unchangedReasons(operations, files);
      const changes = [
        ...pending(settings).map(s => ({ id: s.stepId, kind: 'setting', title: s.title || '設定の変更', technicalSummary: s.prepared?.summary || '', before: clone(s.prepared?.before ?? null), after: clone(s.prepared?.after ?? s.prepared?.expect ?? s.prepared?.payload), actionType: s.actionType })),
        ...pending(files).map(s => ({ id: s.changeId, kind: 'javascript', title: operations.find(o => o.id === s.changeId)?.summary || s.name, file: s.name, target: s.target, operation: s.kind }))
      ];
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
      let settings = null, files = null, filesPrepared = prepared.files, writeInFlight = false;
      const result = (status, message) => ({ status, message, settings, files, filesPrepared,
        written: status === 'unknown' ? null : settingWritten(settings) || !!files?.put?.ok,
        rows: [...(settings?.steps || []).map(s => ({ title: s.title, status: s.status, message: s.message })),
          ...(files?.steps || []).map(s => ({ title: s.name, status: s.status, message: s.message }))] });
      try {
        if (!prepared.ok) return result('failed', '反映する準備ができていません。');
        if (pending(prepared.settings).length) {
          writeInFlight = true;
          settings = await planExecutor.executePreview(prepared.settings, { api, onProgress: (step, execution) => { settings = execution; onProgress({ stage: 'settings', title: step.title, status: step.status }); } });
          writeInFlight = false;
          if (settings.status !== 'DONE') return result(settingUnknown(settings) ? 'unknown' : settingWritten(settings) ? 'partial' : 'failed', '設定の反映を完了できませんでした。反映した内容と、止まった手順を確認してください。');
        }
        if (pending(prepared.files).length) {
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
          writeInFlight = true;
          files = await jsExecutor.executePreview(filesPrepared, { api, acknowledged: (prepared.files.confirmations || []).map(c => c.key),
            onProgress: execution => { files = execution; onProgress({ stage: 'javascript', status: execution.status }); } });
          writeInFlight = false;
          if (files.status !== 'DONE') return result(fileUnknown(files) ? 'unknown' : settingWritten(settings) || files.put?.ok ? 'partial' : files.previewUnchanged === true ? 'failed' : 'unknown', 'JavaScriptの登録結果を確認してください。完了していない内容があります。');
        }
        return result('complete', '動作テスト環境に反映しました。kintoneの画面で動作を確認してください。');
      } catch (error) {
        return { ...result(writeInFlight ? 'unknown' : settingWritten(settings) || files?.put?.ok ? 'partial' : 'failed', '反映の途中で処理を完了できませんでした。結果を確認してから次の操作を選んでください。'),
          error: { code: error?.code, message: error?.message } };
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
    async function rollback({ run, prepared, onProgress = () => {} }) {
      let files = clone(prepared.restoredFiles || null), settings = null, writeInFlight = false;
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
          const rollbackApi = { ...api, async getPreviewCustomize(...args) { const current = await api.getPreviewCustomize(...args); readback = clone(current); return current; } };
          writeInFlight = true;
          files = await jsExecutor.executeRollback(prepared.files, { api: rollbackApi, execution: clone(run.result.files), onProgress: result => { files = result; onProgress(result); } });
          writeInFlight = false;
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
          settings = await planExecutor.executeRollback(checked, { api, execution: clone(run.result.settings), onProgress: (step, result) => { settings = result; onProgress(step); } });
          writeInFlight = false;
          if (settings.status !== 'ROLLED_BACK_VERIFIED') return { status: 'partial', files, settings, message: '設定を戻す処理を完了できませんでした。' };
        }
        return { status: 'complete', files, settings, message: 'この反映で変更した内容を元に戻しました。' };
      } catch (error) {
        return { status: writeInFlight ? 'unknown' : files ? 'partial' : 'failed', files, settings,
          message: writeInFlight ? '復元の結果を確認できません。再度戻さず、現在の設定を確認してください。' : '残りを戻すための確認を完了できませんでした。戻し済みの記録は残っています。',
          error: { code: error?.code, message: error?.message } };
      }
    }
    return { prepare, apply, prepareRollback, rollback };
  }
  return { create };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = { KTReleaseExecution };
