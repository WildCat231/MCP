/**
 * Optional credentials and graceful degradation.
 *
 * The behaviour under test is that a missing or refused PatentsView key
 * *shrinks* what the server can answer rather than failing the call — and that
 * the resulting gap is never mistakable for "there are no patents".
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  availabilityOf,
  clearCredentialRejections,
  credentialHeaders,
  credentialReport,
  credentialValue,
  noteCredentialRejected,
} from '../dist/credentials.js';
import { searchPatents } from '../dist/sources/patentsview.js';

const ENV_VAR = 'PATENTSVIEW_API_KEY';

// Must await `fn`: a sync finally would restore the environment before an
// async body had finished reading it.
async function withEnv(value, fn) {
  const previous = process.env[ENV_VAR];
  if (value === undefined) delete process.env[ENV_VAR];
  else process.env[ENV_VAR] = value;
  clearCredentialRejections();
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = previous;
    clearCredentialRejections();
  }
}

/** A fetch stub that always answers the same way. */
function stubFetch(status, body = '{}') {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} });
    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
  };
  fn.calls = calls;
  return fn;
}

test('registries with no credential are always available', async () => {
  const availability = availabilityOf('openfda_device');
  assert.equal(availability.available, true);
  assert.equal(availability.credential, 'not_applicable');
});

test('an absent key still leaves the registry available to attempt', async () => {
  // The requirement is recorded as unknown, so refusing to try would be
  // asserting something that was never observed.
  await withEnv(undefined, () => {
    const availability = availabilityOf('patentsview');
    assert.equal(availability.available, true);
    assert.equal(availability.credential, 'absent');
    assert.equal(credentialValue('patentsview'), undefined);
    assert.deepEqual(credentialHeaders('patentsview'), {});
  });
});

test('a present key is sent in the documented header', async () => {
  await withEnv('secret-key-value', () => {
    assert.equal(availabilityOf('patentsview').credential, 'supplied');
    assert.deepEqual(credentialHeaders('patentsview'), { 'X-Api-Key': 'secret-key-value' });
  });
});

test('whitespace-only keys count as absent', async () => {
  await withEnv('   ', () => {
    assert.equal(credentialValue('patentsview'), undefined);
    assert.equal(availabilityOf('patentsview').credential, 'absent');
  });
});

test('the credential report never leaks the key value', async () => {
  // Tool output lands in a model context and from there into transcripts.
  await withEnv('super-secret-do-not-print', () => {
    const serialized = JSON.stringify(credentialReport());
    assert.ok(!serialized.includes('super-secret-do-not-print'));
    assert.ok(serialized.includes('PATENTSVIEW_API_KEY'), 'the variable name is safe and useful');
  });
});

test('401 without a key proves the requirement and says so plainly', async () => {
  // 401 is the one status that settles PatentsView's open question, so it is
  // the one place the instruction is stated as fact rather than hedged.
  await withEnv(undefined, async () => {
    const fetch = stubFetch(401, '{"error":"API key required"}');
    const result = await searchPatents({ text: 'surgical robot' }, {}, { fetch });

    assert.equal(result.skipped, true, 'skipped, not errored');
    assert.equal(result.error, undefined, 'a missing credential is a gap, not a failure');
    assert.ok(result.warning.includes('PATENTSVIEW_API_KEY'), 'the warning says how to fix it');
    assert.match(result.warning, /requires an API key/);
    assert.deepEqual(result.records, []);
    assert.equal(result.availability.available, false);
    assert.equal(result.availability.reason, 'credential_missing_and_required');
  });
});

test('the four refusal reasons are all distinct', async () => {
  const seen = new Map();
  for (const [status, key] of [
    [401, undefined],
    [401, 'k'],
    [403, undefined],
    [403, 'k'],
  ]) {
    await withEnv(key, async () => {
      const result = await searchPatents({ text: 'x' }, {}, { fetch: stubFetch(status, '{}') });
      seen.set(`${status}:${key === undefined ? 'nokey' : 'key'}`, result.availability.reason);
    });
  }

  assert.deepEqual(Object.fromEntries(seen), {
    '401:nokey': 'credential_missing_and_required',
    '401:key': 'credential_rejected',
    '403:nokey': 'access_forbidden',
    '403:key': 'credential_insufficient',
  });
  assert.equal(new Set(seen.values()).size, 4, 'each combination must be separately diagnosable');
});

