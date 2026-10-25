/* Browser composition. Authentication, limits and preview executors are reused;
 * the former conversation/review/dual-pane state is not part of this path. */
'use strict';
function mountReleaseWorkspace(host, d) {
  const settings = d.settings || KTAiClient.createSettingsStore();
  const session = d.session || KTAiClient.createSession({ store: settings });
  const budget = d.budget || KTAiBudget.create();
  let capability = { available: false, features: {} }, healthAt = 0, healthPromise = null, latestBase = null, view = null;
  let baseQueue = Promise.resolve();
  let connectionError = '', initialHealth = d.initialHealth || null, connectionSettingsFailed = false;
  const esc = KTReleaseView.escape;
  const supportsRelease = (feature, cap) => !!cap?.available && (feature === KTAiClient.FEATURE_GENERATOR ? cap.verification?.includes('artifactOutcome') : feature === KTAiClient.FEATURE_PLANNER ? ['releaseWorkspace', 'formLayoutPlacement', 'fieldMaintenance'].every(mark => cap.requirementOps?.includes(mark)) : ['releaseWorkspace', 'appExplanation'].every(mark => cap.conversation?.includes(mark)));
  host.style.overflow = 'auto';
  host.style.height = '100%';
  function dialog(title, body, { wide = false } = {}) {
    const doc = host.ownerDocument || document, el = doc.createElement('dialog');
    el.className = 'kt-release-dialog' + (wide ? ' ktr-dialog-wide' : '');
    el.innerHTML = '<header class="ktr-dialog-header"><h2>' + esc(title) + '</h2><button type="button" data-close>閉じる</button></header>' + body;
    doc.body.appendChild(el);
    el.querySelector('[data-close]').addEventListener('click', () => el.close());
    el.addEventListener('close', () => el.remove(), { once: true });
    el.showModal();
    return el;
  }
  const connection = () => {
    const status = session.status(), generator = capability.features?.[KTAiClient.FEATURE_GENERATOR];
    const available = supportsRelease(KTAiClient.FEATURE, capability.features?.[KTAiClient.FEATURE]) && supportsRelease(KTAiClient.FEATURE_PLANNER, capability.features?.[KTAiClient.FEATURE_PLANNER]);
    return { connected: status.connected, available, canPlan: supportsRelease(KTAiClient.FEATURE_PLANNER, capability.features?.[KTAiClient.FEATURE_PLANNER]),
      canGenerate: supportsRelease(KTAiClient.FEATURE_GENERATOR, generator),
      message: connectionError || (!status.connected ? 'AIサービスへ接続してください。' : available ? 'AIサービスに接続しています。' : 'AIサービスを利用できません。接続とサービスの更新を確認してください。') };
  };
  async function refreshCapability(force = false) {
    if (connectionSettingsFailed) return capability;
    if (healthPromise) return healthPromise;
    if (!force && healthAt && Date.now() - healthAt < KTAiClient.HEALTH_TTL_MS) return capability;
    healthPromise = (async () => {
      try {
        const savedProbe = initialHealth; initialHealth = null;
        const probe = savedProbe ? await savedProbe() : null;
        // Boot's probe returns its own packet; a direct health refresh remains the same auth path.
        const health = probe?.health || (probe?.ok === true ? probe : await session.client.getHealth());
        capability = KTAiClient.capabilityFromHealth(health);
        healthAt = Date.now(); connectionError = '';
      } catch (e) {
        capability = { available: false, reason: e.code, features: {} };
        connectionError = KTAiClient.errorText(e.code) || '接続を確認できませんでした。作成した内容はこの画面に残っています。';
      } finally { healthPromise = null; view?.render(); }
      return capability;
    })();
    return healthPromise;
  }
  async function requireFeature(feature) {
    await refreshCapability();
    const cap = capability.features?.[feature];
    if (!supportsRelease(feature, cap)) {
      throw Object.assign(new Error('接続先のAIサービスが、この作業に必要な機能に対応していません。接続先とサービスの更新を確認してください。'), { code: 'CAPABILITY_OUTDATED' });
    }
  }
  async function loadBase(options = {}) {
    // An explicit operation always gets its own fresh read, never joins an older request.
    const next = baseQueue.catch(() => {}).then(async () => {
      const b = await d.loadDevBase(options);
      if (b?.ok) {
        b.stamp = KTDevBase.stamp(b); b.current = KTDevBase.currentOf(b);
        latestBase = b;
      }
      return b;
    });
    baseQueue = next; return next;
  }
  const client = budget.wrap(session.client, { limits: () => capability.limits });
  const services = {
    async propose(input) {
      await requireFeature(KTAiClient.FEATURE);
      await requireFeature(KTAiClient.FEATURE_PLANNER);
      const ctx = KTReleaseContext.proposal(input);
      const r = await client.propose({ ctx, signal: input.signal, deadlineMs: capability.limits?.deadlineMs?.[KTAiClient.FEATURE] });
      return { ...r, facts: ctx.facts };
    },
    async plan(input) {
      await requireFeature(KTAiClient.FEATURE_PLANNER);
      const r = await client.plan({ ctx: KTReleaseContext.plan(input), signal: input.signal, deadlineMs: capability.limits?.deadlineMs?.[KTAiClient.FEATURE_PLANNER] });
      return { plan: r };
    },
    async generate(input) {
      await requireFeature(KTAiClient.FEATURE_GENERATOR);
      try {
        const r = await client.generate({ ctx: KTReleaseContext.generator(input), signal: input.signal, onEvent: input.onProgress, deadlineMs: capability.limits?.deadlineMs?.[KTAiClient.FEATURE_GENERATOR] });
        return { generated: r, verification: r.verification, artifactOutcome: r.artifactOutcome };
      } catch (error) {
        const outcome = error?.details?.artifactOutcome;
        if (outcome) return { artifactOutcome: outcome, generated: null, verification: null, error: error.details.error || null };
        throw error;
      }
    }
  };
  const execution = KTReleaseExecution.create({ appId: String(d.appId), api: d.executor?.api, loadBase, currentOf: KTDevBase.currentOf,
    planExecutor: KTPlanExecutor, jsExecutor: KTJsExecutor, hash: KTReleaseWorkspace.hash });
  const controller = KTReleaseWorkspace.create({ services, loadBase, execution });
  const notifiedResults = new Set();
  controller.subscribe(state => {
    const run = state.runs.find(r => r.id === state.resultRunId);
    const key = run && run.id + ':' + (run.rollback?.status || 'applied');
    if (state.phase === 'result' && run && (run.result?.written || run.result?.written === null || run.status === 'unknown') && !notifiedResults.has(key)) {
      notifiedResults.add(key);
      latestBase = null;
      d.onSettingsChanged?.({ preview: true, production: false, source: 'ai' });
    }
  });
  function consent() {
    if (settings.hasConsent('release-raw-source-1')) return Promise.resolve(true);
    return new Promise(resolve => {
      const el = dialog('AIサービスへ送信する内容', '<p>依頼文、アプリの設定、登録されているJavaScriptの本文を送信します。レコードの値、添付ファイル、接続の認証情報は送信しません。</p><p>生成した内容は、確認して反映するまでkintoneに登録しません。</p><button type="button" data-consent>送信する（次回から確認しない）</button>');
      let agreed = false;
      el.querySelector('[data-consent]').addEventListener('click', () => { agreed = true; settings.setConsent(true, 'release-raw-source-1'); el.close(); });
      el.addEventListener('close', () => resolve(agreed), { once: true });
    });
  }
  let flow = null, connectionBusy = false;
  const connectionDialogs = new Set();
  const updateConnections = () => { for (const render of connectionDialogs) render(); };
  function verificationSettings(el) {
    const panel = el.querySelector('[data-budget-panel]');
    if (!panel) return;
    const status = panel.querySelector('[data-budget-status]'), id = panel.querySelector('[data-budget-id]');
    const save = panel.querySelector('[data-budget-start]'), note = panel.querySelector('[data-budget-note]');
    let saving = false;
    const canConfigure = () => {
      const state = controller.getState();
      return state.phase === 'idle' && state.messages.length === 0;
    };
    const render = () => {
      const current = budget.summary();
      status.textContent = current.enabled ? KTAiBudget.summaryText(current) : '検証用の利用上限は設定されていません。';
      id.textContent = current.id ? '検証枠: ' + current.id : '';
      save.disabled = saving || !canConfigure();
      panel.querySelectorAll('input').forEach(input => { input.disabled = save.disabled; });
      note.textContent = canConfigure() ? '会話を始める前に設定します。過去の利用記録は残ります。' : '会話の途中で新しい検証枠には切り替えられません。';
    };
    save.addEventListener('click', async () => {
      if (saving || !canConfigure()) return;
      saving = true; render();
      const message = panel.querySelector('[data-budget-message]');
      message.textContent = '';
      try {
        await budget.configure({ limitUsd: panel.querySelector('[data-budget-usd]').value, maxCalls: panel.querySelector('[data-budget-calls]').value }, canConfigure);
        message.textContent = '新しい検証枠を設定しました。上の上限と回数を確認してください。';
      } catch (error) {
        message.textContent = error?.details?.budget?.reason === 'in-flight' ? '処理中の要求があるため、検証枠を変更できません。' : '検証枠を設定できませんでした。入力した値と設定の状態を確認してください。';
      } finally { saving = false; render(); }
    });
    const offBudget = budget.subscribe(render), offState = controller.subscribe(render);
    el.addEventListener('close', () => { offBudget(); offState(); }, { once: true });
    render();
  }
  function connectionDialog() {
    const staging = 'https://appinsight-ai-api-staging.black-waterfall-157a.workers.dev';
    const verification = typeof budget.configure === 'function' ? '<details data-budget-panel><summary>開発者向け：検証用の設定</summary><p data-staging-note></p><button type="button" data-staging-select>検証用の接続先（staging）に切り替える</button><p data-budget-status></p><p class="ktr-note" data-budget-id></p><label>上限（米ドル） <input data-budget-usd type="number" min="0" step="0.01" value="1.00"></label><label> AIの呼び出し上限（回） <input data-budget-calls type="number" min="0" step="1" value="8"></label><p class="ktr-note" data-budget-note></p><button type="button" data-budget-start>新しい検証枠を設定</button><p data-budget-message role="status"></p></details>' : '';
    const el = dialog('AIサービスとの接続', '<p data-message>' + esc(connection().message) + '</p><p data-connection-base></p><div style="display:flex;gap:10px;flex-wrap:wrap"><button data-connect>接続する</button><button data-refresh>接続を更新</button><button data-disconnect>接続を解除</button></div><p data-link></p>' + verification);
    verificationSettings(el);
    const message = t => { el.querySelector('[data-message]').textContent = t; };
    const stagingReason = () => {
      const status = session.status(), saved = settings.load(), state = controller.getState();
      if (status.apiBase === staging && saved.apiBase === staging && !connectionSettingsFailed) return '検証用の接続先（staging）が設定されています。変更は不要です。';
      if (connectionBusy || healthPromise || flow?.isRunning() || budget.summary().inFlight > 0) return '処理が終わってから接続先を切り替えてください。';
      // An expired refresh or a live in-memory access token must never move to another service.
      if (status.connected || status.accessExpiresAt || saved.refreshToken || saved.refreshAttempt) return '接続情報が残っています。接続を解除してから切り替えてください。';
      if (state.phase !== 'idle' || state.messages.length) return '会話を終え、新しい相談を始める前に接続先を切り替えてください。';
      return '';
    };
    const render = () => {
      el.querySelector('[data-connection-base]').textContent = '接続先: ' + session.status().apiBase;
      el.querySelector('[data-connect]').disabled = connectionBusy || !!healthPromise || connectionSettingsFailed;
      el.querySelector('[data-refresh]').disabled = connectionBusy || connectionSettingsFailed;
      el.querySelector('[data-disconnect]').disabled = connectionBusy;
      const select = el.querySelector('[data-staging-select]');
      if (select) {
        const reason = stagingReason();
        select.disabled = !!reason;
        el.querySelector('[data-staging-note]').textContent = reason || '未接続で会話を始める前だけ切り替えられます。切り替えた後に［接続する］を押してください。';
      }
    };
    el.querySelector('[data-staging-select]')?.addEventListener('click', () => {
      if (stagingReason()) { render(); return; }
      try {
        // Save only the endpoint: neither credentials nor refresh-in-progress state are copied.
        if (settings.save({ apiBase: staging }) !== true) throw new Error('Settings were not saved');
        const saved = settings.load();
        if (saved.apiBase !== staging || session.status().apiBase !== staging || saved.refreshToken || saved.refreshAttempt || saved.scope || saved.connectedAt || saved.refreshExpiresAt) throw new Error('Settings readback differs');
        connectionSettingsFailed = false;
        capability = { available: false, features: {} }; healthAt = 0; initialHealth = null; connectionError = '';
        message('検証用の接続先（staging）に切り替えました。［接続する］から接続してください。');
      } catch (_) {
        connectionSettingsFailed = true;
        capability = { available: false, features: {} }; healthAt = 0; initialHealth = null;
        connectionError = '接続先の保存を確認できませんでした。接続は開始していません。保存できる状態か確認し、もう一度切り替えてください。';
        message(connectionError);
      }
      render(); view.render();
    });
    el.querySelector('[data-refresh]').addEventListener('click', async () => {
      if (connectionBusy || connectionSettingsFailed) return;
      connectionBusy = true; render();
      try { await refreshCapability(true); message(connection().message); }
      finally { connectionBusy = false; updateConnections(); }
    });
    el.querySelector('[data-disconnect]').addEventListener('click', async () => {
      if (connectionBusy) return;
      connectionBusy = true; render();
      try {
        flow?.cancel(); await session.disconnect();
        capability = { available: false, features: {} }; healthAt = 0; initialHealth = null; connectionError = '';
        message('接続を解除しました。作成した内容はこの画面に残っています。'); view.render();
      } finally { connectionBusy = false; updateConnections(); }
    });
    el.querySelector('[data-connect]').addEventListener('click', async () => {
      if (connectionBusy || healthPromise || connectionSettingsFailed) return;
      connectionBusy = true; render();
      let popup = null;
      try { popup = window.open('about:blank', '_blank'); if (popup) popup.opener = null; } catch (_) {}
      flow = flow || KTAiClient.createConnectFlow({ session, openUrl: url => {
        if (popup && !popup.closed) { popup.location.href = url; return true; }
        const area = el.querySelector('[data-link]'), link = el.ownerDocument.createElement('a');
        link.href = url; link.target = '_blank'; link.rel = 'noopener'; link.textContent = '承認ページを開く'; area.replaceChildren(link); return false;
      } });
      try { await flow.start({ onState: state => { message(state.phase === 'pending' ? '開いたページで接続を承認してください。' : '接続を準備しています。'); render(); } }); await refreshCapability(true); message(connection().message); }
      catch (e) { message(KTAiClient.errorText(e.code) || '接続を完了できませんでした。'); try { popup?.close(); } catch (_) {} }
      finally { connectionBusy = false; flow = null; updateConnections(); }
    });
    const offState = controller.subscribe(render), offBudget = budget.subscribe(render);
    connectionDialogs.add(render);
    window.addEventListener('storage', render);
    el.addEventListener('close', () => { if (flow?.isRunning()) flow.cancel(); else flow = null; connectionDialogs.delete(render); offState(); offBudget(); window.removeEventListener('storage', render); });
    render();
  }
  function documents({ request, canRequest, hasDraft }) {
    const templates = [
      { id: 'overview', title: 'アプリの概要', description: '初めて使う人に、主な入力項目や自動処理を説明します。', prompt: 'このアプリの概要を、初めて使う人にも分かるように説明してください。主な入力項目、画面の使い方、自動計算・自動入力、プロセス管理の流れを整理してください。' },
      { id: 'specification', title: 'アプリ仕様書', description: 'フィールド・一覧・プロセス管理など、設定を整理します。', prompt: 'このアプリの仕様書を作成してください。フィールドと配置、一覧、プロセス管理、アクセス権、通知、JavaScriptによる動作を、確認できる設定に基づいて整理してください。' },
      { id: 'instructions', title: '操作説明', description: '入力から保存・承認まで、利用者の操作をまとめます。', prompt: 'このアプリを使う人向けの操作説明を作成してください。レコードの入力・保存・プロセス管理の操作、入力時の注意、PCとモバイルの違いを、実際に確認できる設定とコードに基づいて整理してください。' },
      { id: 'handover', title: '引継ぎ資料', description: '後任者に、設定や自動処理、確認すべき点を伝えます。', prompt: 'このアプリを後任の担当者へ引き継ぐ資料を作成してください。この会話で説明した内容も踏まえ、主な入力項目、計算式・自動入力、プロセス管理、アクセス権、PCとモバイルの違い、運用上の確認事項を整理してください。' },
      { id: 'changes', title: '変更内容のまとめ', description: '相談で決めた内容と、反映済み・未反映の違いを整理します。', prompt: 'この会話の変更内容を資料にまとめてください。最新の修正・取り消しを反映した採用内容、変更前後、反映や復元の結果、未反映の内容を区別してください。採用した案や実行の記録がない場合は、その旨を明記し、仮案を採用済みや反映済みとして書かないでください。' }
    ];
    const el = dialog('資料を作る', '<p>テンプレートを選ぶと、AIがこのアプリの設定と相談内容をもとに資料を作ります。作成後も相談欄で内容を調整できます。</p><fieldset class="ktr-template-grid"><legend>資料の種類</legend>' + templates.map((t, i) => '<label class="ktr-template-choice"><input type="radio" name="document-template" value="' + t.id + '"' + (i === 0 ? ' checked' : '') + '><span><strong>' + t.title + '</strong><small>' + t.description + '</small></span></label>').join('') + '</fieldset><label>追加の希望（任意）<textarea data-document-extra rows="3" placeholder="例：初めて使う担当者向けに、専門用語を少なくしてください。"></textarea></label><p data-document-status role="status"></p><button type="button" data-document-create>AIで作成</button><details data-offline-materials><summary>AIを使わずに書き出す</summary><p>設定資料や、外部のAIへ渡す資料を作れます。Markdown・JSONなどの形式を選べます。</p><button type="button" data-offline-export>設定資料を書き出す</button></details>', { wide: true });
    let pending = false;
    const update = () => {
      el.querySelector('[data-document-create]').disabled = pending || !canRequest();
      el.querySelector('[data-document-status]').textContent = !canRequest() ? '作成するには、接続と現在の作業の状態を確認してください。処理中の場合は、完了してから作成できます。' : hasDraft() ? '相談欄の入力は送信せず、そのまま残します。' : '［AIで作成］を押すと、AIサービスに依頼します。';
    };
    update();
    const unsubscribe = controller.subscribe(update);
    el.addEventListener('close', unsubscribe, { once: true });
    el.querySelector('[data-document-create]').addEventListener('click', async () => {
      if (pending || !canRequest()) { update(); return; }
      const template = templates.find(t => t.id === el.querySelector('input[name="document-template"]:checked').value);
      const extra = el.querySelector('[data-document-extra]').value.trim();
      const prompt = template.prompt + '\n資料の作成だけを依頼しています。設定変更の提案や反映は行わないでください。現在の設定、採用済みで未反映の内容、実行結果を区別し、確認できないことは推測せず未確認としてください。kintone標準の用語を使い、同じ説明や不要な補足を繰り返さずにまとめてください。' + (extra ? '\n追加の希望：' + extra : '');
      pending = true; update();
      try {
        const started = await request(prompt, () => el.close());
        if (!started && el.open) el.querySelector('[data-document-status]').textContent = '資料の作成は開始していません。必要な場合は、もう一度［AIで作成］を押してください。';
      } catch (error) { if (el.open) el.querySelector('[data-document-status]').textContent = error.message || '資料の作成を開始できませんでした。'; }
      finally { pending = false; if (el.open) el.querySelector('[data-document-create]').disabled = !canRequest(); }
    });
    el.querySelector('[data-offline-export]').addEventListener('click', () => { el.close(); freeContext(); });
  }
  function freeContext() {
    const state = controller.getState(), kinds = KTContextUi.DOCUMENT_KINDS;
    let inputs = d.getInputs?.() || {};
    const targets = KTContextUi.listTargets(inputs);
    const choices = [...targets.fields.map(f => ({ type: 'field', id: f.id, label: f.label })), ...targets.files.map(f => ({ type: 'file', id: f.id, label: f.label }))];
    const el = dialog('設定資料を書き出す', '<p>この操作ではAIサービスへ送信しません。レコードの値・添付ファイルは含めません。</p><label>資料の種類 <select data-kind><option value="context">外部AIへの相談用</option><option value="planner">外部AIへの変更計画用</option>' + kinds.map(k => '<option value="' + esc(k.id) + '">' + esc(k.label) + '</option>').join('') + '</select></label><label> 対象 <select data-focus><option value="">アプリ全体</option>' + choices.map((f, i) => '<option value="' + i + '">' + esc(f.label) + '</option>').join('') + '</select></label><p><label>依頼文 <textarea data-question rows="3" style="width:100%"></textarea></label></p><button data-make>資料を作る</button>' + (d.runScan && !inputs.scan ? ' <button data-scan>JavaScriptを解析する</button>' : '') + '<p data-note style="white-space:pre-wrap" role="status"></p><details data-coverage hidden><summary>資料に含めた情報</summary><ul></ul></details><label>形式 <select data-format><option value="markdown">Markdown</option><option value="prompt">AIへの指示</option><option value="json">JSON</option></select></label><textarea data-output rows="15" readonly style="width:100%;font:12px/1.5 monospace"></textarea><div><button data-copy disabled>コピー</button> <button data-save disabled>ファイルで保存</button></div>', { wide: true });
    let outputs = null;
    const output = () => { el.querySelector('[data-output]').value = outputs?.[el.querySelector('[data-format]').value] || ''; };
    const resetOutput = () => { outputs = null; output(); el.querySelector('[data-copy]').disabled = true; el.querySelector('[data-save]').disabled = true; el.querySelector('[data-coverage]').hidden = true; };
    el.querySelector('[data-make]').addEventListener('click', () => {
      resetOutput();
      try {
        const kind = el.querySelector('[data-kind]').value, question = el.querySelector('[data-question]').value, field = el.querySelector('[data-focus]').value;
        let result;
        if (kind === 'context' || kind === 'planner') {
          const focus = field === '' ? null : choices[Number(field)];
          result = kind === 'planner' ? KTContextUi.generatePlan({ goal: question, inputs }) : KTContextUi.generate({ targetType: focus?.type || 'app', targetId: focus?.id, targetLabel: focus?.label, question, inputs });
        } else {
          const last = state.runs.findLast(run => run.taskId === state.taskId && run.approval?.version === state.version);
          const version = state.plan ? { plan: state.plan, goal: state.goal, version: state.version,
            acceptedProposal: state.adopted ? { revision: state.version, proposal: state.adopted } : null,
            answerHistory: state.answers, requestHistory: state.messages.filter(m => m.role === 'user').map(m => m.text), status: last?.rollback?.status === 'complete' ? 'ROLLED_BACK' : last?.status === 'complete' ? 'EXECUTED' : 'ACTIVE' } : null;
          result = KTContextUi.generateDocument({ kind, inputs, version, execState: { execution: last?.result?.settings, rollback: last?.rollback?.settings }, jsExecState: { execution: last?.result?.files, rollback: last?.rollback?.files } });
        }
        if (!result.ok) {
          for (const candidate of result.candidates || []) if (!choices.some(c => c.type === candidate.type && c.id === candidate.id)) {
            const index = choices.push(candidate) - 1, option = el.ownerDocument.createElement('option');
            option.value = String(index); option.textContent = candidate.label; el.querySelector('[data-focus]').appendChild(option);
          }
          throw new Error(result.message);
        }
        outputs = result.outputs;
        el.querySelector('[data-note]').textContent = ['資料を作成しました。外部へ送信する前に内容を確認してください。', ...(result.warnings || []), ...(result.truncation?.applied ? [result.truncation.message, ...(result.truncation.details || [])] : [])].join('\n');
        const coverage = el.querySelector('[data-coverage]'); coverage.hidden = false;
        coverage.querySelector('ul').innerHTML = (result.coverage || []).map(row => '<li>' + esc(row.label) + ': ' + (row.included ? '含めました' : '含めていません') + (row.reason ? '（' + esc(row.reason) + '）' : '') + '</li>').join('');
        el.querySelector('[data-copy]').disabled = false; el.querySelector('[data-save]').disabled = false; output();
      } catch (error) { el.querySelector('[data-note]').textContent = error.message; }
    });
    el.querySelector('[data-kind]').addEventListener('change', () => { resetOutput(); el.querySelector('[data-focus]').disabled = el.querySelector('[data-kind]').value !== 'context'; });
    el.querySelector('[data-focus]').addEventListener('change', resetOutput);
    el.querySelector('[data-question]').addEventListener('input', resetOutput);
    el.querySelector('[data-scan]')?.addEventListener('click', async event => {
      const button = event.currentTarget; button.disabled = true;
      try {
        await d.runScan(); inputs = d.getInputs?.() || inputs;
        const focus = el.querySelector('[data-focus]'), selected = focus.value === '' ? null : choices[Number(focus.value)], updated = KTContextUi.listTargets(inputs);
        choices.splice(0, choices.length, ...updated.fields.map(f => ({ type: 'field', id: f.id, label: f.label })), ...updated.files.map(f => ({ type: 'file', id: f.id, label: f.label })));
        focus.innerHTML = '<option value="">アプリ全体</option>' + choices.map((f, i) => '<option value="' + i + '">' + esc(f.label) + '</option>').join('');
        const index = choices.findIndex(f => f.type === selected?.type && f.id === selected?.id); focus.value = index < 0 ? '' : String(index);
        resetOutput(); el.querySelector('[data-note]').textContent = '解析結果を更新しました。資料を作り直してください。';
      }
      catch (error) { el.querySelector('[data-note]').textContent = error.message; }
      finally { button.disabled = false; }
    });
    el.querySelector('[data-format]').addEventListener('change', output);
    el.querySelector('[data-copy]').addEventListener('click', () => d.copyText(el.querySelector('[data-output]').value));
    el.querySelector('[data-save]').addEventListener('click', () => d.downloadText('app-context.' + (el.querySelector('[data-format]').value === 'json' ? 'json' : 'md'), el.querySelector('[data-output]').value, 'text/plain'));
  }
  function details() {
    const b = latestBase;
    const el = dialog('アプリの情報', b ? '<p>動作テスト環境の設定の版: ' + esc(b.revision?.preview) + '</p><p>運用環境へ未反映の変更: ' + esc(b.diff?.items?.length ?? b.diff?.length ?? b.diff?.count ?? '未確認') + '</p><details><summary>現在の設定の詳細</summary><pre style="white-space:pre-wrap"></pre></details>' : '<p>この作業では、まだ動作テスト環境の設定を取得していません。</p>', { wide: true });
    if (b) el.querySelector('pre').textContent = JSON.stringify({ appId: b.appId, revision: b.revision, diff: b.diff }, null, 2);
  }
  view = KTReleaseView.create(host, { controller, connection, beforeSend: consent, onConnect: connectionDialog, onRefreshConnection: () => refreshCapability(true), onDocuments: documents, onDetails: details,
    onCopy: d.copyText, onDownload: (name, text, type = 'text/javascript') => d.downloadText(name, text, type),
    onOpenPreview: d.onOpenPreview || (/^\d+$/.test(String(d.appId)) && !location.pathname.startsWith('/k/guest/') ? () => window.open(location.origin + '/k/admin/preview/' + encodeURIComponent(d.appId) + '/', '_blank', 'noopener') : null),
    appName: d.getInputs?.()?.data?.appName || 'アプリの相談' });
  const warnBeforeLeave = event => {
    const state = controller.getState();
    if (state.messages.length || state.runs.length) { event.preventDefault(); event.returnValue = ''; }
  };
  window.addEventListener('beforeunload', warnBeforeLeave);
  return { controller, view, capability: () => capability, refreshCapability,
    onVisible() { view.onVisible(); if (d.canAutoFetch?.() !== false && session.status().connected) refreshCapability(); },
    invalidateDevBase() { latestBase = null; }, refreshTargets() { view.render(); },
    consult(seed) { if (!controller.newTask()) return { ok: false, message: '処理が終わってから相談してください。' }; const input = host.querySelector('#kt-release-input'); if (input) { input.value = '「' + (seed?.name || seed?.subject?.name || 'このJavaScript') + '」について相談したいです。'; input.dispatchEvent(new Event('input', { bubbles: true })); input.focus(); } return { ok: true }; },
    dispose() { flow?.cancel(); controller.cancel(); window.removeEventListener('beforeunload', warnBeforeLeave); view.dispose(); }
  };
}
if (typeof module !== 'undefined' && module.exports) module.exports = { mountReleaseWorkspace };
