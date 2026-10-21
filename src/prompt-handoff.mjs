import path from 'node:path';

export function parentPromptName(value) {
  if (typeof value !== 'string' || !/^resume-[a-z0-9]+(?:-[a-z0-9]+)*(?:\.md)?$/.test(value)) {
    throw new Error('A parent resume prompt name is required, e.g. resume-session-name.');
  }
  return value.replace(/\.md$/, '');
}

export const HANDOFF_TEMPLATES = {
  'handoff:resume': {
    label: 'Resume draft',
    description: 'Cold-start handoff outline for baton --template; does not change saved prompt formatting or repository baton instructions.',
    source: `<!-- Follow repository baton instructions. Keep this focused on what the next session needs. -->
## Resume
<!-- Work to resume and owning plan path + section, or a durable brief if there is no plan. -->

## State and next move
<!-- What is in hand, what remains, and the exact next action or blocker. -->

## Decisions and waiting items
<!-- Why this direction; rejected or failed approaches that should not be repeated. -->
<!-- Outstanding decisions, answers or approvals, with a durable record path for each. -->

## Evidence and working material
<!-- Relevant commits, checks that passed, and claims still unverified. -->
<!-- Repo-relative paths to briefs, reports and scripts; scratch paths are supplementary. -->

## Boundaries
<!-- Current user priorities, authorization limits and anything requiring a new go. -->
<!-- Review linked child handoffs and record completed results in the owning plan. -->
`,
  },
  'handoff:subagent': {
    label: 'Subagent draft',
    description: 'Bounded child handoff outline for baton --subagent --template; parent_prompt links it to a resume prompt.',
    source: `---
parent_prompt: {{parent_prompt}}
---
<!-- Follow the repository's baton instructions alongside these child-specific fields. -->
## Task
<!-- One sentence: the bounded job and its owning plan or brief. -->

## State
<!-- Continue, blocked, or complete. If complete, say what the parent must record. -->

## Next
<!-- The exact next action, or the blocker and what clears it. No remaining work: say so. -->
<!-- Include outstanding decisions or approvals and where each is recorded. -->

## Evidence
<!-- Commits, checks that passed, and checks still unverified. -->
<!-- Keep the full record in a durable repo-relative path; scratch paths are supplementary. -->

## Boundaries
<!-- Owned files, shared claims, current authorization, and any required new go. -->
<!-- Do not release or claim the parent's plan. This handoff grants no new authority. -->
`,
  },
};

// Explicit links win, including missing/ambiguous parents. Legacy child names
// may share a parent stem; the longest whole-stem match is the most specific.

export function promptParentCandidates(doc, parents) {
  if(doc.parentPromptInvalid)return [];
  const slug = doc => path.basename(doc.path, '.md');
  let matches;
  if (doc.parentPrompt) {
    const ref = doc.parentPrompt.replace(/\.md$/, '');
    matches = parents.filter(parent => ref.includes('/')
      ? parent.path.replace(/\.md$/, '') === ref
      : path.dirname(parent.path) === path.dirname(doc.path) && slug(parent) === ref);
  } else {
    const stem = slug(doc).replace(/^(?:subagent|agent|session)-/, '');
    if (stem === slug(doc)) return [];
    matches = parents.filter(parent => {
      const parentStem = slug(parent).slice('resume-'.length);
      return path.dirname(parent.path) === path.dirname(doc.path)
        && (stem === parentStem || stem.startsWith(`${parentStem}-`));
    }).sort((a, b) => slug(b).length - slug(a).length);
    if (matches.length > 1 && slug(matches[0]).length > slug(matches[1]).length) matches = matches.slice(0, 1);
  }
  return matches;
}

export function groupPrompts(prompts) {
  const slug = doc => path.basename(doc.path, '.md');
  const parents = prompts.filter(doc => slug(doc).startsWith('resume-')&&!doc.parentPrompt&&!doc.parentPromptInvalid);
  const children = new Map();
  const parentFor = new Map();
  for (const doc of prompts) {
    if (slug(doc).startsWith('resume-')) continue;
    const matches = promptParentCandidates(doc, parents);
    if (matches.length !== 1) continue;
    const parent = matches[0];
    parentFor.set(doc, parent);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(doc);
  }
  const groups = [], emitted = new Set();
  for (const doc of prompts) {
    const root = parentFor.get(doc) ?? doc;
    if (emitted.has(root)) continue;
    emitted.add(root);
    groups.push({ doc: root, children: children.get(root) ?? [] });
  }
  return groups;
}

export function diagnosePromptParents(prompts, config) {
  const archived = doc => doc.status === 'archived' || doc.path.split('/').includes(config.archiveDir);
  const parents = prompts.filter(doc => path.basename(doc.path).startsWith('resume-'));
  const live = parents.filter(doc => !archived(doc)&&!doc.parentPrompt&&!doc.parentPromptInvalid);
  const history = parents.filter(archived).map(doc => ({...doc, path:doc.path.split('/').filter(part=>part!==config.archiveDir).join('/'), archivedPath:doc.path}));
  const links=[];
  for(const doc of prompts.filter(doc=>!archived(doc))) {
    const isResume=path.basename(doc.path).startsWith('resume-');
    if(!doc.parentPrompt&&!doc.parentPromptInvalid&&(isResume||!/^(?:subagent|agent|session)-/.test(path.basename(doc.path))))continue;
    let state,candidates=[];
    if(doc.parentPromptInvalid||(isResume&&doc.parentPrompt))state='invalid';
    else {
      candidates=promptParentCandidates(doc,live);
      if(candidates.length===1)state=doc.parentPrompt?'linked':'inferred';
      else if(candidates.length>1)state='ambiguous';
      else {candidates=promptParentCandidates(doc,history);state=candidates.length?'archived':'missing';}
    }
    links.push({path:doc.path,parentPrompt:doc.parentPrompt??null,state,candidates:candidates.map(parent=>parent.archivedPath??parent.path)});
  }
  const counts={};for(const link of links)counts[link.state]=(counts[link.state]??0)+1;
  return {children:links.length,counts,links,findings:links.filter(link=>link.state!=='linked')};
}
