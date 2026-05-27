// `dotmd surfaces` — print the configured surface taxonomy.
//
// The surface taxonomy (`config.taxonomy.surfaces`) gates which `surfaces:`
// values the validator accepts. Before this command existed the only way to
// discover the valid set was to grep sibling plans or open the config file —
// which sent agents into a retry loop of "guess a surface, run check, get
// flagged, guess again." See issue #12 trap 1.
import { dim } from './color.mjs';

export function runSurfaces(argv, config) {
  const json = argv.includes('--json');
  // Read from raw user config (preserves declaration order) — `config.taxonomy`
  // isn't exposed on the resolved object; only the derived `validSurfaces` Set is.
  const surfaces = config.raw?.taxonomy?.surfaces ?? null;

  if (json) {
    process.stdout.write(JSON.stringify({ surfaces: surfaces ?? [] }, null, 2) + '\n');
    return;
  }

  if (!surfaces || surfaces.length === 0) {
    process.stdout.write(dim('No surface taxonomy configured. Any surface value is accepted.\n'));
    process.stdout.write(dim('To restrict, set `taxonomy.surfaces` in dotmd.config.mjs.\n'));
    return;
  }

  for (const s of surfaces) process.stdout.write(s + '\n');
}
