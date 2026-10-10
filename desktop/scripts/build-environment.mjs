import path from 'node:path';
import os from 'node:os';

export function privateBuildEnvironment(repo, env = process.env, home = os.homedir()) {
  const flags = env.CARGO_ENCODED_RUSTFLAGS !== undefined
    ? env.CARGO_ENCODED_RUSTFLAGS.split('\x1f').filter(Boolean)
    : (env.RUSTFLAGS ?? '').split(/\s+/).filter(Boolean);
  // Encoded flags preserve paths containing spaces. Later rules take precedence.
  flags.push(`--remap-path-prefix=${path.resolve(home)}=/build/home`);
  flags.push(`--remap-path-prefix=${path.resolve(repo)}=/runlist`);
  return { ...env, CARGO_ENCODED_RUSTFLAGS: flags.join('\x1f') };
}
