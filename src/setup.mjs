import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { which } from './util.mjs';
import { persistentCliOnPath, PERSISTENT_CLI_WARNING } from './installation.mjs';

const workerUrl = new URL('./setup-worker.mjs', import.meta.url).href;
const bin = fileURLToPath(new URL('../bin/runlist.mjs', import.meta.url));
const policies = ['untracked', 'tracked', 'local'];
const hosts = ['none', 'claude', 'codex', 'opencode'];
const valueFlags = new Map([
  ['--docs-root', 'docsRoot'], ['--prompt-tracking', 'promptTracking'], ['--host', 'host'],
  ['--first-plan', 'firstPlan'], ['--current-state', 'currentState'], ['--next-step', 'nextStep'], ['--adopt', 'adopt'],
]);

function parse(argv, config) {
  const choices = { docsRoot: null, promptTracking: config.configFound ? config.promptTracking : 'untracked',
    selectPromptTracking: false, gitignore: false, host: 'none', firstPlan: null, currentState: null, nextStep: null, adopt: [] };
  const flags = { yes: false, json: false };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const [flag, ...equals] = argv[i].split('=');
    if (flag !== '--adopt' && seen.has(flag)) throw new Error(`Repeated setup flag: ${flag}`);
    seen.add(flag);
    if (['--yes', '--json', '--gitignore'].includes(flag) && !equals.length) {
      if (flag === '--gitignore') choices.gitignore = true;
      else flags[flag.slice(2)] = true;
      continue;
    }
    const key = valueFlags.get(flag);
    if (!key) throw new Error(`Unknown setup flag: ${argv[i]}`);
    const value = equals.length ? equals.join('=') : argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value.`);
    if (key === 'adopt') choices.adopt.push(value);
    else choices[key] = value;
    if (key === 'promptTracking') choices.selectPromptTracking = true;
  }
  return { choices, flags, seen };
}

function validate(choices, config, existing) {
  if (!policies.includes(choices.promptTracking)) throw new Error('--prompt-tracking must be untracked, tracked, or local.');
  if (!hosts.includes(choices.host)) throw new Error('--host must be none, claude, codex, or opencode.');
  if (choices.docsRoot !== null) {
    if (!choices.docsRoot.trim() || path.isAbsolute(choices.docsRoot) || /[\r\n\0\\]/.test(choices.docsRoot) || choices.docsRoot.split('/').includes('..')) {
      throw new Error('--docs-root must be a relative project path without traversal.');
    }
    if (existing && ((config.docsRoots ?? [config.docsRoot]).length !== 1 || path.resolve(config.repoRoot, choices.docsRoot) !== config.docsRoot)) {
      throw new Error(`Existing configured roots are preserved. Edit the root export manually in ${config.configPath}, review the resulting layout with runlist init --dry-run, then rerun setup without --docs-root.`);
    }
  }
  if (!existing) choices.docsRoot ??= 'docs';
  if (choices.adopt.length > 100) throw new Error('Setup accepts at most 100 explicitly selected adoption files per run.');
  choices.adopt = [...new Set(choices.adopt)];
  for (const file of choices.adopt) {
    if (/[\0\r\n*?\[\]]/.test(file)) throw new Error(`--adopt needs an exact Markdown file path, without globs: ${file}`);
  }
  if (choices.firstPlan) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(choices.firstPlan) || choices.firstPlan.length > 100) {
      throw new Error('--first-plan needs a lowercase slug of at most 100 characters (letters, numbers, hyphens).');
    }
    for (const [key, flag, cap] of [['currentState', '--current-state', 1500], ['nextStep', '--next-step', 800]]) {
      const value = choices[key]?.trim();
      if (!value || value.length < 8 || !/[\p{L}\p{N}]/u.test(value) || /^(?:todo|tbd|n\/?a|unknown|placeholder|fill me|none|test)[.!?\s]*$/i.test(value)) {
        throw new Error(`${flag} needs meaningful user-supplied text for --first-plan (at least 8 characters).`);
      }
      if (value.length > cap || /[\0\x01-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw new Error(`${flag} exceeds its ${cap} character cap or contains control characters.`);
      choices[key] = value;
    }
  } else if (choices.currentState !== null || choices.nextStep !== null) throw new Error('--current-state and --next-step require --first-plan.');
}

function runWorker(request) {
  const script = `import {readFileSync} from 'node:fs';
    import {setupWorker} from ${JSON.stringify(workerUrl)};
    const request=JSON.parse(readFileSync(0,'utf8'));
    const write=process.stdout.write.bind(process.stdout); let output='';
    process.stdout.write=chunk=>{output+=chunk;return true;};
    try { const data=await setupWorker(request); write(JSON.stringify({ok:!process.exitCode,data,output,error:process.exitCode?'Command reported failure':null})); }
    catch(error) { write(JSON.stringify({ok:false,output,error:error.message})); process.exitCode=1; }`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: request.cwd, input: JSON.stringify(request), encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, RUNLIST_JOURNAL: '0', DOTMD_JOURNAL: '0', NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  try {
    const parsed = JSON.parse(result.stdout);
    if (!parsed.ok || result.status !== 0) {
      const error = new Error(parsed.error || result.stderr || `Setup ${request.operation} exited ${result.status}`);
      error.output = parsed.output;
      throw error;
    }
    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(result.error?.message || result.stderr || `Setup ${request.operation} produced an invalid report (exit ${result.status}).`);
    throw error;
  }
}

function runHost({ host, dryRun, cwd, configPath }) {
  const result = spawnSync(process.execPath, [bin, ...(configPath ? ['--config', configPath] : []), 'install', host, ...(dryRun ? ['--dry-run'] : [])], {
    cwd, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, RUNLIST_JOURNAL: '0', DOTMD_JOURNAL: '0', NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  // Setup owns this prerequisite in Outstanding, including JSON. Do not also
  // bury the installer's copy in a completed host action's captured output.
  const stderr = (result.error?.message || result.stderr || '').replace(`Warning: ${PERSISTENT_CLI_WARNING}\n`, '');
  return { available: which(host), status: result.status, stdout: result.stdout || '', stderr };
}

function checkHostCli(report, cwd) {
  const missing = !persistentCliOnPath({ cwd }).available;
  if (missing) report.checks.host.persistentCliMissing = true;
  else delete report.checks.host.persistentCliMissing;
  report.outstanding = report.outstanding.filter(item => item.id !== 'persistent-cli');
  if (missing) report.outstanding.push({ id: 'persistent-cli', description: PERSISTENT_CLI_WARNING });
}

// One readline iterator retains queued answers and handles EOF at every prompt,
// including confirmation. Creating a fresh interface per question can hang on EOF.
function terminal(input, output) {
  const rl = createInterface({ input, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  return { close: () => rl.close(), async ask(question) {
    output.write(question);
    const { value, done } = await lines.next();
    if (done || /^(?:cancel|quit)$/i.test(value.trim())) return null;
    return value.trim();
  } };
}

async function collect(choices, seen, existing, ask) {
  const answer = async (flag, question, key, fallback) => {
    if (seen.has(flag)) return;
    const value = await ask(question);
    if (value === null) throw new Error('SETUP_CANCELLED');
    choices[key] = value || fallback;
    if (flag === '--prompt-tracking' && value) choices.selectPromptTracking = true;
  };
  if (!existing) await answer('--docs-root', 'Docs root [docs]: ', 'docsRoot', 'docs');
  await answer('--prompt-tracking', `Prompt tracking: untracked/tracked/local [${choices.promptTracking}]: `, 'promptTracking', choices.promptTracking);
  if (!seen.has('--gitignore')) {
    const value = await ask('Add .gitignore rules for runtime state and non-tracked prompts? [y/N]: ');
    if (value === null) throw new Error('SETUP_CANCELLED');
    if (value && !/^(?:y|yes|n|no)$/i.test(value)) throw new Error('Choose yes or no for .gitignore edits.');
    choices.gitignore = /^(?:y|yes)$/i.test(value);
  }
  await answer('--host', 'Install a host integration: none/claude/codex/opencode [none]: ', 'host', 'none');
  await answer('--first-plan', 'First plan slug (blank to skip): ', 'firstPlan', null);
  if (choices.firstPlan) {
    await answer('--current-state', 'Current state (user-supplied, cap 1500 characters): ', 'currentState', null);
    await answer('--next-step', 'Next step (user-supplied, cap 800 characters): ', 'nextStep', null);
  }
  if (!seen.has('--adopt')) for (let i = 0; i <= 100; i++) {
    const value = await ask('Existing Markdown file to adopt (exact path, blank to finish): ');
    if (value === null) throw new Error('SETUP_CANCELLED');
    if (!value) break;
    choices.adopt.push(value);
    if (i === 100) throw new Error('Setup accepts at most 100 adoption files.');
  }
}

function render(report, out, json) {
  if (json) { out.write(`${JSON.stringify(report, null, 2)}\n`); return; }
  out.write(`Setup ${report.status} (${report.mode})\n`);
  for (const action of report.mode === 'preview' ? report.actions : []) {
    out.write(`\n${action.description}${action.path ? `: ${action.path}` : ''}\n`);
    if (action.preview) out.write(action.preview.endsWith('\n') ? action.preview : `${action.preview}\n`);
  }
  // Notes are information, not work left to do: shown after the counted sections and
  // only when there are any, so a clean setup never reads as unfinished.
  for (const category of ['completed', 'outstanding', 'failed', 'notes']) {
    if (category === 'notes' && !report.notes.length) continue;
    out.write(`\n${category[0].toUpperCase() + category.slice(1)}: ${report[category].length}\n`);
    for (const item of report[category]) {
      out.write(`  ${item.description}${item.path ? `: ${item.path}` : ''}\n`);
      for (const file of item.paths ?? []) out.write(`    ${file}\n`);
      if (category === 'failed' && item.output) out.write(item.output.endsWith('\n') ? item.output : `${item.output}\n`);
    }
  }
}

/** Guided, bounded setup. Extra IO/runner options are for isolated integration tests. */
export async function runSetup(argv, config, options = {}) {
  const { dryRun = false, input = process.stdin, out = process.stdout, prompts = process.stderr, hostRunner = runHost } = options;
  const report = { mode: argv.includes('--yes') && !dryRun ? 'apply' : 'preview', status: 'preview', choices: null, actions: [], checks: { firstPlan: null, project: null, host: null }, completed: [], outstanding: [], notes: [], failed: [] };
  let json = argv.includes('--json');
  let session;
  let applying = false;
  try {
    const parsed = parse(argv, config);
    const { choices, flags, seen } = parsed;
    json = flags.json;
    report.choices = choices;
    const existing = Boolean(config.configPath && existsSync(config.configPath));
    if (config.configPath && !existing) throw new Error(`The selected config does not exist: ${config.configPath}. Setup will not redirect initialization to a different config. Create the selected config manually, or rerun without --config for the standard fresh-project config.`);
    const cwd = existing ? config.repoRoot : (options.cwd ?? process.cwd());
    const interactive = options.interactive ?? Boolean(input.isTTY && prompts.isTTY);
    if (!flags.yes && !dryRun && !json && interactive) {
      session = options.ask ? { ask: options.ask, close() {} } : terminal(input, prompts);
      await collect(choices, seen, existing, session.ask);
    }
    validate(choices, config, existing);
    const configPath = existing ? config.configPath : null;
    const request = { cwd, configPath, choices };
    const configSnapshot = existing ? readFileSync(configPath, 'utf8') : null;
    const prepared = runWorker({ ...request, operation: 'prepare' });
    const plan = prepared.data;
    if (plan.skippedValidationHooks.length) report.outstanding.push({ description: `Custom ${plan.skippedValidationHooks.join('/')} hooks were not executed by setup validation; run runlist check to execute the project's custom checks` });
    const adoptionSnapshots = plan.adoptions.map(item => [item.path, readFileSync(item.path, 'utf8')]);
    report.actions.push({ id: 'init', description: 'Initialize missing scaffolding; preserve configured roots, JavaScript and hooks', path: configPath || path.join(cwd, 'runlist.config.mjs'), preview: prepared.output, ...plan.layout });
    if (plan.layout.sample) report.notes.push({ description: 'An existing example sample is preserved unchanged; archive or edit it explicitly when ready', path: plan.layout.sample });
    if (plan.policy) report.actions.push({ id: 'policy', description: `Set promptTracking to ${choices.promptTracking} using the narrow config setter`, path: configPath });
    else report.actions.push({ id: 'policy-info', description: `Prompt tracking: ${choices.promptTracking}${existing ? (config.promptTrackingSource === 'legacy-default' ? ' (legacy compatibility default preserved; choose --prompt-tracking explicitly)' : ' (preserve existing choice)') : ' (new project default/selection)'}` });
    report.actions.push({ id: 'ignore-info', description: choices.gitignore ? 'Apply only the .gitignore additions listed in the scaffold preview' : 'Leave ignore files unchanged' });
    for (const adoption of plan.adoptions) report.actions.push({ id: `adopt:${adoption.path}`, description: adoption.candidate ? `Adopt selected file: ${JSON.stringify(adoption.candidate.updates)}` : 'Selected file already tagged; leave unchanged', path: adoption.path,
      preview: `Frontmatter before:\n${adoption.beforeFrontmatter || '(none)'}\nFrontmatter after:\n${adoption.afterFrontmatter}\n`, checks: adoption.checks });
    report.checks.adoptions = plan.adoptions.map(item => ({ path: item.path, ...item.checks }));
    for (const adoption of plan.adoptions) if (adoption.checks.warnings.length) report.outstanding.push({ description: `${adoption.checks.warnings.length} validation warning(s) in selected adoption; authored summary/state were not invented. Run runlist check for details`, path: adoption.path });
    if (plan.firstPlan) {
      report.actions.push({ id: 'plan', description: 'Create first plan from supplied current_state and next_step', path: plan.firstPlan.path, preview: plan.firstPlan.body });
      report.checks.firstPlan = { status: 'preflight-passed', ...plan.firstPlan.checks, path: plan.firstPlan.path };
    }
    if (choices.host !== 'none') {
      const host = await hostRunner({ host: choices.host, dryRun: true, cwd, configPath });
      report.checks.host = { host: choices.host, available: host.available, previewExitCode: host.status };
      checkHostCli(report, cwd);
      report.actions.push({ id: 'host', description: `Installer dry-run for selected ${choices.host} host; no integration was installed by this preview`, preview: `${host.stdout || ''}${host.stderr || ''}` });
      if (host.status !== 0) report.outstanding.push({ description: `Host preview reported exit ${host.status}; installation may be unavailable or refused` });
      if (!host.available) report.outstanding.push({ description: `${choices.host} CLI is unavailable; install/activation cannot be verified` });
    } else report.actions.push({ id: 'host-info', description: 'Host integration: none' });
    const untouched = plan.untagged.filter(file => !plan.adoptions.some(item => item.path === file));
    if (untouched.length) report.outstanding.push({ description: `${untouched.length} pre-existing untagged Markdown file(s) remain untouched; select exact paths with --adopt`, paths: untouched });
    if (choices.promptTracking === 'untracked') report.notes.push({ description: 'Leave pending prompts untracked to reduce commit churn; git add -A can still stage prompts that are not ignored' });
    if (plan.layout.files.includes(config.indexPath) || !existing) report.actions.push({ id: 'index', description: 'Regenerate the configured generated index after selected changes', path: plan.layout.files.find(file => file === config.indexPath) || path.join(cwd, choices.docsRoot, 'docs.md') });
    if (dryRun || (!flags.yes && !session)) {
      report.outstanding.push({ description: 'Preview only; rerun with --yes and the selected flags to apply' });
      render(report, out, json);
      return report;
    }
    if (session) {
      render(report, out, false);
      const confirm = await session.ask('Apply this concrete setup preview? [y/N]: ');
      if (!/^(?:y|yes)$/i.test(confirm ?? '')) {
        report.status = 'cancelled';
        report.outstanding.push({ description: 'Setup cancelled; no changes were made' });
        render(report, out, json);
        return report;
      }
      // Confirmation approves these bytes and paths. Refuse changes while the
      // user was reviewing rather than silently applying a different preview.
      const refreshed = runWorker({ ...request, operation: 'prepare' });
      if (JSON.stringify(refreshed) !== JSON.stringify(prepared)) throw new Error('Setup sources changed during review; rerun to review a fresh preview.');
    }
    if (existing && readFileSync(configPath, 'utf8') !== configSnapshot) throw new Error('Config changed since preview; rerun setup.');
    for (const [file, content] of adoptionSnapshots) if (readFileSync(file, 'utf8') !== content) throw new Error(`Adoption source changed since preview: ${file}`);
    applying = true;
    report.mode = 'apply';
    // Each stage preflights again in a fresh process. This is deliberately a
    // sequence of honest operations, not an advertised multi-stage transaction.
    const steps = [ ...(plan.policy ? ['policy'] : []), 'init', ...plan.adoptions.filter(item => item.candidate).map(item => item.path), ...(plan.firstPlan ? ['plan'] : []), ...(report.actions.some(action => action.id === 'index') ? ['index'] : []) ];
    for (const [stepIndex, step] of steps.entries()) {
      const adoption = plan.adoptions.find(item => item.path === step);
      try {
        const result = runWorker({ ...request, operation: adoption ? 'adopt' : step, ...(adoption ? { path: step, expectedSource: adoptionSnapshots.find(([file]) => file === step)[1] } : {}) });
        const action = report.actions.find(item => item.id === (adoption ? `adopt:${step}` : step));
        const { preview, ...completedAction } = action;
        report.completed.push({ ...completedAction, output: result.output });
      } catch (error) {
        report.failed.push({ description: `${adoption ? 'Adoption' : step} failed: ${error.message}`, ...(adoption ? { path: step } : {}), output: error.output || '' });
        report.outstanding.push({ description: 'The failed stage may have partial effects; earlier completed stages remain applied. Setup is not a multi-stage transaction.' });
        for (const remaining of steps.slice(stepIndex + 1)) {
          const action = report.actions.find(item => item.id === remaining || item.id === `adopt:${remaining}`);
          report.outstanding.push({ description: `Not attempted: ${action?.description || remaining}`, ...(action?.path ? { path: action.path } : {}) });
        }
        break;
      }
    }
    if (choices.host !== 'none') {
      if (report.failed.length) report.outstanding.push({ description: `Host install for ${choices.host} was not attempted after project setup failed` });
      else if (!report.checks.host.available) report.failed.push({ description: `${choices.host} CLI is unavailable; host install was not attempted` });
      else {
        checkHostCli(report, cwd);
        const host = await hostRunner({ host: choices.host, dryRun: false, cwd, configPath: configPath || path.join(cwd, 'runlist.config.mjs') });
        if (host.status !== 0) report.failed.push({ description: `${choices.host} install failed (exit ${host.status})`, output: `${host.stdout || ''}${host.stderr || ''}` });
        else report.completed.push({ id: 'host', description: `${choices.host} install verb completed`, output: `${host.stdout || ''}${host.stderr || ''}` });
        report.outstanding.push({ description: `Reload/restart ${choices.host} (for Codex, start a new thread and review/trust hooks); live host activation remains unverified` });
      }
    }
    try {
      const checked = runWorker({ ...request, operation: 'check', ...(plan.firstPlan ? { planPath: plan.firstPlan.path } : {}) }).data;
      report.checks.project = { status: 'checked', scope: 'whole project; built-in validation only, custom hooks not executed', errors: checked.errors, warnings: checked.warnings, untagged: checked.untagged };
      if (checked.firstPlan) report.checks.firstPlan = { status: checked.firstPlan.errors.length || checked.firstPlan.warnings.length ? 'findings' : 'passed', ...checked.firstPlan };
      if (checked.errors.length || checked.warnings.length) report.outstanding.push({ description: `Whole-project validation: ${checked.errors.length} error(s), ${checked.warnings.length} warning(s); run runlist check for details. These findings are separate from the selected first plan and adoption checks` });
    } catch (error) { report.failed.push({ description: `Project validation failed: ${error.message}` }); }
    report.status = report.failed.length ? 'partial' : report.checks.project?.errors.length ? 'attention' : 'completed';
  } catch (error) {
    if (error.message === 'SETUP_CANCELLED') {
      report.status = 'cancelled';
      report.outstanding.push({ description: 'Setup cancelled or input ended; no changes were made' });
    } else {
      report.status = report.completed.length ? 'partial' : 'failed';
      report.failed.push({ description: `${applying ? 'Setup' : 'Preflight'} failed: ${error.message}` });
    }
  } finally { session?.close(); }
  if (report.failed.length || report.status === 'attention') process.exitCode = 1;
  render(report, out, json);
  return report;
}
