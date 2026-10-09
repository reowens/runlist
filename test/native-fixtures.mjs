// Native records used by API, core and optional browser journeys.
export const recordId = (kind, n) => `${kind}:00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
export const owner = {kind:'human',id:'human:fixture',label:'Fixture owner'};
export function nativeFixture(type='decision') {
  const at='2026-10-05T00:00:00Z';
  const common={repository_id:recordId('repo',1),created_by:owner,aliases:[],evidence:[],relations:[],history:[],extensions:{'fixture.example':{unicode:'先 🧭',nested:[1,true,{kept:'original'}]}}};
  return {
    record_schema:'runlist.record/v1',id:recordId(type,type==='flag'?2:3),type,status:'open',created:at,updated:at,custom_team:'original',
    ...(type==='flag'?{finding:'An observed violation.',record_data:{...common,severity:'problem',source:{kind:'check',name:'fixture-check',rule_id:'fixture.rule/v1',finding_key:'fixture'},occurrence:1,triage:{disposition:'unreviewed',extension:'retained'},resolutions:[]}}:
      {question:'Which native bin?',record_data:{...common,options:[4,5].map(n=>({id:recordId('option',n),label:n===4?'Blue bin':'Red bin',description:'A concrete approach.',consequences:[{kind:'cost',text:'An explicit cost.'}]})),recommendations:[],rulings:[]}})
  };
}
export function nativeSource(record=nativeFixture(),body='# Native fixture\n\nContext stays unchanged 先 🧭.\n\n<!-- preserved comment -->\n') {
  const {record_data,...fm}=record;
  return `---\n${Object.entries(fm).map(([k,v])=>`${k}: ${v}`).join('\n')}\nrecord_data: |-\n${JSON.stringify(record_data,null,2).split('\n').map(l=>'  '+l).join('\n')}\n---\n${body}`;
}
