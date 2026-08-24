import { describe, test } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import {
  ARTIFACT_PREFIX,
  CONFIG_FILENAMES,
  ENV_PREFIX,
  LEGACY_ARTIFACT_PREFIX,
  LEGACY_ENV_PREFIX,
  LEGACY_STATE_DIR,
  STATE_DIR,
  isOwnedArtifact,
  isSidecarArtifact,
  readEnv,
} from '../src/naming.mjs';
import { MutationConflictError, MutationLockError } from '../src/atomic-mutation.mjs';
import { AmbiguousReferenceError } from '../src/reference-planner.mjs';

describe('product-owned naming', () => {
  test('machine-readable errors use the canonical prefix', () => {
    strictEqual(new MutationConflictError('conflict').code, 'RUNLIST_MUTATION_CONFLICT');
    strictEqual(new MutationLockError('timeout').code, 'RUNLIST_MUTATION_LOCK_TIMEOUT');
    strictEqual(
      new AmbiguousReferenceError('x', 'source', 'local', 'repository').code,
      'RUNLIST_AMBIGUOUS_REFERENCE',
    );
  });

  test('current and legacy spellings are distinct', () => {
    ok(STATE_DIR !== LEGACY_STATE_DIR);
    ok(ARTIFACT_PREFIX !== LEGACY_ARTIFACT_PREFIX);
    ok(ENV_PREFIX !== LEGACY_ENV_PREFIX);
  });

  test('artifact readers accept both spellings without accepting near misses', () => {
    ok(isOwnedArtifact('.runlist-index-123', 'index'));
    ok(isOwnedArtifact('.dotmd-index-123', 'index'));
    ok(isOwnedArtifact('.runlist-index-restore-123', 'index'));
    ok(!isOwnedArtifact('runlist-index-123', 'index'));
    ok(!isOwnedArtifact('.runlist-transaction-123', 'index'));
  });

  test('sidecar readers accept both spellings', () => {
    ok(isSidecarArtifact('.plan.md.runlist-tmp-1', 'tmp'));
    ok(isSidecarArtifact('.plan.md.dotmd-tmp-1', 'tmp'));
    ok(!isSidecarArtifact('.plan.md.runlist-recovery-1', 'tmp'));
  });

  test('new environment variables win and old ones remain supported', () => {
    strictEqual(readEnv('DEBUG', { RUNLIST_DEBUG: 'new', DOTMD_DEBUG: 'old' }), 'new');
    strictEqual(readEnv('DEBUG', { DOTMD_DEBUG: 'old' }), 'old');
    strictEqual(readEnv('DEBUG', { RUNLIST_DEBUG: '', DOTMD_DEBUG: 'old' }), '');
    strictEqual(readEnv('DEBUG', {}), undefined);
  });

  test('new config filenames precede every legacy spelling', () => {
    strictEqual(CONFIG_FILENAMES[0], 'runlist.config.mjs');
    ok(CONFIG_FILENAMES.includes('dotmd.config.mjs'));
    const firstLegacy = CONFIG_FILENAMES.findIndex(name => name.includes('dotmd'));
    const lastCurrent = CONFIG_FILENAMES.map(name => name.includes('dotmd')).lastIndexOf(false);
    ok(lastCurrent < firstLegacy);
    strictEqual(new Set(CONFIG_FILENAMES).size, CONFIG_FILENAMES.length);
  });
});
