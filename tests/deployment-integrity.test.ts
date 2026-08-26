import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {gzipSync} from 'node:zlib';
import {zipSync} from 'fflate';
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
const GENERATED = 'generated firebase config';
const PROFILE_PROBE = '<!doctype html><title>Profile not found</title>\n';
const FUNCTION_PACKAGE = '{"name":"dummy-functions"}\n';
const FIREBASE_JSON = {
  hosting: {
    site: 'test-project',
    public: 'public',
    headers: [{
      source: '**',
      headers: [{key: 'Cache-Control', value: 'no-cache'}],
    }],
    redirects: [{source: '/old', destination: '/new', type: 301}],
    rewrites: [
      {
        source: '/profiles/**',
        function: {functionId: 'publicweb', region: 'europe-west1', pinTag: true},
      },
      {source: '**', destination: '/index.html'},
    ],
  },
  functions: {
    source: 'functions',
    disallowLegacyRuntimeConfig: true,
    ignore: [
      'node_modules',
      '.git',
      '.DS_Store',
      '.env*',
      '.secret.*',
      '*.log',
      'src',
      'test',
      'eslint.config.cjs',
      'tsconfig.json',
      '**/*.js.map',
      '**/lib/scripts/**',
    ],
    predeploy: [
      'npm --prefix "$RESOURCE_DIR" run lint',
      'npm --prefix "$RESOURCE_DIR" run build',
    ],
  },
};
const HOSTING_CONFIG = {
  headers: [{glob: '**', headers: {'Cache-Control': 'no-cache'}}],
  redirects: [{glob: '/old', statusCode: 301, location: '/new'}],
  rewrites: [
    {
      glob: '/profiles/**',
      run: {serviceId: 'publicweb', region: 'europe-west1', pinTag: true},
    },
    {glob: '**', path: '/index.html'},
  ],
};
const ACTIVE_HOSTING_CONFIG = {
  headers: HOSTING_CONFIG.headers,
  redirects: HOSTING_CONFIG.redirects,
  rewrites: [
    {
      glob: '/profiles/**',
      run: {serviceId: 'publicweb', region: 'europe-west1', tag: 'fh-version1'},
    },
    {glob: '**', path: '/index.html'},
  ],
};

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function artifact(value: string): {sha256: string; hostingHash: string} {
  return {
    sha256: hash(value),
    hostingHash: createHash('sha256')
      .update(gzipSync(value, {level: 9}))
      .digest('hex'),
  };
}

const FUNCTION_FILES = {'package.json': hash(FUNCTION_PACKAGE)};
const FUNCTION_ARCHIVE = zipSync({
  'package.json': new TextEncoder().encode(FUNCTION_PACKAGE),
});

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
  functionIam: [{role: 'roles/cloudfunctions.invoker', members: ['allUsers']}],
  runIam: null,
  event: null,
};

const expectedGen2Function = {
  name: 'publicweb',
  generation: 'GEN_2' as const,
  region: 'europe-west1',
  entryPoint: 'publicweb',
  access: 'http' as const,
  timeoutSeconds: 30,
  maxInstances: 20,
  serviceAccount: '123456789-compute@developer.gserviceaccount.com',
  secrets: [],
  functionIam: [],
  runIam: [{role: 'roles/run.invoker', members: ['allUsers']}],
  event: null,
};

const target: DeploymentTarget = {
  projectId: 'test-project',
  projectNumber: '123456789',
  releaseId: 'reviewed-release',
  hostingSite: 'test-project',
  hostingOrigins: [
    'https://test-project.web.app',
    'https://test-project.firebaseapp.com',
  ],
  hostingCustomDomains: [],
  generatedHostingFiles: {'__/firebase/init.js': artifact(GENERATED)},
  allowedUntrackedPrefixes: ['ideas/'],
  ancestorResources: ['projects/test-project'],
  ancestorIamPolicySha256: hash('[{"bindings":[],"resource":"projects/test-project"}]'),
  firebaseConfig: {
    projectId: 'test-project',
    databaseURL: 'https://test-project.firebaseio.com',
    storageBucket: 'test-project.firebasestorage.app',
    locationId: 'europe-west',
  },
  functions: [expectedFunction, expectedGen2Function],
};

