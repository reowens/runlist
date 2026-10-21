import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { authorizeRepoGeneratedPath } from './managed-path.mjs';
import { mutateFileSet, MutationConflictError } from './atomic-mutation.mjs';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { HANDOFF_TEMPLATES } from './prompt-handoff.mjs';

export const templateFile = 'runlist.templates.json';
export const templateNames = ['doc','plan','prompt',...Object.keys(HANDOFF_TEMPLATES)];
const tokens = new Set(['title','status','date','body','version']);
const revision = text => createHash('sha256').update(text).digest('hex');
function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
export function validateTemplate(name, source) {
  if (!templateNames.includes(name)) fail('invalid-template','Choose a doc, plan, prompt, resume or subagent template.');
  if (typeof source !== 'string' || !source.trim() || Buffer.byteLength(source) > 128 * 1024) fail('invalid-template','Template must be nonempty Markdown smaller than 128 KB.');
  const parts = extractFrontmatter(source), metadata=parseSimpleFrontmatter(parts.frontmatter);
  if (Object.hasOwn(HANDOFF_TEMPLATES,name)) {
    for (const match of source.matchAll(/\{\{([^{}]+)\}\}/g)) if (name !== 'handoff:subagent' || match[1] !== 'parent_prompt') fail('invalid-template',`Unknown placeholder: {{${match[1]}}}.`);
    if (name === 'handoff:subagent' && (!source.startsWith('---\n') || metadata.parent_prompt !== '{{parent_prompt}}' || (parts.frontmatter.match(/^parent_prompt:/gm)??[]).length !== 1)) fail('invalid-template','Keep parent_prompt: {{parent_prompt}} in the subagent frontmatter.');
    if (name === 'handoff:resume' && Object.hasOwn(metadata,'parent_prompt')) fail('invalid-template','A resume draft cannot have its own parent_prompt; use the subagent draft for child handoffs.');
    if (['type','status','created','updated'].some(key=>Object.hasOwn(metadata,key))) fail('invalid-template','Handoff drafts contain authored content; saved prompt metadata is supplied by the prompt scaffold.');
    return parts;
  }
  if (!source.startsWith('---\n') || metadata.type !== name) fail('invalid-template',`Keep the frontmatter and type: ${name}.`);
  for (const match of source.matchAll(/\{\{([^{}]+)\}\}/g)) if (!tokens.has(match[1])) fail('invalid-template',`Unknown placeholder: {{${match[1]}}}.`);
  if (!/\{\{title\}\}/.test(parts.body) && name !== 'prompt') fail('invalid-template','Keep {{title}} in the document body.');
  if (metadata.status !== '{{status}}' || metadata.created !== '{{date}}' || metadata.updated !== '{{date}}' || ['type','status','created','updated'].some(key=>(parts.frontmatter.match(new RegExp(`^${key}:`, 'gm'))??[]).length!==1)) fail('invalid-template','Keep status: {{status}}, created: {{date}} and updated: {{date}}.');
  if (!parts.body.includes('{{body}}')) fail('invalid-template','Keep {{body}} so authored content is preserved.');
  return parts;
}
export function readTemplateStore(config) {
  const file = authorizeRepoGeneratedPath(path.join(config.repoRoot,templateFile),config).path;
  let source = null;
  if (existsSync(file)) {
    if (!statSync(file).isFile() || statSync(file).size > 512 * 1024) fail('invalid-template','Template settings must be a regular file smaller than 512 KB.');
    source = readFileSync(file,'utf8');
  }
  let data = {version:1,templates:{}};
  if (source !== null) {
    try { data = JSON.parse(source); } catch { fail('invalid-template','runlist.templates.json contains invalid JSON.'); }
    if (!data || typeof data !== 'object' || data.version !== 1 || !data.templates || typeof data.templates !== 'object' || Array.isArray(data.templates) || Object.keys(data).some(k=>!['version','templates'].includes(k))) fail('invalid-template','Unsupported template settings format.');
    for (const [name,value] of Object.entries(data.templates)) {
      if (!value || Object.keys(value).some(k=>k!=='source')) fail('invalid-template','Template settings accept a Markdown source field.');
      validateTemplate(name,value.source);
    }
  }
  return {file,source,data,revision:source === null ? null : revision(source)};
}
export function saveTemplate(config,{name,source,expectedRevision,reset=false}) {
  if (!templateNames.includes(name)) fail('invalid-template','Choose a doc, plan, prompt, resume or subagent template.');
  if (!reset) validateTemplate(name,source);
  const store = readTemplateStore(config);
  if (expectedRevision !== store.revision) fail('template-conflict','Templates changed in another tab or process. Your draft is kept; reload the saved templates before trying again.');
  if (reset) delete store.data.templates[name]; else store.data.templates[name] = {source};
  const content = JSON.stringify(store.data,null,2)+'\n';
  if (Buffer.byteLength(content) > 512 * 1024) fail('invalid-template','Combined template settings must be smaller than 512 KB.');
  try { mutateFileSet(store.source === null ? {creations:[{path:store.file,content}]} : {updates:[{path:store.file,expectedContent:store.source,content}]},{repoRoot:config.repoRoot}); }
  catch (error) { if (error instanceof MutationConflictError) fail('template-conflict','Templates changed while saving. Your draft is kept.'); throw error; }
  return {revision:revision(content)};
}
export function applyTemplateOverride(name,base,config,version) {
  // Markdown document overrides apply only to the three built-in types.
  if (!['doc','plan','prompt'].includes(name)) return base;
  const source = readTemplateStore(config).data.templates[name]?.source;
  if (source === undefined) return base;
  const parts = validateTemplate(name,source);
  const fill = (text, values) => text.replace(/\{\{(title|status|date|body|version)\}\}/g,(_,key)=>values[key] ?? '');
  const values = (title,ctx) => ({title,status:ctx.status,date:ctx.today,body:ctx.bodyInput?.trim() ?? '',version:ctx.version ?? version ?? ''});
  return {...base,_overridesBuiltin:true,acceptsBody:true,
    frontmatter:(status,date,ctx)=>fill(parts.frontmatter,{...values(ctx.title,ctx),title:JSON.stringify(ctx.title??'').slice(1,-1),status,date}),
    body:(title,ctx)=>fill(parts.body,values(title,ctx))};
}
