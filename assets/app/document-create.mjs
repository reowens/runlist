import {markdownHtml,escapeHtml as esc,splitSource} from './shared.mjs';
import {nativeContent} from './record-navigation.mjs';

export function documentCreation({$,api,checkout,state,beforeNavigate,open,library,notice,createdRecord}) {
  const dialog=$('create-dialog');let catalog,review=null,request=null,filenameEdited=false,scope='',sequence=0;
  $('create-preview').addEventListener('click',event=>{if(event.target.closest('a'))event.preventDefault();});
  const key=()=>`runlist:create:${scope||checkout()}`;
  const current=()=>{if(scope!==checkout())throw new Error('The checkout changed. This creation review is retained for its original checkout.');};
  const selected=()=>catalog?.templates.find(t=>t.name===$('create-template').value);
  const alternatives=()=>[...$('create-options').children].map(row=>({label:row.querySelector('[data-label]').value,description:row.querySelector('[data-description]').value,consequences:[...row.querySelectorAll('[data-consequence]')].flatMap(field=>field.value.trim()?[{kind:field.dataset.consequence,text:field.value}]:[])}));
  const form=()=>({template:$('create-template').value,title:$('create-name').value,folder:$('create-folder').value,filename:$('create-filename').value,status:$('create-status').value,body:$('create-body').value,...(selected()?.name==='flag'?{severity:$('create-severity').value}:selected()?.name==='decision'?{options:alternatives()}:{})});
  function optionRow(option={}){
    const row=document.createElement('section');row.className='create-alternative';
    row.innerHTML=`<div class="create-alternative-heading"><h3>Alternative</h3><button type="button" class="quiet small" data-remove>Remove alternative</button></div><label>Label<input data-label required maxlength="120" value="${esc(option.label??'')}" placeholder="A short name for this approach"></label><label>Description<textarea data-description required maxlength="4000" rows="3">${esc(option.description??'')}</textarea></label><details><summary>Consequences <span class="muted">optional</span></summary><div class="create-consequences">${['benefit','cost','risk','follow-up'].map(kind=>`<label>${{benefit:'Benefit',cost:'Cost',risk:'Risk','follow-up':'Follow-up'}[kind]}<textarea data-consequence="${kind}" maxlength="4000" rows="2">${esc(option.consequences?.filter(c=>c.kind===kind).map(c=>c.text).join('\n')??'')}</textarea></label>`).join('')}</div></details>`;
    row.querySelector('[data-remove]').onclick=()=>{if($('create-options').children.length>2){row.remove();numberOptions();keep();}};
    for(const field of row.querySelectorAll('input,textarea'))field.oninput=keep;
    return row;
  }
  function numberOptions(){for(const [i,row] of [...$('create-options').children].entries()){row.querySelector('h3').textContent=`Alternative ${i+1}`;row.querySelector('[data-remove]').disabled=$('create-options').children.length<=2;} $('create-option-add').disabled=$('create-options').children.length>=12;}
  function setOptions(options=[{},{}]){$('create-options').replaceChildren(...options.map(optionRow));numberOptions();}
  $('create-option-add').onclick=()=>{if($('create-options').children.length<12){const row=optionRow();$('create-options').append(row);numberOptions();keep();row.querySelector('input').focus();}};
  $('create-severity').onchange=keep;
  function keep(){try{localStorage.setItem(key(),JSON.stringify({form:form(),review,request,at:Date.now()}));return true;}catch{feedback('This new document draft could not be preserved locally. Keep this dialog open or copy its content.',true);return false;}}
  function feedback(message,error=false){$('create-feedback').textContent=message;$('create-feedback').classList.toggle('error',error);}
  function chooseTemplate(){
    const selected=catalog.templates.find(t=>t.name===$('create-template').value);if(!selected)return;
    $('create-status').replaceChildren(...selected.statuses.map(status=>new Option(status,status)));
    $('create-status').value=selected.defaultStatus;$('create-folder').value=selected.folder;
    const native=selected.native===true;
    $('create-name-label').textContent=selected.name==='flag'?'Finding':selected.name==='decision'?'Question':'Title';
    $('create-name').placeholder=native?(selected.name==='flag'?'What did you observe?':'What needs deciding?'):'What is this document about?';
    $('create-folder').readOnly=native;
    for(const [id,type] of [['create-flag-fields','flag'],['create-decision-fields','decision']]){const active=selected.name===type;$(id).hidden=!active;for(const input of $(id).querySelectorAll('input,select,textarea'))input.disabled=!active;}
    if(native&&!$('create-filename').value){$('create-filename').value=crypto.randomUUID()+'.md';filenameEdited=true;}
    $('create-title').textContent=native?`New ${selected.name}`:'New document';
    $('create-preview-button').textContent=native?`Preview ${selected.name}`:'Preview document';
    $('create-origin').textContent=`${selected.origin} · ${selected.description}${selected.note?' '+selected.note:''}`;
  }
  function renderReview(){
    $('create-form').hidden=!!review;$('create-review').hidden=!review;
    if(!review)return;
    $('create-path').textContent=review.path;$('create-source').textContent=review.source;
    // Creation preview has no active document context or privileged link navigation.
    $('create-preview').innerHTML=review.record?`<p class="record-eyebrow">Open${review.record.type==='flag'?` · ${esc(review.record.record_data.severity)} · Unreviewed`:''}</p><h1>${esc(review.record.finding??review.record.question)}</h1>${nativeContent({data:review.record.record_data})}${markdownHtml(splitSource(review.source).body)}`:markdownHtml(review.source);
    $('create-setup').hidden=!review.setup;$('create-setup-source').textContent=review.setup?.source??'';
    $('create-diagnostics').replaceChildren(...(review.diagnostics??[]).map(d=>{const row=document.createElement('li');row.textContent=`${d.level}: ${d.message}`;return row;}));
    $('create-confirm').textContent=review.state==='committed'?(review.record?'Open created record':'Open created document'):review.state==='prepared'?'Retry reviewed creation':review.record?`Create ${review.record.type}`:'Create document';
    $('create-back').disabled=review.state!=='reviewed';$('create-discard').disabled=review.state!=='reviewed';
    $('create-confirm').disabled=review.state==='discarded'||review.state==='prepared'&&review.currentRevision!=null&&review.currentRevision!==review.revision;
  }
  async function show({operationId,template}={}) {
    if(state.busy)throw new Error('Wait for the current operation before creating a record.');
    const own=++sequence,owner=checkout();await beforeNavigate();const result=await api('create');if(own!==sequence||owner!==checkout())return;catalog=result;scope=owner;
    if(template&&!catalog.templates.some(t=>t.name===template))throw new Error(catalog.recordError??'This record template is unavailable.');
    $('create-template').replaceChildren(...catalog.templates.map(t=>new Option(({hub:'Hub',plan:'Plan',flag:'Flag',decision:'Decision'})[t.name]??'Document',t.name)));
    $('create-folders').replaceChildren(...catalog.roots.map(root=>{const option=document.createElement('option');option.value=root;return option;}));
    $('create-form').reset();setOptions();chooseTemplate();filenameEdited=false;review=null;request=null;feedback('');$('create-diagnostics').replaceChildren();
    try {
      const stored=JSON.parse(localStorage.getItem(key())??'null');
      if(stored){if(catalog.templates.some(t=>t.name===stored.form?.template)){$('create-template').value=stored.form.template;chooseTemplate();}for(const [field,id] of Object.entries({title:'create-name',folder:'create-folder',filename:'create-filename',status:'create-status',body:'create-body',severity:'create-severity'}))if(typeof stored.form?.[field]==='string')$(id).value=stored.form[field];if(Array.isArray(stored.form?.options)){setOptions(stored.form.options);chooseTemplate();}review=stored.review;request=stored.request;filenameEdited=!!stored.form?.filename;}
    }catch{feedback('A local new-document draft could not be read. Its stored entry has been kept.',true);}
    if(operationId||review?.operationId){const inspected=await api('create/inspect',{operationId:operationId??review.operationId});if(own!==sequence||owner!==checkout())return;review=inspected;if(!review)feedback('No creation review was found. Your form is retained; preview it again.',true);}
    if(template&&template!==$('create-template').value){if(review||$('create-name').value)feedback('Your retained creation draft is open. Finish or discard it before starting another record.');else{$('create-template').value=template;chooseTemplate();}}
    if(operationId&&review?.record&&!request){$('create-template').value=review.record.type;chooseTemplate();$('create-name').value=review.record.finding??review.record.question;$('create-body').value=splitSource(review.source).body;$('create-folder').value=review.path.slice(0,review.path.lastIndexOf('/'));$('create-filename').value=review.path.split('/').at(-1);if(review.record.type==='flag')$('create-severity').value=review.record.record_data.severity;else setOptions(review.record.record_data.options);}
    $('create-preview-button').disabled=!catalog.templates.length;renderReview();dialog.showModal();(review?$('create-confirm'):$('create-name')).focus();
    if(!catalog.templates.length){$('create-preview-button').disabled=true;feedback('This checkout has no supported document templates. Configure a plan or doc type through the CLI.',true);}
  }
  $('create-template').onchange=()=>{chooseTemplate();keep();};
  $('create-filename').oninput=()=>{filenameEdited=true;keep();};
  $('create-name').oninput=()=>{if(!filenameEdited&&!selected()?.native){const slug=$('create-name').value.toLowerCase().replace(/[\s_]+/g,'-').replace(/[^a-z0-9-]/g,'').replace(/-+/g,'-').replace(/^-|-$/g,'').slice(0,120);$('create-filename').value=slug?slug+'.md':'';}keep();};
  for(const id of ['create-status','create-folder','create-body'])$(id).oninput=keep;
  async function busy(work){if(state.busy)return;if(scope!==checkout()){feedback('The checkout changed. Resume this creation in its original checkout.',true);return;}state.busy=true;$('create-close').disabled=true;for(const button of dialog.querySelectorAll('button'))button.disabled=true;try{await work();}catch(error){feedback(error.message,true);if(error.details?.diagnostics)$('create-diagnostics').replaceChildren(...error.details.diagnostics.map(d=>{const li=document.createElement('li');li.textContent=d.message;return li;}));notice(error.message,true);}finally{state.busy=false;for(const button of dialog.querySelectorAll('button'))button.disabled=false;$('create-preview-button').disabled=!catalog?.templates.length;numberOptions();renderReview();if(scope!==checkout())dialog.close();}}
  $('create-form').onsubmit=event=>{event.preventDefault();return busy(async()=>{$('create-diagnostics').replaceChildren();const fields=form(),{operationId,...previous}=request??{};request={...fields,operationId:operationId&&JSON.stringify(previous)===JSON.stringify(fields)?operationId:crypto.randomUUID()};if(!keep())throw new Error('Preserve the new document draft before reviewing it.');const result=await api('create/preview',request);current();review=result;keep();renderReview();feedback(`Review the new file, then choose ${$('create-confirm').textContent}.`);$('create-confirm').focus();});};
  $('create-back').onclick=()=>busy(async()=>{if(review)await api('create/discard',{operationId:review.operationId});current();review=null;request=null;keep();renderReview();$('create-name').focus();});
  $('create-inspect').onclick=()=>busy(async()=>{const inspected=await api('create/inspect',{operationId:review.operationId});current();review=inspected;keep();feedback(review?`Creation is ${review.state}.${review.currentRevision&&review.currentRevision!==review.revision?' The destination changed and will not be overwritten.':''}`:'No creation review found.');});
  $('create-confirm').onclick=()=>busy(async()=>{
    if(review.state!=='committed') {const committed=await api('create/commit',{operationId:review.operationId});current();review=committed;keep();}
    current();const path=review.path,record=review.record;localStorage.removeItem(key());dialog.close();state.busy=false;await library.load({refresh:true});current();if(record&&createdRecord)await createdRecord(record);else await open(path);notice(record?`Created an open ${record.type}. Ready for review.`:'Created local Markdown. Ready to edit.');
  });
  $('create-discard').onclick=()=>busy(async()=>{if(review)await api('create/discard',{operationId:review.operationId});current();localStorage.removeItem(key());review=null;request=null;dialog.close();notice('New document draft discarded.');});
  $('create-close').onclick=()=>{if(!state.busy&&keep()){sequence++;dialog.close();}};
  dialog.addEventListener('cancel',event=>{if(state.busy||!keep())event.preventDefault();});
  document.addEventListener('keydown',event=>{if(dialog.open&&(event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='s'){event.preventDefault();if(!state.busy){if(review)$('create-confirm').focus();else $('create-form').requestSubmit();}}});
  $('new-document').onclick=()=>show().catch(error=>notice(error.message,true));
  return {show};
}
