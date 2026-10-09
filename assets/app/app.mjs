import {desktop,request,copyText,mountDesktop,desktopDisconnected} from './transport.mjs';
import {documentCreation} from './document-create.mjs';
import {quickNavigation} from './quick-navigation.mjs';
import {recoveryCenter} from './recovery-center.mjs';
import {appSettings} from './settings.mjs';
import {documentLifecycle} from './document-lifecycle.mjs';
import { recordNavigation } from './record-navigation.mjs';
import { libraryNavigation } from './library-navigation.mjs';
import { gitChanges } from './git-changes.mjs';
import { gitCommit } from './git-commit.mjs';
import { editorNavigation } from './editor-navigation.mjs';
import { templateEditor } from './template-editor.mjs';
import { BlockEditor } from './block-editor.mjs';
import { documentViews } from './document-views.mjs';
import { escapeHtml as esc, splitSource, editedSource, markdownHtml, lineDiff, diffHtml } from './shared.mjs';
const $ = id => document.getElementById(id);
const state = { doc:null, base:null, body:'', csrf:null, mode:'read', dirty:false, draft:null, recovery:null, conflict:null, pending:null, lastSave:null, busy:false, plans:[] };
const clientId = sessionStorage.runlistClientId ||= crypto.randomUUID();
let checkoutKey = '', draftTimer, persistence = Promise.resolve();
let editorPath;
const blockEditor = new BlockEditor($('block-editor'),{onChange:body=>bodyChanged(body),resolveLink:linked});
const navigation = editorNavigation({state,editor:blockEditor,checkout:()=>checkoutKey,$,view,notice});
templateEditor({api,$,checkout:()=>checkoutKey,notice});
const library = libraryNavigation({state,$,api,open,showLibrary,checkout:()=>checkoutKey,notice});
const settings=appSettings({$,api,checkout:()=>checkoutKey,library,notice});
const lifecycle=documentLifecycle({state,$,api,checkout:()=>checkoutKey,open,library,notice});
const records = recordNavigation({state,$,api,open,showLibrary,checkout:()=>checkoutKey,preferences:()=>settings.read(),notice,create:template=>creation.show({template})});
const changes=gitChanges({state,$,api,open,showLibrary,checkout:()=>checkoutKey,notice,returnToDraft:()=>{view(state.doc.editable?'edit':'read');const url=new URL(location.href);url.searchParams.delete('view');url.searchParams.set('path',state.doc.path);history.replaceState(null,'',url);}});
const commits=gitCommit({$,api,checkout:()=>checkoutKey,selection:changes.selectedPaths,changed:()=>changes.invalidate(),notice});
$('changes-commit').onclick=()=>{if(!$('changes-commit').disabled)return commits.show().catch(error=>notice(error.message,true));};
const views = documentViews({$,view});
const creation=documentCreation({$,api,checkout:()=>checkoutKey,state,beforeNavigate:beforeDesktopLeave,open,library,notice,createdRecord:record=>records.show(record.type==='flag'?'flags':'decisions',record.id)});
const recoveryCenterView=recoveryCenter({$,api,checkout:()=>checkoutKey,beforeNavigate:beforeDesktopLeave,resume:resumeRecovery,notice});
const quick=quickNavigation({$,api,state,library,open,jump:section=>navigation.jumpTo(section),notice,actions:()=>[
  {title:'New document…',run:()=>creation.show()},
  {title:'New flag…',detail:'Record a finding for triage',run:()=>creation.show({template:'flag'})},
  {title:'New decision…',detail:'Compare alternatives before ruling',run:()=>creation.show({template:'decision'})},
  {title:'Recovery',detail:'Drafts and interrupted operations',run:()=>recoveryCenterView.show()},
  {title:'Changes',detail:'Review saved documents against local Git history',run:()=>changes.show()},
  {title:'Library',run:showLibrary},{title:'Active plans',run:()=>library.applyView('active-plans')},{title:'Hubs',run:()=>library.applyView('hubs')},
  {title:'Flags needing attention',run:()=>records.show('flags')},{title:'Decisions needing attention',run:()=>records.show('decisions')},
  {title:'Templates',run:()=>$('open-templates').click()},{title:'Settings',run:()=>$('open-settings').click()},
  ...(library.savedViews?.()??[]).map(v=>({title:`View: ${v.name}`,detail:'Saved library filters',run:()=>library.applyView(v.id)})),
]});
function notice(message, error = false) { $('notice').textContent = message; $('notice').classList.toggle('error', error); }
async function api(route,body) {const result=await request(route,body,state.csrf);if(body!==undefined&&['save','undo','create/commit','lifecycle/commit','native/action','flags/triage'].includes(route))changes.invalidate();return result;}
function guarded(fn) { return async () => { try { await fn(); } catch (error) { notice(error.message, true); } }; }
function key(path = state.doc?.path) { return `runlist:recovery:${checkoutKey}:${encodeURIComponent(path)}:${clientId}`; }
function recoverySource() {
  if (state.pending?.kind === 'undo') return state.pending.source;
  try { return candidate(); } catch { return splitSource(state.base.source).envelope + state.body; }
}
function storeLocal() {
  if (!state.doc || !state.base) return;
  const record = { path:state.doc.path, baseSource:state.base.source, baseRevision:state.base.revision, source:recoverySource(), draft:state.draft, pending:state.pending, lastSave:state.lastSave, conflicted:!!state.conflict, at:Date.now() };
  try { localStorage.setItem(key(), JSON.stringify(record)); state.recoveryStored = true; } catch { state.recoveryStored = false; notice(`${desktop?'Runlist':'Browser'} recovery storage is full. Keep this tab open until the draft is saved to disk.`, true); }
}
function findRecovery(path) {
  const prefix = `runlist:recovery:${checkoutKey}:${encodeURIComponent(path)}:`;
  const records = [];
  try { for (let i = 0; i < localStorage.length; i++) {
    const location = localStorage.key(i); if (!location.startsWith(prefix)) continue;
    try { records.push({ ...JSON.parse(localStorage.getItem(location)), location }); } catch { /* Ignore unreadable browser entries, not disk state. */ }
  }
  } catch { /* Disk recovery remains available when renderer storage cannot be read. */ }
  return records.find(r => r.location === key(path)) ?? records.sort((a,b) => b.at - a.at)[0];
}
function linked(href) {
  const target=href.split('#')[0];
  if(!target.endsWith('.md')||/^(?:[a-z][a-z0-9+.-]*:|\\|\/\/)/i.test(target))return null;
  return `?ref=${encodeURIComponent(href)}&from=${encodeURIComponent(state.doc?.path??'')}`;
}