const expected: ExpectedDeployment = {
  target,
  firestoreRulesSha256: hash(RULES),
  indexes: [],
  ttls: [],
  hostingFiles: {'index.html': artifact(INDEX)},
  functionFiles: FUNCTION_FILES,
  profileProbeSha256: hash(PROFILE_PROBE),
  hostingConfig: HOSTING_CONFIG,
};

const currentFunction: ObservedFunction = {
  ...expectedFunction,
  releaseId: 'reviewed-release',
  state: 'ACTIVE',
  allTrafficOnLatestRevision: null,
  revision: null,
  sourceFiles: FUNCTION_FILES,
  runtime: 'nodejs22',
  buildEnvironmentVariables: {GOOGLE_NODE_RUN_SCRIPTS: ''},
  userEnvironmentVariables: {},
  ingressSettings: 'ALLOW_ALL',
  availableMemory: '256M',
  availableCpu: null,
  maxInstanceRequestConcurrency: 1,
  minInstances: null,
  vpcConnector: null,
  vpcConnectorEgressSettings: null,
  secretVolumes: [],
  securityLevel: 'SECURE_ALWAYS',
  binaryAuthorizationPolicy: null,
  kmsKeyName: null,
  invokerIamDisabled: null,
  dockerRegistry: 'ARTIFACT_REGISTRY',
  dockerRepository: null,
  automaticUpdatePolicy: {},
  buildServiceAccount: null,
  workerPool: null,
  uri: 'https://europe-west1-test-project.cloudfunctions.net/booksapi-lookupisbn',
  serviceResource: null,
  runLatestReadyRevision: null,
  runLatestCreatedRevision: null,
  runConfiguration: null,
};

const RUN_CONFIGURATION = {
  ingress: 'INGRESS_TRAFFIC_ALL',
  customAudiences: ['https://europe-west1-test-project.cloudfunctions.net/publicweb'],
  binaryAuthorization: {},
  iapEnabled: false,
  scaling: {maxInstanceCount: 20},
  template: {
    revision: 'publicweb-00001-test',
    serviceAccount: '123456789-compute@developer.gserviceaccount.com',
    timeout: '30s',
    maxInstanceRequestConcurrency: 80,
    scaling: {maxInstanceCount: 20},
    vpcAccess: {},
    encryptionKey: null,
    sessionAffinity: false,
    executionEnvironment: null,
    gpuZonalRedundancyDisabled: false,
    healthCheckDisabled: false,
    volumes: [],
    containers: [{
      name: 'worker',
      baseImageUri:
        'europe-west1-docker.pkg.dev/serverless-runtimes/google-22-full/runtimes/nodejs22',
      environmentNames: [
        'EVENTARC_CLOUD_EVENT_SOURCE',
        'FIREBASE_CONFIG',
        'FUNCTION_TARGET',
        'GCLOUD_PROJECT',
        'LOG_EXECUTION_ID',
      ],
      resources: {
        limits: {cpu: '1', memory: '256Mi'},
        cpuIdle: true,
        startupCpuBoost: true,
      },
      ports: [{name: 'http1', containerPort: 8080}],
      startupProbe: {
        timeoutSeconds: 240,
        periodSeconds: 240,
        failureThreshold: 1,
        tcpSocket: {port: 8080},
      },
      volumeMounts: [],
    }],
  },
  expectedService: 'projects/test-project/locations/europe-west1/services/publicweb',
};

const RUN_SERVICE_API = {
  name: 'projects/test-project/locations/europe-west1/services/publicweb',
  invokerIamDisabled: false,
  latestReadyRevision:
    'projects/test-project/locations/europe-west1/services/publicweb/revisions/publicweb-00001-test',
  latestCreatedRevision:
    'projects/test-project/locations/europe-west1/services/publicweb/revisions/publicweb-00001-test',
  ingress: 'INGRESS_TRAFFIC_ALL',
  customAudiences: ['https://europe-west1-test-project.cloudfunctions.net/publicweb'],
  binaryAuthorization: {},
  scaling: {maxInstanceCount: 20},
  template: {
    revision: 'publicweb-00001-test',
    serviceAccount: '123456789-compute@developer.gserviceaccount.com',
    timeout: '30s',
    maxInstanceRequestConcurrency: 80,
    scaling: {maxInstanceCount: 20},
    containers: [{
      name: 'worker',
      image: 'europe-west1-docker.pkg.dev/test-project/gcf-artifacts/publicweb:version_1',
      baseImageUri:
        'europe-west1-docker.pkg.dev/serverless-runtimes/google-22-full/runtimes/nodejs22',
      env: [
        {name: 'FIREBASE_CONFIG'},
        {name: 'GCLOUD_PROJECT'},
        {name: 'EVENTARC_CLOUD_EVENT_SOURCE'},
        {name: 'FUNCTION_TARGET'},
        {name: 'LOG_EXECUTION_ID'},
      ],
      resources: {
        limits: {cpu: '1', memory: '256Mi'},
        cpuIdle: true,
        startupCpuBoost: true,
      },
      ports: [{name: 'http1', containerPort: 8080}],
      startupProbe: {
        timeoutSeconds: 240,
        periodSeconds: 240,
        failureThreshold: 1,
        tcpSocket: {port: 8080},
      },
    }],
  },
  traffic: [{tag: 'fh-version1', revision: 'publicweb-00001-test'}],
};

