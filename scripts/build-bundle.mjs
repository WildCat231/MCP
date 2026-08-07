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

import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { inputsHash } from './lib/bundle-hash.mjs';

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

/**
 * Bare specifiers imported by the compiled output that do not resolve from the
 * staged tree. Comment text and ordinary strings are excluded by anchoring on
 * real import/export/require forms rather than matching any quoted string.
 */
function unresolvedSpecifiers(dir) {
  const distDir = path.join(dir, 'dist');
  const requireFrom = createRequire(path.join(dir, 'package.json'));
  const patterns = [
    /(?:^|[\s;}])(?:import|export)\s[^;'"]*?from\s*['"]([^'"]+)['"]/gm,
    /(?:^|[\s;}])import\s*['"]([^'"]+)['"]/gm,
    /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];

  const seen = new Map();
  const walk = (current) => {
    for (const entry of fsSync.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) {
        const source = fsSync.readFileSync(full, 'utf8');
        for (const pattern of patterns) {
          for (const match of source.matchAll(pattern)) {
            const specifier = match[1];
            if (specifier.startsWith('.') || specifier.startsWith('node:')) continue;
            if (!seen.has(specifier)) seen.set(specifier, path.relative(dir, full));
          }
        }
      }
    }
  };
  walk(distDir);

  const missing = [];
  for (const [specifier, from] of seen) {
    try {
      requireFrom.resolve(specifier);
    } catch {
      missing.push({ specifier, from });
    }
  }
  return missing;
}

/** Start the staged server and confirm it comes up, capturing its stderr. */
function verifyStartup(dir) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(dir, 'dist', 'main.js')], {
      cwd: dir,
      // Its own home, so verification never touches the developer's cache.
      env: { ...process.env, FRONTIER_HOME: path.join(dir, '.verify-home') },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    let settled = false;
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      if (!settled && /listening on stdio/.test(stderr)) {
        settled = true;
        child.kill();
        resolve({ ok: true, stderr, code: null, signal: null });
      }
    });

    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, stderr, code, signal });
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ ok: false, stderr: `${stderr}\n(timed out waiting for startup)`, code: null, signal: 'TIMEOUT' });
    }, 15_000);
    timer.unref?.();
  });
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

// Verify the staged tree BEFORE packing. A bundle that cannot start is worth
// catching here, with the process's own stderr in front of you, rather than
// three steps later as an MCP client reporting "-32000 connection closed" —
// which says only that the child died, never why.
console.log('Verifying staged bundle...');
const unresolved = unresolvedSpecifiers(stagingDir);
if (unresolved.length > 0) {
  console.error('\nStaged bundle is missing runtime dependencies:');
  for (const { specifier, from } of unresolved) console.error(`  ${specifier}  (imported by ${from})`);
  console.error('\nThese resolve in the repo because devDependencies are installed alongside.');
  process.exit(1);
}
console.log(`  import closure resolves`);

const startup = await verifyStartup(stagingDir);
if (!startup.ok) {
  console.error('\nStaged bundle failed to start:');
  console.error(startup.stderr.trim() || '  (no stderr — process exited silently)');
  console.error(`\n  exit code: ${startup.code}, signal: ${startup.signal}`);
  process.exit(1);
}
console.log('  server starts and speaks stdio');

console.log('Packing...');
const packOutput = run('npx', ['--yes', '@anthropic-ai/mcpb@latest', 'pack', stagingDir, path.join(outputDir, 'frontier.mcpb')]);
console.log(packOutput.split('\n').slice(-12).join('\n'));

await fs.rm(path.join(stagingDir, '.verify-home'), { recursive: true, force: true });
// Stamp beside the artifact, so a test can check freshness without unpacking.
await fs.writeFile(
  `${path.join(outputDir, 'frontier.mcpb')}.stamp.json`,
  `${JSON.stringify({ inputs_sha256: inputsHash(), built_at: new Date().toISOString(), version: pkg.version }, null, 2)}\n`,
);

if (!keep) {
  await fs.rm(stagingDir, { recursive: true, force: true });
}
console.log(`\nBundle: ${path.join(outputDir, 'frontier.mcpb')}`);
