import { resolveConfig } from './config.mjs';
import { planHandoffsUpgrade } from './handoffs-mode.mjs';
import { planSetupCarry, preConfigView } from './setup-carry.mjs';

// In a handoffs-only project, the plans and prompts an older runlist saved
// before there was a config, which `runlist setup` carries in when it turns
// planning on (src/setup-carry.mjs): counted by setup's own carry planner, so
// the planning-off line says exactly what setup will bring in. The carry reads
// the old default folders only (plans/, the root archive, the root prompts/),
// never the whole project, and nothing here runs on a hook path. Counting
// never stops a command: anything it cannot read counts as nothing.
export async function documentsWaitingForSetup(config) {
  if (config?.mode !== 'handoffs' || !config.configPath) return 0;
  try {
    const upgrade = planHandoffsUpgrade(config);
    const after = await resolveConfig(config.configDir, config.configPath, { overrides: upgrade.overrides });
    const carry = planSetupCarry(await preConfigView(config.repoRoot), after, true);
    return carry.moves.length + carry.outstanding.length;
  } catch { return 0; }
}
