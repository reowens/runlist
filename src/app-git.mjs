// Read-only checkout Git operations. Commit execution has a separate feasibility gate.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { authorizeManagedSource, authorizeManagedDestination } from './managed-path.mjs';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { SourceEditError } from './source-editor.mjs';
import { localCommitSupport } from './git-commit-support.mjs';

const MAX_OUTPUT=16*1024*1024, MAX_FILE=8*1024*1024, MAX_DIFF=1024*1024, MAX_LINES=20_000;
const fail=(code,message)=>{throw new SourceEditError(code,message);};
const decoder=new TextDecoder('utf-8',{fatal:true});
const decode=bytes=>{try{return decoder.decode(bytes);}catch{fail('git-encoding','This Git output is not valid UTF-8. Review it with Git.');}};
const inside=(root,file)=>{const rel=path.relative(root,file);return rel!== '..'&&!rel.startsWith(`..${path.sep}`)&&!path.isAbsolute(rel);};

export function parseGitChanges(bytes) {
  const fields=decode(bytes).split('\0'),rows=[];
  for(let i=0;i<fields.length;i++) {
    const field=fields[i];if(!field)continue;
    const type=field[0];
    if(type==='?'||type==='!'){rows.push({path:field.slice(2),xy:type==='?'?'??':'!!',kind:type==='?'?'Added':'Local only',ignored:type==='!'});continue;}
    const parts=field.split(' '),count=type==='1'?8:type==='2'?9:type==='u'?10:0;
    if(!count||parts.length<=count)fail('git-output','Git returned an unsupported change record.');
    const file=parts.slice(count).join(' '),xy=parts[1],original=type==='2'?fields[++i]:null;
    if(type==='2'&&!original)fail('git-output','Git returned an incomplete rename.');
    const kind=type==='u'?'Conflicted':type==='2'?'Renamed':xy.includes('D')?'Deleted':xy.includes('A')?'Added':'Modified';
    rows.push({path:file,original,xy,kind,conflict:type==='u',partial:xy[0]!=='.'&&xy[1]!=='.',staged:xy[0]!=='.',indexMode:parts[4],headMode:parts[3]});
  }
  return rows;
}

