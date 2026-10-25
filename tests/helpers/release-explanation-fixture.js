'use strict';
const clone = value => JSON.parse(JSON.stringify(value));
function explanation(title='案件管理の仕組み') {
 return { title, sections: [
  { heading:'アプリの目的', paragraphs:['案件の受付から承認までを管理します。'], items:['備考には引き継ぐ内容を記入します。'], table:null, evidenceIds:['E1','unknown'] },
  { heading:'確認する項目', paragraphs:[], items:[], table:{ columns:['項目','意味','補足'], rows:[
   ['備考','引き継ぐ内容','複数行で入力できます。'],
   ['<img src=x onerror="window.injected=true">','A|B\n次の行','[実行](javascript:alert(1))'],
   ...Array.from({length:32},(_,i)=>['項目'+(i+1),'長い説明'.repeat(15),'確認する内容'.repeat(8)])
  ] }, evidenceIds:['E1'] }
 ], unknowns:['運用担当者の確認はまだ行っていません。'] };
}
const facts=[{id:'E1',statement:'備考は文字列（複数行）です。',kind:'field',confidence:'confirmed',value:{code:'memo',type:'MULTI_LINE_TEXT'}},
 {id:'E2',statement:'この項目は説明から参照されていません。',value:'参照していない設定'}];
function response(title) { return { reply:'説明をまとめました。右側で確認できます。',intent:'question',proposalUnchanged:true,explanation:explanation(title),turn:{ops:[],answers:[],requirementOps:[]},facts:clone(facts) }; }
module.exports={explanation,response,facts,clone};
