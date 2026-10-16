// テストの偽の生成工程（Gateway の代わり）が返す検証結果の候補の指紋（verification.candidateHash）。
//   Gateway の candidateHashOf（AI版 worker/src/v2/toolkit/verify-generated.mjs）と同じ計算（SHA-256 の先頭 16 桁）を Node の crypto で同期に行う。
//   baseHash = Toolkit が送った既存ファイルの本文の指紋（KTScan.hashText）。統合でなければ null。
//   Toolkit 側の計算（KTScan.gatewayCandidateHashOf）と一致することは、実機の記録の指紋で ai-flow-redesign の D30 が確かめる
'use strict';
const crypto = require('crypto');

function gwCandidateHash({ strategy = null, targetFile = null, code = '', patch = null, baseHash = null, customizationId = null } = {}) {
  const lf = (s) => String(s ?? '').replace(/\r\n/g, '\n');
  const ops = patch && Array.isArray(patch.operations) ? patch.operations.map(o => [String(o?.type ?? ''), lf(o?.anchor), lf(o?.content)]) : null;
  const payload = JSON.stringify([strategy, targetFile, lf(code), ops ? { baseHash: patch.baseHash ?? null, operations: ops } : null, baseHash, customizationId]);
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 16);
}

/**
 * 画面の偽の接続先（client.generate）用: Toolkit が送った Generator Context（ctx）と生成結果（g）から、Gateway と同じ値で指紋を作る
 *   （baseHash = ctx.existingFile.hash・customizationId = ctx.customization.customizationId。targetFile は Gateway の正規化と同じく文字列）
 */
function gwHashOfCtx(ctx, g) {
  return gwCandidateHash({ strategy: g.strategy, targetFile: String(g.targetFile || ''), code: g.code, patch: g.patch && typeof g.patch === 'object' ? g.patch : null, baseHash: ctx && ctx.existingFile ? ctx.existingFile.hash : null, customizationId: ctx && ctx.customization ? ctx.customization.customizationId : null });
}
/** 生成結果の検証結果（g.verification）に、Gateway と同じ値の指紋を入れる（検証結果が無ければそのまま） */
function withGwHash(ctx, g) { return g && g.verification ? { ...g, verification: { ...g.verification, candidateHash: gwHashOfCtx(ctx, g) } } : g; }

module.exports = { gwCandidateHash, gwHashOfCtx, withGwHash };
