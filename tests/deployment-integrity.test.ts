import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {
  deploymentProblems,
  fetchWithRetry,
  parseOptions,
  readExpectedDeployment,
  readObservedDeployment,
  reviewedTreeProblems,
  runCli,
  type DeploymentTarget,
  type ExpectedDeployment,
  type FetchLike,
  type FetchResponse,
  type GitRunner,
  type ObservedDeployment,
  type ObservedFunction,
} from '../deployment-integrity.ts';

const COMMIT = 'a'.repeat(40);
const RULES = 'rules_version = "2";\n';
const INDEX = '<!doctype html><title>reviewed</title>\n';
const GENERATED_HASH = 'b'.repeat(64);
const FIREBASE_JSON = {
  hosting: {
    site: 'test-project',
    public: 'public',
    headers: [{
      source: '**',
      headers: [{key: 'Cache-Control', value: 'no-cache'}],
    }],
    redirects: [{source: '/old', destination: '/new', type: 301}],
    rewrites: [{source: '**', destination: '/index.html'}],
  },
};
const HOSTING_CONFIG = {
  headers: [{glob: '**', headers: {'Cache-Control': 'no-cache'}}],
  redirects: [{glob: '/old', statusCode: 301, location: '/new'}],
  rewrites: [{glob: '**', path: '/index.html'}],
};

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const expectedFunction = {
  name: 'booksapi-lookupisbn',
  generation: 'GEN_1' as const,
  region: 'europe-west1',
  entryPoint: 'booksapi.lookupisbn',
  access: 'callable' as const,
  timeoutSeconds: 60,
  maxInstances: null,
  serviceAccount: 'test-project@appspot.gserviceaccount.com',
  secrets: [{
    key: 'FUNCTIONS_CONFIG_EXPORT',
    projectId: '123456789',
    secret: 'FUNCTIONS_CONFIG_EXPORT',
    version: '2',
  }],
  publicInvoker: true,
  invokers: ['roles/cloudfunctions.invoker:allUsers'],
  event: null,
};

const target: DeploymentTarget = {
  projectId: 'test-project',
  projectNumber: '123456789',
  releaseId: 'reviewed-release',
  hostingSite: 'test-project',
  hostingOrigins: ['https://test-project.web.app'],
  allowedGeneratedHostingFiles: ['__/firebase/init.js'],
  allowedUntrackedPrefixes: ['ideas/'],
  functions: [expectedFunction],
};

const expected: ExpectedDeployment = {
  target,
  firestoreRulesSha256: hash(RULES),
  indexes: [],
  ttls: [],
  hostingFiles: {'index.html': hash(INDEX)},
  hostingConfig: HOSTING_CONFIG,
};

const currentFunction: ObservedFunction = {
  ...expectedFunction,
  releaseId: 'reviewed-release',
  state: 'ACTIVE',
  allTrafficOnLatestRevision: null,
};

function currentObserved(): ObservedDeployment {
  return {
    firestoreRulesSha256: expected.firestoreRulesSha256,
    indexes: [],
    ttls: [],
    functions: [currentFunction],
    hosting: {
      files: {'https://test-project.web.app': {...expected.hostingFiles}},
      activeVersionFiles: {
        'index.html': hash(INDEX),
        '__/firebase/init.js': GENERATED_HASH,
      },
      activeVersionConfig: structuredClone(HOSTING_CONFIG),
      profileReleaseIds: {'https://test-project.web.app': 'reviewed-release'},
      sitemapReleaseIds: {'https://test-project.web.app': 'reviewed-release'},
    },
  };
}

test('rejects recently redeployed vulnerable artifacts and configuration', () => {
  const vulnerable = currentObserved();
  vulnerable.firestoreRulesSha256 = hash('allow read, write: if true;');
  vulnerable.indexes = [{
    collectionGroup: 'books',
    queryScope: 'COLLECTION',
    fields: [{fieldPath: 'finished', order: 'ASCENDING'}],
  }];
  vulnerable.ttls = [{collectionGroup: 'logEvents', fieldPath: 'expiresAt'}];
  vulnerable.functions = [
    {
      ...currentFunction,
      releaseId: 'old-vulnerable-code',
      state: 'ACTIVE',
      publicInvoker: false,
      secrets: [],
    },
    {
      ...currentFunction,
      name: 'searchisbn',
      region: 'us-central1',
    },
  ];
  vulnerable.hosting.files['https://test-project.web.app']['index.html'] = hash('stale');
  vulnerable.hosting.activeVersionFiles['backdoor.txt'] = hash('backdoor');
  vulnerable.hosting.activeVersionConfig.rewrites = [];
  vulnerable.hosting.profileReleaseIds['https://test-project.web.app'] = 'old';
  vulnerable.hosting.sitemapReleaseIds['https://test-project.web.app'] = 'old';

  assert.deepEqual(deploymentProblems(expected, vulnerable), [
    'Firestore rules do not match the reviewed commit',
    'Firestore indexes do not match the reviewed commit',
    'Firestore TTL policies do not match the reviewed commit',
    'Active Hosting version has unexpected or missing files',
    'Active Hosting configuration does not match the reviewed commit',
    'Unexpected function: us-central1/searchisbn',
    'Function release mismatch: europe-west1/booksapi-lookupisbn',
    'Function configuration mismatch: europe-west1/booksapi-lookupisbn',
    'Hosting files do not match the reviewed commit: https://test-project.web.app',
    'Profile rewrite release mismatch: https://test-project.web.app',
    'Sitemap rewrite release mismatch: https://test-project.web.app',
  ]);
});

