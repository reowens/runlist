import {it} from 'node:test';
import {strictEqual,ok} from 'node:assert';
import {parseBlocks,blocksSource,rewriteBlock,convertBlock} from '../assets/app/block-model.mjs';
const body='\n# A heading ###\n\nParagraph with **bold** and [a link](../other.md).\nSecond line.\n\n- [X] A task\n- A bullet\n3. A step\n\n<!-- native-item: stable-id -->\n\n| A | B |\n| --- | --- |\n| one | two |\n\n```js\nconst x = 1;\n```\n\n## Version History\n\n- Preserved event.\n';
it('retains exact source when projecting supported blocks and source fallbacks',()=>{
 const blocks=parseBlocks(body);strictEqual(blocksSource(blocks),body);ok(blocks.some(b=>b.kind==='source'));strictEqual(blocks.find(b=>b.kind==='task').checked,true);strictEqual(blocks.at(-1).locked,true);
});
it('an inline edit only replaces its block and keeps history, comments, and closing heading markers',()=>{
 const blocks=parseBlocks(body);rewriteBlock(blocks.find(b=>b.kind==='h1'),'Renamed heading');strictEqual(blocksSource(blocks),body.replace('A heading','Renamed heading'));
 const task=blocks.find(b=>b.kind==='task');rewriteBlock(task,'New task text');strictEqual(blocksSource(blocks),body.replace('A heading','Renamed heading').replace('A task','New task text'));
});
it('changes block type without leaking heading closing markers and retains the EOF ending',()=>{
 const blocks=parseBlocks('# Title ###');convertBlock(blocks[0],'task');strictEqual(blocksSource(blocks),'- [ ] Title');
});
it('does not invent syntax for unclosed fences or flatten nested list source',()=>{
 const src='- Item\n  - Child\n\n```mjs\nunclosed\n';const blocks=parseBlocks(src);strictEqual(blocksSource(blocks),src);strictEqual(blocks.filter(b=>b.kind==='source').length,2);
});
