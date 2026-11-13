'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {loadToolkit}=require('./helpers/load-toolkit.js');
const C=loadToolkit().KTAiClient;
test('新healthは業務320秒・相談140秒、旧healthは互換値で待つ',()=>{
 const health={limits:{version:1,deadlineMs:{'toolkit.assistant-qa':300000},features:{'toolkit.assistant-qa':{deadlineMsByPurpose:{business:300000,consultation:120000}}}}};
 const limits=C.limitsFromHealth(health),feature=limits.features['assistant-qa'];
 assert.equal(C.clientLimitFromDeadline(feature.deadlineMsByPurpose.business),320000);
 assert.equal(C.clientLimitFromDeadline(feature.deadlineMsByPurpose.consultation),140000);
 // Old clients read only the feature-wide value; they must not cut off business at 140s.
 assert.equal(C.clientLimitFromDeadline(limits.deadlineMs['assistant-qa']),320000);
 delete health.limits.features;health.limits.deadlineMs['toolkit.assistant-qa']=120000;
 assert.equal(C.clientLimitFromDeadline(C.limitsFromHealth(health).deadlineMs['assistant-qa']),140000);
 assert.equal(C.clientLimitFromDeadline(600000),330000);
});
