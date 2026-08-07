/**
 * Guards the recorded fixtures themselves.
 *
 * A fixture is only worth having if it is a real answer. A rate-limit page
 * saved as `gdelt-surgical-robotics.json` looks exactly like a recording, and
 * a replay test against it validates the parser against an error page and
 * passes — proving nothing while reporting success. That happened, which is
 * why these checks exist as tests rather than as a note in the recorder.
 *
 * The recorder now refuses to write a refusal, but a fixture recorded before
 * that change is already on disk, so the guard has to run over what is
 * committed rather than only over what is being written.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Every fixture that has a `.meta.json`, paired with its recorded body. */
function recordedFixtures() {
  if (!fs.existsSync(fixturesDir)) return [];
  return fs
    .readdirSync(fixturesDir)
    .filter((f) => f.endsWith('.meta.json'))
    .map((f) => {
      const name = f.replace(/\.meta\.json$/, '');
      const meta = JSON.parse(fs.readFileSync(path.join(fixturesDir, f), 'utf8'));
      const body = ['json', 'xml', 'html']
        .map((ext) => path.join(fixturesDir, `${name}.${ext}`))
        .find((p) => fs.existsSync(p));
      return { name, meta, bodyPath: body };
    });
}

/** Statuses that mean "not now" rather than "no". Mirrors the recorder. */
const REFUSAL = (status) => status === 408 || status === 425 || status === 429 || status >= 500;

test('no fixture is a rate limit or an outage page', async () => {
  // The specific regression: a GDELT 429 was committed as a recording.
  const refused = recordedFixtures().filter((f) => REFUSAL(f.meta.status));

  assert.deepEqual(
    refused.map((f) => `${f.name} (HTTP ${f.meta.status})`),
    [],
    'A refusal is not a result. Delete these fixtures and their .meta.json, then re-record when the ' +
      'service is willing to answer. Until then the affected adapter is UNVALIDATED, not tested.',
  );
});

test('every recorded status is one the adapter is meant to handle', async () => {
  // 2xx is a result. 404 is openFDA saying "no matches" and Wikipedia saying
  // "no such article". 401/403 is PatentsView saying "you need a key". Nothing
  // else is data.
  const allowed = new Set([401, 403, 404]);
  for (const fixture of recordedFixtures()) {
    const status = fixture.meta.status;
    const ok = (status >= 200 && status < 300) || allowed.has(status);
    assert.ok(
      ok,
      `${fixture.name} was recorded with HTTP ${status}, which is neither a success nor a documented ` +
        'result-bearing error. Re-record it or delete it.',
    );
  }
});

test('every fixture body matches the digest recorded with it', async () => {
  // Detects a hand-edited fixture, which would silently become the parser's
  // expected input.
  for (const fixture of recordedFixtures()) {
    assert.ok(fixture.bodyPath, `${fixture.name} has metadata but no recorded body`);
    const body = fs.readFileSync(fixture.bodyPath);

    if (typeof fixture.meta.sha256 === 'string') {
      assert.equal(
        createHash('sha256').update(body).digest('hex'),
        fixture.meta.sha256,
        `${fixture.name} does not match its recorded digest — it has been edited since recording`,
      );
    }
    if (typeof fixture.meta.bytes === 'number') {
      assert.equal(body.byteLength, fixture.meta.bytes, `${fixture.name} byte count differs from its metadata`);
    }
  }
});

test('a JSON fixture actually parses as JSON', async () => {
  // An error page served with a JSON content type would otherwise sit here
  // looking like data until a replay test read it.
  for (const fixture of recordedFixtures()) {
    if (fixture.bodyPath?.endsWith('.json') !== true) continue;
    const raw = fs.readFileSync(fixture.bodyPath, 'utf8');
    assert.doesNotThrow(
      () => JSON.parse(raw),
      `${fixture.name} is stored as .json but does not parse — it is probably an error page`,
    );
  }
});

test('an HTML fixture is not silently an error page', async () => {
  // A 200 that renders "Too Many Requests" is the case the status check misses.
  for (const fixture of recordedFixtures()) {
    if (fixture.bodyPath?.endsWith('.html') !== true) continue;
    const raw = fs.readFileSync(fixture.bodyPath, 'utf8').slice(0, 4000).toLowerCase();
    for (const marker of ['too many requests', 'rate limit exceeded', 'service unavailable', 'access denied']) {
      assert.ok(!raw.includes(marker), `${fixture.name} looks like an error page: contains "${marker}"`);
    }
  }
});
