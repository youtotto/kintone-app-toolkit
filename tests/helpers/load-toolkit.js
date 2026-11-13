// 実スクリプトを Node の vm sandbox に読み込み、内部モジュール（KTDeps / KTScan / KTIncoming / KTContext）を取り出す。
// DOM / kintone API は与えない（純関数の部分だけをテストする）。既存テストと同じ方式を共通化したもの。
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadToolkit({ document: docOverride = null, localStorage: lsOverride = null, verificationBudget = false } = {}) {
  // KT_SRC: 別のビルド（修正前の版など）で同じテストを走らせるとき（RED の確認）に使う
  const SRC = process.env.KT_SRC || path.join(__dirname, '..', '..', 'kintoneAppToolkit.user.js');
  let code = fs.readFileSync(SRC, 'utf8');
  if (verificationBudget) { const at=code.lastIndexOf('})();'); code=code.slice(0,at)+fs.readFileSync(path.join(__dirname,'../../tools/verification/ai-budget.js'),'utf8')+code.slice(at); }
  const lastClose = code.lastIndexOf('})();');
  if (lastClose < 0) throw new Error('IIFE close not found');
  code = code.slice(0, lastClose)
    + '\n  globalThis.__TEST__ = { KTReleaseWorkspace: typeof KTReleaseWorkspace !== "undefined" ? KTReleaseWorkspace : undefined, KTReleaseView: typeof KTReleaseView !== "undefined" ? KTReleaseView : undefined, KTReleaseContext: typeof KTReleaseContext !== "undefined" ? KTReleaseContext : undefined, KTReleaseExecution: typeof KTReleaseExecution !== "undefined" ? KTReleaseExecution : undefined, mountReleaseWorkspace: typeof mountReleaseWorkspace !== "undefined" ? mountReleaseWorkspace : undefined, KTDeps, KTScan, KTIncoming, KTDevBase: typeof KTDevBase !== "undefined" ? KTDevBase : undefined, KTContext, KTPlanText: typeof KTPlanText !== "undefined" ? KTPlanText : undefined, KTContextUi, KTAiClient, KTAiBudget: typeof KTAiBudget !== "undefined" ? KTAiBudget : undefined, KTQueryCheck, KTPlanReview: typeof KTPlanReview !== "undefined" ? KTPlanReview : undefined, KTPlanExecutor, KTAiConversation: typeof KTAiConversation !== "undefined" ? KTAiConversation : undefined, KTAiAnswers: typeof KTAiAnswers !== "undefined" ? KTAiAnswers : undefined, KTAiWorkspaceViewModel: typeof KTAiWorkspaceViewModel !== "undefined" ? KTAiWorkspaceViewModel : undefined, KTAiChatUi: typeof KTAiChatUi !== "undefined" ? KTAiChatUi : undefined, KTJsCatalog, KTCodeReview: typeof KTCodeReview !== "undefined" ? KTCodeReview : undefined, KTJsExecutor, mountAiWorkspace: typeof mountAiWorkspace !== "undefined" ? mountAiWorkspace : undefined, mountRoot, renderCustomize, renderAiWorkspace: typeof renderAiWorkspace !== "undefined" ? renderAiWorkspace : undefined, SCRIPT_VERSION, buildProcessMermaid: typeof buildProcessMermaid !== "undefined" ? buildProcessMermaid : undefined, startToolkit: typeof startToolkit !== "undefined" ? startToolkit : undefined, KTFetchGate: typeof KTFetchGate !== "undefined" ? KTFetchGate : undefined, KTApi: typeof KTApi !== "undefined" ? KTApi : undefined, prefetchAppData: typeof prefetchAppData !== "undefined" ? prefetchAppData : undefined, fetchRelatedApps: typeof fetchRelatedApps !== "undefined" ? fetchRelatedApps : undefined, renderPlugins: typeof renderPlugins !== "undefined" ? renderPlugins : undefined };\n'
    + code.slice(lastClose);

  const noop = () => { };
  const fakeStorage = { getItem: () => null, setItem: noop, removeItem: noop };
  const sandbox = {
    console, setTimeout, clearTimeout,
    setInterval: () => 0, clearInterval: noop,
    AbortController, TextEncoder, TextDecoder, URL, btoa, atob, Uint8Array, crypto: globalThis.crypto,   // 簡素化 B（2026-10-17）: 候補の指紋（SHA-256）
      // ブラウザにもある標準 API（timeout の中断・サイズ計測・PKCE で使う）
    localStorage: lsOverride || fakeStorage, sessionStorage: fakeStorage,   // Phase 18: 移行案内（localStorage）のテストでは差し替える
    navigator: {},
    // Phase 15: mountRoot（タブ構成）のテストでは fake-dom.js の makeFakeDocument() を渡す
    document: docOverride || {
      createElement: () => ({ style: {}, setAttribute: noop, addEventListener: noop, appendChild: noop }),
      querySelector: () => null, getElementById: () => null,
      head: { appendChild: noop }, body: { appendChild: noop, removeChild: noop },
      documentElement: { matches: () => false },
      addEventListener: noop,
    },
    matchMedia: () => ({ matches: false, addEventListener: noop }),
    location: { host: 'test.cybozu.com', origin: 'https://test.cybozu.com', protocol: 'https:', pathname: '/k/310/', href: 'https://test.cybozu.com/k/310/' },
    requestIdleCallback: noop,
    ResizeObserver: class { observe() { } disconnect() { } },
    addEventListener: noop, removeEventListener: noop,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  //   2026-10-18: 読み込みの間に本体が作るタイマー（起動の待ち waitReady: kintone が無ければ 10 秒で打ち切って画面を起動する）は、読み込みの後に止める。
  //   テストは kintone を与えないので、実行が 10 秒を超えたファイルの途中で画面の起動が始まり、kintone が無い例外でテストが止まっていた
  //   （ai-consultation が 10.3 秒かかり §54 の後で止まった。setInterval は前から何もしない関数）。読み込みの後に作るタイマー（テストの待ち）は今までどおり
  const loadTimers = [];
  sandbox.setTimeout = (fn, ms, ...args) => { const t = setTimeout(fn, ms, ...args); loadTimers.push(t); return t; };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'kintoneAppToolkit.user.js' });
  sandbox.setTimeout = setTimeout;
  for (const t of loadTimers) clearTimeout(t);
  sandbox.__TEST__.__sandbox = sandbox;   // Phase 18: Customize タブのテストで window.loadMonaco / kintone / fetch を差し込む
  //   簡素化（2026-10-17）: 作った会話を覚え、テストが版から今の判定（反映できるか）を引けるようにする（tests/helpers/final-state.js）
  if (sandbox.__TEST__.KTAiConversation) require('./final-state.js').trackConversations(sandbox.__TEST__.KTAiConversation);
  return sandbox.__TEST__;
}

/** PASS/FAIL を出力する最小のアサーション（既存テストと同じ出力形式） */
function makeAssert() {
  const state = { failed: 0, passed: 0 };
  const assert = (cond, label) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}`);
    if (cond) state.passed++; else state.failed++;
  };
  return { assert, state };
}

module.exports = { loadToolkit, makeAssert };
