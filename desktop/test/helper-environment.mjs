import {realpathSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A test project in the temporary folder never resolves to a Git repository
// that holds that folder, as when the temporary folder sits in a home folder
// that is itself a repository. Importing this module sets it for the test
// process and every child it starts.
process.env.GIT_CEILING_DIRECTORIES=[realpathSync(os.tmpdir()),process.env.GIT_CEILING_DIRECTORIES].filter(Boolean).join(path.delimiter);

export function helperEnvironment(extra={}) {
 const env={};
 for(const key of ['HOME','USER','LOGNAME','USERPROFILE','USERNAME','SystemRoot','WINDIR','APPDATA','LOCALAPPDATA','TEMP','TMP','TMPDIR','LANG','LC_ALL','GNUPGHOME','GIT_CEILING_DIRECTORIES'])if(process.env[key]!==undefined)env[key]=process.env[key];
 env.PATH=process.platform==='win32'?process.env.PATH:'/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
 return {...env,NODE_OPTIONS:'',...extra};
}
