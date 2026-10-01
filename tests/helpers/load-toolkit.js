// 実スクリプトを Node の vm sandbox に読み込み、内部モジュール（KTDeps / KTScan / KTIncoming / KTContext）を取り出す。
// DOM / kintone API は与えない（純関数の部分だけをテストする）。既存テストと同じ方式を共通化したもの。
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadToolkit() {
  const SRC = path.join(__dirname, '..', '..', 'kintoneAppToolkit.user.js');
  let code = fs.readFileSync(SRC, 'utf8');
  const lastClose = code.lastIndexOf('})();');
  if (lastClose < 0) throw new Error('IIFE close not found');
  code = code.slice(0, lastClose)
    + '\n  globalThis.__TEST__ = { KTDeps, KTScan, KTIncoming, KTContext, KTContextUi, mountAiDocsPanel, SCRIPT_VERSION };\n'
    + code.slice(lastClose);

  const noop = () => { };
  const fakeStorage = { getItem: () => null, setItem: noop, removeItem: noop };
  const sandbox = {
    console, setTimeout, clearTimeout,
    setInterval: () => 0, clearInterval: noop,
    localStorage: fakeStorage, sessionStorage: fakeStorage,
    navigator: {},
    document: {
      createElement: () => ({ style: {}, setAttribute: noop, addEventListener: noop, appendChild: noop }),
      querySelector: () => null, getElementById: () => null,
      head: { appendChild: noop }, body: { appendChild: noop, removeChild: noop },
      documentElement: { matches: () => false },
      addEventListener: noop,
    },
    matchMedia: () => ({ matches: false, addEventListener: noop }),
    location: { host: 'test.cybozu.com', origin: 'https://test.cybozu.com' },
    requestIdleCallback: noop,
    ResizeObserver: class { observe() { } disconnect() { } },
    addEventListener: noop, removeEventListener: noop,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'kintoneAppToolkit.user.js' });
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
