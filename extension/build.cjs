'use strict';
// kintone App Toolkit の Chrome 拡張機能版（Manifest V3）を、ユーザースクリプト（kintoneAppToolkit.user.js）から組み立てる。
// ユーザースクリプトは変えない。違いはビルドで作る（同じソースから 2 つの配布物）。
//
//   node extension/build.cjs          → dist/extension/（展開したまま読み込める形）と dist/kintone-app-toolkit-<版>-chrome-extension.zip
//   node extension/build.cjs --check  → 書き出さずに、本体の変換と検査だけ
//
// ユーザースクリプト版との違い
//   1) mermaid（@require）と Monaco Editor（CDN）を同梱する。拡張機能のストア審査では外部から読み込んだコードの実行が禁止のため
//   2) 本体はページ側の世界（world: MAIN）で動かす（@grant none と同じく、ページの kintone を直接使う）
//   3) Monaco の置き場所だけを同梱物へ差し替える（拡張機能の場所は起動前の bootstrap.js が <html> の属性で伝える）
//   4) 自動更新（@updateURL）はストアに任せる
// 依存パッケージは使わない（tarball の展開と ZIP の作成は Node の標準機能だけで行う）。
const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib'), crypto = require('node:crypto'), vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const USERSCRIPT = path.join(ROOT, 'kintoneAppToolkit.user.js');
const CACHE = path.join(__dirname, '.vendor-cache');
const OUT = path.join(ROOT, 'dist', 'extension');
const CHECK = process.argv.includes('--check');
const lock = JSON.parse(fs.readFileSync(path.join(__dirname, 'vendor.lock.json'), 'utf8'));
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const fail = (m) => { throw new Error(m); };

