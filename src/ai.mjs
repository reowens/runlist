import { spawnSync } from 'node:child_process';
import { warn } from './util.mjs';
import { dim } from './color.mjs';

let uvChecked = null;

export function checkUvAvailable() {
  if (uvChecked !== null) return uvChecked;
  const result = spawnSync('uv', ['--version'], { encoding: 'utf8' });
  uvChecked = !result.error && result.status === 0;
  if (!uvChecked) warn('uv is not installed. Install it to enable AI summaries: https://docs.astral.sh/uv/');
  return uvChecked;
}

export const DEFAULT_MODEL = 'mlx-community/Llama-3.2-3B-Instruct-4bit';

export function runMLX(prompt, opts = {}) {
  const { model = DEFAULT_MODEL, maxTokens = 200, timeout = 120000 } = opts;
  if (!checkUvAvailable()) return null;

  process.stderr.write(dim('  generating...'));
  const result = spawnSync('uv', [
    'run', '--with', 'mlx-lm',
    'python3', '-m', 'mlx_lm', 'generate',
    '--model', model,
    '--prompt', prompt,
    '--max-tokens', String(maxTokens),
    '--verbose', 'false',
  ], { encoding: 'utf8', timeout });

  process.stderr.write('\r\x1b[K');
  if (result.status !== 0) return null;

  const output = result.stdout.trim();
  const lines = output.split('\n')
    .filter(l => !l.includes('Fetching') && !l.includes('Warning:') && !l.includes('=========='));
  return lines.join(' ').trim() || null;
}

export function summarizeDocBody(bodyText, meta, opts = {}) {
  if (!bodyText?.trim()) return null;
  const prompt = `Summarize this markdown document in 2-3 sentences. Focus on what the document is about, its current state, and any key next actions or open questions.

Title: ${meta.title}
Status: ${meta.status}
File: ${meta.path}

${bodyText.slice(0, 6000)}`;
  return runMLX(prompt, { maxTokens: 200, ...opts });
}

export function summarizeDiffText(diffText, filePath, model) {
  const prompt = `Summarize this git diff in 1-2 sentences. Focus on what changed semantically, not line counts.\n\nFile: ${filePath}\n\n${diffText.slice(0, 4000)}`;
  return runMLX(prompt, { model, maxTokens: 150 });
}
