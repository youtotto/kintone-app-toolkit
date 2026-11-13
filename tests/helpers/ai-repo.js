'use strict';
// Offline integration tests share contracts with the separately managed AI repo.
const fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..');
let resolved;
function resolveAiRepo(){
  if(resolved)return resolved;
  const config=process.env.KT_AI_REPO?null:spawnSync('git',['-C',root,'config','--local','--get','toolkit.aiRepo'],{encoding:'utf8'});
  const configured=process.env.KT_AI_REPO||(config?.status===0?config.stdout.trim():'');
  const candidate=path.resolve(root,configured||'../AI');
  if(!fs.existsSync(path.join(candidate,'worker/src/v2/prompt-registry.mjs')))throw new Error('AI test repository not found. Set KT_AI_REPO or git config --local toolkit.aiRepo to the AI repository path.');
  resolved=candidate;return resolved;
}
const aiUrl=relative=>pathToFileURL(path.join(resolveAiRepo(),relative)).href;
module.exports={resolveAiRepo,aiUrl};