export function gitEnvironment() {
  const result={};
  for(const key of ['HOME','USER','LOGNAME','TMPDIR','USERPROFILE','USERNAME','HOMEDRIVE','HOMEPATH','APPDATA','LOCALAPPDATA','ProgramData','SystemRoot','WINDIR','TEMP','TMP','XDG_CONFIG_HOME','GNUPGHOME'])if(process.env[key])result[key]=process.env[key];
  result.PATH=(process.env.PATH??'').split(path.delimiter).filter(value=>path.isAbsolute(value)).join(path.delimiter);
  return {...result,LANG:'C',LC_ALL:'C',GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0',GIT_NO_LAZY_FETCH:'1'};
}

// Fixed commands only; the renderer never chooses a binary, argument or cwd.
function runner(config,deadline) {
  return (args,{allow=[0],input,max=MAX_OUTPUT,configOverrides=[]}={})=>new Promise((resolve,reject)=>{
    const remaining=deadline-Date.now();if(remaining<=0){reject(new SourceEditError('git-timeout','Git inspection timed out. Narrow the checkout or try Refresh.'));return;}
    const child=spawn('git',['--no-optional-locks','--literal-pathspecs','-c','core.fsmonitor=false','-c','core.untrackedCache=false',...configOverrides.flatMap(v=>['-c',v]),...args],{cwd:config.repoRoot,env:gitEnvironment(),windowsHide:true,stdio:['pipe','pipe','pipe']});
    const output=[],errors=[];let size=0,errorSize=0,failed=false;
    const stop=(code,message)=>{if(failed)return;failed=true;child.kill('SIGKILL');reject(new SourceEditError(code,message));};
    const timer=setTimeout(()=>stop('git-timeout','Git inspection timed out. Try Refresh.'),remaining);
    child.on('error',error=>{clearTimeout(timer);stop(error.code==='ENOENT'?'git-missing':'git-unavailable','Git is unavailable. Document editing is still available.');});
    child.stdout.on('data',chunk=>{size+=chunk.length;if(size>max)stop('git-limit','Git output exceeds the review limit. Review this checkout with Git.');else output.push(chunk);});
    child.stderr.on('data',chunk=>{errorSize+=chunk.length;if(errorSize>64*1024)stop('git-limit','Git diagnostics exceed the review limit.');else errors.push(chunk);});
    child.stdin.on('error',()=>{});child.stdin.end(input);
    child.on('close',code=>{clearTimeout(timer);if(failed)return;if(!allow.includes(code)){reject(new SourceEditError('git-unavailable','Git could not inspect this checkout. Review its state with Git and try Refresh.'));return;}resolve({code,bytes:Buffer.concat(output),text:()=>decode(Buffer.concat(output)).trim()});});
  });
}

export function createAppGit({config,actor,authenticate,library}) {
  let active=0;
  function identity(req) {const user=authenticate(req);if(user?.kind!=='human'||user.id!==actor.id)fail('forbidden','Git inspection belongs to the authenticated checkout owner.');}
  function scope(input,{disk=true}={}) {
    if(typeof input!=='string'||!input||input.includes('\0')||input.includes('\\')||path.posix.isAbsolute(input)||path.posix.normalize(input)!==input||input.split('/').includes('..'))fail('forbidden','Choose a document in this checkout.');
    const file=path.resolve(config.repoRoot,input),parts=input.split('/');
    if(!input.endsWith('.md')||!inside(config.repoRoot,file)||file===config.indexPath||parts.some(p=>['.git','.runlist','.dotmd','prompts','drafts','receipts','before-images','credentials'].includes(p)||config.excludeDirs?.has(p)))fail('forbidden','Private or excluded files are unavailable in Changes.');
    const roots=(config.docsRoots??[config.docsRoot]).filter(root=>inside(root,file)).sort((a,b)=>b.length-a.length);
    if(!roots.length)fail('forbidden','Choose a document in a configured document root.');
    const scoped={...config,docsRoots:[roots[0]],docsRoot:roots[0]};
    // Destination authorization also checks existing ancestors for deleted paths.
    try{if(disk)authorizeManagedDestination(file,scoped);}catch{fail('forbidden','This document escapes its configured root.');}
    return {file,scoped};
  }
  async function saved(input) {
    const {file,scoped}=scope(input);let stamp;
    try{stamp=await lstat(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}
    if(stamp.isSymbolicLink()||!stamp.isFile())fail('forbidden','Symlinks and non-document files are unavailable in Changes.');
    try{authorizeManagedSource(file,scoped);}catch{fail('forbidden','This document escapes its configured root.');}
    if(stamp.size>MAX_FILE)fail('git-file-limit','This file exceeds the 8 MiB review limit.');
    const fd=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
    try{const opened=await fd.stat();if(opened.dev!==stamp.dev||opened.ino!==stamp.ino||opened.size>MAX_FILE)fail('git-review-changed','The file changed. Refresh Changes.');const bytes=Buffer.alloc(opened.size+1);const {bytesRead}=await fd.read(bytes,0,bytes.length,0);const after=await fd.stat();if(bytesRead!==opened.size||after.size!==opened.size||after.mtimeMs!==opened.mtimeMs||after.ctimeMs!==opened.ctimeMs)fail('git-review-changed','The file changed while reading. Refresh Changes.');const source=decode(bytes.subarray(0,bytesRead));if(source.includes('\0'))fail('git-binary','This document is not reviewable text.');return source;}finally{await fd.close();}
  }
  const privateType=source=>parseSimpleFrontmatter(extractFrontmatter(source??'').frontmatter).type==='prompt';
  async function historical(git,head,input) {
    scope(input);if(!head)return null;
    const record=(await git(['ls-tree','-z',head,'--',input])).bytes;
    if(!record.length)return null;
    const entry=decode(record).split('\0')[0],match=entry.match(/^(100644|100755) blob ([a-f0-9]{40,64})\t/);
    if(!match)fail('forbidden','Symlinks and submodules are unavailable in Changes.');
    const length=Number((await git(['cat-file','-s',match[2]])).text());if(length>MAX_FILE)fail('git-file-limit','This historical file exceeds the review limit.');
    const source=decode((await git(['cat-file','blob',match[2]],{max:MAX_FILE})).bytes);
    if(source.includes('\0'))fail('git-binary','This document is not reviewable text.');if(privateType(source))fail('forbidden','Saved prompts are unavailable in Changes.');return source;
  }
  async function inspect(req,git,params) {
    identity(req);
    const top=await git(['rev-parse','--show-toplevel'],{allow:[0,128]});
    if(top.code!==0)return {available:false,reason:'This folder is not a Git checkout.',code:'not-git',rows:[]};
    const [a,b]=await Promise.all([stat(await realpath(top.text())),stat(await realpath(config.repoRoot))]);
    if(a.dev!==b.dev||a.ino!==b.ino)return {available:false,reason:'Open the Git checkout root to review its changes.',code:'git-root',rows:[]};
    const headResult=await git(['rev-parse','--verify','HEAD'],{allow:[0,128]}),head=headResult.code===0?headResult.text():null;
    const branchResult=await git(['symbolic-ref','--quiet','--short','HEAD'],{allow:[0,1]}),branch=branchResult.code===0?branchResult.text():null;
    // Listing and saved-source inspection never execute clean/process drivers.
    // Filtered candidates require the separate, explicit Git-tree commit review.
    const filterRecords=decode((await git(['config','--null','--get-regexp','^filter.*[.](clean|process)$'],{allow:[0,1]})).bytes).split('\0');
    const filters=new Set(filterRecords.flatMap(record=>{const at=record.indexOf('\n'),key=record.slice(0,at),value=record.slice(at+1);const name=key.match(/^filter[.](.*)[.](clean|process)$/)?.[1];return name&&value.trim()?[name]:[];}));
    const candidates=decode((await git(['ls-files','--cached','--others','--exclude-standard','-z'])).bytes).split('\0').filter(Boolean).filter(file=>{try{scope(file,{disk:false});return true;}catch{return false;}});
    await library.refresh(true);
    const catalog=await library.all(),metadata=new Map(catalog.map(doc=>[doc.path,doc]));
    const filteredCandidates=candidates;
    const attrs=filteredCandidates.length?decode((await git(['check-attr','-z','--stdin','filter','working-tree-encoding'],{input:Buffer.from(filteredCandidates.join('\0')+'\0')})).bytes).split('\0'):[];
    const filtered=new Set(),encoded=new Set();for(let i=0;i+2<attrs.length;i+=3){if(attrs[i+1]==='filter'&&filters.has(attrs[i+2]))filtered.add(attrs[i]);if(attrs[i+1]==='working-tree-encoding'&&!['unspecified','unset'].includes(attrs[i+2]))encoded.add(attrs[i]);}
    // This metadata scan can over-report filtered candidates. Eligibility and
    // exact filtered blobs are resolved by explicit private-index review.
    const configOverrides=[...filters].flatMap(name=>[`filter.${name}.clean=`,`filter.${name}.process=`,`filter.${name}.required=false`]);
    const raw=parseGitChanges((await git(['status','--porcelain=v2','-z','--untracked-files=all','--ignored=matching','--renames'],{configOverrides})).bytes);
    const reported=new Set(raw.map(row=>row.path));for(const file of filtered)if(!reported.has(file))raw.push({path:file,xy:'.M',kind:'Review required',staged:false,partial:false});
    const tracked=new Set(decode((await git(['ls-files','--cached','-z'])).bytes).split('\0'));
    let reason=!head?'Create the first commit with Git before reviewing local commits.':!branch?'This checkout has a detached HEAD. Choose a branch with Git.':null;
    for(const marker of ['MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','rebase-merge','rebase-apply']) {
      const file=(await git(['rev-parse','--git-path',marker])).text();try{await lstat(path.resolve(config.repoRoot,file));reason='Finish the current merge, rebase or cherry-pick with Git first.';}catch(error){if(error.code!=='ENOENT')throw error;}
    }
    const unrelatedStaged=raw.filter(row=>row.staged).filter(row=>{try{scope(row.path,{disk:false});if(row.original)scope(row.original,{disk:false});return false;}catch{return true;}}).length;
    const ignored=raw.filter(row=>row.ignored).map(row=>row.path),rows=[];
    for(const rawRow of raw.filter(row=>!row.ignored)) {
      try {
        scope(rawRow.path,{disk:false});if(rawRow.original)scope(rawRow.original);
        if(['120000','160000'].includes(rawRow.indexMode)||['120000','160000'].includes(rawRow.headMode))continue;
        const meta=metadata.get(rawRow.path);let fm={},archived=meta?.archived??false;
        if(!meta) {
          // An existing file absent from the freshly authorized library is
          // excluded or private. Only genuine deletions use historical scope.
          const file=path.resolve(config.repoRoot,rawRow.path);
          try{await lstat(file);continue;}catch(error){if(error.code!=='ENOENT')throw error;}
          const old=await historical(git,head,rawRow.original??rawRow.path);
          fm=parseSimpleFrontmatter(extractFrontmatter(old??'').frontmatter);
          archived=fm.status==='archived'||rawRow.path.split('/').includes(path.basename(config.archiveDir??'archived'));
        } else if(rawRow.original)await historical(git,head,rawRow.original);
        if(archived&&params.get('archived')!=='1')continue;
        const filterReviewRequired=filtered.has(rawRow.path)||filtered.has(rawRow.original);
        const blocked=reason??(encoded.has(rawRow.path)?'Working-tree encoding requires Git.':rawRow.conflict?'Resolve the conflict with Git.':rawRow.partial&&!filterReviewRequired?'Staged content differs from the saved file. Whole-file selection would replace partial staging.':meta?.bytes>MAX_FILE?'Exceeds the 8 MiB review limit.':null);
        rows.push({...meta,...rawRow,filterReviewRequired,title:String(meta?.title??fm.title??path.posix.basename(rawRow.path)).slice(0,300),archived,eligible:!blocked,blockedReason:blocked});
      }catch(error){if(error instanceof SourceEditError&&error.code==='forbidden')continue;throw error;}
    }
    // Git collapses ignored directories. Expand only freshly authorized
    // library metadata, never ignored private storage or document bodies.
    const visible=new Set(rows.map(row=>row.path));
    for(const doc of catalog)if(!tracked.has(doc.path)&&(params.get('archived')==='1'||!doc.archived)&&ignored.some(prefix=>doc.path===prefix||prefix.endsWith('/')&&doc.path.startsWith(prefix))&&!visible.has(doc.path)) {
      try{scope(doc.path,{disk:false});rows.push({...doc,kind:'Local only',ignored:true,eligible:false,blockedReason:'Ignored by Git. This document stays local.'});}catch{}
    }
    rows.sort((a,b)=>a.path.localeCompare(b.path));
    const finalHead=(await git(['rev-parse','--verify','HEAD'],{allow:[0,128]})).text(),finalBranch=(await git(['symbolic-ref','--quiet','--short','HEAD'],{allow:[0,1]})).text();
    if(finalHead!==(head??'')||finalBranch!==(branch??''))fail('git-review-changed','The branch changed during inspection. Refresh Changes.');
    const commitSupport=localCommitSupport((await git(['--version'])).text());
    identity(req);return {available:true,reason,branch,head,unrelatedStaged,rows,commitSupport,commitEnabled:false};
  }
  async function operation(req,fn) {identity(req);if(active>=2)fail('git-busy','Git inspection is already running. Try again when it finishes.');active++;try{return await fn(runner(config,Date.now()+10_000));}finally{active--;}}
  async function status(req,params=new URLSearchParams()) {return operation(req,async git=>{
    let result;try{result=await inspect(req,git,params);}catch(error){if(!['git-missing','git-unavailable','git-limit','git-timeout'].includes(error.code))throw error;return {available:false,code:error.code,reason:error.message,changes:[],total:0,commitEnabled:false};}
    const query=(params.get('q')??'').slice(0,500).toLowerCase(),matches=result.rows.filter(row=>`${row.title??''} ${row.path} ${row.original??''}`.toLowerCase().includes(query));
    const limit=100,requested=Math.max(0,Math.floor(Number(params.get('offset'))||0)),offset=Math.min(requested,Math.max(0,Math.floor((matches.length-1)/limit)*limit));
    const {rows,...info}=result;return {...info,changes:matches.slice(offset,offset+limit),total:matches.length,changedDocuments:rows.filter(r=>!r.ignored).length,localOnly:rows.filter(r=>r.ignored).length,offset,limit,hasMore:offset+limit<matches.length,commitEnabled:false};
  });}
  async function diff(req,params) {scope(params.get('path'));return operation(req,async git=>{
    const result=await inspect(req,git,params);if(!result.available)fail(result.code??'git-unavailable',result.reason);
    const row=result.rows.find(row=>row.path===params.get('path'));if(!row)fail('git-review-changed','This change is no longer available. Refresh Changes.');
    const before=await historical(git,result.head,row.original??row.path),after=await saved(row.path);if(privateType(after))fail('forbidden','Saved prompts are unavailable in Changes.');
    if(Buffer.byteLength(before??'')+Buffer.byteLength(after??'')>MAX_DIFF)fail('git-limit','This diff exceeds the inline review limit. Review it with Git.');
    for(const source of [before??'',after??'']){let count=1,at=-1;while((at=source.indexOf('\n',at+1))!==-1)if(++count>MAX_LINES)fail('git-limit','This diff has too many lines for inline review. Review it with Git.');}
    identity(req);return {change:row,branch:result.branch,head:result.head,before:before??'',after:after??'',basis:row.filterReviewRequired?'Saved Markdown against HEAD; commit review applies the clean filter':'Saved Markdown against HEAD',commitEnabled:false};
  });}
  async function selection(req,chosen) {return operation(req,async git=>{
    if(!Array.isArray(chosen)||!chosen.length||chosen.length>100||new Set(chosen).size!==chosen.length)fail('invalid-request','Select between 1 and 100 distinct saved documents.');
    const result=await inspect(req,git,new URLSearchParams({archived:'1'}));
    if(!result.available||result.reason)fail(result.code??'git-unavailable',result.reason);
    const rows=chosen.map(file=>{scope(file);const row=result.rows.find(row=>row.path===file);if(!row||!row.eligible)fail('git-review-changed',row?.blockedReason??'A selected document changed or is unavailable. Refresh Changes.');return row;});
    // Read/authorize both sides now, including historical private types.
    for(const row of rows)await historical(git,result.head,row.original??row.path);
    const paths=[...new Set(rows.flatMap(row=>row.original?[row.path,row.original]:[row.path]))],authorizedSources={};
    for(const file of paths){const source=await saved(file);if(privateType(source))fail('forbidden','Saved prompts are unavailable in Changes.');authorizedSources[file]=source===null?null:createHash('sha256').update(source).digest('hex');}
    identity(req);return {paths,authorizedSources,rows,head:result.head,branch:result.branch};
  });}
  return {status,diff,selection};
}
