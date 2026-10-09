import {it} from 'node:test';
import {strictEqual,ok,throws} from 'node:assert';
import {prepareDecisionAction} from '../src/decision-action.mjs';
import {parseDecisionItems,dispositionOf,pendingRows,analyzeDecisions,decisionSettings} from '../src/decisions.mjs';
const actor={kind:'human',id:'human:fixture',label:'Fixture owner'},at='2026-10-05T00:00:00Z';
function act(source,settings={},disposition='ruled'){const item=parseDecisionItems(source,settings)[0];return prepareDecisionAction(source,{id:item.id,line:item.line,disposition,choice:'Blue bin',note:'It fits the existing shelf.',actor,at},settings);}
it('records newest heading outcomes while preserving CRLF, metadata, old outcomes and unrelated bytes',()=>{
 const raw='---\r\ntype: plan\r\nstatus: active\r\ncustom: preserved\r\n---\r\n# Fixture\r\n\r\n## Decisions\r\n\r\n### D1 Which bin?\r\nDisposition: OPEN.\r\n\r\nBlue or red.\r\n\r\n## Version History\r\n\r\n- Earlier history.\r\n';
 const ruled=act(raw);strictEqual(ruled.replace(/Disposition: RULED[^\r\n]*\r\n/,''),raw);strictEqual(dispositionOf(parseDecisionItems(ruled)[0]),'ruled');
 const held=act(ruled,{},'held');ok(held.includes('Disposition: RULED'));strictEqual(dispositionOf(parseDecisionItems(held)[0]),'held');ok(!/(?<!\r)\n/.test(held));
});
it('keeps table, bold, list and register records parseable and their original text intact',()=>{
 const examples=[['## Decisions\n\n- **D1 — Which bin?** OPEN. Blue or red.\n',{}],['## Decisions\n\n**D1 — Which bin?** OPEN. Blue or red.\n',{}],['## Decisions\n\n| ID | Question | Answer |\n| --- | --- | --- |\n| D1 | Which bin? | OPEN. Blue or red. |\n',{}],['```text\nwaiting on you:\nD1  OPEN. Which bin? Blue or red.\n```\n',decisionSettings({register:{statusLine:'waiting on you:'}})]];
 for(const [source,settings] of examples){const next=act(source,settings);strictEqual(dispositionOf(parseDecisionItems(next,settings)[0],settings),'ruled');ok(next.includes('**Original record:**'));const twice=act(next,settings,'held');strictEqual(dispositionOf(parseDecisionItems(twice,settings)[0],settings),'held');ok(twice.includes('Disposition: RULED'));}
 const source='## Decisions\n\n- **Q-12 — Which bin?** OPEN.\n',settings={id:'Q-\\d+'};strictEqual(parseDecisionItems(act(source,settings),settings)[0].id,'Q-12');
});
it('preserves the question shown by the queue after repeated recorded outcomes',()=>{
 const source='## Decisions\n\n- **D1 — Which bin?** OPEN. Blue or red.\n',next=act(act(source),{},'held');const rows=pendingRows(analyzeDecisions([{path:'docs/plans/fixture.md',text:next}],{}),{all:true});ok(rows[0].question.includes('Which bin?'),JSON.stringify(rows));ok(!rows[0].question.includes('Recorded by'),JSON.stringify(rows));
});
it('handles a final heading without a newline, rejects agents ruling and refuses a moved decision',()=>{
 strictEqual(dispositionOf(parseDecisionItems(act('## Decisions\n\n### D1 Which bin?'))[0]),'ruled');
 const source='## Decisions\n\n### D1 Which bin?\nDisposition: OPEN.\n';
 throws(()=>prepareDecisionAction(source,{id:'D1',line:3,disposition:'ruled',choice:'Blue',note:'Reason',actor:{kind:'agent',id:'session',session_id:'session'},at}),/human/);
 throws(()=>prepareDecisionAction(source,{id:'D1',line:7,disposition:'held',note:'Reason',actor,at}),/moved/);
});
