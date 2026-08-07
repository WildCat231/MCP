/**
 * Content hash of everything the `.mcpb` bundle is built from.
 *
 * This lives in its own module for one reason: both the build script and the
 * bundle tests need it, and `scripts/build-bundle.mjs` performs a full build at
 * top level. Importing the hash from there would compile, stage, and pack the
 * bundle as a side effect of running `npm test` — the same import-time
 * side-effect problem the main/index split exists to avoid, one layer up.
 *
 * Content rather than mtime: `npm test` runs `tsc` first, so `dist/` is
 * rewritten on every test run even when nothing changed. An mtime comparison
 * would call the bundle stale every single time and the signal would be worth
 * nothing.
 *
 * What is hashed is what the tests can be wrong about: `dist/`, the manifest,
 * and package.json. Two things staged into the bundle are deliberately left
 * out. Dependencies, because they are copied from the resolved
 * `npm ls --omit=dev` closure — a change there shows up in package.json, and
 * hashing several thousand node_modules files on every test run would cost more
 * than the check is worth. README and LICENSE, because they carry no behaviour;
 * including them would demand a ten-second rebuild after every documentation
 * edit to keep the suite green, which trains people to ignore the warning.
 *
 * So the guarantee is narrower than "the bundle matches the tree": it is "the
 * bundle runs the code the tree contains". That is the property the bundle
 * tests actually assert, and the one a stale artifact silently violates.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Files hashed alongside the compiled output. */
const TOP_LEVEL_INPUTS = ['manifest.json', 'package.json'];

/** @returns {string} hex SHA-256 over the staged inputs, stable across runs. */
export function inputsHash() {
  const hash = createHash('sha256');
  // Path and body are both fed in, NUL-delimited, so that renaming a file
  // changes the digest even when its contents are identical.
  const add = (label, body) => hash.update(`${label}\u0000${body}\u0000`);

  const walk = (dir, prefix) => {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(full, rel);
      else add(rel, fs.readFileSync(full, 'utf8'));
    }
  };

  walk(path.join(repoRoot, 'dist'), 'dist');
  for (const file of TOP_LEVEL_INPUTS) {
    const full = path.join(repoRoot, file);
    if (fs.existsSync(full)) add(file, fs.readFileSync(full, 'utf8'));
  }

  return hash.digest('hex');
}
