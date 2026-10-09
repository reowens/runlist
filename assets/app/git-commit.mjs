import {escapeHtml as esc,diffHtml} from './shared.mjs';
// Explicit review/commit/inspection only. Polling never executes or recovers.
export function gitCommit({$,api,checkout,selection,changed,notice}){
 const messages=new Map(),dialog=$('git-commit-dialog');let operation=null,owner=null,busy=false,timer,sequence=0,visited=new Set();
 const pathLabel=name=>String(name).replace(/[\x00-\x1f\x7f]/g,c=>`\\u${c.charCodeAt(0).toString(16).padStart(4,'0')}`);
 function stop(){clearTimeout(timer);sequence++;}
 function close(){if(owner)messages.set(owner,$('git-commit-message').value);stop();dialog.close();}
 function buttons(){
  $('git-commit-confirm').disabled=busy||!operation?.canCommit||visited.size!==operation.review.length||Date.now()>operation.expiresAt;
  $('git-commit-confirm').hidden=operation?.state!=='reviewed';$('git-commit-inspect').hidden=!operation||operation.running||operation.state==='reviewed'||operation.state==='failed';
  $('git-commit-recover').hidden=!operation?.canRecover;$('git-commit-cancel').hidden=!operation?.running;$('git-commit-settlement').hidden=!operation?.canSettle;$('git-commit-settle').disabled=busy||!$('git-commit-note').value.trim();
  for(const id of ['git-commit-inspect','git-commit-recover','git-commit-cancel','git-commit-preview'])$(id).disabled=busy;
  $('git-commit-preview').disabled=busy||!$('git-commit-message').value.trim()||!selection().length;
 }
 function fileReview(index){
  const row=operation?.review[index];if(!row)return;
  let diff;try{diff=diffHtml(row.before,row.after);}catch{diff=`<div class="git-source-pair"><section><h3>Before</h3><pre>${esc(row.before)}</pre></section><section><h3>After</h3><pre>${esc(row.after)}</pre></section></div>`;}
  $('git-commit-diff').innerHTML=`<h3>${esc(pathLabel(row.path))}</h3>${row.original?`<p>Renamed from ${esc(pathLabel(row.original))}</p>`:''}<div class="diff">${diff}</div>`;
  visited.add(index);$('git-commit-reviewed').textContent=`${visited.size} of ${operation.review.length} files reviewed`;
  for(const node of $('git-commit-files').querySelectorAll('button'))node.setAttribute('aria-pressed',String(Number(node.dataset.index)===index));buttons();
 }
 function render(value){
  const previous=operation?.operationId;operation=value;if(previous!==value.operationId)visited.clear();
  $('git-commit-form').hidden=true;$('git-commit-result').hidden=false;
  $('git-commit-summary').textContent=`${value.branch} · ${value.paths.length} paths · parent ${value.head.slice(0,12)}${value.execution?` · Hooks: ${value.execution.hooks.join(', ')||'none'} · Signing: ${value.execution.signing} · Clean filters: ${(value.execution.filters??[]).join(', ')||'none'}`:''}`;
  $('git-commit-reviewed-message').textContent=value.message;
  const labels={reviewing:'Building the exact Git snapshot…',reviewed:'Review the saved Git content below before committing.',starting:'Starting local commit…',preparing:'Preparing selected files…',executing:'Creating the local commit…','ref-prepared':'Publishing the reviewed commit…','ref-committed':'Commit published; checking the index…',committed:'Local commit complete.','not-committed':'No commit was recorded. Inspect before reviewing a new commit.','committed-index-recovery':'Commit exists. Git staging still needs recovery.','committed-external-ref':'Commit was recorded; the branch has since moved.','uncertain-ref-publication':'Publication is uncertain. This operation will not be repeated.','uncertain-external-ref':'The branch changed. This operation will not be repeated.',failed:'Review unavailable.'};
  $('git-commit-feedback').textContent=[labels[value.state]??value.state,value.commitId?`Commit ${value.commitId}`:'',value.failure?.message??'',value.recovery?`Recovery: ${value.recovery.replaceAll('-',' ')}`:''].filter(Boolean).join(' ');
  $('git-commit-files').replaceChildren(...value.review.map((row,index)=>{const button=document.createElement('button');button.type='button';button.className='quiet small';button.textContent=pathLabel(row.path);button.dataset.index=String(index);button.onclick=()=>fileReview(index);return button;}));
  if(value.state==='reviewed'){if(!visited.size)fileReview(0);}else{$('git-commit-diff').replaceChildren();$('git-commit-reviewed').textContent='';}
  buttons();if(value.state==='committed')changed(value);
 }
 async function inspect(){const own=sequence,current=owner,id=operation.operationId;const value=await api('git/operation?'+new URLSearchParams({id}));if(own!==sequence||current!==checkout()||!dialog.open)return;if(!value)throw new Error('The retained Git operation is unavailable.');render(value);if(value.running)timer=setTimeout(()=>inspect().catch(error=>{$('git-commit-feedback').textContent=error.message;}),500);}
 async function action(route){if(busy||!operation||owner!==checkout())return;busy=true;buttons();const own=sequence;try{const result=await api(route,{operationId:operation.operationId,...(route==='git/operation/settle'?{expectedRef:operation.observedRef,expectedIndexRevision:operation.observedIndex,note:$('git-commit-note').value}:{})});if(own!==sequence||owner!==checkout()||!dialog.open)return;render(result);if(result.running)timer=setTimeout(()=>inspect().catch(error=>{$('git-commit-feedback').textContent=error.message;}),500);}catch(error){if(own===sequence)$('git-commit-feedback').textContent=`${error.message} The receipt was kept. Inspect the outcome before continuing.`;}finally{busy=false;buttons();}}
 async function show({operationId}={}){
  stop();const current=checkout();if(owner!==current){if(owner)messages.set(owner,$('git-commit-message').value);$('git-commit-message').value=messages.get(current)??'';}owner=current;const own=sequence;busy=false;visited.clear();operation=null;$('git-commit-note').value='';dialog.showModal();$('git-commit-diff').replaceChildren();$('git-commit-files').replaceChildren();$('git-commit-feedback').textContent='';
  if(operationId){busy=true;$('git-commit-form').hidden=true;$('git-commit-result').hidden=true;$('git-commit-feedback').textContent='Reading retained Git operation…';buttons();try{const value=await api('git/operation?'+new URLSearchParams({id:operationId}));if(own!==sequence||current!==checkout()||!dialog.open)return;if(!value)throw new Error('This Git operation is unavailable.');render(value);if(value.running)timer=setTimeout(()=>inspect().catch(error=>notice(error.message,true)),500);}finally{if(own===sequence){busy=false;buttons();}}}
  else{$('git-commit-form').hidden=false;$('git-commit-result').hidden=true;$('git-commit-paths').textContent=selection().map(pathLabel).join('\n');buttons();$('git-commit-message').focus();}
 }
 $('git-commit-form').onsubmit=async event=>{event.preventDefault();if(busy||owner!==checkout()||!selection().length)return;busy=true;buttons();const own=sequence;try{const value=await api('git/commit/preview',{operationId:crypto.randomUUID(),paths:selection(),message:$('git-commit-message').value});if(own!==sequence||owner!==checkout()||!dialog.open)return;render(value);if(value.running)timer=setTimeout(()=>inspect().catch(error=>notice(error.message,true)),500);}catch(error){if(own===sequence)$('git-commit-feedback').textContent=error.message;}finally{busy=false;buttons();}};
 $('git-commit-note').oninput=buttons;$('git-commit-settle').onclick=()=>{if(!$('git-commit-settle').disabled)return action('git/operation/settle');};
 $('git-commit-message').oninput=buttons;$('git-commit-close').onclick=close;dialog.oncancel=()=>stop();
 $('git-commit-confirm').onclick=()=>{if(!$('git-commit-confirm').disabled)return action('git/commit/start');};
 $('git-commit-inspect').onclick=()=>action('git/operation/inspect');$('git-commit-recover').onclick=()=>action('git/operation/recover');$('git-commit-cancel').onclick=()=>action('git/operation/cancel');
 return {show,close};
}
