import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { cleanNpmEnv } from './sync-global-cli.mjs';

const SIGN_TEAM = '7GSPYYN5X8';
// The App Store Connect issuer of the same personal team, pinned by its SHA-256 so
// the public repository carries no account identifier. An issuer belongs to one
// team, so a key from any other team is refused here.
export const NOTARY_ISSUER_SHA256 = 'e7be6dfa3fbf7f28b2cc9d1d0a7dd95d243611711c8b7acd442381bd3af93db2';

export function desktopReleaseEnvironment(root, env = process.env) {
  env = cleanNpmEnv(path.dirname(process.execPath), env);
  const file = env.RUNLIST_RELEASE_CONFIG || path.join(root, '.runlist', 'release-config.json');
  const config = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  return {
    ...env,
    RUNLIST_SIGN_IDENTITY: env.RUNLIST_SIGN_IDENTITY || config.signIdentity,
    RUNLIST_SIGN_TEAM: env.RUNLIST_SIGN_TEAM || config.signTeam,
    RUNLIST_NOTARY_PROFILE: env.RUNLIST_NOTARY_PROFILE || config.notaryProfile,
    RUNLIST_NOTARY_KEY: env.RUNLIST_NOTARY_KEY || config.notaryKey,
    RUNLIST_NOTARY_KEY_ID: env.RUNLIST_NOTARY_KEY_ID || config.notaryKeyId,
    RUNLIST_NOTARY_ISSUER: env.RUNLIST_NOTARY_ISSUER || config.notaryIssuer,
    CARGO_BUILD_JOBS: env.CARGO_BUILD_JOBS || '1',
  };
}

// Notarization runs only on the signing team's App Store Connect key. A Keychain
// profile is refused because nothing it answers names its team, which is how
// releases 0.95 to 0.98.3 came to be notarized under another team unnoticed.
export function notaryCredentials(env = process.env, { issuerSha256 = NOTARY_ISSUER_SHA256 } = {}) {
  if (env.RUNLIST_NOTARY_PROFILE) {
    throw new Error(`Desktop notarization refuses a Keychain profile: its team cannot be checked. Name team ${SIGN_TEAM}'s App Store Connect key (notaryKey, notaryKeyId, notaryIssuer) instead.`);
  }
  const key = env.RUNLIST_NOTARY_KEY, keyId = env.RUNLIST_NOTARY_KEY_ID, issuer = env.RUNLIST_NOTARY_ISSUER;
  for (const [name, value] of [['RUNLIST_NOTARY_KEY', key], ['RUNLIST_NOTARY_KEY_ID', keyId], ['RUNLIST_NOTARY_ISSUER', issuer]]) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`Desktop release requires ${name}; configure the environment or private .runlist/release-config.json before versioning.`);
    }
  }
  if (createHash('sha256').update(issuer).digest('hex') !== issuerSha256) {
    throw new Error(`Desktop notarization credentials belong to a team other than ${SIGN_TEAM}; runlist is notarized only under the team that signs it.`);
  }
  if (path.basename(key) !== `AuthKey_${keyId}.p8`) throw new Error('RUNLIST_NOTARY_KEY must be the AuthKey_<RUNLIST_NOTARY_KEY_ID>.p8 file of that key.');
  if (!existsSync(key)) throw new Error(`The notarization key file is missing: ${key}`);
  return { key, keyId, issuer };
}

export function preflightDesktopRelease(root, { env = process.env, platform = process.platform, arch = process.arch, issuerSha256 } = {}) {
  if (!existsSync(path.join(root, 'desktop/package.json'))) return;
  if (platform !== 'darwin' || arch !== 'arm64') throw new Error('Product releases require the qualified Apple Silicon Mac desktop release host.');
  const signing = desktopReleaseEnvironment(root, env);
  for (const key of ['RUNLIST_SIGN_IDENTITY', 'RUNLIST_SIGN_TEAM']) {
    if (typeof signing[key] !== 'string' || !signing[key].trim()) {
      throw new Error(`Desktop release requires ${key}; configure the environment or private .runlist/release-config.json before versioning.`);
    }
  }
  if (signing.RUNLIST_SIGN_TEAM !== SIGN_TEAM) throw new Error('Desktop release signing team differs from the supported installer trust policy.');
  notaryCredentials(signing, issuerSha256 ? { issuerSha256 } : undefined);
  return signing;
}
