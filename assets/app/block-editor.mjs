import { escapeHtml as esc, markdownHtml } from './shared.mjs';
import { parseBlocks, blocksSource, rewriteBlock, convertBlock, blockPrefixes } from './block-model.mjs';
const escapeText = s => s.replace(/[\\`*_\[\]~]/g,'\\$&');
const allowedLink = href => !/^(?:[a-z][a-z0-9+.-]*:|\/\/|\\)/i.test(href) || /^(https?:|mailto:)/i.test(href);
function inlineHTML(text) {
  const re=/`([^`\n]+)`|\[([^\]\n]+)\]\(([^\s)]+)\)|\*\*([^\n]+?)\*\*|__([^\n]+?)__|~~([^\n]+?)~~|\*([^*\n]+)\*|_([^_\n]+)_|(?<escaped>\\[\\`*_{}[\]()#+.!>~-])/g;
  let html='',cursor=0;
  for(const m of text.matchAll(re)) {
    html+=esc(text.slice(cursor,m.index)); let tag,inner,attrs='';
    if(m.groups.escaped){tag='span';inner=esc(m.groups.escaped.slice(1));}
    else if(m[1]!==undefined){tag='code';inner=esc(m[1]);}
    else if(m[2]!==undefined){tag='a';inner=inlineHTML(m[2]);attrs=` data-href="${esc(m[3])}"${allowedLink(m[3])?` href="${esc(m[3])}"`:''}`;}
    else {tag=m[4]!==undefined||m[5]!==undefined?'strong':m[6]!==undefined?'s':'em';inner=inlineHTML(m[4]??m[5]??m[6]??m[7]??m[8]);}
    html+=`<${tag}${attrs} data-raw="${esc(m[0])}">${inner}</${tag}>`;cursor=m.index+m[0].length;
  }
  return html+esc(text.slice(cursor));
}
function rememberMarkup(root) { for(const e of root.querySelectorAll('[data-raw]')) e._originalHTML=e.innerHTML; }
const markText=(text,mark)=>{const [,lead,body,tail]=text.match(/^(\s*)([\s\S]*?)(\s*)$/);return lead+(body?mark+body+mark:'')+tail;};
function markdownDOM(node) {
  if(node.nodeType===3)return escapeText(node.data);
  if(node.nodeType!==1)return '';
  if(node.dataset.raw!==undefined&&node.innerHTML===node._originalHTML)return node.dataset.raw;
  if(node.tagName==='BR')return '\n';
  const text=[...node.childNodes].map(markdownDOM).join('');
  switch(node.tagName){
    case 'STRONG': case 'B':return markText(text,'**');
    case 'EM': case 'I':return markText(text,'*');
    case 'S': case 'STRIKE':return markText(text,'~~');
    case 'CODE': {const raw=node.textContent;let fence='`';while(raw.includes(fence))fence+='`';return fence+(raw.startsWith('`')||raw.endsWith('`')?' ':'')+raw+(raw.startsWith('`')||raw.endsWith('`')?' ':'')+fence;}
    case 'A': {const href=node.dataset.href??node.getAttribute('href')??'';return allowedLink(href)?`[${text}](${href.replace(/[\s()]/g,c=>encodeURIComponent(c))})`:text;}
    case 'DIV': case 'P':return text+'\n';
    default:return text;
  }
}
const commands=[['paragraph','Text','Plain paragraph'],['h1','Heading 1','Large heading'],['h2','Heading 2','Section heading'],['h3','Heading 3','Small heading'],['bullet','Bulleted list','A simple list'],['number','Numbered list','A numbered step'],['task','To-do list','Track a task'],['quote','Quote','Set a passage apart'],['code','Code','A code block'],['divider','Divider','A horizontal rule']];
const MAX_UNDO_ENTRIES=100,MAX_UNDO_BYTES=32*1024*1024;
// The common edit keeps block boundaries. Compare raw fragments without
// allocating two complete Unicode document strings on every keystroke.
const sameSource=(before,after)=>{
  if(before.length===after.length){
    let changed=0;
    for(let i=0;i<before.length;i++)if(before[i].raw!==after[i].raw)changed++;
    if(changed<2)return changed===0;
  }
  return blocksSource(before)===blocksSource(after);
};
export class BlockEditor {
  constructor(root,{onChange,resolveLink}={}) {
    this.root=root;this.onChange=onChange;this.resolveLink=resolveLink;this.blocks=[];this.history=[];this.future=[];this.readOnly=false;
    root.classList.add('block-document');root.setAttribute('role','group');root.setAttribute('aria-label','Editable document');
    root.addEventListener('input',e=>this.input(e));root.addEventListener('keydown',e=>this.keydown(e));
    root.addEventListener('paste',e=>this.paste(e));root.addEventListener('drop',e=>{e.preventDefault();const el=e.target.closest('[data-editable]');if(!el||this.readOnly)return;const range=document.caretRangeFromPoint?.(e.clientX,e.clientY);if(range&&el.contains(range.startContainer)){getSelection().removeAllRanges();getSelection().addRange(range);this.paste({target:el,preventDefault(){},clipboardData:e.dataTransfer});}});root.addEventListener('click',e=>this.click(e));
    root.addEventListener('focusin',e=>{const el=e.target.closest('[data-editable]');if(el){this.activeId=el.closest('[data-block]').dataset.block;this.showTools();}});
    document.addEventListener('selectionchange',()=>this.selectionTools());window.addEventListener('scroll',()=>{this.tools.hidden=true;},true);
    document.addEventListener('pointerdown',e=>{if(!root.contains(e.target)&&!this.tools?.contains(e.target)&&!this.menu?.contains(e.target))this.closeMenu();});
    this.tools=document.createElement('div');this.tools.className='block-format';this.tools.hidden=true;this.tools.setAttribute('role','toolbar');this.tools.setAttribute('aria-label','Text formatting');
    this.tools.innerHTML=`<button data-style="strong" aria-label="Bold" title="Bold · ⌘B"><b>B</b></button><button data-style="em" aria-label="Italic" title="Italic · ⌘I"><i>I</i></button><button data-style="code" aria-label="Inline code">&lt;/&gt;</button><button data-style="s" aria-label="Strikethrough"><s>S</s></button><button data-style="link" aria-label="Add link">Link</button>`;
    this.tools.onpointerdown=e=>e.preventDefault();this.tools.onclick=e=>{const b=e.target.closest('[data-style]');if(b)this.format(b.dataset.style);};document.body.append(this.tools);
    this.menu=document.createElement('div');this.menu.className='block-menu';this.menu.hidden=true;this.menu.setAttribute('role','menu');document.body.append(this.menu);
    this.menu.onpointerdown=e=>e.preventDefault();this.menu.onclick=e=>{const b=e.target.closest('[data-kind]');if(b)this.choose(b.dataset.kind);};
  }
  set(body,{readOnly=false}={}) {this.closeMenu();this.tools.hidden=true;this.readOnly=readOnly;this.blocks=parseBlocks(body);this.history=[];this.future=[];this.typing=null;this.render();}
  source(){return blocksSource(this.blocks);}
  hideTools(){this.closeMenu();this.tools.hidden=true;}
  setReadOnly(value){this.readOnly=value;for(const el of this.root.querySelectorAll('[data-editable]')){el.setAttribute('contenteditable',String(!value));el.setAttribute('aria-readonly',String(value));}for(const el of this.root.querySelectorAll('button,input'))el.disabled=value||!!this.blocks.find(b=>b.id===el.closest('[data-block]')?.dataset.block)?.locked;for(const el of this.root.querySelectorAll('textarea'))el.readOnly=value;if(value)this.hideTools();}
  editable(){return this.root.querySelector(`[data-block="${this.activeId}"] [data-editable]`);}
  selected(){const s=getSelection();return s?.rangeCount&&this.root.contains(s.anchorNode)&&this.root.contains(s.focusNode)?s:null;}
  position(){const el=this.editable(),s=this.selected();if(!el||!s||!el.contains(s.focusNode))return {id:this.activeId,offset:0};const range=document.createRange();range.selectNodeContents(el);range.setEnd(s.focusNode,s.focusOffset);return {id:this.activeId,offset:range.toString().length};}
  focus(id,offset=0){this.activeId=id;const el=this.editable();if(!el)return;el.focus({preventScroll:true});let remaining=offset;const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);let text;while((text=walker.nextNode())){if(remaining<=text.length){const r=document.createRange();r.setStart(text,remaining);r.collapse(true);getSelection().removeAllRanges();getSelection().addRange(r);return;}remaining-=text.length;}const r=document.createRange();r.selectNodeContents(el);r.collapse(false);getSelection().removeAllRanges();getSelection().addRange(r);}
  snapshot(){
    // Blocks contain only primitive fields. Copy their mutable objects while
    // sharing immutable strings; structuredClone duplicates all document text.
    const blocks=this.blocks.map(block=>({...block}));
    const bytes=blocks.reduce((sum,block)=>sum+128+Object.values(block).reduce((n,value)=>n+(typeof value==='string'?value.length*2:8),0),0);
    return {blocks,position:this.position(),bytes};
  }
  trimUndo(){
    let bytes=[...this.history,...this.future].reduce((sum,snapshot)=>sum+snapshot.bytes,0);
    // Count shared strings conservatively. Keep at least the nearest action,
    // even if that single document snapshot exceeds the history byte budget.
    while(this.history.length+this.future.length>1&&(bytes>MAX_UNDO_BYTES||this.history.length+this.future.length>MAX_UNDO_ENTRIES)){
      const stack=this.history.length>=this.future.length?this.history:this.future;
      bytes-=stack.shift().bytes;
    }
  }
  commit(previous,{typing=false}={}){
    if(previous&&!sameSource(previous.blocks,this.blocks)){
      const now=performance.now(),group=typing&&this.typing?.id===previous.position.id&&now-this.typing.at<800;
      if(!group)this.history.push(previous);
      this.typing=typing?{id:previous.position.id,at:now}:null;this.future=[];this.trimUndo();this.onChange?.(this.source());
    }
  }
  mutate(fn){const previous=this.snapshot();fn();this.commit(previous);}
  render(){
    this.root.replaceChildren();
    for(const b of this.blocks){
      if(['gap','comment'].includes(b.kind))continue;
      const row=document.createElement('div');row.className=`doc-block block-${b.kind}`;row.dataset.block=b.id;
      const handle=document.createElement('button');handle.className='block-handle';handle.type='button';handle.textContent='+';handle.title='Add a block below';handle.setAttribute('aria-label','Add block below');handle.dataset.add=b.id;handle.disabled=this.readOnly||b.locked;row.append(handle);
      if(b.locked||b.kind==='divider') {const content=document.createElement('div');content.innerHTML=markdownHtml(b.raw,this.resolveLink);if(b.locked){row.classList.add('locked-block');const note=document.createElement('div');note.className='block-lock-label';note.textContent='Lifecycle history · read only';row.append(note);}row.append(content);this.root.append(row);continue;}
      if(b.kind==='source') {const details=document.createElement('details');details.className='source-block';const summary=document.createElement('summary');summary.textContent='Edit this block as Markdown';const preview=document.createElement('div');preview.innerHTML=markdownHtml(b.raw,this.resolveLink);const textarea=document.createElement('textarea');textarea.value=b.raw;textarea.dataset.rawEditor=b.id;textarea.setAttribute('aria-label','Block Markdown');textarea.readOnly=this.readOnly;details.append(summary,textarea);row.append(preview,details);this.root.append(row);continue;}
      const marker=document.createElement(b.kind==='task'?'input':'span');marker.className='block-marker';
      if(b.kind==='task'){marker.type='checkbox';marker.checked=b.checked;marker.disabled=this.readOnly;marker.dataset.check=b.id;marker.setAttribute('aria-label',`Complete task: ${b.text}`);row.append(marker);}
      else if(b.kind==='bullet'||b.kind==='number'){marker.textContent=b.kind==='bullet'?'•':b.prefix.trim();row.append(marker);}
      const el=document.createElement(/^h[1-6]$/.test(b.kind)?b.kind:b.kind==='code'?'pre':'div');el.className='block-text';el.dataset.editable='true';el.contentEditable=String(!this.readOnly);el.setAttribute('role','textbox');el.setAttribute('aria-multiline','true');el.setAttribute('aria-label',b.kind==='paragraph'?'Paragraph':b.kind==='task'?'Task text':b.kind==='code'?'Code':b.kind.startsWith('h')?'Heading':`${b.kind} text`);el.dataset.placeholder=b.kind==='paragraph'?"Type '/' for blocks":'Type here…';
      el.tabIndex=0;el.setAttribute('aria-readonly',String(this.readOnly));if(/^h[1-6]$/.test(b.kind))el.setAttribute('aria-description',`Heading level ${b.kind.slice(1)}`);
      if(b.kind==='code')el.textContent=b.text;else {el.innerHTML=inlineHTML(b.text);rememberMarkup(el);}
      row.append(el);this.root.append(row);
    }
    const add=document.createElement('button');add.className='append-block';add.textContent='+ Add a block';add.disabled=this.readOnly;add.dataset.append='true';this.root.append(add);
  }
  input(e){if(this.readOnly)return;const textarea=e.target.closest('[data-raw-editor]');if(textarea){const b=this.blocks.find(b=>b.id===textarea.dataset.rawEditor);this.mutate(()=>{b.raw=textarea.value;});return;}
    const el=e.target.closest('[data-editable]');if(!el)return;this.activeId=el.closest('[data-block]').dataset.block;const b=this.blocks.find(b=>b.id===this.activeId);const previous=this.snapshot();previous.position={id:b.id,offset:Math.max(0,this.position().offset-1)};rewriteBlock(b,b.kind==='code'?el.innerText:[...el.childNodes].map(markdownDOM).join(''));this.commit(previous,{typing:['insertText','deleteContentBackward','deleteContentForward'].includes(e.inputType)});
    if(b.kind==='paragraph'&&/^\/[^\n]*$/.test(el.textContent))this.openMenu(b.id,{slash:true,query:el.textContent.slice(1)});else if(!this.menu.hidden&&this.menuSlash)this.closeMenu();
  }
  click(e){const link=e.target.closest('a');if(link){e.preventDefault();if(e.metaKey||e.ctrlKey){const href=link.dataset.href??link.getAttribute('href');if(allowedLink(href))window.open(this.resolveLink?.(href)??href,'_blank','noopener');}return;}
    if(e.target.dataset.check){const b=this.blocks.find(b=>b.id===e.target.dataset.check);this.mutate(()=>{b.checked=e.target.checked;b.prefix=b.prefix.replace(/\[[ xX]\]/,b.checked?'[x]':'[ ]');rewriteBlock(b,b.text);});return;}
    if(e.target.dataset.add){this.activeId=e.target.dataset.add;this.openMenu(this.activeId,{insert:true});}
    if(e.target.dataset.append)this.openMenu(this.blocks.filter(b=>!b.locked&&!['gap','comment'].includes(b.kind)).at(-1)?.id,{insert:true});
  }
  closeMenu(){this.menu.hidden=true;this.menuSlash=false;}
  openMenu(id,{slash=false,insert=false,query=''}={}){
    if(this.readOnly)return;this.menuId=id;this.menuSlash=slash;this.menuInsert=insert;this.menuIndex=0;
    const matches=commands.filter(c=>`${c[1]} ${c[2]}`.toLowerCase().includes(query.toLowerCase()));this.menuCommands=matches;
    this.menu.innerHTML='<div class="block-menu-title">'+(insert?'ADD A BLOCK':'TURN INTO')+'</div>'+matches.map((c,i)=>`<button role="menuitem" data-kind="${c[0]}" class="${i===0?'selected':''}"><span>${esc(c[1])}</span><small>${esc(c[2])}</small></button>`).join('');
    if(!matches.length)this.menu.innerHTML+='<p>No matching block types</p>';
    this.menu.hidden=false;const row=this.root.querySelector(`[data-block="${id}"]`),rect=(row??this.root).getBoundingClientRect();this.menu.style.left=Math.max(8,Math.min(rect.left,innerWidth-260))+'px';this.menu.style.top=Math.max(8,Math.min(rect.bottom+4,innerHeight-Math.min(420,this.menu.offsetHeight)-8))+'px';
  }
  choose(kind){this.mutate(()=>{const id=this.menuId;let b=this.blocks.find(b=>b.id===id);if(this.menuInsert){b=this.insertAfter(b,kind,'');}
    else if(b){if(this.menuSlash)b.text='';if(kind==='code'){b.kind='code';b.prefix='```\n';b.suffix='\n```'+(b.raw.endsWith('\n')?'\n':'');rewriteBlock(b,b.text);}else if(kind==='divider'){b.kind='divider';b.raw='---'+(b.raw.endsWith('\n')?'\n':'');}else convertBlock(b,kind);}this.closeMenu();this.render();this.focus(b?.id);});}
  insertAfter(block,kind,text){let index=block?this.blocks.indexOf(block)+1:this.blocks.findIndex(b=>b.locked);if(index<0)index=this.blocks.length;
    const next=this.blocks[index];if(block&&!block.raw.endsWith('\n'))block.raw+='\n';
    const fresh={id:crypto.randomUUID(),kind,prefix:kind==='code'?'```\n':blockPrefixes[kind]??'',text,suffix:kind==='code'?'\n```\n':'\n',checked:false,raw:''};rewriteBlock(fresh,text);if(kind==='divider')fresh.raw='---\n';
    const parts=[];if(!['bullet','number','task'].includes(kind))parts.push({id:crypto.randomUUID(),kind:'gap',raw:'\n'});parts.push(fresh);if(next?.kind!=='gap'&&next)parts.push({id:crypto.randomUUID(),kind:'gap',raw:'\n'});
    this.blocks.splice(index,0,...parts);return fresh;
  }
  selectionTools(){const s=this.selected();if(!s||s.isCollapsed||this.readOnly){this.tools.hidden=true;return;}const start=s.anchorNode.parentElement.closest('[data-editable]'),end=s.focusNode.parentElement.closest('[data-editable]');if(!start||start!==end||start.closest('.block-code')){this.tools.hidden=true;return;}
    this.savedRange=s.getRangeAt(0).cloneRange();const r=this.savedRange.getBoundingClientRect();this.tools.hidden=false;this.tools.style.left=Math.max(8,Math.min(r.left,innerWidth-this.tools.offsetWidth-8))+'px';this.tools.style.top=Math.max(8,r.top-this.tools.offsetHeight-8)+'px';
  }
  showTools(){this.selectionTools();}
  format(tag){let s=this.selected(),range=s?.rangeCount?s.getRangeAt(0):this.savedRange;if(!range||range.collapsed||!this.root.contains(range.commonAncestorContainer))return;
    const el=(range.startContainer.nodeType===1?range.startContainer:range.startContainer.parentElement).closest('[data-editable]');if(!el||!el.contains(range.endContainer)||el.closest('.block-code'))return;
    this.activeId=el.closest('[data-block]').dataset.block;let href;
    if(tag==='link'){href=window.prompt('Link URL');if(!href)return;if(!allowedLink(href)||/[\s]/.test(href)){window.alert('Use a web, mail, fragment, or relative link without spaces.');return;}tag='a';}
    this.mutate(()=>{
      const parent=(range.startContainer.nodeType===1?range.startContainer:range.startContainer.parentElement).closest(tag);
      if(parent&&el.contains(parent)&&parent.contains(range.endContainer)) {
        const before=document.createRange();before.selectNodeContents(parent);before.setEnd(range.startContainer,range.startOffset);
        const after=document.createRange();after.selectNodeContents(parent);after.setStart(range.endContainer,range.endOffset);
        const left=parent.cloneNode(false),right=parent.cloneNode(false),middle=range.cloneContents();
        left.removeAttribute('data-raw');right.removeAttribute('data-raw');left.append(before.cloneContents());right.append(after.cloneContents());
        const replacement=document.createDocumentFragment();if(left.textContent)replacement.append(left);replacement.append(middle);if(right.textContent)replacement.append(right);
        const offset=this.position().offset;parent.replaceWith(replacement);
        rewriteBlock(this.blocks.find(b=>b.id===this.activeId),[...el.childNodes].map(markdownDOM).join(''));this.focus(this.activeId,offset);return;
      }
      const wrapper=document.createElement(tag);if(href){wrapper.dataset.href=href;wrapper.setAttribute('href',href);}wrapper.append(range.extractContents());range.insertNode(wrapper);const r=document.createRange();r.selectNodeContents(wrapper);s=getSelection();s.removeAllRanges();s.addRange(r);rewriteBlock(this.blocks.find(b=>b.id===this.activeId),[...el.childNodes].map(markdownDOM).join(''));
    });this.selectionTools();
  }
  paste(e){const el=e.target.closest('[data-editable]');if(!el||this.readOnly)return;e.preventDefault();const s=this.selected();if(!s)return;const r=s.getRangeAt(0);if(!el.contains(r.endContainer))return;const text=e.clipboardData.getData('text/plain');r.deleteContents();const node=document.createTextNode(text.replaceAll('\r\n','\n'));r.insertNode(node);r.setStartAfter(node);r.collapse(true);s.removeAllRanges();s.addRange(r);this.input({target:el});}
  undo(redo=false){this.typing=null;const from=redo?this.future:this.history,to=redo?this.history:this.future;if(!from.length)return;const target=from.pop();to.push(this.snapshot());this.trimUndo();this.blocks=target.blocks;this.closeMenu();this.render();this.focus(target.position.id,target.position.offset);this.onChange?.(this.source());}
  keydown(e){if(this.readOnly||e.isComposing)return;const el=e.target.closest('[data-editable]');if(!el)return;this.activeId=el.closest('[data-block]').dataset.block;const b=this.blocks.find(b=>b.id===this.activeId),mod=e.metaKey||e.ctrlKey;
    if(mod&&e.key.toLowerCase()==='z'){e.preventDefault();this.undo(e.shiftKey);return;}if(mod&&e.key.toLowerCase()==='y'){e.preventDefault();this.undo(true);return;}
    if(mod&&['b','i'].includes(e.key.toLowerCase())){e.preventDefault();this.format(e.key.toLowerCase()==='b'?'strong':'em');return;}
    if(!this.menu.hidden){if(e.key==='Escape'){e.preventDefault();this.closeMenu();return;}if(['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();this.menuIndex=(this.menuIndex+(e.key==='ArrowDown'?1:-1)+this.menuCommands.length)%this.menuCommands.length;[...this.menu.querySelectorAll('[data-kind]')].forEach((b,i)=>b.classList.toggle('selected',i===this.menuIndex));return;}if(e.key==='Enter'){e.preventDefault();const cmd=this.menuCommands[this.menuIndex];if(cmd)this.choose(cmd[0]);return;}}
    const s=this.selected();if(!s||!el.contains(s.anchorNode)||!el.contains(s.focusNode))return;
    if(e.key==='Enter'&&e.shiftKey&&b.kind!=='code'){e.preventDefault();const r=s.getRangeAt(0);r.deleteContents();const br=document.createElement('br');r.insertNode(br);r.setStartAfter(br);r.collapse(true);s.removeAllRanges();s.addRange(r);this.input({target:el});return;}
    if(['ArrowUp','ArrowDown'].includes(e.key)&&s.isCollapsed&&!mod){const offset=this.position().offset;if((e.key==='ArrowUp'&&offset===0)||(e.key==='ArrowDown'&&offset===el.textContent.length)){const elements=[...this.root.querySelectorAll('[data-editable]')],index=elements.indexOf(el),next=elements[index+(e.key==='ArrowUp'?-1:1)];if(next){e.preventDefault();this.focus(next.closest('[data-block]').dataset.block,e.key==='ArrowUp'?next.textContent.length:0);}}}
    if(e.key==='Enter'&&!e.shiftKey&&b.kind!=='code'){
      e.preventDefault();this.mutate(()=>{const r=s.getRangeAt(0);r.deleteContents();const tail=document.createRange();tail.selectNodeContents(el);tail.setStart(r.startContainer,r.startOffset);const frag=tail.extractContents();const head=[...el.childNodes].map(markdownDOM).join(''),text=[...frag.childNodes].map(markdownDOM).join('');
        if(['bullet','number','task','quote'].includes(b.kind)&&!head&&!text){rewriteBlock(b,'');convertBlock(b,'paragraph');this.render();this.focus(b.id);return;}
        rewriteBlock(b,head);const kind=['bullet','number','task','quote'].includes(b.kind)?b.kind:'paragraph',next=this.insertAfter(b,kind,text);if(kind==='number'){next.prefix=b.prefix.replace(/\d+/,n=>String(Number(n)+1));rewriteBlock(next,next.text);}this.render();this.focus(next.id);});return;
    }
    if(e.key==='Enter'&&b.kind==='code'){e.preventDefault();const r=s.getRangeAt(0);r.deleteContents();const n=document.createTextNode('\n');r.insertNode(n);r.setStartAfter(n);r.collapse(true);s.removeAllRanges();s.addRange(r);this.input({target:el});return;}
    if(e.key==='Backspace'&&s.isCollapsed&&this.position().offset===0){
      if(b.kind!=='paragraph'&&b.kind in blockPrefixes){e.preventDefault();this.mutate(()=>{convertBlock(b,'paragraph');this.render();this.focus(b.id);});return;}
      const index=this.blocks.indexOf(b);let p=index-1;while(this.blocks[p]?.kind==='gap')p--;const prev=this.blocks[p];if(!prev||prev.locked||!['paragraph','bullet','number','task','quote','h1','h2','h3','h4','h5','h6'].includes(prev.kind))return;
      e.preventDefault();const prevEl=this.root.querySelector(`[data-block="${prev.id}"] [data-editable]`),offset=prevEl?.textContent.length??0;this.mutate(()=>{rewriteBlock(prev,prev.text+b.text);this.blocks.splice(p+1,index-p);this.render();this.focus(prev.id,offset);});
    }
    if(e.key==='Tab'&&!mod&&!e.shiftKey&&b.kind==='code'){e.preventDefault();const r=s.getRangeAt(0),n=document.createTextNode('  ');r.deleteContents();r.insertNode(n);r.setStartAfter(n);r.collapse(true);s.removeAllRanges();s.addRange(r);this.input({target:el});}
  }
}
