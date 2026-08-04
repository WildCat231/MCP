/**
 * Filesystem-backed JSON store.
 *
 * The storage primitive underneath the cache and (later) snapshots: read,
 * write, delete, and enumerate JSON documents under a directory.
 *
 * Writes are atomic — serialize to a temp file in the same directory, then
 * `rename`. `rename` within a directory is atomic on POSIX and on Windows
 * NTFS, so a crash or a concurrently reading process sees either the old
 * document or the new one, never a half-written file. This matters more than
 * it looks: a truncated cache entry that still parses as JSON would be
 * indistinguishable from a real API response returning partial data.
 *
 * Reads never throw on corruption. A cache is disposable by definition, so an
 * unparseable entry is treated as a miss and reported, not raised.
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface ReadResult<T> {
  /** Parsed document, or undefined when absent or unreadable. */
  value?: T;
  /** Set when the file existed but could not be read or parsed. */
  corrupt?: boolean;
}

function isMissing(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

export async function ensureDir(dir: string): Promise<void> {
  // 0o700: the cache holds a record of what the user has been researching.
  // Ignored on Windows, harmless there.
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
}

export async function readJson<T>(file: string): Promise<ReadResult<T>> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (isMissing(err)) return {};
    return { corrupt: true };
  }
  try {
    return { value: JSON.parse(text) as T };
  } catch {
    return { corrupt: true };
  }
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  const dir = path.dirname(file);
  await ensureDir(dir);
  // Temp file in the same directory, so the rename never crosses a filesystem
  // boundary (where it would stop being atomic and start being copy+unlink).
  const tmp = path.join(dir, `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

/** Returns true when a document was actually removed. */
export async function removeJson(file: string): Promise<boolean> {
  try {
    await fs.unlink(file);
    return true;
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
}

/**
 * Every `.json` document under `dir`, recursively. Missing directory yields an
 * empty list — an unused cache is not an error. Temp files are skipped so an
 * enumeration racing a write never yields a partial document.
 */
export async function listJson(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }

  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await listJson(full)));
    } else if (entry.isFile() && entry.name.endsWith('.json') && !entry.name.startsWith('.')) {
      found.push(full);
    }
  }
  return found;
}

/** Remove a directory tree. Used by `clear_cache`. */
export async function removeDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}
