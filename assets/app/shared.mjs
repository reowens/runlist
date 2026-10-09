// Pure browser/server helpers. Source is always escaped; authored HTML is text.
export const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
export function splitSource(source) {
  const envelope = source.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0] ?? '';
  return { envelope, body: source.slice(envelope.length) };
}
export function lineDiff(before, after) {
  const a = before.replaceAll('\r\n', '\n').split('\n'), b = after.replaceAll('\r\n', '\n').split('\n');
  let first = 0, lastA = a.length, lastB = b.length;
  const result = [];
  while (first < lastA && first < lastB && a[first] === b[first]) result.push({ kind:'same', text:a[first], oldIndex:first++ });
  while (lastA > first && lastB > first && a[lastA - 1] === b[lastB - 1]) { lastA--; lastB--; }
  const n = lastA - first, m = lastB - first;
  if (n * m > 1_000_000) throw new Error('This diff is too large to review safely. Make a smaller edit or review it through the CLI.');
  const rows = Array.from({ length:n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) rows[i][j] = a[first + i] === b[first + j] ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1]);
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[first + i] === b[first + j]) { result.push({ kind:'same', text:a[first + i], oldIndex:first + i }); i++; j++; }
    else if (j < m && (i === n || rows[i][j + 1] > rows[i + 1][j])) result.push({ kind:'add', text:b[first + j++] });
    else { result.push({ kind:'remove', text:a[first + i], oldIndex:first + i }); i++; }
  }
  while (lastA < a.length) { result.push({ kind:'same', text:a[lastA], oldIndex:lastA }); lastA++; }
  return result;
}
// Textareas normalize line endings. Reuse exact raw lines for every unchanged
// line so an edit does not normalize unrelated CRLF or mixed-ending content.
export function editedSource(base, body) {
  const parts = splitSource(base), lines = parts.body.split('\n');
  const eol = parts.body.includes('\r\n') || parts.envelope.includes('\r\n') ? '\r' : '';
  const diff = lineDiff(parts.body, body);
  const retained = diff.filter(row => row.kind !== 'remove');
  return parts.envelope + retained.map((row, i) => row.kind === 'same' ? (i === retained.length - 1 && row.oldIndex < lines.length - 1 ? lines[row.oldIndex].replace(/\r$/, '') : lines[row.oldIndex]) : row.text + (i < retained.length - 1 ? eol : '')).join('\n');
}
function safeLink(href, resolve) {
  if (/^(https?:|mailto:)/i.test(href) || /^#[^\s]*$/.test(href)) return href;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\\)/i.test(href)) return null;
  return resolve?.(href) ?? null;
}
function inline(text, resolve) {
  // Tokenize before escaping so authored markup cannot break attributes, and
  // code spans never run through emphasis/link replacements.
  const token = /`([^`]+)`|!?\[([^\]]+)\]\(([^\s)]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*/g;
  let html = '', cursor = 0;
  for (const match of text.matchAll(token)) {
    html += escapeHtml(text.slice(cursor, match.index));
    if (match[1] !== undefined) html += `<code>${escapeHtml(match[1])}</code>`;
    else if (match[2] !== undefined) {
      const href = safeLink(match[3], resolve);
      html += href ? `<a href="${escapeHtml(href)}" rel="noreferrer">${escapeHtml(match[2])}</a>` : escapeHtml(match[2]);
    } else if (match[4] !== undefined) html += `<strong>${escapeHtml(match[4])}</strong>`;
    else html += `<em>${escapeHtml(match[5])}</em>`;
    cursor = match.index + match[0].length;
  }
  return html + escapeHtml(text.slice(cursor));
}
export function markdownHtml(source, resolve) {
  const lines = splitSource(source).body.replaceAll('\r\n', '\n').split('\n');
  const out = []; let i = 0;
  const cells = line => line.trim().replace(/^\||\|$/g, '').split('|').map(c => inline(c.trim(), resolve));
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      const code = []; i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`).test(lines[i])) code.push(lines[i++]);
      i++; out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`); continue;
    }
    if (/^\s*<!--/.test(line)) { while (i < lines.length && !lines[i++].includes('-->')) { /* comments are retained in source */ } continue; }
    const heading = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*$/);
    if (heading) { out.push(`<h${heading[1].length}>${inline(heading[2], resolve)}</h${heading[1].length}>`); i++; continue; }
    if (line.includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? '')) {
      const header = cells(line); i += 2; const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(`<tr>${cells(lines[i++]).map(c => `<td>${c}</td>`).join('')}</tr>`);
      out.push(`<div class="table-wrap"><table><thead><tr>${header.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`); continue;
    }
    if (/^ {0,3}(?:[-*+] |\d+\. )/.test(line)) {
      const ordered = /^ {0,3}\d+\. /.test(line), items = [];
      while (i < lines.length && /^ {0,3}(?:[-*+] |\d+\. )/.test(lines[i])) {
        const value = lines[i++].replace(/^ {0,3}(?:[-*+] |\d+\. )/, ''), task = value.match(/^\[([ xX])\] (.*)/);
        items.push(task ? `<li class="task"><span aria-label="${task[1] === ' ' ? 'Incomplete' : 'Complete'}">${task[1] === ' ' ? '□' : '✓'}</span><div>${inline(task[2], resolve)}</div></li>` : `<li>${inline(value, resolve)}</li>`);
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`); continue;
    }
    if (/^>\s?/.test(line)) { out.push(`<blockquote>${inline(line.replace(/^>\s?/, ''), resolve)}</blockquote>`); i++; continue; }
    if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    const paragraph = [line]; i++;
    while (i < lines.length && lines[i].trim() && !/^(?: {0,3}(?:#{1,6}\s|[-*+] |\d+\. |`{3,}|~{3,})|>|\s*<!--)/.test(lines[i]) && !(lines[i].includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? ''))) paragraph.push(lines[i++]);
    out.push(`<p>${inline(paragraph.join('\n'), resolve)}</p>`);
  }
  return out.join('\n');
}
export function diffHtml(before, after) {
  const rows = lineDiff(before, after), visible = new Set();
  rows.forEach((r, i) => { if (r.kind !== 'same') for (let j = Math.max(0, i - 3); j <= Math.min(rows.length - 1, i + 3); j++) visible.add(j); });
  if (!visible.size) return '<p class="muted">No source changes.</p>';
  let previous = -2;
  return [...visible].map(i => {
    const row = rows[i], gap = i > previous + 1 ? '<div class="diff-gap">···</div>' : ''; previous = i;
    return gap + `<div class="diff-line ${row.kind}"><span>${row.kind === 'add' ? '+' : row.kind === 'remove' ? '−' : ' '}</span><code>${escapeHtml(row.text) || ' '}</code></div>`;
  }).join('');
}
