'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { KTReleaseWorkspace } = require('../src/release-workspace.js');
const { KTReleaseView } = require('../src/release-view.js');
const { fixture, REQUEST, plan, deferred } = require('./helpers/release-workspace-fixture.js');
const normal = html => String(html).replace(/<style>[\s\S]*?<\/style>/g, '');
const decode = value => String(value).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function hostOf() {
  const listeners = new Map();
  let html = '', input = null;
  const host = { ownerDocument: { activeElement: null }, addEventListener(type, fn) { const values = listeners.get(type) || []; values.push(fn); listeners.set(type, values); }, removeEventListener(type, fn) { listeners.set(type, (listeners.get(type) || []).filter(x => x !== fn)); },
    querySelector: selector => selector === '#kt-release-input' ? input : null,
    querySelectorAll(selector) {
      if (selector !== '[data-release-base-disabled]' && selector !== '[data-release-draft-note]') return [];
      const marker = selector.slice(1, -1), attribute = marker === 'data-release-base-disabled' ? 'disabled' : 'hidden';
      return (html.match(/<[^>]+>/g) || []).filter(tag => tag.includes(marker)).map(original => {
        let tag = original;
        const node = { dataset: { releaseBaseDisabled: /data-release-base-disabled="true"/.test(tag) ? 'true' : 'false' } };
        Object.defineProperty(node, attribute, { get: () => new RegExp('\\s' + attribute + '(?:\\s|>)').test(tag), set(value) {
          const next = tag.replace(new RegExp('\\s' + attribute + '(?=\\s|>)', 'g'), '').replace(/>$/, value ? ' ' + attribute + '>' : '>');
          html = html.replace(tag, next); tag = next;
        } });
        return node;
      });
    },
    async dispatch(type, event = {}) { for (const fn of listeners.get(type) || []) await fn({ type, preventDefault() {}, ...event }); }, listenerCount: type => (listeners.get(type) || []).length };
  Object.defineProperty(host, 'innerHTML', { get: () => html, set(value) { html = String(value); const tag = /<textarea\b[^>]*id="kt-release-input"([^>]*)>([\s\S]*?)<\/textarea>/.exec(html); input = tag ? { id: 'kt-release-input', value: decode(tag[2]), disabled: /\bdisabled\b/.test(tag[1]), selectionStart: 0, selectionEnd: 0, focus() { host.ownerDocument.activeElement = input; }, setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; } } : null; } });
  return host;
}
function buttonOf(host, action, id) {
  const tags = String(host.innerHTML).match(/<button\b[^>]*>/g) || [];
  const tag = tags.find(t => t.includes(`data-release-action="${action}"`) && (id == null || t.includes(`data-release-id="${id}"`)));
  assert.ok(tag, `画面に操作 ${action}${id ? ':' + id : ''} がある`);
  return { disabled: /\sdisabled(?:\s|>)/.test(tag), dataset: { releaseAction: action, ...(id ? { releaseId: id } : {}) } };
}
async function click(host, action, id) { const target = buttonOf(host, action, id); assert.equal(target.disabled, false, `操作 ${action} が有効`); await host.dispatch('click', { target }); }
async function type(host, text) { const input = host.querySelector('#kt-release-input'); assert.ok(input); input.value = text; input.focus(); await host.dispatch('input', { target: input }); }
async function mounted(options = {}) {
  const f = fixture(KTReleaseWorkspace, options.fixture || {}), host = hostOf();
  const view = KTReleaseView.create(host, { controller: f.controller, appName: '受入試験用アプリ', ...options.view });
  return { ...f, host, view };
}
async function finishProposal(f) { await type(f.host, REQUEST); await click(f.host, 'send'); await click(f.host, 'adopt'); }


test('モバイルだけの反映結果でPCの動作テスト環境へ誘導しない', async () => {
  const f=fixture(KTReleaseWorkspace,{settings:false,platforms:['mobile']});
  await f.controller.send(REQUEST);await f.controller.adopt();await f.controller.apply();
  const html=normal(KTReleaseView.render(f.controller.getState(),{onOpenPreview(){}}));
  assert.match(html,/モバイルの動作は、動作テスト環境では確認できません/);
  assert.doesNotMatch(html,/data-release-action="preview"|PCの動作は/);
});

test('PCとモバイルでは確認先を分け、PCの確認ボタンを残す', async () => {
  const f=fixture(KTReleaseWorkspace);
  await f.controller.send(REQUEST);await f.controller.adopt();await f.controller.apply();
  const html=normal(KTReleaseView.render(f.controller.getState(),{onOpenPreview(){}}));
  assert.match(html,/PCの動作は、動作テスト環境を開いて確認/);
  assert.match(html,/モバイルの動作は、動作テスト環境では確認できません/);
  assert.match(html,/data-release-action="preview"/);
});