const currentGen2Function: ObservedFunction = {
  ...expectedGen2Function,
  releaseId: 'reviewed-release',
  state: 'ACTIVE',
  allTrafficOnLatestRevision: true,
  revision: 'publicweb-00001-test',
  sourceFiles: FUNCTION_FILES,
  runtime: 'nodejs22',
  buildEnvironmentVariables: {GOOGLE_NODE_RUN_SCRIPTS: ''},
  userEnvironmentVariables: {},
  ingressSettings: 'ALLOW_ALL',
  availableMemory: '256Mi',
  availableCpu: '1',
  maxInstanceRequestConcurrency: 80,
  minInstances: null,
  vpcConnector: null,
  vpcConnectorEgressSettings: null,
  secretVolumes: [],
  securityLevel: null,
  binaryAuthorizationPolicy: null,
  kmsKeyName: null,
  invokerIamDisabled: false,
  dockerRegistry: 'ARTIFACT_REGISTRY',
  dockerRepository: 'projects/test-project/locations/europe-west1/repositories/gcf-artifacts',
  automaticUpdatePolicy: {},
  buildServiceAccount: null,
  workerPool: null,
  uri: 'RUN_APP',
  serviceResource: 'projects/test-project/locations/europe-west1/services/publicweb',
  runLatestReadyRevision: 'publicweb-00001-test',
  runLatestCreatedRevision: 'publicweb-00001-test',
  runConfiguration: RUN_CONFIGURATION,
};

function currentObserved(): ObservedDeployment {
  return {
    firestoreRulesSha256: expected.firestoreRulesSha256,
    indexes: [],
    ttls: [],
    functions: [currentFunction, currentGen2Function],
    ancestorResources: [...target.ancestorResources],
    ancestorIamPolicySha256: target.ancestorIamPolicySha256,
    hosting: {
      files: {'https://test-project.web.app': {
        'index.html': artifact(INDEX).sha256,
        '__/firebase/init.js': artifact(GENERATED).sha256,
      }, 'https://test-project.firebaseapp.com': {
        'index.html': artifact(INDEX).sha256,
        '__/firebase/init.js': artifact(GENERATED).sha256,
      }},
      activeVersionFiles: {
        'index.html': artifact(INDEX).hostingHash,
        '__/firebase/init.js': artifact(GENERATED).hostingHash,
      },
      activeVersionConfig: structuredClone(HOSTING_CONFIG),
      sites: ['test-project'],
      defaultUrl: 'https://test-project.web.app',
      channels: ['live'],
      customDomains: [],
      pinnedRevisions: {'europe-west1/publicweb': 'publicweb-00001-test'},
      profileReleaseIds: {
        'https://test-project.web.app': 'reviewed-release',
        'https://test-project.firebaseapp.com': 'reviewed-release',
      },
      profileProbeSha256: {
        'https://test-project.web.app': hash(PROFILE_PROBE),
        'https://test-project.firebaseapp.com': hash(PROFILE_PROBE),
      },
      sitemapReleaseIds: {
        'https://test-project.web.app': 'reviewed-release',
        'https://test-project.firebaseapp.com': 'reviewed-release',
      },
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
      secrets: [],
    },
    currentGen2Function,
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
    'Active Hosting version files do not match the reviewed commit',
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
    functionIam: [
      ...observed.functions[0].functionIam,
      {role: 'roles/run.admin', members: ['user:attacker@example.test']},
    ],
  };
  assert.deepEqual(deploymentProblems(expected, observed), [
    'Function configuration mismatch: europe-west1/booksapi-lookupisbn',
  ]);
});

