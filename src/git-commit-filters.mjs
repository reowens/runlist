// Qualify one-shot clean drivers without executing them. Git retains its own
// required/optional failure semantics; arbitrary shell and process drivers stay gated.
import {existsSync,readFileSync,realpathSync} from 'node:fs';
import path from 'node:path';
import {hash,fail,safeFile} from './git-commit-store.mjs';
const unsupported=()=>fail('git-filter-unsupported','This clean filter needs separate qualification. Use a one-shot executable with literal arguments; process filters, shell expressions and working-tree encoding require Git.');
function words(command){
 if(command.length>8192||/[\x00-\x1f\x7f$`;&|<>()\\]/.test(command))unsupported();
 const result=[];let word='',quote=null,started=false;
 for(const c of command){if(quote){if(c===quote)quote=null;else word+=c;started=true;}else if(c==='"'||c==="'"){quote=c;started=true;}else if('*?[]~#{}!'.includes(c))unsupported();else if(/\s/.test(c)){if(started){result.push(word);word='';started=false;}}else{word+=c;started=true;}}
 if(quote)unsupported();if(started)result.push(word);
 if(!result[0]||result.length>64||result.some(w=>w.includes('%')&&w!=='%f')||result.slice(1).some(w=>['-c','-e','--eval','--command'].includes(w)))unsupported();
 return result;
}
function generation(file){const st=safeFile(file,16*1024*1024);return {file,hash:hash(readFileSync(file)),mode:st.mode&0o777};}
export function filterProfiles(r,run,environment){
 const attrs=run(r,['check-attr','-z','--stdin','filter','working-tree-encoding'],{input:Buffer.from(r.paths.join('\0')+'\0')}).bytes.toString('utf8').split('\0'),names=new Set();
 for(let i=0;i+2<attrs.length;i+=3){const [,attr,value]=attrs.slice(i,i+3);if(['unspecified','unset'].includes(value))continue;if(attr==='working-tree-encoding')unsupported();if(attr==='filter'&&value!=='set')names.add(value);}
 const result=[];
 for(const name of [...names].sort()){
  const get=key=>{const p=run(r,['config','--get',`filter.${name}.${key}`],{allow:[0,1]});return p.code===0?p.text():'';};
  if(get('process'))unsupported();const command=get('clean');if(!command)continue;
  const argv=words(command);if(!argv[0].includes('/')&&new Set(['.',':','alias','bg','break','cd','command','continue','declare','echo','eval','exec','exit','export','fc','fg','getopts','hash','jobs','kill','local','printf','pwd','read','readonly','return','set','shift','test','time','times','trap','type','typeset','ulimit','umask','unalias','unset','wait','true','false']).has(argv[0]))unsupported();
  const candidate=argv[0].includes('/')?path.resolve(r.root,argv[0]):(environment.PATH??'').split(path.delimiter).map(dir=>path.join(dir,argv[0])).find(file=>{try{return !!(safeFile(realpathSync(file)).mode&0o111);}catch{return false;}});
  if(!candidate||!existsSync(candidate))unsupported();const executable=generation(realpathSync(candidate));if(!(executable.mode&0o111))unsupported();
  // Bind literal file arguments (e.g. an interpreter's script) too. Indirect
  // dependencies are trusted checkout code, like dependencies of commit hooks.
  const files={};for(const arg of argv.slice(1)){if(arg==='%f'||arg.startsWith('-')||!arg)continue;const file=path.resolve(r.root,arg);if(existsSync(file))files[file]=generation(realpathSync(file));else if(arg.includes('/'))files[file]=null;}
  result.push({name,command,executable,files});
 }
 return result;
}
