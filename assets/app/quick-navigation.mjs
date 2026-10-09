import {semanticSearch} from './semantic-search.mjs';
export function quickNavigation({$,api,state,library,open,jump,actions,notice}) {
  const dialog=$('quick-dialog');let sequence=0,timer,running=false,rerun=false,items=[],active=0,semantic=null,submitted='',keyboardChosen=false;
  const mode=()=>$('quick-mode').value;
  function cancel(){semantic?.abort();semantic=null;submitted='';$('quick-cancel').hidden=true;}
  function choose(index){active=Math.max(0,Math.min(items.length-1,index));for(const [i,row] of [...$('quick-results').children].entries())row.setAttribute('aria-selected',String(i===active));if(items.length)$('quick-query').setAttribute('aria-activedescendant',`quick-result-${active}`);else $('quick-query').removeAttribute('aria-activedescendant');}
  function render(results) {
    keyboardChosen=false;items=results.slice(0,80);$('quick-results').replaceChildren(...items.map((item,index)=>{
      const row=document.createElement('button');row.id=`quick-result-${index}`;row.className='quick-result quiet';row.setAttribute('role','option');row.tabIndex=-1;
      const title=document.createElement('strong');title.textContent=item.title;
      const detail=document.createElement('small');detail.textContent=item.detail??item.path??'';row.append(title,detail);row.onclick=()=>activate(index);return row;
    }));choose(0);
  }
  async function activate(index){if(state.busy)return;const item=items[index];if(!item)return;close();try{if(item.run)await item.run();else{await open(item.path);if(item.line){if(item.revision&&state.doc?.revision!==item.revision)notice('The document changed. Search again to verify its section.',true);else jump(item);}}}catch(error){notice(error.message,true);}}
  const matchingActions=query=>actions().filter(action=>!query||`${action.title} ${action.detail??''}`.toLowerCase().includes(query)).map(a=>({...a,detail:a.detail??'Action'}));
  async function semanticQuery(){
    cancel();const query=$('quick-query').value.trim(),own=++sequence;if(!query){$('quick-status').textContent='Enter a question, then press Search. Uses optional local gmax.';return;}
    const controller=new AbortController();semantic=controller;$('quick-cancel').hidden=false;render(matchingActions(query.toLowerCase()));$('quick-status').textContent='Searching the existing local gmax index…';
    try{
      const result=await semanticSearch(api,{query,archived:$('quick-archived').checked},controller.signal);
      if(own!==sequence||!dialog.open||query!==$('quick-query').value.trim()||mode()!=='semantic')return;
      if(result.state!=='ready'){$('quick-status').textContent=result.message??'Semantic search is unavailable. Exact search is available.';return;}
      render([...matchingActions(query.toLowerCase()),...result.documents.map(doc=>({...doc,detail:`${doc.path} · ${doc.excerpt}${doc.location==='changed'?' · Location changed':''}`})),...result.sections.map(section=>({...section,detail:`Verified section · ${section.path}`}))]);submitted=query;
      $('quick-status').textContent=`${result.documents.length} top semantic matches${result.coverage.partial?' · Index coverage is incomplete':''}${result.indexUpdating?' · Index is updating':''}${result.stale?' · Changed sources open at the document':''}. Exact search is also available.`;
    }catch(error){if(own===sequence&&dialog.open&&!controller.signal.aborted)$('quick-status').textContent=error.message;}
    finally{if(semantic===controller){semantic=null;$('quick-cancel').hidden=true;}}
  }
  async function search(){
    if(!dialog.open)return;if(mode()==='semantic')return semanticQuery();
    if(running){rerun=true;return;}running=true;
    const own=++sequence,query=$('quick-query').value.trim();render(matchingActions(query.toLowerCase()));$('quick-status').textContent=query?'Searching local documents…':'Choose an action or recent document.';
    try{
      if(!query){render([...matchingActions(''),...(library.quickDocuments?.()??[]).map(doc=>({...doc,detail:`Recent or pinned · ${doc.path}`}))]);return;}
      const result=await api(`search?${new URLSearchParams({q:query,archived:$('quick-archived').checked?'1':'0',limit:'30'})}`);
      if(own!==sequence||!dialog.open||query!==$('quick-query').value.trim()||mode()!=='text')return;
      render([...matchingActions(query.toLowerCase()),...result.documents.map(doc=>({...doc,detail:doc.excerpt?`${doc.path} · ${doc.excerpt}`:doc.path})),...result.sections.map(section=>({...section,detail:`Section · ${section.path}`}))]);
      $('quick-status').textContent=`${result.total} matching documents · ${result.sections.length} matching sections${result.partial?` · Partial search: scanned ${result.scanned} of ${result.inventoryTotal} documents; narrow the query or folder in the library.`:''}${result.unavailable?` · ${result.unavailable} unavailable files`:''}${!items.length?' · No matches. Try another search.':''}`;
    }catch(error){if(own===sequence&&dialog.open)$('quick-status').textContent=`Search unavailable. ${error.message}`;}
    finally{running=false;if(rerun){rerun=false;if(mode()==='text')await search();}}
  }
  async function show(){if(state.busy||$('workspace').hidden)return;if(document.querySelector('dialog[open]'))return;dialog.showModal();$('quick-query').value='';$('quick-mode').value='text';modeChanged(false);$('quick-query').focus();await search();}
  function close(){sequence++;cancel();clearTimeout(timer);dialog.close();$('quick-query').removeAttribute('aria-activedescendant');}
  function modeChanged(reload=true){sequence++;cancel();clearTimeout(timer);render(matchingActions($('quick-query').value.trim().toLowerCase()));const semanticMode=mode()==='semantic';$('quick-search').hidden=!semanticMode;$('quick-tool-settings').hidden=!semanticMode;$('quick-hint').textContent=semanticMode?'Enter to search, then ↑ ↓ and Enter to open · Esc to close. Experimental semantic search · optional local gmax; existing index only. Text search is available.':'↑ ↓ to choose · Enter to open · Esc to close. Searches local document contents on demand.';$('quick-status').textContent=semanticMode?'Enter a question, then press Search.': 'Choose an action or recent document.';if(reload&&!semanticMode&&dialog.open)void search();}
  $('quick-mode').onchange=modeChanged;
  $('quick-query').oninput=()=>{sequence++;cancel();render(matchingActions($('quick-query').value.trim().toLowerCase()));clearTimeout(timer);if(mode()==='semantic')$('quick-status').textContent='Press Enter or Search to query the existing index.';else{$('quick-status').textContent='Searching local documents…';timer=setTimeout(search,200);}};
  $('quick-archived').onchange=()=>{sequence++;cancel();if(mode()==='text')return search();render(matchingActions($('quick-query').value.trim().toLowerCase()));$('quick-status').textContent='Filters changed. Press Search.';};
  $('quick-query').onkeydown=event=>{if(['ArrowDown','ArrowUp','Home','End','Enter'].includes(event.key)){event.preventDefault();if(event.key==='Enter'){if(mode()==='semantic'&&submitted!==$('quick-query').value.trim()&&!(keyboardChosen&&items[active]?.run))void semanticQuery();else void activate(active);}else{choose(event.key==='Home'?0:event.key==='End'?items.length-1:active+(event.key==='ArrowDown'?1:-1));keyboardChosen=true;}$('quick-results').children[active]?.scrollIntoView({block:'nearest'});}};
  $('quick-search').onclick=semanticQuery;$('quick-cancel').onclick=()=>{sequence++;cancel();$('quick-status').textContent='Semantic search cancelled.';};$('quick-tool-settings').onclick=()=>{close();$('open-settings').click();};
  $('quick-close').onclick=close;dialog.addEventListener('cancel',()=>{sequence++;cancel();clearTimeout(timer);});$('quick-open').onclick=()=>show().catch(error=>notice(error.message,true));
  document.addEventListener('keydown',event=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){if(document.querySelector('dialog[open]')&&!dialog.open)return;event.preventDefault();if(dialog.open)close();else show().catch(error=>notice(error.message,true));}});
  return {show,search};
}
