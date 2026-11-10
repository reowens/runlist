// Versioned, read-only interface shared by roadmap and planning consumers.
export const GATE_API_VERSION = 1;
export { parseGate, gateDeclarations } from './gate-source.mjs';
export { createGateReader } from './gates.mjs';
export { resolveConfig } from './config.mjs';
export { buildIndex } from './index.mjs';
