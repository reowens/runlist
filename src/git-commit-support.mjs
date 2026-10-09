// Keep the service and worker on the same terminal-qualified matrix.
// Linux evidence: Debian 13 ARM64 / Git 2.47.3, pinned Node 24.21.0.
export function commitPlatformQualified(platform=process.platform,arch=process.arch){
 return arch==='arm64'&&(platform==='darwin'||platform==='linux');
}
export function commitVersionQualified(version,platform=process.platform,arch=process.arch){
 if(!commitPlatformQualified(platform,arch))return false;
 return platform==='darwin'?/^git version 2\.(54|55)\.0(?: |$)/.test(version):version==='git version 2.47.3';
}
export function localCommitSupport(version,platform=process.platform,arch=process.arch){
 const available=commitVersionQualified(version,platform,arch);
 const reason=available?null:!commitPlatformQualified(platform,arch)
  ?'Local commits are not available on this platform yet. You can still review and edit documents, then commit with your Git client.'
  :'Local commits are not available with this Git version yet. You can still review and edit documents, then commit with your Git client.';
 return {available,reason};
}
