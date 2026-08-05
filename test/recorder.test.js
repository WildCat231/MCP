/**
 * Guards the fixture recorder's raw-capture invariant.
 *
 * The recorder must write upstream response bodies verbatim. If it ever
 * imported a parse function and stored normalized output, the fixture-replay
 * tests would be checking each parser against its own output and would pass no
 * matter how wrong the field mapping was — which is precisely the failure the
 * fixtures exist to prevent, and precisely the failure that would be invisible
 * once it happened.
 *
 * This is a static check on the script's source. That is deliberate: the
 * property being protected is "this file does not do X", and no runtime test
 * of a network script can establish that offline.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const recorderPath = path.join(repoRoot, 'scripts', 'record-fixtures.mjs');
const source = fs.readFileSync(recorderPath, 'utf8');

/** Bindings pulled out of dist/, ignoring anything inside a comment. */
function importedBindings() {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const bindings = [];
  for (const match of withoutComments.matchAll(/const\s*\{([^}]+)\}\s*=\s*await\s+dist\(/g)) {
    for (const name of match[1].split(',')) {
      const trimmed = name.trim();
      if (trimmed !== '') bindings.push(trimmed);
    }
  }
  return bindings;
}

test('the recorder imports only URL builders and transport helpers', async () => {
  const bindings = importedBindings();
  assert.ok(bindings.length > 0, 'the static analysis should find the imports it is checking');

  const allowed = new Set([
    // URL construction — the only adapter code the recorder legitimately needs.
    'arxivUrl',
    'crossrefSearchUrl',
    'crossrefDoiUrl',
    'esearchUrl',
    'esummaryUrl',
    'clearanceSearchUrl',
    'approvalSearchUrl',
    'summaryUrl',
    'patentsviewUrl',
    // Transport and politeness.
    'HOST_LIMITS',
    'DEFAULT_HOST_LIMIT',
    'RateLimiter',
    'USER_AGENT',
    'credentialHeaders',
  ]);

  for (const binding of bindings) {
    assert.ok(allowed.has(binding), `recorder imports "${binding}", which is not an allowed binding`);
  }
});

test('the recorder imports no parser', async () => {
  // The specific regression this file exists to catch.
  for (const binding of importedBindings()) {
    assert.ok(!/^parse/.test(binding), `recorder must not import parser "${binding}"`);
    assert.ok(!/^to[A-Z]/.test(binding), `recorder must not import normalizer "${binding}"`);
  }
});

test('the response body is written without re-serialization', async () => {
  // JSON.parse/stringify round-tripping would reorder keys and reformat
  // numbers, quietly destroying the evidence.
  assert.ok(
    /await fs\.writeFile\(file, body\)/.test(source),
    'the body must be written exactly as received',
  );
  assert.ok(
    !/writeFile\(file,[^)]*JSON\.(parse|stringify)/.test(source),
    'the fixture body must never be re-serialized',
  );
});

test('the recorder stores a digest so tampering is detectable', async () => {
  assert.ok(/sha256/.test(source), 'meta should carry a digest of the recorded bytes');
  assert.ok(/bytes:/.test(source), 'meta should carry the byte count');
});

test('request headers are never written to the fixture metadata', async () => {
  // The PatentsView recording would otherwise carry the API key into the repo.
  // Comments stripped first — the block carries a comment explaining *why* no
  // headers are stored, and matching on that would defeat the check.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const metaBlock = /await fs\.writeFile\(\s*meta,[\s\S]*?\n  \);/.exec(code)?.[0] ?? '';
  assert.ok(metaBlock.length > 0, 'the metadata write should be findable');

  // `response.headers` is fine — those came back from the server and carry no
  // secret. What must never appear is anything we *sent*.
  const requestSide = metaBlock.replace(/response\.headers/g, '');
  assert.ok(!/headers/.test(requestSide), 'metadata must not record request headers');
  assert.ok(!/credentialHeaders/.test(metaBlock), 'metadata must not record credentials');
  assert.ok(!/api[_-]?key/i.test(metaBlock), 'metadata must not record a key under any spelling');
  assert.ok(!/\binit\b|\bAuthorization\b/i.test(metaBlock), 'metadata must not record the request init');
});

test('XML responses are not stored under a .json extension', async () => {
  assert.ok(/extensionFor/.test(source), 'the extension should follow the payload');
  assert.ok(
    /xml/.test(source),
    'arXiv returns Atom; storing it as .json would mislead every reader that trusts the suffix',
  );
});
