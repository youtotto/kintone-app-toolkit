// 模擬イベント（KTJsSim）の Node 用 backend: vm の別 context（timeout・microtaskMode afterEvaluate・仮想の setTimeout は runtime が持つ）。
//   ブラウザの backend（sandbox の iframe）と同じ runtime の文字列を入れ、既存 JS → 候補の順に vm.Script で読み込み、__ktSim.runAll() の後に結果の JSON を取り出す。
//   userscript は Node の vm を使えないので、テストだけがこの backend を KTJsSim.simulate に渡す（ブラウザでは KTJsSim.iframeBackend）
'use strict';
const vm = require('vm');

/**
 * @param {object} o timeoutMs（1 回の評価の上限。同期の無限ループと microtask の暴走を止める）
 * @returns {{ kind: 'vm', available: true, run({ runtimeSource, files, inputJson }): Promise<object> }}
 */
function makeVmBackend({ timeoutMs = 2000 } = {}) {
  return {
    kind: 'vm', available: true,
    async run({ runtimeSource, files, inputJson }) {
      const sandbox = {};
      const ctx = vm.createContext(sandbox, { microtaskMode: 'afterEvaluate' });
      const runIn = (code, filename) => new vm.Script(code, { filename }).runInContext(ctx, { timeout: timeoutMs });
      runIn(runtimeSource, 'kt-sim-runtime.js');
      runIn(`__ktSim.install(${JSON.stringify(inputJson)});`, 'kt-sim-install.js');
      for (const f of files) {
        runIn(`__ktSim.beginFile(${JSON.stringify(f.name)});`, 'kt-sim-begin.js');
        try { runIn(f.text, f.name); }
        catch (e) { runIn(`__ktSim.fileError(${JSON.stringify(f.name)}, ${JSON.stringify({ message: String(e && e.message || e), name: e && typeof e.name === 'string' ? e.name : null })});`, 'kt-sim-file-error.js'); }
      }
      runIn(`__ktSim.beginFile('');`, 'kt-sim-begin.js');
      let timedOut = false;
      // runAll は非同期（await は microtask だけ。仮想の時計は runtime の中）。afterEvaluate で評価の後に microtask を全部流す。時間切れは例外になる
      try { runIn('__ktSim.runAll();', 'kt-sim-run.js'); }
      catch (e) { timedOut = /timed out|Script execution/i.test(String(e && e.message || e)); if (!timedOut) throw e; }
      const json = runIn('__ktSim.resultJson();', 'kt-sim-result.js');
      const out = JSON.parse(json);
      if (timedOut) out.timedOut = true;
      return out;
    },
  };
}

module.exports = { makeVmBackend };
