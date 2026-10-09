import {randomUUID} from 'node:crypto';import path from 'node:path';
import {prepareNativeAction} from './native-action.mjs';import {cliEditor} from './cli-editor.mjs';import {resolveDocArg} from './index.mjs';import {SourceEditError} from './source-editor.mjs';
export function runRecordAction(argv,config,{dryRun=false,env=process.env}={}){
 const args=[],opts={};for(let i=0;i<argv.length;i++){if(argv[i]==='--json')opts.json=true;else if(argv[i].startsWith('--'))opts[argv[i].slice(2)]=argv[++i];else args.push(argv[i]);}
 const [input,action]=args;if(!input||!action||!opts.note)throw new SourceEditError('native-invalid-action','Use runlist record <file> <action> --note <reason> [--option <option-id>].');
 const file=resolveDocArg(input,config),{editor,actor}=cliEditor(config,file,{env,domainPrepare:prepareNativeAction}),before=editor.read(null,{path:file});
 if(opts['expected-revision']&&opts['expected-revision']!==before.revision)throw new SourceEditError('revision-conflict','The record changed. Read it before recording an action.');
 const request={path:file,operationId:randomUUID(),action,note:opts.note,optionId:opts.option,at:new Date().toISOString(),expectedRevision:before.revision};request.source=prepareNativeAction(before.source,request,actor);
 if(dryRun){process.stdout.write(request.source);return {dryRun:true};}
 const result=editor.nativeAction(null,request);process.stdout.write(opts.json?JSON.stringify(result)+'\n':`${path.relative(config.repoRoot,file)}: ${action} recorded.\n`);return result;
}
