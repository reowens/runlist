import { afterEach, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync, renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveConfig } from '../src/config.mjs';
import { createDocumentLibrary } from '../src/app-library.mjs';
const dirs=[];afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
async function fixture(){const root=mkdtempSync(path.join(os.tmpdir(),'runlist-library-'));dirs.push(root);for(const dir of ['docs/plans','docs/modules','docs/prompts','docs/evidence'])mkdirSync(path.join(root,dir),{recursive:true});writeFileSync(path.join(root,'runlist.config.mjs'),"export const root=['docs/plans','docs']; export const excludeDirs=['evidence'];\n");return {root,config:await resolveConfig(root)};}
it('bounds a 5,000-document library, separates hub/plan/doc views, and reuses unchanged headers',async()=>{
 const f=await fixture();for(let i=0;i<5000;i++){const type=i%5===0?'doc':'plan',hub=type==='plan'&&i%23===0,status=i%10===0?'archived':i%3===0?'partial':'active',folder=type==='doc'?'modules':'plans';writeFileSync(path.join(f.root,'docs',folder,`record-${String(i).padStart(4,'0')}.md`),`---\ntype: ${type}\nstatus: ${status}\nupdated: 2026-10-05T12:00:00Z\nmodules: [catalog]\n${hub?'execution_mode: coordination\n':''}---\n# Document ${i}\n\nPRIVATE BODY MUST NOT BE INDEXED\n`);}
 writeFileSync(path.join(f.root,'docs/prompts/forged.md'),'---\ntype: plan\nstatus: active\n---\n# PRIVATE PROMPT\n');writeFileSync(path.join(f.root,'docs/evidence/excluded.md'),'# EXCLUDED\n');symlinkSync(path.join(f.root,'docs/plans/record-0001.md'),path.join(f.root,'docs/modules/link.md'));
 const library=createDocumentLibrary(f.config),first=await library.query();strictEqual(first.inventoryTotal,5000);strictEqual(first.counts.all,4500);strictEqual(first.documents.length,50);strictEqual(first.stats.headersRead,5000);ok(!JSON.stringify(first).includes('PRIVATE BODY'));ok(!JSON.stringify(first).includes('PRIVATE PROMPT'));strictEqual(new Set(first.documents.map(d=>d.path)).size,50);
 const second=await library.query(new URLSearchParams('offset=50'));strictEqual(second.documents.length,50);ok(!second.documents.some(d=>first.documents.some(p=>p.path===d.path)));strictEqual(second.stats.generation,first.stats.generation);
 const hubs=await library.query(new URLSearchParams('kind=hubs'));ok(hubs.total>100);ok(hubs.documents.every(d=>d.kind==='hub'));const docs=await library.query(new URLSearchParams('kind=documents'));strictEqual(docs.total,500);ok(docs.documents.every(d=>d.type==='doc'));
 const search=await library.query(new URLSearchParams('q=record-4999&folder=docs/plans&status=active'));strictEqual(search.total,1);strictEqual(search.documents[0].path,'docs/plans/record-4999.md');strictEqual((await library.query(new URLSearchParams('archived=1&limit=1000'))).documents.length,100);
 await library.refresh(true);strictEqual(library.stats.headersRead,0);
 const changed=path.join(f.root,'docs/plans/record-4999.md');writeFileSync(changed,'---\ntype: plan\nstatus: blocked\n---\n# Changed external title\n');renameSync(path.join(f.root,'docs/plans/record-4998.md'),path.join(f.root,'docs/plans/renamed.md'));await library.refresh(true);strictEqual(library.stats.headersRead,2);strictEqual((await library.query(new URLSearchParams('q=Changed external'))).documents[0].status,'blocked');strictEqual(library.resolve('record-4998.md','docs/plans/a.md'),null);ok(library.resolve('renamed.md','docs/plans/a.md'));
});
it('connects hub membership and parents without treating arbitrary citations as children',async()=>{
 const f=await fixture();const write=(name,source)=>writeFileSync(path.join(f.root,`docs/plans/${name}.md`),source);
 write('hub','---\ntype: plan\nstatus: active\nexecution_mode: coordination\nrunlist:\n  - child.md\n---\n# Hub\n');write('child','---\ntype: plan\nstatus: partial\nparent_plan: hub.md\n---\n# Child\n');write('backref','---\ntype: plan\nstatus: planned\nparent_plan: hub.md\n---\n# Backref\n');write('citation','---\ntype: plan\nstatus: active\n---\n# Citation\n');
 const library=createDocumentLibrary(f.config);await library.refresh();const relations=library.relations('docs/plans/hub.md',{type:'plan',execution_mode:'coordination',runlist:['child.md']},'## Ranked queue\n\n| Child | Status |\n| --- | --- |\n| [Child](child.md) | partial |\n\n## References\n\n[Citation](citation.md)\n');deepStrictEqual(relations.filter(r=>r.label==='Hub members').map(r=>r.target.path).sort(),['docs/plans/backref.md','docs/plans/child.md']);strictEqual(library.resolve('../prompts/private.md','docs/plans/hub.md'),null);strictEqual(library.relations('docs/plans/hub.md',{type:'plan',runlist:Array.from({length:80},(_,i)=>`missing-${i}.md`)},'').filter(r=>r.label==='Hub members').length,82);
});
it('reads small headers on demand without truncating split headings or long CRLF frontmatter',async()=>{
 const f=await fixture(),write=(name,source)=>writeFileSync(path.join(f.root,'docs/plans',name+'.md'),source);
 write('small','---\ntype: plan\nstatus: active\ntitle: Small explicit title\n---\n# Heading\n'+'Unrelated body. '.repeat(20_000));
 const library=createDocumentLibrary(f.config);await library.refresh();strictEqual(library.stats.headerBytesRead,4096);strictEqual((await library.all())[0].title,'Small explicit title');
 const prefix='---\ntype: plan\nstatus: active\n---\n',heading='A heading crossing the read boundary '+ 'é'.repeat(200);
 write('split',prefix+'x'.repeat(4088-prefix.length)+'\n# '+heading+'\n');
 write('long','---\r\ntype: plan\r\nstatus: active\r\ncustom: |-\r\n  '+ 'x'.repeat(10_000)+'\r\ntitle: Title after long frontmatter\r\n---\r\n# Body heading\r\n');
 write('late',prefix+'x'.repeat(70_000)+'\n# Late heading\n');
 await library.refresh(true);const rows=await library.all();strictEqual(rows.find(r=>r.path.endsWith('/split.md')).title,heading.slice(0,300));strictEqual(rows.find(r=>r.path.endsWith('/long.md')).title,'Title after long frontmatter');strictEqual(rows.find(r=>r.path.endsWith('/long.md')).status,'active');strictEqual(rows.find(r=>r.path.endsWith('/late.md')).title,'Late heading');
});

