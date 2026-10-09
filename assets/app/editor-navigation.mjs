import { documentOutline } from './outline.mjs';
export function editorNavigation({state,editor,checkout,$,view,notice}) {
  let entries=[], bookmarks=[], path='', active=null, previous=[],previousModel;
  const storageKey=()=>`runlist:bookmarks:${checkout()}:${encodeURIComponent(state.doc.path)}`;
  function persist() { try { localStorage.setItem(storageKey(),JSON.stringify(bookmarks)); } catch { notice('Bookmarks could not be saved in local editor storage.',true); } }
  function jump(entry) {
    if (!entry || !state.doc) return;
    if (!['read','edit'].includes(state.mode)) view('edit');
    let target;
    if (state.mode==='read') target=[...$('reading').querySelectorAll('h1,h2,h3,h4,h5,h6')][entries.indexOf(entry)];
    else if (!$('markdown-fallback').hidden) { target=$('body-editor'); target.focus(); target.setSelectionRange(entry.offset,entry.offset); const lineHeight=parseFloat(getComputedStyle(target).lineHeight)||22; target.scrollTop=Math.max(0,(entry.line-3)*lineHeight); }
    else { target=[...editor.root.querySelectorAll('[data-block]')].find(e=>e.dataset.block===entry.id); if (!entry.locked) editor.focus(entry.id); }
    target?.scrollIntoView({block:'center',behavior:'smooth'}); active=entry.key; highlight(); $('evidence').classList.remove('outline-open');
  }
  function highlight() { for (const button of $('outline').querySelectorAll('[data-section]')) { const selected=button.dataset.section===active; button.setAttribute('aria-current',String(selected)); } }
  function toggle(entry) { const index=bookmarks.findIndex(b=>b.key===entry.key); if(index<0) bookmarks.push({key:entry.key,title:entry.title}); else bookmarks.splice(index,1); persist(); render(); }
  function row(entry, saved=false) {
    const div=document.createElement('div'); div.className='outline-row'; div.style.setProperty('--heading-level',entry.level ?? 1);
    const button=document.createElement('button'); button.className='section-link quiet'; button.textContent=entry.title; button.dataset.section=entry.key;
    const found=entries.find(e=>e.key===entry.key); button.disabled=!found; button.title=found ? `Jump to ${entry.title} · line ${found.line}` : 'This heading was renamed or removed. Remove this bookmark or bookmark the new heading.';
    button.onclick=()=>jump(found);
    const star=document.createElement('button'); star.className='section-bookmark quiet'; const marked=bookmarks.some(b=>b.key===entry.key); star.textContent=marked?'★':'☆'; star.setAttribute('aria-label',`${marked?'Remove bookmark for':'Bookmark'} ${entry.title}`);star.setAttribute('aria-pressed',String(marked));star.onclick=()=>{if(found)toggle(found);else{bookmarks=bookmarks.filter(b=>b.key!==entry.key);persist();render();}};
    div.append(button,star); if(saved&&!found) {const small=document.createElement('small');small.textContent='Heading unavailable';div.append(small);}return div;
  }
  function render() {
    const query=$('section-filter').value.toLowerCase();
    $('outline').replaceChildren(...entries.filter(e=>e.title.toLowerCase().includes(query)).map(e=>row(e)));
    if(!$('outline').children.length)$('outline').textContent=query?'No matching headings.':'Add a heading to create a section.';
    $('bookmarks').replaceChildren(...bookmarks.map(b=>row(b,true)));$('bookmark-empty').hidden=bookmarks.length>0;
    $('section-count').textContent=entries.length;highlight();
  }
  function update() {
    if(!state.doc)return;
    const samePath=path===state.doc.path;
    if(!samePath){path=state.doc.path;active=null;previous=[];try{const stored=JSON.parse(localStorage.getItem(storageKey())??'[]');bookmarks=Array.isArray(stored)?stored.filter(b=>typeof b.key==='string'&&typeof b.title==='string'):[];}catch{bookmarks=[];}$('section-filter').value='';}
    const model=editor.source()===state.body?editor.blocks:undefined;
    entries=documentOutline(state.body,model);
    // Inline block identity survives typing and insertions, so heading renames
    // also update their bookmarks. Source replacements leave unmatched bookmarks explicit.
    if(samePath&&model&&model===previousModel){let changed=false;for(const b of bookmarks){const old=previous.find(e=>e.key===b.key),fresh=old&&entries.find(e=>e.id===old.id);if(fresh&&fresh.key!==b.key){b.key=fresh.key;b.title=fresh.title;changed=true;}}if(changed)persist();}
    previous=entries;previousModel=model;render();
  }
  $('section-filter').oninput=render;
  $('toggle-outline').onclick=()=>{$('evidence').classList.toggle('outline-open');$('section-filter').focus();};
  $('close-outline').onclick=()=>$('evidence').classList.remove('outline-open');
  $('add-section').onclick=()=>{if(!state.doc||state.busy||state.pending||!state.doc.editable)return;view('edit');if(!$('markdown-fallback').hidden)$('toggle-markdown').click();editor.mutate(()=>{const last=editor.blocks.filter(b=>!b.locked&&!['gap','comment'].includes(b.kind)).at(-1);const fresh=editor.insertAfter(last,'h2','New section');editor.render();editor.focus(fresh.id);});update();jump(entries.find(e=>e.id===editor.activeId));};
  document.addEventListener('keydown',event=>{if(!state.doc||['home','records'].includes(state.mode)||document.querySelector('dialog[open]'))return;if((event.metaKey||event.ctrlKey)&&event.shiftKey&&event.key.toLowerCase()==='j'){event.preventDefault();$('evidence').classList.add('outline-open');$('section-filter').focus();}if(event.altKey&&['PageDown','PageUp'].includes(event.key)){event.preventDefault();const index=entries.findIndex(e=>e.key===active);jump(entries[Math.max(0,Math.min(entries.length-1,index+(event.key==='PageDown'?1:-1)))]);}if(event.key==='Escape')$('evidence').classList.remove('outline-open');});
  $('section-filter').onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();jump(entries.find(e=>e.title.toLowerCase().includes($('section-filter').value.toLowerCase())));}};
  let scheduled=false;window.addEventListener('scroll',()=>{if(scheduled||!state.doc||!['read','edit'].includes(state.mode)||!$('markdown-fallback').hidden)return;scheduled=true;requestAnimationFrame(()=>{scheduled=false;const nodes=state.mode==='read'?[...$('reading').querySelectorAll('h1,h2,h3,h4,h5,h6')]:entries.map(e=>[...editor.root.querySelectorAll('[data-block]')].find(n=>n.dataset.block===e.id));let current=entries[0];for(let i=0;i<nodes.length;i++)if(nodes[i]?.getBoundingClientRect().top<260)current=entries[i];if(current){active=current.key;highlight();}});},{passive:true});
  return {update,jumpTo:section=>{update();const entry=entries.find(e=>e.line===section.line&&e.title.slice(0,200)===section.title)||entries.find(e=>e.title.slice(0,200)===section.title);if(entry)jump(entry);else notice('This section changed since the search. Use the document outline to find it.',true);}};
}