test('accepts one coherent deployment of the reviewed commit', () => {
  assert.deepEqual(deploymentProblems(expected, currentObserved()), []);
});

test('reports a leftover same-name function in another region', () => {
  const observed = currentObserved();
  observed.functions.push({...currentFunction, region: 'us-central1'});
  assert.deepEqual(deploymentProblems(expected, observed), [
    'Unexpected function: us-central1/booksapi-lookupisbn',
  ]);
});

test('rejects an unreviewed private function invoker', () => {
  const observed = currentObserved();
  observed.functions[0] = {
    ...observed.functions[0],
    invokers: [
      ...observed.functions[0].invokers,
      'roles/cloudfunctions.invoker:user:attacker@example.test',
    ],
  };
  assert.deepEqual(deploymentProblems(expected, observed), [
    'Function configuration mismatch: europe-west1/booksapi-lookupisbn',
  ]);
});

interface MockReply {
  status?: number;
  json?: unknown;
  body?: string;
  headers?: Record<string, string>;
}

function response(reply: MockReply): FetchResponse {
  const status = reply.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => reply.headers?.[name.toLowerCase()] ?? null,
    },
    json: async () => reply.json,
    arrayBuffer: async () => new TextEncoder().encode(reply.body ?? '').buffer,
  };
}

function apiFixture(overrides = new Map<string, MockReply>()): {
  fetch: FetchLike;
  calls: Array<{url: string; authorization?: string; signal?: AbortSignal}>;
} {
  const ruleset = 'projects/test-project/rulesets/current';
  const replies = new Map<string, MockReply>([
    [
      'https://firebaserules.googleapis.com/v1/projects/test-project/releases/cloud.firestore',
      {json: {rulesetName: ruleset}},
    ],
    [
      `https://firebaserules.googleapis.com/v1/${ruleset}`,
      {json: {source: {files: [{name: 'firestore.rules', content: RULES}]}}},
    ],
    [
      'https://cloudfunctions.googleapis.com/v2/projects/test-project/locations/-/functions',
      {json: {
        functions: [{
          name: 'projects/test-project/locations/europe-west1/functions/booksapi-lookupisbn',
          state: 'ACTIVE',
          buildConfig: {entryPoint: 'booksapi.lookupisbn'},
          serviceConfig: {
            timeoutSeconds: 60,
            serviceAccountEmail: 'test-project@appspot.gserviceaccount.com',
            secretEnvironmentVariables: [{
              key: 'FUNCTIONS_CONFIG_EXPORT',
              projectId: '123456789',
              secret: 'FUNCTIONS_CONFIG_EXPORT',
              version: '2',
            }],
          },
          labels: {
            'book-tracker-release': 'reviewed-release',
            'deployment-callable': 'true',
          },
        }],
        nextPageToken: '',
      }},
    ],
    [
      'https://cloudfunctions.googleapis.com/v2/projects/test-project/locations/europe-west1/functions/booksapi-lookupisbn:getIamPolicy',
      {json: {bindings: [{role: 'roles/cloudfunctions.invoker', members: ['allUsers']}]}},
    ],
    [
      'https://firestore.googleapis.com/v1/projects/test-project/databases/(default)/collectionGroups/-/indexes',
      {json: {indexes: []}},
    ],
    [
      'https://firestore.googleapis.com/v1/projects/test-project/databases/(default)/collectionGroups/-/fields?filter=ttlConfig%3A*',
      {json: {fields: []}},
    ],
    [
      'https://firebasehosting.googleapis.com/v1beta1/sites/test-project/channels/live/releases?pageSize=1',
      {json: {releases: [{
        name: 'sites/test-project/channels/live/releases/123',
        type: 'DEPLOY',
        version: {
          name: 'sites/test-project/versions/version1',
          status: 'FINALIZED',
          fileCount: '2',
          config: HOSTING_CONFIG,
        },
      }]}},
    ],
    [
      'https://firebasehosting.googleapis.com/v1beta1/sites/test-project/versions/version1/files?pageSize=1000&status=ACTIVE',
      {json: {files: [
        {path: '/index.html', hash: hash(INDEX), status: 'ACTIVE'},
        {path: '/__/firebase/init.js', hash: GENERATED_HASH, status: 'ACTIVE'},
      ]}},
    ],
    ['https://test-project.web.app/index.html', {body: INDEX}],
    [
      'https://test-project.web.app/profiles/__deployment_integrity_probe__',
      {status: 404, headers: {'x-book-tracker-release': 'reviewed-release'}},
    ],
    [
      'https://test-project.web.app/sitemap.xml',
      {body: '<urlset/>', headers: {'x-book-tracker-release': 'reviewed-release'}},
    ],
    ...overrides,
  ]);
  const calls: Array<{url: string; authorization?: string; signal?: AbortSignal}> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({
      url,
      authorization: init?.headers?.Authorization,
      signal: init?.signal,
    });
    assert.equal(replies.has(url), true, `unexpected URL ${url}`);
    return response(replies.get(url)!);
  };
  return {fetch, calls};
}

