import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopLaunch } from '../src/desktop.mjs';
import { installedDesktopVersion, runDesktopInstall, selectDesktopRelease } from '../src/desktop-install.mjs';
import { privateBuildEnvironment } from '../desktop/scripts/build-environment.mjs';
import { checkPublicBundle } from '../desktop/scripts/check-public-bundle.mjs';
import { saveReceipt } from '../desktop/scripts/notarize.mjs';
import { preflightDesktopRelease } from './desktop-release-config.mjs';

export function validateDesktopManifest(manifest, version, source) {
  if (manifest?.version !== version || manifest.sourceCommit !== source || manifest.architecture !== 'arm64'
      || manifest.protocol !== 1 || manifest.team !== '7GSPYYN5X8' || manifest.notarized !== true
      || !/^[a-f0-9]{64}$/.test(manifest.sha256 ?? '')
      || manifest.artifact !== `Runlist-${version}-macOS-arm64.dmg`
      || manifest.submissions?.length !== 2 || manifest.submissions.some(item => item.status !== 'Accepted')) {
    throw new Error('Desktop release evidence does not match the exact version, source and accepted artifacts.');
  }
}

export async function releaseDesktop(root = process.cwd(), version, source, { environment = process.env } = {}) {
  const env = preflightDesktopRelease(root, { env: environment });
  if (!env) return;
  const capture = (command, args) => execFileSync(command, args, { cwd: root, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const run = (command, args, extraEnv = env) => execFileSync(command, args, { cwd: root, env: extraEnv, stdio: 'inherit' });
  const head = capture('git', ['rev-parse', 'HEAD']).trim();
  source ??= head;
  version ??= JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  if (!/^[a-f0-9]{40}$/.test(source) || !/^\d+\.\d+\.\d+$/.test(version)
      || JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version !== version) {
    throw new Error('Desktop release must use the exact stable CLI release commit and version.');
  }
  if (capture('git', ['status', '--porcelain=v1', '--untracked-files=all']).trim()) throw new Error('Desktop release source must be clean.');
  if (source !== head) {
    // Recovery may need newer release tooling after the immutable CLI tag was
    // published. Build that tag in its own checkout, never newer app sources.
    capture('git', ['merge-base', '--is-ancestor', source, head]);
    const selected = path.join(root, '.runlist', 'desktop-release', version, 'source');
    if (!existsSync(selected)) {
      mkdirSync(path.dirname(selected), { recursive: true });
      run('git', ['worktree', 'add', '--detach', selected, source]);
    }
    return releaseDesktop(selected, version, source, { environment: env });
  }
  let verified = false;
  for (const workflow of ['publish.yml', 'ci.yml']) {
    const runs = JSON.parse(capture('gh', ['api', `repos/reowens/runlist/actions/workflows/${workflow}/runs?head_sha=${source}&status=success&per_page=100`]));
    if (runs.workflow_runs.some(run => run.head_sha === source && ['push', 'workflow_dispatch'].includes(run.event) && run.conclusion === 'success')) { verified = true; break; }
  }
  if (!verified) throw new Error('Desktop release requires successful CI or Publish verification for this exact source commit.');
  const tag = `desktop-v${version}`;
  let published;
  try { published = JSON.parse(capture('gh', ['release', 'view', tag, '--json', 'isDraft,targetCommitish,assets'])); }
  catch (error) {
    // A transport/authentication failure is not evidence that a release is absent.
    const listed = JSON.parse(capture('gh', ['api', 'repos/reowens/runlist/releases?per_page=100']));
    if (listed.some(item => item.tag_name === tag)) throw error;
  }
  if (published && published.targetCommitish !== source) throw new Error('Existing desktop release belongs to a different source commit.');
  const directory = path.join(root, '.runlist', 'desktop-release', version);
  mkdirSync(directory, { recursive: true });
  const lock = path.join(directory, 'release.lock');
  try { mkdirSync(lock); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Another desktop release may be running. Confirm it stopped before removing its release.lock directory.'); throw error; }
  try {
  const stateFile = path.join(directory, 'state.json');
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { version, source };
  if (state.version !== version || state.source !== source) throw new Error('Desktop release state belongs to different source.');
  const save = () => saveReceipt(stateFile, state);
  const app = path.join(env.CARGO_TARGET_DIR || path.join(root, 'desktop/src-tauri/target'), 'release/bundle/macos/Runlist.app');
  const manifestFile = path.join(directory, 'release-manifest.json');
  if (!published || published.isDraft) {
    if (!state.built) {
      run('npm', ['ci', '--prefix', 'desktop']);
      run('npm', ['--prefix', 'desktop', 'test']);
      run('npm', ['--prefix', 'desktop', 'run', 'build', '--', '--ci']);
      run('cargo', ['test', '--locked', '--manifest-path', 'desktop/src-tauri/Cargo.toml', '--lib'], privateBuildEnvironment(root, env));
      run('npm', ['--prefix', 'desktop', 'run', 'test:bundle']);
      saveReceipt(path.join(directory, 'unsigned-public-check.json'), checkPublicBundle(app, root));
      state.built = true; save();
    }
    if (!state.signed) {
      run(process.execPath, ['desktop/scripts/sign.mjs'], { ...env, RUNLIST_SIGN_APP: app, RUNLIST_RELEASE_DIR: directory, RUNLIST_RELEASE_SOURCE_SHA: source });
      state.signed = true; save();
    }
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    validateDesktopManifest(manifest, version, source);
    const artifact = path.join(directory, manifest.artifact);
    if (createHash('sha256').update(readFileSync(artifact)).digest('hex') !== manifest.sha256) throw new Error('Desktop installer changed after qualification.');
    run(process.execPath, ['desktop/scripts/inspect-bundle.mjs', app]);
    run(process.execPath, ['desktop/scripts/check-installed.mjs', app]);
    saveReceipt(path.join(directory, 'signed-public-check.json'), checkPublicBundle(app, root));
    const checksum = path.join(directory, 'SHA256SUMS');
    writeFileSync(checksum, `${manifest.sha256}  ${manifest.artifact}\n`);
    if (!published) {
      const notes = path.join(directory, 'release-notes.md');
      writeFileSync(notes, `Runlist ${version} for Apple Silicon macOS 13.5+. Includes the matching CLI engine ${version}.\n\nSigned and notarized; app and installer tickets are stapled. Offline packaged checks passed. Native-window, fresh/minimum-host and other desktop platform acceptance remain separate.\n\nInstall or update: \`runlist desktop install\`. Quit Runlist before updating; the previous app is retained for rollback.\n`);
      run('gh', ['release', 'create', tag, '--target', source, '--draft', '--title', `Runlist Desktop ${version} (Mac)`, '--notes-file', notes]);
    }
    run('gh', ['release', 'upload', tag, artifact, manifestFile, checksum, '--clobber']);
    run('gh', ['release', 'edit', tag, '--draft=false', '--latest=false']);
    published = JSON.parse(capture('gh', ['release', 'view', tag, '--json', 'isDraft,targetCommitish,assets']));
  }
  const installer = selectDesktopRelease([{ draft: published.isDraft, assets: published.assets.map(asset => ({
    ...asset, browser_download_url: asset.url,
  })) }]);
  if (installer?.version !== version) throw new Error('The matching desktop release is not publicly downloadable.');
  if (existsSync(manifestFile) && JSON.parse(readFileSync(manifestFile, 'utf8')).sha256 !== installer.sha256) throw new Error('Published desktop bytes differ from the qualified installer.');
  state.published = true; save();
  if (desktopLaunch([]).app) {
    const result = await runDesktopInstall(['install']);
    if (await installedDesktopVersion(result.installed) !== version) throw new Error('Installed desktop does not match this release.');
    run(process.execPath, ['desktop/scripts/check-installed.mjs', result.installed]);
    state.installed = result; save();
  }
  console.log(`Desktop ${version} published${state.installed ? ' and installed' : ''}.`);
  } finally { rmSync(lock, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  releaseDesktop(process.cwd(), process.argv[2], process.argv[3]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
