// Field Scanner（scanOnce）が生成する payload と同じ形を、テスト用に組み立てる。
//   results[].matches / appRefs / externalRefs / unknownRefs / fileEvents / files / meta
// appRefs・unknownRefs・externalRefs は実スクリプトの純関数（KTScan / KTDeps）で求め、
// フィールド出現箇所（matches）とイベント種別だけは簡易な正規表現で代用する
// （Scanner 本体の analyze / extractEventTypes は UI 内にあり sandbox から呼べないため）。
'use strict';

function buildScanPayload({ KTScan, KTDeps }, { appId, files, fields, deps = null, scannedAt = '2026-10-01T00:00:00.000Z' }) {
  const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;
  const results = [];
  for (const f of fields) {
    const matches = [];
    for (const file of files) {
      if (file.kind !== 'js' || !file.text) continue;
      const clean = KTScan.stripCommentsOnly(file.text);
      const rx = new RegExp(`(?:\\['${f.code}'\\]|\\["${f.code}"\\]|\\.${f.code}\\b|'${f.code}'|"${f.code}")`, 'g');
      let m;
      while ((m = rx.exec(clean)) !== null) {
        const after = clean.slice(m.index + m[0].length, m.index + m[0].length + 20);
        const before = clean.slice(Math.max(0, m.index - 40), m.index);
        const access = /setFieldShown\(\s*$/.test(before) ? 'SHOW_HIDE'
          : /^\.value\s*=[^=]/.test(after) ? 'WRITE'
            : /^\.value/.test(after) ? 'READ'
              : /^\.lookup/.test(after) ? 'WRITE'
                : /change\.$/.test(before) ? 'ELEMENT' : 'OTHER';
        const s = Math.max(0, m.index - 24), e = Math.min(clean.length, m.index + m[0].length + 48);
        matches.push({
          file: file.name, target: file.target, kind: file.kind,
          line: lineOf(clean, m.index), access,
          confidence: access === 'OTHER' ? 'LOW' : 'HIGH',
          snippet: clean.slice(s, e).replace(/\n/g, '⏎'),
        });
      }
    }
    const accessCounts = {};
    for (const m of matches) accessCounts[m.access] = (accessCounts[m.access] || 0) + 1;
    results.push({
      code: f.code, label: f.label, type: f.type, used: matches.length > 0, count: matches.length,
      files: [...new Set(matches.map(m => `${m.target}: ${m.file}`))],
      samples: matches.slice(0, 2), matches, accessCounts,
      accessSummary: Object.entries(accessCounts).map(([k, v]) => `${k}×${v}`).join(', '),
    });
  }

  const appRefs = [];
  const fileEvents = {};
  for (const f of files) {
    if (f.kind !== 'js' || !f.text) continue;
    const clean = KTScan.stripCommentsOnly(f.text);
    const li = KTScan.buildLineIndex(clean);
    for (const ref of KTDeps.extractAppIdRefs(clean, (i) => KTScan.lineAt(li, i))) {
      if (ref.appId && String(ref.appId) === String(appId)) continue;
      appRefs.push({ ...ref, file: f.name, target: f.target });
    }
    const evs = [...clean.matchAll(/'((?:mobile\.)?app\.record\.[a-z.]+(?:\.[A-Za-z0-9_]+)?)'/g)].map(m => ({ name: m[1], direct: true }));
    if (evs.length) fileEvents[`${f.target}:js:${f.name}`] = evs;
  }
  const depsKnown = (deps?.nodes || []).filter(n => n.type === 'FIELD').map(n => String(n.id).replace(/^FIELD:/, ''));
  const unknownRefs = KTScan.collectUnknownFieldRefs(files, fields, depsKnown, appId);
  const externalRefs = KTScan.collectExternalFieldRefs(files, appId);
  return {
    results, files, fields, appRefs, fileEvents, unknownRefs, unknownStatuses: [], externalRefs,
    meta: { appId, include: 'both', kinds: 'js', scannedAt },
  };
}

module.exports = { buildScanPayload };