test('reads live APIs, stops on an empty page token, and withholds credentials from Hosting', async () => {
  const fixture = apiFixture();
  const observed = await readObservedDeployment(fixture.fetch, expected, 'dummy-token');
  assert.deepEqual(deploymentProblems(expected, observed), []);
  assert.equal(
    fixture.calls.filter((call) => call.url.includes('/locations/-/functions')).length,
    1,
  );
  for (const call of fixture.calls) {
    assert.ok(call.signal instanceof AbortSignal);
    if (call.url.startsWith('https://test-project.web.app')) {
      assert.equal(call.authorization, undefined);
    } else {
      assert.equal(call.authorization, 'Bearer dummy-token');
    }
  }
});

test('fails closed on unreachable locations and malformed ruleset payloads', async () => {
  const unreachable = apiFixture(new Map([[
    'https://cloudfunctions.googleapis.com/v2/projects/test-project/locations/-/functions',
    {json: {functions: [], unreachable: ['us-central1']}},
  ]]));
  await assert.rejects(
    readObservedDeployment(unreachable.fetch, expected, 'dummy-token'),
    /Expected values to be strictly deep-equal/,
  );

  const wrongRuleset = apiFixture(new Map([[
    'https://firebaserules.googleapis.com/v1/projects/test-project/releases/cloud.firestore',
    {json: {rulesetName: 'projects/another-project/rulesets/current'}},
  ]]));
  await assert.rejects(
    readObservedDeployment(wrongRuleset.fetch, expected, 'dummy-token'),
    /did not match/,
  );

  const suffixFile = apiFixture(new Map([[
    'https://firebaserules.googleapis.com/v1/projects/test-project/rulesets/current',
    {json: {source: {files: [{name: 'evil-firestore.rules', content: RULES}]}}},
  ]]));
  await assert.rejects(
    readObservedDeployment(suffixFile.fetch, expected, 'dummy-token'),
    /0 !== 1/,
  );

  const wrongFunctionProject = apiFixture(new Map([[
    'https://cloudfunctions.googleapis.com/v2/projects/test-project/locations/-/functions',
    {json: {functions: [{
      name: 'projects/another-project/locations/europe-west1/functions/booksapi-lookupisbn',
    }]}},
  ]]));
  await assert.rejects(
    readObservedDeployment(wrongFunctionProject.fetch, expected, 'dummy-token'),
    /another-project/,
  );

  const wrongIndexProject = apiFixture(new Map([[
    'https://firestore.googleapis.com/v1/projects/test-project/databases/(default)/collectionGroups/-/indexes',
    {json: {indexes: [{
      name: 'projects/another-project/databases/(default)/collectionGroups/books/indexes/one',
      state: 'READY',
      queryScope: 'COLLECTION',
      fields: [],
    }]}},
  ]]));
  await assert.rejects(
    readObservedDeployment(wrongIndexProject.fetch, expected, 'dummy-token'),
    /another-project/,
  );

  const conditionalPublicInvoker = apiFixture(new Map([[
    'https://cloudfunctions.googleapis.com/v2/projects/test-project/locations/europe-west1/functions/booksapi-lookupisbn:getIamPolicy',
    {json: {bindings: [{
      role: 'roles/cloudfunctions.invoker',
      members: ['allUsers'],
      condition: {expression: 'request.time < timestamp("2030-01-01T00:00:00Z")'},
    }]}},
  ]]));
  await assert.rejects(
    readObservedDeployment(conditionalPublicInvoker.fetch, expected, 'dummy-token'),
    /conditional invoker is unsupported/,
  );
});

