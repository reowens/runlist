// A Node/linkedom component benchmark of the actual BlockEditor. This is not
// a WebView measurement and exercises no browser, native window or OS input.
import {readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseHTML} from 'linkedom';
import {fixture,MiB,round,percentile,sha256} from './memory-workload.mjs';
const options={};
for(let i=2;i<process.argv.length;i+=2) {
  const key=process.argv[i],value=process.argv[i+1];
  if(!['--assets','--output','--edits'].includes(key)||!value||options[key]!==undefined)throw new Error('Invalid editor argument: '+key);
  options[key]=value;
}
if(!options['--assets']||!options['--output'])throw new Error('Choose exact assets and an output report.');
const assets=path.resolve(options['--assets']),edits=Number(options['--edits']??120);
if(!Number.isInteger(edits)||edits<100||edits>200)throw new Error('Edits must be 100–200.');
const {BlockEditor}=await import(pathToFileURL(path.join(assets,'block-editor.mjs')));
const {document,window}=parseHTML('<html><body><main id="editor"></main></body></html>');
Object.assign(globalThis,{document,window,getSelection:()=>null});
let lastSource=null;
const editor=new BlockEditor(document.getElementById('editor'),{onChange:source=>lastSource=source});
const corpus=fixture(100),small=readFileSync(path.join(corpus.root,'docs/plans/item-00003.md'),'utf8').split('---\n').slice(2).join('---\n'),large=readFileSync(path.join(corpus.root,corpus.large),'utf8').split('---\n').slice(2).join('---\n');
const report={startedAt:new Date().toISOString(),assets,measurementNode:process.version,execArgv:process.execArgv,harnessSha256:sha256(import.meta.filename),identity:Object.fromEntries(['block-editor.mjs','block-model.mjs','shared.mjs'].map(file=>[file,sha256(path.join(assets,file))])),forcedGC:false,rendererQualified:false,safetyCeiling:{heapUsedMiB:220,rssMiB:512},workloads:[],limitations:['Runs the actual editor in Node/linkedom, not macOS WebKit.','Selection/ranges, native focus, paint and typing-to-frame latency are not measured.','Memory is the whole benchmark Node process, including linkedom and measurement dependencies.','The 220 MiB heap/512 MiB RSS safety ceiling bounds this Node fixture; it is not a native renderer release budget.']};
const memory=()=>Object.fromEntries(Object.entries(process.memoryUsage()).map(([key,bytes])=>[key,round(bytes/MiB)]));
try {
  for(const [name,body] of [['small',small],['large-unicode',large]]) {
    const before=memory(),start=performance.now();editor.set(body);
    if(editor.source()!==body)throw new Error('Source bytes changed during editor load.');
    const loadMs=round(performance.now()-start),afterLoad=memory(),timings=[],samples=[];
    let sampledPeakRSSMiB=afterLoad.rss,sampledPeakHeapMiB=afterLoad.heapUsed;
    let stoppedForMemory=false,completed=0;
    const target=editor.root.querySelector('.block-paragraph [data-editable]');
    if(!target)throw new Error('Missing editable paragraph.');
    const original=target.textContent;
    for(let i=0;i<edits;i++) {
      target.textContent=original+' Edit '+i+'.';
      const start=performance.now();
      editor.input({target,inputType:'insertFromPaste'}); // Separate undo groups, as paste/format actions are.
      timings.push(performance.now()-start);completed++;
      const current=memory();sampledPeakRSSMiB=Math.max(sampledPeakRSSMiB,current.rss);sampledPeakHeapMiB=Math.max(sampledPeakHeapMiB,current.heapUsed);
      const overCeiling=current.heapUsed>220||current.rss>512;
      if(i%10===9||overCeiling) {
        const sample={edit:i+1,...current,undoEntries:editor.history.length};samples.push(sample);
        console.log(JSON.stringify({stage:'editor-edit',name,...sample}));
        if(overCeiling){stoppedForMemory=true;break;}
        await new Promise(resolve=>setImmediate(resolve));
      }
    }
    if(lastSource!==editor.source()||!lastSource.endsWith(body.slice(body.lastIndexOf('## Work')))&&name==='small')throw new Error('Editor update source did not round-trip.');
    const edited=memory(),historyEntries=editor.history.length;
    editor.set(small);lastSource=null;
    await new Promise(resolve=>setTimeout(resolve,1000));
    const switched=memory();
    report.workloads.push({name,sourceBytes:Buffer.byteLength(body),sourceUTF16Bytes:body.length*2,requestedEdits:edits,completedEdits:completed,stoppedForMemory,loadMs,sampledPeakRSSMiB,sampledPeakHeapMiB,edit:{samples:timings.length,medianMs:percentile(timings,.5),p95Ms:percentile(timings,.95),maxMs:round(Math.max(...timings))},historyEntries,before,afterLoad,edited,afterSwitch:switched,samples});
  }
  report.completedAt=new Date().toISOString();
  report.componentBudgetsPass=report.workloads.every(w=>!w.stoppedForMemory&&w.completedEdits===edits&&w.edit.p95Ms<=(w.name==='small'?50:250));
  writeFileSync(options['--output'],JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({stage:'editor-complete',componentBudgetsPass:report.componentBudgetsPass,rendererQualified:false}));
  if(!report.componentBudgetsPass)process.exitCode=1;
}catch(error){report.error={message:error.message};writeFileSync(options['--output'],JSON.stringify(report,null,2)+'\n');throw error;}
finally {corpus.close();}
