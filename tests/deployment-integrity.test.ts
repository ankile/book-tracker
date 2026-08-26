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
const STORAGE_RULES = 'rules_version = "2"; service firebase.storage { match /b/{bucket}/o { match /{path=**} { allow read, write: if false; } } }\n';
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
  storage: {rules: 'storage.rules'},
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

function hash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return `{${Object.keys(source).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(source[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonicalHash(value: unknown): string {
  return hash(canonical(value));
}

const EMPTY_BUCKET_CONFIGURATION = {
  autoclass: {}, billing: {}, cors: [], customPlacementConfig: {},
  defaultEventBasedHold: false, encryption: {}, hierarchicalNamespace: {},
  ipFilter: {}, lifecycle: {}, location: 'EUROPE-WEST1', locationType: 'region',
  logging: {}, objectRetention: {}, retentionPolicy: {}, rpo: null,
  softDeletePolicy: {}, storageClass: 'STANDARD', versioning: {}, website: {},
};
const ARTIFACT_REPOSITORY_CONFIGURATION = {
  format: 'DOCKER',
  description: null,
  labels: {},
  mode: 'STANDARD_REPOSITORY',
  cleanupPolicies: {},
  cleanupPolicyDryRun: false,
  kmsKeyName: null,
  dockerConfig: {},
  mavenConfig: {},
  virtualRepositoryConfig: {},
  remoteRepositoryConfig: {},
  vulnerabilityScanningConfig: {enablementState: null},
};

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

function tarArchive(files: Record<string, Uint8Array>): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const [path, body] of Object.entries(files)) {
    const header = new Uint8Array(512);
    const write = (offset: number, length: number, value: string): void => {
      const encoded = new TextEncoder().encode(value);
      assert.ok(encoded.byteLength <= length);
      header.set(encoded, offset);
    };
    const octal = (offset: number, length: number, value: number): void =>
      write(offset, length, `${value.toString(8).padStart(length - 1, '0')}\0`);
    write(0, 100, path);
    octal(100, 8, 0o644);
    octal(108, 8, 0);
    octal(116, 8, 0);
    octal(124, 12, body.byteLength);
    octal(136, 12, 0);
    header.fill(32, 148, 156);
    header[156] = 48;
    write(257, 6, 'ustar\0');
    write(263, 2, '00');
    const checksum = header.reduce((sum, value) => sum + value, 0);
    write(148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
    chunks.push(header, body, new Uint8Array((512 - body.byteLength % 512) % 512));
  }
  chunks.push(new Uint8Array(1024));
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

const IMAGE_SOURCE_TAR = gzipSync(tarArchive({
  './package.json': new TextEncoder().encode(FUNCTION_PACKAGE),
}));
const IMAGE_LAYER = gzipSync(tarArchive({
  '/layers/google.utils.archive-source/src/source-code.tar.gz': IMAGE_SOURCE_TAR,
}));
const IMAGE_LAYER_DIGEST = `sha256:${hash(IMAGE_LAYER)}`;
const IMAGE_CONFIG = {
  config: {Labels: {
    'google.build-id': '11111111-1111-1111-1111-111111111111',
    'google.source':
      'gs://gcf-v2-sources-123456789-europe-west1/publicweb/function-source.zip#123',
  }},
};
const IMAGE_CONFIG_BYTES = new TextEncoder().encode(JSON.stringify(IMAGE_CONFIG));
const IMAGE_CONFIG_DIGEST = `sha256:${hash(IMAGE_CONFIG_BYTES)}`;
const IMAGE_MANIFEST = {
  schemaVersion: 2,
  config: {digest: IMAGE_CONFIG_DIGEST},
  layers: [{
    mediaType: 'application/vnd.docker.image.rootfs.diff.tar.gzip',
    size: IMAGE_LAYER.byteLength,
    digest: IMAGE_LAYER_DIGEST,
  }],
};
const IMAGE_MANIFEST_BYTES = new TextEncoder().encode(JSON.stringify(IMAGE_MANIFEST));
const IMAGE_DIGEST = `sha256:${hash(IMAGE_MANIFEST_BYTES)}`;
const AUTH_API = {
  authorizedDomains: ['test-project.firebaseapp.com', 'test-project.web.app'],
  signIn: {email: {enabled: true, passwordRequired: true}},
  mfa: {state: 'DISABLED'},
  multiTenant: {},
  client: {permissions: {}, firebaseSubdomain: 'test-project'},
  blockingFunctions: {},
  monitoring: {requestLogging: {}},
  smsRegionConfig: {},
  subtype: 'FIREBASE_AUTH',
};
const AUTH_TARGET = {
  ...AUTH_API,
  signInHashConfigSha256: hash('{}'),
  notificationSha256: hash('{}'),
  quota: {},
  client: {...AUTH_API.client, apiKeySha256: hash('null')},
  mobileLinksConfig: {},
  defaultHostingSite: null,
  subtype: 'FIREBASE_AUTH',
  recaptchaConfig: {},
  emailPrivacyConfig: {},
  passwordPolicyConfig: {},
  autodeleteAnonymousUsers: null,
};
const EMPTY_AUTH_PROVIDERS = Object.fromEntries([
  'defaultSupportedIdpConfigs', 'inboundSamlConfigs', 'oauthIdpConfigs', 'tenants',
].map((name) => [name, {names: [], sha256: hash('[]')} ]));

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
  security: {
    gitOrigin: 'https://github.com/example/test-project.git',
    storageRulesRelease: 'test-project.firebasestorage.app',
    authConfig: AUTH_TARGET,
    authProviders: EMPTY_AUTH_PROVIDERS,
    firebaseRulesReleases: [
      'cloud.firestore',
      'firebase.storage/test-project.firebasestorage.app',
    ],
    ancestorIamPolicies: [{name: 'projects/test-project', iam: []}],
    customRoles: [],
    serviceAccounts: [
      {name: '123456789-compute@developer.gserviceaccount.com', iam: [], userManagedKeys: []},
      {name: 'test-project@appspot.gserviceaccount.com', iam: [], userManagedKeys: []},
    ],
    secrets: [{
      name: 'FUNCTIONS_CONFIG_EXPORT',
      iam: [{
        role: 'roles/secretmanager.secretAccessor',
        members: ['serviceAccount:test-project@appspot.gserviceaccount.com'],
      }],
      versions: [{version: '2', state: 'ENABLED'}],
    }],
    artifactRepositories: [{
      name: 'projects/test-project/locations/europe-west1/repositories/gcf-artifacts',
      iam: [],
      configuration: ARTIFACT_REPOSITORY_CONFIGURATION,
    }],
    storageBuckets: [{
      name: 'test-project.firebasestorage.app',
      iam: [],
      publicAccessPrevention: 'inherited',
      uniformBucketLevelAccess: false,
      bucketAcl: [],
      defaultObjectAcl: [],
      objectAclsSha256: hash('[]'),
      configurationSha256: canonicalHash(EMPTY_BUCKET_CONFIGURATION),
    }],
    eventarcTriggers: [],
    pubsubTopics: [],
    pubsubSubscriptions: [],
  },
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
  storageRulesSha256: hash(STORAGE_RULES),
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
  runTraffic: null,
  runTrafficStatuses: null,
  configuredImage: null,
  revisionImage: null,
  buildId: null,
  buildSource: null,
  buildImageDigest: null,
  imageBuildId: null,
  imageSource: null,
  imageSourceFiles: null,
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
      image: 'europe-west1-docker.pkg.dev/test-project/gcf-artifacts/test--project__europe--west1__publicweb:version_1',
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
      image: 'europe-west1-docker.pkg.dev/test-project/gcf-artifacts/test--project__europe--west1__publicweb:version_1',
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
  traffic: [
    {type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST', percent: 100},
    {tag: 'fh-version1', revision: 'publicweb-00001-test'},
  ] as Array<Record<string, unknown>>,
  trafficStatuses: [{
    type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST',
    percent: 100,
    tag: 'fh-version1',
    revision: 'publicweb-00001-test',
  }],
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
  runTraffic: [
    {type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST', percent: 100},
    {tag: 'fh-version1', revision: 'publicweb-00001-test'},
  ],
  runTrafficStatuses: [{
    type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST',
    percent: 100,
    tag: 'fh-version1',
    revision: 'publicweb-00001-test',
  }],
  configuredImage: 'europe-west1-docker.pkg.dev/test-project/gcf-artifacts/test--project__europe--west1__publicweb:version_1',
  revisionImage:
    `europe-west1-docker.pkg.dev/test-project/gcf-artifacts/test--project__europe--west1__publicweb@${IMAGE_DIGEST}`,
  buildId: '11111111-1111-1111-1111-111111111111',
  buildSource: 'gs://gcf-v2-sources-123456789-europe-west1/publicweb/function-source.zip#123',
  buildImageDigest: IMAGE_DIGEST,
  imageBuildId: '11111111-1111-1111-1111-111111111111',
  imageSource: 'gs://gcf-v2-sources-123456789-europe-west1/publicweb/function-source.zip#123',
  imageSourceFiles: FUNCTION_FILES,
};

function currentObserved(): ObservedDeployment {
  return {
    firestoreRulesSha256: expected.firestoreRulesSha256,
    storageRulesSha256: expected.storageRulesSha256,
    indexes: [],
    ttls: [],
    functions: [currentFunction, currentGen2Function],
    ancestorResources: [...target.ancestorResources],
    ancestorIamPolicySha256: target.ancestorIamPolicySha256,
    security: {
      ...structuredClone(target.security),
      runServices: [
        'projects/test-project/locations/europe-west1/services/publicweb',
      ],
    },
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
      pinnedTags: {'europe-west1/publicweb': 'fh-version1'},
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
  const exactBody = new Uint8Array(body.byteLength);
  exactBody.set(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => reply.headers?.[name.toLowerCase()] ?? null,
    },
    json: async () => reply.json,
    arrayBuffer: async () => exactBody.buffer,
  };
}

function apiFixture(overrides = new Map<string, MockReply>()): {
  fetch: FetchLike;
  calls: Array<{
    url: string;
    authorization?: string;
    signal?: AbortSignal;
    method?: string;
    body?: string;
  }>;
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
      'https://firebaserules.googleapis.com/v1/projects/test-project/releases/firebase.storage/test-project.firebasestorage.app',
      {json: {rulesetName: 'projects/test-project/rulesets/storage-current'}},
    ],
    [
      'https://firebaserules.googleapis.com/v1/projects/test-project/rulesets/storage-current',
      {json: {source: {files: [{name: 'storage.rules', content: STORAGE_RULES}]}}},
    ],
    [
      'https://firebaserules.googleapis.com/v1/projects/test-project/releases',
      {json: {releases: [
        {name: 'projects/test-project/releases/cloud.firestore'},
        {name: 'projects/test-project/releases/firebase.storage/test-project.firebasestorage.app'},
      ]}},
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
            revision: '7',
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
            build: 'projects/123456789/locations/europe-west1/builds/11111111-1111-1111-1111-111111111111',
            environmentVariables: {GOOGLE_NODE_RUN_SCRIPTS: ''},
            dockerRegistry: 'ARTIFACT_REGISTRY',
            dockerRepository:
              'projects/test-project/locations/europe-west1/repositories/gcf-artifacts',
            automaticUpdatePolicy: {},
            source: {storageSource: {
              bucket: 'gcf-v2-sources-123456789-europe-west1',
              object: 'publicweb/function-source.zip',
              generation: '123',
            }},
            sourceProvenance: {resolvedStorageSource: {
              bucket: 'gcf-v2-sources-123456789-europe-west1',
              object: 'publicweb/function-source.zip',
              generation: '123',
            }},
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
      'https://storage.googleapis.com/storage/v1/b/gcf-v2-sources-123456789-europe-west1/o/publicweb%2Ffunction-source.zip?alt=media&generation=123',
      {body: FUNCTION_ARCHIVE},
    ],
    [
      'https://cloudbuild.googleapis.com/v1/projects/123456789/locations/europe-west1/builds/11111111-1111-1111-1111-111111111111',
      {json: {
        name: 'projects/123456789/locations/europe-west1/builds/11111111-1111-1111-1111-111111111111',
        id: '11111111-1111-1111-1111-111111111111',
        status: 'SUCCESS',
        startTime: '2026-01-01T00:00:00Z',
        finishTime: '2026-01-01T00:01:00Z',
        sourceProvenance: {},
        steps: [{
          id: 'fetch', status: 'SUCCESS',
          name: 'europe-west1-docker.pkg.dev/serverless-runtimes/utilities/gcs-fetcher:base_test',
          args: [
            '--type=ZipArchive',
            '--location=gs://gcf-v2-sources-123456789-europe-west1/publicweb/function-source.zip',
            '--dest_dir=/workspace',
            '--timeout_gcs=false',
          ],
        }, {
          id: 'pre-buildpack', status: 'SUCCESS', entrypoint: '/bin/shim',
          name: 'europe-west1-docker.pkg.dev/serverless-runtimes/google-22-full/builder/nodejs:nodejs_test',
          args: [
            '--phase=pre',
            '--app_image_unique=europe-west1-docker.pkg.dev/test-project/gcf-artifacts/test--project__europe--west1__publicweb:version_1',
            '--app_image_stable=europe-west1-docker.pkg.dev/test-project/gcf-artifacts/test--project__europe--west1__publicweb:latest',
            '--cache_image_unique=europe-west1-docker.pkg.dev/test-project/gcf-artifacts/test--project__europe--west1__publicweb/cache:11111111-1111-1111-1111-111111111111',
            '--cache_image_stable=europe-west1-docker.pkg.dev/test-project/gcf-artifacts/test--project__europe--west1__publicweb/cache:latest',
            '--env_var_names=BUILDER_OUTPUT,GOOGLE_RUNTIME,GOOGLE_LABEL_BUILDER_VERSION,GOOGLE_LABEL_BUILDER_IMAGE,GOOGLE_LABEL_RUN_IMAGE,GOOGLE_LABEL_SOURCE,GOOGLE_USE_SERVERLESS_RUNTIMES_TARBALLS,X_GOOGLE_FASTER_LANGUAGE_TARBALL_INSTALLATION,GOOGLE_RUNTIME_IMAGE_REGION,GOOGLE_RUNTIME_VERSION,X_GOOGLE_SKIP_RUNTIME_LAUNCH,GOOGLE_BUILD_ENV,GOOGLE_BUILD_UNIVERSE,GOOGLE_TPC_TARBALL_PROJECT,GOOGLE_TPC_HOSTNAME,GOOGLE_FUNCTION_TARGET,GOOGLE_FUNCTION_SIGNATURE_TYPE,X_GOOGLE_TARGET_PLATFORM,GOOGLE_LABEL_BUILD_ID,GOOGLE_LABEL_BASE_IMAGE,GOOGLE_LABEL_FUNCTION_TARGET,X_GOOGLE_SET_NODE_HEAP_SIZE,GOOGLE_NODE_RUN_SCRIPTS',
            '--experimental_skip_retag_cache',
          ],
          env: [
            'GOOGLE_RUNTIME=nodejs22',
            'GOOGLE_LABEL_SOURCE=gs://gcf-v2-sources-123456789-europe-west1/publicweb/function-source.zip#123',
            'GOOGLE_LABEL_BUILD_ID=11111111-1111-1111-1111-111111111111',
            'GOOGLE_FUNCTION_TARGET=publicweb',
            'GOOGLE_FUNCTION_SIGNATURE_TYPE=http',
            'X_GOOGLE_TARGET_PLATFORM=gcf',
            'GOOGLE_LABEL_BUILDER_IMAGE=europe-west1-docker.pkg.dev/serverless-runtimes/google-22-full/builder/nodejs:nodejs_test',
            'GOOGLE_LABEL_RUN_IMAGE=europe-west1-docker.pkg.dev/serverless-runtimes/google-22-full/scratch/nodejs22:nodejs22_test',
            'GOOGLE_LABEL_BASE_IMAGE=europe-west1-docker.pkg.dev/serverless-runtimes/google-22-full/runtimes/nodejs22',
          ],
        }, {
          id: 'build', status: 'SUCCESS', entrypoint: '/cnb/lifecycle/creator',
          name: 'europe-west1-docker.pkg.dev/serverless-runtimes/google-22-full/builder/nodejs:nodejs_test',
          args: [
            '--tag=europe-west1-docker.pkg.dev/test-project/gcf-artifacts/test--project__europe--west1__publicweb:latest',
            'europe-west1-docker.pkg.dev/test-project/gcf-artifacts/test--project__europe--west1__publicweb:version_1',
          ],
          env: [
            'CNB_RUN_IMAGE=europe-west1-docker.pkg.dev/serverless-runtimes/google-22-full/scratch/nodejs22:nodejs22_test',
          ],
        }],
        options: {
          env: [
            'CNB_APP_DIR=/workspace', 'CNB_ANALYZED_PATH=/layers/analyzed.toml',
            'CNB_BUILDPACKS_DIR=/cnb/buildpacks', 'CNB_GROUP_PATH=/layers/group.toml',
            'CNB_LAYERS_DIR=/layers', 'CNB_PLAN_PATH=/layers/plan.toml',
            'CNB_PLATFORM_DIR=/platform', 'CNB_PLATFORM_API=0.11', 'CNB_NO_COLOR=true',
            'CNB_USER_ID=33', 'CNB_GROUP_ID=33',
            'CNB_CACHE_IMAGE=europe-west1-docker.pkg.dev/test-project/gcf-artifacts/test--project__europe--west1__publicweb/cache:latest',
            'CNB_PREVIOUS_IMAGE=europe-west1-docker.pkg.dev/test-project/gcf-artifacts/test--project__europe--west1__publicweb:latest',
          ],
          logStreamingOption: 'STREAM_OFF', logging: 'CLOUD_LOGGING_ONLY', pool: {},
          volumes: [{name: 'layers', path: '/layers'}, {name: 'platform', path: '/platform'}],
        },
        substitutions: {},
        tags: [
          'p-gcf', 'r-nodejs22', 'v-nodejs22_test', 'b-nodejs_test', 't-function',
          'bt-LIFECYCLE', 'service_publicweb',
        ],
        timeout: '1800s',
        queueTtl: '360s',
      }},
    ],
    [
      'https://logging.googleapis.com/v2/entries:list',
      {json: {entries: [{
        insertId: '11111111-1111-1111-1111-111111111111-145',
        labels: {build_step: 'Step #2 - "build"'},
        logName: 'projects/test-project/logs/cloudbuild',
        receiveTimestamp: '2026-01-01T00:00:31Z',
        resource: {type: 'build', labels: {
          build_id: '11111111-1111-1111-1111-111111111111',
          build_trigger_id: '', project_id: 'test-project',
        }},
        severity: 'INFO',
        textPayload: `Step #2 - "build": *** Images (${IMAGE_DIGEST}):`,
        timestamp: '2026-01-01T00:00:30Z',
      }, {
        insertId: 'audit-build-create',
        logName: 'projects/test-project/logs/cloudaudit.googleapis.com%2Factivity',
        resource: {type: 'build', labels: {
          build_id: '11111111-1111-1111-1111-111111111111',
          build_trigger_id: '', project_id: 'test-project',
        }},
        severity: 'NOTICE',
        timestamp: '2025-12-31T23:59:59Z',
        protoPayload: {
          serviceName: 'cloudbuild.googleapis.com',
          methodName: 'google.devtools.cloudbuild.v1.CloudBuild.CreateBuild',
          authenticationInfo: {
            principalEmail: 'service-123456789@gcf-admin-robot.iam.gserviceaccount.com',
          },
          authorizationInfo: [{permission: 'cloudbuild.builds.create', granted: true}],
        },
      }]}},
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
      'https://run.googleapis.com/v2/projects/test-project/locations/europe-west1/services/publicweb/revisions/publicweb-00001-test',
      {json: {
        name: 'projects/test-project/locations/europe-west1/services/publicweb/revisions/publicweb-00001-test',
        containers: [{
          name: 'worker',
          image: `europe-west1-docker.pkg.dev/test-project/gcf-artifacts/test--project__europe--west1__publicweb@${IMAGE_DIGEST}`,
        }],
      }},
    ],
    [
      `https://europe-west1-docker.pkg.dev/v2/test-project/gcf-artifacts/test--project__europe--west1__publicweb/manifests/${IMAGE_DIGEST}`,
      {body: IMAGE_MANIFEST_BYTES},
    ],
    [
      `https://artifactregistry.googleapis.com/v1/projects/test-project/locations/europe-west1/repositories/gcf-artifacts/dockerImages/test--project__europe--west1__publicweb%40${IMAGE_DIGEST}`,
      {json: {
        uri: `europe-west1-docker.pkg.dev/test-project/gcf-artifacts/test--project__europe--west1__publicweb@${IMAGE_DIGEST}`,
        tags: ['latest', 'version_1'],
        uploadTime: '2026-01-01T00:00:30Z',
        updateTime: '2026-01-01T00:00:31Z',
      }},
    ],
    [
      `https://europe-west1-docker.pkg.dev/v2/test-project/gcf-artifacts/test--project__europe--west1__publicweb/blobs/${IMAGE_CONFIG_DIGEST}`,
      {body: IMAGE_CONFIG_BYTES},
    ],
    [
      `https://europe-west1-docker.pkg.dev/v2/test-project/gcf-artifacts/test--project__europe--west1__publicweb/blobs/${IMAGE_LAYER_DIGEST}`,
      {body: IMAGE_LAYER},
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
      'https://run.googleapis.com/v2/projects/test-project/locations/-/services',
      {json: {services: [{
        name: 'projects/test-project/locations/europe-west1/services/publicweb',
      }], unreachable: []}},
    ],
    [
      'https://eventarc.googleapis.com/v1/projects/test-project/locations/-/triggers',
      {json: {triggers: []}},
    ],
    [
      'https://identitytoolkit.googleapis.com/admin/v2/projects/test-project/config',
      {json: AUTH_API},
    ],
    [
      'https://identitytoolkit.googleapis.com/admin/v2/projects/test-project/defaultSupportedIdpConfigs',
      {json: {defaultSupportedIdpConfigs: []}},
    ],
    [
      'https://identitytoolkit.googleapis.com/admin/v2/projects/test-project/oauthIdpConfigs',
      {json: {oauthIdpConfigs: []}},
    ],
    [
      'https://identitytoolkit.googleapis.com/admin/v2/projects/test-project/inboundSamlConfigs',
      {json: {inboundSamlConfigs: []}},
    ],
    [
      'https://identitytoolkit.googleapis.com/v2/projects/test-project/tenants',
      {json: {tenants: []}},
    ],
    [
      'https://iam.googleapis.com/v1/projects/test-project/roles?showDeleted=true&view=FULL',
      {json: {roles: []}},
    ],
    [
      'https://iam.googleapis.com/v1/projects/test-project/serviceAccounts',
      {json: {accounts: [
        {email: 'test-project@appspot.gserviceaccount.com'},
        {email: '123456789-compute@developer.gserviceaccount.com'},
      ]}},
    ],
    [
      'https://iam.googleapis.com/v1/projects/test-project/serviceAccounts/test-project%40appspot.gserviceaccount.com:getIamPolicy',
      {json: {bindings: []}},
    ],
    [
      'https://iam.googleapis.com/v1/projects/test-project/serviceAccounts/test-project%40appspot.gserviceaccount.com/keys',
      {json: {keys: []}},
    ],
    [
      'https://iam.googleapis.com/v1/projects/test-project/serviceAccounts/123456789-compute%40developer.gserviceaccount.com:getIamPolicy',
      {json: {bindings: []}},
    ],
    [
      'https://iam.googleapis.com/v1/projects/test-project/serviceAccounts/123456789-compute%40developer.gserviceaccount.com/keys',
      {json: {keys: []}},
    ],
    [
      'https://secretmanager.googleapis.com/v1/projects/test-project/secrets',
      {json: {secrets: [{name: 'projects/test-project/secrets/FUNCTIONS_CONFIG_EXPORT'}]}},
    ],
    [
      'https://secretmanager.googleapis.com/v1/projects/test-project/secrets/FUNCTIONS_CONFIG_EXPORT:getIamPolicy?options.requestedPolicyVersion=3',
      {json: {bindings: target.security.secrets[0].iam}},
    ],
    [
      'https://secretmanager.googleapis.com/v1/projects/test-project/secrets/FUNCTIONS_CONFIG_EXPORT/versions',
      {json: {versions: [{
        name: 'projects/test-project/secrets/FUNCTIONS_CONFIG_EXPORT/versions/2',
        state: 'ENABLED',
      }]}},
    ],
    [
      'https://artifactregistry.googleapis.com/v1/projects/test-project/locations/-/repositories',
      {json: {repositories: [{
        name: 'projects/test-project/locations/europe-west1/repositories/gcf-artifacts',
      }]}},
    ],
    [
      'https://artifactregistry.googleapis.com/v1/projects/test-project/locations/europe-west1/repositories/gcf-artifacts',
      {json: {
        name: 'projects/test-project/locations/europe-west1/repositories/gcf-artifacts',
        format: 'DOCKER',
        mode: 'STANDARD_REPOSITORY',
      }},
    ],
    [
      'https://artifactregistry.googleapis.com/v1/projects/test-project/locations/europe-west1/repositories/gcf-artifacts:getIamPolicy?options.requestedPolicyVersion=3',
      {json: {bindings: []}},
    ],
    [
      'https://pubsub.googleapis.com/v1/projects/test-project/topics',
      {json: {topics: []}},
    ],
    [
      'https://pubsub.googleapis.com/v1/projects/test-project/subscriptions',
      {json: {subscriptions: []}},
    ],
    [
      'https://storage.googleapis.com/storage/v1/b?project=test-project&projection=full',
      {json: {items: [{
        name: 'test-project.firebasestorage.app',
        location: 'EUROPE-WEST1',
        locationType: 'region',
        storageClass: 'STANDARD',
        iamConfiguration: {
          publicAccessPrevention: 'inherited',
          uniformBucketLevelAccess: {enabled: false},
        },
      }]}},
    ],
    [
      'https://storage.googleapis.com/storage/v1/b/test-project.firebasestorage.app/iam?optionsRequestedPolicyVersion=3',
      {json: {bindings: []}},
    ],
    [
      'https://storage.googleapis.com/storage/v1/b/test-project.firebasestorage.app/o?projection=full&versions=true',
      {json: {items: []}},
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
  const calls: Array<{
    url: string;
    authorization?: string;
    signal?: AbortSignal;
    method?: string;
    body?: string;
  }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({
      url,
      authorization: init?.headers?.Authorization,
      signal: init?.signal,
      method: init?.method,
      body: init?.body,
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
        call.url.startsWith('https://storage.googleapis.com/dummy/')) {
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
    'Ancestor IAM policies do not match the reviewed commit',
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

test('rejects stale tagged revisions and a repointed Gen 2 container image', async () => {
  const staleRunService = structuredClone(RUN_SERVICE_API);
  staleRunService.traffic = [
    {type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST', percent: 100},
    {tag: 'fh-version1', revision: 'publicweb-00001-test', percent: 0},
    {tag: 'backdoor', revision: 'publicweb-00000-old', percent: 0},
  ];
  staleRunService.template.containers[0].image =
    'europe-west1-docker.pkg.dev/test-project/gcf-artifacts/attacker:version_1';
  const fixture = apiFixture(new Map([[
    'https://run.googleapis.com/v2/projects/test-project/locations/europe-west1/services/publicweb',
    {json: staleRunService},
  ]]));
  const observed = await readObservedDeployment(fixture.fetch, expected, 'dummy-token');
  const problems = deploymentProblems(expected, observed);
  assert.ok(problems.includes('Cloud Run traffic does not match the reviewed deployment: europe-west1/publicweb'));
  assert.ok(problems.includes('Cloud Run container image does not match the reviewed Function: europe-west1/publicweb'));
});

test('uses the generation-matched source API and inventories standalone Run services', async () => {
  const fixture = apiFixture();
  const observed = await readObservedDeployment(fixture.fetch, expected, 'dummy-token');
  assert.deepEqual(deploymentProblems(expected, observed), []);
  assert.ok(fixture.calls.some(({url}) => url ===
    'https://storage.googleapis.com/storage/v1/b/gcf-v2-sources-123456789-europe-west1/o/publicweb%2Ffunction-source.zip?alt=media&generation=123'));
  assert.ok(fixture.calls.some(({url}) => url ===
    'https://run.googleapis.com/v2/projects/test-project/locations/-/services'));
  const gen1Download = fixture.calls.find(({url}) => url ===
    'https://cloudfunctions.googleapis.com/v1/projects/test-project/locations/europe-west1/functions/booksapi-lookupisbn:generateDownloadUrl');
  assert.equal(gen1Download?.method, 'POST');
  assert.deepEqual(JSON.parse(gen1Download?.body ?? ''), {versionId: '7'});
  assert.equal(fixture.calls.some(({url}) =>
    url === 'https://identitytoolkit.googleapis.com/v2/projects/test-project/tenants'), false);
});

test('rechecks every unreachable Run region and exposes a hidden service', async () => {
  const fixture = apiFixture(new Map([
    [
      'https://run.googleapis.com/v2/projects/test-project/locations/-/services',
      {json: {services: [{
        name: 'projects/test-project/locations/europe-west1/services/publicweb',
      }], unreachable: ['us-central1']}},
    ],
    [
      'https://run.googleapis.com/v2/projects/test-project/locations/us-central1/services',
      {json: {services: [{
        name: 'projects/test-project/locations/us-central1/services/backdoor',
      }], unreachable: []}},
    ],
  ]));
  const observed = await readObservedDeployment(fixture.fetch, expected, 'dummy-token');
  assert.equal(deploymentProblems(expected, observed).includes(
    'Cloud Run services do not match the reviewed Functions',
  ), true);
});

test('accepts an unreachable Run region only with a location-policy proof', async () => {
  const restricted = 'us-central2';
  const fixture = apiFixture(new Map([
    [
      'https://run.googleapis.com/v2/projects/test-project/locations/-/services',
      {json: {services: [{
        name: 'projects/test-project/locations/europe-west1/services/publicweb',
      }], unreachable: [restricted]}},
    ],
    [
      `https://run.googleapis.com/v2/projects/test-project/locations/${restricted}/services`,
      {status: 403, json: {error: {
        status: 'PERMISSION_DENIED',
        details: [{
          '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
          reason: 'LOCATION_POLICY_VIOLATED',
          metadata: {location: restricted},
        }],
      }}},
    ],
  ]));
  const observed = await readObservedDeployment(fixture.fetch, expected, 'dummy-token');
  assert.deepEqual(deploymentProblems(expected, observed), []);

  const unproven = apiFixture(new Map([
    [
      'https://run.googleapis.com/v2/projects/test-project/locations/-/services',
      {json: {services: [{
        name: 'projects/test-project/locations/europe-west1/services/publicweb',
      }], unreachable: [restricted]}},
    ],
    [
      `https://run.googleapis.com/v2/projects/test-project/locations/${restricted}/services`,
      {status: 403, json: {error: {
        status: 'PERMISSION_DENIED',
        details: [],
      }}},
    ],
  ]));
  await assert.rejects(
    readObservedDeployment(unproven.fetch, expected, 'dummy-token'),
    /location-policy proof/,
  );
});

test('inventories Eventarc, Storage rules, Auth, identities, secrets, and build resources', async () => {
  const fixture = apiFixture();
  const observed = await readObservedDeployment(fixture.fetch, expected, 'dummy-token');
  assert.deepEqual(deploymentProblems(expected, observed), []);
  const called = new Set(fixture.calls.map(({url}) => url));
  for (const url of [
    'https://eventarc.googleapis.com/v1/projects/test-project/locations/-/triggers',
    'https://firebaserules.googleapis.com/v1/projects/test-project/releases/firebase.storage/test-project.firebasestorage.app',
    'https://identitytoolkit.googleapis.com/admin/v2/projects/test-project/config',
    'https://iam.googleapis.com/v1/projects/test-project/serviceAccounts/test-project%40appspot.gserviceaccount.com:getIamPolicy',
    'https://iam.googleapis.com/v1/projects/test-project/serviceAccounts/test-project%40appspot.gserviceaccount.com/keys',
    'https://secretmanager.googleapis.com/v1/projects/test-project/secrets/FUNCTIONS_CONFIG_EXPORT:getIamPolicy?options.requestedPolicyVersion=3',
    'https://secretmanager.googleapis.com/v1/projects/test-project/secrets/FUNCTIONS_CONFIG_EXPORT/versions',
    'https://artifactregistry.googleapis.com/v1/projects/test-project/locations/europe-west1/repositories/gcf-artifacts:getIamPolicy?options.requestedPolicyVersion=3',
    'https://storage.googleapis.com/storage/v1/b?project=test-project&projection=full',
  ]) assert.equal(called.has(url), true, `missing security inventory call: ${url}`);
  const loggingCall = fixture.calls.find(({url}) =>
    url === 'https://logging.googleapis.com/v2/entries:list');
  assert.equal(loggingCall?.method, 'POST');
  const loggingBody = JSON.parse(loggingCall?.body ?? '') as {filter: string};
  assert.match(loggingBody.filter, /11111111-1111-1111-1111-111111111111/);
  assert.match(loggingBody.filter, /Step #2/);
});

test('rejects an overwritten Gen 2 source generation and a same-package replacement image', async () => {
  const attackerArchive = zipSync({
    'package.json': new TextEncoder().encode('{"name":"attacker"}\n'),
  });
  const sourceFixture = apiFixture(new Map([[
    'https://storage.googleapis.com/storage/v1/b/gcf-v2-sources-123456789-europe-west1/o/publicweb%2Ffunction-source.zip?alt=media&generation=123',
    {body: attackerArchive},
  ]]));
  const sourceObserved = await readObservedDeployment(sourceFixture.fetch, expected, 'dummy-token');
  assert.equal(deploymentProblems(expected, sourceObserved).includes(
    'Function source does not match the reviewed commit: europe-west1/publicweb',
  ), true);

  const attackerSourceTar = gzipSync(tarArchive({
    './package.json': new TextEncoder().encode('{"name":"attacker"}\n'),
  }));
  const attackerLayer = gzipSync(tarArchive({
    '/layers/google.utils.archive-source/src/source-code.tar.gz': attackerSourceTar,
  }));
  const attackerLayerDigest = `sha256:${hash(attackerLayer)}`;
  const attackerManifest = {
    schemaVersion: 2,
    config: {digest: IMAGE_CONFIG_DIGEST},
    layers: [{
      mediaType: 'application/vnd.docker.image.rootfs.diff.tar.gzip',
      size: attackerLayer.byteLength,
      digest: attackerLayerDigest,
    }],
  };
  const attackerManifestBytes = new TextEncoder().encode(JSON.stringify(attackerManifest));
  const attackerDigest = `sha256:${hash(attackerManifestBytes)}`;
  const attackerImage =
    `europe-west1-docker.pkg.dev/test-project/gcf-artifacts/test--project__europe--west1__publicweb@${attackerDigest}`;
  const replacedRevision = {
    name: 'projects/test-project/locations/europe-west1/services/publicweb/revisions/publicweb-00001-test',
    containers: [{
      name: 'worker',
      image: attackerImage,
    }],
  };
  const imageFixture = apiFixture(new Map([
    [
      'https://run.googleapis.com/v2/projects/test-project/locations/europe-west1/services/publicweb/revisions/publicweb-00001-test',
      {json: replacedRevision},
    ],
    [
      `https://europe-west1-docker.pkg.dev/v2/test-project/gcf-artifacts/test--project__europe--west1__publicweb/manifests/${attackerDigest}`,
      {body: attackerManifestBytes},
    ],
    [
      `https://artifactregistry.googleapis.com/v1/projects/test-project/locations/europe-west1/repositories/gcf-artifacts/dockerImages/test--project__europe--west1__publicweb%40${attackerDigest}`,
      {json: {
        uri: attackerImage,
        tags: ['latest', 'version_1'],
        uploadTime: '2026-01-01T00:00:30Z',
        updateTime: '2026-01-01T00:00:31Z',
      }},
    ],
    [
      `https://europe-west1-docker.pkg.dev/v2/test-project/gcf-artifacts/test--project__europe--west1__publicweb/blobs/${attackerLayerDigest}`,
      {body: attackerLayer},
    ],
  ]));
  const imageObserved = await readObservedDeployment(imageFixture.fetch, expected, 'dummy-token');
  assert.equal(deploymentProblems(expected, imageObserved).includes(
    'Cloud Run image provenance does not match the immutable Function build: europe-west1/publicweb',
  ), true);
  assert.equal(deploymentProblems(expected, imageObserved).includes(
    'Cloud Run image source does not match the reviewed commit: europe-west1/publicweb',
  ), true);

  const overwrittenDuringBuild: FetchLike = async (url, init) => {
    const original = await imageFixture.fetch(url, init);
    if (url !== 'https://logging.googleapis.com/v2/entries:list') return original;
    const body = structuredClone(await original.json()) as {
      entries: Array<Record<string, unknown>>;
    };
    const output = body.entries.find((entry) =>
      entry.logName === 'projects/test-project/logs/cloudbuild')!;
    output.textPayload = `Step #2 - "build": *** Images (${attackerDigest}):`;
    return response({json: body});
  };
  const raceObserved = await readObservedDeployment(
    overwrittenDuringBuild, expected, 'dummy-token',
  );
  const raceProblems = deploymentProblems(expected, raceObserved);
  assert.equal(raceProblems.includes(
    'Cloud Run image provenance does not match the immutable Function build: europe-west1/publicweb',
  ), false);
  assert.equal(raceProblems.includes(
    'Cloud Run image source does not match the reviewed commit: europe-west1/publicweb',
  ), true);
});

test('rejects a managed Function build with an unreviewed patch step', async () => {
  const fixture = apiFixture();
  const buildUrl =
    'https://cloudbuild.googleapis.com/v1/projects/123456789/locations/europe-west1/builds/11111111-1111-1111-1111-111111111111';
  const fetch: FetchLike = async (url, init) => {
    const original = await fixture.fetch(url, init);
    if (url !== buildUrl) return original;
    const build = structuredClone(await original.json()) as {
      steps: Array<Record<string, unknown>>;
    };
    build.steps.splice(2, 0, {
      id: 'patch-reviewed-source',
      name: 'europe-west1-docker.pkg.dev/serverless-runtimes/utilities/attacker:test',
      status: 'SUCCESS',
      args: ['overwrite', '/workspace/lib/index.js'],
    });
    return response({json: build});
  };
  await assert.rejects(
    readObservedDeployment(fetch, expected, 'dummy-token'),
    /pre-buildpack/,
  );
});

test('rehashes content-addressed image responses instead of trusting registry paths', async () => {
  const tamperedManifest = new TextEncoder().encode(JSON.stringify({
    ...IMAGE_MANIFEST,
    attackerField: true,
  }));
  const fixture = apiFixture(new Map([[
    `https://europe-west1-docker.pkg.dev/v2/test-project/gcf-artifacts/test--project__europe--west1__publicweb/manifests/${IMAGE_DIGEST}`,
    {body: tamperedManifest},
  ]]));
  await assert.rejects(
    readObservedDeployment(fixture.fetch, expected, 'dummy-token'),
    /manifest does not match its digest/,
  );
});

test('detects ordinary user-managed keys on non-runtime service accounts', async () => {
  const expectedWithAccount = structuredClone(expected);
  expectedWithAccount.target.security.serviceAccounts.push({
    name: 'privileged@test-project.iam.gserviceaccount.com',
    iam: [],
    userManagedKeys: [],
  });
  const fixture = apiFixture(new Map([
    [
      'https://iam.googleapis.com/v1/projects/test-project/serviceAccounts',
      {json: {accounts: [
        {email: 'test-project@appspot.gserviceaccount.com'},
        {email: '123456789-compute@developer.gserviceaccount.com'},
        {email: 'privileged@test-project.iam.gserviceaccount.com'},
      ]}},
    ],
    [
      'https://iam.googleapis.com/v1/projects/test-project/serviceAccounts/privileged%40test-project.iam.gserviceaccount.com:getIamPolicy',
      {json: {bindings: []}},
    ],
    [
      'https://iam.googleapis.com/v1/projects/test-project/serviceAccounts/privileged%40test-project.iam.gserviceaccount.com/keys',
      {json: {keys: [{
        name: 'projects/test-project/serviceAccounts/privileged/keys/attacker',
        keyOrigin: 'GOOGLE_PROVIDED',
        keyType: 'USER_MANAGED',
        disabled: false,
        validAfterTime: '2026-01-01T00:00:00Z',
        validBeforeTime: '9999-12-31T23:59:59Z',
      }]}},
    ],
  ]));
  const observed = await readObservedDeployment(
    fixture.fetch, expectedWithAccount, 'dummy-token',
  );
  assert.equal(deploymentProblems(expectedWithAccount, observed).includes(
    'Service-account IAM or user-managed keys do not match the reviewed commit',
  ), true);
});

test('rejects an extra Artifact Registry repository before trusting its IAM', async () => {
  const fixture = apiFixture(new Map([[
    'https://artifactregistry.googleapis.com/v1/projects/test-project/locations/-/repositories',
    {json: {repositories: [{
      name: 'projects/test-project/locations/europe-west1/repositories/gcf-artifacts',
    }, {
      name: 'projects/test-project/locations/us-central1/repositories/attacker',
    }]}},
  ]]));
  await assert.rejects(
    readObservedDeployment(fixture.fetch, expected, 'dummy-token'),
    /attacker/,
  );
});

test('rejects unreviewed buckets, public object ACLs, Auth controls, providers, and rules releases', async () => {
  const unknownBucketField = apiFixture(new Map([[
    'https://storage.googleapis.com/storage/v1/b?project=test-project&projection=full',
    {json: {items: [{
      name: 'test-project.firebasestorage.app',
      location: 'EUROPE-WEST1', locationType: 'region', storageClass: 'STANDARD',
      exposureMode: 'PUBLIC',
      iamConfiguration: {
        publicAccessPrevention: 'inherited', uniformBucketLevelAccess: {enabled: false},
      },
    }]}},
  ]]));
  await assert.rejects(
    readObservedDeployment(unknownBucketField.fetch, expected, 'dummy-token'),
    /unknown field/,
  );

  const extraBucket = apiFixture(new Map([[
    'https://storage.googleapis.com/storage/v1/b?project=test-project&projection=full',
    {json: {items: [
      {name: 'test-project.firebasestorage.app', iamConfiguration: {
        publicAccessPrevention: 'inherited', uniformBucketLevelAccess: {enabled: false},
      }},
      {name: 'attacker-bucket', iamConfiguration: {}},
    ]}},
  ]]));
  await assert.rejects(
    readObservedDeployment(extraBucket.fetch, expected, 'dummy-token'),
    /attacker-bucket/,
  );

  const aclFixture = apiFixture(new Map([[
    'https://storage.googleapis.com/storage/v1/b/test-project.firebasestorage.app/o?projection=full&versions=true',
    {json: {items: [{
      name: 'dummy.txt', generation: '1', acl: [{entity: 'allUsers', role: 'READER'}],
    }]}},
  ]]));
  const aclObserved = await readObservedDeployment(aclFixture.fetch, expected, 'dummy-token');
  assert.equal(deploymentProblems(expected, aclObserved).includes(
    'Cloud Storage security does not match the reviewed commit',
  ), true);

  const bucketConfigFixture = apiFixture(new Map([[
    'https://storage.googleapis.com/storage/v1/b?project=test-project&projection=full',
    {json: {items: [{
      name: 'test-project.firebasestorage.app',
      location: 'EUROPE-WEST1', locationType: 'region', storageClass: 'STANDARD',
      cors: [{origin: ['https://attacker.example.test'], method: ['GET']}],
      iamConfiguration: {
        publicAccessPrevention: 'inherited', uniformBucketLevelAccess: {enabled: false},
      },
    }]}},
  ]]));
  const bucketConfigObserved = await readObservedDeployment(
    bucketConfigFixture.fetch, expected, 'dummy-token',
  );
  assert.equal(deploymentProblems(expected, bucketConfigObserved).includes(
    'Cloud Storage security does not match the reviewed commit',
  ), true);

  const authFixture = apiFixture(new Map([
    [
      'https://identitytoolkit.googleapis.com/admin/v2/projects/test-project/config',
      {json: {...AUTH_API, emailPrivacyConfig: {enableImprovedEmailPrivacy: true}}},
    ],
    [
      'https://identitytoolkit.googleapis.com/admin/v2/projects/test-project/defaultSupportedIdpConfigs',
      {json: {defaultSupportedIdpConfigs: [{
        name: 'projects/test-project/defaultSupportedIdpConfigs/google.com', enabled: true,
      }]}},
    ],
    [
      'https://firebaserules.googleapis.com/v1/projects/test-project/releases',
      {json: {releases: [
        {name: 'projects/test-project/releases/cloud.firestore'},
        {name: 'projects/test-project/releases/firebase.storage/test-project.firebasestorage.app'},
        {name: 'projects/test-project/releases/firebase.storage/attacker-bucket'},
      ]}},
    ],
  ]));
  const authObserved = await readObservedDeployment(authFixture.fetch, expected, 'dummy-token');
  const authProblems = deploymentProblems(expected, authObserved);
  assert.equal(authProblems.includes(
    'Firebase Authentication security does not match the reviewed commit',
  ), true);
  assert.equal(authProblems.includes(
    'Firebase Authentication providers or tenants do not match the reviewed commit',
  ), true);
  assert.equal(authProblems.includes(
    'Firebase Rules releases do not match the reviewed commit',
  ), true);
});

test('lists tenants strictly when the Auth config identifies Identity Platform', async () => {
  const identityExpected = structuredClone(expected);
  identityExpected.target.security.authConfig = {
    ...identityExpected.target.security.authConfig,
    subtype: 'IDENTITY_PLATFORM',
    multiTenant: {allowTenants: true},
  };
  const tenant = {name: 'projects/test-project/tenants/reviewed', disabled: false};
  identityExpected.target.security.authProviders.tenants = {
    names: [tenant.name],
    sha256: canonicalHash([tenant]),
  };
  const fixture = apiFixture(new Map([
    [
      'https://identitytoolkit.googleapis.com/admin/v2/projects/test-project/config',
      {json: {...AUTH_API, subtype: 'IDENTITY_PLATFORM', multiTenant: {allowTenants: true}}},
    ],
    [
      'https://identitytoolkit.googleapis.com/v2/projects/test-project/tenants',
      {json: {tenants: [tenant]}},
    ],
  ]));
  const observed = await readObservedDeployment(
    fixture.fetch, identityExpected, 'dummy-token',
  );
  assert.deepEqual(deploymentProblems(identityExpected, observed), []);
});

test('rejects resource IAM, key, rule, Auth, Run, and Eventarc drift from API mocks', async () => {
  const fixture = apiFixture(new Map([
    [
      'https://firebaserules.googleapis.com/v1/projects/test-project/rulesets/storage-current',
      {json: {source: {files: [{
        name: 'storage.rules',
        content: 'allow read, write: if true;',
      }]}}},
    ],
    [
      'https://run.googleapis.com/v2/projects/test-project/locations/-/services',
      {json: {services: [
        {name: 'projects/test-project/locations/europe-west1/services/publicweb'},
        {name: 'projects/test-project/locations/europe-west1/services/backdoor'},
      ], unreachable: []}},
    ],
    [
      'https://eventarc.googleapis.com/v1/projects/test-project/locations/-/triggers',
      {json: {triggers: [{
        name: 'projects/test-project/locations/europe-west1/triggers/attacker',
        destination: {cloudFunction:
          'projects/test-project/locations/europe-west1/functions/publicweb'},
        eventFilters: [{attribute: 'type', value: 'google.cloud.audit.log.v1.written'}],
        transport: {pubsub: {topic: 'projects/test-project/topics/attacker'}},
        labels: {},
        serviceAccount: '123456789-compute@developer.gserviceaccount.com',
      }]}},
    ],
    [
      'https://eventarc.googleapis.com/v1/projects/test-project/locations/europe-west1/triggers/attacker:getIamPolicy?options.requestedPolicyVersion=3',
      {json: {bindings: []}},
    ],
    [
      'https://identitytoolkit.googleapis.com/admin/v2/projects/test-project/config',
      {json: {...AUTH_API, authorizedDomains: [
        ...AUTH_API.authorizedDomains,
        'attacker.example.test',
      ]}},
    ],
    [
      'https://iam.googleapis.com/v1/projects/test-project/serviceAccounts/test-project%40appspot.gserviceaccount.com:getIamPolicy',
      {json: {bindings: [{
        role: 'roles/iam.serviceAccountTokenCreator',
        members: ['user:attacker@example.test'],
      }]}},
    ],
    [
      'https://iam.googleapis.com/v1/projects/test-project/serviceAccounts/test-project%40appspot.gserviceaccount.com/keys',
      {json: {keys: [{
        name: 'projects/test-project/serviceAccounts/dummy/keys/attacker',
        keyOrigin: 'GOOGLE_PROVIDED',
        keyType: 'USER_MANAGED',
        disabled: false,
        validAfterTime: '2026-01-01T00:00:00Z',
        validBeforeTime: '9999-12-31T23:59:59Z',
      }]}},
    ],
    [
      'https://secretmanager.googleapis.com/v1/projects/test-project/secrets/FUNCTIONS_CONFIG_EXPORT/versions',
      {json: {versions: [{
        name: 'projects/test-project/secrets/FUNCTIONS_CONFIG_EXPORT/versions/2',
        state: 'DISABLED',
      }]}},
    ],
    [
      'https://artifactregistry.googleapis.com/v1/projects/test-project/locations/europe-west1/repositories/gcf-artifacts:getIamPolicy?options.requestedPolicyVersion=3',
      {json: {bindings: [{role: 'roles/artifactregistry.writer', members: [
        'user:attacker@example.test',
      ]}]}},
    ],
    [
      'https://storage.googleapis.com/storage/v1/b/test-project.firebasestorage.app/iam?optionsRequestedPolicyVersion=3',
      {json: {bindings: [{role: 'roles/storage.objectAdmin', members: [
        'user:attacker@example.test',
      ]}]}},
    ],
  ]));
  const observed = await readObservedDeployment(fixture.fetch, expected, 'dummy-token');
  const problems = deploymentProblems(expected, observed);
  for (const problem of [
    'Storage rules do not match the reviewed commit',
    'Service-account IAM or user-managed keys do not match the reviewed commit',
    'Secret Manager security does not match the reviewed commit',
    'Artifact Registry security does not match the reviewed commit',
    'Cloud Storage security does not match the reviewed commit',
    'Firebase Authentication security does not match the reviewed commit',
    'Cloud Run services do not match the reviewed Functions',
    'Eventarc triggers do not match the reviewed Functions',
  ]) assert.equal(problems.includes(problem), true, `missing drift problem: ${problem}`);
});

test('detects Eventarc transport replacement and Pub/Sub publisher authorization', async () => {
  const expectedMessaging = structuredClone(expected);
  const triggerName = 'projects/test-project/locations/europe-west1/triggers/publicweb';
  const destination = {
    cloudFunction: 'projects/test-project/locations/europe-west1/functions/publicweb',
  };
  expectedMessaging.target.security.eventarcTriggers = [{
    name: triggerName,
    iam: [],
    configuration: {
      destination,
      eventFilters: [{attribute: 'type', value: 'example.event'}],
      transport: {pubsub: {topic: 'projects/test-project/topics/reviewed'}},
      labels: {'goog-managed-by': 'cloudfunctions'},
      serviceAccount: '123456789-compute@developer.gserviceaccount.com',
      channel: null,
      eventDataContentType: 'application/json',
      conditions: {},
    },
  }];
  expectedMessaging.target.security.pubsubTopics = [{
    name: 'projects/test-project/topics/reviewed',
    iam: [],
    configuration: {
      labels: {}, messageStoragePolicy: {}, schemaSettings: {},
      ingestionDataSourceSettings: {}, kmsKeyName: null,
      messageRetentionDuration: null, messageTransforms: [], state: null,
    },
  }];
  const fixture = apiFixture(new Map([
    [
      'https://eventarc.googleapis.com/v1/projects/test-project/locations/-/triggers',
      {json: {triggers: [{
        name: triggerName,
        destination,
        eventFilters: [{attribute: 'type', value: 'example.event'}],
        transport: {pubsub: {topic: 'projects/test-project/topics/attacker'}},
        labels: {'goog-managed-by': 'cloudfunctions'},
        serviceAccount: '123456789-compute@developer.gserviceaccount.com',
        eventDataContentType: 'application/json',
      }]}},
    ],
    [
      `https://eventarc.googleapis.com/v1/${triggerName}:getIamPolicy?options.requestedPolicyVersion=3`,
      {json: {bindings: []}},
    ],
    [
      'https://pubsub.googleapis.com/v1/projects/test-project/topics',
      {json: {topics: [{name: 'projects/test-project/topics/reviewed'}]}},
    ],
    [
      'https://pubsub.googleapis.com/v1/projects/test-project/topics/reviewed:getIamPolicy?options.requestedPolicyVersion=3',
      {json: {bindings: [{
        role: 'roles/pubsub.publisher', members: ['allAuthenticatedUsers'],
        condition: {
          title: 'temporary-backdoor',
          expression: 'request.time < timestamp("2030-01-01T00:00:00Z")',
        },
      }]}},
    ],
  ]));
  const observed = await readObservedDeployment(fixture.fetch, expectedMessaging, 'dummy-token');
  const problems = deploymentProblems(expectedMessaging, observed);
  assert.equal(problems.includes('Eventarc triggers do not match the reviewed Functions'), true);
  assert.equal(problems.includes(
    'Pub/Sub topics or authorization do not match the reviewed commit',
  ), true);
});

test('rejects mutable IAM principals and changed custom-role permissions', async () => {
  for (const member of [
    'group:operators@example.test',
    'principalSet://iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/pool/*',
  ]) {
    const mutablePrincipal = apiFixture(new Map([[
      'https://cloudresourcemanager.googleapis.com/v1/projects/test-project:getIamPolicy',
      {json: {bindings: [{role: 'roles/viewer', members: [member]}]}},
    ]]));
    await assert.rejects(
      readObservedDeployment(mutablePrincipal.fetch, expected, 'dummy-token'),
      /mutable IAM principal is not reviewable/,
    );
  }

  const customRole = apiFixture(new Map([[
    'https://iam.googleapis.com/v1/projects/test-project/roles?showDeleted=true&view=FULL',
    {json: {roles: [{
      name: 'projects/test-project/roles/customRuntime',
      title: 'Custom runtime',
      description: '',
      includedPermissions: ['run.routes.invoke'],
      stage: 'GA',
      deleted: false,
    }]}},
  ]]));
  const observed = await readObservedDeployment(customRole.fetch, expected, 'dummy-token');
  assert.equal(
    deploymentProblems(expected, observed).includes(
      'Custom IAM roles do not match the reviewed commit',
    ),
    true,
  );
});

test('derives Cloud Run scaling from the reviewed Function limit', () => {
  const scaledExpected = structuredClone(expected);
  scaledExpected.target.functions[1].maxInstances = 25;
  const scaledObserved = currentObserved();
  scaledObserved.functions[1].maxInstances = 25;
  scaledObserved.functions[1].runConfiguration = structuredClone(RUN_CONFIGURATION);
  scaledObserved.functions[1].runConfiguration!.scaling = {maxInstanceCount: 25};
  const template = scaledObserved.functions[1].runConfiguration!.template as Record<string, unknown>;
  template.scaling = {maxInstanceCount: 25};
  assert.deepEqual(deploymentProblems(scaledExpected, scaledObserved), []);
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
  ignoredSecret = '',
  originUrl = 'https://github.com/example/test-project.git',
  localConfig = '',
  configOrigin = 'file:.git/config',
): GitRunner {
  const files = new Map<string, Buffer>([
    [`show ${COMMIT}:deployment-target.json`, Buffer.from(JSON.stringify(target))],
    [`show ${COMMIT}:firebase.json`, Buffer.from(JSON.stringify(FIREBASE_JSON))],
    [`show ${COMMIT}:firestore.indexes.json`, Buffer.from(JSON.stringify({
      indexes: [], fieldOverrides: [],
    }))],
    [`show ${COMMIT}:firestore.rules`, Buffer.from(RULES)],
    [`show ${COMMIT}:storage.rules`, Buffer.from(STORAGE_RULES)],
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
    ['remote get-url origin', Buffer.from(`${originUrl}\n`)],
    ['config --list --show-origin -z', Buffer.from(
      localConfig === '' ? '' : `${configOrigin}\0${localConfig}`,
    )],
    ['status --porcelain=v1 -z --untracked-files=all', Buffer.from(status)],
    [
      'ls-files --others --ignored --exclude-standard -z -- :(glob)functions/.env*',
      Buffer.from(dotenv),
    ],
    [
      'ls-files --others --ignored --exclude-standard -z -- :(glob)functions/.secret.*',
      Buffer.from(ignoredSecret),
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
  const approvedKey = structuredClone(target);
  approvedKey.security.serviceAccounts[0].userManagedKeys = [{
    name: 'projects/test-project/serviceAccounts/runtime/keys/standing-key',
  }];
  const exposedStorageAlias = structuredClone(target);
  exposedStorageAlias.security.storageRulesRelease = 'test-project.appspot.com';
  exposedStorageAlias.security.storageBuckets[0].name = 'test-project.appspot.com';
  exposedStorageAlias.security.storageBuckets.push({
    ...structuredClone(exposedStorageAlias.security.storageBuckets[0]),
    name: 'test-project.firebasestorage.app',
  });
  const inconsistentEventarc = structuredClone(target);
  inconsistentEventarc.functions[1] = {
    ...inconsistentEventarc.functions[1],
    access: 'event',
    event: {type: 'example.event', retry: false, filters: []},
  };
  inconsistentEventarc.security.eventarcTriggers = [{
    name: 'projects/test-project/locations/europe-west1/triggers/publicweb',
    iam: [],
    configuration: {
      destination: {
        cloudFunction: 'projects/test-project/locations/europe-west1/functions/publicweb',
      },
      eventFilters: [{attribute: 'type', value: 'attacker.event'}],
      transport: {pubsub: {topic: 'projects/test-project/topics/reviewed'}},
      labels: {'goog-managed-by': 'cloudfunctions'},
      serviceAccount: '123456789-compute@developer.gserviceaccount.com',
      channel: null,
      eventDataContentType: 'application/json',
      conditions: {},
    },
  }];
  const invalidTargets: unknown[] = [
    {...target, hostingOrigins: []},
    {...target, functions: []},
    {...target, allowedUntrackedPrefixes: ['']},
    {...target, generatedHostingFiles: {}},
    approvedKey,
    exposedStorageAlias,
    inconsistentEventarc,
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
  assert.deepEqual(
    reviewedTreeProblems(
      COMMIT,
      target,
      gitFixture('', COMMIT, COMMIT, COMMIT, '', 'functions/.secret.local\0'),
    ),
    ['Ignored Functions secret input: functions/.secret.local'],
  );
  assert.deepEqual(
    reviewedTreeProblems(
      COMMIT,
      target,
      gitFixture('', COMMIT, COMMIT, COMMIT, '', '', 'git@evil.test:fork/book-tracker.git'),
    ),
    ['Git origin is not the reviewed repository'],
  );
  assert.deepEqual(
    reviewedTreeProblems(
      COMMIT,
      target,
      gitFixture('', COMMIT, COMMIT, COMMIT, '', '', target.security.gitOrigin,
        'url.https://attacker.example/.insteadof\nhttps://github.com/\0'),
    ),
    ['Git URL rewrite can spoof origin'],
  );
  assert.deepEqual(
    reviewedTreeProblems(
      COMMIT,
      target,
      gitFixture('', COMMIT, COMMIT, COMMIT, '', '', target.security.gitOrigin,
        'url.ssh://attacker.example/.pushinsteadof\nhttps://github.com/\0',
        'file:/Users/test/.gitconfig'),
    ),
    ['Git URL rewrite can spoof origin'],
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
