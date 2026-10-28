import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export function prepareReleaseDocUpdates(root, version) {
  return ['README.md', 'desktop/README.md'].filter(file => existsSync(path.join(root, file))).map(relative => {
    const file = path.join(root, relative), text = readFileSync(file, 'utf8');
    const expression = /<!-- runlist:release:start -->[\s\S]*?<!-- runlist:release:end -->/g;
    if ([...text.matchAll(expression)].length !== 1) throw new Error(`Missing unique release-version markers in ${relative}.`);
    const section = `<!-- runlist:release:start -->\nCLI and desktop release version: **${version}**.\n[Mac installer and release notes](https://github.com/reowens/runlist/releases/tag/desktop-v${version}).\nNormal product releases publish both components. Local app installation is separate from release acceptance.\n<!-- runlist:release:end -->`;
    return { file, content: text.replace(expression, section) };
  });
}
