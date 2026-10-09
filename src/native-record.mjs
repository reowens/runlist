import { readFileSync } from 'node:fs';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';

export const NATIVE_RECORD_SCHEMA = 'runlist.record/v1';
export const NATIVE_RECORD_METADATA_BYTES = 256 * 1024;
const schema = JSON.parse(readFileSync(new URL('../assets/schemas/runlist-record-v1.schema.json', import.meta.url), 'utf8'));
export const nativeRecordSchema = () => structuredClone(schema);

// This validator implements only the keywords used by the bundled schema.
// It is not a general JSON Schema engine. External tools can use the same
// document with a Draft 2020-12 implementation.
function schemaErrors(value, rule, at = '$') {
  const errors = [];
  const add = message => errors.push({ code: 'record-schema', path: at, message });
  if (rule.$ref) return schemaErrors(value, schema.$defs[rule.$ref.split('/').at(-1)], at);
  if (rule.allOf) for (const child of rule.allOf) errors.push(...schemaErrors(value, child, at));
  if (rule.oneOf && rule.oneOf.filter(child => schemaErrors(value, child, at).length === 0).length !== 1) {
    add('Must match exactly one record kind.');
    const selected = rule.oneOf.find(child => child.properties?.type?.const === value?.type);
    if (selected) errors.push(...schemaErrors(value, selected, at));
  }
  if (Object.hasOwn(rule, 'const') && value !== rule.const) add(`Expected ${JSON.stringify(rule.const)}.`);
  if (rule.enum && !rule.enum.includes(value)) add(`Expected one of ${rule.enum.join(', ')}.`);
  const matches = type => type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
    : type === 'array' ? Array.isArray(value) : type === 'integer' ? Number.isSafeInteger(value) : typeof value === type;
  if (rule.type && !matches(rule.type)) { add(`Expected ${rule.type}.`); return errors; }
  if (typeof value === 'string') {
    if (rule.minLength && [...value].length < rule.minLength) add('Must not be empty.');
    if (rule.pattern && !new RegExp(rule.pattern).test(value)) add('Value does not match the required pattern.');
    if (rule.format === 'date-time') {
      const valid = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
      if (!valid || new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19)) add('Expected a valid UTC timestamp.');
    }
  }
  if (typeof value === 'number' && rule.minimum !== undefined && value < rule.minimum) add(`Must be at least ${rule.minimum}.`);
  if (Array.isArray(value) && rule.items) value.forEach((item, i) => errors.push(...schemaErrors(item, rule.items, `${at}[${i}]`)));
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of rule.required ?? []) if (!Object.hasOwn(value, key)) errors.push({ code: 'record-schema', path: `${at}.${key}`, message: 'Required field is missing.' });
    for (const [key, child] of Object.entries(rule.properties ?? {})) if (Object.hasOwn(value, key)) errors.push(...schemaErrors(value[key], child, `${at}.${key}`));
  }
  return errors;
}

function strictJson(text) {
  if (Buffer.byteLength(text) > NATIVE_RECORD_METADATA_BYTES) throw new Error('Record metadata exceeds 256 KiB.');
  const value = JSON.parse(text);
  let i = 0;
  const whitespace = () => { while (/\s/.test(text[i] ?? '') && i < text.length) i++; };
  const string = () => {
    const start = i++;
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i++] === '"') return JSON.parse(text.slice(start, i));
    }
  };
  const visit = depth => {
    if (depth > 64) throw new Error('Record metadata exceeds 64 nesting levels.');
    whitespace();
    const token = text[i];
    if (token === '"') { string(); return; }
    if (token === '{' || token === '[') {
      const object = token === '{';
      const end = object ? '}' : ']';
      const keys = new Set();
      i++; whitespace();
      while (text[i] !== end) {
        if (object) {
          const key = string();
          if (keys.has(key)) throw new Error(`Duplicate JSON key ${JSON.stringify(key)} at offset ${i}.`);
          keys.add(key); whitespace(); i++;
        }
        visit(depth + 1); whitespace();
        if (text[i] !== ',') break;
        i++; whitespace();
      }
      i++;
    } else {
      while (i < text.length && !/[\s,\]}]/.test(text[i])) i++;
    }
  };
  visit(0);
  return value;
}