test('retries transient API failures and rejects permanent failures', async () => {
  let attempts = 0;
  const transient: FetchLike = async () => {
    attempts += 1;
    return response(attempts === 1 ? {status: 503} : {json: {ok: true}});
  };
  const result = await fetchWithRetry(transient, 'https://example.test', undefined);
  assert.equal(result.status, 200);
  assert.equal(attempts, 2);

  const forbidden: FetchLike = async () => response({status: 403});
  await assert.rejects(
    fetchWithRetry(forbidden, 'https://example.test', undefined),
    /returned HTTP 403/,
  );
});

function gitFixture(status = '', head = COMMIT, pushed = COMMIT): GitRunner {
  const files = new Map<string, Buffer>([
    [`show ${COMMIT}:deployment-target.json`, Buffer.from(JSON.stringify(target))],
    [`show ${COMMIT}:firebase.json`, Buffer.from(JSON.stringify(FIREBASE_JSON))],
    [`show ${COMMIT}:firestore.indexes.json`, Buffer.from(JSON.stringify({
      indexes: [], fieldOverrides: [],
    }))],
    [`show ${COMMIT}:firestore.rules`, Buffer.from(RULES)],
    [`show ${COMMIT}:hosting-artifacts.json`, Buffer.from(JSON.stringify({
      version: 1,
      files: {'index.html': hash(INDEX)},
    }))],
    ['rev-parse HEAD', Buffer.from(`${head}\n`)],
    ['rev-parse origin/master', Buffer.from(`${pushed}\n`)],
    ['status --porcelain=v1 -z --untracked-files=all', Buffer.from(status)],
  ]);
  return (arguments_) => {
    const key = arguments_.join(' ');
    assert.equal(files.has(key), true, `unexpected git command: ${key}`);
    return files.get(key)!;
  };
}

test('reads every expected artifact from the reviewed commit', () => {
  assert.deepEqual(readExpectedDeployment(COMMIT, gitFixture()), expected);
});

test('rejects a mismatched commit and dirty deploy inputs while allowing reviewed notes', () => {
  assert.deepEqual(reviewedTreeProblems(COMMIT, target, gitFixture('', 'b'.repeat(40))), [
    'HEAD is not the reviewed commit',
  ]);
  assert.deepEqual(reviewedTreeProblems(COMMIT, target, gitFixture(' M firestore.rules\0')), [
    'Unreviewed working-tree change:  M firestore.rules',
  ]);
  assert.deepEqual(reviewedTreeProblems(COMMIT, target, gitFixture('?? ideas/note.md\0')), []);
});

test('rejects unknown, empty, duplicate, and obsolete timestamp arguments', () => {
  assert.throws(() => parseOptions(['--deployed-after=2026-08-25T21:00:00Z']), /unknown argument/);
  assert.throws(() => parseOptions(['--commit=']), /requires a value/);
  assert.throws(() => parseOptions(['--project=first', '--project=second']), /duplicate argument/);
});

test('runCli returns distinct success and dirty-tree failure codes', async () => {
  const fixture = apiFixture();
  const output: string[] = [];
  const errors: string[] = [];
  const success = await runCli(
    [`--commit=${COMMIT}`, '--project=test-project'],
    {
      root: process.cwd(),
      runGit: gitFixture(),
      fetch: fixture.fetch,
      accessToken: () => 'dummy-token',
      stdout: (message) => output.push(message),
      stderr: (message) => errors.push(message),
    },
  );
  assert.equal(success, 0);
  assert.match(output.join(''), /Deployment matches reviewed commit/);
  assert.equal(errors.length, 0);

  const failure = await runCli(
    [`--commit=${COMMIT}`],
    {
      root: process.cwd(),
      runGit: gitFixture(' M firestore.rules\0'),
      fetch: async () => assert.fail('dirty tree must fail before fetch'),
      accessToken: () => assert.fail('dirty tree must fail before credentials'),
      stdout: (message) => output.push(message),
      stderr: (message) => errors.push(message),
    },
  );
  assert.equal(failure, 1);
  assert.match(errors.join(''), /Unreviewed working-tree change/);
});

test('the production CLI executes even through a symlinked path', () => {
  const directory = mkdtempSync(join(tmpdir(), 'book-tracker-release-cli-'));
  const link = join(directory, 'verify-release.ts');
  symlinkSync(new URL('../deployment-integrity-cli.ts', import.meta.url), link);
  const result = spawnSync(process.execPath, [link], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing --commit/);
});
