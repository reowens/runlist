import path from 'node:path';
import { readFileSync } from 'node:fs';
import { gateDeclarations, parseGate } from './gate-source.mjs';
import { extractFrontmatter } from './frontmatter.mjs';
import { maskInlineCodeLine } from './markdown-code-spans.mjs';
import { walkSections } from './section.mjs';
import { analyzeDecisionItems, parseDecisionItems } from './decisions.mjs';

export { gateField } from './gate-source.mjs';
export function createGateReader(docs, config) {
  const byPath = new Map(docs.map(d => [d.path,d]));
  const sources = new Map();
  const source = rel => {
    if (!sources.has(rel)) {
      try { sources.set(rel,readFileSync(path.join(config.repoRoot,rel),'utf8')); } catch { sources.set(rel,null); }
    }
    return sources.get(rel);
  };
  let decisions;
  const settings = config.raw?.decisions ?? {};
  const readDecisions = () => decisions ??= analyzeDecisionItems(docs.flatMap(d => {
    const text = source(d.path);
    return text == null ? [] : parseDecisionItems(text, settings).map(item => ({...item,doc:d.path,docTitle:d.title}));
  }), settings);
  function read(rel) {
    const text = source(rel);
    if (text == null) return {review:'unreviewed', entries:[], diagnostics:['source unavailable']};
    const declared = gateDeclarations(text, config);
    const entries = declared.entries.map(({raw,line}) => {
      const {kind,ref} = parseGate(raw);
      const entry = {kind, raw, source:{path:rel,line}, locations:[line], diagnostic:'unevaluated'};
      if (kind === 'none') { entry.diagnostic = ref ? 'declared-none' : 'invalid-none'; return entry; }
      if (!['plan','decision'].includes(kind)) return entry;
      const split = ref.indexOf('#');
      const file = split < 0 ? ref : ref.slice(0,split);
      let fragment;
      try { fragment = split < 0 ? null : decodeURIComponent(ref.slice(split+1)); } catch { entry.diagnostic='unsupported-fragment'; return entry; }
      if (!/\.md$/i.test(file)) return entry;
      let decoded;
      try { decoded = decodeURIComponent(file); } catch { entry.diagnostic='unsupported-path'; return entry; }
      const candidates = [...new Set([path.resolve(config.repoRoot,path.dirname(rel),decoded),path.resolve(config.repoRoot,decoded)].map(p=>path.relative(config.repoRoot,p).split(path.sep).join('/')))].filter(p=>byPath.has(p));
      if (candidates.length !== 1) { entry.diagnostic = candidates.length ? 'ambiguous-target' : 'missing-or-excluded-target'; return entry; }
      const target = candidates[0];
      entry.target = {path:target, fragment, status:byPath.get(target).status};
      if (kind === 'decision') {
        if (!fragment) return entry;
        const found = readDecisions().filter(d=>d.doc===target && d.id===fragment);
        if (found.length !== 1) { entry.diagnostic=found.length ? 'ambiguous-decision' : 'missing-decision'; return entry; }
        const decision = found[0];
        entry.observed = {disposition:decision.effective ?? decision.disposition, text:decision.text, peers:decision.peers.map(p=>({path:p.doc,line:p.line})), classification:'legacy analyzer; may include prose inference'};
        entry.diagnostic='resolved-unevaluated';
      } else if (fragment != null) {
        const targetText = source(target);
        if (targetText == null) { entry.diagnostic='source-unavailable'; return entry; }
        const {body,bodyLineOffset} = extractFrontmatter(targetText);
        const slug = h => h.toLowerCase().replace(/<[^>]*>/g,'').replace(/[^\p{L}\p{N}_\s-]/gu,'').replace(/ /g,'-');
        const headings = walkSections(body).filter(s=>slug(s.heading)===fragment).map(s=>({line:s.lineStart+(bodyLineOffset ?? 0),heading:s.heading}));
        let fence = null;
        const anchors = [];
        targetText.split(/\r?\n/).forEach((l,i)=>{
          const f=/^ {0,3}(`{3,}|~{3,})/.exec(l); if(f){fence=fence===null ? f[1][0] : fence===f[1][0] ? null : fence;return;}
          if(fence!==null || /^ {4}/.test(l))return;
          for(const m of maskInlineCodeLine(l).matchAll(/<(?:a|span)\b[^>]*\b(?:id|name)=["']([^"']+)["'][^>]*>/g))if(m[1]===fragment)anchors.push({line:i+1});
        });
        const matches = anchors.length ? anchors : headings;
        if(matches.length!==1){entry.diagnostic=matches.length ? 'ambiguous-fragment' : 'missing-fragment';return entry;}
        entry.target = {...entry.target,...matches[0]}; entry.diagnostic='resolved-unevaluated';
      } else entry.diagnostic='resolved-unevaluated';
      return entry;
    });
    const deduped = [];
    for(const entry of entries){const prior=deduped.find(e=>e.raw===entry.raw);if(prior)prior.locations.push(entry.source.line);else deduped.push(entry);}
    const none = entries.filter(e=>e.kind==='none');
    const diagnostics = none.length && (entries.length!==1 || !none[0].raw.replace(/^none:\s*/,'')) ? ['none must be a sole nonempty declaration'] : [];
    if(diagnostics.length)for(const e of deduped)if(e.kind==='none')e.diagnostic='invalid-none';
    return {field:declared.field, review:!entries.length ? 'unreviewed' : none.length===1 && entries.length===1 && !diagnostics.length ? 'declared-none' : 'declared', entries:deduped, diagnostics, legacyBlockers:byPath.get(rel)?.blockers ?? []};
  }
  return read;
}

export function gateSummary(gates, limit = 3) {
  const entries = gates.entries.slice(0,limit).map(e=>({...e,raw:e.raw.slice(0,160),rawTruncated:e.raw.length>160, ...(e.observed ? {observed:{disposition:e.observed.disposition}} : {})}));
  return {review:gates.review,total:gates.entries.length,omitted:gates.entries.length-entries.length,entries,diagnostics:gates.diagnostics, more:'runlist deps <file> --json'};
}
export function gateLines(gates) {
  return [
    `Gates: ${gates.review} (acceptance unevaluated)`,
    ...(gates.entries ?? []).filter(Boolean).map(e => `  ${e.dependent ? e.dependent + ': ' : ''}${e.raw} [${e.diagnostic}]${e.rawTruncated ? ' [text clipped; see deps]' : ''}`),
    ...(gates.diagnostics ?? []).map(d => `  ${d}`),
    ...(gates.truncated ? [`Truncated: ${(gates.truncationReasons ?? []).join(', ')}`] : []),
  ];
}
