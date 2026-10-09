// Block boundaries retain the original source. Only the block being edited is
// rewritten; gaps, comments, unsupported syntax, and managed history stay raw.
export function parseBlocks(body) {
  const lines = body.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const blocks = []; let i = 0, id = 0;
  const line = n => (lines[n] ?? '').replace(/\n$/, '');
  const add = (kind, start, end, extra = {}) => blocks.push({id:String(id++),kind,raw:lines.slice(start,end).join(''),...extra});
  const special = s => /^(?: {0,3}(?:#{1,6}\s|[-*+] |\d+[.)] |`{3,}|~{3,})|>|\s*<!--|\s*$)/.test(s);
  while (i < lines.length) {
    const start = i, s = line(i), heading = s.match(/^( {0,3})(#{1,6})(\s+)(.*?)(\s+#+\s*)?$/);
    if (heading && heading[2].length === 2 && /^Version History\s*$/i.test(heading[4])) { add('history',i,lines.length,{locked:true}); break; }
    if (!s.trim()) { while (i < lines.length && !line(i).trim()) i++; add('gap',start,i); continue; }
    if (/^\s*<!--/.test(s)) { while (i < lines.length && !line(i++).includes('-->')) {} add('comment',start,i); continue; }
    const fence = s.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      i++; while (i < lines.length && !new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`).test(line(i))) i++;
      // Unclosed fences remain source-editable; do not invent a closing fence.
      if (i === lines.length) { add('source',start,i); continue; }
      const end = i++; add('code',start,i,{prefix:lines[start],text:lines.slice(start+1,end).join('').replace(/\n$/,''),suffix:'\n'+lines[end]}); continue;
    }
    if (s.includes('|') && /^\s*\|?\s*:?-{3,}/.test(line(i+1))) { i+=2; while (i<lines.length && line(i).includes('|') && line(i).trim()) i++; add('source',start,i); continue; }
    if (heading) { i++; add('h'+heading[2].length,start,i,{prefix:heading[1]+heading[2]+heading[3],text:heading[4],suffix:(heading[5]??'')+(lines[start].endsWith('\n')?'\n':'')}); continue; }
    const item = s.match(/^( {0,3})([-*+] |\d+[.)] )(?:\[([ xX])\] )?(.*)$/);
    if (item) {
      i++; // Multiline/nested items need a source fallback, rather than losing indentation.
      while (i<lines.length && /^\s{2,}\S/.test(line(i))) i++;
      if (i>start+1) { add('source',start,i); continue; }
      add(item[3]!==undefined?'task':/\d/.test(item[2])?'number':'bullet',start,i,{prefix:item[1]+item[2]+(item[3]!==undefined?`[${item[3]}] `:''),text:item[4],checked:item[3]!==undefined&&item[3]!==' ',suffix:lines[start].endsWith('\n')?'\n':''}); continue;
    }
    if (/^>\s?/.test(s)) { i++; add('quote',start,i,{prefix:s.match(/^>\s?/)[0],text:s.replace(/^>\s?/,''),suffix:lines[start].endsWith('\n')?'\n':''}); continue; }
    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(s)) { i++; add('divider',start,i); continue; }
    i++; while (i<lines.length && !special(line(i)) && !(line(i).includes('|') && /^\s*\|?\s*:?-{3,}/.test(line(i+1)))) i++;
    const raw = lines.slice(start,i).join('');
    add(/^ {4}|^\t|^\s*</.test(s)?'source':'paragraph',start,i,{prefix:'',text:raw.replace(/\n$/,''),suffix:raw.endsWith('\n')?'\n':''});
  }
  return blocks;
}
export const blocksSource = blocks => blocks.map(b=>b.raw).join('');
export function rewriteBlock(block, text) {
  if (block.locked) throw new Error('Managed history is read only.');
  block.text = text;
  block.raw = block.prefix + text + block.suffix;
  return block;
}
export const blockPrefixes = {paragraph:'',h1:'# ',h2:'## ',h3:'### ',bullet:'- ',number:'1. ',task:'- [ ] ',quote:'> '};
export function convertBlock(block, kind) {
  if (!(kind in blockPrefixes) || block.locked || ['source','code','history'].includes(block.kind)) return false;
  block.kind=kind; block.prefix=blockPrefixes[kind]; block.checked=false;
  // ATX heading closing markers belong to the previous block kind.
  block.suffix=block.suffix.endsWith('\n')?'\n':'';
  rewriteBlock(block,block.text); return true;
}
