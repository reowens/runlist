import {parseNativeRecord} from './native-record.mjs';
import {SourceEditError} from './source-editor.mjs';

const fail=(code,message)=>{throw new SourceEditError(code,message);};
export function prepareNativeAction(source,request,actor) {
  const parsed=parseNativeRecord(source);
  if(!parsed.ok||!['flag','decision'].includes(parsed.record?.type))fail('invalid-record','A valid native flag or decision is required. Repair its source before recording an action.');
  if(!actor?.id||!['human','agent'].includes(actor.kind))fail('unauthenticated','An authenticated human or agent is required.');
  const {action,note,operationId,at,optionId}=request;
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(operationId??''))fail('invalid-id','A UUID v4 operation is required.');
  if(typeof note!=='string'||!note.trim()||note.length>4000)fail('native-invalid-action','Give a reason, up to 4,000 characters.');
  if(typeof at!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(at)||!Number.isFinite(Date.parse(at)))fail('native-invalid-action','A valid recording timestamp is required.');
  const record=structuredClone(parsed.record),data=record.record_data,by=structuredClone(actor),reason=note.trim(),oldStatus=record.status;
  if(data.history.some(e=>e.id===`event:${operationId}`))fail('operation-reused','This operation is already in the record. Retry its retained request.');
  const event={id:`event:${operationId}`,kind:action,by,at,reason,from:oldStatus};
  if(record.type==='flag') {
    if(!['accept','reject','resolve','reopen'].includes(action))fail('native-invalid-action','Choose accept, reject, resolve or reopen.');
    if(action==='reopen' ? oldStatus==='open' : oldStatus!=='open')fail('native-state-conflict','The flag changed state. Reload it before reviewing an action.');
    if(action==='accept'||action==='reject'){
      event.previous_triage=structuredClone(data.triage);
      data.triage={...data.triage,disposition:action==='accept'?'accepted':'rejected',by,at,reason};record.status=action==='reject'?'rejected':'open';
    }else if(action==='resolve'){
      const resolution={id:`resolution:${operationId}`,by,at,method:'manual',reason,evidence_ids:[]};
      data.resolutions.push(resolution);data.active_resolution_id=resolution.id;record.status='resolved';event.resolution_id=resolution.id;
    }else{
      event.previous_triage=structuredClone(data.triage);event.previous_resolution_id=data.active_resolution_id??null;
      const {by:priorBy,at:priorAt,reason:priorReason,...extensions}=data.triage;
      data.triage={...extensions,disposition:'unreviewed'};delete data.active_resolution_id;record.status='open';
    }
  }else{
    if(!['held','ruled','closed','open'].includes(action))fail('native-invalid-action','Choose open, held, ruled or closed.');
    const superseded=new Set(data.rulings.map(r=>r.supersedes_ruling_id).filter(Boolean)),heads=data.rulings.filter(r=>!superseded.has(r.id));
    if(heads.length>1)fail('native-ruling-conflict','Competing rulings need an explicit reconciliation in the source.');
    const previous=heads[0];
    if(action==='ruled'||action==='closed'||previous?.kind==='select'){
      if(actor.kind!=='human')fail('native-authority-required','A human must record or withdraw a ruling. Agents can recommend an option separately.');
      if(action==='ruled'&&!data.options.some(o=>o.id===optionId))fail('native-invalid-option','Select an existing option.');
      const ruling={id:`ruling:${operationId}`,kind:action==='ruled'?'select':'withdraw',by,at,reason,authority:{basis:'human'},evidence_ids:[],...(action==='ruled'?{option_id:optionId}:{}),...(previous?{supersedes_ruling_id:previous.id}:{})};
      data.rulings.push(ruling);event.ruling_id=ruling.id;
      if(['ruled','closed'].includes(action))data.active_ruling_id=ruling.id;
    }
    if(!['ruled','closed'].includes(action))delete data.active_ruling_id;
    if(action==='held')data.hold={...data.hold,by,at,reason};else delete data.hold;
    record.status=action;
  }
  event.to=record.status;data.history.push(event);record.updated=at;
  // Replace only managed top-level lines and the literal JSON payload. Preserve
  // every other metadata byte, the body and its original line endings.
  const lines=source.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g).filter(Boolean),end=lines.findIndex((l,i)=>i>0&&/^---\s*$/.test(l.trim())),start=lines.findIndex((l,i)=>i>0&&i<end&&/^record_data: [|]/.test(l));
  if(start<0||end<0)fail('invalid-record','The record_data literal block is required.');
  let finish=start+1;while(finish<end&&(/^[ \t]/.test(lines[finish])||!lines[finish].trim()))finish++;
  const eol=lines[start].match(/\r\n|\n|\r$/)?.[0]??'\n';
  const payload=JSON.stringify(data,null,2).split('\n').map(line=>`  ${line}${eol}`);
  lines.splice(start+1,finish-start-1,...payload);
  for(const [field,value] of [['status',record.status],['updated',at]]){const i=lines.findIndex(l=>l.startsWith(`${field}:`));if(i<1)fail('invalid-record',`Missing ${field}.`);const ending=lines[i].match(/\r\n|\n|\r$/)?.[0]??'';lines[i]=`${field}: ${value}${ending}`;}
  const next=lines.join(''),after=parseNativeRecord(next);
  if(!after.ok)throw new SourceEditError('invalid-record','The action would violate the native record contract.',{diagnostics:after.diagnostics});
  return next;
}
