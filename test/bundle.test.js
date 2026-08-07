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
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import fsSync, { existsSync } from 'node:fs';
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
    for (const required of ['manifest.json', 'package.json', 'dist/main.js']) {
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

test('the extracted bundle starts, and says why if it does not', async (t) => {
  // Run the entry point directly rather than through an MCP client. A client
  // reports a dead child as "-32000 connection closed", which says only that
  // it died; the process's own stderr says why. This test exists so that
  // diagnosis never requires reaching for the shell.
  if (!needsBundle(t)) return;
  const dir = await extract();
  const home = path.join(dir, '.test-home');

  try {
    const { ok, stderr, code, signal } = await new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(dir, 'dist', 'main.js')], {
        cwd: dir,
        env: { ...process.env, FRONTIER_HOME: home },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let captured = '';
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        child.kill();
        resolve(result);
      };

      child.stderr.on('data', (chunk) => {
        captured += String(chunk);
        if (/listening on stdio/.test(captured)) finish({ ok: true, stderr: captured });
      });
      child.on('exit', (exitCode, exitSignal) =>
        finish({ ok: false, stderr: captured, code: exitCode, signal: exitSignal }),
      );
      setTimeout(() => finish({ ok: false, stderr: `${captured}\n(timed out)`, signal: 'TIMEOUT' }), 15_000);
    });

    assert.ok(
      ok,
      `The bundled server exited on startup (code ${code}, signal ${signal}). Its stderr:\n${
        stderr.trim() || '(silent)'
      }`,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/** Minimal JSON-RPC over stdio, so the child process stays under our control. */
function speak(child) {
  let buffer = '';
  const pending = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += String(chunk);
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line === '') continue;
      try {
        const message = JSON.parse(line);
        const resolve = pending.get(message.id);
        if (resolve !== undefined) {
          pending.delete(message.id);
          resolve(message);
        }
      } catch {
        // Not a frame we asked for.
      }
    }
  });

  return {
    request(id, method, params) {
      const answer = new Promise((resolve, reject) => {
        pending.set(id, resolve);
        setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), 10_000);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return answer;
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },
  };
}