export function nativePlanItems(body) {
  const items = [];
  const lines = body.split('\n');
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const marker = lines[i].match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      continue;
    }
    if (fence) continue;
    const anchor = lines[i].match(/^ {0,3}<!-- runlist:item (item:[^\s]+) -->\s*$/);
    if (!anchor) continue;
    const next = lines[i + 1] ?? '';
    const task = next.match(/^ {0,3}[-*+] \[([ xX])\] (.+)$/);
    const phase = next.match(/^(#{2,6}) (.+)$/);
    items.push({ id: anchor[1], kind: task ? 'task' : phase ? 'phase' : 'invalid', complete: task ? task[1].toLowerCase() === 'x' : null, line: i + 1 });
  }
  return items;
}

function envelopeErrors(text) {
  const errors = [];
  let mode = null;
  let blockIndent = null;
  for (const [i, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    const key = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (key) {
      mode = /^[>|][-+]?\s*$/.test(key[2]) ? 'block' : !key[2].trim() ? 'array' : null;
      blockIndent = null;
      continue;
    }
    if (line.startsWith('#')) { mode = null; continue; }
    const indent = line.match(/^ */)[0].length;
    if (mode === 'block' && indent > 0 && (blockIndent === null || indent >= blockIndent)) {
      blockIndent ??= indent;
      continue;
    }
    if (mode === 'array' && /^ {2}- (?![A-Za-z0-9_-]+:\s).+/.test(line)) continue;
    errors.push({ code: 'unsupported-frontmatter', path: `$.frontmatter.line[${i + 1}]`, message: 'Use the flat frontmatter subset; nested metadata belongs in the literal JSON record_data block.' });
  }
  return errors;
}

export function validateNativeRecord(record, { body = '' } = {}) {
  const errors = schemaErrors(record, schema);
  if (errors.length) return errors;
  const data = record.record_data;
  const add = (path, message, code = 'record-invariant') => errors.push({ code, path, message });
  if (data.requires?.length) add('$.record_data.requires', 'Unknown required features; expose source but do not perform managed edits.', 'unsupported-feature');
  const declarations = new Set([record.id]);
  for (const field of ['evidence','relations','history','options','rulings','resolutions']) {
    for (const entry of data[field] ?? []) {
      if (declarations.has(entry.id)) add(`$.record_data.${field}`, `Duplicate declared ID ${entry.id}.`);
      declarations.add(entry.id);
    }
  }
  const items = record.type === 'plan' ? nativePlanItems(body) : [];
  const itemPattern = schema.$defs.target.properties.id.pattern.replace('(plan|item|flag|decision|evidence)', '(item)');
  for (const item of items) {
    if (item.kind === 'invalid' || !new RegExp(itemPattern).test(item.id)) add('$.body', `Invalid item anchor at body line ${item.line}.`);
    if (declarations.has(item.id)) add('$.body', `Duplicate declared ID ${item.id}.`);
    declarations.add(item.id);
  }
  const ownedSources = new Set([record.id, ...items.map(item => item.id)]);
  const evidence = new Map(data.evidence.map(e => [e.id, e]));
  const checkEvidence = (ids, at) => { for (const id of ids ?? []) if (!evidence.has(id)) add(at, `Unknown local evidence ID ${id}.`); };
  for (const alias of data.aliases) if (data.aliases.filter(a => a.value === alias.value && a.namespace === alias.namespace).length > 1) add('$.record_data.aliases', 'Duplicate alias in the same namespace.');
  const relativePath = value => !value.startsWith('/') && !value.includes('\\') && !/^[A-Za-z]:/.test(value) && !value.split('/').some(part => !part || part === '.' || part === '..');
  for (const e of data.evidence) {
    if (['code','document'].includes(e.kind)) {
      if (!e.repository_id || !e.path || !e.revision) add('$.record_data.evidence', 'Code/document evidence requires repository, path and observed revision.');
    }
    if (e.path && !relativePath(e.path)) add('$.record_data.evidence', 'Evidence paths must be normalized repository-relative paths.');
    if (e.revision?.kind === 'git' && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(e.revision.value ?? '')) add('$.record_data.evidence', 'Git revisions use the full commit hash.');
    if (e.revision?.kind === 'content' && !/^[0-9a-f]{64}$/.test(e.revision.value ?? '')) add('$.record_data.evidence', 'Content revisions use a SHA-256 digest.');
    if (e.revision?.kind === 'unknown' && !e.revision.reason) add('$.record_data.evidence', 'Unknown revisions require an explicit reason.');
    if (e.revision?.kind === 'git' && e.revision.dirty && !e.anchor?.sha256) add('$.record_data.evidence', 'Dirty Git observations also require an observed content fingerprint.');
    if (e.anchor?.end_line && (!e.anchor.start_line || e.anchor.end_line < e.anchor.start_line)) add('$.record_data.evidence', 'Invalid observed line range.');
    if (e.kind === 'url' && !e.uri) add('$.record_data.evidence', 'URL evidence requires a URI.');
    if (['command','test'].includes(e.kind) && (!e.argv?.length || e.exit === undefined)) add('$.record_data.evidence', 'Command/test evidence requires argv and exit status.');
  }
  for (const relation of data.relations) {
    if (!ownedSources.has(relation.source_id)) add('$.record_data.relations', 'A relation source must belong to this record.');
    if (relation.target.path && !relativePath(relation.target.path)) add('$.record_data.relations', 'Navigation hints must be repository-relative paths.');
    if (relation.kind === 'blocks' && !/^(plan|item):/.test(relation.target.id)) add('$.record_data.relations', 'Blocks targets execution: a plan or plan item.');
    if (relation.kind === 'verified-by' && !relation.target.id.startsWith('evidence:')) add('$.record_data.relations', 'Verified-by targets evidence.');
    if (relation.kind === 'resolved-by' && (!relation.source_id.startsWith('flag:') || !/^(plan|item|decision|evidence):/.test(relation.target.id))) add('$.record_data.relations', 'Resolved-by links a flag to work, a decision, or evidence.');
    if (relation.kind === 'supersedes' && (relation.target.id === relation.source_id || relation.target.id.split(':')[0] !== relation.source_id.split(':')[0])) add('$.record_data.relations', 'Supersedes requires a distinct target of the same kind.');
  }
  for (const entry of [...data.history, ...(data.resolutions ?? []), ...(data.recommendations ?? []), ...(data.rulings ?? [])]) checkEvidence(entry.evidence_ids, '$.record_data');
  if (record.type === 'flag') {
    if (data.source.kind === 'check' && !data.source.rule_id) add('$.record_data.source', 'Check findings require a stable rule ID.');
    if (data.triage.disposition !== 'unreviewed' && (!data.triage.by || !data.triage.at || !data.triage.reason)) add('$.record_data.triage', 'Triage requires actor, timestamp and reason.');
    if ((record.status === 'rejected') !== (data.triage.disposition === 'rejected')) add('$.status', 'Rejected status and triage must agree.');
    const resolution = data.resolutions.find(r => r.id === data.active_resolution_id);
    if (record.status === 'resolved' ? !resolution : data.active_resolution_id !== undefined) add('$.record_data.active_resolution_id', 'Only a resolved flag has an active resolution, and it must exist.');
    const observations = data.evidence.filter(e => ['code','document'].includes(e.kind));
    const successfulProof = proof => ['command','test'].includes(proof?.kind) && proof.exit === 0
      && proof.repository_id && ['git','content'].includes(proof.revision?.kind)
      && Date.parse(proof.observed_at) <= Date.parse(resolution?.at)
      && observations.filter(e => e.repository_id === proof.repository_id).every(e => Date.parse(proof.observed_at) >= Date.parse(e.observed_at));
    if (resolution && ['check','test'].includes(resolution.method) && !resolution.evidence_ids.some(id => successfulProof(evidence.get(id)))) add('$.record_data.resolutions', 'Automated resolution requires successful command/test evidence pinned to a snapshot after the observations.');
    if (resolution?.method === 'manual' && !['human','agent'].includes(resolution.by.kind)) add('$.record_data.resolutions', 'Manual resolution must identify its human or agent actor.');
    if (resolution?.method === 'check' && data.source.kind !== 'check') add('$.record_data.resolutions', 'Only the originating check resolves a check-owned finding automatically.');
    if (resolution?.method === 'check') {
      const proofs = resolution.evidence_ids.map(id => evidence.get(id)).filter(p => successfulProof(p) && p.kind === 'command'
        && p.rule_id === data.source.rule_id && p.coverage?.complete === true && p.coverage.repository_id === p.repository_id);
      const subjects = observations.length ? observations : [{repository_id:data.repository_id}];
      if (!subjects.every(subject => proofs.some(proof => proof.repository_id === subject.repository_id
        && (proof.coverage.kind === 'repository' || (proof.coverage.kind === 'files' && subject.path && proof.coverage.paths.includes(subject.path)))))) {
        add('$.record_data.resolutions', 'Check resolution requires complete coverage of the original evidence and the same rule.');
      }
    }
  }
  if (record.type === 'decision') {
    const options = new Set(data.options.map(o => o.id));
    for (const recommendation of data.recommendations) if (!options.has(recommendation.option_id)) add('$.record_data.recommendations', 'Recommendation names an unknown option.');
    const earlier = new Set();
    for (const ruling of data.rulings) {
      if (ruling.kind === 'select' && !options.has(ruling.option_id)) add('$.record_data.rulings', 'Ruling names an unknown option.');
      if (ruling.kind === 'withdraw' && ruling.option_id !== undefined) add('$.record_data.rulings', 'Withdrawal does not select an option.');
      if (ruling.by.kind === 'human' ? ruling.authority.basis !== 'human' : ruling.by.kind !== 'agent' || ruling.authority.basis !== 'delegated' || !ruling.authority.grant_ref) add('$.record_data.rulings', 'Ruling provenance must identify a human or an explicit delegation.');
      if (ruling.supersedes_ruling_id && !earlier.has(ruling.supersedes_ruling_id)) add('$.record_data.rulings', 'A ruling can supersede only a preceding ruling in this record.');
      earlier.add(ruling.id);
    }
    const ruling = data.rulings.find(r => r.id === data.active_ruling_id);
    const superseded = new Set(data.rulings.map(r => r.supersedes_ruling_id).filter(Boolean));
    if (ruling && data.rulings.filter(r => !superseded.has(r.id)).length > 1) add('$.record_data.active_ruling_id', 'Competing rulings require an explicit superseding ruling; never select by timestamp.');
    if (ruling && superseded.has(ruling.id)) add('$.record_data.active_ruling_id', 'The active ruling cannot be superseded.');
    if (['ruled','closed'].includes(record.status) ? !ruling : data.active_ruling_id !== undefined) add('$.record_data.active_ruling_id', 'Only ruled/closed decisions have an active ruling, and it must exist.');
    if (record.status === 'ruled' && (ruling?.kind !== 'select' || data.options.length < 2)) add('$.status', 'A ruled decision selects one of at least two options.');
    if (record.status === 'held' && !data.hold) add('$.record_data.hold', 'A held decision requires actor, timestamp and reason.');
  }
  return errors;
}

// Read-only opt-in parser. Legacy CLI writers are deliberately not connected
// to this format until their mutation/migration contracts are implemented.
export function parseNativeRecord(raw) {
  const result = { ok: false, record: null, body: '', source: raw, diagnostics: [] };
  const add = (code, path, message) => result.diagnostics.push({ code, path, message });
  const { frontmatter, body } = extractFrontmatter(raw);
  result.body = body;
  const warnings = [];
  const fm = parseSimpleFrontmatter(frontmatter, warnings);
  if (fm.record_schema !== NATIVE_RECORD_SCHEMA) { add('unsupported-schema', '$.record_schema', 'Expected runlist.record/v1; retain source without managed edits.'); return result; }
  if (warnings.length) { for (const warning of warnings) add('duplicate-frontmatter', `$.${warning.key}`, warning.message); return result; }
  result.diagnostics.push(...envelopeErrors(frontmatter));
  if (result.diagnostics.length) return result;
  if (!/^record_data:\s*\|[-+]?\s*$/m.test(frontmatter)) { add('record-json', '$.record_data', 'Nested data must use JSON in a literal record_data block.'); return result; }
  try { fm.record_data = strictJson(fm.record_data); }
  catch (err) { add('record-json', '$.record_data', err.message); return result; }
  result.diagnostics.push(...validateNativeRecord(fm, { body }));
  result.record = fm;
  result.ok = result.diagnostics.length === 0;
  return result;
}
