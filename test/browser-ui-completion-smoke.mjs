import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL(process.env.RUNLIST_PLAYWRIGHT_MODULE).href);
import {startApp} from '../src/app.mjs';
import {resolveConfig} from '../src/config.mjs';
import {nativeFixture,nativeSource,owner} from './native-fixtures.mjs';
const root=mkdtempSync(path.join(os.tmpdir(),'runlist-ui-audit-'));
const artifacts=mkdtempSync(path.join(os.tmpdir(),'runlist-ui-completion-evidence-'));
for(const dir of ['docs/plans','docs/reference','docs/flags','docs/decisions'])mkdirSync(path.join(root,dir),{recursive:true});
writeFileSync(path.join(root,'runlist.config.mjs'),"export const root='docs';\nexport const filing=true;\n");
for(const [i,title] of ['Improve desktop navigation and simplify document editing for every project workspace','Prepare the release','Review document editing'].entries())writeFileSync(path.join(root,`docs/plans/plan-${i+1}.md`),`---\ntype: plan\nstatus: active\ntitle: ${title}\nupdated: 2026-10-21\n---\n# ${title}\n\nA short description of the project work.\n\n${i===0?Array.from({length:20},(_,n)=>`Project note ${n+1}. This longer document exercises scrolling and the sticky document controls.\n\n`).join(''):''}## Work\n\n- [ ] Improve the document workflow.\n\n## Version History\n\n- Initial plan.\n`);
writeFileSync(path.join(root,'docs/reference/guide.md'),'---\ntype: doc\nstatus: active\n---\n# Editing guide\n\nProject reference material.\n');
writeFileSync(path.join(root,'docs/plans/hub.md'),'---\ntype: plan\nstatus: active\nexecution_mode: coordination\nrunlist: [plan-1.md, plan-2.md, plan-3.md]\n---\n# Desktop project\n\n| Plan | Status |\n| --- | --- |\n| [Navigation](plan-1.md) | active |\n');
writeFileSync(path.join(root,'docs/flags/native.md'),nativeSource(nativeFixture('flag')));
writeFileSync(path.join(root,'docs/decisions/native.md'),nativeSource());
writeFileSync(path.join(root,'.gitignore'),'.runlist/\n');
execFileSync('git',['init','--quiet'],{cwd:root});execFileSync('git',['add','.'],{cwd:root});execFileSync('git',['-c','user.name=UI Audit','-c','user.email=audit@example.test','-c','commit.gpgsign=false','commit','--quiet','-m','Audit fixture'],{cwd:root});
const app=await startApp({config:await resolveConfig(root),port:0,initialPath:'docs/plans/plan-1.md',actor:owner});
const browser=await chromium.launch({headless:true,executablePath:process.env.RUNLIST_CHROME_EXECUTABLE});
const context=await browser.newContext({viewport:{width:1280,height:850},colorScheme:'dark'});
const page=await context.newPage();page.setDefaultTimeout(7000);
const results=[],pageErrors=[];page.on('pageerror',e=>pageErrors.push(e.message));
const save=()=>writeFileSync(path.join(artifacts,'results.json'),JSON.stringify({scope:'Shared desktop UI rendered in Chromium; isolated local fixture; no installed native-app verification',results,pageErrors},null,2));
const shot=async name=>{const file=path.join(artifacts,name+'.png');await page.screenshot({path:file});return file;};
const attempt=async(name,fn)=>{try{const evidence=await fn();results.push({name,...evidence});console.log(JSON.stringify({name,...evidence}));}catch(error){results.push({name,error:error.message});console.log(JSON.stringify({name,error:error.message}));}save();};
const home=async()=>{await page.evaluate(()=>{for(const dialog of document.querySelectorAll('dialog[open]'))dialog.close();});await page.locator('#library-home').click();await page.locator('#empty').waitFor();};
const listReady=()=>page.waitForFunction(()=>document.getElementById('record-results')?.getAttribute('aria-busy')==='false');


