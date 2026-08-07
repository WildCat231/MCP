#!/usr/bin/env node
/**
 * The executable entry point.
 *
 * This file exists so that `src/index.ts` can be a library — importable by
 * tests and by other modules without starting a server — while the thing a
 * client launches has no conditional in it at all.
 *
 * ## Why there is no is-this-the-main-module guard
 *
 * There used to be one, in index.ts:
 *
 *     const isDirectRun = import.meta.url === pathToFileURL(process.argv[1]).href;
 *
 * It fails whenever the entry point is reached by any path other than the one
 * Node resolves the module to. A symlinked launcher is the common case:
 * `process.argv[1]` is the symlink, `import.meta.url` is the realpath, the
 * comparison is false, `main()` never runs, and the process exits 0 with no
 * output. Nothing crashes and nothing is missing — the server simply does
 * nothing, which is the hardest kind of failure to read from the outside. A
 * client reports it as "connection closed" and a log shows an empty stderr.
 *
 * This is the second time that comparison has produced exactly this symptom.
 * The first was on Windows, where `process.argv[1]` is a backslash drive path
 * that never equals a `file://` URL under naive concatenation. Fixing the
 * comparison a second time would leave a third variant waiting — case-folding
 * filesystems, UNC paths, percent-encoding of unusual characters in an install
 * directory. So the guard is gone rather than repaired: an executable that is
 * only ever an executable does not need to ask whether it is one.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { SERVER_NAME, TOOL_VERSION, createServer } from './index.js';
import { frontierHome } from './paths.js';

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();

  // Awaited: the transport subscribes to stdin during connect, and that
  // subscription is what holds the event loop open. Returning before it
  // resolves would let the process drain and exit cleanly, reproducing the
  // same silent no-op from the other direction.
  await server.connect(transport);

  // stderr, never stdout — stdout carries the JSON-RPC frames, and one stray
  // byte on it makes the client fail to parse and disconnect.
  process.stderr.write(`${SERVER_NAME} ${TOOL_VERSION} listening on stdio (home: ${frontierHome()})\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `${SERVER_NAME}: fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
