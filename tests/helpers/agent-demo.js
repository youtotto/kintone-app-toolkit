'use strict';
// 共通の会話の仕組み（KTAgent）の模擬応答（テスト専用。本体には入れない。2026-10-06 利用者の指示: 試作の検証用の道具を本体に作らない）
//   模擬の「会話を理解する担当」（台本の発言だけを理解する）と、条件から決定的に作る模擬の変更案。AI は使わない
// ================= KTAgentDemo（共通の会話の仕組みの模擬応答・試作 2026-10-06）=================
//   追加の課金なしで、会話の状態の持ち方と画面を確かめるための模擬の「会話を理解する担当」と「変更案を作る担当」。
//   会話を理解する担当は台本（下の例の発言）だけを理解する（自然な言い回しの理解の質は、実 AI の確認で別に確かめる）。
//   事実の文は、取得済みの設定から作る（このアプリに無いことを「ある」と言わない）。変更案は条件の値から決定的に作る。
//   drift: 'first' のとき、最初の変更案だけ「承認待ちになった日時」を「更新日時」に置き換える（評価の記録 §9・§10 で実際の AI が行った置き換えの再現）
const KTAgentDemo = (() => {
  const norm = (t) => String(t ?? '').normalize('NFKC').replace(/[\s。、，．,.!！?？「」『』]/g, '');
  const fieldsOf = (data) => { const fs = data?.fields; return fs ? Object.values(fs.properties || fs).filter(f => f && f.code) : []; };
  const labelOf = (data, code) => fieldsOf(data).find(f => f.code === code)?.label || code;
  const statusNames = (data) => Object.values(data?.status?.states || {}).sort((a, b) => Number(a.index) - Number(b.index)).map(s => s.name);
  const waitingStatus = (data) => statusNames(data).find(s => /承認待ち/.test(s)) || statusNames(data).find(s => /承認|確認|待ち/.test(s)) || null;
  const amountField = (data) => fieldsOf(data).find(f => f.type === 'NUMBER' && /金額/.test(f.label || '')) || null;
  const userFields = (data) => fieldsOf(data).filter(f => f.type === 'USER_SELECT');
  const approverField = (data) => userFields(data).find(f => /承認者/.test(f.label || '')) || null;
  const reminders = (data) => (Array.isArray(data?.reminderNotify?.notifications) ? data.reminderNotify.notifications : []);
  const entityJa = (data, en) => (en?.type === 'FIELD_ENTITY' ? (en.code === '作業者' ? '作業者' : `「${labelOf(data, en.code)}」`) : en?.type === 'USER' ? `ユーザー ${en.code}` : en?.type === 'GROUP' ? `グループ ${en.code}` : en?.type === 'ORGANIZATION' ? `組織 ${en.code}` : String(en?.code ?? ''));
  const raw = (o) => ({ reply: '', intent: 'update', goal: '', ops: [], answers: [], reads: [], needProposal: false, clarify: '', ...o });
  const op = (o) => ({ label: '', text: '', valueJson: '', origin: 'user', quote: '', reason: '', ...o, valueJson: o.value === undefined ? '' : JSON.stringify(o.value) });
  const READ = (ref, reason, kind = ref.split(':')[0]) => ({ kind, ref, reason });
  const openQuestion = (p, re) => (p.openQuestions || []).find(q => re.test(`${q.label} ${q.text}`)) || null;
  const exceptionItem = (data, to = null) => { const a = amountField(data); return a ? { when: '金額が100万円以上', cond: `${a.code} >= "1000000"`, addRecipients: '上長', ...(to ? { to } : {}) } : null; };
  /** 新しい会話で試す例（いまのアプリにリマインダーがあるときだけ）: 既存のリマインダーと同じ条件 → 変更不要 */
  function existingReminderSay(data) {
    const r = reminders(data).find(n => n?.timing?.code && n.timing.daysLater != null && n.timing.time);
    if (!r) return null;
    const d = Number(r.timing.daysLater);
    const fe = (r.targets || []).map(t => t.entity).find(en => en?.type === 'FIELD_ENTITY');
    return { r, fe, text: `「${labelOf(data, r.timing.code)}」の${d < 0 ? `${-d}日前` : d === 0 ? '当日' : `${d}日後`}の${r.timing.time}に${fe ? entityJa(data, fe) : '通知先'}へ知らせたい` };
  }

  /** 台本（例の発言）。say はアプリの設定から作る（設定に合わない例は出さない） */
  const SCRIPT = [
    { id: 'ask', group: '通知の相談', say: () => '今の通知で承認漏れは防げてる？',
      respond(p, data) {
        if (!p.followup) return raw({ intent: 'question', reply: '通知の設定とプロセス管理を確かめます。', reads: [READ('setting:notifications', '通知の設定（宛先・条件・タイミング）'), READ('setting:process', 'ステータスと作業者')] });
        const general = Array.isArray(data?.generalNotify?.notifications) ? data.generalNotify.notifications : [];
        const toAssignee = general.some(n => n.statusChanged && n.entity?.type === 'FIELD_ENTITY' && n.entity.code === '作業者');
        const st = waitingStatus(data);
        const byStatus = reminders(data).filter(n => /ステータス/.test(String(n.filterCond || '')));
        const parts = [
          toAssignee ? 'ステータスが変わったときは、アプリの条件通知で作業者へ届く設定があります（設定）。' : 'ステータスが変わったときに作業者へ届くアプリの条件通知は、設定に見当たりません（設定）。',
          byStatus.length ? `ステータスで絞ったリマインダーが ${byStatus.length} 件あります（設定）。` : `${st ? `「${st}」` : '承認待ち'}のまま止まった案件を後から知らせるリマインダーはありません（設定）。`,
          '止まった案件に気づくには、リマインダーで催促する方法があります。',
        ];
        return raw({ intent: 'question', reply: parts.join('') });
      } },
    { id: 'request', group: '通知の相談', say: (data) => (waitingStatus(data) ? `${waitingStatus(data)}のまま止まっている案件に気づけるようにしたい。3日たったら作業者だけに知らせて。数え方はおまかせ。${amountField(data) ? 'ただし金額が100万円以上の案件は上長にも知らせて' : ''}` : null),
      respond(p, data) {
        if (!p.followup) return raw({ reply: 'リマインダーと、アクションの実行時のイベントの公式の仕様を確かめます。', reads: [READ('spec:notification.reminder', '基準日時に選べるもの'), READ('spec:notification.process-proceed', 'ステータスになった日時を記録できるか'), READ('setting:fields', '金額・日時のフィールド')] });
        const st = waitingStatus(data), ex = exceptionItem(data);
        const ops = [
          op({ op: 'set', key: 'notification.stop_condition', label: '通知する条件（止める条件）', text: `ステータスが「${st}」の間だけ`, value: { kind: 'while-status', status: st }, quote: `${st}のまま止まっている案件` }),
          op({ op: 'set', key: 'notification.interval', label: '通知までの間隔', text: '3 日後', value: { days: 3 }, quote: '3日たったら' }),
          op({ op: 'set', key: 'notification.recipients', label: '宛先', text: '作業者だけ', value: { kind: 'assignee', only: true }, quote: '作業者だけに知らせて' }),
          op({ op: 'delegate', key: 'notification.base_datetime', label: '基準日時（数え始める日時）', text: `「${st}」になった日時`, value: { kind: 'status-entered', status: st }, origin: 'delegated', quote: '数え方はおまかせ', reason: `更新日時は編集でも変わるので、「${st}」になった日時から数える案にしました。標準の設定にこの日時は無いので、記録用の日時フィールドと、アクションの実行時に記録する JavaScript が要ります（公式の仕様で確かめた方式）` }),
          op({ op: 'set', key: 'notification.time_of_day', label: '通知の時刻', text: '9:00', value: { time: '09:00' }, origin: 'ai', reason: '時刻の指定が無いので、仮に朝 9:00 にしました' }),
          ...(ex ? [op({ op: 'set', key: 'notification.exceptions', label: '例外（条件で宛先などを変える）', text: '金額が100万円以上なら上長にも', value: { items: [ex] }, quote: 'ただし金額が100万円以上の案件は上長にも知らせて' })] : []),
        ];
        return raw({ goal: `${st}のまま止まっている案件に気づけるようにする`, ops, needProposal: true,
          reply: `「${st}」になってから 3 日たったら、作業者だけに知らせる案を作ります。数え方はおまかせなので、「${st}」になった日時から数えます（更新日時は編集でも変わるため）。記録用の日時フィールドと、記録する JavaScript を足します。時刻は指定が無いので、仮に 9:00 にしています。${ex ? '金額が 100 万円以上なら上長にも知らせます（上長が誰かは確認します）。' : ''}` });
      } },
    { id: 'mixed', group: '作っている途中に', say: () => '時刻は8時にして。あと、更新日時だと何が困るの？',
      respond() {
        return raw({ ops: [op({ op: 'set', key: 'notification.time_of_day', label: '通知の時刻', text: '8:00', value: { time: '08:00' }, quote: '時刻は8時にして' })], needProposal: true,
          reply: '時刻を 8:00 にして作り直します。更新日時は、レコードを編集するたびに新しくなります（一般的な知識）。待っている間に誰かが編集すると、そこから数え直しになり、3 日たっても知らせが届かないことがあります。リマインダーの基準に更新日時を選ぶこと自体はできます（公式）。' });
      } },
    { id: 'boss', group: '確認事項に答える', say: (data) => (approverField(data) && amountField(data) ? `上長は${approverField(data).label}フィールドの人にして` : null),
      respond(p, data) {
        const af = approverField(data), q = openQuestion(p, /上長/), ex = exceptionItem(data, af ? { kind: 'field', field: af.code } : null);
        const quote = `上長は${af.label}フィールドの人にして`;
        return raw({ needProposal: true, answers: q ? [{ questionId: q.id, kind: 'value', text: `${af.label}フィールドの人`, valueJson: '', quote, reason: '' }] : [],
          ops: ex ? [op({ op: 'set', key: 'notification.exceptions', label: '例外（条件で宛先などを変える）', text: `金額が100万円以上なら上長（${af.label}）にも`, value: { items: [ex] }, quote })] : [],
          reply: `金額が 100 万円以上のときは「${af.label}」の人にも知らせます。` });
      } },
    { id: 'boss-delegate', group: '確認事項に答える', say: (data) => (approverField(data) && amountField(data) ? '上長はおすすめで' : null),
      respond(p, data) {
        const af = approverField(data), q = openQuestion(p, /上長/), ex = exceptionItem(data, { kind: 'field', field: af.code });
        const reason = `上長を表すフィールドが無いので、承認の作業者を決めている「${af.label}」を仮に選びました（違えば、ユーザー・組織の名前を伝えてください）`;
        return raw({ needProposal: true, answers: q ? [{ questionId: q.id, kind: 'delegated', text: `${af.label}フィールドの人`, valueJson: '', quote: '上長はおすすめで', reason }] : [],
          ops: [op({ op: 'delegate', key: 'notification.exceptions', label: '例外（条件で宛先などを変える）', text: `金額が100万円以上なら上長（${af.label}）にも`, value: { items: [ex] }, origin: 'delegated', quote: '上長はおすすめで', reason })],
          reply: `上長は「${af.label}」の人にしました。${reason.replace(/^[^、]+、/, '')}` });
      } },
    { id: 'thanks', group: '相づち・取り消し', say: () => 'ありがとう', respond: () => raw({ intent: 'smalltalk', reply: 'どういたしまして。案はそのままです。' }) },
    { id: 'hmm', group: '相づち・取り消し', say: () => 'うーん', respond: () => raw({ intent: 'unclear', reply: '気になる点があれば、そのまま書いてください（今の案のままでよければ、何もしなくて大丈夫です）。' }) },
    { id: 'revoke', group: '相づち・取り消し', say: (data) => (amountField(data) ? 'やっぱり金額の例外はなしで' : null),
      respond(p) {
        const q = openQuestion(p, /上長/);
        return raw({ needProposal: true, ops: [op({ op: 'revoke', key: 'notification.exceptions', label: '例外（条件で宛先などを変える）', quote: 'やっぱり金額の例外はなしで' })], answers: q ? [{ questionId: q.id, kind: 'skip', text: '', valueJson: '', quote: 'やっぱり金額の例外はなしで', reason: '例外を取り消したので不要' }] : [],
          reply: '金額が 100 万円以上の例外を外して作り直します。' });
      } },
    { id: 'accept-updated', group: '方式の違いを受け入れる', say: () => '更新日時で数えるのでいい',
      respond: () => raw({ needProposal: true, ops: [op({ op: 'set', key: 'notification.base_datetime', label: '基準日時（数え始める日時）', text: '更新日時', value: { kind: 'field', field: '更新日時' }, quote: '更新日時で数えるのでいい' })],
        reply: '基準を更新日時に変えます。編集すると数え直しになる点はご了承ください。記録用のフィールドと JavaScript は要らなくなります。' }) },
    { id: 'existing', group: '新しい会話で（変更不要の確認）', say: (data) => existingReminderSay(data)?.text || null,
      respond(p, data) {
        const x = existingReminderSay(data);
        if (!p.followup) return raw({ reply: 'リマインダーの設定を確かめます。', reads: [READ('setting:notifications', '今のリマインダー')] });
        const d = Number(x.r.timing.daysLater);
        return raw({ goal: x.text, needProposal: true, ops: [
          op({ op: 'set', key: 'notification.base_datetime', label: '基準日時（数え始める日時）', text: labelOf(data, x.r.timing.code), value: { kind: 'field', field: x.r.timing.code }, quote: `「${labelOf(data, x.r.timing.code)}」` }),
          op({ op: 'set', key: 'notification.interval', label: '通知までの間隔', text: `${d} 日`, value: { days: d }, quote: d < 0 ? `${-d}日前` : d === 0 ? '当日' : `${d}日後` }),
          op({ op: 'set', key: 'notification.time_of_day', label: '通知の時刻', text: x.r.timing.time, value: { time: x.r.timing.time }, quote: x.r.timing.time }),
          ...(x.fe ? [op({ op: 'set', key: 'notification.recipients', label: '宛先', text: entityJa(data, x.fe), value: { kind: 'field', field: x.fe.code }, quote: `${entityJa(data, x.fe)}へ知らせたい` })] : []),
        ], reply: '条件として受け取りました。今のリマインダーと照らします。' });
      } },
  ];
  /** いまのアプリで使える例の発言 */
  const examples = (data) => SCRIPT.map(s => ({ id: s.id, group: s.group, text: s.say(data) })).filter(x => x.text);

  // ---------------- 変更案を作る担当（模擬）----------------
  const SPEC0 = { name: null, from: null, to: null, filterCond: null, assignees: [], targets: [], events: [], timingField: null, daysLater: null, time: null, fields: [], sort: null, sourceApp: null, keyField: null, mappings: [], fieldType: null, required: null, options: [], destApp: null };
  const step = (id, actionType, targetKind, targetRef, title, sp = {}, extra = {}) => ({ id, actionType, targetKind, targetRef, targetExists: null, title, proposal: { summary: title, details: [] }, spec: { ...SPEC0, ...sp }, dependsOn: [], reason: '', evidenceIds: [], confidence: 'INFERRED', alternatives: [], ...extra });
  const uniqueCode = (data, base) => { const codes = new Set(fieldsOf(data).map(f => f.code)); let c = base, i = 2; while (codes.has(c)) c = `${base}_${i++}`; return c; };
  /**
   * 条件の値から変更案を作る（決定的）。drift のときは基準日時を更新日時に置き換えた案を返す（説明は書かない。実際に起きた形）
   */
  function buildNotificationPlan({ conditions = [], data = null, drift = false }) {
    const get = (k) => conditions.find(c => c.key === k)?.value || null;
    const base = get('notification.base_datetime'), iv = get('notification.interval') || { days: 3 }, tm = get('notification.time_of_day'), stop = get('notification.stop_condition'), rc = get('notification.recipients'), ex = get('notification.exceptions');
    const steps = [], proposedFields = [], customizations = [], questions = [];
    const st = stop?.kind === 'while-status' ? stop.status : base?.kind === 'status-entered' ? base.status : null;
    const filter = stop?.kind === 'query' ? stop.query : st ? `ステータス in ("${st}")` : '';
    const target = rc?.kind === 'field' ? `FIELD_ENTITY:${rc.field}` : rc?.kind === 'entity' ? `${rc.type}:${rc.code}` : 'FIELD_ENTITY:作業者';
    let timingField = base?.kind === 'field' ? base.field : '更新日時', dep = [], recordCode = null;
    if (base?.kind === 'status-entered' && !drift) {
      recordCode = uniqueCode(data, 'status_entered_at');
      proposedFields.push({ temporaryId: 'NEW_FIELD_1', label: `${base.status}になった日時`, suggestedCode: recordCode, type: 'DATETIME', typeValid: true, required: false, options: [], reason: '標準の設定には、ステータスになった日時を記録するフィールドが無い', evidenceIds: [], alternativeExistingFieldCode: null, codeConflict: false, labelDuplicate: false });
      steps.push(step('P1', 'ADD_FIELD', 'PROPOSED_FIELD', 'NEW_FIELD_1', `日時のフィールド「${base.status}になった日時」を足す`));
      timingField = 'NEW_FIELD_1'; dep = ['P1'];
    }
    const days = iv.days != null ? iv.days : Math.round((iv.hours || 0) / 24);
    const time = tm?.time || '09:00';
    steps.push(step('P2', 'ADD_REMINDER', 'REMINDER', `${st || '対象'}のまま${days}日`, `リマインダー「${st || '対象'}のまま${days}日」を足す`, { name: `${st || '対象'}のまま${days}日`, timingField, daysLater: days, time, filterCond: filter, targets: [target] }, { dependsOn: dep }));
    for (const [i, it] of (ex?.items || []).entries()) {
      const n = i + 3;
      if (it.to) {
        const add = it.to.kind === 'field' ? `FIELD_ENTITY:${it.to.field}` : `${it.to.type}:${it.to.code}`;
        steps.push(step(`P${n}`, 'ADD_REMINDER', 'REMINDER', `${st || '対象'}のまま${days}日（${it.when}）`, `リマインダー「${st || '対象'}のまま${days}日（${it.when}）」を足す`, { name: `${st || '対象'}のまま${days}日（${it.when}）`, timingField, daysLater: days, time, filterCond: [filter, it.cond].filter(Boolean).join(' and '), targets: [target, add] }, { dependsOn: dep }));
      } else {
        steps.push(step(`P${n}`, 'REQUIRE_CONFIRMATION', 'CONFIRMATION', it.addRecipients || '宛先', `「${it.when}」のときの宛先（${it.addRecipients || '未定'}）を確かめる`, { filterCond: it.cond }));
        questions.push({ id: `Q${questions.length + 1}`, question: `「${it.when}」のとき、${it.addRecipients || '追加の宛先'}にも知らせるには、${it.addRecipients || 'その人'}が誰か（ユーザー選択のフィールド・ユーザー・組織）を決める必要があります。どれにしますか？`, reason: '', relatedEvidenceIds: [], topic: 'other', label: it.addRecipients || '宛先', options: userFields(data).map(f => `「${f.label}」の人`).slice(0, 3), recommendation: '', priority: 'blocking' });
      }
    }
    if (recordCode) {
      steps.push(step('C1', 'CUSTOMIZATION_REQUIRED', 'JS', '', `「${base.status}」になった日時を記録する JavaScript`, { customizationId: 'C1' }, { solution: 'CUSTOMIZATION', execution: { mode: 'PLAN_ONLY', supported: false, reason: 'JavaScript の生成は次の段階' }, dependsOn: ['P1'] }));
      customizations.push({ customizationId: 'C1', requirement: `プロセス管理のアクションで「${base.status}」へ進むとき、「${base.status}になった日時」に今の日時を記録する`, whyStandardInsufficient: '標準の設定には、ステータスになった日時を記録するフィールドが無い', strategy: 'NEW_JS_FILE', platform: ['desktop', 'mobile'], implementation: 'JAVASCRIPT', events: ['app.record.detail.process.proceed', 'mobile.app.record.detail.process.proceed'], fields: [{ code: recordCode, access: 'WRITE' }], apis: ['kintone.events.on'], existingFiles: [], risks: ['一覧の画面での実行・REST API でのステータスの変更で記録されるかは、確かめた文書に書かれていない'], questions: [], dependsOn: ['P1'] });
    }
    const summary = drift
      ? `「${st}」のレコードを、更新日時の ${days} 日後 ${time} に${rc?.kind === 'assignee' ? '作業者' : '宛先'}へ知らせます。`
      : `${base?.kind === 'status-entered' ? `「${base.status}」になった日時を日時のフィールドに記録し（アクションの実行時に JavaScript で記録）、その` : `${base?.kind === 'field' ? `「${labelOf(data, base.field)}」の` : ''}`}${days} 日後 ${time} に${rc?.kind === 'assignee' ? '作業者' : '宛先'}へ知らせるリマインダーを足します。${st ? `ステータスが「${st}」の間だけ届きます。` : ''}`;
    return { planVersion: '1', requestId: `demo-${Date.now()}`, goal: '', assessment: { summary }, relevantFields: [], proposedFields, steps, alternatives: [], impact: [], questions, unknowns: [], planConfidence: 'INFERRED', solution: customizations.length ? 'HYBRID' : 'STANDARD', customizations };
  }

  /**
   * 模擬のサービス（会話を理解する担当・変更案を作る担当）。review / prepare は呼び出し元が実物（Toolkit Review・Executor の準備）を渡す
   * @param {object} o getInputs / delays { turn, plan }（ミリ秒）/ drift: 'first' | 'never'（または値を返す関数。画面で切り替える）/ sleep（テストで差し替え）
   */
  function createServices({ getInputs = () => ({}), delays = { turn: 400, plan: 2500 }, drift = 'first', sleep = (ms) => new Promise(r => setTimeout(r, ms)) } = {}) {
    const st = { drifted: false, calls: { turn: 0, plan: 0 } };
    const svc = {
      async turn(payload) {
        st.calls.turn++;
        if (delays.turn) await sleep(delays.turn);
        const data = getInputs().data || null;
        const s = SCRIPT.find(x => { const t = x.say(data); return t && norm(t) === norm(payload.utterance); });
        const out = s ? s.respond(payload, data) : raw({ intent: 'unclear', reply: '（模擬応答）この発言は模擬応答の台本にありません。下の例の発言を使うか、実 AI の確認で試してください。' });
        return { ...out, meta: { ai: { model: 'demo', usage: null } } };
      },
      async plan({ conditions = [], repair = null }) {
        st.calls.plan++;
        if (delays.plan) await sleep(delays.plan);
        const data = getInputs().data || null;
        const base = conditions.find(c => c.key === 'notification.base_datetime')?.value;
        const doDrift = (typeof drift === 'function' ? drift() : drift) === 'first' && !repair && !st.drifted && base?.kind === 'status-entered';
        if (doDrift) st.drifted = true;
        return { ok: true, plan: buildNotificationPlan({ conditions, data, drift: doDrift }) };
      },
      reset() { st.drifted = false; },
      calls: () => ({ ...st.calls }),
    };
    return svc;
  }
  return { SCRIPT, examples, buildNotificationPlan, createServices, norm };
})();
module.exports = { KTAgentDemo };
