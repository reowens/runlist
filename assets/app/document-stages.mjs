import { readSourceStage } from './shared.mjs';

// Stage is authored metadata. A choice only changes the existing editor draft;
// the ordinary source review/save flow publishes it with its usual guards.
export function documentStages({state,$,changed}) {
  const select=$('document-stage'),meaning=$('document-stage-meaning');
  let current={word:null,invalid:false};
  select.onchange=()=>changed(select.value?select.value.slice(5):null);
  return {update(source) {
    const plan=state.doc?.kind==='plan';$('document-stage-fields').hidden=!plan;
    if(!plan)return;
    current=readSourceStage(source);
    const definitions=state.doc.stageDefinitions??[],known=definitions.some(stage=>stage.word===current.word);
    select.replaceChildren(new Option('Unset · no stage',''),...definitions.map(stage=>new Option(stage.word,`word:${stage.word}`)));
    if(current.word&&!known){const option=new Option(`${current.word} · unknown`,`word:${current.word}`);option.disabled=true;select.add(option);}
    if(current.invalid){const option=new Option('Invalid metadata','@invalid');option.disabled=true;select.add(option);}
    select.value=current.invalid?'@invalid':current.word?`word:${current.word}`:'';
    select.disabled=!state.doc.editable||!!state.pending||state.busy;
    const definition=definitions.find(stage=>stage.word===current.word);
    meaning.textContent=current.invalid?'This stage has unsupported metadata. Choose a configured stage or Unset, then review the change.':current.word&&!known?'This stage is not configured in this repository. Its current value is preserved until you choose a replacement.':definition?.meaning||(!definitions.length?'No stages are configured. Define taxonomy.milestones in runlist.config.mjs to choose a stage.':'Stage describes when this plan should ship. Changes stay in your draft until saved.');
  }};
}
