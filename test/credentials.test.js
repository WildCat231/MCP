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

test('a 401 degrades this registry only, as a skip with a warning', async () => {
  await withEnv(undefined, async () => {
    const fetch = stubFetch(401, '{"error":"API key required"}');
    const result = await searchPatents({ text: 'surgical robot' }, {}, { fetch });

    assert.equal(result.skipped, true, 'skipped, not errored');
    assert.equal(result.error, undefined, 'a missing credential is a gap, not a failure');
    assert.ok(result.warning.includes('PATENTSVIEW_API_KEY'), 'the warning says how to fix it');
    assert.deepEqual(result.records, []);
    assert.equal(result.availability.available, false);
    assert.equal(result.availability.reason, 'credential_missing_and_required');
  });
});

test('a 403 with a key present is reported as the key being rejected', async () => {
  await withEnv('a-wrong-key', async () => {
    const fetch = stubFetch(403, '{"error":"forbidden"}');
    const result = await searchPatents({ text: 'surgical robot' }, {}, { fetch });

    assert.equal(result.skipped, true);
    assert.equal(result.availability.reason, 'credential_rejected');
    assert.ok(result.warning.includes('rejected'));
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
