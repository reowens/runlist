import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import {createSourceEditor,SourceEditError} from './source-editor.mjs';import {hostSessionSource} from './util.mjs';
export function cliEditor(config,file,{env=process.env,domainPrepare=null}={}) {
  const session=hostSessionSource(env),agent=session?.scope==='session';
  if(session?.scope==='process')throw new SourceEditError('invalid-actor','An agent needs a session-scoped identity before recording an action.');
  const actor=agent?{kind:'agent',id:session.id,session_id:session.id,label:session.host??session.id}:{kind:'human',id:`human:local:${createHash('sha256').update(`${os.userInfo().username}:${os.userInfo().uid}`).digest('hex').slice(0,24)}`,label:os.userInfo().username};
  const editor=createSourceEditor({config,domainPrepare,legacyTypes:[...(config.validTypes??['plan','doc'])].filter(t=>t!=='prompt'),authenticate:()=>actor,authorize:({path:target})=>({allowed:target===file&&!path.relative(config.repoRoot,target).split(path.sep).some(p=>p==='prompts'||p==='.git'||config.excludeDirs?.has(p)),...(agent?{grant_id:`cli:record:${actor.session_id}:${path.relative(config.repoRoot,file)}`}:{})})});return {actor,editor};
}
