import { it } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { spawnSync } from 'node:child_process';

it('retains metadata and record fragments rather than large document buffers across refreshes', () => {
  // A separate heap and explicit collection make this a retained-memory check,
  // independent of test-runner concurrency and macOS compression/residency.
  const child = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', `
    import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync } from 'node:fs';
    import os from 'node:os'; import path from 'node:path';
    import {resolveConfig} from './src/config.mjs';
    import {createDocumentLibrary} from './src/app-library.mjs';
    import {createRecordLibrary} from './src/app-records.mjs';
    import {searchCheckout} from './src/app-search.mjs';
    const root=mkdtempSync(path.join(os.tmpdir(),'runlist-memory-'));
    const measure=()=>{global.gc();global.gc();return process.memoryUsage().heapUsed;};
    try {
      mkdirSync(path.join(root,'docs/plans'),{recursive:true});
      writeFileSync(path.join(root,'runlist.config.mjs'),"export const root='docs';");
      const padding='A large unrelated narrative paragraph. '.repeat(14_000);
      for(let i=0;i<120;i++)writeFileSync(path.join(root,'docs/plans',i+'.md'),
        '---\\ntype: plan\\nstatus: active\\nparent_plan: an-example-parent-hub.md\\n---\\n# A sufficiently long heading '+i+'\\n\\n'+padding+'\\n\\n## Decisions\\n\\n### D1 Which bin?\\nDisposition: OPEN.\\n\\nQuestion: Which bin?\\nAlternatives: Red or blue.\\n\\n## Work\\n\\n- [ ] Wait for D1.\\n');
      const config=await resolveConfig(root),baseline=measure(),library=createDocumentLibrary(config);
      await library.refresh();const metadata=measure()-baseline;
      const records=createRecordLibrary({config,library,readSource:(_,file)=>({source:readFileSync(path.join(root,file),'utf8')}),evidence:()=>({})});
      let retained;
      for(let i=0;i<3;i++){
        const result=await records.query(null,'decisions',new URLSearchParams('refresh=1'));
        if(result.total!==120)throw new Error('Missing decision records');
        retained=measure()-baseline;
      }
      const searchBaseline=measure();
      let searchResult;
      for(let i=0;i<3;i++)searchResult=await searchCheckout(config,library,new URLSearchParams('q=sufficiently&limit=100'));
      if(searchResult.total!==120||searchResult.sections.length!==100)throw new Error('Missing search results');
      await new Promise(resolve=>setImmediate(resolve));
      const searchRetained=measure()-searchBaseline;
      console.log(JSON.stringify({metadata,retained,searchRetained}));
    } finally {rmSync(root,{recursive:true,force:true});}
  `], { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 60_000 });
  strictEqual(child.status, 0, child.stderr);
  const { metadata, retained, searchRetained } = JSON.parse(child.stdout.trim());
  ok(metadata < 8 * 1024 * 1024, `Metadata retained ${(metadata / 1024 / 1024).toFixed(1)} MiB`);
  ok(searchRetained < 4 * 1024 * 1024, `Search retained ${(searchRetained / 1024 / 1024).toFixed(1)} MiB`);
  ok(retained < 12 * 1024 * 1024, `Records retained ${(retained / 1024 / 1024).toFixed(1)} MiB`);
});
