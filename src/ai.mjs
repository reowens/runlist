import { generate } from './model.mjs';

// Model-backed text for summaries and lint. The server applies each model's
// own chat template, so prompts are plain system and user messages.
// `runlist model` shows which model runs and where.

export function runModel(prompt, opts = {}) {
  const { system, ...rest } = opts;
  const messages = system ? [{ role: 'system', content: system }, { role: 'user', content: prompt }] : [{ role: 'user', content: prompt }];
  const text = generate(messages, rest);
  return text ? text.replace(/\*\*/g, '').replace(/^#+\s*/gm, '').trim() : null;
}

export function summarizeDocBody(bodyText, meta, opts = {}) {
  if (!bodyText?.trim()) return null;
  const prompt = `Write a 2-3 sentence plain text summary of this document. State what it covers, its current state (${meta.status}), and what remains to be done. No markdown formatting. No bold, headers, or bullets. Do not start with "This document" or "Here is".

Title: ${meta.title}
${bodyText.slice(0, 6000)}`;
  return runModel(prompt, {
    system: 'You write brief, direct summaries. No preamble. No filler. Start with the subject immediately.',
    maxTokens: 200,
    ...opts,
  });
}

export function summarizeDiffText(diffText, filePath, model) {
  const prompt = `Summarize this git diff in 1-2 sentences. Focus on what changed semantically, not line counts.\n\nFile: ${filePath}\n\n${diffText.slice(0, 4000)}`;
  return runModel(prompt, { model, maxTokens: 150 });
}