test('401 with a key means the key itself is bad', async () => {
  await withEnv('a-wrong-key', async () => {
    const fetch = stubFetch(401, '{"error":"invalid api key"}');
    const result = await searchPatents({ text: 'surgical robot' }, {}, { fetch });

    assert.equal(result.skipped, true);
    assert.equal(result.availability.reason, 'credential_rejected');
    assert.match(result.warning, /wrong, expired, or revoked/);
  });
});

test('403 with a key is insufficient permission, not a bad key', async () => {
  // Authenticated and still refused: scope, plan, or quota. Telling the user
  // their key is wrong would send them to regenerate a key that works fine.
  await withEnv('a-valid-but-limited-key', async () => {
    const fetch = stubFetch(403, '{"error":"quota exceeded"}');
    const result = await searchPatents({ text: 'surgical robot' }, {}, { fetch });

    assert.equal(result.skipped, true);
    assert.equal(result.availability.reason, 'credential_insufficient');
    assert.match(result.warning, /scope, plan, or quota/);
    assert.ok(!/wrong, expired, or revoked/.test(result.warning), 'must not blame the key');
  });
});

test('403 without a key does NOT claim a key is required', async () => {
  // This is the distinction the whole 401/403 split exists for. A 403 with no
  // credential is ambiguous — IP block, geo restriction, exhausted anonymous
  // quota — and asserting "requires an API key" would be a guess dressed as a
  // diagnosis.
  await withEnv(undefined, async () => {
    const fetch = stubFetch(403, '{"error":"forbidden"}');
    const result = await searchPatents({ text: 'surgical robot' }, {}, { fetch });

    assert.equal(result.skipped, true);
    assert.equal(result.availability.reason, 'access_forbidden');
    assert.ok(
      !/requires an API key/.test(result.warning),
      'a 403 does not establish that a key would have helped',
    );
    assert.match(result.warning, /IP block|geo restriction|quota/, 'the other causes are named');
    assert.match(result.warning, /PATENTSVIEW_API_KEY/, 'trying a key is still suggested');
  });
});

test('after a refusal the endpoint is not asked again', async () => {
  // Hammering an endpoint that has already said no is both rude and pointless.
  await withEnv(undefined, async () => {
    const fetch = stubFetch(401);
    await searchPatents({ text: 'first' }, {}, { fetch });
    assert.equal(fetch.calls.length, 1);

    const second = await searchPatents({ text: 'second' }, {}, { fetch });
    assert.equal(fetch.calls.length, 1, 'no second request');
    assert.equal(second.skipped, true);
    assert.ok(second.warning.length > 0, 'still explains itself');
  });
});

test('rejections are per-process, so adding a key and restarting recovers', async () => {
  await withEnv(undefined, () => {
    noteCredentialRejected('patentsview', 'test');
    assert.equal(availabilityOf('patentsview').available, false);
    clearCredentialRejections();
    assert.equal(availabilityOf('patentsview').available, true);
  });
});

test('a keyless success is honoured — the endpoint may simply be open', async () => {
  // If PatentsView turns out not to require a key, nothing here penalizes that.
  await withEnv(undefined, async () => {
    const body = JSON.stringify({
      patents: [
        {
          patent_id: '5397323',
          patent_title: 'Remote center-of-motion robot for surgery',
          patent_date: '1995-03-14',
          assignees: [{ assignee_organization: 'IBM' }],
          inventors: [{ inventor_name_first: 'Russell', inventor_name_last: 'Taylor' }],
        },
      ],
      total_hits: 1,
    });
    const fetch = stubFetch(200, body);
    const result = await searchPatents({ text: 'surgical robot' }, {}, { fetch });

    assert.equal(result.skipped, undefined);
    assert.equal(result.error, undefined);
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].patent_number, '5397323');
    assert.equal(result.records[0].grant_date, '1995-03-14');
    assert.deepEqual(fetch.calls[0].headers['X-Api-Key'], undefined, 'no key was sent');
  });
});

test('a genuine outage is an error, not a credential skip', async () => {
  // These must stay distinguishable: one is fixable by setting a variable, the
  // other is not.
  await withEnv('a-key', async () => {
    const fetch = stubFetch(503, 'upstream unavailable');
    const result = await searchPatents({ text: 'surgical robot' }, {}, { fetch });

    assert.equal(result.skipped, undefined);
    assert.ok(result.error.includes('503'));
    assert.equal(result.availability.available, true, 'the credential is not implicated');
  });
});
