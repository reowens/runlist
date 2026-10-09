// A stage draft changes only the plan's ships field. Keep all other source bytes.
function field(source) {
  const envelope = source.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0];
  if (!envelope) throw new Error('Stage editing requires document metadata.');
  const lines = envelope.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const matches = lines.map((line, i) => /^ships:/.test(line) ? i : -1).filter(i => i >= 0);
  if (matches.length > 1) throw new Error('Repair duplicate ships fields before changing the stage.');
  const start = matches[0] ?? -1;
  let end = start + 1;
  const raw = start < 0 ? '' : lines[start].replace(/^ships:[ \t]*/, '').trim();
  if (start >= 0 && (!raw || /^[>|][-+]?$/.test(raw))) {
    let indent=null;
    while (end < lines.length - 1) {
      if (lines[end].trim() && /^[ \t]/.test(lines[end])) {
        const current=lines[end].match(/^[ \t]*/)[0].length;
        if(indent!==null&&current<indent)break;
        indent??=current;end++;continue;
      }
      if (!lines[end].trim()) {
        let next=end+1;while(next<lines.length-1&&!lines[next].trim())next++;
        if (/^[ \t]/.test(lines[next]??'')) {end=next;continue;}
      }
      break;
    }
  }
  return {envelope, lines, start, end};
}

export function withoutSourceStage(source) {
  const {envelope,lines,start,end} = field(source);
  if (start < 0) return source;
  return lines.slice(0,start).join('') + lines.slice(end).join('') + source.slice(envelope.length);
}

export function replaceSourceStage(source, word) {
  if (word !== null && (typeof word !== 'string' || !word.trim() || /[\r\n\0]/.test(word))) throw new Error('Choose a single stage from this checkout.');
  const {envelope,lines,start,end} = field(source), newline = lines[0].endsWith('\r\n') ? '\r\n' : '\n';
  const next = word === null ? '' : `ships: ${JSON.stringify(word)}${newline}`;
  if (start >= 0) return lines.slice(0,start).join('') + next + lines.slice(end).join('') + source.slice(envelope.length);
  return lines.slice(0,-1).join('') + next + lines.at(-1) + source.slice(envelope.length);
}

export function readSourceStage(source) {
  try {
    const {lines,start,end} = field(source);
    if (start < 0) return {word:null,invalid:false};
    let value = lines[start].replace(/^ships:\s*/, '').trim();
    if (!value && lines.slice(start+1,end).every(line=>!line.trim()||line.trimStart().startsWith('#'))) return {word:null,invalid:false};
    if (/^[>|][-+]?$/.test(value)) {
      const raw = lines.slice(start + 1,end).map(line=>line.replace(/\r?\n$/,''));
      const indent = raw.find(line=>line.trim())?.match(/^[ \t]*/)[0].length ?? 0;
      const contents=raw.map(line=>line.trim()?line.slice(indent):'');
      const keep=value.endsWith('+');
      if(value.startsWith('|'))value=contents.join('\n');
      else {value='';let hasContent=false,blank=false;for(const line of contents){if(!line){if(hasContent&&!blank)value+='\n';blank=true;}else{if(hasContent&&!blank)value+=' ';value+=line;hasContent=true;blank=false;}}}
      if(keep&&!value.endsWith('\n'))value+='\n';
    } else if (end > start + 1 || value.startsWith('[') || value.startsWith('{')) return {word:null,invalid:true};
    else if (value.startsWith('"')) {try {value = JSON.parse(value);} catch {return {word:null,invalid:true};}}
    else if (value.startsWith("'")) {if (!value.endsWith("'")) return {word:null,invalid:true};value = value.slice(1,-1).replaceAll("''", "'");}
    else if (value === 'true' || value === 'false') return {word:null,invalid:true};
    const word=typeof value==='string'?value.trim()||null:null;
    return typeof value === 'string' && !(word && /[\r\n\0]/.test(value)) ? {word,invalid:false} : {word:null,invalid:true};
  } catch {return {word:null,invalid:true};}
}

export function rebaseSourceStage(base, draft, current) {
  // Metadata refreshed by another writer is authoritative except for the
  // explicitly drafted stage. The resulting change still requires review.
  const baseStage = field(base), draftStage = field(draft);
  const bytes = value => value.start < 0 ? '' : value.lines.slice(value.start,value.end).join('');
  if (bytes(baseStage) === bytes(draftStage)) return current;
  const {word,invalid} = readSourceStage(draft);
  if (invalid) throw new Error('Repair the stage draft before merging it.');
  return replaceSourceStage(current,word);
}
