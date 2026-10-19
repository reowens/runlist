import { collectDocFiles, resolveDocArg } from './index.mjs';
import { authorizeManagedSweep } from './managed-path.mjs';
import { assertPlanMutationAuthorized, ownershipPathFor, availableSessionId } from './pickup.mjs';
import { mutateFileSet } from './atomic-mutation.mjs';

export function resolveRepairSources(inputs, config) {
  const files = inputs.length ? [...new Set(inputs.map(input => resolveDocArg(input, config)))] : collectDocFiles(config);
  authorizeManagedSweep(files, config, { kind: 'Repair source' });
  return files;
}

export function publishRepairs(repairs, config, opts = {}) {
  const changed = repairs.filter(item => item.content !== item.expectedContent);
  const guards = changed.map(item => {
    const ownership = assertPlanMutationAuthorized(item.path, config, { sessionId: availableSessionId() });
    return ownership ? { path: ownership.recordPath, expectedContent: ownership.raw }
      : { path: ownershipPathFor(item.path, config), absent: true };
  });
  if (opts.dryRun || !changed.length) return;
  mutateFileSet({ updates: changed.map(item => ({ path: item.path,
    expectedContent: item.expectedContent, render: () => item.content })), guards },
  { repoRoot: config.repoRoot, testHooks: opts.testHooks });
}
