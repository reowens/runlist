import { realpathSync } from 'node:fs';
import path from 'node:path';
import { extractFrontmatter } from './frontmatter.mjs';

function slash(value) { return value.split(path.sep).join('/'); }

function canonicalExisting(filePath, memo = null) {
  const key = memo ? path.resolve(filePath) : null;
  if (memo) {
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
  }
  const identity = resolveCanonical(filePath);
  if (memo) memo.set(key, identity);
  return identity;
}

function resolveCanonical(filePath) {
  try { return realpathSync(filePath); }
  catch {
    const suffix = [];
    let cursor = path.resolve(filePath);
    while (true) {
      try { return path.join(realpathSync(cursor), ...suffix); }
      catch {
        const parent = path.dirname(cursor);
        if (parent === cursor) return path.resolve(filePath);
        suffix.unshift(path.basename(cursor));
        cursor = parent;
      }
    }
  }
}

export class AmbiguousReferenceError extends Error {
  constructor(token, sourcePath, local, repository) {
    super(`Ambiguous reference '${token}' in ${sourcePath}: document-relative resolves to ${local}, repository-relative resolves to ${repository}. Use an explicit unambiguous path.`);
    this.name = 'AmbiguousReferenceError';
    this.code = 'DOTMD_AMBIGUOUS_REFERENCE';
  }
}

export function configuredReferenceFields(config) {
  return [...new Set([
    ...(config.referenceFields?.bidirectional ?? []),
    ...(config.referenceFields?.unidirectional ?? []),
  ])];
}

// Resolving a reference costs two `canonicalExisting` calls (document-relative
// and repository-relative), and the repository-relative spelling usually does
// NOT exist — which sends it up the tree doing a realpath per ancestor. Across
// a corpus-wide sweep that is tens of thousands of syscalls over a few hundred
// distinct paths, and it dominated the reference rewrite: a status change in a
// 2,000-doc repo spent ~0.85s resolving the same directory prefixes over and
// over. The memo lives on the identity set, so it is scoped to one sweep and
// cannot outlive a mutation — `dotmd bulk` builds a fresh set per move. Within
// a sweep it is also strictly more consistent than re-resolving per token,
// which could see the filesystem change midway.
export function createReferenceIdentitySet(filePaths) {
  const identities = new Set();
  identities.paths = new Map();
  identities.canonical = new Map();
  identities.names = new Map();
  identities.symlinked = false;
  for (const filePath of filePaths) {
    const resolved = path.resolve(filePath);
    const identity = canonicalExisting(filePath, identities.canonical);
    // A corpus path whose realpath differs is a symlink, so one document can be
    // reachable under more than one name. `names` records every one of them —
    // and `symlinked` warns the candidate prefilter that names are not a
    // reliable signal in this repo at all.
    if (identity !== resolved) identities.symlinked = true;
    identities.add(identity);
    identities.paths.set(identity, resolved);
    let names = identities.names.get(identity);
    if (!names) identities.names.set(identity, names = new Set());
    names.add(path.basename(resolved).toLowerCase());
  }
  return identities;
}

// Can this document possibly hold a reference to `oldIdentity`? Every token the
// rewriter will touch has to survive `/\.md$/i` and then resolve to the moved
// file, so the document must spell one of that file's names somewhere. Checking
// that first skips the fence-aware walk for the ~99% of a corpus that never
// mentions the file — the measured difference on a 2,000-doc repo is 950ms of
// rewriting versus 120ms.
//
// The comparison mirrors the resolver: case-folded (a case-insensitive
// filesystem resolves `FOO.MD` to `foo.md`, and folding can only over-include),
// and with the same backslash escapes unwound, so `my\ plan.md` still matches
// `my plan.md`. Percent-encoding needs no handling — the resolver does not
// decode it either, so `foo%20bar.md` never resolves in the first place.
//
// The boundary: a symlink whose name differs from its target's. Aliases inside
// the corpus are covered by `names`; a symlink that is NOT itself a collected
// doc is not, so any repo that symlinks docs at all fails open to the full walk.
function mayReferenceIdentity(content, oldIdentity, oldPath, identities) {
  if (!identities?.names || identities.symlinked) return true;
  const names = identities.names.get(oldIdentity);
  const haystack = (content.includes('\\') ? content.replace(/\\([\s()[\]<>])/g, '$1') : content).toLowerCase();
  if (haystack.includes(path.basename(oldPath).toLowerCase())) return true;
  if (names) for (const name of names) if (haystack.includes(name)) return true;
  return false;
}

