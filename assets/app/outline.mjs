import { parseBlocks } from './block-model.mjs';

// Source offsets refer to the normalized body, not frontmatter. Fenced code,
// comments and raw fallback blocks cannot accidentally create outline entries.
export function documentOutline(body, blocks = parseBlocks(body)) {
  const counts = new Map(), parents = []; let offset = 0, line = 1;
  return blocks.flatMap(block => {
    const start = offset, startLine = line; offset += block.raw.length; line += (block.raw.match(/\n/g) ?? []).length;
    let level = /^h([1-6])$/.exec(block.kind)?.[1], title = block.text;
    if (block.kind === 'history') { level=2; title='Version History'; }
    if (!level) return [];
    level=Number(level); parents.length=level-1;
    const signature = JSON.stringify([parents.filter(Boolean),level,title]);
    const occurrence = counts.get(signature) ?? 0; counts.set(signature,occurrence+1);
    const key = JSON.stringify([signature,occurrence]); parents[level-1]=title;
    return [{key,id:block.id,title,level,offset:start,line:startLine,locked:!!block.locked}];
  });
}
