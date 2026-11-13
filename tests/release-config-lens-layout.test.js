'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { KTReleaseConfigLensLayout: Layout } = require('../src/release-config-lens-layout.js');
const oracle = require('./fixtures/config-lens-fa9a942.cjs');
const clone = value => JSON.parse(JSON.stringify(value));
const row = fields => ({ type: 'ROW', fields });
const labels = { before: '運用環境', after: '保存ファイル' };
const settings = (layout, properties = {}) => ({ layout: { revision: '1', layout }, fields: { revision: '1', properties } });
test('本家と同じ識別・変更判定で行移動、寸法、項目設定、追加削除、匿名部品を区別する', () => {
  const before = [row([{type:'SINGLE_LINE_TEXT',code:'memo',size:{width:'200'}},{type:'SPACER'},{type:'HR',elementId:'divider'}]),{type:'GROUP',code:'g',layout:[row([{type:'DATE',code:'date'}])]}];
  const after = [row([{type:'SPACER'},{type:'SINGLE_LINE_TEXT',code:'memo',size:{width:'300'}}]),{type:'SUBTABLE',code:'t',fields:[{type:'NUMBER',code:'amount'}]}];
  const a = {memo:{type:'SINGLE_LINE_TEXT',label:'旧'}}, b = {memo:{type:'SINGLE_LINE_TEXT',label:'新',required:true}};
  const input = clone({before,after,a,b});
  assert.deepEqual(Layout.layoutMarks(before,after,a,b),oracle.layoutMarks(before,after,a,b));
  assert.deepEqual(Layout.layoutIndex(before),oracle.layoutIndex(before));
  assert.equal(Layout.layoutMarks(before,after,a,b)[1].get('0/fields/1').text,'配置位置・寸法・部品・項目設定');
  assert.deepEqual({before,after,a,b},input);
  const duplicate = [row([{type:'SPACER',elementId:'same'},{type:'SPACER',elementId:'same'}])];
  assert.deepEqual(Layout.layoutIndex(duplicate),oracle.layoutIndex(duplicate));
  assert.ok([...Layout.layoutMarks(duplicate,duplicate)[0].values()].every(m=>m.anonymous));
});
test('未取得・不正形式を空フォームと区別し、正常な空フォームと変更なしを描く', () => {
  for(const value of [null,{before:settings([]),after:null},{before:settings([null]),after:settings([])},{before:settings([row('invalid')]),after:settings([])}]) {
    const html=Layout.render(value,labels);
    assert.match(html,/data-cl-layout-unavailable/);assert.doesNotMatch(html,/ktcl-layout-canvas|配置された項目はありません/);
  }
  const comparison={before:settings([]),after:settings([])};
  assert.equal((Layout.render(comparison,labels).match(/配置された項目はありません/g)||[]).length,2);
  comparison.before=comparison.after=settings([row([{type:'SINGLE_LINE_TEXT',code:'memo'}])],{memo:{type:'SINGLE_LINE_TEXT',label:'備考'}});
  const html=Layout.render(comparison,labels);
  assert.match(html,/備考/);assert.doesNotMatch(html,/class="ktcl-layout-node ktcl-layout-(added|changed|deleted)/);
});
test('寸法は数値に限定し、設定値をHTMLやCSSとして展開せず入力を変更しない', () => {
  const attack='<img src="https://invalid.test/x" onerror="alert(1)">';
  const side=settings([row([{type:'LABEL',label:attack},{type:'SINGLE_LINE_TEXT',code:'memo',size:{width:'2; background:url(x)',innerHeight:'99999'}}])],{memo:{type:'SINGLE_LINE_TEXT',label:attack}});
  const comparison={before:side,after:clone(side)}, original=clone(comparison), html=Layout.render(comparison,labels);
  assert.doesNotMatch(html,/<img|onerror="alert|style="[^"]*url\(/);
  assert.match(html,/width:200px/);assert.match(html,/min-height:3000px/);
  assert.deepEqual(comparison,original);
  assert.equal(Layout.dimension('0',200),20);assert.equal(Layout.dimension('-1',200),200);
});
