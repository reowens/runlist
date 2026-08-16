export function extractFirstHeading(body) {
  return body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? null;
}

export function extractSummary(body) {
  const blockquoteLines = body
    .split('\n')
    .filter(line => line.startsWith('> '))
    .map(line => line.slice(2).trim())
    .filter(Boolean);

  const nonStatusLine = blockquoteLines.find(line => !/^Status note\b/i.test(line));
  return nonStatusLine ?? blockquoteLines[0] ?? null;
}

export function extractStatusSnapshot(body) {
  const statusNoteMatch = body.match(/^>\s+Status note(?:\s+\([^)]+\))?:\s*(.+)$/m);
  if (statusNoteMatch) return statusNoteMatch[1].trim();

  const boldStatusMatch = body.match(/^\*\*Status:\*\*\s*(.+)$/m);
  if (boldStatusMatch) return boldStatusMatch[1].trim();

  const plainStatusMatch = body.match(/^-\s+Status:\s*(.+)$/m);
  if (plainStatusMatch) return plainStatusMatch[1].trim();

  return null;
}

export function extractNextStep(body) {
  const match = body.match(/^##+\s+(?:Suggested\s+)?Next Step\s*$([\s\S]*?)(?=^##+\s|\Z)/m);
  if (!match) return null;

  const lines = match[1]
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => line.replace(/^[-*]\s+/, ''));

  return lines[0] ?? null;
}

export function extractBodyLinks(body) {
  if (!body) return [];
  // Strip fenced code blocks, then MASK inline code rather than delete it.
  // Deleting it ate the commonest link idiom in a plan hub: [`plan.md`](plan.md)
  // has its link TEXT as a code span, so removing the span left `[](plan.md)`,
  // which the regex below rejects for having empty text. A hub with hundreds of
  // such links reported one — and since this list is what validates body links,
  // every one of them was also never checked for breakage. Masking to same-length
  // filler keeps the link matchable while still neutralizing a link that is
  // itself inside code (`[fake](x.md)` stays unmatched), and preserves offsets.
  const stripped = body
    .replace(/^```[\s\S]*?^```/gm, '')
    .replace(/`[^`]+`/g, match => 'x'.repeat(match.length));
  const links = [];
  // Match [text](path.md) or [text](path.md#anchor), skip images (preceded by !)
  const regex = /(?<!!)\[([^\]]+)\]\(([^)]+\.md(?:#[^)]*)?)\)/g;
  let match;
  while ((match = regex.exec(stripped)) !== null) {
    const href = match[2];
    // Skip external URLs
    if (/^https?:\/\//i.test(href)) continue;
    // Strip anchor fragment for path resolution
    const cleanHref = href.replace(/#.*$/, '');
    links.push({ text: match[1], href: cleanHref });
  }
  return links;
}

export function extractChecklistCounts(body) {
  const matches = [...body.matchAll(/^\s*[-*]\s+\[([ xX])\]\s+/gm)];
  let completed = 0;
  let open = 0;

  for (const match of matches) {
    if (match[1].toLowerCase() === 'x') {
      completed += 1;
    } else {
      open += 1;
    }
  }

  return {
    completed,
    open,
    total: completed + open,
  };
}
