#!/usr/bin/env node

// Legacy executable alias. Share the canonical dispatcher so both names stay
// compatible throughout the migration window.
await import('./runlist.mjs');
