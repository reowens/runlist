import { readFileSync } from 'node:fs';
import { runUpdate } from '../src/update.mjs';

// The release has already installed/verified the CLI in every visible prefix.
// Reuse normal update planning for installed hosts only, with an exact release
// version check. Failure leaves release intent intact for release:resume.
const expectedVersion = process.argv[2];
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
if (!expectedVersion || expectedVersion !== version) {
  process.stderr.write(`host update requires this CLI version (${version}), got ${expectedVersion ?? 'no version'}\n`);
  process.exitCode = 1;
} else {
  await runUpdate(['--plugin-only'], null, { expectedVersion });
  if (!process.exitCode) process.stdout.write(`Installed host integrations verified against ${expectedVersion}\n`);
}