test('設定だけの反映は動作テスト環境で確認する案内を残す', async () => {
  const f=fixture(KTReleaseWorkspace,{platforms:[]});
  await f.controller.send(REQUEST);await f.controller.adopt();await f.controller.apply();
  const html=normal(KTReleaseView.render(f.controller.getState(),{onOpenPreview(){}}));
  assert.match(html,/data-release-action="preview"/);
  assert.doesNotMatch(html,/モバイルの動作は/);
});

test('設定変更で止まった完成済みの案には、AIを使わない再確認の操作を出す', async () => {
  const f=await mounted();await finishProposal(f);f.bump();await f.controller.apply();
  assert.equal(f.controller.getState().error.code,'BASE_CHANGED');
  assert.match(normal(f.host.innerHTML),/最新の設定で確認し直す/);
  assert.match(normal(f.host.innerHTML),/AIは呼び出さず/);
  let called=0;f.controller.reprepare=async()=>{called++;};
  await click(f.host,'reprepare');assert.equal(called,1);assert.equal(f.writes.length,0);
  await type(f.host,'まだ送っていない訂正');
  assert.equal(buttonOf(f.host,'reprepare').disabled,true);
});

test('質問待ちと未完成の案には再確認のボタンを出さない', async () => {
  const f=fixture(KTReleaseWorkspace);await f.controller.send(REQUEST);await f.controller.adopt();
  const s=f.controller.getState();s.phase='blocked';s.error={code:'PLAN_QUESTION',message:'回答が必要'};
  s.plan.questions=[{question:'誰が確認しますか',blocking:true}];
  assert.doesNotMatch(KTReleaseView.render(s),/data-release-action="reprepare"/);
  s.plan.questions=[];s.error.code='BASE_CHANGED';s.artifacts=[];
  assert.doesNotMatch(KTReleaseView.render(s),/data-release-action="reprepare"/);
});

test('作成済みで設定取得だけ失敗した場合は残りを生成せず再確認へ案内する', async () => {
  const f=fixture(KTReleaseWorkspace);await f.controller.send(REQUEST);await f.controller.adopt();
  const s=f.controller.getState();s.phase='incomplete';s.error={code:'BASE_UNAVAILABLE',message:'取得不可'};
  const html=normal(KTReleaseView.render(s));
  assert.match(html,/data-release-action="reprepare"/);assert.doesNotMatch(html,/data-release-action="resume"/);
});

test('復元結果が不明なら再実行でなく確認を案内し、その記録を渡す', async () => {
  const f=await mounted({fixture:{rollback:async()=>({status:'unknown',message:'結果を確認できません'})}});
  await finishProposal(f);await f.controller.apply();
  const id=f.controller.getState().runs[0].id;
  await f.controller.requestRollback(id);await f.controller.rollback(id);
  assert.match(normal(f.host.innerHTML),/復元結果を確認する/);
  assert.doesNotMatch(f.host.innerHTML,/data-release-action="request-rollback"|data-release-action="rollback"/);
  let checked=null;f.controller.recheckRollback=async value=>{checked=value;};
  await click(f.host,'recheck-rollback',id);assert.equal(checked,id);
  const s=f.controller.getState();s.phase='checking-result';
  const html=normal(KTReleaseView.render(s));
  assert.match(html,/復元結果を確認しています/);
  assert.match(html,/<textarea[^>]* disabled/);
  assert.doesNotMatch(html,/data-release-action="recheck-rollback"/);
});

test('相談の失敗でも送信済み本文は入力欄へ戻さず会話に保持する', async () => {
  const f=await mounted({fixture:{propose:async()=>{throw Error('固定の通信失敗');}}});
  await type(f.host,'備考を編集不可にしてください');await click(f.host,'send');
  assert.equal(f.host.querySelector('#kt-release-input').value,'');
  assert.equal(f.controller.getState().messages[0].text,'備考を編集不可にしてください');
  assert.doesNotMatch(normal(f.host.innerHTML),/固定の通信失敗/);
  assert.match(normal(f.host.innerHTML),/操作を完了できませんでした/);
});

test('失敗中に別の下書きが入っていれば元の文で上書きしない', async () => {
  const held=deferred(),f=await mounted({fixture:{propose:()=>held.promise}});
  await type(f.host,'最初の依頼');const sending=click(f.host,'send');
  await new Promise(resolve=>setImmediate(resolve));
  // A later draft can also arrive through an input method or another caller.
  await type(f.host,'次の下書き');held.reject(Error('固定の通信失敗'));await sending;
  assert.equal(f.host.querySelector('#kt-release-input').value,'次の下書き');
});

test('会話へ受理する前の例外では未送信の入力を保持する', async () => {
  const f=await mounted();f.controller.send=async()=>{throw Error('呼び出し失敗');};
  await type(f.host,'保存したい依頼');await click(f.host,'send');
  assert.equal(f.host.querySelector('#kt-release-input').value,'保存したい依頼');
});

