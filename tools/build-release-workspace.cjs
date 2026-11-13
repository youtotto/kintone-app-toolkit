'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..'), target = path.join(root, 'kintoneAppToolkit.user.js');
const startMark = '  // BEGIN RELEASE WORKSPACE (generated from src/release-*.js)';
const endMark = '  // END RELEASE WORKSPACE';
let code = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
// The hand-authored header is the release version source; KT_BUILD is derived.
const version = code.match(/^[/][/] @version\s+(\S+)$/m)?.[1];
const scriptVersion = code.match(/^  const SCRIPT_VERSION = '([^']+)';$/m)?.[1];
if (!version || version !== scriptVersion) throw new Error('@version and SCRIPT_VERSION must match.');
const buildPattern = /^  const KT_BUILD = '[^']*';$/gm;
if ([...code.matchAll(buildPattern)].length !== 1) throw new Error('Expected exactly one KT_BUILD declaration.');
code = code.replace(buildPattern, "  const KT_BUILD = '" + version + "';");
const notes = fs.readFileSync(path.join(root, 'docs', 'RELEASE-NOTES-' + version + '.md'), 'utf8');
if (notes.split(/\r?\n/)[0] !== '# kintone App Toolkit ' + version) throw new Error('Release notes version must match @version.');
const sources = ['vendor/config-lens-compare.js', 'release-environment-diff.js', 'release-environment-view.js', 'release-settings-export.js', 'release-settings-compare.js', 'release-config-lens-layout.js', 'release-config-lens-view.js', 'release-config-lens.js', 'release-history.js', 'release-history-session.js', 'release-analysis-input.js', 'release-business-contract.js', 'release-business-settings.js', 'release-workflow-diagram.js', 'release-workflow-overview.js', 'release-business-view.js', 'release-business-consultation.js', 'release-business-consultation-view.js', 'release-workspace.js', 'release-context.js', 'release-execution.js', 'release-smalltalk.js', 'release-view.js', 'release-customize.js', 'release-usage-diagnostics.js', 'release-runtime.js'];
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
const forbidden = [/const KTAiBudget\b/, /const KTReleaseBudgetReport\b/, /ktAi\.devMode/, /data-(?:budget|staging|production)-/, /id="kt-ai-(?:dev|token|api-base)"/, /appinsight-ai-api-staging/];
for (const pattern of forbidden) if (pattern.test(code)) throw new Error('Verification-only code leaked into public distribution: '+pattern);
if (process.argv.includes('--check')) {
  if (fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n') !== code) throw new Error('Rebuild the release workspace before testing.');
  process.stdout.write('Release workspace matches its source files.\n');
} else {
  fs.writeFileSync(target, code, 'utf8');
  process.stdout.write('Release workspace embedded from ' + sources.length + ' source files.\n');
}