// ---- 1) ユーザースクリプトのヘッダーを読む（想定外の変更があれば止める）----
const src = fs.readFileSync(USERSCRIPT, 'utf8');
const hm = src.match(/^\/\/ ==UserScript==\r?\n([\s\S]*?)\/\/ ==\/UserScript==\r?\n/);
if (!hm) fail('ユーザースクリプトのヘッダーが見つからない');
const meta = {};
for (const line of hm[1].split(/\r?\n/)) {
  const m = line.match(/^\/\/\s+@(\S+)\s+(.*)$/); if (!m) continue;
  (meta[m[1]] = meta[m[1]] || []).push(m[2].trim());
}
const one = (k) => { if (!meta[k] || meta[k].length !== 1) fail(`@${k} が 1 つではない`); return meta[k][0]; };
const version = one('version');
if (!/^\d+(\.\d+){0,3}$/.test(version)) fail('@version が拡張機能の版の形でない: ' + version);
const expectGrant = one('grant');
if (expectGrant !== 'none') fail('@grant が none でない（拡張機能版の作りの前提が変わった）: ' + expectGrant);
const requires = meta.require || [];
const mermaidPkg = lock.packages.find((p) => p.name === 'mermaid');
if (requires.length !== 1 || !/^https:\/\/cdn\.jsdelivr\.net\/npm\/mermaid@10\/dist\/mermaid\.min\.js$/.test(requires[0])) fail('@require が想定（mermaid@10 だけ）と違う。vendor.lock.json と build.cjs を見直す: ' + requires.join(', '));
if (!mermaidPkg.version.startsWith('10.')) fail('同梱する mermaid が 10 系でない');
// @match / @exclude はそのまま拡張機能の match pattern として使う。
//   どちらも * は任意の文字列（/ を含む）、? は文字どおり。拡張機能の match pattern はパスとクエリ（?以降）を合わせて照合する
const matches = meta.match || [];
const excludes = meta.exclude || [];
for (const m of [...matches, ...excludes]) if (!/^https:\/\/\*\.cybozu\.com\/[^\s#]*$/.test(m)) fail('想定外の @match / @exclude: ' + m);
const contentMatches = [...new Set(matches)];
const excludeMatches = [...new Set(excludes)];

// ---- 2) 本体（ヘッダーを除く）を作り、Monaco の置き場所だけを差し替える ----
let body = src.slice(hm[0].length);
const MONACO_CDN = "const MONACO_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.36.1/min/vs';";
const monacoPkg = lock.packages.find((p) => p.name === 'monaco-editor');
if (!MONACO_CDN.includes(`/monaco-editor/${monacoPkg.version}/`)) fail('同梱する Monaco の版と、本体が CDN から読む版が違う');
if (body.split(MONACO_CDN).length !== 2) fail('MONACO_BASE の行が 1 つではない（本体が変わった。build.cjs を見直す）');
body = body.replace(MONACO_CDN,
  "// [Chrome 拡張機能版] Monaco Editor は拡張機能に同梱したものを使う（場所は bootstrap.js が <html> の属性で渡す）\n" +
  "  const MONACO_BASE = ((document.documentElement && typeof document.documentElement.getAttribute === 'function' && document.documentElement.getAttribute('data-nr-toolkit-ext-base')) || '') + 'vendor/monaco/vs';");
// 外部から JS を読み込む箇所が、差し替えた Monaco の 1 か所だけであること
//   - <script> を作るのは Monaco のローダーだけ
//   - CDN の名前は、利用者のアプリの JS を解析するときの「配布元の一覧」（データ）にだけ出る
if (body.split("document.createElement('script')").length !== 2) fail("<script> を作る箇所が 1 つではない");
const cdnLines = body.split(/\r?\n/).map((l, i) => [i + 1, l]).filter(([, l]) => /cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com/.test(l));
const knownCdnLine = (l) => /^\s*(\*|\/\/)/.test(l) || /\{ host: 'cdnjs\.cloudflare\.com'/.test(l) || /host:\s*'(cdn\.jsdelivr\.net|unpkg\.com)'/.test(l);
const unknown = cdnLines.filter(([, l]) => !knownCdnLine(l));
if (unknown.length) fail('CDN を読み込んでいるかもしれない行がある:\n' + unknown.map(([n, l]) => `  ${n}: ${l.trim().slice(0, 160)}`).join('\n'));
if (/\beval\s*\(/.test(body)) fail('eval がある');
// Chrome は content script のファイルに Unicode の非文字（U+FFFE・U+FFFF・U+FDD0〜U+FDEF）がそのまま入っていると
// 「UTF-8 でエンコードされていない」として拡張機能を読み込まない。正規表現・文字列の範囲の終わり（-\uFFFF）に使われているだけなので、
// 意味の同じ \uFFFF の書き方に置き換える（範囲の終わり以外の場所にあれば止める）
const NONCHAR = /[\uFDD0-\uFDEF\uFFFE\uFFFF]/g;
function escapeNonchars(text, name) {
  let n = 0;
  const out = text.replace(NONCHAR, (ch, i) => {
    if (text[i - 1] !== '-') fail(`${name}: 範囲の終わり以外に非文字 U+${ch.charCodeAt(0).toString(16).toUpperCase()} がある（位置 ${i}）`);
    n++; return '\\u' + ch.charCodeAt(0).toString(16).toUpperCase();
  });
  return { text: out, count: n };
}
const tk = escapeNonchars(body, 'toolkit.js');
body = tk.text;
try { new vm.Script(body, { filename: 'toolkit.js' }); } catch (e) { fail('本体の構文: ' + e.message); }
const toolkitJs = Buffer.from(`// kintone App Toolkit ${version}（Chrome 拡張機能版）。kintoneAppToolkit.user.js から extension/build.cjs で作成。\n` + body, 'utf8');

// ---- 3) manifest ----
const description = one('description');
if ([...description].length > 132) fail('説明が 132 文字を超える（ストアの上限）');
const manifest = {
  manifest_version: 3,
  name: one('name'),
  version,
  description,
  minimum_chrome_version: '111',
  icons: { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' },
  content_scripts: [
    { matches: contentMatches, exclude_matches: excludeMatches, js: ['bootstrap.js'], run_at: 'document_start' },
    { matches: contentMatches, exclude_matches: excludeMatches, js: ['vendor/mermaid/mermaid.min.js', 'toolkit.js'], run_at: 'document_idle', world: 'MAIN' },
  ],
  web_accessible_resources: [{ resources: ['vendor/monaco/vs/*'], matches: ['https://*.cybozu.com/*'] }],
};

// ---- 4) 同梱物（npm の tarball を取得・照合・展開）----
function readTar(buf) {
  const files = {}; let off = 0; let paxPath = null;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a, n) => h.subarray(a, a + n).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(str(124, 12).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 48);
    const prefix = str(345, 155);
    let name = (prefix ? prefix + '/' : '') + str(0, 100);
    const data = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') { const m = data.toString('utf8').match(/\d+ path=([^\n]*)\n/); paxPath = m ? m[1] : null; continue; }
    if (type === 'g') continue;
    if (paxPath) { name = paxPath; paxPath = null; }
    if (type === '0' || type === '\0' || type === '7') files[name] = Buffer.from(data);
  }
  return files;
}
async function vendorFiles() {
  fs.mkdirSync(CACHE, { recursive: true });
  const out = {}; const record = [];
  for (const p of lock.packages) {
    const tgzPath = path.join(CACHE, `${p.name}-${p.version}.tgz`);
    if (!fs.existsSync(tgzPath)) {
      const r = await fetch(p.tarball);
      if (!r.ok) fail(`${p.name} の取得に失敗: ${r.status}`);
      fs.writeFileSync(tgzPath, Buffer.from(await r.arrayBuffer()));
    }
    const tgz = fs.readFileSync(tgzPath);
    const [alg, expected] = p.integrity.split('-');
    if (crypto.createHash(alg).update(tgz).digest('base64') !== expected) { fs.rmSync(tgzPath); fail(`${p.name} の tarball が integrity と一致しない`); }
    const tar = readTar(zlib.gunzipSync(tgz));
    const pkgJson = JSON.parse(tar['package/package.json'].toString('utf8'));
    if (pkgJson.version !== p.version || pkgJson.name !== p.name) fail(`${p.name} の package.json が想定と違う`);
    let count = 0;
    for (const c of p.copy) {
      if (c.url) {
        const f = path.join(CACHE, `${p.name}-${p.version}-${path.basename(c.to)}`);
        if (!fs.existsSync(f)) { const r = await fetch(c.url); if (!r.ok) fail(`${c.url} の取得に失敗: ${r.status}`); fs.writeFileSync(f, Buffer.from(await r.arrayBuffer())); }
        const b = fs.readFileSync(f);
        if (sha256(b) !== c.sha256) { fs.rmSync(f); fail(`${c.url} が sha256 と一致しない`); }
        out[c.to] = b; count++;
      } else if (c.fromDir) {
        for (const [n, b] of Object.entries(tar)) if (n.startsWith(c.fromDir)) { out[c.to + n.slice(c.fromDir.length)] = b; count++; }
      } else if (tar[c.from]) { out[c.to] = tar[c.from]; count++; }
      else if (!c.optional) fail(`${p.name} に ${c.from} がない`);
    }
    record.push({ name: p.name, version: p.version, files: count, tarballSha256: sha256(tgz) });
  }
  return { out, record };
}

// ---- 5) ZIP（deflate）。Node の標準機能だけで作る ----
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function makeZip(entries) {
  const parts = [], central = []; let off = 0;
  const dosTime = 0, dosDate = ((2026 - 1980) << 9) | (11 << 5) | 12; // 中身が同じなら同じ ZIP になるよう日時は固定
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const comp = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, comp);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(dosTime, 12); cen.writeUInt16LE(dosDate, 14); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(off, 42);
    central.push(cen, nameBuf);
    off += 30 + nameBuf.length + comp.length;
  }
  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cenBuf.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cenBuf, end]);
}