try {
 await page.goto(app.launchUrl);await page.locator('#edit').waitFor();
 await attempt('Pins are labeled, durable, and roll back storage failures',async()=>{
  const pin=page.locator('#pin-document');assert.equal(await pin.innerText(),'Pin');assert.match(await pin.getAttribute('title'),/Pinned/);
  await page.evaluate(()=>{window.realSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('runlist:library:'))throw new Error('Storage denied');return window.realSetItem.call(this,k,v);};});
  await pin.click();assert.equal(await pin.getAttribute('aria-pressed'),'false');assert.equal(await page.locator('#library-saved-section').isVisible(),false);
  await page.locator('#notice').filter({hasText:'Could not save'}).waitFor();await page.waitForTimeout(3500);assert.equal(await page.locator('#notice').isVisible(),true);
  await page.evaluate(()=>Storage.prototype.setItem=window.realSetItem);await pin.click();assert.equal(await pin.innerText(),'Pinned');
  await page.reload();await pin.waitFor();assert.equal(await pin.getAttribute('aria-pressed'),'true');
  await page.evaluate(()=>{window.realSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('runlist:library:'))throw new Error('Storage denied');return window.realSetItem.call(this,k,v);};});
  await pin.click();assert.equal(await pin.getAttribute('aria-pressed'),'true');await page.evaluate(()=>Storage.prototype.setItem=window.realSetItem);
  await home();await page.route('**/api/library?**',route=>route.fulfill({status:503,json:{message:'Library unavailable'}}));
  await page.locator('#filter').fill('missing');await page.locator('#library-retry').waitFor();await page.locator('#library-saved .plan').click();await pin.waitFor();await pin.click();assert.equal(await pin.getAttribute('aria-pressed'),'false');
  await page.unroute('**/api/library?**');await page.reload();await pin.waitFor();assert.equal(await pin.getAttribute('aria-pressed'),'false');
  return {screenshot:await shot('labeled-pin')};
 });
 await attempt('Clean documents skip empty Review; real drafts still review and discard',async()=>{
  assert.equal(await page.locator('#tab-review').isDisabled(),true);assert.equal(await page.locator('#tab-review').isVisible(),false);await page.locator('#tab-source').focus();await page.keyboard.press('ArrowLeft');assert.equal(await page.locator('#tab-edit').getAttribute('aria-selected'),'true');
  await page.locator('.block-paragraph [data-editable]').first().fill('Reviewed completion check.');assert.equal(await page.locator('#tab-review').isEnabled(),true);
  await page.locator('#review').click();assert.equal(await page.locator('#save').isEnabled(),true);await page.locator('#back-edit').click();await page.locator('#discard').click();assert.equal(await page.locator('#tab-review').isDisabled(),true);
  assert.equal(await page.locator('#toggle-markdown').isVisible(),false);await page.locator('#toggle-outline').click();await page.locator('.file-evidence > summary').click();await page.locator('#toggle-markdown').click();assert.equal(await page.locator('#body-editor').isVisible(),true);assert.equal(await page.locator('#body-editor:focus').count(),1);
  await page.locator('#toggle-outline').click();await page.locator('#toggle-markdown').click();assert.equal(await page.locator('#block-editor').isVisible(),true);
  return {screenshot:await shot('quiet-editor')};
 });
 await attempt('Success notices expire while errors remain visible',async()=>{
  await page.locator('#tab-source').click();await page.locator('#copy-source').click();await page.locator('#notice').filter({hasText:'Source copied.'}).waitFor();await page.locator('#notice').waitFor({state:'hidden',timeout:5000});
  return {screenshot:await shot('no-lingering-notice')};
 });
 await attempt('New document defaults to writing fields and keeps file customization usable',async()=>{
  await page.locator('#new-document').click();await page.locator('#create-dialog[open]').waitFor();
  for(const id of ['create-status','create-folder','create-filename','create-origin'])assert.equal(await page.locator('#'+id).isVisible(),false,id);
  assert.equal(await page.locator('#create-template').isVisible(),true);assert.equal(await page.locator('#create-name').isVisible(),true);assert.equal(await page.locator('#create-body').isVisible(),true);
  await page.locator('#create-name').fill('A useful reference');assert.equal(await page.locator('#create-filename').inputValue(),'a-useful-reference.md');
  const screenshot=await shot('simple-new-document');
  await page.setViewportSize({width:390,height:850});assert.equal(await page.locator('#create-dialog').evaluate(e=>e.scrollWidth>e.clientWidth),false);await shot('simple-new-document-narrow');await page.setViewportSize({width:1280,height:850});
  await page.locator('#create-file-options > summary').click();await page.locator('#create-filename').fill('invalid name.md');await page.locator('#create-file-options > summary').click();await page.locator('#create-preview-button').click();assert.equal(await page.locator('#create-file-options').evaluate(e=>e.open),true);
  await page.locator('#create-filename').fill('custom-reference.md');await page.locator('#create-name').fill('A renamed reference');assert.equal(await page.locator('#create-filename').inputValue(),'custom-reference.md');
  await page.locator('#create-preview-button').click();await page.locator('#create-review').waitFor();assert.match(await page.locator('#create-path').innerText(),/custom-reference\.md$/);
  await page.locator('#create-confirm').click();await page.locator('#create-dialog').waitFor({state:'hidden'});await page.waitForFunction(()=>document.getElementById('doc-path').textContent.endsWith('custom-reference.md'));
  return {screenshot};
 });
 for(const kind of ['flags','decisions'])await attempt(`${kind}: pending and failed search removes old rows; Retry preserves query`,async()=>{
  await page.locator('#library-'+kind).click();await listReady();assert.equal(await page.locator('.record-row').count(),1);
  let fail=true;await page.route('**/api/records?**',route=>new URL(route.request().url()).searchParams.get('q')==='absent-record-completion'&&fail?route.fulfill({status:503,json:{message:'Record search failed'}}):route.continue());
  await page.locator('#record-search').fill('absent-record-completion');assert.equal(await page.locator('.record-row').count(),0);await page.locator('#record-retry').waitFor();assert.equal(await page.locator('.record-row').count(),0);assert.equal(await page.locator('#record-next').isDisabled(),true);
  const screenshot=await shot(kind+'-search-error');fail=false;await page.locator('#record-retry').click();await page.waitForFunction(()=>document.getElementById('record-range').textContent==='0 records');assert.equal(await page.locator('#record-search').inputValue(),'absent-record-completion');await page.unroute('**/api/records?**');
  return {screenshot};
 });

 await attempt('Back names the destination, preserves search and drafts, and stays readable at every width',async()=>{
  await home();await page.locator('#library-plans').click();await page.locator('#filter').fill('Prepare the release');await page.waitForFunction(()=>document.querySelectorAll('#plans .plan').length===1);await page.locator('#plans .plan').click();
  assert.equal(await page.locator('#back-library').innerText(),'← Back to search results');await page.locator('#edit').click();await page.locator('.block-paragraph [data-editable]').first().fill('Keep this draft when returning to results.');await page.locator('#back-library').click();
  assert.equal(await page.locator('#filter').inputValue(),'Prepare the release');assert.equal(await page.locator('#library-kind').inputValue(),'plans');assert.equal(await page.locator('#plans .plan').count(),1);
  await page.locator('#plans .plan').click();await page.locator('#recover').click();assert.equal(await page.locator('.block-paragraph [data-editable]').first().innerText(),'Keep this draft when returning to results.');await page.locator('#discard').click();
  await page.locator('#back-library').click();await page.locator('#filter').fill('');await page.waitForFunction(()=>document.querySelectorAll('#plans .plan').length===3);await page.locator('#plans .plan').first().click();assert.equal(await page.locator('#back-library').innerText(),'← Back to plans');
  for(const width of [1440,1024,800,390])for(const theme of ['light','dark']){
   await page.setViewportSize({width,height:900});await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
   const layout=await page.evaluate(()=>{const back=document.getElementById('back-library').getBoundingClientRect(),title=document.getElementById('doc-title').getBoundingClientRect();return {overflow:document.documentElement.scrollWidth>innerWidth,backHeight:back.height,backBottom:back.bottom,titleTop:title.top,bodyFont:parseFloat(getComputedStyle(document.getElementById('reading')).fontSize),navFont:parseFloat(getComputedStyle(document.getElementById('library-all')).fontSize)};});
   assert.equal(layout.overflow,false,JSON.stringify({width,theme,layout}));assert.ok(layout.backHeight>=40);assert.ok(layout.titleTop>layout.backBottom);assert.ok(layout.bodyFont>=16);assert.ok(layout.navFont>=15);
   await shot('readability-'+width+'-'+theme);
  }
  return {screenshot:await shot('clear-back-and-readable-document')};
 });
 assert.deepEqual(pageErrors,[]);const failures=results.filter(r=>r.error);console.log(JSON.stringify({passed:!failures.length,checks:results.length,failures,artifacts}));process.exitCode=failures.length?1:0;
}finally{await browser.close();await app.close();rmSync(root,{recursive:true,force:true});}