it('updates a saved document without rescanning unchanged files and keeps relationships and facets current',async()=>{
 const f=await fixture(),write=(name,source)=>writeFileSync(path.join(f.root,'docs/plans',name+'.md'),source);
 write('hub','---\ntype: plan\nstatus: active\nexecution_mode: coordination\n---\n# Hub\n');
 for(let i=0;i<100;i++)write('child-'+i,`---\ntype: plan\nstatus: active\nparent_plan: hub.md\n---\n# Child ${i}\n`);
 const library=createDocumentLibrary(f.config);await library.refresh();const before=library.stats;
 write('child-0','---\ntype: plan\nstatus: blocked\nparent_plan: other.md\n---\n# Saved title\n');library.invalidate('docs/plans/child-0.md');
 const result=await library.query(new URLSearchParams('q=Saved title'));
 strictEqual(result.documents[0].status,'blocked');strictEqual(result.stats.fullScans,before.fullScans);strictEqual(result.stats.checkedFiles,1);strictEqual(result.stats.headersRead,1);strictEqual(result.stats.files,101);
 strictEqual(result.facets.statuses.find(s=>s.value==='blocked').count,1);
 strictEqual(library.relations('docs/plans/hub.md',{type:'plan',execution_mode:'coordination'},'').filter(r=>r.label==='Hub members').length,99);
 ok(!JSON.stringify(result).includes('parent_plan:'));
});