test('rejects old Function code carrying the current mutable release label', () => {
  const observed = currentObserved();
  observed.functions[0] = {
    ...observed.functions[0],
    sourceFiles: {'package.json': hash('{"name":"old-vulnerable-code"}\n')},
  };
  assert.deepEqual(deploymentProblems(expected, observed), [
    'Function source does not match the reviewed commit: europe-west1/booksapi-lookupisbn',
  ]);
});

test('rejects dotenv overrides, secret volumes, and weakened service configuration', () => {
  const observed = currentObserved();
  observed.functions[0] = {
    ...observed.functions[0],
    userEnvironmentVariables: {FUNCTIONS_EMULATOR: 'true'},
    ingressSettings: 'ALLOW_INTERNAL_ONLY',
    secretVolumes: [{
      mountPath: '/secrets',
      projectId: '123456789',
      secret: 'FUNCTIONS_CONFIG_EXPORT',
      versions: [{version: 'latest', path: 'token'}],
    }],
  };
  assert.deepEqual(deploymentProblems(expected, observed), [
    'Function configuration mismatch: europe-west1/booksapi-lookupisbn',
  ]);
});

test('rejects altered active Hosting bytes even while the CDN mock serves reviewed bytes', () => {
  const observed = currentObserved();
  observed.hosting.activeVersionFiles['index.html'] = hash('gzip of attacker bytes');
  assert.deepEqual(deploymentProblems(expected, observed), [
    'Active Hosting version files do not match the reviewed commit',
  ]);
});

test('rejects disabled Gen 2 IAM checks and a stale Hosting-pinned revision', () => {
  const observed = currentObserved();
  observed.functions[1] = {
    ...observed.functions[1],
    invokerIamDisabled: true,
    runConfiguration: {
      ...RUN_CONFIGURATION,
      template: {
        ...RUN_CONFIGURATION.template,
        serviceAccount: 'attacker@test-project.iam.gserviceaccount.com',
      },
    },
  };
  observed.hosting.pinnedRevisions['europe-west1/publicweb'] = 'publicweb-00000-old';
  assert.deepEqual(deploymentProblems(expected, observed), [
    'Function configuration mismatch: europe-west1/publicweb',
    'Cloud Run configuration mismatch: europe-west1/publicweb',
    'Hosting does not pin the reviewed Function revision: europe-west1/publicweb',
  ]);
});

interface MockReply {
  status?: number;
  json?: unknown;
  body?: string | Uint8Array;
  headers?: Record<string, string>;
}

