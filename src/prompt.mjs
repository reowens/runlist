import { createInterface } from 'node:readline';

export function isInteractive() {
  return Boolean(process.stdin.isTTY);
}

export async function promptText(question) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function promptChoice(question, options) {
  process.stderr.write(question + '\n');
  options.forEach((opt, i) => process.stderr.write(`  ${i + 1}) ${opt}\n`));
  const answer = await promptText('> ');
  const idx = parseInt(answer, 10) - 1;
  if (idx >= 0 && idx < options.length) return options[idx];
  const match = options.find(o => o.toLowerCase() === answer.toLowerCase());
  return match ?? null;
}