it('preserves full and targeted invalidations received while discovery is in flight',async()=>{
 const f=await fixture(),write=name=>writeFileSync(path.join(f.root,'docs/plans',name+'.md'),`---\ntype: plan\nstatus: active\n---\n# ${name}\n`),library=createDocumentLibrary(f.config);
 write('first');const initial=library.refresh();write('added-during-scan');library.invalidate('docs/plans/added-during-scan.md');
 await initial;ok(library.resolve('added-during-scan.md','docs/plans/first.md'));strictEqual(library.stats.fullScans,1);strictEqual(library.stats.incrementalRefreshes,1);
 const scan=library.refresh(true);write('added-after-discovery');library.invalidate();await scan;
 ok(library.resolve('added-after-discovery.md','docs/plans/first.md'));strictEqual(library.stats.fullScans,3);
});

it('coalesces overlapping forced refreshes into a single discovery',async()=>{
 const f=await fixture();writeFileSync(path.join(f.root,'docs/plans/a.md'),'---\ntype: plan\nstatus: active\n---\n# A\n');const library=createDocumentLibrary(f.config);
 await Promise.all([library.refresh(true),library.refresh(true),library.query()]);strictEqual(library.stats.fullScans,1);
 await Promise.all([library.refresh(true),library.refresh(true)]);strictEqual(library.stats.fullScans,2);
});

it('does not let repeated local saves postpone discovery of external additions, moves and deletions',async()=>{
 const f=await fixture(),file=path.join(f.root,'docs/plans/a.md'),external=path.join(f.root,'docs/plans/external.md'),library=createDocumentLibrary(f.config,{refreshMs:1000});
 writeFileSync(file,'---\ntype: plan\nstatus: active\n---\n# A\n');await library.refresh();const indexed=Date.parse(library.stats.indexedAt),clock=Date.now;
 try{
  Date.now=()=>indexed+500;writeFileSync(file,'---\ntype: plan\nstatus: active\n---\n# Saved A\n');library.invalidate(file);await library.refresh();strictEqual(Date.parse(library.stats.indexedAt),indexed);
  writeFileSync(external,'---\ntype: doc\nstatus: active\n---\n# External\n');renameSync(file,path.join(f.root,'docs/plans/moved.md'));
  Date.now=()=>indexed+1001;await library.refresh();strictEqual(library.resolve('a.md','docs/plans/a.md'),null);ok(library.resolve('moved.md','docs/plans/a.md'));ok(library.resolve('external.md','docs/plans/a.md'));strictEqual(library.stats.fullScans,2);
  rmSync(external);Date.now=()=>indexed+2002;await library.refresh();strictEqual(library.resolve('external.md','docs/plans/a.md'),null);
 }finally{Date.now=clock;}
});

it('targeted refresh removes deleted or unsafe rows and never reads excluded or escaped paths',async()=>{
 const f=await fixture(),file=path.join(f.root,'docs/plans/a.md'),other=path.join(f.root,'docs/plans/b.md');
 for(const p of [file,other])writeFileSync(p,'---\ntype: plan\nstatus: active\n---\n# Visible\n');const library=createDocumentLibrary(f.config);await library.refresh();
 rmSync(file);library.invalidate(file);await library.refresh();strictEqual(library.resolve('a.md','docs/plans/b.md'),null);strictEqual(library.stats.unavailable,0);
 const privateFile=path.join(f.root,'docs/prompts/private.md');writeFileSync(privateFile,'---\ntype: plan\nstatus: active\n---\n# PRIVATE_TARGETED_CANARY\n');
 rmSync(other);symlinkSync(privateFile,other);library.invalidate([other,privateFile,path.join(f.root,'docs/evidence/excluded.md'),'../outside.md']);const result=await library.query();
 strictEqual(result.total,0);strictEqual(result.stats.checkedFiles,1);strictEqual(result.stats.unavailable,1);ok(!JSON.stringify(result).includes('PRIVATE_TARGETED_CANARY'));
});

it('bounds pending changed paths by falling back to discovery',async()=>{
 const f=await fixture(),library=createDocumentLibrary(f.config);await library.refresh();
 library.invalidate(Array.from({length:600},(_,i)=>`docs/plans/missing-${i}.md`));await library.refresh();strictEqual(library.stats.fullScans,2);strictEqual(library.stats.checkedFiles,0);
});
