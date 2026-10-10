// Neutral publication checks; no private vocabulary or credentials.
export const PRIVATE_ROOT = /^(?:docs|\.runlist|\.dotmd|\.gmax|\.claude\/logs|desktop\/releases)(?:\/|$)/;
export const CREDENTIAL_FILE = /(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|[^/]*\.(?:pem|p12|pfx|key))$/;


export function inspectBaselineText(text, file) {
  const findings = [];
  const fixture = /^(?:test|desktop\/test)\//.test(file);
  for (const [index, line] of text.split('\n').entries()) {
    const paths = line.match(/\/(?:Users|home)\/[a-z0-9._-]+/g) ?? [];
    if (paths.some(value => !fixture || !/\/(?:test|me|u|user|example)$/i.test(value))) {
      findings.push({ file, line: index + 1, category: 'personal absolute path' });
    }
    if (file.endsWith('.json') && !fixture && /"email"\s*:/.test(line)) {
      findings.push({ file, line: index + 1, category: 'contact address in public metadata' });
    }
  }
  return findings;
}
