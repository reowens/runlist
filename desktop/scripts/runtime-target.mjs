import path from 'node:path';

export function runtimeExtractor({platform=process.platform,env=process.env}={}) {
 if(platform!=='win32')return 'tar';
 const systemRoot=env.SystemRoot??env.WINDIR;
 if(!systemRoot||!path.win32.isAbsolute(systemRoot))throw new Error('Windows runtime extraction requires an absolute SystemRoot or WINDIR.');
 // Git Bash can put GNU tar first on PATH, where a drive colon means a remote archive.
 return path.win32.join(systemRoot,'System32','tar.exe');
}

const triples={
 'aarch64-apple-darwin':['darwin','arm64'], 'x86_64-apple-darwin':['darwin','x64'],
 'x86_64-pc-windows-msvc':['win32','x64'], 'aarch64-pc-windows-msvc':['win32','arm64'],
 'x86_64-pc-windows-gnu':['win32','x64'],
 'x86_64-unknown-linux-gnu':['linux','x64'], 'aarch64-unknown-linux-gnu':['linux','arm64']
};
export function selectRuntime(lock,{platform=process.platform,arch=process.arch,target=process.env.RUNLIST_TARGET}={}) {
 if(target){const pair=triples[target];if(!pair)throw new Error(`Unsupported desktop target: ${target}`);[platform,arch]=pair;}
 const pin=lock.platforms?.[platform]?.[arch];
 if(!pin)throw new Error(`No verified desktop runtime for ${platform}/${arch}.`);
 if(!/^node-v[\d.]+-(darwin|linux|win)-(arm64|x64)\.(tar\.gz|zip)$/.test(pin.file)||!/^[a-f0-9]{64}$/.test(pin.sha256))throw new Error('Invalid runtime pin.');
 return {...pin,platform,arch,target:target??null,folder:pin.file.replace(/\.(tar\.gz|zip)$/,''),executable:platform==='win32'?'RunlistHelper.exe':'RunlistHelper',nodePath:platform==='win32'?'node.exe':'bin/node'};
}
