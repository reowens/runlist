import {it} from 'node:test';
import {strictEqual} from 'node:assert';
import path from 'node:path';
import {isPathInside,containingRoot} from '../src/path-containment.mjs';

it('rejects Windows parent, sibling-prefix, other-drive and other-UNC-share paths',()=>{
  const win=path.win32,root=String.raw`C:\audit\checkout`;
  for(const file of [String.raw`C:\audit\outside\dep.mjs`,String.raw`C:\audit\checkout-other\dep.mjs`,String.raw`C:\audit`,String.raw`D:\audit\checkout\dep.mjs`,String.raw`\\server\share\checkout\dep.mjs`,String.raw`C:relative.mjs`]) strictEqual(isPathInside(root,file,win),false,file);
  strictEqual(isPathInside(root,root,win),true);
  strictEqual(isPathInside(root,String.raw`C:\audit\checkout\nested\dep.mjs`,win),true);
  strictEqual(isPathInside(root,String.raw`C:/audit/checkout/nested/../dep.mjs`,win),true);
  strictEqual(isPathInside(root,String.raw`C:\audit\checkout\..\outside\dep.mjs`,win),false);
  const unc=String.raw`\\server\share\checkout`;
  strictEqual(isPathInside(unc,String.raw`\\server\share\checkout\dep.mjs`,win),true);
  for(const file of [String.raw`\\server\share\outside\dep.mjs`,String.raw`\\server\other\checkout\dep.mjs`,String.raw`\\other\share\checkout\dep.mjs`]) strictEqual(isPathInside(unc,file,win),false,file);
});

it('keeps extended Windows namespaces contained within their actual drive/share',()=>{
  const win=path.win32,root=String.raw`\\?\C:\audit\checkout`,unc=String.raw`\\?\UNC\server\share\checkout`;
  strictEqual(isPathInside(root,String.raw`\\?\C:\audit\checkout\dep.mjs`,win),true);
  strictEqual(isPathInside(root,String.raw`\\?\C:\audit\outside\dep.mjs`,win),false);
  strictEqual(isPathInside(root,String.raw`\\?\D:\audit\checkout\dep.mjs`,win),false);
  strictEqual(isPathInside(unc,String.raw`\\?\UNC\server\share\checkout\dep.mjs`,win),true);
  strictEqual(isPathInside(unc,String.raw`\\?\UNC\server\other\checkout\dep.mjs`,win),false);
  // Ambiguous namespace aliases are not authority; canonical filesystem checks
  // remain required by trust discovery rather than stripping prefixes here.
  strictEqual(isPathInside(root,String.raw`C:\audit\checkout\dep.mjs`,win),false);
});

it('uses component boundaries on POSIX without rejecting literal backslashes',()=>{
  for(const file of ['/checkout-other/dep.mjs','/checkout/../outside/dep.mjs','/']) strictEqual(isPathInside('/checkout',file,path.posix),false,file);
  strictEqual(isPathInside('/checkout','/checkout/..\\literal.mjs',path.posix),true);
  strictEqual(isPathInside('/checkout','/checkout/nested/dep.mjs',path.posix),true);
  strictEqual(isPathInside('checkout','/checkout/dep.mjs',path.posix),false);
});

it('selects the deepest containing lifecycle root without admitting a sibling or drive',()=>{
  const win=path.win32,roots=[String.raw`C:\repo\docs`,String.raw`C:\repo\docs\team`,String.raw`C:\repo\docs-team`,String.raw`D:\repo\docs\team`];
  strictEqual(containingRoot(String.raw`C:\repo\docs\team\plan.md`,roots,win),roots[1]);
  strictEqual(containingRoot(String.raw`C:\repo\docs\other\plan.md`,roots,win),roots[0]);
  strictEqual(containingRoot(String.raw`C:\repo\docs-other\plan.md`,roots,win),null);
  strictEqual(containingRoot(String.raw`E:\repo\docs\team\plan.md`,roots,win),null);
  strictEqual(containingRoot('/repo/docs/team/plan.md',['/repo/docs','/repo/docs/team'],path.posix),'/repo/docs/team');
});