function response(reply: MockReply): FetchResponse {
  const status = reply.status ?? 200;
  const body = typeof reply.body === 'string' ?
    new TextEncoder().encode(reply.body) : (reply.body ?? new Uint8Array());
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => reply.headers?.[name.toLowerCase()] ?? null,
    },
    json: async () => reply.json,
    arrayBuffer: async () => body.slice().buffer,
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
          environment: 'GEN_1',
          state: 'ACTIVE',
          buildConfig: {
            entryPoint: 'booksapi.lookupisbn',
            runtime: 'nodejs22',
            environmentVariables: {GOOGLE_NODE_RUN_SCRIPTS: ''},
            dockerRegistry: 'ARTIFACT_REGISTRY',
            automaticUpdatePolicy: {},
          },
          serviceConfig: {
            timeoutSeconds: 60,
            serviceAccountEmail: 'test-project@appspot.gserviceaccount.com',
            environmentVariables: {
              GCLOUD_PROJECT: 'test-project',
              FIREBASE_CONFIG: JSON.stringify(target.firebaseConfig),
              EVENTARC_CLOUD_EVENT_SOURCE:
                'projects/test-project/locations/europe-west1/functions/booksapi-lookupisbn',
            },
            ingressSettings: 'ALLOW_ALL',
            availableMemory: '256M',
            maxInstanceRequestConcurrency: 1,
            securityLevel: 'SECURE_ALWAYS',
            uri: 'https://europe-west1-test-project.cloudfunctions.net/booksapi-lookupisbn',
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
        }, {
          name: 'projects/test-project/locations/europe-west1/functions/publicweb',
          environment: 'GEN_2',
          state: 'ACTIVE',
          buildConfig: {
            entryPoint: 'publicweb',
            runtime: 'nodejs22',
            environmentVariables: {GOOGLE_NODE_RUN_SCRIPTS: ''},
            dockerRegistry: 'ARTIFACT_REGISTRY',
            dockerRepository:
              'projects/test-project/locations/europe-west1/repositories/gcf-artifacts',
            automaticUpdatePolicy: {},
          },
          serviceConfig: {
            timeoutSeconds: 30,
            maxInstanceCount: 20,
            serviceAccountEmail: '123456789-compute@developer.gserviceaccount.com',
            environmentVariables: {
              GCLOUD_PROJECT: 'test-project',
              FIREBASE_CONFIG: JSON.stringify(target.firebaseConfig),
              EVENTARC_CLOUD_EVENT_SOURCE:
                'projects/test-project/locations/europe-west1/services/publicweb',
              FUNCTION_TARGET: 'publicweb',
              LOG_EXECUTION_ID: 'true',
            },
            ingressSettings: 'ALLOW_ALL',
            availableMemory: '256Mi',
            availableCpu: '1',
            maxInstanceRequestConcurrency: 80,
            allTrafficOnLatestRevision: true,
            revision: 'publicweb-00001-test',
            uri: 'https://publicweb-dummy-ew.a.run.app',
            service: 'projects/test-project/locations/europe-west1/services/publicweb',
          },
          labels: {'book-tracker-release': 'reviewed-release'},
        }],
        nextPageToken: '',
      }},
    ],
    [
      'https://cloudfunctions.googleapis.com/v2/projects/test-project/locations/europe-west1/functions/booksapi-lookupisbn:getIamPolicy?options.requestedPolicyVersion=3',
      {json: {bindings: [{role: 'roles/cloudfunctions.invoker', members: ['allUsers']}]}},
    ],
    [
      'https://cloudfunctions.googleapis.com/v1/projects/test-project/locations/europe-west1/functions/booksapi-lookupisbn:generateDownloadUrl',
      {json: {downloadUrl: 'https://storage.googleapis.com/dummy/booksapi.zip?signature=dummy'}},
    ],
    [
      'https://storage.googleapis.com/dummy/booksapi.zip?signature=dummy',
      {body: FUNCTION_ARCHIVE},
    ],
    [
      'https://cloudfunctions.googleapis.com/v2/projects/test-project/locations/europe-west1/functions/publicweb:getIamPolicy?options.requestedPolicyVersion=3',
      {json: {bindings: []}},
    ],
    [
      'https://cloudfunctions.googleapis.com/v1/projects/test-project/locations/europe-west1/functions/publicweb:generateDownloadUrl',
      {json: {downloadUrl: 'https://storage.googleapis.com/dummy/publicweb.zip?signature=dummy'}},
    ],
    [
      'https://storage.googleapis.com/dummy/publicweb.zip?signature=dummy',
      {body: FUNCTION_ARCHIVE},
    ],
    [
      'https://run.googleapis.com/v2/projects/test-project/locations/europe-west1/services/publicweb:getIamPolicy?options.requestedPolicyVersion=3',
      {json: {bindings: [{role: 'roles/run.invoker', members: ['allUsers']}]}},
    ],
    [
      'https://run.googleapis.com/v2/projects/test-project/locations/europe-west1/services/publicweb',
      {json: RUN_SERVICE_API},
    ],
    [
      'https://cloudresourcemanager.googleapis.com/v3/projects/test-project',
      {json: {name: 'projects/123456789', projectId: 'test-project'}},
    ],
    [
      'https://cloudresourcemanager.googleapis.com/v1/projects/test-project:getIamPolicy',
      {json: {bindings: []}},
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
          config: ACTIVE_HOSTING_CONFIG,
        },
      }]}},
    ],
    [
      'https://firebasehosting.googleapis.com/v1beta1/projects/test-project/sites?pageSize=100',
      {json: {sites: [{
        name: 'projects/test-project/sites/test-project',
        defaultUrl: 'https://test-project.web.app',
        type: 'DEFAULT_SITE',
      }]}},
    ],
    [
      'https://firebasehosting.googleapis.com/v1beta1/sites/test-project/channels?pageSize=100',
      {json: {channels: [{name: 'sites/test-project/channels/live'}]}},
    ],
    [
      'https://firebasehosting.googleapis.com/v1beta1/sites/test-project/domains?pageSize=100',
      {json: {domains: []}},
    ],
    [
      'https://firebasehosting.googleapis.com/v1beta1/sites/test-project/versions/version1/files?pageSize=1000&status=ACTIVE',
      {json: {files: [
        {
          path: '/index.html',
          hash: artifact(INDEX).hostingHash,
          status: 'ACTIVE',
        },
        {
          path: '/__/firebase/init.js',
          hash: artifact(GENERATED).hostingHash,
          status: 'ACTIVE',
        },
      ]}},
    ],
    ['https://test-project.web.app/index.html', {body: INDEX}],
    ['https://test-project.web.app/__/firebase/init.js', {body: GENERATED}],
    ['https://test-project.firebaseapp.com/index.html', {body: INDEX}],
    ['https://test-project.firebaseapp.com/__/firebase/init.js', {body: GENERATED}],
    [
      'https://test-project.web.app/profiles/__deployment_integrity_probe__',
      {
        status: 404,
        body: PROFILE_PROBE,
        headers: {'x-book-tracker-release': 'reviewed-release'},
      },
    ],
    [
      'https://test-project.web.app/sitemap.xml',
      {body: '<urlset/>', headers: {'x-book-tracker-release': 'reviewed-release'}},
    ],
    [
      'https://test-project.firebaseapp.com/profiles/__deployment_integrity_probe__',
      {
        status: 404,
        body: PROFILE_PROBE,
        headers: {'x-book-tracker-release': 'reviewed-release'},
      },
    ],
    [
      'https://test-project.firebaseapp.com/sitemap.xml',
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
    if (call.url.startsWith('https://test-project.web.app') ||
        call.url.startsWith('https://test-project.firebaseapp.com') ||
        call.url.startsWith('https://storage.googleapis.com/')) {
      assert.equal(call.authorization, undefined);
    } else {
      assert.equal(call.authorization, 'Bearer dummy-token');
    }
  }
});

