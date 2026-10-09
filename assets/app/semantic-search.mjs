// Background jobs keep the native helper responsive to Cancel and navigation.
export async function semanticSearch(api,body,signal){
  let id,complete=false;
  try{
    signal.throwIfAborted();const job=await api('semantic/start',body);id=job.id;
    if(typeof id!=='string')throw new Error('Semantic search returned an invalid request.');
    for(let i=0;i<80;i++){
      signal.throwIfAborted();const result=await api(`semantic/result?${new URLSearchParams({id})}`);signal.throwIfAborted();
      if(result.state!=='running'){complete=true;return result;}
      await new Promise((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(new Error('Cancelled'));};const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},150);signal.addEventListener('abort',abort,{once:true});});
    }
    throw new Error('Semantic search timed out. Exact search is available.');
  }finally{if(id&&!complete)await api('semantic/cancel',{id}).catch(()=>{});}
}