function candidate() { return state.pending?.kind === 'undo' ? state.pending.source : editedSource(state.base.source, state.body); }
function updateDirty() {
  state.dirty = candidate() !== state.base.source;
  const rows = lineDiff(state.base.source, candidate()), adds = rows.filter(r => r.kind === 'add').length, removes = rows.filter(r => r.kind === 'remove').length;
  $('change-count').textContent = state.dirty ? `${adds + removes}` : '';
  $('review-summary').textContent = `${adds} added ${adds === 1 ? 'line' : 'lines'} · ${removes} removed ${removes === 1 ? 'line' : 'lines'} · ${state.doc.path}`;
  const claimed = state.doc.claim?.state === 'owned' || state.doc.claim?.corrupt;
  $('save').disabled = !state.dirty || !state.doc.editable || claimed || !!state.conflict || state.busy;
  $('edit').disabled = !state.doc.editable || state.busy;
  $('tab-edit').disabled = !state.doc.editable || state.busy;
  $('undo').disabled = !state.lastSave || state.dirty || claimed || state.busy;
  $('body-editor').readOnly = !!state.pending;
  blockEditor.setReadOnly(!!state.pending || !state.doc.editable);
  $('toggle-markdown').disabled = !!state.pending;
  $('pending-note').hidden = !state.pending;
  $('save').textContent = state.pending ? state.pending.kind === 'undo' ? 'Retry undo' : 'Retry save' : 'Save changes';
}
function view(mode) {
  if (!state.doc) return;
  state.mode = mode;
  $('records-home').hidden=true;records.deactivate();changes.deactivate();
  $('workspace').classList.remove('library-start');$('empty').hidden=true;$('document').hidden=false;
  $('doc-title').textContent=state.doc.title;$('doc-path').textContent=state.doc.path;$('doc-status').textContent=state.doc.status??'';
  views.update(mode);
  const source = candidate();
  $('reading').innerHTML = markdownHtml(state.dirty ? source : state.doc.source, linked);
  $('full-source').textContent = state.doc.source;
  $('diff').innerHTML = diffHtml(state.base.source, source);
  updateDirty();
  if (mode === 'read' && state.dirty) notice('Previewing your draft. It has not been saved to the file.');
  if (mode === 'edit' && (editorPath !== state.doc.path || blockEditor.source() !== state.body)) { blockEditor.set(state.body,{readOnly:!!state.pending || !state.doc.editable}); editorPath=state.doc.path; }
  if (mode !== 'edit') blockEditor.hideTools();
  navigation.update();library.render();
}
function renderList() { library.render(); }

