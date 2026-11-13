'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {KTAiBudget:B}=require('./helpers/load-toolkit.js').loadToolkit({ verificationBudget: true });
test('診断Solと業務Astraの事前見積もりは用途と実際のモデルに一致',()=>{
 const limits={features:{'assistant-qa':{model:'gpt-6-luna',modelsByPurpose:{diagnosis:'gpt-6.1-sol',business:'gpt-6-astra',document:'gpt-6.1-sol',consultation:'gpt-6-luna'},serviceTier:'default',maxOutputTokens:4000,maxAiCalls:1}}};
 const estimate=ctx=>B.estimate({kind:'propose',ctx,limits,ctxBytes:1000});
 const diagnosis=estimate({requestPurpose:'ideation',focus:{target:{type:'app-diagnosis'}}}),business=estimate({requestPurpose:'document',businessSnapshot:{}});
 assert.equal(diagnosis.model,'gpt-6.1-sol');assert.equal(business.model,'gpt-6-astra');assert.equal(business.ok,true);assert.equal(business.price.input,10);assert.equal(business.price.output,50);assert.ok(business.maxUsd>diagnosis.maxUsd);
 assert.equal(estimate({requestPurpose:'consultation'}).model,'gpt-6-luna');assert.equal(estimate({requestPurpose:'document'}).model,'gpt-6.1-sol');
});
