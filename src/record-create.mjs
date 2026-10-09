import {randomUUID} from 'node:crypto';
import {existsSync,openSync,closeSync,fstatSync,readSync,constants} from 'node:fs';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {catchAllRoot} from './new.mjs';
import {parseNativeRecord,NATIVE_RECORD_SCHEMA} from './native-record.mjs';
import {SourceEditError,sourceRevision} from './source-editor.mjs';

const fail=message=>{throw new SourceEditError('record-configuration',message);};
const uuid='[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
const id=kind=>`${kind}:${randomUUID()}`;
export const recordSettingsPath=config=>path.join(config.repoRoot,'runlist.records.json');
export function recordSettingsText(config,safe){
 const file=safe(recordSettingsPath(config));if(!existsSync(file))return null;
 let fd;try{
  fd=openSync(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));const before=fstatSync(fd);
  if(!before.isFile()||before.size>16384)fail('Record settings must be an ordinary JSON file smaller than 16 KiB.');
  const bytes=Buffer.alloc(16385);let length=0;
  while(length<bytes.length){const count=readSync(fd,bytes,length,bytes.length-length,length);if(!count)break;length+=count;}
  const after=fstatSync(fd);if(length!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)fail('Record settings changed while being read. Retry the review.');
  return bytes.toString('utf8',0,length);
 }finally{if(fd!==undefined)closeSync(fd);}
}
export function recordSettings(config,safe,destination,existingIds=[]){
 let persisted=null,revision=null;const source=recordSettingsText(config,safe);
 if(source!==null){
  revision=sourceRevision(source);
  try{persisted=JSON.parse(source);}catch{fail('Repair runlist.records.json before creating records.');}
 }
 const configured=config.raw?.records;
 if(configured&&persisted&&JSON.stringify([configured.schema,configured.repositoryId,configured.root,configured.shared])!==JSON.stringify([persisted.schema,persisted.repositoryId,persisted.root,persisted.shared]))fail('The records configuration and runlist.records.json disagree. Reconcile them before creating records.');
 const value=configured??persisted;
 if(value){
  if(value.schema!==1||!new RegExp(`^repo:${uuid}$`).test(value.repositoryId??'')||typeof value.root!=='string'||!value.root||typeof value.shared!=='boolean')fail('Records require schema 1, a persisted repo UUID, a document root and an explicit shared value.');
  destination(`${value.root}/flags/record.md`);destination(`${value.root}/decisions/record.md`);
  return {...value,revision,needsSetup:false};
 }
 const root=path.relative(config.repoRoot,path.join(catchAllRoot(config),'records')).split(path.sep).join('/');
 destination(`${root}/flags/record.md`);
 const identities=[...new Set(existingIds)];if(identities.length>1)fail('Existing native records use multiple repository identities. Choose the repositoryId explicitly in records configuration before creating another.');
 return {schema:1,root,shared:false,revision:null,needsSetup:true,...(identities.length?{repositoryId:identities[0]}:{})};
}
export function assertRecordTrackable(config,file,shared){
 if(!shared)return;
 const relative=path.relative(config.repoRoot,file).split(path.sep).join('/');
 try{
  const common={stdio:['ignore','pipe','ignore'],encoding:'utf8',timeout:3000};
  if(execFileSync('git',['-C',config.repoRoot,'rev-parse','--is-inside-work-tree'],common).trim()!=='true')throw new Error('not checkout');
  try{execFileSync('git',['-C',config.repoRoot,'check-ignore','-q','--',relative],common);fail('The shared record destination is ignored by Git. Choose a trackable root; Runlist will not force-add it.');}
  catch(error){if(error.code==='record-configuration')throw error;if(error.status!==1)fail('Cannot verify Git policy for shared records.');}
 }catch(error){if(error.code==='record-configuration')throw error;fail('Shared record creation requires a working Git checkout.');}
}
export function renderNewRecord(request,actor,settings,at){
 const allowed=new Set(['operationId','template','title','folder','filename','status','body','severity','options']);
 if(Object.keys(request).some(key=>!allowed.has(key)))throw new SourceEditError('invalid-request','Use only the supported record fields.');
 if(request.status!=='open')throw new SourceEditError('invalid-status','New records start open. Record a ruling or triage separately.');
 const type=request.template,recordId=id(type),repositoryId=settings.repositoryId??id('repo');
 const data={repository_id:repositoryId,created_by:actor,aliases:[],evidence:[],relations:[],history:[{id:id('event'),kind:'created',by:actor,at}]};
 if(type==='flag'){
  if(!['problem','warn','info'].includes(request.severity)||request.options!==undefined)throw new SourceEditError('invalid-request','Choose Problem, Warning or Information for this finding.');
  Object.assign(data,{severity:request.severity,source:{kind:'manual',name:'Runlist',finding_key:recordId},occurrence:1,triage:{disposition:'unreviewed'},resolutions:[]});
 }else{
  if(request.severity!==undefined||!Array.isArray(request.options)||request.options.length<2||request.options.length>12)throw new SourceEditError('invalid-request','Describe between two and twelve alternatives.');
  const text=(value,max)=>typeof value==='string'&&value.trim()&&value.length<=max&&!value.includes('\0');
  const labels=new Set();
  const options=request.options.map(option=>{
   if(!option||Object.keys(option).some(k=>!['label','description','consequences'].includes(k))||!text(option.label,120)||!text(option.description,4000)||!Array.isArray(option.consequences)||option.consequences.length>16)throw new SourceEditError('invalid-request','Each alternative needs a label, description and supported consequences.');
   const label=option.label.trim(),key=label.toLowerCase();if(labels.has(key))throw new SourceEditError('invalid-request','Give each alternative a distinct label.');labels.add(key);
   const consequences=option.consequences.map(c=>{
    if(!c||Object.keys(c).some(k=>!['kind','text'].includes(k))||!['benefit','cost','risk','follow-up'].includes(c.kind)||!text(c.text,4000))throw new SourceEditError('invalid-request','Use a benefit, cost, risk or follow-up with a description.');
    return {kind:c.kind,text:c.text.trim()};
   });return {id:id('option'),label,description:option.description.trim(),consequences};
  });Object.assign(data,{options,recommendations:[],rulings:[]});
 }
 const primary=type==='flag'?'finding':'question';
 const fm={record_schema:NATIVE_RECORD_SCHEMA,id:recordId,type,status:'open',created:at,updated:at,[primary]:request.title.trim()};
 const body=request.body.trim()?request.body:'## Context\n\n';
 const source=`---\n${Object.entries(fm).map(([k,v])=>`${k}: ${JSON.stringify(v)}`).join('\n')}\nrecord_data: |-\n${JSON.stringify(data,null,2).split('\n').map(line=>'  '+line).join('\n')}\n---\n${body}${body.endsWith('\n')?'':'\n'}`;
 const parsed=parseNativeRecord(source);if(!parsed.ok)throw new SourceEditError('invalid-record','The new record does not satisfy the native contract.',{diagnostics:parsed.diagnostics});
 const setup=settings.needsSetup?{path:'runlist.records.json',source:JSON.stringify({schema:1,repositoryId,root:settings.root,shared:false},null,2)+'\n'}:null;
 return {source,setup};
}
