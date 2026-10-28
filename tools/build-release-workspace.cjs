'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..'), target = path.join(root, 'kintoneAppToolkit.user.js');
const startMark = '  // BEGIN RELEASE WORKSPACE (generated from src/release-*.js)';
const endMark = '  // END RELEASE WORKSPACE';
let code = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
const sources = ['vendor/config-lens-compare.js', 'release-environment-diff.js', 'release-environment-view.js', 'release-settings-export.js', 'release-settings-compare.js', 'release-config-lens-view.js', 'release-config-lens.js', 'release-history.js', 'release-history-session.js', 'release-workspace.js', 'release-context.js', 'release-execution.js', 'release-view.js', 'release-customize.js', 'release-runtime.js'];
const section = sources.map(file => fs.readFileSync(path.join(root, 'src', file), 'utf8').replace(/\r\n/g, '\n')
  .replace(/^if \(typeof module !== 'undefined'.*$/gm, '').trim().split('\n').map(line => line ? '  ' + line : '').join('\n')).join('\n\n');
if (code.includes(startMark)) {
  const start = code.indexOf(startMark), end = code.indexOf(endMark, start);
  if (end < 0) throw new Error('Missing release workspace end marker');
  code = code.slice(0, start) + startMark + '\n' + section + '\n' + endMark + code.slice(end + endMark.length);
} else {
  const start = code.indexOf('  const KTAiAnswers = (() => {');
  const end = code.indexOf('  const mountRoot = () => {', start);
  if (start < 0 || end < 0) throw new Error('Cannot locate old release workspace');
  code = code.slice(0, start) + startMark + '\n' + section + '\n' + endMark + '\n\n' + code.slice(end);
}
code = code.replace('panel = mountAiWorkspace(host, {', 'panel = mountReleaseWorkspace(host, {')
  .replace('return KTDevBase.load({ appId: appId ?? kintone.app.getId()', 'return KTDevBase.loadForRelease({ appId: appId ?? kintone.app.getId()');
if (process.argv.includes('--check')) {
  if (fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n') !== code) throw new Error('Rebuild the release workspace before testing.');
  process.stdout.write('Release workspace matches its source files.\n');
} else {
  fs.writeFileSync(target, code, 'utf8');
  process.stdout.write('Release workspace embedded from ' + sources.length + ' source files.\n');
}
