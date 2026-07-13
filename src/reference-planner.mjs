import { realpathSync } from 'node:fs';
import path from 'node:path';
import { extractFrontmatter } from './frontmatter.mjs';

function slash(value) { return value.split(path.sep).join('/'); }

function canonicalExisting(filePath) {
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

export function createReferenceIdentitySet(filePaths) {
  const identities = new Set();
  identities.paths = new Map();
  for (const filePath of filePaths) {
    const identity = canonicalExisting(filePath);
    identities.add(identity);
    identities.paths.set(identity, path.resolve(filePath));
  }
  return identities;
}

// Both interpretations are evaluated. A local document wins only when the
// repo-relative spelling is absent or names the same identity; disagreement is
// rejected rather than guessed.
export function resolveReferenceIdentity(token, documentPath, repoRoot, identities) {
  if (!token || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(token)) return null;
  const clean = token.replace(/[?#].*$/, '').replace(/\\([\s()[\]<>])/g, '$1');
  const local = canonicalExisting(path.resolve(path.dirname(documentPath), clean));
  const repository = canonicalExisting(path.resolve(repoRoot, clean.replace(/^\/+/, '')));
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
  const oldIdentity = canonicalExisting(oldPath);
  const args = [sourcePath, outputPath, repoRoot, identities, oldIdentity, newPath, rebaseAll];
  const nextFrontmatter = rewriteFrontmatter(frontmatter, referenceFields, args);
  const nextBody = rewriteMarkdown(body, args);
  return nextFrontmatter === frontmatter && nextBody === body ? content : `---\n${nextFrontmatter}\n---\n${nextBody}`;
}

export function planReferenceMove({ documents, oldPath, newPath, repoRoot, referenceFields = [] }) {
  const identities = createReferenceIdentitySet(documents.map(document => document.path));
  const oldIdentity = canonicalExisting(oldPath);
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
