// Read-only discovery. Never imports code from the selected checkout.
import {existsSync,lstatSync,readFileSync,realpathSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire,isBuiltin} from 'node:module';
import {parse} from 'acorn';
import {CONFIG_FILENAMES} from '../src/naming.mjs';
import {isPathInside as inside} from '../src/path-containment.mjs';
export function checkoutTrust(input) {
  let root=realpathSync(input); if(!lstatSync(root).isDirectory())throw new Error('Choose a checkout folder.');
  for(let dir=root;;dir=path.dirname(dir)){if(existsSync(path.join(dir,'.git'))){root=dir;break;}if(dir===path.dirname(dir))break;}
  const config=CONFIG_FILENAMES.map(name=>path.join(root,name)).find(existsSync)??null;
  const hash=createHash('sha256').update(root), files=new Set();let bytes=0,volatile=false;
  function inspectImportPath(file) {
    if(!inside(root,file))throw new Error('Configuration imports must stay inside the selected checkout without symlinks.');
    let cursor=root;
    for(const part of path.relative(root,file).split(path.sep).filter(Boolean)){
      cursor=path.join(cursor,part);
      try{if(lstatSync(cursor).isSymbolicLink())throw new Error('Configuration imports must stay inside the selected checkout without symlinks.');}
      catch(error){if(error.code==='ENOENT')return;throw error;}
    }
  }
  function visit(file) {
    file=path.resolve(file);if(files.has(file))return;
    if(!inside(root,file)||lstatSync(file).isSymbolicLink()||!inside(root,realpathSync(file)))throw new Error('Configuration imports must stay inside the selected checkout without symlinks.');
    const stat=lstatSync(file);if(!stat.isFile()||stat.size>4*1024*1024||files.size>=10000||(bytes+=stat.size)>64*1024*1024)throw new Error('Configuration dependency discovery exceeded its safety limit.');
    files.add(file);const source=readFileSync(file);hash.update(path.relative(root,file)).update('\0').update(source);
    if(!/\.[cm]?js$/.test(file)){if(!/\.json$/.test(file))volatile=true;return;}
    const text=source.toString('utf8');
    // Parse JavaScript without executing it: comments, multiline imports, escaped
    // specifiers and dynamic expressions must not bypass dependency discovery.
    let tree;try{tree=parse(text,{ecmaVersion:'latest',sourceType:'module',allowReturnOutsideFunction:true});}catch{throw new Error(`Cannot inspect configuration JavaScript in ${path.relative(root,file)}.`);}
    const imports=new Set();
    const inspect=node=>{
      if(!node||typeof node!=='object')return;
      const add=expression=>{if(expression?.type==='Literal'&&typeof expression.value==='string')imports.add(expression.value);else volatile=true;};
      if(['ImportDeclaration','ExportNamedDeclaration','ExportAllDeclaration'].includes(node.type)&&node.source)add(node.source);
      if(node.type==='ImportExpression')add(node.source);
      if(node.type==='CallExpression'&&node.callee.type==='Identifier'&&node.callee.name==='require')add(node.arguments.length===1?node.arguments[0]:null);
      // Aliased loaders and require.resolve are not a statically proven closure.
      if(node.type==='Identifier'&&['createRequire','eval','Function'].includes(node.name))volatile=true;
      if(node.type==='MemberExpression'&&node.object.type==='Identifier'&&node.object.name==='require')volatile=true;
      for(const value of Object.values(node)){if(Array.isArray(value))value.forEach(inspect);else if(value&&typeof value==='object')inspect(value);}
    };
    inspect(tree);
    for(const spec of imports){if(isBuiltin(spec))continue;
      // Package conditions may select different import/require branches. Keep
      // trust explicit on every opening instead of claiming a complete closure.
      if(!spec.startsWith('.'))volatile=true;
      const resolver=createRequire(file);
      // Node resolution can canonicalize and cache an internal symlink target.
      // Inspect the original lookup path as well as the resolved file so a later
      // symlink/junction retarget cannot keep an obsolete trusted fingerprint.
      if(spec.startsWith('.')||path.isAbsolute(spec))inspectImportPath(path.resolve(path.dirname(file),spec));
      else for(const directory of resolver.resolve.paths(spec)??[]){const candidate=path.resolve(directory,spec);if(inside(root,candidate))inspectImportPath(candidate);}
      let target;try{target=resolver.resolve(spec);}catch{throw new Error(`Cannot inspect configuration dependency ${spec}.`);}visit(target);
      // Package metadata can change module resolution independently of source.
      for(let dir=path.dirname(target);inside(root,dir);dir=path.dirname(dir)){const pkg=path.join(dir,'package.json');if(existsSync(pkg))visit(pkg);if(dir===root)break;}
    }
  }
  if(config)visit(config); else hash.update('no-configuration');
  const pkg=path.join(root,'package.json');if(existsSync(pkg))visit(pkg);
  return {root,config,fingerprint:hash.digest('hex'),files:[...files].map(file=>path.relative(root,file)),volatile,executable:!!config};
}
