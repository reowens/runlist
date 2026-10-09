import path from 'node:path';
export function isBundledRunlistRuntime(executable,paths=path) {
 return /^RunlistHelper(?:\.exe)?$/i.test(paths.basename(executable));
}
