import {createAppLifecycle} from './app-lifecycle.mjs';
import {createAppDocuments} from './app-create.mjs';
import {searchCheckout} from './app-search.mjs';
import {createAppSemanticSearch} from './app-semantic-search.mjs';
import {resolveStatusMetadata} from './status-metadata.mjs';
import {prepareNativeAction} from './native-action.mjs';
import { createRecordLibrary } from './app-records.mjs';
import { prepareDecisionAction } from './decision-action.mjs';
import { createDocumentLibrary, libraryKind } from './app-library.mjs';
import { createAppGit } from './app-git.mjs';
import { createAppGitCommits } from './app-git-commits.mjs';
import { appTemplates } from './new.mjs';
import { saveTemplate } from './template-store.mjs';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSourceEditor, SourceEditError, sourceRevision } from './source-editor.mjs';
import { authorizeManagedSource } from './managed-path.mjs';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { deriveFlags, flagsFile, readFlagEvents, triageFlag } from './flags.mjs';
import { readPlanOwnership, ownershipLiveness } from './pickup.mjs';
import { normalizeEol } from './frontmatter.mjs';
import { extractFirstHeading } from './extractors.mjs';

export const localActor = () => ({ kind: 'human', id: `human:local:${createHash('sha256').update(`${os.userInfo().username}:${os.userInfo().uid}`).digest('hex').slice(0, 24)}`, label: os.userInfo().username });
function problem(code, message) { throw new SourceEditError(code, message); }
function relative(filePath, config) { return path.relative(config.repoRoot, filePath).split(path.sep).join('/'); }
function contained(root, filePath) { const rel = path.relative(root, filePath); return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); }

function evidenceFor(source, documentPath, config) {
  const flags = deriveFlags(readFlagEvents(flagsFile(config))).filter(flag => {
    if (typeof flag.file !== 'string') return false;
    const id = typeof flag.id === 'string' ? flag.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
    return flag.file === documentPath || (flag.file && source.includes(flag.file)) || (id && new RegExp(`(?<![A-Za-z0-9])${id}(?![A-Za-z0-9])`).test(source));
  }).slice(-6).reverse();
  return flags.map(flag=>flagEvidence(flag,config));
}
function flagEvidence(flag,config) {
    let current = { status: 'unavailable', revision: null, line: null, quote: null };
    const candidate = path.resolve(config.repoRoot, flag.file), ext = path.extname(candidate).toLowerCase();
    // Evidence reads are bounded to this checkout and known document/code
    // types. No arbitrary-file endpoint, prompts, env files, or Git internals.
    if (contained(config.repoRoot, candidate) && !flag.file.split(/[\\/]/).some(p => ['prompts', '.git', 'node_modules'].includes(p)||config.excludeDirs?.has(p))
      && /^(?:\.md|\.mjs|\.cjs|\.js|\.ts|\.tsx|\.jsx|\.py|\.swift|\.rs|\.go|\.sql|\.sh|\.css)$/.test(ext)) {
      try {
        if (lstatSync(candidate).isSymbolicLink() || !contained(realpathSync(config.repoRoot), realpathSync(candidate)) || statSync(candidate).size > 1024 * 1024) throw new Error('unsafe');
        const raw = readFileSync(candidate, 'utf8'), lines = normalizeEol(raw).split('\n');
        const at = Number.isInteger(flag.line) ? flag.line - 1 : null;
        const quote = at !== null ? lines[at]?.trim().slice(0, 200) ?? null : null;
        const matches = flag.quote ? lines.flatMap((line, i) => line.trim().slice(0, 200) === flag.quote ? [i + 1] : []) : [];
        const status = at === null ? 'file' : quote === flag.quote ? 'unchanged' : matches.length === 1 ? 'moved' : matches.length > 1 ? 'ambiguous' : 'changed';
        const line = status === 'moved' ? matches[0] : flag.line ?? null;
        current = { status, revision: sourceRevision(raw), line, quote: line ? lines[line - 1]?.trim().slice(0, 200) ?? null : null };
      } catch { /* Original evidence survives missing or unsafe current files. */ }
    }
    return { id: flag.id, text: flag.text, severity: flag.severity, state: flag.state, triage: flag.triage, original: { file: flag.file, line: flag.line, quote: flag.quote, at: flag.at, by: flag.by, revision: null, revisionReason: 'The legacy flag did not record an observed revision.' }, current };
}

