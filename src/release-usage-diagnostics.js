/* Receiver-side usage facts only. Never reconstruct these from normalized token counts. */
const KTReleaseUsageDiagnostics = (() => {
  const obj = value => !!value && typeof value === 'object' && !Array.isArray(value);
  const own = (value, key) => obj(value) && Object.prototype.hasOwnProperty.call(value, key);
  const containerKeys = ['usageState', 'inputDetailsState', 'writeDetailsState'];
  const tokenKeys = ['writeTokensState', 'ttl30mState', 'ttl12hState'];
  function sanitize(value) {
    if (!obj(value) || !own(value, 'version') || value.version !== 1 || !own(value, 'inputDetailsSource') ||
        ![null, 'input_tokens_details', 'prompt_tokens_details'].includes(value.inputDetailsSource) ||
        !own(value, 'hasUnrecognizedWriteFields') || typeof value.hasUnrecognizedWriteFields !== 'boolean') return null;
    if (containerKeys.some(key => !own(value, key) || !['object', 'missing', 'null', 'invalid'].includes(value[key])) ||
        tokenKeys.some(key => !own(value, key) || !['valid', 'missing', 'null', 'invalid'].includes(value[key]))) return null;
    return { version: 1, usageState: value.usageState, inputDetailsSource: value.inputDetailsSource,
      inputDetailsState: value.inputDetailsState, writeDetailsState: value.writeDetailsState,
      writeTokensState: value.writeTokensState, ttl30mState: value.ttl30mState, ttl12hState: value.ttl12hState,
      hasUnrecognizedWriteFields: value.hasUnrecognizedWriteFields };
  }
  function html(value) {
    const d = sanitize(value);
    if (!d) return '<p>使用量の受信状態は未記録です。この記録だけでは、保持期間別の項目がないのか、値の形式が異なるのかを判断できません。</p>';
    const labels = { object: 'オブジェクトあり', valid: '有効な数値あり', missing: '項目なし', null: 'null', invalid: '形式不正' };
    const fields = { usageState: '使用量全体', inputDetailsState: '入力の内訳', writeDetailsState: '保持期間別の内訳', writeTokensState: '書き込み合計', ttl30mState: '書込30分', ttl12hState: '書込12時間' };
    return '<details><summary>使用量の受信状態</summary><p>受信した使用量の既知の項目について、変換前の状態を記録しています。未取得の内訳を補完する情報ではありません。</p><p>入力の取得元：' +
      (d.inputDetailsSource === 'input_tokens_details' ? 'Responses形式' : d.inputDetailsSource === 'prompt_tokens_details' ? 'Chat Completions形式' : '項目なし') + '</p><dl>' +
      Object.entries(fields).map(([key, label]) => '<dt>' + label + '</dt><dd>' + labels[d[key]] + '</dd>').join('') + '</dl>' +
      (d.hasUnrecognizedWriteFields ? '<p>保持期間別の内訳には、既知の2項目以外も含まれています。項目名や内容は記録していません。</p>' : '') + '</details>';
  }
  return { sanitize, html };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = { KTReleaseUsageDiagnostics };
