import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { nativeRecordSchema, parseNativeRecord, validateNativeRecord } from '../src/native-record.mjs';

const id = (kind, n) => `${kind}:00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const repo = id('repo', 1);
const actor = { kind: 'human', id: 'human:fixture-owner' };
const at = '2026-10-05T00:00:00Z';
const common = () => ({ repository_id: repo, created_by: actor, aliases: [], evidence: [], relations: [], history: [] });
const flag = () => ({ record_schema: 'runlist.record/v1', id: id('flag', 2), type: 'flag', status: 'open', created: at, updated: at, finding: 'An observed violation.', record_data: { ...common(), severity: 'problem', source: { kind: 'check', name: 'fixture-check', rule_id: 'fixture.rule/v1', finding_key: 'stable-subject-and-rule' }, occurrence: 1, triage: { disposition: 'unreviewed' }, resolutions: [] } });
const decision = () => ({ record_schema: 'runlist.record/v1', id: id('decision', 3), type: 'decision', status: 'open', created: at, updated: at, question: 'Which approach?', record_data: { ...common(), options: [4,5].map(n => ({id:id('option',n),label:`Option ${n}`,description:'A concrete approach.',consequences:[{kind:'cost',text:'One explicit cost.'}]})), recommendations: [], rulings: [] } });
const source = (r, body = '# Record\n\nContext stays native Markdown.\n') => {
  const {record_data, ...fm} = r;
  return `---\n${Object.entries(fm).map(([k,v]) => `${k}: ${v}`).join('\n')}\nrecord_data: |-\n${JSON.stringify(record_data,null,2).split('\n').map(line => `  ${line}`).join('\n')}\n---\n${body}`;
};
const codeEvidence = () => ({id:id('evidence',6),kind:'code',observed_at:at,by:actor,repository_id:repo,path:'src/sample.mjs',revision:{kind:'git',value:'a'.repeat(40)},anchor:{start_line:2,end_line:3,quote:'Original observed code'}});

describe('native record v1 contract', () => {
  it('retains nested evidence revisions, unknown metadata, Unicode and original CRLF bytes', () => {
    const r=flag();
    r.custom_team='fixture';
    r.record_data.evidence=[codeEvidence()];
    r.record_data.extensions={'fixture.example':{nested:[{text:'先 🧭',enabled:true,count:3}]}};
    const raw=source(r).replaceAll('\n','\r\n');
    const parsed=parseNativeRecord(raw);
    strictEqual(parsed.ok,true,JSON.stringify(parsed.diagnostics));
    strictEqual(parsed.source,raw);
    strictEqual(parsed.record.record_data.evidence[0].revision.value,'a'.repeat(40));
    deepStrictEqual(parsed.record.record_data.extensions,r.record_data.extensions);
    strictEqual(parsed.record.custom_team,'fixture');
    strictEqual(parsed.body,'# Record\n\nContext stays native Markdown.\n');
    strictEqual(raw,parsed.source);
  });

  it('rejects ambiguous JSON keys, nested YAML, folded data and unknown schema versions', () => {
    const raw=source(flag());
    const duplicate=raw.replace('"severity": "problem"','"severity": "info", "sever\\u0069ty": "problem"');
    ok(parseNativeRecord(duplicate).diagnostics.some(e=>e.message.includes('Duplicate JSON key')));
    ok(parseNativeRecord(raw.replace('record_data: |-','record_data: >-')).diagnostics.some(e=>e.code==='record-json'));
    strictEqual(parseNativeRecord(raw.replace('record_data: |-\n','record_data:\n')).ok,false);
    const nested=raw.replace('type: flag','type: flag\ncustom:\n  nested: value');
    ok(parseNativeRecord(nested).diagnostics.some(e=>e.code==='unsupported-frontmatter'));
    const unknown=raw.replace('runlist.record/v1','runlist.record/v9');
    strictEqual(parseNativeRecord(unknown).record,null);
    strictEqual(parseNativeRecord(unknown).source,unknown);
    strictEqual(parseNativeRecord(unknown).diagnostics[0].code,'unsupported-schema');
    ok(parseNativeRecord(raw.replace('type: flag','type: flag\ntype: decision')).diagnostics.some(e=>e.code==='duplicate-frontmatter'));
  });

  it('rejects incomplete evidence without substituting the current revision or first repeated quote', () => {
    const r=flag();
    const e=codeEvidence();
    r.record_data.evidence=[e];
    delete e.revision;
    ok(validateNativeRecord(r).some(x=>x.message.includes('observed revision')));
    e.revision={kind:'unknown',reason:'Legacy evidence did not record a revision.'};
    strictEqual(validateNativeRecord(r).length,0);
    e.revision={kind:'git',value:'abc123',dirty:true};
    ok(validateNativeRecord(r).some(x=>x.message.includes('full commit hash')));
    e.revision.value='b'.repeat(40);
    e.anchor.sha256='c'.repeat(64);
    strictEqual(validateNativeRecord(r).length,0);
    e.path='../escape.mjs';
    ok(validateNativeRecord(r).some(x=>x.message.includes('repository-relative')));
  });

  it('keeps accepted awareness open and requires completed evidence for check resolution', () => {
    const r=flag();
    r.record_data.triage={disposition:'accepted',by:actor,at,reason:'Known and accepted for review.'};
    strictEqual(validateNativeRecord(r).length,0);
    strictEqual(r.status,'open');
    r.status='resolved';
    const original=codeEvidence();
    const proof={id:id('evidence',7),kind:'command',observed_at:at,by:{kind:'check',id:'check:fixture'},repository_id:repo,revision:{kind:'git',value:'b'.repeat(40)},argv:['fixture-check'],exit:0,rule_id:'fixture.rule/v1',coverage:{complete:false,repository_id:repo,kind:'files',paths:[original.path]}};
    r.record_data.evidence=[original,proof];
    r.record_data.resolutions=[{id:id('resolution',8),by:proof.by,at,method:'check',reason:'Complete recheck.',evidence_ids:[proof.id]}];
    r.record_data.active_resolution_id=id('resolution',8);
    ok(validateNativeRecord(r).some(x=>x.message.includes('complete coverage')));
    proof.coverage.complete=true;
    strictEqual(validateNativeRecord(r).length,0);
    proof.observed_at='2026-10-04T00:00:00Z';
    ok(validateNativeRecord(r).some(x=>x.message.includes('after the observations')));
    proof.observed_at=at;
    original.repository_id=id('repo',17);
    ok(validateNativeRecord(r).some(x=>x.message.includes('complete coverage')));
    original.repository_id=repo;
    proof.coverage.paths=['src/unrelated.mjs'];
    ok(validateNativeRecord(r).some(x=>x.message.includes('complete coverage')));
    r.status='open';
    delete r.record_data.active_resolution_id;
    r.record_data.occurrence=2;
    strictEqual(validateNativeRecord(r).length,0);
    strictEqual(r.record_data.resolutions.length,1);
  });

  it('keeps recommendations separate from rulings and validates selection and delegated authority', () => {
    const r=decision();
    r.record_data.recommendations=[{by:{kind:'agent',id:'agent:fixture'},at,option_id:id('option',4),reason:'Recommended after inspection.',evidence_ids:[]}];
    strictEqual(validateNativeRecord(r).length,0);
    strictEqual(r.status,'open');
    const ruling={id:id('ruling',9),by:actor,at,kind:'select',option_id:id('option',5),reason:'Chosen by the fixture owner.',authority:{basis:'human'},evidence_ids:[]};
    r.status='ruled'; r.record_data.rulings=[ruling]; r.record_data.active_ruling_id=ruling.id;
    strictEqual(validateNativeRecord(r).length,0);
    ruling.option_id=id('option',99);
    ok(validateNativeRecord(r).some(x=>x.message.includes('unknown option')));
    ruling.option_id=id('option',5);
    ruling.by={kind:'agent',id:'agent:fixture'};
    ok(validateNativeRecord(r).some(x=>x.message.includes('explicit delegation')));
    ruling.authority={basis:'delegated',grant_ref:{repository_id:repo,id:id('decision',10)}};
    strictEqual(validateNativeRecord(r).length,0);
    ruling.supersedes_ruling_id=ruling.id;
    ok(validateNativeRecord(r).some(x=>x.message.includes('preceding ruling')));
    delete ruling.supersedes_ruling_id;
    const peer={...structuredClone(ruling),id:id('ruling',16),option_id:id('option',4)};
    r.record_data.rulings.push(peer);
    ok(validateNativeRecord(r).some(x=>x.message.includes('Competing rulings')));
    peer.supersedes_ruling_id=ruling.id;
    r.record_data.active_ruling_id=peer.id;
    strictEqual(validateNativeRecord(r).length,0);
  });

  it('uses explicit owned item anchors and relations, ignoring examples in fences', () => {
    const r={record_schema:'runlist.record/v1',id:id('plan',11),type:'plan',status:'active',created:at,updated:at,record_data:common()};
    const item=id('item',12);
    const body=`# Plan\n\n<!-- runlist:item ${item} -->\n- [ ] First action.\n\n~~~markdown\n<!-- runlist:item ${item} -->\n- [x] Example only.\n~~~\n\n    <!-- runlist:item ${item} -->\n    - [x] Indented example.\n`;
    r.record_data.relations=[{id:id('relation',13),source_id:item,kind:'about',target:{repository_id:repo,id:id('decision',3)},by:actor,at}];
    strictEqual(parseNativeRecord(source(r,body)).ok,true);
    r.record_data.relations[0].kind='blocks';
    ok(validateNativeRecord(r,{body}).some(x=>x.message.includes('Blocks targets execution')));
    r.record_data.relations[0].target.id=id('item',14);
    strictEqual(validateNativeRecord(r,{body}).length,0);
    ok(validateNativeRecord(r,{body:body+`\n<!-- runlist:item ${item} -->\n- [x] Duplicate.\n`}).some(x=>x.message.includes('Duplicate declared ID')));
    r.record_data.relations[0].source_id=id('item',15);
    ok(validateNativeRecord(r,{body}).some(x=>x.message.includes('source must belong')));
  });

  it('returns located schema diagnostics and refuses unsupported required features', () => {
    const r=flag(); r.updated='2026-02-30T00:00:00Z';
    ok(validateNativeRecord(r).some(x=>x.path==='$.updated'));
    r.updated=at; r.record_data.requires=['future-policy/v2'];
    ok(parseNativeRecord(source(r)).diagnostics.some(x=>x.code==='unsupported-feature'));
    const copy=nativeRecordSchema(); copy.title='Changed';
    ok(nativeRecordSchema().title!=='Changed');
  });

  it('bounds metadata size and depth and does not treat quoted keys as duplicate structure', () => {
    const r=flag();
    r.record_data.extensions={quoted:'A string containing "severity": and braces { }.',empty:[],unicode:'先'};
    strictEqual(parseNativeRecord(source(r)).ok,true);
    let nested={};
    for(let i=0;i<66;i++) nested={nested};
    r.record_data.extensions=nested;
    ok(parseNativeRecord(source(r)).diagnostics.some(x=>x.message.includes('64 nesting levels')));
    r.record_data.extensions={huge:'x'.repeat(256*1024)};
    ok(parseNativeRecord(source(r)).diagnostics.some(x=>x.message.includes('256 KiB')));
  });
});