(async () => {
  const summary = { version, contentMatches, excludeMatches, toolkitJsSha256: sha256(toolkitJs), userscriptSha256: sha256(Buffer.from(src, 'utf8')) };
  if (CHECK) { console.log(JSON.stringify(summary, null, 1)); console.log('（--check: 書き出していない）'); return; }
  const { out: vendor, record } = await vendorFiles();
  const files = {
    'manifest.json': Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8'),
    'bootstrap.js': fs.readFileSync(path.join(__dirname, 'src', 'bootstrap.js')),
    'toolkit.js': toolkitJs,
    'LICENSE.md': fs.readFileSync(path.join(ROOT, 'LICENSE.md')),
    ...Object.fromEntries([16, 32, 48, 128].map((s) => [`icons/icon${s}.png`, fs.readFileSync(path.join(__dirname, 'icons', `icon${s}.png`))])),
    ...vendor,
  };
  // content script（mermaid）も同じく非文字を置き換える。置き換えの前後で構文が保たれることを確かめる
  const mm = escapeNonchars(files['vendor/mermaid/mermaid.min.js'].toString('utf8'), 'mermaid.min.js');
  try { new vm.Script(mm.text, { filename: 'mermaid.min.js' }); } catch (e) { fail('mermaid の構文: ' + e.message); }
  files['vendor/mermaid/mermaid.min.js'] = Buffer.from(mm.text, 'utf8');
  summary.noncharEscaped = { 'toolkit.js': tk.count, 'vendor/mermaid/mermaid.min.js': mm.count };
  // content script は正しい UTF-8 で、非文字が無いこと（Chrome が読み込みを拒否する条件）
  for (const cs of manifest.content_scripts) for (const f of cs.js) {
    const b = files[f];
    try { new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { fail(`${f} が UTF-8 として正しくない`); }
    if (NONCHAR.test(b.toString('utf8'))) fail(`${f} に非文字が残っている`);
    NONCHAR.lastIndex = 0;
  }
  // manifest が参照するファイルがすべてあること
  for (const cs of manifest.content_scripts) for (const f of cs.js) if (!files[f]) fail('manifest の参照先がない: ' + f);
  for (const f of Object.values(manifest.icons)) if (!files[f]) fail('アイコンがない: ' + f);
  // 本体が読み込む Monaco のローダー（`${MONACO_BASE}/loader.min.js`）が同梱物にあること
  const loaderName = (body.match(/\$\{MONACO_BASE\}\/([\w.]+\.js)/) || [])[1];
  if (!loaderName || !files[`vendor/monaco/vs/${loaderName}`]) fail('本体が読み込む Monaco のローダーが同梱物にない: ' + loaderName);
  // 書き出し（dist/extension は毎回作り直す。dist はリポジトリの管理外）
  fs.rmSync(OUT, { recursive: true, force: true });
  for (const [n, b] of Object.entries(files)) { const f = path.join(OUT, n); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, b); }
  const names = Object.keys(files).sort();
  const zip = makeZip(names.map((n) => [n, files[n]]));
  const zipPath = path.join(ROOT, 'dist', `kintone-app-toolkit-${version}-chrome-extension.zip`);
  fs.writeFileSync(zipPath, zip);
  Object.assign(summary, { files: names.length, bytes: names.reduce((s, n) => s + files[n].length, 0), zip: path.relative(ROOT, zipPath), zipBytes: zip.length, zipSha256: sha256(zip), vendor: record });
  fs.writeFileSync(path.join(ROOT, 'dist', 'extension-build.json'), JSON.stringify(summary, null, 1));
  console.log(JSON.stringify(summary, null, 1));
})().catch((e) => { console.error('失敗: ' + e.message); process.exit(1); });
