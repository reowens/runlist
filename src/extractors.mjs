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
  // Strip fenced code blocks to avoid false positives
  const stripped = body.replace(/^```[\s\S]*?^```/gm, '');
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
