import {existsSync} from 'node:fs';
import {execFileSync,spawn} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
// This is a launch plan only; it never reads checkout configuration.
export function desktopLaunch(argv,{platform=process.platform,env=process.env,home=os.homedir(),exists=existsSync}={}) {
 const paths=platform==='win32'?path.win32:path.posix;
 const at=argv.indexOf('--app');
 if(at>=0&&(!argv[at+1]||argv[at+1].startsWith('--')))throw new Error('--app requires the installed application path.');
 let candidates;
 if(platform==='darwin')candidates=['/Applications/Runlist.app',paths.join(home,'Applications/Runlist.app')];
 else if(platform==='win32')candidates=[env.LOCALAPPDATA,env.ProgramFiles,env['ProgramFiles(x86)']].filter(Boolean).map(root=>paths.join(root,'Runlist','Runlist.exe'));
 else if(platform==='linux')candidates=['/usr/bin/Runlist','/usr/bin/runlist','/usr/local/bin/Runlist','/usr/local/bin/runlist'];
 else throw new Error('Runlist desktop packaging is available for macOS, Windows and Linux.');
 const app=at>=0?paths.resolve(argv[at+1]):candidates.find(exists);
 return {platform,app,program:platform==='darwin'?'/usr/bin/open':app,args:platform==='darwin'&&app?['-a',app]:[]};
}
export function runDesktop(argv,{dryRun=false}={}) {
 const launch=desktopLaunch(argv);
 if(dryRun){process.stdout.write(`Would open ${launch.app??'the installed Runlist application'}${launch.platform==='darwin'?' through macOS LaunchServices':''}. Choose a trusted checkout in the app. No server starts.\n`);return;}
 if(!launch.app||!existsSync(launch.app))throw new Error('Runlist is not installed. Run runlist desktop install, or use runlist desktop --app /path/to/the/application.');
 if(launch.platform==='darwin')execFileSync(launch.program,launch.args,{stdio:'ignore'});
 else {const child=spawn(launch.program,launch.args,{detached:true,stdio:'ignore',windowsHide:true,shell:false});child.on('error',error=>{process.stderr.write(`Cannot launch Runlist: ${error.message}\n`);process.exitCode=1;});child.once('spawn',()=>{process.stdout.write('Opened Runlist. Choose a checkout folder in the application. Local files; no listening server.\n');child.unref();});return;}
 process.stdout.write('Opened Runlist. Choose a checkout folder in the application. Local files; no listening server.\n');
}
