import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const HANDOFF_DIR = path.join('.dotmd', 'handoffs');

export function handoffPath(config, repoPath) {
  return path.join(config.repoRoot, HANDOFF_DIR, repoPath);
}

export function hasHandoff(config, repoPath) {
  return existsSync(handoffPath(config, repoPath));
}

export function readHandoff(config, repoPath) {
  const file = handoffPath(config, repoPath);
  if (!existsSync(file)) return null;
  return readFileSync(file, 'utf8');
}

export function appendHandoff(config, repoPath, text, opts = {}) {
  const file = handoffPath(config, repoPath);
  mkdirSync(path.dirname(file), { recursive: true });
  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const block = `## ${stamp}\n\n${text.trimEnd()}\n`;
  if (opts.replace || !existsSync(file)) {
    writeFileSync(file, block + '\n', 'utf8');
  } else {
    const prior = readFileSync(file, 'utf8').trimEnd();
    writeFileSync(file, `${prior}\n\n${block}\n`, 'utf8');
  }
  return file;
}

export function consumeHandoff(config, repoPath) {
  const file = handoffPath(config, repoPath);
  if (!existsSync(file)) return null;
  const body = readFileSync(file, 'utf8');
  unlinkSync(file);
  return body;
}

export function listQueuedHandoffs(config) {
  const root = path.join(config.repoRoot, HANDOFF_DIR);
  if (!existsSync(root)) return [];
  const out = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const repoPath = path.relative(root, full).split(path.sep).join('/');
      const st = statSync(full);
      out.push({ repoPath, path: full, mtimeMs: st.mtimeMs });
    }
  }
  walk(root);
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}
