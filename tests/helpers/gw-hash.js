// テストの偽の生成工程（Gateway の代わり）が返す検証結果の、書き込む本文の指紋（verification.bodyHash）。
//   2026-10-18（AI版 契約 20 §20）: Gateway の bodyHashOf（AI版 worker/src/v2/toolkit/verify-generated.mjs）と同じ計算（SHA-256 の先頭 16 桁）を Node の crypto で同期に行う。
//   書き込む本文 = 新規はコード、統合は生成工程が既存の本文に差分を合成した全文（generated.body。偽の生成工程が持たせる）。改行はそろえない。
//   baseHash = Toolkit が送った既存ファイルの本文の指紋（KTScan.hashText）。統合でなければ null。
//   Toolkit 側の計算（KTScan.gatewayBodyHashOf）と一致することは ai-flow-redesign の D30 が、本物の Gateway の計算と一致することは AI版 の cross-toolkit が確かめる
'use strict';
const crypto = require('crypto');

/** 書き込む本文の指紋（Toolkit の会話はこの指紋を候補の指紋 entry.candidateHash として承認・登録に結び付ける）。本文が無ければ null */
function gwCandidateHash({ strategy = null, targetFile = null, code = '', body = null, baseHash = null, customizationId = null } = {}) {
  const text = strategy === 'EXTEND_EXISTING_JS' ? body : code;
  if (typeof text !== 'string') return null;
  return crypto.createHash('sha256').update(JSON.stringify([strategy, targetFile, text, baseHash, customizationId]), 'utf8').digest('hex').slice(0, 16);
}

/**
 * 画面の偽の接続先（client.generate）用: Toolkit が送った Generator Context（ctx）と生成結果（g）から、Gateway と同じ値で指紋を作る
 *   （baseHash = ctx.existingFile.hash・customizationId = ctx.customization.customizationId。targetFile は Gateway の正規化と同じく文字列）
 */
function gwHashOfCtx(ctx, g) {
  return gwCandidateHash({ strategy: g.strategy, targetFile: String(g.targetFile || ''), code: g.code, body: g.body, baseHash: ctx && ctx.existingFile ? ctx.existingFile.hash : null, customizationId: ctx && ctx.customization ? ctx.customization.customizationId : null });
}
/** 生成結果の検証結果（g.verification）に、Gateway と同じ値の指紋（bodyHash）を入れる（検証結果が無ければそのまま） */
function withGwHash(ctx, g) { return g && g.verification ? { ...g, verification: { ...g.verification, bodyHash: gwHashOfCtx(ctx, g) } } : g; }

/**
 * 偽の生成工程が返す統合の本文 generated.body（テストの部品だけ。本物の合成は AI版 modern-js.mjs の modernizeGenerated で、Toolkit 本体は合成しない）。
 *   既存の本文と anchor・content の改行を LF にそろえ、操作を順に当てる（anchor が 1 回だけ現れなければ null。生成工程は合成できない候補を止める）
 */
function gwFakeBody(source, patch) {
  const lf = (s) => String(s ?? '').replace(/\r\n/g, '\n');
  let t = lf(source);
  for (const op of (patch && Array.isArray(patch.operations) ? patch.operations : [])) {
    const anchor = lf(op.anchor), content = lf(op.content);
    if (op.type === 'APPEND') { t = t + (t.endsWith('\n') || !t ? '' : '\n') + content + (content.endsWith('\n') ? '' : '\n'); continue; }
    const at = t.indexOf(anchor);
    if (!anchor || at < 0 || t.indexOf(anchor, at + 1) >= 0) return null;
    const end = at + anchor.length, rest = t.slice(end);
    if (op.type === 'INSERT_AFTER') t = t.slice(0, end) + (t[end - 1] === '\n' ? '' : '\n') + content.replace(/\n$/, '') + (rest.startsWith('\n') || !rest ? '' : '\n') + rest;
    else if (op.type === 'INSERT_BEFORE') t = t.slice(0, at) + (content.endsWith('\n') ? content : `${content}\n`) + t.slice(at);
    else if (op.type === 'REPLACE') t = t.slice(0, at) + content + rest;
    else return null;
  }
  return t;
}
/** 統合の候補（generated）に、偽の生成工程の本文（gwFakeBody）を持たせる（新規の候補はそのまま。テストの部品だけ） */
function gwWithBody(generated, sourceText) { return generated && generated.strategy === 'EXTEND_EXISTING_JS' ? { ...generated, body: gwFakeBody(sourceText, generated.patch) } : generated; }

module.exports = { gwCandidateHash, gwHashOfCtx, withGwHash, gwFakeBody, gwWithBody };
