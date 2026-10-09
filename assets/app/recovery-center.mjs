export function recoveryCenter({$,api,checkout,beforeNavigate,resume,notice}) {
  const dialog=$('recovery-dialog');let rows=[],offset=0,hasMore=false,sequence=0;
  function localItems(){
    const items=[];let unreadable=0;
    try { for(let i=0;i<localStorage.length;i++) {
      const key=localStorage.key(i),prefix=`runlist:recovery:${checkout()}:`,lifecycle=`runlist:lifecycle:${checkout()}:`,record=`runlist:record-action:${checkout()}:`,yardstick=`runlist:yardstick:${checkout()}:`;
      if(!key.startsWith(prefix)&&!key.startsWith(lifecycle)&&!key.startsWith(record)&&!key.startsWith(yardstick)&&key!==`runlist:create:${checkout()}`)continue;
      try {
        const value=JSON.parse(localStorage.getItem(key));if(!value)continue;
        if(key.startsWith(prefix)&&typeof value.path==='string'&&typeof value.source==='string'&&typeof value.baseSource==='string'&&(value.source!==value.baseSource||value.pending))items.push({kind:'local-draft',path:value.path,location:key,draftId:value.draft?.id,operationId:value.pending?.operationId,at:new Date(value.at).toISOString(),stale:!!value.conflicted,state:value.pending?'interrupted':value.conflicted?'conflict':'draft',available:true});
        else if(key.startsWith(yardstick))items.push({kind:'yardstick',path:value.path,operationId:value.operationId,at:'',available:true,state:value.state??'retained'});
        else if(key.startsWith(lifecycle))items.push({kind:'lifecycle',path:value.path,operationId:value.operationId,at:'',available:true,state:'retained'});
        else if(key.startsWith(record)){const suffix=key.slice(record.length),colon=suffix.indexOf(':');items.push({kind:'record',recordKind:suffix.slice(0,colon),recordKey:suffix.slice(colon+1),path:value.request?.path??'Flag or decision',at:'',available:true,state:'retained'});}
        else if(key===`runlist:create:${checkout()}`&&(value.form?.title||value.form?.body||value.review))items.push({kind:'creation',operationId:value.review?.operationId,path:value.review?.path??`${value.form?.folder??''}/${value.form?.filename??'New document'}`,state:value.review?.state??'draft',at:new Date(value.at).toISOString(),available:true});
      }catch{unreadable++;}
    }
    } catch {unreadable++;}
    return {items,unreadable};
  }
  const label=row=>row.kind==='git-commit'?`Local Git commit · ${row.state}`:row.kind==='creation'?'New document draft':row.kind==='yardstick'?`Product goal assessment · ${row.state}`:row.kind==='lifecycle'?`Status change · ${row.state}`:row.kind==='record'?'Flag or decision review':row.kind==='operation'?'Interrupted save · inspect outcome':row.operationId||row.pendingOperation?'Interrupted save · draft preserved locally':row.stale?'File changed · compare draft':'Draft preserved locally';
  function render(){
    const query=$('recovery-filter').value.toLowerCase(),visible=rows.filter(row=>`${row.path} ${label(row)}`.toLowerCase().includes(query));
    $('recovery-items').replaceChildren(...visible.map(row=>{
      const section=document.createElement('section');section.className='recovery-item';
      const info=document.createElement('div'),title=document.createElement('strong'),detail=document.createElement('p'),date=document.createElement('small');title.textContent=row.path;detail.textContent=label(row);date.textContent=row.at?new Date(row.at).toLocaleString():'';info.append(title,detail,date);
      const button=document.createElement('button');button.className='quiet';button.textContent=!row.available?'File unavailable':row.kind==='creation'?'Resume creation':row.kind==='git-commit'||row.kind==='yardstick'||row.kind==='lifecycle'||row.kind==='operation'?'Inspect operation':row.kind==='record'?'Resume review':'Resume draft';button.disabled=!row.available;
      button.onclick=async()=>{try{dialog.close();await resume(row);}catch(error){notice(error.message,true);}};section.append(info,button);return section;
    }));
    if(!visible.length){const message=document.createElement('p');message.className='library-no-results';message.textContent=query?'No recovery items match this filter.':'No unfinished work in this checkout.';$('recovery-items').append(message);}
    $('recovery-more').hidden=!hasMore;
  }
  async function load(more=false){
    const own=++sequence;$('recovery-status').textContent='Reading retained work…';$('recovery-refresh').disabled=true;
    try {
      if(!more)offset=0;
      const result=await api(`recovery?offset=${offset}&limit=50`);if(own!==sequence)return;
      const local=localItems(),disk=more?rows.filter(row=>row.disk):[];
      const localDrafts=new Set(local.items.map(row=>row.draftId).filter(Boolean)),localOperations=new Set(local.items.map(row=>row.operationId).filter(Boolean));
      const diskRows=[...disk,...result.items.map(row=>({...row,disk:true}))];
      const pendingDrafts=new Set(diskRows.filter(row=>row.kind==='draft').map(row=>row.pendingOperation?.operationId).filter(Boolean));
      const entries=[...local.items,...diskRows.filter(row=>!localDrafts.has(row.draftId)&&!localOperations.has(row.operationId)&&!(row.kind==='operation'&&pendingDrafts.has(row.operationId)))],seen=new Set();rows=entries.filter(row=>{
        const key=row.location??(row.operationId?`${row.kind}:${row.operationId}`:row.draftId?`draft:${row.draftId}`:`${row.kind}:${row.path}`);
        if(seen.has(key))return false;seen.add(key);return true;
      });
      rows.sort((a,b)=>String(b.at).localeCompare(String(a.at)));offset=result.offset+result.items.length;hasMore=result.hasMore;render();
      $('recovery-status').textContent=`${rows.length} items shown${hasMore?' · More retained items available':''}${result.unavailable||local.unreadable?` · ${result.unavailable+local.unreadable} entries need manual inspection; their stored data was kept.`:''}`;
    }catch(error){$('recovery-status').textContent=`Recovery unavailable. ${error.message} Retained data has been kept.`;}
    finally{if(own===sequence)$('recovery-refresh').disabled=false;}
  }
  async function show(){await beforeNavigate();$('recovery-filter').value='';dialog.showModal();$('recovery-filter').focus();await load();}
  $('open-recovery').onclick=()=>show().catch(error=>notice(error.message,true));$('recovery-close').onclick=()=>dialog.close();$('recovery-refresh').onclick=()=>load();$('recovery-more').onclick=()=>load(true);$('recovery-filter').oninput=render;
  return {show,load};
}
