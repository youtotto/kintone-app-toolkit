'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {KTReleaseUtils:U}=require('../src/release-utils.js');

test('HTML text escapes markup and quotes while preserving Japanese, Unicode and newlines',()=>{
  assert.equal(U.escapeHtml('<script a="x" b=\'y\'>&日本語😀\n</script>'),'&lt;script a=&quot;x&quot; b=&#39;y&#39;&gt;&amp;日本語😀\n&lt;/script&gt;');
  assert.equal(U.escapeHtml('&amp;'),'&amp;amp;');
  for(const value of [null,undefined])assert.equal(U.escapeHtml(value),'');
  assert.equal(U.escapeHtml(0),'0');assert.equal(U.escapeHtml(false),'false');
});
test('JSON snapshots preserve persisted normalization and isolate nested edits',()=>{
  const input={date:new Date('2026-11-16T00:00:00Z'),missing:undefined,values:[undefined,NaN,Infinity],nested:{text:'申請\n😀'}};
  const saved=U.cloneJson(input);
  assert.deepEqual(saved,{date:'2026-11-16T00:00:00.000Z',values:[null,null,null],nested:{text:'申請\n😀'}});
  saved.nested.text='変更';assert.equal(input.nested.text,'申請\n😀');
  for(const value of [null,undefined,0,false,''])assert.equal(U.cloneJson(value),value);
});
test('unsupported snapshots still reject cycles and BigInt instead of silently changing storage semantics',()=>{
  const cycle={};cycle.self=cycle;
  assert.throws(()=>U.cloneJson(cycle),TypeError);assert.throws(()=>U.cloneJson({value:1n}),TypeError);
});
test('JSON toJSON behavior and opaque field names are retained',()=>{
  const field=JSON.parse('{"__proto__":{"value":"保持"},"constructor":"項目"}');
  const value=U.cloneJson({field,custom:{toJSON:()=>({kind:'saved'})}});
  assert.equal(Object.hasOwn(value.field,'__proto__'),true);
  assert.equal(value.field.__proto__.value,'保持');assert.equal(value.field.constructor,'項目');
  assert.deepEqual(value.custom,{kind:'saved'});assert.equal(Object.getPrototypeOf(value.field),Object.prototype);
});
