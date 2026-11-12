'use strict';
// tests/*.test.js を、ユーザースクリプト（kintoneAppToolkit.user.js）と拡張機能版の本体（dist/extension/toolkit.js）の
// 両方で実行し、ファイルごとの合否・件数が同じことを確かめる（テストは KT_SRC で読み込む本体を差し替えられる）。
//   node extension/compare-tests.cjs [テスト名の一部 ...]
const fs = require('node:fs'), path = require('node:path');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'dist', 'extension', 'toolkit.js');
if (!fs.existsSync(EXT)) { console.error('先に node extension/build.cjs を実行してください'); process.exit(1); }
const filter = process.argv.slice(2);
const files = fs.readdirSync(path.join(ROOT, 'tests')).filter((f) => f.endsWith('.test.js') && (!filter.length || filter.some((x) => f.includes(x)))).sort();
function run(file, src) {
  return new Promise((resolve) => {
    const env = { ...process.env }; if (src) env.KT_SRC = src; else delete env.KT_SRC;
    const p = spawn(process.execPath, [path.join('tests', file)], { cwd: ROOT, env });
    let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { p.kill(); out += '\nTIMEOUT'; }, 10 * 60 * 1000);
    p.on('close', (code) => {
      clearTimeout(timer);
      // 2 つの書き方に対応: 独自の「PASS: / FAIL:」と、Node 標準のテストランナー（node:test）の「# pass N / # fail N」「not ok N - 名前」
      const num = (k) => { const m = out.match(new RegExp('^# ' + k + ' (\\d+)$', 'm')); return m ? Number(m[1]) : 0; };
      const pass = (out.match(/^PASS:/gm) || []).length + num('pass'), failN = (out.match(/^FAIL:/gm) || []).length + num('fail');
      const fails = [...(out.match(/^FAIL: .*$/gm) || []).map((l) => l.slice(6, 160)), ...(out.match(/^not ok \d+ - .*$/gm) || []).map((l) => l.replace(/^not ok \d+ - /, '').slice(0, 160))];
      resolve({ code, pass, fail: failN, fails, timeout: /TIMEOUT$/.test(out) });
    });
  });
}
(async () => {
  const rows = []; let same = 0;
  const queue = files.slice();
  const worker = async () => {
    while (queue.length) {
      const f = queue.shift();
      const [a, b] = await Promise.all([run(f, null), run(f, EXT)]);
      const eq = a.code === b.code && a.pass === b.pass && a.fail === b.fail && JSON.stringify(a.fails) === JSON.stringify(b.fails);
      if (eq) same++;
      rows.push({ file: f, userscript: a, extension: b, same: eq });
      console.log(`${eq ? '同じ' : '違う'}  ${f}  ユーザースクリプト: exit ${a.code} ${a.pass}/${a.pass + a.fail}${a.timeout ? ' TIMEOUT' : ''}  拡張機能: exit ${b.code} ${b.pass}/${b.pass + b.fail}${b.timeout ? ' TIMEOUT' : ''}`);
      if (!eq) { for (const x of a.fails) console.log('   [US] FAIL: ' + x); for (const x of b.fails) console.log('   [EX] FAIL: ' + x); }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  rows.sort((x, y) => x.file.localeCompare(y.file));
  fs.writeFileSync(path.join(ROOT, 'dist', 'extension-tests.json'), JSON.stringify(rows, null, 1));
  const tot = (k) => rows.reduce((s, r) => s + r[k].pass, 0);
  console.log(`\n${rows.length} ファイル中 ${same} が同じ結果。合格の件数: ユーザースクリプト ${tot('userscript')} / 拡張機能 ${tot('extension')}。失敗のあるファイル: ユーザースクリプト ${rows.filter((r) => r.userscript.code !== 0).length} / 拡張機能 ${rows.filter((r) => r.extension.code !== 0).length}`);
  process.exit(same === rows.length ? 0 : 1);
})();
