import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export function desktopReleaseEnvironment(root, env = process.env) {
  const file = env.RUNLIST_RELEASE_CONFIG || path.join(root, '.runlist', 'release-config.json');
  const config = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  return {
    ...env,
    RUNLIST_SIGN_IDENTITY: env.RUNLIST_SIGN_IDENTITY || config.signIdentity,
    RUNLIST_SIGN_TEAM: env.RUNLIST_SIGN_TEAM || config.signTeam,
    RUNLIST_NOTARY_PROFILE: env.RUNLIST_NOTARY_PROFILE || config.notaryProfile,
    CARGO_BUILD_JOBS: env.CARGO_BUILD_JOBS || '1',
  };
}

export function preflightDesktopRelease(root, { env = process.env, platform = process.platform, arch = process.arch } = {}) {
  if (!existsSync(path.join(root, 'desktop/package.json'))) return;
  if (platform !== 'darwin' || arch !== 'arm64') throw new Error('Product releases require the qualified Apple Silicon Mac desktop release host.');
  const signing = desktopReleaseEnvironment(root, env);
  for (const key of ['RUNLIST_SIGN_IDENTITY', 'RUNLIST_SIGN_TEAM', 'RUNLIST_NOTARY_PROFILE']) {
    if (typeof signing[key] !== 'string' || !signing[key].trim()) {
      throw new Error(`Desktop release requires ${key}; configure the environment or private .runlist/release-config.json before versioning.`);
    }
  }
  if (signing.RUNLIST_SIGN_TEAM !== '7GSPYYN5X8') throw new Error('Desktop release signing team differs from the supported installer trust policy.');
  return signing;
}
