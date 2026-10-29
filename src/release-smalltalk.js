/* Isolated casual conversation: never owns proposals, app context or paid actions. */
'use strict';
const KTReleaseSmalltalk=(()=>{
 const clone=x=>JSON.parse(JSON.stringify(x));
 const usageOf=x=>x&&['monthly'].every(k=>x[k]&&['used','remaining','limit'].every(n=>Number.isSafeInteger(x[k][n])&&x[k][n]>=0)&&Number.isFinite(Date.parse(x[k].resetsAt)))?clone(x):null;
 const valid=s=>s&&Object.keys(s).every(k=>['version','open','draft','turns'].includes(k))&&s.version===1&&typeof s.open==='boolean'&&typeof s.draft==='string'&&s.draft.length<=10000&&Array.isArray(s.turns)&&s.turns.length<=10000&&s.turns.every(t=>t&&Object.keys(t).every(k=>['id','user','reply','handoff'].includes(k))&&typeof t.id==='string'&&typeof t.user==='string'&&[...t.user].length<=500&&(t.reply==null||typeof t.reply==='string'&&[...t.reply].length<=1200)&&typeof t.handoff==='boolean');
 function create({send,available,canSend,beforeSend=async()=>true,makeId=()=>globalThis.crypto.randomUUID()}){
  let state={version:1,open:false,draft:'',turns:[],pending:false,error:'',usage:null},abort=null,disposed=false;
  const listeners=new Set(),emit=(redraw=true)=>listeners.forEach(fn=>fn(redraw));
  function setDraft(text){state.draft=String(text);emit(false);}
  async function submit(){
   if(disposed||state.pending||!state.open||!canSend())return false;
   const text=state.draft.trim();
   if(!text||[...text].length>500){state.error='雑談は500文字以内で入力してください。';emit();return false;}
   state.pending=true;state.error='';abort=new AbortController();const signal=abort.signal;emit();
   let started=false;
   try{
    if(!await beforeSend()||disposed||signal.aborted)return false;
    if(!available())throw Error('雑談を利用できません。接続先・契約・AIサービスの更新を確認してください。');
    const history=state.turns.filter(t=>typeof t.reply==='string').slice(-3).map(t=>({user:t.user,assistant:t.reply}));
    const id=makeId(),turn={id,user:text,reply:null,handoff:false};
    state.turns.push(turn);state.draft='';started=true;emit();
    const result=await send({text,history,requestId:id,signal});
    if(disposed||signal.aborted)return false;
    if(result?.ok!==true||result.version!==1||typeof result.reply!=='string'||!result.reply.trim()||[...result.reply].length>1200||typeof result.handoff!=='boolean')throw Error('雑談の返答を確認できませんでした。');
    turn.reply=result.reply;turn.handoff=result.handoff;state.usage=usageOf(result.smalltalkUsage);
    return true;
   }catch(error){
    if(!disposed){state.error=signal.aborted?'雑談を中断しました。送信開始後の無料枠は戻りません。':error?.message||'雑談の返答を受け取れませんでした。';state.usage=usageOf(error?.details?.error?.detail?.smalltalkUsage||error?.details?.smalltalkUsage||error?.detail?.smalltalkUsage)||state.usage;if(started&&!state.draft)state.draft=text;}
    return false;
   }finally{if(signal.aborted&&started&&!state.draft)state.draft=text;state.pending=false;abort=null;if(!disposed)emit();}
  }
  return {getState:()=>clone(state),setDraft,submit,
   toggle(){if(disposed||state.pending||!canSend())return false;state.open=!state.open;state.error='';emit();return true;},
   close(){if(state.pending)return false;state.open=false;emit();return true;},
   cancel(){abort?.abort();state.error='雑談を中断しました。送信開始後の無料枠は戻りません。';emit();},
   handoff(id){const t=state.turns.find(t=>t.id===id);return t?.reply&&t.handoff?'次の話題について、このアプリでの対応を相談したいです。雑談の内容は未採用で、現在のアプリでは未確認です。設定を確認してから提案してください。\n\n私の依頼：'+t.user+'\n\n雑談の回答（未確認）：'+t.reply:null;},
   snapshot(){return {version:1,open:state.open,draft:state.draft,turns:clone(state.turns)};},
   restore(saved){if(state.pending||!valid(saved))return false;state={...clone(saved),pending:false,error:saved.turns.some(t=>t.reply==null)?'返答が残っていない送信があります。自動では再送しません。':'',usage:null};emit();return true;},
   reset(){if(state.pending)return false;state={version:1,open:false,draft:'',turns:[],pending:false,error:'',usage:null};emit();return true;},
   subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},dispose(){disposed=true;abort?.abort();listeners.clear();}
  };
 }
 return {create,valid};
})();
if (typeof module !== 'undefined' && module.exports) module.exports=KTReleaseSmalltalk;
