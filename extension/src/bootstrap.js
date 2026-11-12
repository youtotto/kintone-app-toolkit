// Chrome 拡張機能版の起動前の準備（拡張機能側の世界 ISOLATED で、ページの読み込み開始時に動く）。
// 本体（toolkit.js）はページ側の世界 MAIN で動くため chrome.runtime を使えない。
// 同梱した Monaco Editor の場所（chrome-extension://<ID>/）を、ページの <html> の属性で本体へ伝える。
document.documentElement.setAttribute('data-nr-toolkit-ext-base', chrome.runtime.getURL(''));
