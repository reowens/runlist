import { libraryKind, matchesLibraryStage, sortLibraryRows } from './app-library.mjs';
import { readPlanStage, readShipsFrontmatter } from './stages.mjs';
import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {StringDecoder} from 'node:string_decoder';
import path from 'node:path';
import {extractFrontmatter,parseSimpleFrontmatter} from './frontmatter.mjs';
import {authorizeManagedSource} from './managed-path.mjs';

const detached=value=>JSON.parse(JSON.stringify(value));

// On-demand streaming search. No document bodies or content index are retained.
export async function searchCheckout(config,library,params) {
  const words=(params.get('q')??'').slice(0,500).toLowerCase().trim().split(/\s+/).filter(Boolean);
  const limit=Math.max(1,Math.min(100,Math.floor(Number(params.get('limit'))||50)));
  const requestedOffset=Math.max(0,Math.floor(Number(params.get('offset'))||0));
  const all=await library.all(),rows=all.filter(r=>(params.get('archived')==='1'||!r.archived)
    &&(!params.get('kind')||params.get('kind')==='all'||params.get('kind')==='plans'&&r.kind==='plan'||params.get('kind')==='hubs'&&r.kind==='hub'||params.get('kind')==='documents'&&r.kind==='document')
    &&matchesLibraryStage(r,params.get('stage'))
    &&(!params.get('status')||r.status===params.get('status'))&&(!params.get('type')||r.type===params.get('type'))
    &&(!params.get('folder')||r.folder===params.get('folder')||r.folder.startsWith(params.get('folder')+'/')));
  sortLibraryRows(rows,params,config);
  const documents=[],sections=[];let scanned=0,unavailable=0,bytesRead=0,total=0,partial=false,index=0;
  if(!words.length)return {documents:rows.slice(requestedOffset,requestedOffset+limit),sections:[],total:rows.length,offset:requestedOffset,limit,hasMore:requestedOffset+limit<rows.length,scanned:0,inventoryTotal:rows.length,partial:false,unavailable:0};
  const budget=128*1024*1024;
  const worker=async()=>{
    while(index<rows.length) {
      if(bytesRead>=budget){partial=true;return;}
      const row=rows[index++];let fd;
      try {
        const file=authorizeManagedSource(path.resolve(config.repoRoot,row.path),config).path;
        fd=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));const stamp=await fd.stat();
        if(!stamp.isFile()||stamp.size>8*1024*1024){unavailable++;continue;}
        const buffer=Buffer.alloc(64*1024),decoder=new StringDecoder('utf8');let offset=0,carry='',lineCarry='',bodyLine=0,fence=null,comment=false,frontmatter=false,first=true,excerpt='';
        const found=new Set(),headings=[];let rejected=false;
        const metadata=`${row.title} ${row.path} ${row.status} ${row.type} ${row.modules.join(' ')}`.toLowerCase();
        words.forEach(w=>{if(metadata.includes(w))found.add(w);});
        function line(raw){
          if(bodyLine===0&&raw==='---'&&!frontmatter){frontmatter=true;return;}
          if(frontmatter){if(raw==='---')frontmatter=false;return;}
          bodyLine++;
          if(raw.includes('<!--'))comment=true;
          const marker=raw.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
          if(marker&&!comment){if(!fence)fence=marker[1];else if(marker[1][0]===fence[0]&&marker[1].length>=fence.length&&!marker[2].trim())fence=null;}
          const match=!fence&&!comment&&raw.match(/^ {0,3}#{1,6}\s+(.*?)(?:\s+#+\s*)?$/);
          if(match&&words.every(w=>match[1].toLowerCase().includes(w))&&headings.length<8)headings.push({path:row.path,title:detached(match[1].slice(0,200)),line:bodyLine});
          if(raw.includes('-->'))comment=false;
        }
        while(offset<stamp.size) {
          if(bytesRead>=budget){partial=true;break;}
          const {bytesRead:count}=await fd.read(buffer,0,buffer.length,offset);if(!count)break;offset+=count;bytesRead+=count;
          const chunk=decoder.write(buffer.subarray(0,count));
          if(first){
            first=false;const parts=extractFrontmatter(chunk),header=parseSimpleFrontmatter(parts.frontmatter);
            // Re-check current metadata, even when a cached library row predates a type change.
            if(header.type==='prompt'||/^---\r?\n/.test(chunk)&&!parts.bodyLineOffset){unavailable++;rejected=true;break;}
            row.kind=libraryKind(header,row.path);
            if(row.kind==='plan'){const stage=readPlanStage(readShipsFrontmatter(parts.frontmatter));row.stage=stage.word;row.stageInvalid=stage.invalid;}else{delete row.stage;delete row.stageInvalid;}
            if(!matchesLibraryStage(row,params.get('stage'))||params.get('kind')==='plans'&&row.kind!=='plan'){rejected=true;break;}
          }
          const haystack=(carry+chunk).toLowerCase();
          for(const word of words){const at=haystack.indexOf(word);if(at>=0){found.add(word);if(!excerpt)excerpt=(carry+chunk).slice(Math.max(0,at-65),at+165).replace(/\s+/g,' ').slice(0,240);}}
          carry=chunk.slice(-500);
          const lines=(lineCarry+chunk).split('\n');lineCarry=lines.pop();for(const raw of lines)line(raw.replace(/\r$/,''));
          // A pathological single-line file must not accumulate the entire body.
          if(lineCarry.length>4096)lineCarry=lineCarry.slice(-4096);
        }
        if(rejected||offset<stamp.size)continue;
        line(lineCarry+decoder.end());scanned++;
        if(found.size===words.length){total++;documents.push({...row,excerpt:detached(excerpt)});}
        for(const heading of headings)if(sections.length<limit)sections.push(heading);
      }catch{unavailable++;}finally{await fd?.close();}
    }
  };
  await Promise.all(Array.from({length:4},worker));
  sortLibraryRows(documents,params,config);
  sections.sort((a,b)=>a.path.localeCompare(b.path)||a.line-b.line);
  const offset=Math.min(requestedOffset,Math.max(0,Math.floor((documents.length-1)/limit)*limit));
  return {documents:documents.slice(offset,offset+limit),sections,total,offset,limit,hasMore:offset+limit<total,scanned,inventoryTotal:rows.length,partial,unavailable,bytesRead};
}
