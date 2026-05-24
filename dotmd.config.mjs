// dotmd.config.mjs — document management configuration
// All exports are optional. See dotmd.config.example.mjs for full reference.

export const root = 'docs';

export const index = {
  path: 'docs/docs.md',
  startMarker: '<!-- GENERATED:dotmd:start -->',
  endMarker: '<!-- GENERATED:dotmd:end -->',
  archivedLimit: 8,
};
