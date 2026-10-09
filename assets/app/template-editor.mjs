import { markdownHtml, diffHtml } from './shared.mjs';
export function templateEditor({api,$,checkout,notice}) {
  let catalog, selected, busy=false, preview=false;
  const drafts=new Map();
  const key=name=>`runlist:template-draft:${checkout()}:${name}`;
  const current=()=>drafts.get(selected.name);
  function keep() {if(!selected?.editable)return;try{localStorage.setItem(key(selected.name),JSON.stringify(current()));}catch{feedback('Template draft could not be saved in local editor storage. Keep this dialog open.',true);}}
  function feedback(text,error=false){$('template-feedback').textContent=text;$('template-feedback').classList.toggle('error',error);}
  function dirty(){const d=current();return selected?.editable&&(d.source!==d.base||d.reset);}
  function render() {
    if(!selected)return;
    const d=current();$('template-name').textContent=selected.name;$('template-origin').textContent=selected.origin;$('template-description').textContent=selected.description;
    $('template-config-note').hidden=!selected.configuredSource;$('template-config').hidden=!selected.configuredSource;$('template-config-source').textContent=selected.configuredSource??'';
    $('template-source').value=d.source;$('template-source').readOnly=!selected.editable;$('template-source').hidden=preview;
    $('template-preview').hidden=!preview;
    $('template-preview-tab').disabled=!selected.editable;
    $('template-edit-tab').setAttribute('aria-pressed',String(!preview));$('template-preview-tab').setAttribute('aria-pressed',String(preview));
    const example=d.source.replace(/\{\{(title|status|date|body|version)\}\}/g,(_,token)=>({title:'Example document',status:selected.name==='prompt'?'pending':selected.name==='plan'?'planned':'active',date:new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),body:'Authored content goes here.',version:catalog.version})[token]);
    $('template-preview').innerHTML=markdownHtml(example);
    $('template-review-button').disabled=!dirty()||busy;$('template-reset').hidden=!selected.editable||(!selected.overridden&&!selected.configuredSource);
    $('template-discard').disabled=!dirty()||busy;$('template-tokens').hidden=!selected.editable;
    $('template-review-button').hidden=!selected.editable;$('template-save').hidden=true;$('template-review').hidden=true;
    $('template-save').disabled=busy;$('template-source').disabled=busy;
    $('template-reset').disabled=busy;$('close-templates').disabled=busy;
    for(const button of $('template-list').children){button.classList.toggle('active',button.dataset.name===selected.name);button.disabled=busy;}
  }
  function select(template) {
    selected=template;preview=false;$('template-reload').hidden=true;
    if(!drafts.has(template.name)){
      let saved;try{saved=JSON.parse(localStorage.getItem(key(template.name)));}catch{}
      drafts.set(template.name,saved&&typeof saved.source==='string'&&typeof saved.base==='string'&&('revision'in saved)?saved:{source:template.source,base:template.source,revision:catalog.revision,reset:false});
    }
    render();feedback(!template.editable?'JavaScript template · edit this source in runlist.config.mjs.':dirty()?'Your template draft is kept. Review it before saving.':template.configuredSource&&!template.overridden?'The editor contains a Markdown override starter; the JavaScript template stays active until you save.':'Choose Edit Markdown or Preview example.');
  }
  function list(){ $('template-list').replaceChildren(...catalog.templates.map(template=>{const button=document.createElement('button');button.className='quiet';button.dataset.name=template.name;button.textContent=template.name;button.onclick=()=>select(template);return button;})); }
  $('open-templates').onclick=async()=>{try{catalog=await api('templates');list();select(catalog.templates.find(t=>t.name===selected?.name)??catalog.templates.find(t=>t.name==='plan')??catalog.templates[0]);$('template-dialog').showModal();}catch(error){notice(error.message,true);}};
  $('close-templates').onclick=()=>{$('template-dialog').close();};
  $('template-dialog').addEventListener('cancel',event=>{if(busy)event.preventDefault();});
  $('template-source').oninput=()=>{const d=current();d.source=$('template-source').value;d.reset=false;keep();$('template-save').hidden=true;$('template-review').hidden=true;$('template-review-button').disabled=!dirty();feedback('Template draft kept in local editor storage.');};
  $('template-edit-tab').onclick=()=>{preview=false;render();};$('template-preview-tab').onclick=()=>{preview=true;render();};
  $('template-review-button').onclick=()=>{const d=current();$('template-diff').innerHTML=diffHtml(d.base,d.source);$('template-review').hidden=false;$('template-review').open=true;$('template-save').hidden=false;$('template-save').disabled=!dirty();feedback(d.reset?'Save will remove the Markdown override and use the original template.':'Review this template before saving it for future documents.');};
  $('template-reset').onclick=()=>{const d=current();d.source=selected.defaultSource;d.reset=true;keep();render();feedback('Review and save to remove the Markdown override and use the original template.');};
  $('template-discard').onclick=()=>{drafts.set(selected.name,{source:selected.source,base:selected.source,revision:catalog.revision,reset:false});localStorage.removeItem(key(selected.name));render();feedback('Template draft discarded.');};
  $('template-reload').onclick=async()=>{try{catalog=await api('templates');const name=selected.name;selected=catalog.templates.find(t=>t.name===name);const d=current();d.base=selected.source;d.revision=catalog.revision;keep();list();render();$('template-reload').hidden=true;feedback('Saved template reloaded. Your draft is kept; compare and review it before saving.');}catch(error){feedback(error.message,true);}};
  $('template-save').onclick=async()=>{if(busy||!dirty())return;const name=selected.name,d=current();busy=true;$('template-save').disabled=true;$('template-dialog').querySelector('.template-layout').inert=true;$('close-templates').disabled=true;try{catalog=await api('templates/save',{name,source:d.source,expectedRevision:d.revision,reset:d.reset});selected=catalog.templates.find(t=>t.name===name);drafts.delete(name);localStorage.removeItem(key(name));busy=false;list();select(selected);feedback('Template saved to runlist.templates.json. New documents use it.');}catch(error){feedback(error.message,true);keep();if(error.code==='template-conflict')$('template-reload').hidden=false;}finally{busy=false;$('template-dialog').querySelector('.template-layout').inert=false;$('template-save').disabled=false;$('close-templates').disabled=false;}};
  document.addEventListener('keydown',event=>{if($('template-dialog').open&&(event.metaKey||event.ctrlKey)&&event.key==='s'){event.preventDefault();$('template-review-button').click();}});
}