// Both interpretations are evaluated. A local document wins only when the
// repo-relative spelling is absent or names the same identity; disagreement is
// rejected rather than guessed.
export function resolveReferenceIdentity(token, documentPath, repoRoot, identities) {
  if (!token || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(token)) return null;
  const clean = token.replace(/[?#].*$/, '').replace(/\\([\s()[\]<>])/g, '$1');
  const memo = identities?.canonical ?? null;
  const local = canonicalExisting(path.resolve(path.dirname(documentPath), clean), memo);
  const repository = canonicalExisting(path.resolve(repoRoot, clean.replace(/^\/+/, '')), memo);
  const localExists = identities.has(local);
  const repositoryExists = identities.has(repository);
  if (localExists && repositoryExists && local !== repository) {
    throw new AmbiguousReferenceError(token, documentPath, local, repository);
  }
  return localExists ? local : (repositoryExists ? repository : null);
}

function rewriteToken(token, sourcePath, outputPath, repoRoot, identities, oldIdentity, newPath, rebaseAll, format = 'plain') {
  const target = resolveReferenceIdentity(token, sourcePath, repoRoot, identities);
  if (!target || (!rebaseAll && target !== oldIdentity)) return token;
  const destination = target === oldIdentity ? path.resolve(newPath) : (identities.paths?.get(target) ?? target);
  const relative = slash(path.relative(path.dirname(outputPath), destination)) || path.basename(destination);
  return format === 'escaped' ? relative.replace(/([\s()[\]<>])/g, '\\$1') : relative;
}

function rewritePathTokens(value, args) {
  let quote = null;
  let commentAt = -1;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (quote) {
      if (char === quote && value[index - 1] !== '\\') quote = null;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '#' && index > 0 && /\s/.test(value[index - 1])) { commentAt = index - 1; break; }
  }
  const editable = commentAt === -1 ? value : value.slice(0, commentAt);
  const comment = commentAt === -1 ? '' : value.slice(commentAt);
  const quoted = editable.replace(/(["'])((?:\\.|(?!\1).)*)\1/g, (match, delimiter, token) => {
    if (!/^.+\.md(?:[?#].*)?$/i.test(token)) return match;
    const suffixAt = token.search(/[?#]/);
    const bare = suffixAt === -1 ? token : token.slice(0, suffixAt);
    const suffix = suffixAt === -1 ? '' : token.slice(suffixAt);
    const rewritten = rewriteToken(bare, ...args);
    return rewritten === bare ? match : `${delimiter}${rewritten}${suffix}${delimiter}`;
  });
  const rewritten = quoted.replace(/[^\s"'<>:[\],()#?]+\.md(?=$|[\s"'<>:[\],()#?])/g, token => rewriteToken(token, ...args));
  return rewritten + comment;
}

function rewriteFrontmatter(frontmatter, fields, args) {
  const allowed = new Set(fields);
  const lines = frontmatter.split('\n');
  let active = false;
  return lines.map(line => {
    const key = /^([A-Za-z_][\w-]*):(?:\s*(.*))?$/.exec(line);
    if (key) {
      active = allowed.has(key[1]);
      if (!active) return line;
      const colon = line.indexOf(':');
      return line.slice(0, colon + 1) + rewritePathTokens(line.slice(colon + 1), args);
    }
    if (/^[^\s#][^:]*:/.test(line)) active = false;
    if (!active || /^\s*#/.test(line)) return line;
    return rewritePathTokens(line, args);
  }).join('\n');
}

function destinationParts(raw) {
  const angle = raw.startsWith('<') && raw.endsWith('>');
  const inner = angle ? raw.slice(1, -1) : raw;
  const suffixAt = inner.search(/[?#]/);
  return {
    angle,
    path: suffixAt === -1 ? inner : inner.slice(0, suffixAt),
    suffix: suffixAt === -1 ? '' : inner.slice(suffixAt),
  };
}

function rewriteDestination(raw, args) {
  const parsed = destinationParts(raw);
  if (!/\.md$/i.test(parsed.path.replace(/\\./g, 'x'))) return raw;
  const next = rewriteToken(parsed.path, ...args, parsed.angle ? 'plain' : 'escaped');
  if (next === parsed.path) return raw;
  const rendered = `${next}${parsed.suffix}`;
  return parsed.angle ? `<${rendered}>` : rendered;
}

function rewriteMarkdownSegment(segment, args) {
  // Inline links: angle destinations, escaped whitespace, optional titles.
  let next = segment.replace(/(\[[^\]]*\]\(\s*)(<[^>\n]+>|(?:\\.|[^\s()])+)(\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?(\s*\))/g,
    (match, prefix, destination, title = '', close, offset) => {
      let escapes = 0;
      for (let index = offset - 1; index >= 0 && segment[index] === '\\'; index--) escapes++;
      if (escapes % 2 === 1) return match;
      const rewritten = rewriteDestination(destination, args);
      return rewritten === destination ? match : `${prefix}${rewritten}${title}${close}`;
    });
  // Reference definitions preserve labels, spacing, destinations, and titles.
  next = next.replace(/^(\s{0,3}\[[^\]]+\]:\s*)(<[^>\n]+>|(?:\\.|[^\s])+)(.*)$/,
    (match, prefix, destination, tail) => {
      const rewritten = rewriteDestination(destination, args);
      return rewritten === destination ? match : `${prefix}${rewritten}${tail}`;
    });
  return next;
}

function rewriteMarkdown(body, args) {
  const lines = body.split('\n');
  let fence = null;
  let inlineRun = null;
  let indentedCode = false;
  let htmlBlock = null;
  const containerContext = line => {
    let rest = line;
    let quotePrefix = '';
    while (true) {
      const quote = /^( {0,3}>[ \t]?)/.exec(rest);
      if (!quote) break;
      quotePrefix += quote[1];
      rest = rest.slice(quote[1].length);
    }
    const list = /^( {0,3}(?:[-+*]|\d+[.)]))([ \t]+)/.exec(rest);
    if (list) {
      const padding = !list[2].includes('\t') && list[2].length <= 4 ? list[2] : list[2][0];
      const listPrefix = `${list[1]}${padding}`;
      rest = rest.slice(listPrefix.length);
      return { content: rest, prefixes: [`${quotePrefix}${listPrefix}`, `${quotePrefix}${' '.repeat(listPrefix.length)}`] };
    }
    return { content: rest, prefixes: quotePrefix ? [quotePrefix] : [''] };
  };
  return lines.map(line => {
    if (fence) {
      const close = new RegExp(`^ {0,3}${fence.char === '`' ? '`' : '~'}{${fence.length},}[ \\t]*$`);
      const compatible = fence.prefixes.find(prefix => line.startsWith(prefix));
      if (compatible !== undefined && close.test(line.slice(compatible.length))) fence = null;
      return line;
    }
    if (htmlBlock) {
      if (htmlBlock === 'comment' && line.includes('-->')) htmlBlock = null;
      else if (htmlBlock !== 'generic' && new RegExp(`</${htmlBlock}\\s*>`, 'i').test(line)) htmlBlock = null;
      else if (htmlBlock === 'generic' && line.trim() === '') htmlBlock = null;
      return line;
    }
    const trimmed = line.trimStart();
    if (trimmed.startsWith('<!--')) {
      if (!trimmed.includes('-->')) htmlBlock = 'comment';
      return line;
    }
    const rawTag = /^<(pre|code|script|style)(?:\s|>|$)/i.exec(trimmed)?.[1]?.toLowerCase();
    if (rawTag) {
      if (!new RegExp(`</${rawTag}\\s*>`, 'i').test(trimmed)) htmlBlock = rawTag;
      return line;
    }
    if (/^<\/?(?:address|article|aside|base|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:\s|>|\/)/i.test(trimmed)) {
      htmlBlock = 'generic';
      return line;
    }
    if (trimmed.startsWith('<')) return line;
    const container = containerContext(line);
    if (indentedCode) {
      if (container.content === '' || /^(?: {4}|\t)/.test(container.content)) return line;
      indentedCode = false;
    } else if (/^(?: {4}|\t)/.test(container.content)) {
      indentedCode = true;
      return line;
    }
    const opener = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(container.content);
    if (opener) {
      fence = { char: opener[1][0], length: opener[1].length, prefixes: container.prefixes };
      return line;
    }
    let output = '';
    let cursor = 0;
    const runs = [...line.matchAll(/`+/g)];
    let index = 0;
    if (inlineRun !== null) {
      const closingIndex = runs.findIndex(candidate => candidate[0].length === inlineRun);
      if (closingIndex === -1) return line;
      const closing = runs[closingIndex];
      output += line.slice(0, closing.index + closing[0].length);
      cursor = closing.index + closing[0].length;
      index = closingIndex + 1;
      inlineRun = null;
    }
    for (; index < runs.length; index++) {
      const opening = runs[index];
      const closingIndex = runs.findIndex((candidate, candidateIndex) => candidateIndex > index && candidate[0].length === opening[0].length);
      if (closingIndex === -1) {
        output += rewriteMarkdownSegment(line.slice(cursor, opening.index), args);
        output += line.slice(opening.index);
        inlineRun = opening[0].length;
        cursor = line.length;
        break;
      }
      const closing = runs[closingIndex];
      output += rewriteMarkdownSegment(line.slice(cursor, opening.index), args);
      output += line.slice(opening.index, closing.index + closing[0].length);
      cursor = closing.index + closing[0].length;
      index = closingIndex;
    }
    return output + rewriteMarkdownSegment(line.slice(cursor), args);
  }).join('\n');
}

export function rewriteDocumentReferences(content, {
  sourcePath,
  outputPath = sourcePath,
  repoRoot,
  identities,
  oldPath,
  newPath,
  referenceFields = [],
  rebaseAll = false,
}) {
  const { frontmatter, body } = extractFrontmatter(content);
  if (!frontmatter) return content;
  const oldIdentity = canonicalExisting(oldPath, identities?.canonical ?? null);
  // `rebaseAll` rewrites every reference the document holds because the
  // document itself moved, so no single name can gate it.
  if (!rebaseAll && !mayReferenceIdentity(content, oldIdentity, oldPath, identities)) return content;
  const args = [sourcePath, outputPath, repoRoot, identities, oldIdentity, newPath, rebaseAll];
  const nextFrontmatter = rewriteFrontmatter(frontmatter, referenceFields, args);
  const nextBody = rewriteMarkdown(body, args);
  return nextFrontmatter === frontmatter && nextBody === body ? content : `---\n${nextFrontmatter}\n---\n${nextBody}`;
}

export function planReferenceMove({ documents, oldPath, newPath, repoRoot, referenceFields = [] }) {
  const identities = createReferenceIdentitySet(documents.map(document => document.path));
  const oldIdentity = canonicalExisting(oldPath, identities.canonical);
  identities.add(oldIdentity);
  const source = documents.find(document => path.resolve(document.path) === path.resolve(oldPath));
  if (!source) throw new Error(`Reference move plan is missing source content: ${oldPath}`);
  const movedContent = rewriteDocumentReferences(source.content, {
    sourcePath: oldPath, outputPath: newPath, repoRoot, identities, oldPath, newPath, referenceFields, rebaseAll: true,
  });
  const updates = [];
  for (const document of documents) {
    if (path.resolve(document.path) === path.resolve(oldPath)) continue;
    const content = rewriteDocumentReferences(document.content, {
      sourcePath: document.path, repoRoot, identities, oldPath, newPath, referenceFields,
    });
    if (content !== document.content) updates.push({ path: document.path, expectedContent: document.content, content });
  }
  return { movedContent, updates, identities };
}
