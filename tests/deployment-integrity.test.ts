import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deploymentProblems,
  parseOptions,
  readObservedDeployment,
  type ExpectedDeployment,
  type FetchJson,
  type ObservedDeployment,
} from '../deployment-integrity.ts';

const expected: ExpectedDeployment = {
  firestoreRulesSha256: 'current-rules',
  functions: [
    {name: 'booksapi-lookupisbn', generation: 'GEN_1', region: 'europe-west1'},
    {name: 'toggl-clearstopping', generation: 'GEN_1', region: 'europe-west1'},
    {name: 'toggl-syncqueue', generation: 'GEN_2', region: 'europe-west1'},
  ],
  hostingVersion: 'current-hosting',
  deployedAfter: '2026-08-25T20:00:00.000Z',
};

test('rejects the stale deployment that left reviewed controls inactive', () => {
  const vulnerable: ObservedDeployment = {
    firestoreRulesSha256: 'permissive-rules',
    functions: [
      {
        name: 'booksapi-lookupisbn',
        generation: 'GEN_1',
        region: 'europe-west1',
        state: 'FAILED',
        updateTime: '2026-08-24T05:37:56.570Z',
      },
      {
        name: 'searchisbn',
        generation: 'GEN_1',
        region: 'europe-west1',
        state: 'ACTIVE',
        updateTime: '2026-07-01T00:00:00.000Z',
      },
      {
        name: 'toggl-syncqueue',
        generation: 'GEN_1',
        region: 'us-central1',
        state: 'ACTIVE',
        updateTime: '2026-08-25T21:00:00.000Z',
      },
    ],
    hostingVersion: 'stale-hosting',
  };

  assert.deepEqual(deploymentProblems(expected, vulnerable), [
    'Firestore rules do not match the reviewed local rules',
    'Missing function: toggl-clearstopping',
    'Unexpected function: searchisbn',
    'Function generation mismatch: toggl-syncqueue expected GEN_2, observed GEN_1',
    'Function region mismatch: toggl-syncqueue expected europe-west1, observed us-central1',
    'Function is not active: booksapi-lookupisbn observed FAILED',
    'Function predates this release: booksapi-lookupisbn',
    'Hosting version does not match the reviewed local build',
  ]);
});

test('accepts one coherent deployment of the reviewed artifacts', () => {
  const current: ObservedDeployment = {
    firestoreRulesSha256: 'current-rules',
    functions: expected.functions.map((deployedFunction) => ({
      ...deployedFunction,
      state: 'ACTIVE',
      updateTime: '2026-08-25T21:00:00.000Z',
    })),
    hostingVersion: 'current-hosting',
  };

  assert.deepEqual(deploymentProblems(expected, current), []);
});

test('reads paginated deployment APIs without exposing credentials to Hosting', async () => {
  const calls: Array<{url: string; authorization?: string; quotaProject?: string}> = [];
  const responses = new Map<string, unknown>([
    [
      'https://firebaserules.googleapis.com/v1/projects/test-project/releases/cloud.firestore',
      {rulesetName: 'projects/test-project/rulesets/current'},
    ],
    [
      'https://firebaserules.googleapis.com/v1/projects/test-project/rulesets/current',
      {source: {files: [{name: 'firestore.rules', content: 'rules_version = "2";\n'}]}},
    ],
    [
      'https://cloudfunctions.googleapis.com/v2/projects/test-project/locations/-/functions',
      {
        functions: [{
          name: 'projects/test-project/locations/europe-west1/functions/first',
          state: 'ACTIVE',
          updateTime: '2026-08-25T21:00:00.000Z',
        }],
        nextPageToken: 'next page',
      },
    ],
    [
      'https://cloudfunctions.googleapis.com/v2/projects/test-project/locations/-/functions?pageToken=next%20page',
      {functions: [
        {
          name: 'projects/test-project/locations/europe-west1/functions/second',
          state: 'ACTIVE',
          updateTime: '2026-08-25T21:01:00.000Z',
        },
        {
          name: 'projects/test-project/locations/europe-west1/functions/worker',
          environment: 'GEN_2',
          state: 'ACTIVE',
          updateTime: '2026-08-25T21:02:00.000Z',
        },
      ]},
    ],
    ['https://test-project.web.app/_app/version.json', {version: 'safe-build'}],
  ]);
  const fetchJson: FetchJson = async (url, init) => {
    calls.push({
      url,
      authorization: init?.headers?.Authorization,
      quotaProject: init?.headers?.['X-Goog-User-Project'],
    });
    assert.equal(responses.has(url), true, `unexpected URL ${url}`);
    return {
      ok: true,
      status: 200,
      json: async () => responses.get(url),
    };
  };

  const observed = await readObservedDeployment(
    fetchJson,
    'test-project',
    'https://test-project.web.app',
    'dummy-access-token',
  );

  assert.deepEqual(observed, {
    firestoreRulesSha256: 'fe9547d5535fb28181ba8cd8e0c173ac321e126df6a2a2f7368c9d31624abbe4',
    functions: [
      {
        name: 'first', generation: 'GEN_1', region: 'europe-west1', state: 'ACTIVE',
        updateTime: '2026-08-25T21:00:00.000Z',
      },
      {
        name: 'second', generation: 'GEN_1', region: 'europe-west1', state: 'ACTIVE',
        updateTime: '2026-08-25T21:01:00.000Z',
      },
      {
        name: 'worker', generation: 'GEN_2', region: 'europe-west1', state: 'ACTIVE',
        updateTime: '2026-08-25T21:02:00.000Z',
      },
    ],
    hostingVersion: 'safe-build',
  });
  const hostingCall = calls.find((call) => call.url.startsWith('https://test-project.web.app'));
  assert.equal(hostingCall?.authorization, undefined);
  for (const call of calls.filter((value) => value !== hostingCall)) {
    assert.equal(call.authorization, 'Bearer dummy-access-token');
    assert.equal(call.quotaProject, 'test-project');
  }
});

test('rejects misspelled, empty, and duplicate release arguments', () => {
  assert.throws(() => parseOptions(['--deployed-aftr=2026-08-25T21:00:00Z']), /unknown argument/);
  assert.throws(() => parseOptions(['--deployed-after=']), /requires a value/);
  assert.throws(
    () => parseOptions(['--project=first', '--project=second']),
    /duplicate argument/,
  );
  assert.deepEqual(
    parseOptions([
      '--project=test-project',
      '--deployed-after=2026-08-25T21:00:00Z',
    ]),
    new Map([
      ['project', 'test-project'],
      ['deployed-after', '2026-08-25T21:00:00Z'],
    ]),
  );
});
