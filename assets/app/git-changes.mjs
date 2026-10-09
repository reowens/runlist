import {escapeHtml as esc,diffHtml} from './shared.mjs';

export function gitChanges({$,api,state,checkout,showLibrary,open,returnToDraft=()=>open(state.doc.path),notice}) {
  const selected=new Map();let data=null,offset=0,sequence=0,diffSequence=0,reviewed=null,timer,owner=null;
  const root=$('changes-home');
  const run=fn=>async()=>{try{await fn();}catch(error){notice(error.message,true);}};
  const displayPath=value=>String(value).replace(/[\x00-\x1f\x7f]/g,c=>`\\u${c.charCodeAt(0).toString(16).padStart(4,'0')}`);
  function selection() {$('changes-selected').textContent=`${selected.size} selected`;$('changes-clear').disabled=!selected.size;$('changes-commit').disabled=!selected.size||data?.commitSupport?.available===false;$('changes-commit').title=data?.commitSupport?.reason??'Review selected files before creating a local commit';}
  function deactivate() {sequence++;diffSequence++;clearTimeout(timer);root.hidden=true;$('library-changes').setAttribute('aria-pressed','false');}
  function invalidate() {data=null;$('library-changes-count').textContent='•';$('library-changes').title='Saved files changed. Open Changes to refresh.';}
  function activate() {
    state.mode='changes';root.hidden=false;$('empty').hidden=true;$('document').hidden=true;$('records-home').hidden=true;
    $('workspace').classList.add('library-start');$('doc-title').textContent='Changes';
    for(const name of ['all','hubs','plans','documents','flags','decisions'])$('library-'+name).setAttribute('aria-pressed','false');
    $('library-changes').setAttribute('aria-pressed','true');
    const url=new URL(location.href);for(const key of ['path','ref','from','record'])url.searchParams.delete(key);url.searchParams.set('view','changes');history.replaceState(null,'',url);
    $('changes-draft').hidden=!(state.doc&&(state.dirty||state.pending));
  }
  function rows() {
    const scroll=$('changes-list').scrollTop;
    const focused=document.activeElement,activePath=focused?.getAttribute('data-git-path'),activeTag=focused?.tagName;
    $('changes-list').replaceChildren(...(data?.changes??[]).map(row=>{
      const item=document.createElement('div');item.className='changes-row';
      const check=document.createElement('input');check.type='checkbox';check.checked=selected.has(row.path);check.disabled=!row.eligible;check.setAttribute('aria-label',`Select ${displayPath(row.path)}`);check.title=row.blockedReason??'Select the whole saved file';
      check.setAttribute('data-git-path',row.path);
      check.onchange=()=>{if(check.checked){if(selected.size>=100){check.checked=false;notice('Review up to 100 selected files at a time.',true);return;}selected.set(row.path,row);}else selected.delete(row.path);selection();};
      const button=document.createElement('button');button.className='changes-file quiet';button.setAttribute('aria-pressed',String(reviewed===row.path));
      button.setAttribute('data-git-path',row.path);
      button.innerHTML=`<strong>${esc(row.title??displayPath(row.path))}</strong><span class="changes-path">${esc(displayPath(row.path))}</span>${row.original?`<small>From ${esc(displayPath(row.original))}</small>`:''}<span class="changes-meta">${esc(row.kind)}${row.staged?' · Staged':''}${row.partial&&!row.filterReviewRequired?' · Partial staging':''}${row.filterReviewRequired?' · Clean-filter review required':''}</span>${row.blockedReason?`<small class="changes-blocked">${esc(row.blockedReason)}</small>`:''}`;
      button.onclick=run(()=>review(row.path));item.append(check,button);return item;
    }));
    if(data?.available&&!data.changes.length){const empty=document.createElement('p');empty.className='library-no-results';empty.textContent=$('changes-search').value?'No saved documents match this search.':'No saved document changes. Unsaved drafts stay in the editor.';$('changes-list').append(empty);}
    $('changes-list').scrollTop=scroll;selection();
    if(activePath)[...$('changes-list').querySelectorAll('[data-git-path]')].find(node=>node.tagName===activeTag&&node.getAttribute('data-git-path')===activePath)?.focus();
  }
  async function load({refresh=false}={}) {
    const own=++sequence;$('changes-list').setAttribute('aria-busy','true');$('changes-refresh').disabled=true;$('changes-feedback').textContent='Inspecting saved changes…';
    const old=data,params=new URLSearchParams({q:$('changes-search').value,offset:String(offset),archived:$('changes-archived').checked?'1':'0',refresh:refresh?'1':'0'});
    try{
      const result=await api(`git/status?${params}`);if(own!==sequence||state.mode!=='changes')return;
      data=result;offset=result.offset??0;
      if(!result.available){selected.clear();reviewed=null;diffSequence++;$('changes-review').innerHTML='<h2>Git review unavailable</h2><p class="muted">Your document library and editor remain available.</p>';}
      for(const row of result.changes){if(!row.eligible)selected.delete(row.path);else if(selected.has(row.path))selected.set(row.path,row);}
      if(old&&old.offset===result.offset&&old.query===params.get('q')&&old.archived===params.get('archived'))for(const row of old.changes)if(!result.changes.some(next=>next.path===row.path))selected.delete(row.path);
      data.query=params.get('q');data.archived=params.get('archived');
      $('changes-checkout').textContent=result.available?`${result.branch??'No branch'} · ${result.head?.slice(0,12)??'No commits yet'}`:'';
      $('changes-feedback').textContent=[result.reason??`${result.changedDocuments} changed documents · ${result.localOnly} local-only documents`,result.commitSupport?.reason].filter(Boolean).join(' ');
      $('changes-range').textContent=result.total?`${offset+1}–${offset+result.changes.length} of ${result.total}`:'0 documents';
      $('changes-previous').disabled=!offset||!result.available;$('changes-next').disabled=!result.hasMore||!result.available;
      $('library-changes-count').textContent=result.available?String(result.changedDocuments):'—';$('library-changes').title='Review saved document changes';
      $('changes-staging').textContent=result.unrelatedStaged?`${result.unrelatedStaged} staged files outside this document scope stay staged.`:'Selection and review leave Git staging unchanged.';
      rows();if(reviewed)await review(reviewed);
    }catch(error){if(own!==sequence||state.mode!=='changes')return;if(own===sequence&&state.mode==='changes')$('changes-feedback').textContent=`${error.message} Selection is kept. Try Refresh.`;throw error;}
    finally{if(own===sequence){$('changes-list').setAttribute('aria-busy','false');$('changes-refresh').disabled=false;}}
  }
  async function review(file) {
    const own=++diffSequence;reviewed=file;rows();$('changes-review').setAttribute('aria-busy','true');
    $('changes-review').innerHTML=`<h2>${esc(displayPath(file))}</h2><p class="muted">Loading saved file diff…</p>`;
    try{
      const result=await api(`git/diff?${new URLSearchParams({path:file,archived:$('changes-archived').checked?'1':'0'})}`);if(own!==diffSequence||state.mode!=='changes')return;
      let diff;try{diff=diffHtml(result.before,result.after);}catch{diff='<p>This diff is too large to display. Review the file with Git.</p>';}
      const row=result.change;
      $('changes-review').innerHTML=`<div class="changes-review-heading"><div><h2>${esc(displayPath(row.path))}</h2><p>${esc(result.basis)} · ${esc(result.branch??'Detached HEAD')}${row.original?`<br>Renamed from ${esc(displayPath(row.original))}`:''}</p></div>${row.kind!=='Deleted'?'<button id="changes-open-file" class="quiet small">Open document</button>':''}</div>${row.blockedReason?`<p class="inline-note">${esc(row.blockedReason)}</p>`:''}<div class="diff">${diff}</div>`;
      if($('changes-open-file'))$('changes-open-file').onclick=run(()=>open(row.path));
    }catch(error){if(own!==diffSequence||state.mode!=='changes')return;if(own===diffSequence&&state.mode==='changes')$('changes-review').innerHTML=`<h2>${esc(displayPath(file))}</h2><p class="inline-note">${esc(error.message)}</p>`;throw error;}
    finally{if(own===diffSequence)$('changes-review').setAttribute('aria-busy','false');}
  }
  async function show() {
    await showLibrary();
    if(owner!==checkout()){owner=checkout();selected.clear();reviewed=null;offset=0;data=null;$('changes-search').value='';$('changes-archived').checked=false;}
    activate();await load({refresh:true});$('changes-title').focus();
  }
  $('library-changes').onclick=run(show);$('changes-refresh').onclick=run(()=>load({refresh:true}));
  $('changes-clear').onclick=()=>{selected.clear();rows();};
  $('changes-search').oninput=()=>{clearTimeout(timer);timer=setTimeout(()=>{offset=0;run(load)();},200);};
  $('changes-archived').onchange=run(()=>{offset=0;return load();});
  $('changes-previous').onclick=run(()=>{offset=Math.max(0,offset-100);return load();});$('changes-next').onclick=run(()=>{offset+=100;return load();});
  $('changes-return-draft').onclick=run(returnToDraft);
  return {show,deactivate,invalidate,selectedPaths:()=>[...selected.keys()]};
}