test('detects inherited invoker access, disabled Run IAM, and public preview channels from API mocks', async () => {
  const fixture = apiFixture(new Map([
    [
      'https://cloudresourcemanager.googleapis.com/v1/projects/test-project:getIamPolicy',
      {json: {bindings: [{
        role: 'projects/test-project/roles/customInvoker',
        members: ['allUsers'],
      }]}},
    ],
    [
      'https://run.googleapis.com/v2/projects/test-project/locations/europe-west1/services/publicweb',
      {json: {...RUN_SERVICE_API, invokerIamDisabled: true}},
    ],
    [
      'https://firebasehosting.googleapis.com/v1beta1/sites/test-project/channels?pageSize=100',
      {json: {channels: [
        {name: 'sites/test-project/channels/live'},
        {name: 'sites/test-project/channels/unreviewed-preview'},
      ]}},
    ],
  ]));
  const observed = await readObservedDeployment(fixture.fetch, expected, 'dummy-token');
  assert.deepEqual(deploymentProblems(expected, observed), [
    'Effective ancestor IAM does not match the reviewed commit',
    'Public Hosting preview channels exist',
    'Function configuration mismatch: europe-west1/publicweb',
  ]);
});

test('treats omitted Gen 2 allTrafficOnLatestRevision as false', async () => {
  const fixture = apiFixture();
  const functionListUrl =
    'https://cloudfunctions.googleapis.com/v2/projects/test-project/locations/-/functions';
  const fetch: FetchLike = async (url, init) => {
    const result = await fixture.fetch(url, init);
    if (url !== functionListUrl) return result;
    const payload = structuredClone(await result.json()) as {
      functions: Array<{name: string; serviceConfig: Record<string, unknown>}>;
    };
    const publicweb = payload.functions.find(({name}) => name.endsWith('/publicweb'))!;
    delete publicweb.serviceConfig.allTrafficOnLatestRevision;
    return response({json: payload});
  };
  const observed = await readObservedDeployment(fetch, expected, 'dummy-token');
  assert.ok(deploymentProblems(expected, observed).includes(
    'Function does not send all traffic to its latest revision: europe-west1/publicweb',
  ));
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

  const extraRulesFile = apiFixture(new Map([[
    'https://firebaserules.googleapis.com/v1/projects/test-project/rulesets/current',
    {json: {source: {files: [
      {name: 'firestore.rules', content: RULES},
      {name: 'extra.rules', content: 'match /backdoor/{path=**} {}'},
    ]}}},
  ]]));
  await assert.rejects(
    readObservedDeployment(extraRulesFile.fetch, expected, 'dummy-token'),
    /exactly one source file/,
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
    'https://cloudfunctions.googleapis.com/v2/projects/test-project/locations/europe-west1/functions/booksapi-lookupisbn:getIamPolicy?options.requestedPolicyVersion=3',
    {json: {bindings: [{
      role: 'roles/cloudfunctions.invoker',
      members: ['allUsers'],
      condition: {expression: 'request.time < timestamp("2030-01-01T00:00:00Z")'},
    }]}},
  ]]));
  const conditionalObserved = await readObservedDeployment(
    conditionalPublicInvoker.fetch,
    expected,
    'dummy-token',
  );
  assert.ok(deploymentProblems(expected, conditionalObserved).includes(
    'Function configuration mismatch: europe-west1/booksapi-lookupisbn',
  ));
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

