// Explicit noninteractive signing profiles. No renderer-supplied executables,
// shell commands, agent forwarding, passphrases or UI credential operations.
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,realpathSync,existsSync,openSync,closeSync,constants} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {hash,fail,safeFile} from './git-commit-store.mjs';
import {gitEnvironment} from './app-git.mjs';
import {processStartIdentity} from './atomic-mutation.mjs';
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const material=file=>{const st=safeFile(file);return {hash:hash(readFileSync(file)),mode:st.mode&0o777};};
function privateFile(file,bytes){if(existsSync(file))safeFile(file);const fd=openSync(file,constants.O_WRONLY|constants.O_CREAT|constants.O_TRUNC|constants.O_NOFOLLOW,0o600);try{writeFileSync(fd,bytes);}finally{closeSync(fd);}}
function binary(value,root){
 const candidates=value.includes('/')?[path.resolve(root,value)]:(gitEnvironment().PATH??'').split(path.delimiter).map(dir=>path.join(dir,value));
 for(const candidate of candidates)if(existsSync(candidate)){const file=realpathSync(candidate),st=safeFile(file);if(st.mode&0o111)return {file,material:material(file)};}
 fail('git-signing-unavailable','The configured signing executable is unavailable. Use your Git signing workflow.');
}
export function signingProfile(r,run){
 const config=(name,pathValue=false)=>{const q=run(r,['config',...(pathValue?['--path']:[]),'--get',name],{allow:[0,1]});return q.code===0?q.text():null;};
 const required=run(r,['config','--bool','--get','commit.gpgSign'],{allow:[0,1]});if(required.code!==0||required.text()!=='true')return {format:'none'};
 const format=config('gpg.format')??'openpgp',key=config('user.signingkey',format==='ssh');
 if(!key||key.includes('\0'))fail('git-signing-unsupported','Noninteractive signing requires an explicit user.signingkey. Configure it with Git.');
 if(format==='ssh'){
  if(/^(key::|ssh-)/.test(key))fail('git-signing-unsupported','SSH agent/public-key signing is not qualified. Use an explicit local private key or your Git workflow.');
  const file=path.resolve(r.root,key);if(!existsSync(file))fail('git-signing-unsupported','The configured SSH private-key file is unavailable.');const keyMaterial=material(file);if(!readFileSync(file).subarray(0,80).toString().includes('BEGIN OPENSSH PRIVATE KEY'))fail('git-signing-unsupported','SSH signing requires a local OpenSSH private-key file. Agent and hardware signing remain separate.');
  const program=binary(config('gpg.ssh.program',true)??'ssh-keygen',r.root);if(path.basename(program.file)!=='ssh-keygen')fail('git-signing-unsupported','Custom SSH signer commands are not qualified. Use ssh-keygen or your Git workflow.');
  return {format,key:file,keyMaterial,program};
 }
 if(format!=='openpgp'||! /^[a-f0-9]{40}!?$/i.test(key))fail('git-signing-unsupported','Noninteractive OpenPGP signing requires a full key fingerprint. X.509 and other signer formats remain separate.');
 const named=config('gpg.openpgp.program',true),legacy=config('gpg.program',true);if(named&&legacy&&named!==legacy)fail('git-signing-unsupported','Conflicting OpenPGP program aliases require your Git workflow; Runlist will not select or bypass either signer.');
 const program=binary(named??legacy??'gpg',r.root);if(!/^gpg2?$/.test(path.basename(program.file)))fail('git-signing-unsupported','Custom OpenPGP signer commands are not qualified. Use GnuPG or your Git workflow.');
 return {format,key,home:path.resolve(process.env.GNUPGHOME??path.join(os.homedir(),'.gnupg')),program};
}
export function signerEnvironment(profile){
 const env=gitEnvironment();env.SSH_AUTH_SOCK='';env.SSH_ASKPASS='/usr/bin/false';env.SSH_ASKPASS_REQUIRE='force';env.DISPLAY='runlist-noninteractive';
 if(profile.format==='openpgp')env.GNUPGHOME=profile.home;
 return env;
}
const gpgArgs=['--batch','--no-tty','--no-autostart','--pinentry-mode','error','--no-auto-key-retrieve','--auto-key-locate','clear'];
function tool(profile,args,input){
 if(!equal(material(profile.program.file),profile.program.material))fail('git-review-changed','The signing executable changed after review.');
 const q=spawnSync(profile.program.file,[...(profile.format==='openpgp'?gpgArgs:[]),...args],{env:signerEnvironment(profile),input,timeout:10000,maxBuffer:128000,killSignal:'SIGKILL',windowsHide:true});
 if(q.error||q.status!==0)fail('git-signing-failed','Noninteractive signing or signature verification failed. No credential dialog was requested; inspect the retained outcome and use your Git workflow.');
 return q;
}
export function prepareSigning(store,r,worker,shell){
 const profile=r.material.signing;if(profile.format==='none')return [];
 if(profile.format==='ssh'){
  const pub=tool(profile,['-y','-P','','-f',profile.key]).stdout.toString().trim();if(!/^ssh-ed25519 [A-Za-z0-9+/=]+(?: |$)/.test(pub))fail('git-signing-unsupported','Only local Ed25519 SSH signing keys are qualified.');
  store.update(r.id,d=>{d.signingPublicKey=pub.split(' ').slice(0,2).join(' ');});
 }
 const wrapper=path.join(store.job(r.id),'signer');writeFileSync(wrapper,'#!/bin/sh\nexec '+shell(process.execPath)+' --max-old-space-size=128 '+shell(worker)+' --sign '+shell(r.root)+' '+shell(r.actor.id)+' '+shell(r.id)+' "$@"\n',{flag:'wx',mode:0o700});
 return ['-c',`gpg.${profile.format}.program=${wrapper}`,...(profile.format==='openpgp'?['-c',`gpg.program=${wrapper}`]:[])];
}
export function signingInvocation(store,id,args){
 const r=store.read(id),profile=r.material?.signing;if(!profile||profile.format==='none'||r.gitOwner?.pid!==process.ppid||r.gitOwner.processStartIdentity!==processStartIdentity(process.ppid))fail('git-signer-owner','The signer was invoked outside its registered Git process.');
 if(!equal(material(profile.program.file),profile.program.material))fail('git-review-changed','The configured signer changed after review.');
 const q=spawnSync(profile.program.file,[...(profile.format==='openpgp'?gpgArgs:[]),...args],{cwd:r.root,env:signerEnvironment(profile),stdio:'inherit',timeout:10000,killSignal:'SIGKILL',windowsHide:true});
 if(q.error||q.status!==0){store.update(id,d=>{d.failure={code:'git-signing-failed',message:'The configured signer could not sign noninteractively. Its requirement was not bypassed. Inspect the retained outcome.'};});if(q.error?.code==='ETIMEDOUT'){process.kill(-r.workerOwner.pid,'SIGKILL');return;}fail('git-signing-failed','The noninteractive signer refused the commit.');}
}
export function verifySignature(r,raw,job){
 const profile=r.material?.signing??{format:'none'},split=raw.indexOf('\n\n'),lines=raw.subarray(0,split).toString('utf8').split('\n'),unsigned=[],signature=[];let active=false,count=0;
 for(const line of lines){if(line.startsWith('gpgsig ')){active=true;count++;signature.push(line.slice(7));}else if(active&&line.startsWith(' '))signature.push(line.slice(1));else{active=false;unsigned.push(line);}}
 if(profile.format==='none'){if(count)fail('git-signature-unreviewed','An unreviewed signature was added.');return;}
 if(count!==1)fail('git-signature-unreviewed','The configured signed commit has no unique signature.');
 const payload=Buffer.concat([Buffer.from(unsigned.join('\n')+'\n\n'),raw.subarray(split+2)]),sig=signature.join('\n')+'\n',file=path.join(job,'verify-signature');privateFile(file,sig);
 if(profile.format==='ssh'){
  if(!r.signingPublicKey||!sig.startsWith('-----BEGIN SSH SIGNATURE-----'))fail('git-signature-unreviewed','The SSH signature differs from the reviewed signing profile.');
  const allowed=path.join(job,'verify-signers');privateFile(allowed,'runlist '+r.signingPublicKey+'\n');tool(profile,['-Y','verify','-f',allowed,'-I','runlist','-n','git','-s',file],payload);
 }else{
  if(!sig.startsWith('-----BEGIN PGP SIGNATURE-----'))fail('git-signature-unreviewed','The OpenPGP signature differs from the reviewed signing profile.');
  const q=tool(profile,['--status-fd=1','--verify',file,'-'],payload),valid=q.stdout.toString().split('\n').find(line=>line.startsWith('[GNUPG:] VALIDSIG ')),fields=valid?.slice(18).split(' ')??[],key=profile.key.replace(/!$/,'').toUpperCase();
  if(!(profile.key.endsWith('!')?fields[0]===key:fields[0]===key||fields.at(-1)===key))fail('git-signature-unreviewed','The signature was made by another OpenPGP key.');
 }
}
