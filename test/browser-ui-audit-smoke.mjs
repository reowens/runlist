// Optional real-browser audit regression; uses browser-app-smoke's external setup.
import {strictEqual,ok} from 'node:assert';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import os from 'node:os';import path from 'node:path';
import {startApp} from '../src/app.mjs';import {resolveConfig} from '../src/config.mjs';
const playwright=await import(pathToFileURL(process.env.RUNLIST_PLAYWRIGHT_MODULE).href);
const repo=mkdtempSync(path.join(os.tmpdir(),'runlist-browser-ui-audit-')),artifacts=mkdtempSync(path.join(os.tmpdir(),'runlist-ui-audit-evidence-'));
mkdirSync(path.join(repo,'docs/plans'),{recursive:true});writeFileSync(path.join(repo,'runlist.config.mjs'),"export const root='docs';\n");
const file=path.join(repo,'docs/plans/long-title.md'),source=`---\ntype: plan\nstatus: active\n---\n# ${'A long document title with useful context '.repeat(4)}\n\nOriginal paragraph.\n\n${'More document content.\n\n'.repeat(80)}`;
writeFileSync(file,source);
for(const args of [['init','-q'],['add','.'],['-c','user.name=Fixture','-c','user.email=fixture@example.com','commit','-qm','Fixture']]){const result=spawnSync('git',args,{cwd:repo,encoding:'utf8'});strictEqual(result.status,0,result.stderr);}
const app=await startApp({config:await resolveConfig(repo),port:0,initialPath:'docs/plans/long-title.md'}),browser=await playwright.chromium.launch({headless:true,executablePath:process.env.RUNLIST_CHROME_EXECUTABLE}),page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
page.on('pageerror',error=>errors.push(error.message));
const frames=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
const mainPrimaries=()=>page.locator('#main button.primary:visible').count();
try{
 await page.goto(app.launchUrl);await page.locator('#edit:not([disabled])').waitFor();await page.locator('#edit').click();
 strictEqual(await page.locator('#editing [data-editable]:focus').count(),1);
 const paragraph=page.locator('.block-paragraph [data-editable]').first();await paragraph.fill('Draft paragraph.');await paragraph.press('End');await paragraph.press('!');
 strictEqual(await paragraph.evaluate(el=>el===document.activeElement),true);strictEqual(await mainPrimaries(),1);
 await page.locator('#review').click();strictEqual(await page.locator('#reviewing:focus').count(),1);strictEqual(await mainPrimaries(),1);strictEqual(await page.locator('#edit').isVisible(),false);
 strictEqual(readFileSync(file,'utf8'),source);await page.locator('#back-edit').click();strictEqual(await page.locator('#editing [data-editable]:focus').count(),1);
 await page.locator('#toggle-outline').click();await page.locator('.file-evidence > summary').click();await page.locator('#toggle-markdown').click();await page.locator('#review').click();await page.locator('#back-edit').click();strictEqual(await page.locator('#body-editor:focus').count(),1);
 await page.locator('#discard').click();await page.locator('#tab-read').click();
 await page.evaluate(()=>{const sheet=document.styleSheets[0];for(const rule of ['.app-header,.document-toolbar,.view-tabs{font-size:24px}', '.app-header *,.document-toolbar *,.view-tabs *{font-size:inherit!important}'])sheet.insertRule(rule,sheet.cssRules.length);});
 for(const width of [1440,1121,740,390]){
  await page.setViewportSize({width,height:900});await frames();
  await page.evaluate(()=>window.scrollTo(0,550));await frames();
  const layout=await page.evaluate(()=>{const rect=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height};};return {header:rect('.app-header'),toolbar:rect('.document-toolbar'),tabs:rect('.view-tabs'),overflow:document.documentElement.scrollWidth>innerWidth};});
  strictEqual(layout.overflow,false,`horizontal overflow at ${width}`);
  if(width>1120){ok(layout.toolbar.top>=layout.header.bottom-1,JSON.stringify(layout));ok(layout.tabs.top>=layout.toolbar.bottom-1,JSON.stringify(layout));}
  await page.screenshot({path:path.join(artifacts,`large-text-${width}.png`)});
 }
 await page.setViewportSize({width:1440,height:900});await page.goto(app.launchUrl);await page.locator('#edit:not([disabled])').waitFor();await page.locator('#library-changes').click();await page.waitForFunction(()=>document.getElementById('changes-list').getAttribute('aria-busy')==='false');
 strictEqual(await page.locator('#changes-list').innerText(),'No saved document changes.');for(const selector of ['.changes-selection','#changes-review','.changes-home .library-pagination','.changes-footer'])strictEqual(await page.locator(selector).isVisible(),false,selector);
 await page.screenshot({path:path.join(artifacts,'changes-empty-light.png')});
 await page.route('**/api/git/status?*',route=>route.fulfill({json:{available:true,reason:'Finish the current merge with Git first.',changes:[],changedDocuments:0,total:0}}));await page.locator('#changes-refresh').click();await page.waitForFunction(()=>document.getElementById('changes-feedback').textContent.includes('current merge'));await page.unroute('**/api/git/status?*');
 await page.route('**/api/git/status?*',route=>route.fulfill({json:{available:false,reason:'This folder does not use Git.',changes:[],total:0}}));await page.locator('#changes-refresh').click();await page.waitForFunction(()=>document.getElementById('changes-feedback').textContent.includes('does not use Git'));strictEqual(await page.locator('#changes-review').isVisible(),false);
 await page.locator('#open-templates').click();await page.locator('#template-dialog[open]').waitFor();strictEqual(await page.locator('#template-feedback').isVisible(),false);strictEqual(await page.locator('#template-tokens').isVisible(),false);
 await page.locator('#template-source').fill((await page.locator('#template-source').inputValue())+'\nExtra context.\n');strictEqual(await page.locator('#template-feedback').innerText(),'Unsaved changes');strictEqual(await page.locator('#template-discard').isEnabled(),true);await page.locator('#template-review-button').click();strictEqual(await page.locator('#template-review-button').isVisible(),false);strictEqual(await page.locator('#template-save').isVisible(),true);strictEqual(await page.locator('#template-source').inputValue().then(text=>text.endsWith('Extra context.\n')),true);
 await page.screenshot({path:path.join(artifacts,'template-review-light.png')});strictEqual(errors.length,0,JSON.stringify(errors));console.log(JSON.stringify({passed:true,checks:['primary focus without rerender focus stealing','one primary action and explicit reviewed save','Markdown focus restoration','long titles and enlarged text at four widths','quiet empty Changes and non-Git explanation','template progressive disclosure and one save action'],artifacts}));
}finally{await browser.close();await app.close();rmSync(repo,{recursive:true,force:true});}
