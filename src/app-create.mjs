import {createHash} from 'node:crypto';
import {existsSync, lstatSync, mkdirSync, readFileSync, readdirSync} from 'node:fs';
import path from 'node:path';
import {appDocumentTemplates, catchAllRoot, renderAppDocument} from './new.mjs';
import {readTemplateStore} from './template-store.mjs';
import {parseDocFile} from './index.mjs';
import {extractFrontmatter, parseSimpleFrontmatter} from './frontmatter.mjs';
import {authorizeManagedDestination, authorizeRepoGeneratedPath} from './managed-path.mjs';
import {createFileExclusive, replaceSnapshot, snapshotFile, withPathLocks} from './atomic-mutation.mjs';
import {SourceEditError, assertPrivateEditorStorage, sourceRevision} from './source-editor.mjs';
import {stateDir} from './naming.mjs';
import {parseNativeRecord} from './native-record.mjs';
import {recordSettings,recordSettingsPath,recordSettingsText,renderNewRecord,assertRecordTrackable} from './record-create.mjs';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail=(code,message)=>{throw new SourceEditError(code,message);};
const hash=value=>createHash('sha256').update(value).digest('hex');
const json=value=>JSON.stringify(value,null,2)+'\n';

/** Reviewed, exclusive creation. The renderer never supplies the committed source. */
export function createAppDocuments({config,actor,library}) {
  const directory=path.join(stateDir(config.repoRoot),'editor','creations');
  const initialConfig=config.configPath?hash(readFileSync(config.configPath)):null;
  function safe(file) {
    const checked=authorizeRepoGeneratedPath(file,config).path;
    let current=config.repoRoot;
    for(const part of path.relative(config.repoRoot,checked).split(path.sep)) {
      current=path.join(current,part);
      try{if(lstatSync(current).isSymbolicLink())fail('unsafe-local-state','Creation reviews may not traverse symlinks.');}
      catch(error){if(error.code!=='ENOENT')throw error;}
    }
    return checked;
  }
  function location(id){if(!uuid.test(id??''))fail('invalid-id','A UUID v4 creation operation is required.');return safe(path.join(directory,id+'.json'));}
  function read(id) {
    const file=location(id);if(!existsSync(file))return null;
    try {
      if(!lstatSync(file).isFile()||lstatSync(file).size>2*1024*1024)throw new Error('size');
      const value=JSON.parse(readFileSync(file,'utf8'));
      if(value.schema!==1||value.id!==id||!['reviewed','prepared','committed','discarded'].includes(value.state)||!value.actor||typeof value.path!=='string'||sourceRevision(value.source)!==value.revision)throw new Error('schema');
      if(value.native!==undefined){
        const parsed=parseNativeRecord(value.source),record=parsed.record;
        if(value.native!==true||!parsed.ok||!['flag','decision'].includes(record.type)||record.status!=='open'||record.record_data.created_by.id!==value.actor.id||record.record_data.created_by.kind!==value.actor.kind||typeof value.recordShared!=='boolean'||value.recordGuard!==null&&!/^sha256:[a-f0-9]{64}$/.test(value.recordGuard))throw new Error('native schema');
        if(value.setup){
          if(value.setup.path!=='runlist.records.json'||typeof value.setup.source!=='string'||Buffer.byteLength(value.setup.source)>16384)throw new Error('setup');
          const settings=JSON.parse(value.setup.source),folder=record.type==='flag'?'flags':'decisions';
          if(settings.schema!==1||settings.repositoryId!==record.record_data.repository_id||settings.shared!==false||value.path.slice(0,value.path.lastIndexOf('/'))!==`${settings.root}/${folder}`)throw new Error('setup identity');
        }
      }
      return value;
    }catch{fail('state-corrupt','The creation review needs inspection; it will not be overwritten.');}
  }
  function own(context,value){const who=actor(context);if(who.kind!=='human'||who.id!==value.actor.id||who.kind!==value.actor.kind)fail('forbidden','This creation review belongs to another user.');}
  function write(value) {
    safe(directory);assertPrivateEditorStorage(config.repoRoot,directory);mkdirSync(directory,{recursive:true,mode:0o700});safe(directory);
    const file=location(value.id);
    if(existsSync(file))replaceSnapshot(snapshotFile(file),json(value),{repoRoot:config.repoRoot,locked:true});
    else createFileExclusive(file,json(value),{repoRoot:config.repoRoot,mode:0o600,locked:true});
  }
  function destination(relative) {
    if(typeof relative!=='string'||path.isAbsolute(relative)||relative.includes('\\')||relative.split('/').some(p=>!p||p==='.'||p==='..'||p==='prompts'||p==='.git'||config.excludeDirs?.has(p)))fail('invalid-path','Choose a Markdown destination within the configured document roots.');
    const file=path.resolve(config.repoRoot,relative);
    if(file===config.indexPath)fail('invalid-path','The generated index is not a document destination.');
    return authorizeManagedDestination(file,config).path;
  }
  const guards=()=>{const current=config.configPath?hash(readFileSync(config.configPath)):null;if(current!==initialConfig)fail('creation-review-stale','Configuration changed. Reopen the checkout before creating a document.');return {templates:readTemplateStore(config).revision,config:current};};
  async function options(){
    const catalog=appDocumentTemplates(config),roots=(config.docsRoots??[config.docsRoot]).map(root=>path.relative(config.repoRoot,root).split(path.sep).join('/'));
    const templates=catalog.templates.filter(t=>config.validTypes.has(t.type)).map(t=>{
      const target=t.type==='plan'?(config.docsRoots??[config.docsRoot]).find(r=>path.basename(r)==='plans'):null;
      const folder=target??(t.type==='plan'?path.join(catchAllRoot(config),'plans'):catchAllRoot(config));
      const statuses=[...(config.typeStatuses?.get(t.type)??config.validStatuses)].filter(s=>s!=='in-session'&&!config.lifecycle.archiveStatuses.has(s));
      return {...t,folder:path.relative(config.repoRoot,folder).split(path.sep).join('/'),statuses,defaultStatus:statuses.includes(t.defaultStatus)?t.defaultStatus:statuses[0]};
    });
    let records=null,recordError=null;
    try{
      records=recordSettings(config,safe,destination);
      if(records.needsSetup){const existing=(await library?.all()??[]).flatMap(row=>row.recordRepositoryId?[row.recordRepositoryId]:[]);records=recordSettings(config,safe,destination,existing);}
      for(const type of ['flag','decision'])templates.push({name:type,type,native:true,origin:'Native Markdown',description:type==='flag'?'A finding to triage, with its original context.':'An open question with described alternatives and consequences.',folder:`${records.root}/${type==='flag'?'flags':'decisions'}`,statuses:['open'],defaultStatus:'open'});
    }catch(error){recordError=error.message;}
    return {...catalog,roots,templates,records,recordError};
  }
  function publicReview(value){const parsed=value.native?parseNativeRecord(value.source):null;return {operationId:value.id,state:value.state,path:value.path,source:value.source,revision:value.revision,diagnostics:value.diagnostics,...(parsed?{record:parsed.record,setup:value.setup??null}:{})};}
  async function preview(context,request) {
    const who=actor(context);if(who.kind!=='human'||!who.id)fail('forbidden','Document creation requires a local human.');
    const catalog=await options(),template=catalog.templates.find(t=>t.name===request.template);
    if(!template)fail('invalid-template',catalog.recordError??'Choose an available document or record template.');
    if(typeof request.title!=='string'||!request.title.trim()||request.title.length>200||/[\r\n\0]/.test(request.title))fail('invalid-request','Give the document a single-line title, up to 200 characters.');
    if(typeof request.filename!=='string'||!/^[a-z0-9][a-z0-9_-]{0,119}\.md$/.test(request.filename))fail('invalid-path','Use a Markdown filename with letters, numbers, hyphens or underscores.');
    if(!template.statuses.includes(request.status))fail('invalid-status','Choose a configured initial status.');
    if(typeof request.body!=='string'||Buffer.byteLength(request.body)>256*1024||request.body.includes('\0'))fail('invalid-source','Initial content must be text smaller than 256 KiB.');
    const fields=[request.template,request.title,request.filename,request.folder,request.status,request.body];
    if(template.native)fields.push(request.severity,request.options);
    const requestHash=hash(JSON.stringify(fields));
    const prior=read(request.operationId);if(prior){own(context,prior);if(prior.requestHash!==requestHash)fail('operation-reused','This creation ID already belongs to another review.');return publicReview(prior);}
    const relative=`${request.folder}/${request.filename}`,file=destination(relative);
    if(existsSync(file))fail('creation-conflict','A file already exists at this destination. Choose another filename.');
    const today=new Date().toISOString();
    let source,setup=null,native=false,recordGuard=null,recordShared=false,diagnostics=[];
    if(template.native){
      if(request.folder!==template.folder)fail('invalid-path','Create records in their configured flag or decision folder.');
      const settings=catalog.records;assertRecordTrackable(config,file,settings.shared);
      ({source,setup}=renderNewRecord(request,who,settings,today));native=true;recordGuard=settings.revision;recordShared=settings.shared;
      if(setup)assertRecordTrackable(config,safe(recordSettingsPath(config)),settings.shared);
    }else{
    source=renderAppDocument(request.template,{title:request.title.trim(),status:request.status,today,bodyInput:request.body},config);
    const warnings=[],fm=parseSimpleFrontmatter(extractFrontmatter(source).frontmatter,warnings);
    if(warnings.length||fm.type!==template.type||fm.status!==request.status||fm.record_schema!==undefined)fail('invalid-template','Repair the template metadata before creating a document.');
    const parsed=parseDocFile(file,config,{source});diagnostics=[...parsed.errors,...parsed.warnings].map(d=>({level:d.level,message:d.message}));
    if(parsed.errors.length)throw new SourceEditError('invalid-record','The new document fails checkout validation.',{diagnostics});
    }
    const value={schema:1,id:request.operationId,state:'reviewed',actor:who,path:relative,source,revision:sourceRevision(source),requestHash,guards:guards(),diagnostics,at:today,...(native?{native,setup,recordGuard,recordShared}:{})};
    return withPathLocks([location(value.id)],{repoRoot:config.repoRoot},()=>{
      const prior=read(value.id);if(prior){own(context,prior);if(prior.requestHash!==requestHash)fail('operation-reused','This creation ID already belongs to another review.');return publicReview(prior);}
      write(value);return publicReview(value);
    });
  }
  function inspect(context,{operationId}) {
    const value=read(operationId);if(!value)return null;own(context,value);const file=destination(value.path);
    let currentRevision=null;
    if(existsSync(file)) {if(lstatSync(file).isSymbolicLink()||!lstatSync(file).isFile()||lstatSync(file).size>8*1024*1024)fail('creation-conflict','The destination is unavailable for inspection.');currentRevision=sourceRevision(readFileSync(file,'utf8'));}
    return {...publicReview(value),currentRevision};
  }
  function commit(context,{operationId}) {
    const prior=read(operationId);if(!prior)fail('operation-missing','Review the document before creating it.');own(context,prior);
    return withPathLocks([location(operationId),destination(prior.path),...(prior.native?[safe(recordSettingsPath(config))]:[])],{repoRoot:config.repoRoot},()=>{
      const value=read(operationId);own(context,value);const file=destination(value.path);
      if(value.state==='discarded')fail('creation-discarded','This review was discarded. Prepare a new document.');
      if(value.state==='committed')return {...publicReview(value),replayed:true};
      if(value.native){
        if(JSON.stringify(value.guards)!==JSON.stringify(guards()))fail('creation-review-stale','Configuration changed. Review a new record.');
        const metadataSource=recordSettingsText(config,safe),current=metadataSource===null?null:sourceRevision(metadataSource);
        const recovered=value.state==='prepared'&&value.setup&&current===sourceRevision(value.setup.source);
        if(current!==value.recordGuard&&!recovered)fail('creation-review-stale','Record settings changed. Review the record again.');
        assertRecordTrackable(config,file,value.recordShared);
      }
      if(value.state==='prepared'&&existsSync(file)) {
        const current=inspect(context,{operationId});
        if(current.currentRevision!==value.revision)fail('creation-uncertain','The destination differs from the reviewed source. Inspect it; it will not be overwritten.');
      } else {
        if(existsSync(file))fail('creation-conflict','Another file appeared at this destination. It will not be overwritten.');
        if(JSON.stringify(value.guards)!==JSON.stringify(guards()))fail('creation-review-stale','Configuration or templates changed. Review a new document before creating it.');
        value.state='prepared';write(value);
        if(value.setup){const metadata=safe(recordSettingsPath(config)),source=recordSettingsText(config,safe);if(source===null)createFileExclusive(metadata,value.setup.source,{repoRoot:config.repoRoot,locked:true});else if(sourceRevision(source)!==sourceRevision(value.setup.source))fail('creation-uncertain','Record setup differs from this review. Inspect it before continuing.');}
        mkdirSync(path.dirname(file),{recursive:true});destination(value.path);
        createFileExclusive(file,value.source,{repoRoot:config.repoRoot,locked:true});
      }
      if(value.setup){const metadata=safe(recordSettingsPath(config)),source=recordSettingsText(config,safe);if(source===null)createFileExclusive(metadata,value.setup.source,{repoRoot:config.repoRoot,locked:true});else if(sourceRevision(source)!==sourceRevision(value.setup.source))fail('creation-uncertain','Record setup differs from this review. Inspect it before continuing.');}
      value.state='committed';write(value);return publicReview(value);
    });
  }
  function discard(context,{operationId}) {
    return withPathLocks([location(operationId)],{repoRoot:config.repoRoot},()=>{
      const value=read(operationId);if(!value)return {discarded:true};own(context,value);
      if(!['reviewed','discarded'].includes(value.state))fail('creation-uncertain','Inspect this creation outcome before dismissing it.');
      value.state='discarded';write(value);return {discarded:true};
    });
  }
  function list(context) {
    safe(directory);if(!existsSync(directory))return {items:[],unavailable:0};
    const items=[];let unavailable=0;
    for(const name of readdirSync(directory).filter(n=>n.endsWith('.json')&&uuid.test(n.slice(0,-5)))) {
      try{const value=read(name.slice(0,-5));if(value.actor.id!==actor(context).id||!['reviewed','prepared'].includes(value.state))continue;own(context,value);destination(value.path);items.push({kind:'creation',path:value.path,operationId:value.id,state:value.state,at:value.at,available:true});}
      catch{unavailable++;}
    }
    return {items,unavailable};
  }
  return {options,preview,commit,inspect,discard,list};
}
