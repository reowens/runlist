import { updateInstalledHosts } from '../src/update.mjs';

// The release has already installed/verified the CLI in every visible prefix.
// Reuse normal update planning for installed hosts only, with an exact release
// version check. Failure leaves release intent intact for release:resume.
await updateInstalledHosts(process.argv[2]);
