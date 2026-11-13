// 最終案の反映できるかを、テストから版（または最終案の記録）で引く共有の部品（簡素化 2026-10-17）。
//   tests/helpers/load-toolkit.js が読み込んだ Toolkit の会話（KTAiConversation.create で作ったもの。画面が作る会話を含む）をここで覚える。
//   最新の版は、その会話の今の判定（finalReadiness。承認の口・画面の承認の欄の準備・最終案のカードのボタンが使うもの）。
//   前の版（置き換わった版）は最終案の記録（作った時点の判定。前の最終案のカードもその記録で描く）
'use strict';
const convs = [];

/** 会話を作る口を包んで、作った会話を覚える（同じ部品に 2 回は包まない） */
function trackConversations(KTAiConversation) {
  if (!KTAiConversation || typeof KTAiConversation.create !== 'function' || KTAiConversation.__ktTracked) return;
  const create0 = KTAiConversation.create;
  KTAiConversation.create = function (...a) { const c = create0.apply(this, a); convs.push(c); return c; };
  Object.defineProperty(KTAiConversation, '__ktTracked', { value: true });
}

/** 版（または最終案の記録）を持つ会話と版。新しく作った会話から探す */
function locate(x) {
  for (let i = convs.length - 1; i >= 0; i--) {
    const c = convs[i];
    const vs = typeof c.planHistory === 'function' ? c.planHistory() || [] : [];
    const v = vs.find(y => y && (y === x || (y.final && y.final === x)));
    if (v) return { c, v };
  }
  return null;
}

/** 反映できるかの判定（{ ready, blockingReason, reasons }）。最新の版は会話の今の判定、前の版は最終案の記録。最終案が無ければ null */
function readinessOf(x) {
  const hit = locate(x);
  if (!hit) throw new Error('最終案の版が、記録した会話に見つかりません（final-state.readinessOf）');
  const { c, v } = hit;
  if (!v.final) return null;
  if (c.activePlan() === v) return c.finalReadiness(v);
  return { ready: !!v.final.approvable, blockingReason: v.final.blockingReason || '', reasons: (v.final.readiness && v.final.readiness.reasons) || [] };
}
/** 反映できるか（readinessOf の ready） */
const readyOf = (x) => { const r = readinessOf(x); return !!(r && r.ready); };
/** 反映できない理由の 1 文（readinessOf の blockingReason。反映できるときは空） */
const reasonOf = (x) => { const r = readinessOf(x); return r ? (r.blockingReason || '') : ''; };

module.exports = { trackConversations, readinessOf, readyOf, reasonOf };
