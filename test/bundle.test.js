/**
 * Phase 10: the packaged bundle (CODEX_SPEC.md §10.10).
 *
 * §10.10 asks for "install locally from the file and confirm every tool is
 * reachable". Installing into Claude Desktop needs a desktop; what CAN be
 * verified anywhere is the half that actually breaks — that the archive
 * contains a runnable server with a complete dependency closure, and that
 * every tool the manifest advertises answers over stdio from the EXTRACTED
 * bundle rather than from the working tree.
 *
 * That distinction is the point. Running `dist/index.js` from the repo proves
 * nothing about the bundle, because the repo has every devDependency installed
 * alongside. Running it from the extracted archive, with only the production
 * closure present, is what catches a missing dependency.
 *
 * Skips with instructions when the bundle has not been built, in the same way
 * the fixture tests do; `npm run bundle` takes about ten seconds and is not
 * something `npm test` should trigger on every run.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundlePath = path.join(repoRoot, 'build', 'frontier.mcpb');

function needsBundle(t) {
  if (!existsSync(bundlePath)) {
    t.skip('bundle not built — run: npm run bundle');
    return false;
  }
  return true;
}

/** Extract to a temp dir. The .mcpb is a zip; `unzip` is the portable reader here. */
async function extract() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frontier-bundle-'));
  execFileSync('unzip', ['-q', bundlePath, '-d', dir], { stdio: ['ignore', 'ignore', 'inherit'] });
  return dir;
}

test('the bundle contains a manifest, compiled output and its dependencies', async (t) => {
  if (!needsBundle(t)) return;
  const dir = await extract();
  try {
    for (const required of ['manifest.json', 'package.json', 'dist/index.js']) {
      assert.ok(existsSync(path.join(dir, required)), `bundle is missing ${required}`);
    }

    // The three runtime dependencies must be present; a client never runs
    // npm install.
    for (const dep of ['@modelcontextprotocol/sdk', 'zod', 'fast-xml-parser']) {
      assert.ok(existsSync(path.join(dir, 'node_modules', dep)), `bundle is missing runtime dep ${dep}`);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('the bundle ships no devDependencies, source, tests or fixtures', async (t) => {
  if (!needsBundle(t)) return;
  const dir = await extract();
  try {
    // TypeScript alone is 18 MB and is never used at runtime.
    for (const excluded of ['node_modules/typescript', 'node_modules/@types', 'src', 'test', 'scripts']) {
      assert.ok(!existsSync(path.join(dir, excluded)), `bundle should not ship ${excluded}`);
    }

    const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
    assert.equal(pkg.devDependencies, undefined, 'devDependencies must be stripped');
    assert.equal(pkg.scripts, undefined, 'build scripts in an installed bundle are noise at best');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('the manifest entry point is the one the bundle actually contains', async (t) => {
  if (!needsBundle(t)) return;
  const dir = await extract();
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
    assert.ok(existsSync(path.join(dir, manifest.server.entry_point)), 'entry_point must resolve inside the bundle');

    // ${__dirname} is substituted by the client at install time; what matters
    // here is that the path after it matches the real entry point.
    const arg = manifest.server.mcp_config.args[0];
    assert.match(arg, /\$\{__dirname\}/, 'the launch path must be relative to the install directory');
    assert.ok(arg.endsWith(manifest.server.entry_point), 'launch arg and entry_point must agree');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('every tool the manifest advertises is reachable from the extracted bundle', async (t) => {
  // The §10.10 check, minus the client install. Running from the extracted
  // archive — not the repo — is what proves the dependency closure is complete.
  if (!needsBundle(t)) return;
  const dir = await extract();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'frontier-bundle-home-'));

  const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(dir, manifest.server.entry_point)],
    cwd: dir,
    env: { ...process.env, FRONTIER_HOME: home },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'frontier-bundle-test', version: '0.0.0' });

  try {
    await client.connect(transport);

    const { tools } = await client.listTools();
    const live = tools.map((x) => x.name).sort();
    const advertised = manifest.tools.map((x) => x.name).sort();
    assert.deepEqual(live, advertised, 'manifest and server must advertise the same tools');

    // Every offline-capable tool answers. The network-bound ones are covered
    // elsewhere; what is under test here is that the module graph loads.
    const ping = JSON.parse((await client.callTool({ name: 'ping', arguments: {} })).content[0].text);
    assert.equal(ping.server, 'frontier');
    assert.equal(ping.version, manifest.version, 'bundle version must match the manifest');

    const status = JSON.parse((await client.callTool({ name: 'cache_status', arguments: {} })).content[0].text);
    assert.equal(status.total_entries, 0);

    // cluster_frontier exercises fast-xml-parser's sibling imports and the
    // pure-arithmetic path, all from bundled dependencies.
    const clustered = JSON.parse(
      (
        await client.callTool({
          name: 'cluster_frontier',
          arguments: { papers: [], component: 'smoke' },
        })
      ).content[0].text,
    );
    assert.equal(clustered.too_sparse, true);

    const saved = JSON.parse(
      (await client.callTool({ name: 'save_snapshot', arguments: { query: 'bundle smoke' } })).content[0].text,
    );
    assert.match(saved.id, /^[0-9a-f]{64}$/);
    const loaded = JSON.parse(
      (await client.callTool({ name: 'load_snapshot', arguments: { id: saved.id } })).content[0].text,
    );
    assert.equal(loaded.verified, true);
  } finally {
    await client.close();
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  }
});
