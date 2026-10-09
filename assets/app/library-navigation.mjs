import {semanticSearch} from './semantic-search.mjs';
export function libraryNavigation({state,$,api,open,showLibrary,checkout,notice}) {
  let result,offset=0,sequence=0,timer,recent=[],favorites=[],savedViews=[],semantic=null,textSort='updated';
  const viewKey=()=>`runlist:views:${checkout()}`;
  const filterIds=['library-kind','filter','library-status','library-type','library-folder','library-sort'];
  function viewOptions(){const selected=$('library-view').value;$('library-view').replaceChildren(new Option('Current filters',''),new Option('Active plans','active-plans'),new Option('Hubs','hubs'),...savedViews.map(v=>new Option(v.name,v.id)));$('library-view').value=selected;$('delete-library-view').hidden=!savedViews.some(v=>v.id===selected);}
  function snapshot(){return {...Object.fromEntries(filterIds.map(id=>[id,$(id).value])),archived:$('library-archived').checked,content:$('library-search-content').checked,semantic:$('library-search-semantic').checked};}
  async function applyView(id){
    await showLibrary();const filters=id==='active-plans'?{'library-kind':'plans','library-status':'active'}:id==='hubs'?{'library-kind':'hubs'}:savedViews.find(v=>v.id===id)?.filters;
    if(!filters)return;
    for(const key of filterIds)$(key).value=filters[key]??(key==='library-kind'?'all':key==='library-sort'?'updated':'');
    $('library-archived').checked=filters.archived===true;$('library-search-content').checked=filters.content===true;$('library-search-semantic').checked=filters.semantic===true;semanticControls();
    $('library-view').value=id;viewOptions();await load({reset:true});
  }
  const storageKey=()=>`runlist:library:${checkout()}`;
  function keep(){try{localStorage.setItem(storageKey(),JSON.stringify({recent,favorites}));}catch{notice('Recent documents and pins could not be saved in local editor storage.',true);}}
  function button(doc,compact=false){
    const button=document.createElement('button'),active=!['home','records'].includes(state.mode)&&state.doc?.path===doc.path;
    button.className=`plan${active?' active':''}`;button.title=doc.path;
    if(active)button.setAttribute('aria-current','page');
    const name=document.createElement('span');name.className='plan-name';name.textContent=doc.title;
      const location=document.createElement('span');location.className='plan-location';location.textContent=doc.path;
      if(doc.excerpt){const excerpt=document.createElement('small');excerpt.className='search-excerpt';excerpt.textContent=doc.excerpt;name.append(excerpt);}
    if(compact){button.append(name,location);}
    else {
      const label=document.createElement('span');label.className='plan-label';label.append(name,location);
      const type=document.createElement('span');type.className='plan-type';type.textContent=doc.kind==='hub'?'Hub':doc.type??'Document';
      const status=document.createElement('span');status.className='plan-meta';
      const dot=document.createElement('span');dot.className=`dot ${/^[a-z-]+$/.test(doc.status)?doc.status:''}`;
      status.append(dot,document.createTextNode(doc.status??'unknown'));
      const updated=document.createElement('span');updated.className='plan-updated';const date=new Date(/^\d{4}-\d{2}-\d{2}$/.test(doc.updated)?`${doc.updated}T12:00:00`:doc.updated??NaN);
      updated.textContent=Number.isNaN(date.getTime())?'—':date.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'});
      button.append(label,type,status,updated);
    }
    button.onclick=async()=>{try{await open(doc.path);}catch(error){notice(error.message,true);}};return button;
  }
  function render(){
    if(!result)return;
    $('plans').replaceChildren(...state.plans.map(doc=>button(doc)));if(!state.plans.length){const empty=document.createElement('p');empty.className='library-no-results';empty.textContent='No documents match these filters. Try another search or clear the filters.';$('plans').append(empty);}
    $('plan-count').textContent=result.counts.all.toLocaleString();$('library-range').textContent=result.semantic?`${result.total} top semantic matches · Relevance order`:result.pendingSemantic?'Press Search to find semantic matches':result.total?`${result.offset+1}–${Math.min(result.total,result.offset+result.documents.length)} of ${result.total.toLocaleString()}`:'0 results';
    $('library-previous').disabled=result.offset===0;$('library-next').disabled=!result.hasMore;
    for(const kind of ['all','hubs','plans','documents']){$('library-'+kind+'-count').textContent=result.counts[kind].toLocaleString();$('library-'+kind).setAttribute('aria-pressed',String(state.mode==='home'&&($('library-kind').value||'all')===kind));}
    const titles={all:'All documents',hubs:'Hubs',plans:'Plans',documents:'Docs'},descriptions={all:'Hubs, plans, and reference material across this checkout.',hubs:'Programs, roadmaps, and runlists that connect the work.',plans:'Work across this checkout, from planned to complete.',documents:'Guides, research, and other reference material.'};
    const kind=$('library-kind').value||'all';$('library-title').textContent=titles[kind];$('library-description').textContent=descriptions[kind];
    if(state.mode==='home')$('doc-title').textContent=titles[kind];
    const filters=['library-status','library-type','library-folder'].filter(id=>$(id).value).length+Number($('library-archived').checked);
    $('library-filter-label').textContent=filters?`Filters · ${filters}`:'Filters';
    $('library-saved').replaceChildren(...favorites.map(doc=>{const row=document.createElement('div');row.className='saved-document';const remove=document.createElement('button');remove.className='quiet small';remove.textContent='×';remove.setAttribute('aria-label',`Unpin ${doc.title}`);remove.onclick=()=>{favorites=favorites.filter(f=>f.path!==doc.path);keep();render();};row.append(button(doc,true),remove);return row;}));$('library-recent').replaceChildren(...recent.filter(r=>!favorites.some(f=>f.path===r.path)).slice(0,6).map(doc=>button(doc,true)));$('library-saved-section').hidden=!favorites.length;$('library-recent-section').hidden=!recent.length;
    $('pin-document').hidden=!state.doc;const pinned=!!state.doc&&favorites.some(r=>r.path===state.doc.path);$('pin-document').textContent=pinned?'★':'☆';$('pin-document').setAttribute('aria-label',pinned?'Unpin document':'Pin document');$('pin-document').setAttribute('aria-pressed',String(pinned));
    $('library-scan-note').textContent=[result.semantic?`Experimental semantic search. ${result.message}${result.coverage?.partial?' Index coverage is incomplete.':''}${result.indexUpdating?' Index is updating.':''}${result.stale?' Changed sources open at the document.':''}`:'',result.partial?`Content search is partial: scanned ${result.scanned} of ${result.inventoryTotal} documents. Narrow the folder or filters to search the rest.`:'',result.unavailable?`${result.unavailable} files unavailable to content search.`:'',result.stats.unavailable||result.stats.discoveryErrors?`${result.stats.unavailable} unavailable files · ${result.stats.discoveryErrors} unreadable folders. Refresh to retry.`:''].filter(Boolean).join(' ');
  }
  function options(id,values,label){const select=$(id),value=select.value;select.replaceChildren(new Option(label,''),...values.map(v=>new Option(`${v.value} (${v.count})`,v.value)));if(value&&!values.some(v=>v.value===value))select.add(new Option(`${value} (0)`,value));select.value=value;}
  async function load({refresh=false,reset=false,semanticRun=false}={}){
    if(reset)offset=0;semantic?.abort();semantic=null;const own=++sequence;semanticControls();
    const params=new URLSearchParams({q:$('filter').value,kind:$('library-kind').value,status:$('library-status').value,type:$('library-type').value,folder:$('library-folder').value,sort:$('library-sort').value,archived:$('library-archived').checked?'1':'0',content:$('library-search-content').checked?'1':'0',offset:String(offset),limit:'50'});if(refresh)params.set('refresh','1');const semanticMode=$('library-search-semantic').checked,query=$('filter').value.trim();if(semanticMode){params.delete('q');params.set('content','0');params.set('offset','0');}
    $('plans').setAttribute('aria-busy','true');$('library-refresh').disabled=true;$('library-range').textContent='Loading documents…';
    try{let response=await api(`library?${params}`);if(own!==sequence)return;
      if(semanticMode&&query){
        if(semanticRun){const controller=new AbortController();semantic=controller;$('library-semantic-cancel').hidden=false;const found=await semanticSearch(api,{query,kind:$('library-kind').value,status:$('library-status').value,type:$('library-type').value,folder:$('library-folder').value,archived:$('library-archived').checked},controller.signal);if(own!==sequence||controller.signal.aborted)return;response={...response,...found,documents:found.documents??[],total:found.documents?.length??0,offset:0,hasMore:false,semantic:true};}
        else response={...response,documents:[],total:0,offset:0,hasMore:false,pendingSemantic:true};
      }
      result=response;state.plans=result.documents;offset=result.offset;options('library-status',result.facets.statuses,'All statuses');options('library-type',result.facets.types,'All types');options('library-folder',result.facets.folders,'All locations');render();$('plans').scrollTop=0;return result;}
    catch(error){if(own===sequence){$('library-range').textContent='Library unavailable · try Refresh';notice(error.message,true);}throw error;}
    finally{if(own===sequence){$('plans').setAttribute('aria-busy','false');$('library-refresh').disabled=false;semantic=null;$('library-semantic-cancel').hidden=true;}}
  }
  function semanticControls(){const enabled=$('library-search-semantic').checked;$('library-semantic-search').hidden=!enabled;$('library-sort').disabled=enabled;if(enabled){if($('library-sort').value!=='relevance')textSort=$('library-sort').value;$('library-sort').value='relevance';}else if($('library-sort').value==='relevance')$('library-sort').value=textSort;}
  $('library-semantic-search').onclick=()=>run({reset:true,semanticRun:true});
  $('library-semantic-cancel').onclick=()=>{changed();run({reset:true});};
  const run=options=>load(options).catch(()=>{});
  function changed(){semantic?.abort();semantic=null;sequence++;$('library-semantic-cancel').hidden=true;$('plans').setAttribute('aria-busy','false');$('library-refresh').disabled=false; $('library-view').value='';viewOptions(); }
  $('filter').oninput=()=>{changed();clearTimeout(timer);if($('library-search-semantic').checked){if(result){result={...result,documents:[],total:0,offset:0,hasMore:false,semantic:false,pendingSemantic:true};state.plans=[];render();}}else timer=setTimeout(()=>run({reset:true}),250);};
  for(const id of ['library-status','library-type','library-folder','library-sort','library-archived','library-search-content','library-search-semantic'])$(id).onchange=()=>{if(id==='library-search-semantic'&&$('library-search-semantic').checked)$('library-search-content').checked=false;if(id==='library-search-content'&&$('library-search-content').checked)$('library-search-semantic').checked=false;changed();semanticControls();run({reset:true});};
  for(const kind of ['all','hubs','plans','documents'])$('library-'+kind).onclick=async()=>{try{await showLibrary();$('library-kind').value=kind;changed();await load({reset:true});}catch(error){notice(error.message,true);}};
  $('library-previous').onclick=()=>{offset=Math.max(0,offset-50);run({});};$('library-next').onclick=()=>{offset+=50;run({});};$('library-refresh').onclick=()=>run({refresh:true});
  $('library-clear').onclick=()=>{$('filter').value='';for(const id of ['library-status','library-type','library-folder'])$(id).value='';$('library-archived').checked=false;$('library-search-content').checked=false;$('library-search-semantic').checked=false;semanticControls();changed();run({reset:true});};
  $('library-view').onchange=()=>applyView($('library-view').value).catch(error=>notice(error.message,true));
  $('save-library-view').onclick=()=>{$('filter-feedback').textContent='';$('filter-name').value='';$('filter-dialog').showModal();$('filter-name').focus();};
  $('filter-close').onclick=()=>$('filter-dialog').close();
  $('filter-form').onsubmit=event=>{event.preventDefault();try{const name=$('filter-name').value.trim();if(!name||name.length>60)throw new Error('Give this view a name, up to 60 characters.');if(savedViews.length>=30)throw new Error('Remove an old saved view before adding another.');const value={id:crypto.randomUUID(),name,filters:snapshot()},next=[...savedViews,value];localStorage.setItem(viewKey(),JSON.stringify(next));savedViews=next;viewOptions();$('library-view').value=value.id;viewOptions();$('filter-dialog').close();notice('Library view saved on this computer.');}catch(error){$('filter-feedback').textContent=error.message;}};
  $('delete-library-view').onclick=()=>{try{const next=savedViews.filter(v=>v.id!==$('library-view').value);localStorage.setItem(viewKey(),JSON.stringify(next));savedViews=next;changed();notice('Saved view deleted. Current filters are kept.');}catch(error){notice(error.message,true);}};
  $('pin-document').onclick=()=>{const doc=state.doc,index=favorites.findIndex(r=>r.path===doc.path);if(index>=0)favorites.splice(index,1);else favorites.unshift(summary(doc));favorites=favorites.slice(0,30);keep();render();};
  function summary(doc){return {path:doc.path,title:doc.title,status:doc.status,type:doc.type,kind:doc.kind};}
  function opened(){const doc=summary(state.doc);recent=[doc,...recent.filter(r=>r.path!==doc.path)].slice(0,12);favorites=favorites.map(r=>r.path===doc.path?doc:r);keep();render();}
  function restore(){try{const saved=JSON.parse(localStorage.getItem(storageKey())??'{}'),valid=r=>r&&typeof r.path==='string'&&typeof r.title==='string';recent=Array.isArray(saved.recent)?saved.recent.filter(valid).slice(0,12):[];favorites=Array.isArray(saved.favorites)?saved.favorites.filter(valid).slice(0,30):[];const views=JSON.parse(localStorage.getItem(viewKey())??'[]');savedViews=Array.isArray(views)?views.filter(v=>v&&typeof v.id==='string'&&typeof v.name==='string'&&v.filters).slice(0,30):[];}catch{}viewOptions();render();}
  async function preferences(prefs,reload=true){$('library-sort').value=prefs.sort;$('library-archived').checked=prefs.archived;if(reload&&state.mode==='home')await load({reset:true});}
  function relocated(oldPath,newPath){if(oldPath===newPath)return;favorites=favorites.map(doc=>doc.path===oldPath?summary({...doc,...state.doc,path:newPath}):doc);recent=recent.filter(doc=>doc.path!==oldPath);keep();render();const oldKey=`runlist:bookmarks:${checkout()}:${encodeURIComponent(oldPath)}`,newKey=`runlist:bookmarks:${checkout()}:${encodeURIComponent(newPath)}`;try{const bookmarks=localStorage.getItem(oldKey);if(bookmarks&&!localStorage.getItem(newKey))localStorage.setItem(newKey,bookmarks);}catch{notice('Moved document bookmarks could not be copied in local editor storage.',true);}}
  return {load,render,opened,restore,preferences,relocated,applyView,savedViews:()=>savedViews,quickDocuments:()=>[...favorites,...recent.filter(doc=>!favorites.some(f=>f.path===doc.path))].slice(0,12)};
}