/** Shared checkout operations. Transport adapters supply their own trusted actor. */
export function createCheckoutService({config,initialPath=null,actor=localActor(),authenticate=()=>actor,semanticOptions={}}) {
  if (actor.kind !== 'human' || !actor.id) problem('unauthenticated', 'A locally identified human is required.');
  const library = createDocumentLibrary(config);
  const semantic=createAppSemanticSearch({config,library,...semanticOptions});
  const git = createAppGit({config,actor,authenticate,library});
  const gitCommits = createAppGitCommits({config,actor,authenticate,git});
  const editor = createSourceEditor({ config, domainPrepare:prepareNativeAction, legacyTypes:[...(config.validTypes ?? ['plan','doc'])].filter(t=>t!=='prompt'),allowUnconfiguredRead:true, authenticate: req => authenticate(req), authorize: ({ actor: candidate, path: filePath }) => ({ allowed: candidate.kind === 'human' && candidate.id === actor.id && !path.relative(config.repoRoot,filePath).split(path.sep).some(p=>p==='prompts'||p==='.git'||config.excludeDirs?.has(p)) && filePath!==config.indexPath && (config.docsRoots ?? [config.docsRoot]).some(root => contained(path.resolve(root), filePath)) }) });
  function openDocument(req, documentPath) {
    const opened = editor.read(req, { path: documentPath });
    const fm = parseSimpleFrontmatter(extractFrontmatter(opened.source).frontmatter);
    const repoPath = relative(opened.path, config), ownership = readPlanOwnership(repoPath, config);
    return { ...opened, path: repoPath, title: (fm.record_schema==='runlist.record/v1'&&(fm.finding||fm.question)) || fm.title || extractFirstHeading(extractFrontmatter(opened.source).body) || path.basename(opened.path, '.md'), status: fm.status, type:fm.type??'untyped',kind:libraryKind(fm,repoPath),relationships:library.relations(repoPath,fm,extractFrontmatter(opened.source).body),metadata: fm, claim: ownership ? { corrupt: ownership.corrupt, state: ownership.state, sessionId: ownership.sessionId, liveness: ownershipLiveness(ownership) } : null, flags: evidenceFor(opened.source, repoPath, config) };
  }
  const records=createRecordLibrary({config,library,readSource:(req,path)=>editor.read(req,{path}),evidence:flag=>flagEvidence(flag,config)});
  const lifecycle=createAppLifecycle({config,read:openDocument,actor:req=>authenticate(req)});
  const creation=createAppDocuments({config,actor:req=>authenticate(req),library});
  async function request(req, route, body) {
    if (typeof route !== 'string' || !route.startsWith('/api/')) problem('invalid-request','Choose a supported checkout operation.');
    const url = new URL(route, 'http://checkout.invalid');
    const authenticated = {actor:authenticate(req)};
    if (req.method === 'GET' && url.pathname === '/api/git/status') return git.status(req,url.searchParams);
    if (req.method === 'GET' && url.pathname === '/api/git/diff') return git.diff(req,url.searchParams);
    if (req.method === 'GET' && url.pathname === '/api/git/operation') return gitCommits.inspect(req,url.searchParams.get('id'));
    const send = (_status, value) => { if (_status === 404) problem('not-found',value.message); return value; };
      if (req.method === 'GET' && url.pathname === '/api/templates') return send(200, appTemplates(config));
      if(req.method==='GET'&&url.pathname==='/api/create')return creation.options();
      if(url.pathname.startsWith('/api/semantic/')){
        if(authenticated.actor?.kind!=='human'||authenticated.actor.id!==actor.id)problem('forbidden','This local checkout authority is required.');
        if(req.method==='GET'&&url.pathname==='/api/semantic/settings')return semantic.settings();
        if(req.method==='GET'&&url.pathname==='/api/semantic/result')return semantic.inspect(url.searchParams.get('id'));
        if(req.method==='POST'){if(!body||typeof body!=='object'||Array.isArray(body))problem('invalid-request','Use a JSON object.');
          if(url.pathname==='/api/semantic/settings')return semantic.saveSettings(body);
          if(url.pathname==='/api/semantic/start')return semantic.start(body);
          if(url.pathname==='/api/semantic/cancel'){if(Object.keys(body).some(k=>k!=='id')||typeof body.id!=='string')problem('invalid-request','Choose a semantic request.');return semantic.cancel(body.id);}
        }
      }
      if(req.method==='GET'&&url.pathname==='/api/search')return searchCheckout(config,library,url.searchParams);
      if(req.method==='GET'&&url.pathname==='/api/recovery'){
        const target=url.searchParams.get('path'),groups=[editor.listRecovery(req,{path:target}),...(target?[]:[creation.list(req),lifecycle.list(req),gitCommits.list(req)])];
        const items=groups.flatMap(group=>group.items).map(item=>({...item,path:path.isAbsolute(item.path)?relative(item.path,config):item.path})).sort((a,b)=>String(b.at).localeCompare(String(a.at)));
        const offset=Math.max(0,Math.floor(Number(url.searchParams.get('offset'))||0)),limit=Math.max(1,Math.min(200,Math.floor(Number(url.searchParams.get('limit'))||50)));
        return {items:items.slice(offset,offset+limit),total:items.length,offset,limit,hasMore:offset+limit<items.length,unavailable:groups.reduce((n,g)=>n+g.unavailable,0)};
      }
      if (req.method === 'GET' && ['/api/library','/api/plans'].includes(url.pathname)) { const params=new URLSearchParams(url.searchParams); if(url.pathname==='/api/plans'&&!params.has('kind'))params.set('kind','plans'); const metadata=new URLSearchParams(params);if(params.get('content')==='1')metadata.delete('q');let result=await library.query(metadata);if(params.get('content')==='1'&&params.get('q')?.trim())result={...result,...await searchCheckout(config,library,params)}; return send(200,{checkout:path.basename(config.repoRoot),checkoutPath:config.repoRoot,...result,plans:result.documents,initialPath}); }
      if (req.method === 'GET' && url.pathname === '/api/document') { await library.refresh(); return send(200,openDocument(req,url.searchParams.get('path'))); }
      if (req.method === 'GET' && url.pathname === '/api/link') { await library.refresh(); return send(200,library.resolve(url.searchParams.get('ref'),url.searchParams.get('from')??'')); }
      if(req.method==='GET'&&url.pathname==='/api/settings')return send(200,{checkout:path.basename(config.repoRoot),roots:(config.docsRoots??[config.docsRoot]).map(root=>relative(root,config)),exclusions:[...config.excludeDirs],statuses:resolveStatusMetadata(config),configFile:config.configPath?relative(config.configPath,config):null,sharing:{records:'Markdown in this checkout; share through Git',preferences:'This browser',drafts:'Private local editor state',templates:'runlist.templates.json'}});
      if(req.method==='GET'&&url.pathname==='/api/lifecycle')return send(200,lifecycle.information(req,url.searchParams.get('path')));
      if(req.method==='GET'&&url.pathname==='/api/records'){
        const kind=url.searchParams.get('kind');if(!['flags','decisions'].includes(kind))problem('invalid-request','Choose flags or decisions.');
        return send(200,url.searchParams.has('key')?await records.detail(req,kind,url.searchParams.get('key')):await records.query(req,kind,url.searchParams));
      }
      if (req.method === 'POST') {
        if (!body || typeof body !== 'object' || Array.isArray(body)) problem('invalid-request','Use a JSON object.');
        if(['actor','checkout','repoRoot'].some(key=>key in body))problem('forbidden','Identity and checkout authority belong to the local application.');
        if(url.pathname==='/api/git/commit/preview')return gitCommits.preview(req,body);
        if(url.pathname==='/api/git/commit/start')return gitCommits.start(req,body);
        if(url.pathname==='/api/git/operation/inspect')return gitCommits.inspectJob(req,body);
        if(url.pathname==='/api/git/operation/recover')return gitCommits.recover(req,body);
        if(url.pathname==='/api/git/operation/settle')return gitCommits.settle(req,body);
        if(url.pathname==='/api/git/operation/cancel')return gitCommits.cancel(req,body);
        if(url.pathname==='/api/create/preview')return creation.preview(req,body);
        if(url.pathname==='/api/create/inspect')return creation.inspect(req,body);
        if(url.pathname==='/api/create/discard')return creation.discard(req,body);
        if(url.pathname==='/api/create/commit'){const result=creation.commit(req,body);library.invalidate();records.invalidate();return result;}
        if(url.pathname==='/api/lifecycle/preview')return send(200,await lifecycle.preview(req,body));
        if(url.pathname==='/api/lifecycle/commit'){const result=await lifecycle.commit(req,body);library.invalidate();records.invalidate();return send(200,result);}
        if(url.pathname==='/api/lifecycle/inspect')return send(200,lifecycle.inspect(req,body));
        if(url.pathname==='/api/lifecycle/settle')return send(200,lifecycle.settle(req,body));
        if(url.pathname==='/api/native/preview'){
          const opened=editor.read(req,{path:body.path});
          const claim=readPlanOwnership(relative(opened.path,config),config);
          if(claim?.corrupt||claim?.state==='owned')problem('claim-conflict','This record is claimed or its ownership needs repair through the CLI.');
          if(opened.revision!==body.expectedRevision)problem('revision-conflict','The record changed. Reload and review it again.');
          const request={path:relative(opened.path,config),operationId:body.operationId,expectedRevision:opened.revision,action:body.action,note:body.note,optionId:body.optionId,at:new Date().toISOString()};
          request.source=prepareNativeAction(opened.source,request,authenticated.actor);
          return send(200,{request,before:opened.source});
        }
        if(url.pathname==='/api/native/action'){const result=editor.nativeAction(req,body);library.invalidate(body.path);records.invalidate();return send(200,result);}
        if(url.pathname==='/api/flags/triage'){
          const selected=await records.detail(req,'flags',body.key);
          if(selected.native)problem('record-read-only','Use the native record action for this record.');
          if(!/^sha256:[a-f0-9]{64}$/.test(body.expectedRevision??'')||!body.operationId)problem('invalid-request','Review the current flag and supply its revision and operation ID.');
          if(typeof body.note!=='string'||!body.note.trim()||body.note.length>4000)problem('invalid-request','Give a reason, up to 4,000 characters.');
          const human=authenticated.actor;
          const outcome=triageFlag(config,{id:selected.id,event:body.action,note:body.note,expectedRevision:body.expectedRevision,operationId:body.operationId,by:{kind:'person',name:human.label??human.id,id:human.id}});
          records.invalidate();return send(200,{...outcome,actor:human});
        }
        if(url.pathname==='/api/decisions/preview'){
          const selected=await records.detail(req,'decisions',body.key);
          if(!selected.editable||selected.native)problem('record-read-only','Open this record’s source to edit it.');
          if(selected.revision!==body.expectedRevision)problem('decision-revision-conflict','The source changed. Reload the decision and review it again.');
          const source=prepareDecisionAction(selected.source,{...body,id:selected.id,line:selected.line,actor:authenticated.actor,at:new Date().toISOString()},config.raw?.decisions);
          return send(200,{path:selected.path,source,before:selected.source,expectedRevision:selected.revision});
        }
        if (url.pathname === '/api/templates/save') { saveTemplate(config,body); return send(200,appTemplates(config)); }
        if (!['/api/save','/api/undo','/api/draft/read','/api/draft/write','/api/draft/discard','/api/operation/inspect','/api/operation/settle'].includes(url.pathname)) return send(404, { code:'not-found', message:'No such operation.' });
        if (url.pathname.startsWith('/api/operation/')) {
          const retained = editor.inspectOperation(req, body);
          const current = retained ? openDocument(req, retained.path) : null;
          if (url.pathname.endsWith('settle')) return send(200, editor.settleOperation(req, body));
          return send(200, retained ? { ...retained, currentSource:current.source, currentRevision:current.revision } : null);
        }
        // Save/undo/draft writes validate current source under their own
        // guards. Draft reads without retained state and discard also need a
        // stable source read, but none needs a second rendered document and
        // related evidence before the guarded operation.
        if(['/api/draft/read','/api/draft/discard'].includes(url.pathname))editor.read(req,{path:body.path});
        const methods = { '/api/save':'save', '/api/undo':'undo', '/api/draft/read':'readDraft', '/api/draft/write':'putDraft', '/api/draft/discard':'discardDraft' };
        const result = editor[methods[url.pathname]](req, body);
        if(['/api/save','/api/undo'].includes(url.pathname)){library.invalidate(body.path);records.invalidate();}
        return send(200, result);
      }
      problem('not-found','No such checkout operation.');
  }
  return {request,close:()=>semantic.close()};
}
export function appError(error) {
  const code=error.code || 'request-failed';
  return {code,message:error instanceof SourceEditError || /template|flag-|decision-/.test(code) ? error.message : 'The operation failed. Check the selected checkout.',details:error.details ?? {}};
}
