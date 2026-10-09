export const desktop=typeof window!=='undefined'&&!!window.__TAURI__?.core;
export function isDesktopAssetLink(url, current) {
  const asset=value=>!value.username&&!value.password&&!value.port&&((value.protocol==='tauri:'&&value.hostname==='localhost')||(value.protocol==='http:'&&value.hostname==='tauri.localhost'));
  return asset(current)&&asset(url)&&url.protocol===current.protocol&&url.host===current.host;
}
const invoke=(command,args)=>window.__TAURI__.core.invoke(command,args).catch(value=>{const error=new Error(value.message??'The native operation failed.');Object.assign(error,value);throw error;});
let handle=null;
export async function request(route,body,csrf) {
  if(desktop){
    if(route==='session'){const state=await invoke('desktop_status');handle=state.handle;if(!handle)throw new Error('Choose a checkout folder to get started.');return {actor:state.actor,csrf:null};}
    if(route==='logout'){const result=await invoke('close_checkout',{handle});handle=null;return result;}
    if(!handle)throw new Error('Open a checkout folder.');
    return invoke('checkout_request',{handle,route,...(body===undefined?{}:{body})});
  }
  const response=await fetch(`/api/${route}`,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-Runlist-CSRF':csrf??''},body:JSON.stringify(body)});
  const value=await response.json();if(!response.ok){const error=new Error(value.message);Object.assign(error,value);throw error;}return value;
}
export const copyText=text=>desktop?invoke('copy_text',{text}):navigator.clipboard.writeText(text);
export async function mountDesktop({beforeLeave,bootstrap,notice}) {
  if(!desktop)return false;
  const $=id=>document.getElementById(id);
  $('connect-panel').hidden=true;$('desktop-welcome').hidden=false;$('desktop-open').hidden=false;
  $('disconnect').textContent='Close folder';
  $('bookmark-empty').textContent='Star a heading to keep it here. Bookmarks stay in Runlist on this computer.';
  const footer=document.querySelector('.sidebar-footer');footer.replaceChildren(document.createTextNode('Local files · This computer only'),document.createElement('br'));const label=document.createElement('span');label.textContent='Save here. Review local commits in Changes.';footer.append(label);
  async function recent(){const state=await invoke('desktop_status');const root=$('desktop-recents');root.replaceChildren();for(const item of state.recent){const button=document.createElement('button');button.className='quiet recent-checkout';button.textContent=item.path;button.onclick=()=>choose(item.id);root.append(button);}return state;}
  let moving=false;
  async function choose(id){if(moving)return;moving=true;try{
    await beforeLeave();notice('Choose a trusted local checkout…');
    const result=await invoke('choose_checkout',id===undefined?{}:{recent:id});
    if(result.cancelled){notice('Folder opening cancelled.');return;}
    // A fresh renderer clears controller and document authority from the old checkout.
    location.replace(location.pathname);
  }catch(error){notice(error.message,true);}finally{moving=false;}}
  $('desktop-open').onclick=()=>choose();$('desktop-choose').onclick=()=>choose();
  await window.__TAURI__.event.listen('runlist:open',()=>choose());
  await window.__TAURI__.event.listen('runlist:edit',event=>{if(['undo','redo'].includes(event.payload))document.execCommand(event.payload);});
  await window.__TAURI__.event.listen('runlist:quit',async()=>{if(moving)return;moving=true;try{await beforeLeave();notice('Preserving drafts and finishing local operations…');await invoke('finish_quit');}catch(error){notice(error.message,true);moving=false;}});
  document.addEventListener('click',event=>{const anchor=event.target.closest('a');if(!anchor)return;const url=new URL(anchor.href,location.href);if(isDesktopAssetLink(url,new URL(location.href)))return;event.preventDefault();if(['http:','https:','mailto:'].includes(url.protocol))invoke('open_external',{url:url.href}).catch(error=>notice(error.message,true));},true);
  const state=await recent();if(state.handle){$('desktop-welcome').hidden=true;$('desktop-location').hidden=false;$('desktop-location').textContent=state.checkoutPath;await bootstrap();}else notice('Local files · This computer only. Open a checkout folder.');
  return true;
}
export async function desktopDisconnected(){if(!desktop)return;location.replace(location.pathname);}
