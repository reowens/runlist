export function helperEnvironment(extra={}) {
 const env={};
 for(const key of ['HOME','USER','LOGNAME','USERPROFILE','USERNAME','SystemRoot','WINDIR','APPDATA','LOCALAPPDATA','TEMP','TMP','TMPDIR','LANG','LC_ALL','GNUPGHOME'])if(process.env[key]!==undefined)env[key]=process.env[key];
 env.PATH=process.platform==='win32'?process.env.PATH:'/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
 return {...env,NODE_OPTIONS:'',...extra};
}