function gitFixture(
  status = '',
  head = COMMIT,
  pushed = COMMIT,
  remote = pushed,
  dotenv = '',
): GitRunner {
  const files = new Map<string, Buffer>([
    [`show ${COMMIT}:deployment-target.json`, Buffer.from(JSON.stringify(target))],
    [`show ${COMMIT}:firebase.json`, Buffer.from(JSON.stringify(FIREBASE_JSON))],
    [`show ${COMMIT}:firestore.indexes.json`, Buffer.from(JSON.stringify({
      indexes: [], fieldOverrides: [],
    }))],
    [`show ${COMMIT}:firestore.rules`, Buffer.from(RULES)],
    [`show ${COMMIT}:hosting-artifacts.json`, Buffer.from(JSON.stringify({
      version: 2,
      files: {'index.html': artifact(INDEX)},
    }))],
    [`show ${COMMIT}:functions-artifacts.json`, Buffer.from(JSON.stringify({
      version: 1,
      files: FUNCTION_FILES,
      profileProbeSha256: hash(PROFILE_PROBE),
    }))],
    ['rev-parse HEAD', Buffer.from(`${head}\n`)],
    ['rev-parse origin/master', Buffer.from(`${pushed}\n`)],
    ['ls-remote --exit-code origin refs/heads/master', Buffer.from(
      `${remote}\trefs/heads/master\n`,
    )],
    ['status --porcelain=v1 -z --untracked-files=all', Buffer.from(status)],
    [
      'ls-files --others --ignored --exclude-standard -z -- :(glob)functions/.env*',
      Buffer.from(dotenv),
    ],
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

test('rejects target manifests that make deployment checks vacuous', () => {
  const invalidTargets: unknown[] = [
    {...target, hostingOrigins: []},
    {...target, functions: []},
    {...target, allowedUntrackedPrefixes: ['']},
    {...target, generatedHostingFiles: {}},
  ];
  for (const invalid of invalidTargets) {
    const base = gitFixture();
    const runGit: GitRunner = (arguments_) =>
      arguments_.join(' ') === `show ${COMMIT}:deployment-target.json` ?
        Buffer.from(JSON.stringify(invalid)) : base(arguments_);
    assert.throws(() => readExpectedDeployment(COMMIT, runGit));
  }
});

test('rejects a mismatched commit and dirty deploy inputs while allowing reviewed notes', () => {
  assert.deepEqual(reviewedTreeProblems(COMMIT, target, gitFixture('', 'b'.repeat(40))), [
    'HEAD is not the reviewed commit',
  ]);
  assert.deepEqual(reviewedTreeProblems(COMMIT, target, gitFixture(' M firestore.rules\0')), [
    'Unreviewed working-tree change:  M firestore.rules',
  ]);
  assert.deepEqual(reviewedTreeProblems(COMMIT, target, gitFixture('?? ideas/note.md\0')), []);
  assert.deepEqual(
    reviewedTreeProblems(COMMIT, target, gitFixture('', COMMIT, COMMIT, 'b'.repeat(40))),
    ['Remote master is not the reviewed commit'],
  );
  assert.deepEqual(
    reviewedTreeProblems(
      COMMIT,
      target,
      gitFixture('', COMMIT, COMMIT, COMMIT, 'functions/.env.production\0'),
    ),
    ['Ignored Functions dotenv input: functions/.env.production'],
  );
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
