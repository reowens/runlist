import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createLineFramer} from '../line-framer.mjs';

test('fragmented multi-byte frames and multiple frames preserve exact UTF-8 text',()=>{
  const lines=[],input=createLineFramer({maximum:64,onFrame:line=>lines.push(line),onOverflow:()=>assert.fail('overflow')});
  const wire=Buffer.from('先 🧭\r\nsecond\n\ntail');
  for(const byte of wire)input.write(Buffer.from([byte]));
  assert.deepEqual(lines,['先 🧭\r','second','']);
  input.discard();input.write(Buffer.from('\nignored\n'));
  assert.deepEqual(lines,['先 🧭\r','second','']);
});
test('limits count bytes per frame, accept the exact boundary and discard oversize input',()=>{
  const lines=[];let overflows=0;
  const input=createLineFramer({maximum:4,onFrame:line=>lines.push(line),onOverflow:()=>overflows++});
  input.write(Buffer.from('1234'));input.write(Buffer.from('\n12\n123'));
  assert.equal(input.write(Buffer.from('45\nallowed?\n')),false);
  assert.equal(input.write(Buffer.from('x\n')),false);
  assert.deepEqual(lines,['1234','12']);assert.equal(overflows,1);
});
test('a rejected frame stops later frames in the same input chunk',()=>{
  const lines=[];const input=createLineFramer({maximum:8,onFrame:line=>{lines.push(line);return false;},onOverflow:()=>assert.fail('overflow')});
  assert.equal(input.write(Buffer.from('first\nsecond\n')),false);assert.deepEqual(lines,['first']);
});
test('large fragmented frames concatenate only once instead of copying every prefix',()=>{
  const source='先 🧭'.repeat(300000),wire=Buffer.from(source+'\n');let calls=0,allocated=0;
  const original=Buffer.concat;
  Buffer.concat=(chunks,size)=>{calls++;allocated+=size??chunks.reduce((sum,chunk)=>sum+chunk.length,0);return original(chunks,size);};
  try {
    const input=createLineFramer({maximum:wire.length,onFrame:line=>assert.equal(line,source),onOverflow:()=>assert.fail('overflow')});
    for(let i=0;i<wire.length;i+=4096)input.write(wire.subarray(i,i+4096));
  } finally {Buffer.concat=original;}
  assert.equal(calls,1);assert.equal(allocated,wire.length-1);
});
