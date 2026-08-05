#!/usr/bin/env node
/**
 * Build the installable `.mcpb` bundle (CODEX_SPEC.md §10.10).
 *
 * An `.mcpb` is installed by double-clicking it into a client, which never
 * runs `npm install`. So the bundle has to carry its runtime dependencies —
 * but ONLY its runtime dependencies. Packing the working tree directly ships
 * TypeScript, the test fixtures, and every devDependency: 31 MB unpacked and
 * 2400 files, almost none of which the server uses at runtime.
 *
 * This script therefore stages a clean tree containing exactly:
 *
 *   manifest.json     the MCPB manifest
 *   package.json      trimmed to production dependencies
 *   dist/             compiled output
 *   node_modules/     production dependency closure only
 *   README, LICENSE   provenance
 *
 * The production closure is read from `npm ls --omit=dev`, so it stays correct
 * as dependencies change instead of being an ignore list that silently rots.
 *
 *   node scripts/build-bundle.mjs            # build/, stage, pack
 *   node scripts/build-bundle.mjs --keep     # leave the staging dir for inspection
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stagingDir = path.join(repoRoot, 'build', 'bundle');
const outputDir = path.join(repoRoot, 'build');
const keep = process.argv.includes('--keep');

const run = (cmd, args, cwd = repoRoot) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

/** Production dependency directories, from npm rather than a hand-kept list. */
function productionDependencyPaths() {
  const raw = run('npm', ['ls', '--omit=dev', '--parseable', '--all']);
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && line !== repoRoot && line.includes(`${path.sep}node_modules${path.sep}`));
}

async function copyDir(from, to) {
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.cp(from, to, { recursive: true, dereference: true });
}

async function directorySize(dir) {
  let total = 0;
  let files = 0;
  for (const entry of await fs.readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    files += 1;
    total += (await fs.stat(path.join(entry.parentPath ?? entry.path, entry.name))).size;
  }
  return { bytes: total, files };
}

console.log('Compiling...');
run('npm', ['run', 'build']);

console.log('Staging bundle...');
await fs.rm(stagingDir, { recursive: true, force: true });
await fs.mkdir(stagingDir, { recursive: true });

await copyDir(path.join(repoRoot, 'dist'), path.join(stagingDir, 'dist'));
await fs.copyFile(path.join(repoRoot, 'manifest.json'), path.join(stagingDir, 'manifest.json'));
for (const optional of ['README.md', 'LICENSE']) {
  try {
    await fs.copyFile(path.join(repoRoot, optional), path.join(stagingDir, optional));
  } catch {
    // LICENSE may not exist yet; the manifest already declares the license.
  }
}

// package.json without devDependencies or scripts. A client reads `main` and
// the dependency list; build scripts in an installed bundle are noise at best
// and a footgun at worst.
const pkg = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'));
delete pkg.devDependencies;
delete pkg.scripts;
await fs.writeFile(path.join(stagingDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);

const deps = productionDependencyPaths();
for (const dep of deps) {
  await copyDir(dep, path.join(stagingDir, path.relative(repoRoot, dep)));
}
console.log(`  ${deps.length} production packages copied`);

const staged = await directorySize(stagingDir);
console.log(`  staged: ${(staged.bytes / 1e6).toFixed(1)} MB across ${staged.files} files`);

console.log('Packing...');
const packOutput = run('npx', ['--yes', '@anthropic-ai/mcpb@latest', 'pack', stagingDir, path.join(outputDir, 'frontier.mcpb')]);
console.log(packOutput.split('\n').slice(-12).join('\n'));

if (!keep) {
  await fs.rm(stagingDir, { recursive: true, force: true });
}
console.log(`\nBundle: ${path.join(outputDir, 'frontier.mcpb')}`);
