import path from 'node:path';
import { setImmediate as yieldThread } from 'node:timers/promises';
import { analyzeDecisionItems, blocksOf, decisionSettings, parseDecisionItems, pendingRows, dispositionOf, openWork } from './decisions.mjs';
import { deriveFlags, flagRevision, flagsFile, readFlagEvents } from './flags.mjs';
import { authorizeRepoGeneratedPath } from './managed-path.mjs';
import { parseNativeRecord } from './native-record.mjs';
import { readPlanOwnership } from './pickup.mjs';
import { SourceEditError } from './source-editor.mjs';

const nativeKey=doc=>`${doc}#native`,decisionKey=row=>`${row.doc}#${row.line}:${row.id??''}`;
const detached=value=>JSON.parse(JSON.stringify(value));
const escapePattern=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
// Match all known flag IDs in one pass per document, rather than one regex
// scan per flag over the entire corpus. Paths retain their substring semantics.
function flagIndexer(rows){
  const byId=new Map(),byPath=new Map(),links=new Map();
  for(const row of rows){
    const key=JSON.stringify([row.id,row.path]);links.set(key,[]);
    for(const [map,value] of [[byId,String(row.id)],[byPath,row.path]]){if(!map.has(value))map.set(value,[]);map.get(value).push(key);}
  }
  const patterns=[...byId].map(([id,keys])=>({id,keys,pattern:new RegExp(`(?<![A-Za-z0-9])${escapePattern(id)}(?![A-Za-z0-9])`)}));
  const matchingKeys=new Map(patterns.map(({id})=>[id,patterns.filter(entry=>entry.pattern.test(id)).flatMap(entry=>entry.keys)]));
  const ids=byId.size?new RegExp(`(?<![A-Za-z0-9])(?:${[...byId.keys()].sort((a,b)=>b.length-a.length).map(escapePattern).join('|')})(?![A-Za-z0-9])`,'g'):null;
  // A zero-width lookahead also finds paths overlapping at different offsets.
  // Same-offset prefixes are included by the longest match's containment map.
  const files=[...byPath.keys()].filter(Boolean),paths=files.length?new RegExp(`(?=(${files.sort((a,b)=>b.length-a.length).map(escapePattern).join('|')}))`,'g'):null;
  const pathKeys=new Map(files.map(file=>[file,files.filter(other=>file.includes(other)).flatMap(other=>byPath.get(other))]));
  return {links,add(doc,source){
    const keys=new Set();
    for(const key of byPath.get('')??[])keys.add(key);
    if(ids)for(const match of source.matchAll(ids))for(const key of matchingKeys.get(match[0]))keys.add(key);
    if(paths)for(const match of source.matchAll(paths))for(const key of pathKeys.get(match[1]))keys.add(key);
    for(const key of keys)links.get(key).push(doc);
  }};
}
export function createRecordLibrary({config,library,readSource,evidence}) {
  const settings=decisionSettings(config.raw?.decisions??{});
  let documents=[],sourcePaths=[],decisions=[],flagLinks=new Map(),lastScan=0,pending,unavailable=0;
  const flagKey=row=>JSON.stringify([row.id,row.path]);
  const flagPattern=row=>new RegExp(`(?<![A-Za-z0-9])${String(row.id).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?![A-Za-z0-9])`);
  const allowed=file=>typeof file==='string'&&!path.isAbsolute(file)&&!file.split(/[\\/]/).some(p=>p==='..'||p==='prompts'||p==='.git'||config.excludeDirs?.has(p));
  function journal(){const file=flagsFile(config);authorizeRepoGeneratedPath(file,config,{kind:'Flag journal'});return readFlagEvents(file).filter(e=>e.event!=='add'||allowed(e.file));}
  async function refresh(context,force=false){
    if(pending){await pending;return refresh(context);}
    if(!force&&lastScan&&Date.now()-lastScan<15_000)return;
    const observedInvalidation=invalidation;
    pending=(async()=>{
      await library.refresh(force);const nextDocuments=await library.all(),sources=[],records=[],native=[];let nextUnavailable=0,indexer;
      // Native summaries first, so their IDs are available to the flag index.
      const ordered=[...nextDocuments.filter(doc=>['decision','flag'].includes(doc.type)),...nextDocuments.filter(doc=>!['decision','flag'].includes(doc.type))];
      for(const [index,doc] of ordered.entries()){
        const legacy=(settings.types.includes(doc.type)||doc.type==='untyped')&&!doc.archived&&(!settings.paths||[].concat(settings.paths).some(p=>doc.path===p||doc.path.startsWith(p.replace(/\/$/,'')+'/')));
        if(!legacy&&!['decision','flag'].includes(doc.type))continue;
        try{
          const opened=readSource(context,doc.path);
          if(['decision','flag'].includes(doc.type)){
            const parsed=parseNativeRecord(opened.source),relations=parsed.record?.record_data?.relations;
            native.push({key:parsed.record?.id??nativeKey(doc.path),native:true,kind:doc.type,id:parsed.record?.id??doc.path,title:parsed.record?.question??parsed.record?.finding??doc.title,question:parsed.record?.question??doc.title,status:parsed.record?.status==='rejected'?'closed':parsed.record?.status??doc.status,severity:parsed.record?.record_data?.severity,triage:parsed.record?.record_data?.triage?.disposition,hints:(Array.isArray(relations)?relations:[]).map(r=>r?.target?.path).filter(allowed),path:doc.path,line:1,editable:false,diagnostics:parsed.diagnostics});
          }else{
            indexer??=flagIndexer([...flags().filter(row=>!row.native),...native.filter(row=>row.kind==='flag')]);
            indexer.add(doc.path,opened.source);
            // Parse and detach this file's useful fragments before moving on.
            // Neither sliced strings nor a corpus-sized source array survive.
            records.push(...detached(parseDecisionItems(opened.source,settings).map(item=>({...item,doc:doc.path,docTitle:doc.title}))));
            sources.push(detached({path:doc.path,work:openWork(opened.source)}));
          }
        }catch{nextUnavailable++;}
        if(index%12===0)await yieldThread();
      }
      const identities=new Map();for(const row of native)identities.set(row.id,(identities.get(row.id)??0)+1);
      for(const row of native)if(identities.get(row.id)>1){row.duplicate=true;row.key=nativeKey(row.path);}
      const items=analyzeDecisionItems(records,settings),blocks=blocksOf(items,sources,items),byLocation=new Map(items.map(i=>[`${i.doc}:${i.line}`,i]));
      const nextDecisions=pendingRows(items,{all:true,blocks}).map(row=>({...row,key:decisionKey(row),kind:'decision',path:row.doc,searchText:byLocation.get(`${row.doc}:${row.line}`)?.text,peers:(byLocation.get(`${row.doc}:${row.line}`)?.peers??[]).map(p=>({doc:p.doc,line:p.line,id:p.id,status:p.effective})),title:row.question||row.id,status:row.disposition??'unknown'}));
      for(const item of items.filter(i=>!i.id))nextDecisions.push({key:decisionKey(item),kind:'decision',path:item.doc,line:item.line,id:null,title:'Unnamed decision',question:'Unnamed decision',status:item.effective??'unknown',missing:item.missing});
      nextDecisions.push(...native.filter(row=>row.kind==='decision'));
      const nextNativeFlags=native.filter(row=>row.kind==='flag');
      indexer??=flagIndexer([...flags().filter(row=>!row.native),...nextNativeFlags]);
      // Detach substring-backed record text too. Peer bodies are read on demand;
      // the analysis graph and full documents belong only to this refresh.
      decisions=nextDecisions.map(detached);
      nativeFlags=nextNativeFlags.map(detached);
      documents=nextDocuments;sourcePaths=sources.map(doc=>doc.path);flagLinks=indexer.links;unavailable=nextUnavailable;lastScan=observedInvalidation===invalidation?Date.now():0;
    })().finally(()=>{pending=null;});await pending;if(!lastScan)return refresh(context);
  }
  let nativeFlags=[];
  function flags(){return [...deriveFlags(journal()).map(flag=>({...flag,key:flag.id,kind:'flag',path:flag.file,title:flag.text,status:flag.state,revision:flagRevision(flag)})),...nativeFlags];}
  function connections(row,context){
    const paths=new Set([row.path,...(row.hints??[]),...(row.blocks??[]).map(b=>b.doc),...(row.peers??[]).map(p=>p.doc)]);
    if(row.kind==='flag'){
      const key=flagKey(row);
      // Journal additions are visible between document refreshes. Resolve a new
      // finding once using the same authenticated source reader, then cache paths.
      if(!flagLinks.has(key)){
        const pattern=flagPattern(row),matches=[];
        for(const sourcePath of sourcePaths)try{const {source}=readSource(context,sourcePath);if(source.includes(row.path)||pattern.test(source))matches.push(sourcePath);}catch{/* Missing/unsafe sources supply no connection. */}
        flagLinks.set(key,matches);
      }
      for(const sourcePath of flagLinks.get(key))paths.add(sourcePath);
    }
    const links=documents.filter(doc=>paths.has(doc.path));
    for(const doc of [...links])for(const relation of library.relations(doc.path,{parent_plan:doc.parents},''))if(relation.label==='Parent hub'&&relation.target&&!links.some(l=>l.path===relation.target.path))links.push(relation.target);
    return links.map(({path,title,type,kind,status})=>({path,title,type,kind,status}));
  }
  async function query(context,kind,params){
    await refresh(context,params.get('refresh')==='1');
    const flagRows=flags(),all=kind==='flags'?flagRows:decisions,words=(params.get('q')??'').slice(0,500).toLowerCase().trim().split(/\s+/).filter(Boolean),status=params.get('status')??'pending',severity=params.get('severity')??'',scope=params.get('scope')??'';
    let rows=all.filter(row=>(!status||status==='pending'?(!status||['open','held'].includes(row.status)):row.status===status)&&(!severity||row.severity===severity)&&(!scope||row.path===scope||connections(row,context).some(c=>c.path===scope))&&words.every(word=>`${row.id} ${row.title} ${row.question??''} ${row.path} ${row.status} ${row.text??''} ${row.searchText??''}`.toLowerCase().includes(word)));
    rows.sort(kind==='flags'?(a,b)=>['problem','warn','info'].indexOf(a.severity)-['problem','warn','info'].indexOf(b.severity)||String(b.at??'').localeCompare(String(a.at??'')):(a,b)=>String(a.id??'').localeCompare(String(b.id??''),'en',{numeric:true})||a.path.localeCompare(b.path));
    const sourcePaths=new Set(all.flatMap(row=>[row.path,...(row.peers??[]).map(p=>p.doc),...(row.blocks??[]).map(b=>b.doc),...(row.hints??[])]));
    const offset=Math.max(0,Math.min(Number(params.get('offset'))||0,Math.max(0,Math.floor((rows.length-1)/50)*50))),limit=50;
    return {records:rows.slice(offset,offset+limit).map(row=>({key:row.key,id:row.id,title:row.title,status:row.status,severity:row.severity,triage:row.triage,path:row.path,line:row.line,native:row.native,missing:row.missing})),total:rows.length,offset,hasMore:offset+limit<rows.length,counts:{flags:flagRows.filter(f=>f.status==='open').length,decisions:decisions.filter(d=>['open','held'].includes(d.status)).length},scopes:documents.filter(d=>sourcePaths.has(d.path)||d.kind==='hub').map(d=>({path:d.path,title:d.title})),unavailable};
  }
  async function detail(context,kind,key){
    await refresh(context);const row=(kind==='flags'?flags():decisions).find(row=>row.key===key);
    if(!row)throw new SourceEditError('record-not-found','This record is unavailable. Refresh the list.');
    const peers=kind==='decisions'&&!row.native?(row.peers??[]):[];
    const links=connections(row,context);
    if(row.native){const opened=readSource(context,row.path),parsed=parseNativeRecord(opened.source),claim=readPlanOwnership(row.path,config);return {...row,status:parsed.record?.status==='rejected'?'closed':parsed.record?.status??row.status,revision:opened.revision,body:parsed.body??'',data:parsed.record?.record_data,diagnostics:row.duplicate?[...parsed.diagnostics,{code:'duplicate-record-id',message:'This ID is declared in multiple documents. Reconcile their identities before recording an action.'}]:parsed.diagnostics,connections:links,editable:parsed.ok&&!row.duplicate&&!claim?.corrupt&&claim?.state!=='owned',readOnlyReason:row.duplicate?'This record ID is declared in multiple documents. Reconcile their identities first.':claim?.corrupt?'Ownership needs repair through the CLI.':claim?.state==='owned'?'This record is claimed by another session. Coordinate through the CLI first.':null};}
    if(kind==='flags')return {...row,...evidence(row),connections:links,editable:row.state==='open'};
    const opened=readSource(context,row.path),item=parseDecisionItems(opened.source,settings).find(i=>i.id===row.id&&i.line===row.line);
    if(!item)throw new SourceEditError('decision-revision-conflict','This decision moved. Refresh the list to find its current record.');
    const peerSources=new Map([[row.path,parseDecisionItems(opened.source,settings)]]);
    const peerDetails=peers.map(peer=>{
      if(!peerSources.has(peer.doc))peerSources.set(peer.doc,parseDecisionItems(readSource(context,peer.doc).source,settings));
      const current=peerSources.get(peer.doc).find(item=>item.id===peer.id&&item.line===peer.line);
      if(!current)throw new SourceEditError('decision-revision-conflict','A related decision moved. Refresh the list to find its current record.');
      return {path:peer.doc,line:peer.line,id:peer.id,status:peer.status,body:current.text};
    });
    const ownership=readPlanOwnership(row.path,config),claimBlocked=ownership?.corrupt||ownership?.state==='owned';
    return {...row,claim:ownership?{state:ownership.state,corrupt:ownership.corrupt,sessionId:ownership.sessionId}:null,readOnlyReason:claimBlocked?(ownership.corrupt?'Ownership needs repair through the CLI before recording an outcome.':`This source is owned by session ${ownership.sessionId}. Coordinate or release that claim through the CLI before recording an outcome.`):null,status:dispositionOf(item,settings)??row.status,revision:opened.revision,body:item.text,blocks:row.blocks??[],missing:row.missing??[],connections:links,peers:peerDetails,editable:opened.editable&&!!row.id&&!claimBlocked,source:opened.source};
  }
  let invalidation=0;
  return {query,detail,refresh,invalidate(){invalidation++;lastScan=0;}};
}
