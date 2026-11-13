'use strict';
const FX = require('../fixtures/ai-context-app.js');
const { buildScanPayload } = require('./scan-payload.js');

function inputsOf(T, { withScan = true, cachedOnly = false } = {}) {
  const data = FX.makeData();
  const fieldsN = T.KTDeps.normalizeFields(data.fields);
  const deps = T.KTDeps.buildDependencyData(data, fieldsN);
  let scan = null;
  if (withScan) {
    scan = buildScanPayload(T, { appId: FX.SELF_APP, files: FX.files,
      fields: fieldsN.map(f => ({ code:f.code, label:f.label, type:f.rawType })), deps, skippedUrlFiles:FX.skippedUrlFiles });
    if (cachedOnly) scan = { ...scan, files:scan.files.map(({text,...rest}) => rest) };
    T.KTDeps.mergeScannerEdges(deps, scan);
  }
  T.KTDeps.applyIncomingRefs(deps, FX.incoming);
  return { data, deps, scan, incoming:FX.incoming };
}
module.exports = { inputsOf };
