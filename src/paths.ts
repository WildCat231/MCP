/**
 * Where frontier keeps its state on disk.
 *
 * Single root, `~/.frontier`, overridable with `FRONTIER_HOME`. The override
 * is not a convenience: tests must never read or write the real user's cache,
 * or a passing suite would depend on whatever the developer had queried that
 * week, and §8's determinism requirement would be untestable.
 *
 * Every path here is built with `path.join` and `os.homedir()`, so nothing in
 * this module is platform-specific.
 */

import os from 'node:os';
import path from 'node:path';

export function frontierHome(): string {
  const override = process.env['FRONTIER_HOME'];
  if (override !== undefined && override.trim() !== '') {
    return path.resolve(override);
  }
  return path.join(os.homedir(), '.frontier');
}

export function cacheDir(home = frontierHome()): string {
  return path.join(home, 'cache');
}

export function snapshotsDir(home = frontierHome()): string {
  return path.join(home, 'snapshots');
}

export function statsFile(home = frontierHome()): string {
  return path.join(home, 'stats.json');
}
