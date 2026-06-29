// Runs after `npm install dotmd-cli`. Because the dotmd Claude Code plugin is a
// separate artifact from this CLI, upgrading the CLI alone leaves the plugin
// (hooks/skill/commands) on its old version. This script bridges that — but
// conservatively:
//
//   - Only on GLOBAL installs (`npm i -g`). A project devDep / CI / Docker
//     install must never touch a user's Claude Code state.
//   - Default: just print a one-line nudge. A CLI install silently mutating the
//     agent's plugin cache is surprising; opt in with DOTMD_AUTO_PLUGIN_UPDATE=1
//     to actually run the refresh.
//   - NEVER fail the install: everything is swallowed and we always exit 0. A
//     nonzero postinstall would break `npm i -g dotmd-cli`.
//   - Skipped entirely under `npm install --ignore-scripts`.
import { spawnSync } from 'node:child_process';

try {
  // Lifecycle env: npm sets this to "true" for global installs.
  if (process.env.npm_config_global !== 'true') process.exit(0);

  const hasClaude = (() => {
    try {
      const cmd = process.platform === 'win32' ? 'where' : 'which';
      return spawnSync(cmd, ['claude'], { encoding: 'utf8' }).status === 0;
    } catch { return false; }
  })();

  if (process.env.DOTMD_AUTO_PLUGIN_UPDATE === '1' && hasClaude) {
    spawnSync('claude', ['plugin', 'update', 'dotmd@dotmd'], { stdio: 'ignore', timeout: 60000 });
    process.stdout.write('dotmd: refreshed the Claude Code plugin — restart your session (or /reload-plugins) to apply.\n');
  } else {
    // The CLI just installed fresh, so only the plugin can be stale — point at
    // the targeted refresh rather than the full `dotmd update` (CLI + plugin).
    const nudge = hasClaude
      ? 'dotmd CLI installed. Using the Claude Code plugin? Run `dotmd update --plugin-only` to refresh it, then restart.'
      : 'dotmd CLI installed.';
    process.stdout.write(`${nudge}\n`);
  }
} catch {
  // Best effort only — never break the install.
}
process.exit(0);
