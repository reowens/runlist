import { existsSync } from 'node:fs';
import path from 'node:path';
import { dim } from './color.mjs';

export function escapeTable(value) {
  return String(value).replace(/\|/g, '\\|');
}

export function asString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function toSlug(plan) {
  return path.basename(plan.path, '.md');
}

export function truncate(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + '...';
}

export function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return value.map(item => String(item).trim()).filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    return [value.trim()];
  }
  return [];
}

export function normalizeBlockers(blockers) {
  if (Array.isArray(blockers)) {
    return blockers.map(item => String(item));
  }
  if (typeof blockers === 'string' && blockers.trim()) {
    return [blockers.trim()];
  }
  return [];
}

export function mergeUniqueStrings(...lists) {
  return [...new Set(lists.flat().filter(Boolean))];
}

export function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function toRepoPath(absolutePath, repoRoot) {
  return path.relative(repoRoot, absolutePath).split(path.sep).join('/');
}

export function warn(message) {
  process.stderr.write(`${dim(message)}\n`);
}

export class DotmdError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DotmdError';
  }
}

export function die(message) {
  throw new DotmdError(message);
}

export function resolveDocPath(input, config) {
  if (!input) return null;
  if (path.isAbsolute(input)) return existsSync(input) ? input : null;

  let candidate = path.resolve(config.repoRoot, input);
  if (existsSync(candidate)) return candidate;

  candidate = path.resolve(config.docsRoot, input);
  if (existsSync(candidate)) return candidate;

  return null;
}
