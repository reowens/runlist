#!/usr/bin/env node

// Canonical executable. The implementation remains shared with the retired
// `dotmd` alias during the compatibility window so both commands behave
// identically and cannot drift.
await import('./dotmd.mjs');
