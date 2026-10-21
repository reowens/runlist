import { documentOutline } from './outline.mjs';
export function editorNavigation({state,editor,$,view,notice}) {
  let entries=[], path='', active=null;
  function jump(entry) {
    if (!entry || !state.doc) return;
    if (!['read','edit'].includes(state.mode)) view('edit');
    let target;
    if (state.mode==='read') { target=[...$('reading').querySelectorAll('h1,h2,h3,h4,h5,h6')][entries.indexOf(entry)]; if(target){target.tabIndex=-1;target.focus({preventScroll:true});} }
    else if (!$('markdown-fallback').hidden) { target=$('body-editor'); target.focus(); target.setSelectionRange(entry.offset,entry.offset); const lineHeight=parseFloat(getComputedStyle(target).lineHeight)||22; target.scrollTop=Math.max(0,(entry.line-3)*lineHeight); }
    else { target=[...editor.root.querySelectorAll('[data-block]')].find(e=>e.dataset.block===entry.id); if (!entry.locked) editor.focus(entry.id); }
    target?.scrollIntoView({block:'center',behavior:'smooth'}); active=entry.key; highlight(); outline(false);
  }
  function highlight() { for (const button of $('outline').querySelectorAll('[data-section]')) { const selected=button.dataset.section===active; button.setAttribute('aria-current',String(selected)); } }
  function row(entry) {
    const div=document.createElement('div'); div.className='outline-row'; div.style.setProperty('--heading-level',entry.level ?? 1);
    const button=document.createElement('button'); button.className='section-link quiet'; button.textContent=entry.title; button.dataset.section=entry.key;
    button.title=`Jump to ${entry.title} · line ${entry.line}`;button.onclick=()=>jump(entry);
    div.append(button);return div;
  }
  function render() {
    const query=$('section-filter').value.toLowerCase();
    $('outline').replaceChildren(...entries.filter(e=>e.title.toLowerCase().includes(query)).map(e=>row(e)));
    if(!$('outline').children.length)$('outline').textContent=query?'No matching headings.':'Add a heading to create a section.';
    $('section-count').textContent=entries.length;highlight();
  }
  function update() {
    if(!state.doc)return;
    if(path!==state.doc.path){path=state.doc.path;active=null;$('section-filter').value='';}
    const model=editor.source()===state.body?editor.blocks:undefined;
    entries=documentOutline(state.body,model);render();
  }
  $('section-filter').oninput=render;
  function outline(show,restoreFocus=false){
    $('evidence').classList.toggle('outline-open',show);$('toggle-outline').setAttribute('aria-expanded',String(show));
    if(show)$('section-filter').focus();else if(restoreFocus)$('toggle-outline').focus();
  }
  $('toggle-outline').onclick=()=>outline(!$('evidence').classList.contains('outline-open'));
  $('close-outline').onclick=()=>outline(false,true);
  $('add-section').onclick=()=>{if(!state.doc||state.busy||state.pending||!state.doc.editable)return;view('edit');if(!$('markdown-fallback').hidden)$('toggle-markdown').click();editor.mutate(()=>{const last=editor.blocks.filter(b=>!b.locked&&!['gap','comment'].includes(b.kind)).at(-1);const fresh=editor.insertAfter(last,'h2','New section');editor.render();editor.focus(fresh.id);});update();jump(entries.find(e=>e.id===editor.activeId));};
  document.addEventListener('keydown',event=>{if(!state.doc||['home','records','filing'].includes(state.mode)||document.querySelector('dialog[open]'))return;if((event.metaKey||event.ctrlKey)&&event.shiftKey&&event.key.toLowerCase()==='j'){event.preventDefault();outline(true);}if(event.altKey&&['PageDown','PageUp'].includes(event.key)){event.preventDefault();const index=entries.findIndex(e=>e.key===active);jump(entries[Math.max(0,Math.min(entries.length-1,index+(event.key==='PageDown'?1:-1)))]);}if(event.key==='Escape'&&$('evidence').classList.contains('outline-open'))outline(false,true);});
  $('section-filter').onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();jump(entries.find(e=>e.title.toLowerCase().includes($('section-filter').value.toLowerCase())));}};
  let scheduled=false;window.addEventListener('scroll',()=>{if(scheduled||!state.doc||!['read','edit'].includes(state.mode)||!$('markdown-fallback').hidden)return;scheduled=true;requestAnimationFrame(()=>{scheduled=false;const nodes=state.mode==='read'?[...$('reading').querySelectorAll('h1,h2,h3,h4,h5,h6')]:entries.map(e=>[...editor.root.querySelectorAll('[data-block]')].find(n=>n.dataset.block===e.id));let current=entries[0];for(let i=0;i<nodes.length;i++)if(nodes[i]?.getBoundingClientRect().top<260)current=entries[i];if(current){active=current.key;highlight();}});},{passive:true});
  return {update,jumpTo:section=>{update();const entry=entries.find(e=>e.line===section.line&&e.title.slice(0,200)===section.title)||entries.find(e=>e.title.slice(0,200)===section.title);if(entry)jump(entry);else notice('This section changed since the search. Use the document outline to find it.',true);}};
}
