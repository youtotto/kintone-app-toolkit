'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {loadToolkit}=require('./helpers/load-toolkit.js');
const {formatConditionForDisplay:format}=loadToolkit();
const esc=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const cases=[
 ['',{badge:'',linesHtml:'—',linesText:''}],
 ['amount >= 30000',{badge:'',linesHtml:'amount &gt;= 30000',linesText:'amount >= 30000'}],
 ['amount >= 30000 and reason = ""',{badge:'AND',linesHtml:'amount &gt;= 30000<br>reason = &quot;&quot;',linesText:'amount >= 30000\nreason = ""'}],
 ['memo = "a and b" OR type = "c or d"',{badge:'OR',linesHtml:'memo = &quot;a and b&quot;<br>type = &quot;c or d&quot;',linesText:'memo = "a and b"\ntype = "c or d"'}],
 ['a = 1 and b = 2 or c = 3',{badge:'AND/OR',linesHtml:'a = 1<br>b = 2<br>c = 3',linesText:'a = 1\nb = 2\nc = 3'}],
 ['name = "<b>&x"',{badge:'',linesHtml:'name = &quot;&lt;b&gt;&amp;x&quot;',linesText:'name = "<b>&x"'}]
];
for(const [input,expected]of cases)test('通知・権限の条件表示を保持: '+(input||'条件なし'),()=>assert.deepEqual(JSON.parse(JSON.stringify(format(input,esc))),expected));
