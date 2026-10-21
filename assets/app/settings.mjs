import {desktop} from './transport.mjs';
import {escapeHtml as esc} from './shared.mjs';
export function appSettings({$,api,checkout,library}){
 const key=owner=>`runlist:preferences:${owner}`;
 const defaults={sort:'updated',archived:false,records:'pending'};
 let sequence=0;
 function readPreferences(owner){try{const p=JSON.parse(localStorage.getItem(key(owner))??'{}');return {value:{sort:['updated','title','path'].includes(p.sort)?p.sort:'updated',archived:p.archived===true,records:p.records===''?'':'pending'}};}catch(error){return {value:{...defaults},error};}}
 const read=()=>readPreferences(checkout()).value;
 const detail=error=>error?.message||'Please try again.';
 async function show(){
  const own=++sequence,owner=checkout(),prefs=readPreferences(owner),current=()=>own===sequence&&owner===checkout()&&$('settings-dialog').open;
  $('settings-checkout').textContent=$('checkout').textContent;
  $('settings-content').innerHTML=`<section class="settings-section"><h3>Preferences</h3><form id="settings-preferences"><div class="settings-fields"><label>Appearance<select id="settings-theme"><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label><label>Default document order<select id="settings-sort"><option value="updated">Recently updated</option><option value="title">Title</option><option value="path">File path</option></select></label><label>Default records view<select id="settings-records"><option value="pending">Needs attention</option><option value="">All statuses</option></select></label><label class="settings-check"><input id="settings-archived" type="checkbox"> Include archived documents by default</label></div><button class="primary">Save preferences</button><p id="settings-feedback" role="status"></p></form></section><section class="settings-section"><h3>Templates</h3><button id="settings-templates" class="quiet">Open templates</button></section><details id="settings-advanced" class="settings-section"><summary>Advanced</summary><p class="muted">Preferences stay ${desktop?'on this computer':'in this browser'} for this checkout.</p><section id="settings-semantic-section" class="settings-section"></section><section id="settings-repository-section" class="settings-section"></section></details>`;
  const feedback=$('settings-feedback'),form=$('settings-preferences'),save=form.querySelector('button');
  $('settings-theme').value=$('theme-mode').value;$('settings-sort').value=prefs.value.sort;$('settings-archived').checked=prefs.value.archived;$('settings-records').value=prefs.value.records;
  if(prefs.error)feedback.textContent=`Saved preferences could not be read: ${detail(prefs.error)} Defaults are shown. Try saving again.`;
  form.onsubmit=async event=>{
   event.preventDefault();if(!current()||save.disabled)return;
   const preferences={sort:$('settings-sort').value,archived:$('settings-archived').checked,records:$('settings-records').value},theme=$('settings-theme').value;
   save.disabled=true;feedback.textContent='';
   try{localStorage.setItem(key(owner),JSON.stringify(preferences));}
   catch(error){feedback.textContent=`Preferences could not be saved: ${detail(error)} Try again.`;save.disabled=false;return;}
   let appearanceError;
   try{localStorage.setItem('runlist:appearance',theme);$('theme-mode').value=theme;$('theme-mode').dispatchEvent(new Event('change'));}catch(error){appearanceError=error;}
   let refreshError;try{await library.preferences(preferences);}catch(error){refreshError=error;}
   if(current()){
    feedback.textContent=[appearanceError?`Document preferences saved. Appearance could not be saved: ${detail(appearanceError)} Try again.`:'Preferences saved.',refreshError?`Library could not refresh: ${detail(refreshError)} Use Refresh in the library.`:''].filter(Boolean).join(' ');
    save.disabled=false;
   }
  };
  $('settings-templates').onclick=()=>{sequence++;$('settings-dialog').close();$('open-templates').click();};
  $('settings-dialog').showModal();
  async function optional(sectionId,title,route,render){
   const section=$(sectionId);section.innerHTML=`<h3>${title}</h3><p role="status">Loading…</p>`;
   try{const value=await api(route);if(current())render(section,value);}
   catch(error){if(!current())return;section.innerHTML=`<h3>${title}</h3><p id="${sectionId}-feedback" role="status">Could not load: ${esc(detail(error))}</p><button id="${sectionId}-retry" class="quiet">Retry</button>`;section.querySelector('button').onclick=()=>optional(sectionId,title,route,render);}
  }
  const tool=optional('settings-semantic-section','Semantic search · experimental','semantic/settings',(section,tool)=>{
   section.innerHTML=`<h3>Semantic search · experimental</h3><p class="muted">${esc(tool.message)} Leave paths blank for automatic discovery.</p><form id="settings-semantic"><div class="settings-fields"><label>External Node executable<input id="settings-semantic-node" autocomplete="off" placeholder="Absolute path to node"></label><label>gmax entry file<input id="settings-semantic-entry" autocomplete="off" placeholder="Absolute path to grepmax/dist/bin.js"></label></div><button class="quiet">Save tool paths</button><p id="settings-semantic-feedback" role="status"></p></form>`;
   const node=$('settings-semantic-node'),entry=$('settings-semantic-entry'),form=$('settings-semantic'),feedback=$('settings-semantic-feedback'),save=form.querySelector('button');node.value=tool.nodePath??'';entry.value=tool.entryPath??'';
   form.onsubmit=async event=>{event.preventDefault();if(!current()||save.disabled)return;save.disabled=true;feedback.textContent='';try{const saved=await api('semantic/settings',{nodePath:node.value.trim(),entryPath:entry.value.trim()});if(current())feedback.textContent=saved.message;}catch(error){if(current())feedback.textContent=`Tool paths could not be saved: ${detail(error)} Try again.`;}finally{if(current())save.disabled=false;}};
  });
  const repository=optional('settings-repository-section','Checkout rules','settings',(section,info)=>{
   if(info.checkout)$('settings-checkout').textContent=info.checkout;
   section.innerHTML=`<h3>Checkout rules</h3><p class="muted">${esc(info.configFile??'Built-in defaults')}</p><dl class="settings-paths"><dt>Document roots</dt><dd>${info.roots.map(p=>`<code>${esc(p)}</code>`).join(' ')}</dd><dt>Excluded folders</dt><dd>${info.exclusions.map(p=>`<code>${esc(p)}</code>`).join(' ')}</dd></dl>${info.statuses.typeOrder.map(type=>`<details class="settings-rules"><summary>${esc(type)} · ${info.statuses.byType[type].length} statuses</summary><div class="settings-table"><table><thead><tr><th>Status</th><th>Context</th><th>Behavior</th></tr></thead><tbody>${info.statuses.byType[type].map(s=>`<tr><td>${esc(s.name)}</td><td>${esc(s.context)}</td><td>${esc([s.startable?'Can start':null,s.terminal?'Terminal':null,s.archive?'Archives':null,s.filed?`Files in ${s.filed}`:null,s.staleDays?`Stale after ${s.staleDays} days`:null].filter(Boolean).join(' · ')||'Ordinary')}</td></tr>`).join('')}</tbody></table></div></details>`).join('')}<h3>Where changes live</h3><dl class="settings-paths">${Object.entries(info.sharing).map(([name,value])=>`<dt>${esc(name)}</dt><dd>${esc(value)}</dd>`).join('')}</dl>`;
  });
  await Promise.all([tool,repository]);
 }
 $('open-settings').onclick=show;
 $('settings-close').onclick=()=>{sequence++;$('settings-dialog').close();};
 $('settings-dialog').addEventListener('cancel',()=>sequence++);
 return {read};
}