test('AIの発言と利用者の発言を区別する', async () => {
  const f=fixture(KTReleaseWorkspace);await f.controller.send(REQUEST);
  const html=normal(KTReleaseView.render(f.controller.getState()));
  assert.match(html,/class="ktr-speaker">AI<\/span>/);
  assert.match(html,/class="ktr-speaker">あなた<\/span>/);
  assert.doesNotMatch(html,/class="ktr-speaker">Toolkit<\/span>/);
});


test('中断して別の相談を始めた後に届く失敗で古い依頼を戻さない', async () => {
  const held=deferred(),f=await mounted({fixture:{propose:()=>held.promise}});
  await type(f.host,'古い相談');const sending=click(f.host,'send');
  await new Promise(resolve=>setImmediate(resolve));
  f.controller.cancel();f.controller.newTask();
  held.reject(Error('遅れて届いた失敗'));await sending;
  assert.equal(f.host.querySelector('#kt-release-input').value,'');
  assert.equal(f.controller.getState().messages.length,0);
});


test('第三者変更を検出して復元不可とした結果には復元操作を出さない', async () => {
  const f=fixture(KTReleaseWorkspace);await f.controller.send(REQUEST);await f.controller.adopt();await f.controller.apply();
  const s=f.controller.getState();s.runs[0].rollback={status:'partial',recoveryState:'changed',retryable:false,message:'別の変更があるため自動では戻しません。'};
  assert.doesNotMatch(KTReleaseView.render(s),/data-release-action="request-rollback"/);
  s.runs[0].rollback.retryable=true;
  assert.match(KTReleaseView.render(s),/data-release-action="request-rollback"/);
  delete s.runs[0].rollback.retryable;
  assert.match(KTReleaseView.render(s),/data-release-action="request-rollback"/);
});


test('出力途中終了でも本文は履歴に一度だけ保持し、正常終了でも入力欄を空にする', async () => {
  for (const truncated of [true, false]) {
    const f = await mounted(truncated ? {fixture:{propose:async()=>{throw Object.assign(Error('provider-private-path'), {code:'MODEL_OUTPUT_INVALID',details:{reason:'OUTPUT_TRUNCATED'}});}}} : {});
    await type(f.host,'理由を必須にしてください'); await click(f.host,'send');
    assert.equal(f.host.querySelector('#kt-release-input').value,'');
    assert.equal(f.controller.getState().messages.filter(m=>m.role==='user'&&m.text==='理由を必須にしてください').length,1);
    if(truncated){assert.match(normal(f.host.innerHTML),/回答を完了できませんでした/);assert.doesNotMatch(normal(f.host.innerHTML),/OUTPUT_TRUNCATED|provider-private-path|技術者向け/);}
  }
});

test('会話へ受理する前の拒否では未送信の入力を保持する', async () => {
  const f=await mounted();f.controller.send=async()=>false;
  await type(f.host,'まだ受理されていない依頼');await click(f.host,'send');
  assert.equal(f.host.querySelector('#kt-release-input').value,'まだ受理されていない依頼');
  assert.equal(f.controller.getState().messages.length,0);
});

test('内部例外と検証詳細をDOMへ出さず、公開案内と操作判定は保持する', () => {
  const privateText='PRIVATE_PROVIDER_MESSAGE sk-private /worker/private.mjs:321';
  for (const code of ['MODEL_OUTPUT_INVALID','NETWORK_ERROR','BASE_CHANGED','MONTHLY_LIMIT_EXCEEDED','UNKNOWN_PRIVATE_CODE']) {
    const state={phase:'idle',messages:[],runs:[],artifacts:[],error:{code,message:privateText,stack:privateText,detail:{reason:'OUTPUT_TRUNCATED',errors:[{code:'PRIVATE_VALIDATOR',path:'/private/path',message:privateText}]}}};
    const before=JSON.stringify(state),html=KTReleaseView.render(state,{connection:{connected:false,message:privateText},historyStatus:{state:'error',message:privateText}});
    assert.doesNotMatch(html,/PRIVATE_|sk-private|private\.mjs|private\/path|OUTPUT_TRUNCATED|response-diagnostics|技術者向け/);
    assert.match(html,/data-release-action="connect"/);
    assert.match(html,/会話を保存できませんでした/);
    if(code==='BASE_CHANGED')assert.match(html,/最新の設定で変更案を確認し直してください/);
    if(code==='MONTHLY_LIMIT_EXCEEDED')assert.match(html,/残数と更新日を確認してください/);
    assert.equal(JSON.stringify(state),before,'内部エラーは制御・回収のため改変しない');
  }
  const state={phase:'incomplete',messages:[],runs:[],plan:{customizations:[{customizationId:'C1',requirement:'入力確認'}]},artifacts:[{customizationId:'C1',title:'入力確認',error:{code:'NETWORK_ERROR',message:privateText},result:{artifactOutcome:{state:'failed',message:privateText}}}]};
  assert.doesNotMatch(KTReleaseView.render(state),/PRIVATE_|sk-private/);
});
