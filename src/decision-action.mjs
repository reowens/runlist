import { parseDecisionItems, decisionSettings, dispositionOf } from './decisions.mjs';
import { SourceEditError } from './source-editor.mjs';

// A source preparation shared by the CLI and the app. The source editor owns
// authority, claims, revision checking, operation receipts, and publication.
export function prepareDecisionAction(source, request, settings = {}) {
  const {id,line,disposition,note,choice,actor,at}=request;
  const fail=message=>{throw new SourceEditError('decision-invalid-action',message);};
  if(!['open','held','ruled','closed'].includes(disposition))fail('Choose open, held, ruled or closed.');
  if(!actor?.id||!['human','agent'].includes(actor.kind))fail('A verified actor is required.');
  if(disposition==='ruled'&&actor.kind!=='human')fail('A ruling must be recorded by a human; an agent can keep a recommendation in the source.');
  if(typeof note!=='string'||!note.trim()||note.length>4000)fail('Give a reason, up to 4,000 characters.');
  if(disposition==='ruled'&&(typeof choice!=='string'||!choice.trim()))fail('Write the selected answer before recording a ruling.');
  if(typeof at!=='string'||Number.isNaN(Date.parse(at)))fail('A recording timestamp is required.');
  const settingsResolved=decisionSettings(settings??{}),items=parseDecisionItems(source,settingsResolved);
  const item=items.find(item=>item.id===id&&item.line===line);
  if(!item)throw new SourceEditError('decision-revision-conflict','This decision moved or changed. Reload its record before recording an outcome.');
  const one=value=>String(value??'').replace(/[\r\n]+/g,' ').replace(/[<>|]/g,c=>({'<':'&lt;','>':'&gt;','|':'&#124;'}[c]));
  // Inline provenance follows the newest explicit disposition. Earlier source
  // and earlier outcomes remain verbatim, behind it, in the same record.
  const outcome=`Disposition: ${disposition.toUpperCase()} ${at}. Recorded by ${one(actor.label??actor.id)} (${one(actor.kind)}). ${disposition==='ruled'?`Selected answer: ${one(choice)}. `:''}Reason: ${one(note)}.`;
  const lines=source.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g).filter(Boolean),index=line-1;
  const original=lines[index],eol=original.match(/\r\n|\n|\r$/)?.[0]??'\n';
  if(item.kind==='heading'){if(!/[\r\n]$/.test(original))lines[index]+=eol;lines.splice(index+1,0,`${outcome}${eol}`);}
  else {
    // Keep a one-line record one line, including register/table rows.
    const escaped=id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const match=item.kind==='table'?original.match(/^(\|\s*\**[^|]+\**\s*\|\s*)/):item.kind==='register'?original.match(/^(\S+\s{1,3})/):original.match(new RegExp(`^((?:[-*]\\s+(?:\\[[ xX]\\]\\s+)?)?\\**${escaped}\\**[\\s,.:—-]+)`));
    if(!match)fail('This record cannot be updated unambiguously. Open its source to edit it.');
    lines[index]=original.slice(0,match[0].length)+'**Recorded outcome:** '+outcome+' **Original record:** '+original.slice(match[0].length);
  }
  const next=lines.join(''),after=parseDecisionItems(next,settingsResolved).find(i=>i.id===id&&i.line===line);
  if(!after||dispositionOf(after,settingsResolved)!==disposition)fail('The updated record no longer parses. Its source was left unchanged.');
  return next;
}

export async function runDecisionAction(argv,config,{dryRun=false,env=process.env}={}) {
  const [{createSourceEditor},{resolveDocArg},{hostSessionSource},{randomUUID,createHash},{default:os},{default:path}]=await Promise.all([import('./source-editor.mjs'),import('./index.mjs'),import('./util.mjs'),import('node:crypto'),import('node:os'),import('node:path')]);
  const positional=[],options={};
  for(let i=0;i<argv.length;i++){if(argv[i].startsWith('--')){if(argv[i]==='--json')options.json=true;else options[argv[i].slice(2)]=argv[++i];}else positional.push(argv[i]);}
  const [input,id]=positional;
  if(!input||!id||!options.disposition||!options.note)throw new SourceEditError('decision-invalid-action','Use runlist decision <file> <id> --disposition open|held|ruled|closed --note <reason> [--choice <answer>].');
  const file=resolveDocArg(input,config),session=hostSessionSource(env),agent=session?.scope==='session';
  if(session?.scope==='process')throw new SourceEditError('decision-invalid-actor','An agent needs a session-scoped identity before recording an outcome.');
  const actor=agent?{kind:'agent',id:session.id,session_id:session.id,label:session.host??session.id}:{kind:'human',id:`human:local:${createHash('sha256').update(`${os.userInfo().username}:${os.userInfo().uid}`).digest('hex').slice(0,24)}`,label:os.userInfo().username};
  const editor=createSourceEditor({config,legacyTypes:[...(config.validTypes??['plan','doc'])].filter(t=>t!=='prompt'),authenticate:()=>actor,authorize:({path:target})=>({allowed:target===file&&!path.relative(config.repoRoot,target).split(path.sep).some(p=>p==='prompts'||p==='.git'||config.excludeDirs?.has(p)),...(agent?{grant_id:`cli:decision:${actor.session_id}:${path.relative(config.repoRoot,file)}`}:{})})});
  const current=editor.read(null,{path:file});
  if(['flag','decision'].includes(current.type))throw new SourceEditError('record-read-only','Native flag and decision records require their domain writer; this command records outcomes in existing plan/register sections.');
  const items=parseDecisionItems(current.source,decisionSettings(config.raw?.decisions??{}));
  const matches=items.filter(item=>item.id===id);
  if(matches.length!==1)throw new SourceEditError('decision-invalid-action','The source must contain exactly one decision with this ID.');
  if(!current.editable)throw new SourceEditError('record-read-only','This source does not support managed decision actions.');
  if(options['expected-revision']&&options['expected-revision']!==current.revision)throw new SourceEditError('decision-revision-conflict','The source changed; read the decision again before recording an outcome.');
  const source=prepareDecisionAction(current.source,{id,line:matches[0].line,disposition:options.disposition,note:options.note,choice:options.choice,actor,at:new Date().toISOString()},config.raw?.decisions);
  if(dryRun){process.stdout.write(source);return {dryRun:true,source};}
  const outcome=editor.save(null,{path:file,source,expectedRevision:current.revision,operationId:randomUUID()});
  process.stdout.write(options.json?JSON.stringify(outcome)+'\n':`${id}: ${options.disposition} recorded in ${path.relative(config.repoRoot,file)}.\n`);return outcome;
}