function renderDocumentSummary() {
  $('doc-title').textContent=state.doc.title;
  const plan=state.plans.find(p=>p.path===state.doc.path);
  if(plan){plan.title=state.doc.title;plan.status=state.doc.status;}library.opened();
}
function renderEvidence() {
  const doc = state.doc;
  renderConnections();
  $('file-info').innerHTML = `<dl><dt>Source file</dt><dd>${esc(doc.path)}</dd><dt>Revision</dt><dd><code>${esc(doc.revision.slice(0,23))}…</code></dd><dt>Actor</dt><dd>${esc($('identity').textContent)}</dd></dl><p class="muted">Source is the record. Save changes the file; derived views read it again.</p>`;
  $('flags').innerHTML = doc.flags.length ? doc.flags.map(flag => `<section class="flag"><span class="flag-tag">${esc(flag.id)} · ${esc(flag.severity)} · ${esc(flag.state)}</span><h3>${esc(flag.text)}</h3><h4>ORIGINAL OBSERVATION</h4><small>${esc(flag.original.file)}${flag.original.line ? `:${flag.original.line}` : ''}<br>${esc(flag.original.at ?? '')}</small><pre>${esc(flag.original.quote || 'File-level observation; no original quote was recorded.')}</pre><small>${esc(flag.original.revisionReason)}</small><h4>CURRENT LOCATION · ${esc(flag.current.status.toUpperCase())}</h4><pre class="current-quote">${esc(flag.current.quote ?? 'Current evidence is unavailable or ambiguous.')}</pre><small>${flag.current.line ? `Line ${flag.current.line} · ` : ''}${esc(flag.current.revision?.slice(0,23) ?? 'No current revision')}<br>Original evidence is retained.</small></section>`).join('') : '<p class="muted">No related flags recorded for this document.</p>';
}
function renderConnections() {
  const root=$('document-connections'),relations=state.doc.relationships??[];root.hidden=!relations.length;root.replaceChildren();
  for(const label of [...new Set(relations.map(r=>r.label))]) {
    const details=document.createElement('details'),items=relations.filter(r=>r.label===label),summary=document.createElement('summary');summary.textContent=`${label} · ${items.length}`;details.append(summary);let visible=0;
    const more=document.createElement('button');more.className='quiet small';more.textContent='Show more';const append=()=>{for(const relation of items.slice(visible,visible+20)){const button=document.createElement('button');button.className='connection-link quiet';button.disabled=!relation.target;button.textContent=relation.target?`${relation.target.title} · ${relation.target.status}`:`${relation.ref} · unavailable`;button.title=relation.target?.path??relation.ref;if(relation.target)button.onclick=guarded(()=>open(relation.target.path));details.insertBefore(button,more);}visible+=20;more.hidden=visible>=items.length;};details.append(more);more.onclick=append;append();root.append(details);
  }
}
async function open(path,selection={}) {
  if (state.busy) throw new Error('Wait for the current operation before switching plans.');
  clearTimeout(draftTimer);
  if (state.doc && (state.dirty || state.pending)) { storeLocal(); await persistDraft(); if(!state.recoveryStored)throw new Error('Preserve your current draft before switching documents.'); }
  notice('Opening document…');
  path=await lifecycle.resolveInitial(path);
  const doc = await api(`document?path=${encodeURIComponent(path)}`);
  state.doc = doc; state.base = { source:doc.source, revision:doc.revision }; state.body = splitSource(doc.source).body.replaceAll('\r\n','\n');
  state.dirty = false; state.conflict = null; state.pending = null; state.lastSave = null; state.draft = null;
  let recovery = selection.location ? {...JSON.parse(localStorage.getItem(selection.location)),location:selection.location} : findRecovery(doc.path);
  if(selection.draftId||!recovery||recovery.source===recovery.baseSource&&!recovery.pending) {
    const draftId=selection.draftId??(await api(`recovery?${new URLSearchParams({path:doc.path,limit:'200'})}`)).items.find(item=>item.kind==='draft'&&item.available)?.draftId;
    if(draftId){const disk=await api('draft/read',{path:doc.path,draftId});if(disk)recovery={...disk,draft:{id:disk.id,revision:disk.revision},location:key(doc.path),pending:disk.pendingOperation?{...disk.pendingOperation,path:doc.path,source:disk.source}:null,at:Date.parse(disk.at)};}
  }
  state.recovery = recovery;
  if (recovery?.draft) {
    const disk = await api('draft/read',{ path:doc.path, draftId:recovery.draft.id });
    if (disk && (!recovery.source || recovery.source === recovery.baseSource)) { recovery.source = disk.source; recovery.baseSource = disk.baseSource; recovery.baseRevision = disk.baseRevision; recovery.draft.revision = disk.revision; }
  }
  if (recovery?.lastSave) state.lastSave = recovery.lastSave;
  const recoverable = recovery && (recovery.source !== recovery.baseSource || recovery.pending);
  $('recovery').hidden = !recoverable;
  $('recovery-label').textContent = recoverable ? 'A locally preserved draft is available. Recover it to review changes; the Markdown file is unchanged.' : '';
  $('draft-status').textContent = recoverable ? 'Draft available' : 'Saved source';
  $('claim').hidden = !(doc.claim?.corrupt || doc.claim?.state === 'owned' || !doc.editable);
  $('claim').textContent = doc.claim?.corrupt ? 'Ownership is corrupt. Repair it through the CLI before saving.' : doc.claim?.state === 'owned' ? `Owned by session ${doc.claim.sessionId}. You can keep a draft; coordinate or release the claim through the CLI before saving.` : !doc.editable ? 'This source is read only. Its format or metadata needs repair before saving.' : '';
  $('conflict').hidden = true; $('operation-repair').hidden = true; $('empty').hidden = true; $('document').hidden = false;$('workspace').classList.remove('library-start');
  $('doc-title').textContent = doc.title; $('doc-path').textContent = doc.path; $('doc-status').textContent = doc.status ?? '';
  $('body-editor').value = state.body; $('markdown-fallback').hidden=true; $('block-editor').hidden=false; $('toggle-markdown').textContent='Edit Markdown'; $('toggle-markdown').setAttribute('aria-expanded','false'); renderList(); renderEvidence(); view(doc.editable?'edit':'read');
  const url = new URL(location.href); url.searchParams.delete('ref');url.searchParams.delete('from');url.searchParams.delete('view');url.searchParams.delete('record');url.searchParams.set('path',doc.path); history.replaceState(null,'',url);
  library.opened();
  $('sidebar').classList.remove('open');$('toggle-plans').setAttribute('aria-expanded','false');window.scrollTo(0,0); notice(doc.editable?'Your document is ready to edit. Changes are kept as a draft until you save.':'This document is read only. Its source is preserved.');
}
async function persistDraft() {
  if (!state.doc || !state.base || (!state.dirty && !state.pending)) return;
  state.draft ||= { id:crypto.randomUUID(), revision:null };
  storeLocal();
  const request = { path:state.doc.path, draftId:state.draft.id, expectedDraftRevision:state.draft.revision, baseSource:state.base.source, baseRevision:state.base.revision, source:recoverySource(),pendingOperation:state.pending?{operationId:state.pending.operationId,kind:state.pending.kind??'save',expectedRevision:state.pending.expectedRevision,...(state.pending.kind==='undo'?{undoOf:state.pending.undoOf}:{})}:null };
  const path = state.doc.path, id = state.draft.id;
  const run = async () => {
    try {
      // Queued calls must use the most recently acknowledged draft revision.
      if (state.doc?.path !== path || state.draft?.id !== id) return;
      request.expectedDraftRevision = state.draft.revision;
      const stored = await api('draft/write', request);
      if (state.doc?.path === path && state.draft?.id === id) { state.draft.revision = stored.revision; storeLocal(); state.recoveryStored=true; $('draft-status').textContent = 'Draft preserved locally · not saved to Markdown'; }
    } catch (error) { $('draft-status').textContent = desktop?'Draft kept in Runlist':'Draft kept in browser'; notice(error.code === 'draft-conflict' ? 'Another editor updated the disk draft. Your text is kept locally; recover or copy it before proceeding.' : `Draft kept ${desktop?'in Runlist':'in browser'}. ${error.message}`, true); }
  };
  persistence = persistence.then(run,run); await persistence;
}
function conflict(error) {
  state.conflict = error.details;
  $('conflict').hidden = false;
  $('current-diff').innerHTML = diffHtml(state.base.source, error.details.currentSource);
  $('draft-diff').innerHTML = diffHtml(state.base.source, candidate());
  $('current-source').textContent = error.details.currentSource; $('base-source').textContent = state.base.source;
  storeLocal();notice('Save stopped: another edit changed the file. Your draft is kept.',true); view('edit'); $('conflict').scrollIntoView({ block:'start', behavior:'auto' });
}
async function recover() {
  const r = state.recovery; if (!r) return;
  state.base = { source:r.baseSource, revision:r.baseRevision }; state.body = splitSource(r.source).body.replaceAll('\r\n','\n');
  state.draft = r.location === key() ? r.draft : null; state.pending = r.pending; state.lastSave = r.lastSave;
  $('body-editor').value = state.body; $('recovery').hidden = true; updateDirty(); storeLocal(); view('edit');
  if (state.pending) notice('An interrupted save is retained. Review changes and retry to learn its original outcome.');
  else notice('Draft recovered. Review changes before saving.');
  if (state.base.revision !== state.doc.revision && !state.pending) conflict({ details:{ currentRevision:state.doc.revision, currentSource:state.doc.source } });
}
async function clearDraft() {
  if (state.draft?.revision) await api('draft/discard', { path:state.doc.path, draftId:state.draft.id, expectedDraftRevision:state.draft.revision });
  state.draft = null;
}
async function save() {
  clearTimeout(draftTimer); await persistDraft();
  const source = candidate();
  if (state.pending && (state.pending.source !== source || state.pending.expectedRevision !== state.base.revision)) throw new Error('An interrupted save has a different payload. Recover or settle that operation before creating another save.');
  state.pending ||= { path:state.doc.path, operationId:crypto.randomUUID(), expectedRevision:state.base.revision, source };
  // Retain the original request identity on disk before publication, even if renderer storage is later lost.
  await persistDraft();
  if(!state.recoveryStored)throw new Error('Preserve the draft and operation identity before saving.');
  storeLocal(); state.busy = true; $('workspace').inert = true; updateDirty(); notice('Saving the reviewed source…');
  try {
    const result = await api(state.pending.kind === 'undo' ? 'undo' : 'save',state.pending), pending = state.pending;
    const current = await api(`document?path=${encodeURIComponent(state.doc.path)}`);
    if (result.state !== 'committed') throw new Error('Save outcome is not committed. The draft remains available.');
    state.lastSave = pending.kind === 'undo' ? null : { operationId:result.operationId, revision:result.revision };
    state.pending = null;
    if (current.revision !== result.revision) {
      state.doc = current;
      // Historical retry success is not authority to throw away a later edit.
      state.base = { source:pending.source, revision:result.revision };
      state.body = splitSource(pending.source).body.replaceAll('\r\n','\n'); storeLocal();
      conflict({ details:{ currentRevision:current.revision, currentSource:current.source } });
      return;
    }
    state.doc = current; state.base = { source:current.source, revision:current.revision }; state.body = splitSource(current.source).body.replaceAll('\r\n','\n');
    state.dirty = false; storeLocal(); let cleanupError = null;
    try { await clearDraft(); } catch (error) { cleanupError = error; }
    $('body-editor').value = state.body; $('draft-status').textContent = 'Saved source'; storeLocal(); renderDocumentSummary(); renderEvidence(); view('edit');
    notice(cleanupError ? `Saved to Markdown. Recovery draft retained: ${cleanupError.message}` : pending.kind === 'undo' ? 'Undid the save. The CLI reads the same file.' : 'Saved to Markdown. The CLI reads the same file.', !!cleanupError);
  } catch (error) {
    if (error.code === 'revision-conflict') { state.pending = null; storeLocal(); conflict(error); }
    else if (['repair-required','operation-pending'].includes(error.code)) {
      await inspectOperation(error.details.operationId); notice(error.message,true);
    } else if (['claim-conflict','managed-fields','invalid-record','forbidden'].includes(error.code)) {
      try { if (!await api('operation/inspect',{ operationId:state.pending.operationId })) { state.pending = null; storeLocal(); } } catch { /* Keep uncertain evidence when authority prevents inspection. */ }
      notice(error.message,true);
    }
    else { notice(`Save outcome is uncertain. Your draft and operation ID are kept; retry the same save. ${error.message}`,true); }
  } finally { state.busy = false; $('workspace').inert = false; updateDirty(); }
}
async function inspectOperation(operationId) {
  const operation = await api('operation/inspect',{ operationId });
  if (!operation) throw new Error('The retained operation could not be found. Keep your draft for manual review.');
  state.repair = operation; $('operation-repair').hidden = false;
  $('repair-label').textContent = `Operation ${operation.id} is ${operation.state}. Inspect its images. Settlement keeps the current file unchanged.`;
  $('repair-evidence').textContent = `BEFORE\n${operation.before}\n\nAFTER\n${operation.after}\n\nCURRENT SOURCE\n${operation.currentSource}\n\nCURRENT REVISION\n${operation.currentRevision}`;
}
async function bootstrap(token) {
  const session = token ? await api('session',{ token }) : await api('session');
  state.csrf = session.csrf; $('identity').textContent = `${session.actor.label ?? 'Local user'} · human`;
  $('disconnect').hidden = false; $('connect-panel').hidden = true;
  for(const id of ['new-document','quick-open','open-recovery'])$(id).hidden=false;
  const info = await api('library?limit=1');
  checkoutKey = `${session.actor.id}:${encodeURIComponent(info.checkoutPath)}`;
  library.restore();await library.preferences(settings.read(),false);const list=await library.load({reset:true});
  $('checkout').textContent = list.checkout; $('checkout').title = list.checkoutPath; $('workspace').hidden = false;
  renderList();
  const params = new URLSearchParams(location.search), fragment = new URLSearchParams(location.hash.slice(1));
  const resolved=params.has('ref')?await api(`link?${new URLSearchParams({ref:params.get('ref'),from:params.get('from')??''})}`):null;
  const initial = params.has('ref')?resolved?.path:params.get('path') || fragment.get('path') || list.initialPath;
  history.replaceState(null,'',location.pathname + location.search);
  if(params.get('view')==='changes')await changes.show();else if (['flags','decisions'].includes(params.get('view'))) await records.show(params.get('view'),params.get('record')); else if (initial) await open(initial); else await showLibrary();
  records.counts().catch(()=>{});
}
async function showLibrary() {
  if(state.busy)throw new Error('Wait for the current operation before returning to the library.');
  clearTimeout(draftTimer);
  if(state.doc&&(state.dirty||state.pending)){storeLocal();await persistDraft();if(!state.recoveryStored)throw new Error('Preserve your current draft before leaving the document.');}
  state.mode='home';blockEditor.hideTools();$('records-home').hidden=true;records.deactivate();changes.deactivate();
  $('workspace').classList.add('library-start');$('evidence').classList.remove('outline-open');
  $('document').hidden=true;$('empty').hidden=false;$('doc-path').textContent='';
  $('sidebar').classList.remove('open');$('toggle-plans').setAttribute('aria-expanded','false');
  const url=new URL(location.href);for(const key of ['path','ref','from','view','record'])url.searchParams.delete(key);history.replaceState(null,'',url);
  library.render();window.scrollTo(0,0);
  notice(state.doc&&(state.dirty||state.pending)?'Library ready. Your document draft stays available when you reopen it.':'Library ready.');
}
$('document-changes').onclick=guarded(()=>changes.show());
$('library-home').onclick=guarded(showLibrary);
$('back-library').onclick=guarded(showLibrary);
$('toggle-plans').onclick = () => $('toggle-plans').setAttribute('aria-expanded',String($('sidebar').classList.toggle('open')));
for (const name of ['read','edit','review','source']) $('tab-' + name).onclick = guarded(() => view(name));
$('edit').onclick = guarded(() => view(state.dirty ? 'review' : 'edit')); $('review').onclick = guarded(() => view('review')); $('back-edit').onclick = () => view('edit');
function bodyChanged(body) {
  state.body = body;
  navigation.update();
  $('body-editor').value = body;
  storeLocal();
  try { updateDirty(); storeLocal(); $('draft-status').textContent = state.dirty ? 'Saving draft…' : 'Saved source'; clearTimeout(draftTimer); if(state.dirty) draftTimer = setTimeout(() => persistDraft(),500); }
  catch (error) { $('save').disabled = true; notice(error.message,true); }
}
$('body-editor').oninput = () => bodyChanged($('body-editor').value);
$('toggle-markdown').onclick = () => {
  const showing = $('markdown-fallback').hidden;
  $('markdown-fallback').hidden = !showing; $('block-editor').hidden = showing;
  $('toggle-markdown').textContent = showing ? 'Back to document' : 'Edit Markdown';
  $('toggle-markdown').setAttribute('aria-expanded',String(showing));
  if (showing) { $('body-editor').value=state.body; $('body-editor').focus(); }
  else { blockEditor.set(state.body,{readOnly:!!state.pending}); editorPath=state.doc.path; }
};
$('save').onclick = guarded(save);
$('cancel').onclick = guarded(async () => { await persistDraft(); view('read'); notice(state.dirty ? 'Reading your draft preview. Changes are not saved to the file.' : 'Reading saved source.'); });
$('discard').onclick = guarded(async () => { if (state.pending) throw new Error('Inspect or retry the interrupted save before discarding its recovery data.'); await clearDraft(); state.body = splitSource(state.doc.source).body.replaceAll('\r\n','\n'); state.base = { source:state.doc.source, revision:state.doc.revision }; state.pending = null; state.conflict = null; $('conflict').hidden = true; $('body-editor').value = state.body; storeLocal(); $('draft-status').textContent = 'Saved source'; view('edit'); notice('Changes discarded. The Markdown file is unchanged.'); });
$('recover').onclick = guarded(recover);
$('discard-recovery').onclick = guarded(async () => {
  const r = state.recovery;
  if (r?.pending) throw new Error('This draft contains an interrupted save. Recover it and inspect the outcome before discarding.');
  if (r?.draft?.revision) await api('draft/discard',{ path:state.doc.path,draftId:r.draft.id,expectedDraftRevision:r.draft.revision });
  if (r) localStorage.removeItem(r.location); state.recovery = null; $('recovery').hidden = true; notice('Recovery draft discarded. The file is unchanged.');
});
$('review-merge').onclick = guarded(async () => { const c = state.conflict; if (!c) return; state.base = { source:c.currentSource, revision:c.currentRevision }; state.pending = null; state.conflict = null; $('conflict').hidden = true; storeLocal(); await persistDraft(); view('review'); notice('Review the merged draft against the current file before saving.'); });
$('use-current').onclick = guarded(async () => { await persistDraft(); state.doc = await api(`document?path=${encodeURIComponent(state.doc.path)}`); $('reading').innerHTML = markdownHtml(state.doc.source,linked); view('source'); notice('Current source is shown. Your draft and conflict review are retained.'); });
$('inspect-pending').onclick = guarded(() => inspectOperation(state.pending.operationId));
$('settle-operation').onclick = guarded(async () => {
  const r = state.repair; if (!r) return;
  const outcome = await api('operation/settle',{ operationId:r.id,expectedRevision:r.currentRevision,disposition:'leave-current' });
  $('operation-repair').hidden = true;
  if (outcome.state === 'committed' && state.pending?.operationId === r.id) { await save(); return; }
  state.pending = null; storeLocal(); updateDirty();
  const current = await api(`document?path=${encodeURIComponent(state.doc.path)}`);
  if (current.revision !== state.base.revision) conflict({ details:{ currentRevision:current.revision,currentSource:current.source } });
  notice(`Operation settled as ${outcome.state}. The current file was left unchanged; review your draft before a new save.`);
});
$('undo').onclick = guarded(async () => {
  const previous = state.lastSave;
  state.busy = true; $('workspace').inert = true;
  try {
    const record = await api('operation/inspect',{ operationId:previous.operationId });
    if (!record) throw new Error('The original save receipt is unavailable. Undo cannot overwrite the file.');
    state.base = { source:record.after, revision:previous.revision };
    state.body = splitSource(record.before).body.replaceAll('\r\n','\n'); $('body-editor').value = state.body;
    state.pending = { path:state.doc.path,operationId:crypto.randomUUID(),undoOf:previous.operationId,expectedRevision:previous.revision,kind:'undo',source:record.before };
    storeLocal(); updateDirty();
    await save(); // The same persisted retry and conflict machinery as Save.
  } finally { state.busy = false; $('workspace').inert = false; updateDirty(); }
});
$('reading').addEventListener('click',event=>{const anchor=event.target.closest('a');if(!anchor||event.metaKey||event.ctrlKey||event.shiftKey)return;const url=new URL(anchor.href,location.href);if(url.origin!==location.origin||!url.searchParams.has('ref'))return;event.preventDefault();guarded(async()=>{const target=await api(`link?${new URLSearchParams({ref:url.searchParams.get('ref'),from:url.searchParams.get('from')??''})}`);if(!target)throw new Error('This linked document is unavailable or outside this library.');await open(target.path);})();});
$('copy-source').onclick = guarded(async () => { await copyText(state.doc.source); notice('Canonical Markdown source copied.'); });
$('disconnect').onclick = guarded(async () => { await beforeDesktopLeave(); await api('logout',{}); $('workspace').hidden = true; $('connect-panel').hidden = false; for(const id of ['disconnect','new-document','quick-open','open-recovery'])$(id).hidden=true; notice('Disconnected. Private drafts are retained locally.'); await desktopDisconnected(); });
$('connect-form').onsubmit = event => { event.preventDefault(); guarded(async () => { const value = $('access').value.trim(); let token = value; try { token = new URLSearchParams(new URL(value).hash.slice(1)).get('connect') ?? value; } catch { /* A raw token is also accepted. */ } await bootstrap(token); $('access').value = ''; })(); };
window.addEventListener('beforeunload', event => { if (state.dirty || state.pending) { storeLocal(); if (!state.recoveryStored) { event.preventDefault(); event.returnValue = ''; } } });
document.addEventListener('keydown', event => { if (document.querySelector('dialog[open]')) return; if ((event.metaKey || event.ctrlKey) && event.key === 's') { event.preventDefault(); if (state.doc && state.dirty) guarded(() => view('review'))(); } });
async function beforeDesktopLeave() {
  if(state.busy)throw new Error('Wait for the current operation before switching folders or quitting.');
  if($('template-dialog').open||$('lifecycle-dialog')?.open||$('create-dialog').open||$('git-commit-dialog').open||$('filter-dialog').open||$('record-review')&&!$('record-review').hidden)throw new Error('Close the current review or template editor before switching folders or quitting.');
  clearTimeout(draftTimer);
  if(state.doc&&(state.dirty||state.pending)){storeLocal();await persistDraft();if(!state.recoveryStored)throw new Error('Recovery storage is unavailable. Save or preserve your draft before leaving.');}
  await persistence;
}
async function resumeRecovery(row) {
  if(row.kind==='git-commit'){await commits.show({operationId:row.operationId});return;}
  if(row.kind==='creation'){await creation.show(row.operationId?{operationId:row.operationId}:{});return;}
  if(row.kind==='lifecycle'){await lifecycle.resume(row.operationId);return;}
  if(row.kind==='record'){await records.show(row.recordKind,row.recordKey);return;}
  if(row.kind==='operation'){await open(row.path);await inspectOperation(row.operationId);return;}
  await open(row.path,row.location?{location:row.location}:{draftId:row.draftId});await recover();
  if(state.pending)await inspectOperation(state.pending.operationId);
}
try { if(!await mountDesktop({beforeLeave:beforeDesktopLeave,bootstrap,notice}))await bootstrap(new URLSearchParams(location.hash.slice(1)).get('connect')); }
catch (error) { if(!desktop)$('connect-panel').hidden = false; notice(error.message,true); }
