/* Shared pure operations. Preserve the JSON snapshot and HTML text contracts. */
'use strict';
const KTReleaseUtils = (() => {
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  // Intentionally JSON-based: persisted snapshots omit undefined object members,
  // convert dates to strings, and reject cycles. structuredClone has other semantics.
  const cloneJson = value => value == null ? value : JSON.parse(JSON.stringify(value));
  return { escapeHtml, cloneJson };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = { KTReleaseUtils };