test('the bundled server is still running after a completed handshake', async (t) => {
  // "It started" is not the property that matters — the Phase 10 regression
  // started fine and exited immediately, because the direct-run guard meant
  // main() never ran and the event loop had nothing to hold it open. Exit code
  // 0, empty stderr, no crash, no missing dependency. So this drives a real
  // handshake and then asserts the process is STILL ALIVE, and still alive
  // after an idle period, which is what a client actually depends on.
  if (!needsBundle(t)) return;
  const dir = await extract();
  const home = path.join(dir, '.alive-home');

  const child = spawn(process.execPath, [path.join(dir, 'dist', 'main.js')], {
    cwd: dir,
    env: { ...process.env, FRONTIER_HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });

  try {
    const rpc = speak(child);

    const initialized = await rpc.request(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'frontier-liveness-test', version: '0.0.0' },
    });
    assert.equal(initialized.result?.serverInfo?.name, 'frontier', `handshake failed. stderr:\n${stderr}`);
    rpc.notify('notifications/initialized', {});

    const listed = await rpc.request(2, 'tools/list', {});
    assert.ok(listed.result?.tools?.length > 0, 'the handshake should yield tools');

    // The assertion the earlier test could not make.
    assert.equal(
      child.exitCode,
      null,
      `The server exited (code ${child.exitCode}) after completing the handshake. stderr:\n${stderr || '(silent)'}`,
    );

    // And it must stay up while idle — a client leaves the connection open
    // between calls.
    await new Promise((resolve) => setTimeout(resolve, 750));
    assert.equal(child.exitCode, null, 'the server exited while idle after the handshake');

    // Still answering, not merely still resident.
    const again = await rpc.request(3, 'tools/call', { name: 'ping', arguments: {} });
    assert.ok(again.result, 'the server should still answer after idling');
  } finally {
    child.kill();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('the entry point runs when reached through a symlink', async (t) => {
  // The exact shape of the Phase 10 failure. An installer that launches the
  // server through a symlink makes process.argv[1] the link while
  // import.meta.url is the realpath; any comparison between the two is false,
  // and a guarded entry point silently does nothing. There is no guard now,
  // and this keeps it that way.
  if (!needsBundle(t)) return;
  const dir = await extract();
  const link = path.join(dir, 'launch-via-symlink.js');

  try {
    await fs.symlink(path.join(dir, 'dist', 'main.js'), link);

    const started = await new Promise((resolve) => {
      const child = spawn(process.execPath, [link], {
        cwd: dir,
        env: { ...process.env, FRONTIER_HOME: path.join(dir, '.symlink-home') },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let captured = '';
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        child.kill();
        resolve(result);
      };
      child.stderr.on('data', (chunk) => {
        captured += String(chunk);
        if (/listening on stdio/.test(captured)) finish({ ok: true, stderr: captured });
      });
      child.on('exit', (code) => finish({ ok: false, stderr: captured, code }));
      setTimeout(() => finish({ ok: false, stderr: captured, code: 'timeout' }), 10_000);
    });

    assert.ok(
      started.ok,
      'Launched through a symlink the server did nothing and exited ' +
        `(code ${started.code}). stderr: ${started.stderr.trim() || '(silent)'}. ` +
        'An is-this-the-main-module guard has been reintroduced somewhere.',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('the compiled library starts nothing when imported', async (t) => {
  // index.js must stay side-effect free: if importing it started a server, the
  // tests that import createServer() would each spawn a stdio listener.
  if (!needsBundle(t)) return;
  const dir = await extract();

  try {
    const source = fsSync.readFileSync(path.join(dir, 'dist', 'index.js'), 'utf8');
    assert.ok(!/StdioServerTransport/.test(source), 'index.js must not construct a transport');
    assert.ok(!/^main\(\)/m.test(source), 'index.js must not invoke main()');
    assert.ok(/dist\/main\.js/.test('dist/main.js'), 'the executable lives in main.js');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('every runtime import resolves from the bundle alone', async (t) => {
  // The failure mode a repo run can never catch: the repo has every
  // devDependency installed alongside, so a missing production dependency
  // resolves there and only there.
  if (!needsBundle(t)) return;
  const dir = await extract();

  try {
    const requireFrom = createRequire(path.join(dir, 'package.json'));
    const patterns = [
      /(?:^|[\s;}])(?:import|export)\s[^;'"]*?from\s*['"]([^'"]+)['"]/gm,
      /(?:^|[\s;}])import\s*['"]([^'"]+)['"]/gm,
      /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    ];

    const specifiers = new Map();
    const walk = (current) => {
      for (const entry of fsSync.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js')) {
          const source = fsSync.readFileSync(full, 'utf8');
          for (const pattern of patterns) {
            for (const match of source.matchAll(pattern)) {
              const spec = match[1];
              if (spec.startsWith('.') || spec.startsWith('node:')) continue;
              if (!specifiers.has(spec)) specifiers.set(spec, path.relative(dir, full));
            }
          }
        }
      }
    };
    walk(path.join(dir, 'dist'));

    assert.ok(specifiers.size > 0, 'the scan should find the imports it is checking');

    const missing = [];
    for (const [spec, from] of specifiers) {
      try {
        requireFrom.resolve(spec);
      } catch {
        missing.push(`${spec} (imported by ${from})`);
      }
    }
    assert.deepEqual(missing, [], 'these resolve in the repo but not in the bundle');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('every tool the manifest advertises is reachable from the extracted bundle', async (t) => {
  // The §10.10 check, minus the client install.
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

  // Capture the child's stderr so a connect failure reports the cause rather
  // than only the symptom.
  let childStderr = '';
  try {
    try {
      await client.connect(transport);
      transport.stderr?.on('data', (chunk) => {
        childStderr += String(chunk);
      });
    } catch (err) {
      assert.fail(
        `Could not connect to the bundled server: ${err instanceof Error ? err.message : String(err)}\n` +
          `Child stderr:\n${childStderr.trim() || '(none captured — run the previous test for the real reason)'}`,
      );
    }

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
