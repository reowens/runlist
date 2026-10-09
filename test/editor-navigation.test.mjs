import { it } from 'node:test';
import { deepStrictEqual, strictEqual, ok } from 'node:assert';
import { documentOutline } from '../assets/app/outline.mjs';
it('finds heading hierarchy and exact offsets without treating code/comments as sections',()=>{
 const body='# Title\n\n## First ##\n\n```md\n## Code\n```\n\n<!--\n## Comment\n-->\n\n### Child\n\n## Version History\n\n- Existing.\n';
 const headings=documentOutline(body);deepStrictEqual(headings.map(h=>[h.title,h.level]),[['Title',1],['First',2],['Child',3],['Version History',2]]);
 for(const h of headings){ok(body.slice(h.offset).startsWith('#'));strictEqual(body.slice(0,h.offset).split('\n').length,h.line);}strictEqual(headings.at(-1).locked,true);
});
it('distinguishes repeated headings and keeps bookmarks stable when preceding unrelated sections move',()=>{
 const original='# Title\n\n## First\n\n### Same\n\n## Second\n\n### Same\n\n### Same\n';
 const headings=documentOutline(original),moved=documentOutline(original.replace('## First','## Inserted\n\nSome text.\n\n## First'));
 strictEqual(new Set(headings.map(h=>h.key)).size,headings.length);deepStrictEqual(headings.map(h=>h.key),moved.filter(h=>h.title!=='Inserted').map(h=>h.key));
});
