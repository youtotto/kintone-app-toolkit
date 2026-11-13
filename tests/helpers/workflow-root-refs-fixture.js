'use strict';
const F=require('./business-fixture.js');
async function fixture(count=60){
 const data=F.raw();
 for(let i=0;i<count;i++){const code='extra_'+i;data.fields.properties[code]={code,label:'補助項目'+i,type:'SINGLE_LINE_TEXT',required:false,expression:''};}
 const {s}=await F.snapshot({data}),answer=F.workflowAnswer(s),r=answer.businessUnderstanding.rules[0];
 const fields=s.evidence.filter(e=>e.kind==='field'&&e.value.code.startsWith('extra_'));
 const refs=fields.map(e=>({evidenceId:e.evidenceId,pointer:null}));
 r.evidenceRefs.push(...refs);
 for(let i=0;i<Math.min(refs.length,60);i+=20)r.inputs.push({kind:'check',interpretation:'これらの入力項目と運用の対応は未確認です。',evidenceRefs:refs.slice(i,i+20)});
 return {s,answer,fields};
}
module.exports={fixture};
