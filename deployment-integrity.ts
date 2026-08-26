import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {unzipSync} from 'fflate';

type Generation = 'GEN_1' | 'GEN_2';
type FunctionAccess = 'callable' | 'event' | 'http';

interface EventFilter {
  attribute: string;
  value: string;
  operator?: string;
}

interface FunctionEvent {
  type: string;
  retry: boolean;
  filters: EventFilter[];
}

interface FunctionSecret {
  key: string;
  projectId: string;
  secret: string;
  version: string;
}

interface HostingArtifact {
  sha256: string;
  hostingHash: string;
}

interface IamBinding {
  role: string;
  members: string[];
  condition?: Record<string, unknown>;
}

interface IamResource {
  name: string;
  iam: IamBinding[];
}

interface ServiceAccountSecurity extends IamResource {
  userManagedKeys: Record<string, unknown>[];
}

interface SecretSecurity extends IamResource {
  versions: Array<{version: string; state: string}>;
}

interface StorageBucketSecurity extends IamResource {
  publicAccessPrevention: string;
  uniformBucketLevelAccess: boolean;
  bucketAcl: Record<string, unknown>[];
  defaultObjectAcl: Record<string, unknown>[];
  objectAclsSha256: string;
  configurationSha256: string;
}

interface EventarcTriggerSecurity extends IamResource {
  configuration: Record<string, unknown>;
}

interface PubsubResourceSecurity extends IamResource {
  configuration: Record<string, unknown>;
}

interface SecurityTarget {
  gitOrigin: string;
  storageRulesRelease: string;
  authConfig: Record<string, unknown>;
  ancestorIamPolicies: IamResource[];
  customRoles: Record<string, unknown>[];
  serviceAccounts: ServiceAccountSecurity[];
  secrets: SecretSecurity[];
  artifactRepositories: IamResource[];
  storageBuckets: StorageBucketSecurity[];
  eventarcTriggers: EventarcTriggerSecurity[];
  pubsubTopics: PubsubResourceSecurity[];
  pubsubSubscriptions: PubsubResourceSecurity[];
  authProviders: Record<string, unknown>;
  firebaseRulesReleases: string[];
}

interface ObservedSecurity extends Omit<SecurityTarget, 'gitOrigin' | 'storageRulesRelease'> {
  runServices: string[];
}

export interface ExpectedFunction {
  name: string;
  generation: Generation;
  region: string;
  entryPoint: string;
  access: FunctionAccess;
  timeoutSeconds: number;
  maxInstances: number | null;
  serviceAccount: string;
  secrets: FunctionSecret[];
  functionIam: IamBinding[];
  runIam: IamBinding[] | null;
  event: FunctionEvent | null;
}

export interface ObservedFunction extends ExpectedFunction {
  releaseId: string | null;
  state: string;
  allTrafficOnLatestRevision: boolean | null;
  revision: string | null;
  sourceFiles: Record<string, string>;
  runtime: string;
  buildEnvironmentVariables: Record<string, string>;
  userEnvironmentVariables: Record<string, string>;
  ingressSettings: string;
  availableMemory: string;
  availableCpu: string | null;
  maxInstanceRequestConcurrency: number;
  minInstances: number | null;
  vpcConnector: string | null;
  vpcConnectorEgressSettings: string | null;
  secretVolumes: Record<string, unknown>[];
  securityLevel: string | null;
  binaryAuthorizationPolicy: string | null;
  kmsKeyName: string | null;
  invokerIamDisabled: boolean | null;
  dockerRegistry: string;
  dockerRepository: string | null;
  automaticUpdatePolicy: Record<string, unknown>;
  buildServiceAccount: string | null;
  workerPool: string | null;
  uri: string | null;
  serviceResource: string | null;
  runLatestReadyRevision: string | null;
  runLatestCreatedRevision: string | null;
  runConfiguration: Record<string, unknown> | null;
  runTraffic: Record<string, unknown>[] | null;
  runTrafficStatuses: Record<string, unknown>[] | null;
  configuredImage: string | null;
  revisionImage: string | null;
  buildId: string | null;
  buildSource: string | null;
  imageBuildId: string | null;
  imageSource: string | null;
}

interface ExpectedIndex {
  collectionGroup: string;
  queryScope: string;
  fields: Array<{fieldPath: string; order: string}>;
}

interface ExpectedTtl {
  collectionGroup: string;
  fieldPath: string;
}

export interface DeploymentTarget {
  projectId: string;
  projectNumber: string;
  releaseId: string;
  hostingSite: string;
  hostingOrigins: string[];
  hostingCustomDomains: string[];
  generatedHostingFiles: Record<string, HostingArtifact>;
  allowedUntrackedPrefixes: string[];
  ancestorResources: string[];
  ancestorIamPolicySha256: string;
  security: SecurityTarget;
  firebaseConfig: Record<string, string>;
  functions: ExpectedFunction[];
}

export interface ExpectedDeployment {
  target: DeploymentTarget;
  firestoreRulesSha256: string;
  storageRulesSha256: string;
  indexes: ExpectedIndex[];
  ttls: ExpectedTtl[];
  hostingFiles: Record<string, HostingArtifact>;
  functionFiles: Record<string, string>;
  profileProbeSha256: string;
  hostingConfig: Record<string, unknown>;
}

export interface ObservedHosting {
  files: Record<string, Record<string, string>>;
  activeVersionFiles: Record<string, string>;
  activeVersionConfig: Record<string, unknown>;
  sites: string[];
  defaultUrl: string;
  channels: string[];
  customDomains: string[];
  pinnedRevisions: Record<string, string>;
  pinnedTags: Record<string, string>;
  profileReleaseIds: Record<string, string | null>;
  profileProbeSha256: Record<string, string>;
  sitemapReleaseIds: Record<string, string | null>;
}

export interface ObservedDeployment {
  firestoreRulesSha256: string;
  storageRulesSha256: string;
  indexes: ExpectedIndex[];
  ttls: ExpectedTtl[];
  functions: ObservedFunction[];
  ancestorResources: string[];
  ancestorIamPolicySha256: string;
  security: ObservedSecurity;
  hosting: ObservedHosting;
}

interface FetchHeaders {
  get(name: string): string | null;
}

export interface FetchResponse {
  ok: boolean;
  status: number;
  headers: FetchHeaders;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type FetchLike = (
  url: string,
  init?: {
    headers?: Record<string, string>;
    signal?: AbortSignal;
    method?: string;
    body?: string;
  },
) => Promise<FetchResponse>;

export type GitRunner = (arguments_: string[]) => Buffer;

const MAX_API_PAGES = 100;
const FETCH_TIMEOUT_MS = 10_000;
const RELEASE_HEADER = 'x-book-tracker-release';
const MAX_FUNCTION_ARCHIVE_BYTES = 20 * 1024 * 1024;
const MAX_FUNCTION_SOURCE_BYTES = 50 * 1024 * 1024;

function record(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  assert.equal(typeof value, 'string');
  return value as string;
}

function number(value: unknown): number {
  assert.equal(typeof value, 'number');
  return value as number;
}

function boolean(value: unknown): boolean {
  assert.equal(typeof value, 'boolean');
  return value as boolean;
}

function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}

function sha256(content: Uint8Array | string): string {
  return createHash('sha256').update(content).digest('hex');
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

function sha256Canonical(value: unknown): string {
  return sha256(canonical(value));
}

function stringRecord(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(record(value ?? {})).map(([key, entry]) => [
    key,
    string(entry),
  ]));
}

function nullableString(value: unknown): string | null {
  return value === undefined ? null : string(value);
}

function nullableNumber(value: unknown): number | null {
  return value === undefined ? null : number(value);
}

function normalizedIamBindings(policy: Record<string, unknown>): IamBinding[] {
  assert.ok(Object.keys(policy).every((key) =>
    ['bindings', 'etag', 'version', 'auditConfigs', 'kind', 'resourceId'].includes(key)));
  assert.deepEqual(policy.auditConfigs ?? [], []);
  return sortedCanonical(array(policy.bindings ?? []).map((value) => {
    const binding = record(value);
    assert.ok(Object.keys(binding).every((key) =>
      ['role', 'members', 'condition'].includes(key)));
    const condition = binding.condition;
    if (condition !== undefined) {
      const parsed = record(condition);
      assert.ok(Object.keys(parsed).every((key) =>
        ['title', 'description', 'expression', 'location'].includes(key)));
      for (const entry of Object.values(parsed)) string(entry);
    }
    const members = array(binding.members ?? []).map(string).sort();
    for (const member of members) {
      assert.equal(
        member.startsWith('group:') || member.startsWith('domain:') ||
          member.startsWith('principal://') || member.startsWith('principalSet://'),
        false,
        `mutable IAM principal is not reviewable: ${member}`,
      );
    }
    return {
      role: string(binding.role),
      members,
      ...(condition === undefined ? {} : {condition: record(condition)}),
    };
  }));
}

function zipEntryNames(content: Uint8Array): string[] {
  const view = new DataView(content.buffer, content.byteOffset, content.byteLength);
  const minimum = Math.max(0, content.byteLength - 65_557);
  let end = -1;
  for (let offset = content.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      end = offset;
      break;
    }
  }
  assert.notEqual(end, -1, 'Function source archive has no ZIP end record');
  assert.equal(view.getUint16(end + 4, true), 0, 'multi-disk ZIP is unsupported');
  assert.equal(view.getUint16(end + 6, true), 0, 'multi-disk ZIP is unsupported');
  const entriesOnDisk = view.getUint16(end + 8, true);
  const entryCount = view.getUint16(end + 10, true);
  assert.equal(entriesOnDisk, entryCount, 'multi-disk ZIP is unsupported');
  assert.notEqual(entryCount, 0xffff, 'ZIP64 is unsupported');
  const directorySize = view.getUint32(end + 12, true);
  const directoryOffset = view.getUint32(end + 16, true);
  assert.notEqual(directorySize, 0xffffffff, 'ZIP64 is unsupported');
  assert.notEqual(directoryOffset, 0xffffffff, 'ZIP64 is unsupported');
  assert.equal(directoryOffset + directorySize, end);
  const names: string[] = [];
  let offset = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    assert.equal(view.getUint32(offset, true), 0x02014b50, 'invalid ZIP central entry');
    const flags = view.getUint16(offset + 8, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const nameBytes = content.subarray(offset + 46, offset + 46 + nameLength);
    const encoding = (flags & 0x800) === 0 ? 'latin1' : 'utf-8';
    names.push(new TextDecoder(encoding, {fatal: true}).decode(nameBytes));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(offset, end);
  assert.equal(new Set(names).size, names.length, 'Function source archive has duplicate paths');
  return names.sort();
}

function sourceArchiveFiles(content: Uint8Array): Record<string, string> {
  assert.ok(content.byteLength <= MAX_FUNCTION_ARCHIVE_BYTES, 'Function source archive is too large');
  const names = zipEntryNames(content);
  let expandedBytes = 0;
  const files = unzipSync(content, {
    filter: (file) => {
      assert.ok(file.originalSize >= 0);
      expandedBytes += file.originalSize;
      assert.ok(expandedBytes <= MAX_FUNCTION_SOURCE_BYTES, 'Function source archive expands too large');
      return true;
    },
  });
  const entries = Object.entries(files).map(([path, body]) => {
    assert.match(path, /^(?!\/)(?!-)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0\r\n]+$/);
    assert.equal(path.endsWith('/'), false, 'Function source archive contains a directory entry');
    return [path, sha256(body)] as const;
  });
  assert.deepEqual(entries.map(([path]) => path).sort(), names);
  assert.ok(entries.length > 0, 'Function source archive is empty');
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

function functionKey(value: Pick<ExpectedFunction, 'name' | 'region'>): string {
  return `${value.region}/${value.name}`;
}

function resourceParts(
  resourceName: string,
  projectId: string,
): {region: string; name: string} {
  const segments = resourceName.split('/');
  assert.deepEqual(segments.slice(0, 5), [
    'projects', projectId, 'locations', segments[3], 'functions',
  ]);
  assert.equal(segments.length, 6);
  return {region: string(segments[3]), name: string(segments[5])};
}

function firestoreResourceParts(
  resourceName: string,
  projectId: string,
  expectedTail: string[],
): string[] {
  const segments = resourceName.split('/');
  assert.deepEqual(segments.slice(0, 4), [
    'projects', projectId, 'databases', '(default)',
  ]);
  assert.deepEqual(
    segments.filter((_, index) => index >= 4 && index % 2 === 0),
    expectedTail,
  );
  assert.equal(segments.length, 4 + expectedTail.length * 2);
  return segments;
}

function normalizeFilters(filters: EventFilter[]): EventFilter[] {
  return [...filters].sort((left, right) => canonical(left).localeCompare(canonical(right)));
}

function normalizeIndex(index: ExpectedIndex): ExpectedIndex {
  return {
    ...index,
    fields: index.fields.filter((field) => field.fieldPath !== '__name__'),
  };
}

function sortedCanonical<T>(values: T[]): T[] {
  return [...values].sort((left, right) => canonical(left).localeCompare(canonical(right)));
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function fetchWithRetry(
  fetch_: FetchLike,
  url: string,
  init: {headers?: Record<string, string>; method?: string; body?: string} | undefined,
  acceptedStatuses: number[] = [200],
  requestName = url,
): Promise<FetchResponse> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response: FetchResponse;
    try {
      response = await fetch_(url, {
        ...init,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      if (attempt === 2) throw error;
      await delay(100 * (attempt + 1));
      continue;
    }
    if (acceptedStatuses.includes(response.status)) return response;
    if (attempt < 2 && (response.status === 429 || response.status >= 500)) {
      await delay(100 * (attempt + 1));
      continue;
    }
    assert.fail(`${requestName} returned HTTP ${response.status}`);
  }
  assert.fail(`request attempts exhausted for ${requestName}`);
}

function authenticatedHeaders(accessToken: string, projectId: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'X-Goog-User-Project': projectId,
  };
}

async function json(
  fetch_: FetchLike,
  url: string,
  accessToken: string,
  projectId: string,
  init?: {method?: string; body?: string},
): Promise<Record<string, unknown>> {
  const response = await fetchWithRetry(fetch_, url, {
    headers: authenticatedHeaders(accessToken, projectId),
    ...init,
  });
  return record(await response.json());
}

async function deployedFirestoreRules(
  fetch_: FetchLike,
  projectId: string,
  accessToken: string,
): Promise<string> {
  const release = await json(
    fetch_,
    `https://firebaserules.googleapis.com/v1/projects/${projectId}/releases/cloud.firestore`,
    accessToken,
    projectId,
  );
  const rulesetName = string(release.rulesetName);
  assert.match(
    rulesetName,
    new RegExp(`^projects/${projectId}/rulesets/[A-Za-z0-9_-]+$`),
  );
  const ruleset = await json(
    fetch_,
    `https://firebaserules.googleapis.com/v1/${rulesetName}`,
    accessToken,
    projectId,
  );
  const source = record(ruleset.source);
  const files = array(source.files).map(record);
  assert.equal(files.length, 1, 'Firestore ruleset must contain exactly one source file');
  const matches = files.filter((file) => string(file.name).split('/').at(-1) === 'firestore.rules');
  assert.equal(matches.length, 1);
  return string(matches[0].content);
}

async function deployedStorageRules(
  fetch_: FetchLike,
  target: DeploymentTarget,
  accessToken: string,
): Promise<string> {
  const releaseName = `firebase.storage/${target.security.storageRulesRelease}`;
  const release = await json(
    fetch_,
    `https://firebaserules.googleapis.com/v1/projects/${target.projectId}/releases/${releaseName}`,
    accessToken,
    target.projectId,
  );
  const rulesetName = string(release.rulesetName);
  assert.match(
    rulesetName,
    new RegExp(`^projects/${target.projectId}/rulesets/[A-Za-z0-9_-]+$`),
  );
  const ruleset = await json(
    fetch_, `https://firebaserules.googleapis.com/v1/${rulesetName}`,
    accessToken, target.projectId,
  );
  const files = array(record(ruleset.source).files).map(record);
  assert.equal(files.length, 1, 'Storage ruleset must contain exactly one source file');
  assert.equal(string(files[0].name).split('/').at(-1), 'storage.rules');
  return string(files[0].content);
}

async function listApi(
  fetch_: FetchLike,
  baseUrl: string,
  field: string,
  accessToken: string,
  projectId: string,
): Promise<Record<string, unknown>[]> {
  const results: Record<string, unknown>[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_API_PAGES; page += 1) {
    const separator = baseUrl.includes('?') ? '&' : '?';
    const query = pageToken === undefined ? '' :
      `${separator}pageToken=${encodeURIComponent(pageToken)}`;
    const response = await json(fetch_, `${baseUrl}${query}`, accessToken, projectId);
    assert.deepEqual(response.unreachable ?? [], []);
    for (const value of array(response[field] ?? [])) results.push(record(value));
    const next = response.nextPageToken;
    if (next === undefined || string(next).trim() === '') return results;
    pageToken = string(next);
  }
  assert.fail(`${baseUrl} exceeded ${MAX_API_PAGES} pages`);
}

async function functionSourceFiles(
  fetch_: FetchLike,
  projectId: string,
  accessToken: string,
  region: string,
  name: string,
  generation: Generation,
  storageSource: Record<string, unknown> | null,
): Promise<Record<string, string>> {
  if (generation === 'GEN_2') {
    assert.ok(storageSource !== null);
    const source = storageSource;
    const bucket = string(source.bucket);
    const object = string(source.object);
    const objectGeneration = string(source.generation);
    const response = await fetchWithRetry(
      fetch_,
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${
        encodeURIComponent(object)}?alt=media&generation=${encodeURIComponent(objectGeneration)}`,
      {headers: authenticatedHeaders(accessToken, projectId)},
      [200],
      'immutable Gen 2 Function source archive download',
    );
    return sourceArchiveFiles(new Uint8Array(await response.arrayBuffer()));
  }
  assert.equal(storageSource, null);
  const generated = await json(
    fetch_,
    `https://cloudfunctions.googleapis.com/v1/projects/${projectId}/locations/${region}/functions/${name}:generateDownloadUrl`,
    accessToken,
    projectId,
    {method: 'POST', body: '{}'},
  );
  const downloadUrl = new URL(string(generated.downloadUrl));
  assert.equal(downloadUrl.protocol, 'https:');
  assert.equal(downloadUrl.hostname, 'storage.googleapis.com');
  const response = await fetchWithRetry(
    fetch_, downloadUrl.toString(), undefined, [200], 'Function source archive download',
  );
  return sourceArchiveFiles(new Uint8Array(await response.arrayBuffer()));
}

function buildIdFromName(value: unknown, projectNumber: string, region: string): string {
  const prefix = `projects/${projectNumber}/locations/${region}/builds/`;
  const name = string(value);
  assert.equal(name.startsWith(prefix), true);
  const buildId = name.slice(prefix.length);
  assert.match(buildId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  return buildId;
}

async function functionBuild(
  fetch_: FetchLike,
  target: DeploymentTarget,
  accessToken: string,
  region: string,
  buildName: unknown,
  storageSource: Record<string, unknown>,
): Promise<{buildId: string; buildSource: string; startTime: string; finishTime: string}> {
  const buildId = buildIdFromName(buildName, target.projectNumber, region);
  const build = await json(
    fetch_, `https://cloudbuild.googleapis.com/v1/${string(buildName)}`,
    accessToken, target.projectId,
  );
  assert.equal(build.name, buildName);
  assert.equal(build.id, buildId);
  assert.equal(build.status, 'SUCCESS');
  const startTime = string(build.startTime);
  const finishTime = string(build.finishTime);
  assert.equal(Date.parse(startTime) < Date.parse(finishTime), true);
  assert.deepEqual(build.secrets ?? [], []);
  assert.deepEqual(build.availableSecrets ?? {}, {});
  const steps = array(build.steps).map(record);
  assert.ok(steps.length > 0);
  for (const step of steps) assert.equal(step.status, 'SUCCESS');
  const buildSource = `gs://${string(storageSource.bucket)}/${string(storageSource.object)}#${
    string(storageSource.generation)}`;
  const fetchStep = steps.find((step) => step.id === 'fetch');
  assert.ok(fetchStep !== undefined);
  assert.ok(array(fetchStep.args).map(string).includes(
    `--location=gs://${string(storageSource.bucket)}/${string(storageSource.object)}`,
  ));
  return {buildId, buildSource, startTime, finishTime};
}

async function imageProvenance(
  fetch_: FetchLike,
  projectId: string,
  accessToken: string,
  image: string,
  buildWindow: {startTime: string; finishTime: string},
): Promise<{imageBuildId: string; imageSource: string}> {
  const match = image.match(
    /^([a-z0-9-]+-docker\.pkg\.dev)\/([^/]+)\/([^/]+)\/(.+)@(sha256:[0-9a-f]{64})$/,
  );
  assert.ok(match !== null);
  const [, host, imageProject, repository, packageName, digest] = match;
  assert.equal(imageProject, projectId);
  const base = `https://${host}/v2/${imageProject}/${repository}/${packageName}`;
  const metadataName = `projects/${imageProject}/locations/${host.slice(
    0, -'-docker.pkg.dev'.length)}/repositories/${repository}/dockerImages/${
    encodeURIComponent(packageName)}%40${digest}`;
  const [manifest, metadata] = await Promise.all([
    json(fetch_, `${base}/manifests/${digest}`, accessToken, projectId),
    json(fetch_, `https://artifactregistry.googleapis.com/v1/${metadataName}`,
      accessToken, projectId),
  ]);
  assert.equal(metadata.uri, image);
  assert.deepEqual(array(metadata.tags).map(string).sort(), ['latest', 'version_1']);
  const uploadTime = Date.parse(string(metadata.uploadTime));
  const updateTime = Date.parse(string(metadata.updateTime));
  assert.equal(uploadTime >= Date.parse(buildWindow.startTime), true);
  assert.equal(uploadTime <= Date.parse(buildWindow.finishTime), true);
  assert.equal(updateTime >= uploadTime, true);
  assert.equal(updateTime <= Date.parse(buildWindow.finishTime), true);
  assert.equal(manifest.schemaVersion, 2);
  const config = record(manifest.config);
  const configDigest = string(config.digest);
  assert.match(configDigest, /^sha256:[0-9a-f]{64}$/);
  const response = await fetchWithRetry(
    fetch_, `${base}/blobs/${configDigest}`,
    {headers: authenticatedHeaders(accessToken, projectId)},
    [200], 'immutable Function image configuration download',
  );
  const imageConfig = record(await response.json());
  const labels = stringRecord(record(imageConfig.config).Labels);
  return {
    imageBuildId: string(labels['google.build-id']),
    imageSource: string(labels['google.source']),
  };
}

async function functionIam(
  fetch_: FetchLike,
  projectId: string,
  accessToken: string,
  region: string,
  name: string,
): Promise<IamBinding[]> {
  return normalizedIamBindings(await json(
    fetch_,
    `https://cloudfunctions.googleapis.com/v2/projects/${projectId}/locations/${region}/functions/${name}:getIamPolicy?options.requestedPolicyVersion=3`,
    accessToken,
    projectId,
  ));
}

function revisionName(
  value: unknown,
  projectId: string,
  region: string,
  service: string,
): string {
  const prefix = `projects/${projectId}/locations/${region}/services/${service}/revisions/`;
  const name = string(value);
  assert.equal(name.startsWith(prefix), true);
  const revision = name.slice(prefix.length);
  assert.match(revision, /^[a-z0-9-]+$/);
  return revision;
}

function normalizeRunConfiguration(
  value: Record<string, unknown>,
  projectId: string,
  region: string,
  name: string,
): Record<string, unknown> {
  const template = record(value.template);
  const containers = array(template.containers).map((containerValue) => {
    const container = record(containerValue);
    const image = string(container.image);
    assert.match(
      image,
      new RegExp(`^${region}-docker\\.pkg\\.dev/${projectId}/gcf-artifacts/[A-Za-z0-9_.@:-]+$`),
    );
    return {
      name: string(container.name),
      image,
      baseImageUri: string(container.baseImageUri),
      environmentNames: array(container.env ?? []).map((entry) =>
        string(record(entry).name)).sort(),
      resources: record(container.resources),
      ports: array(container.ports ?? []).map(record),
      startupProbe: record(container.startupProbe),
      volumeMounts: array(container.volumeMounts ?? []).map(record),
    };
  });
  return {
    ingress: string(value.ingress),
    customAudiences: array(value.customAudiences ?? []).map(string).sort(),
    binaryAuthorization: record(value.binaryAuthorization ?? {}),
    iapEnabled: value.iapEnabled === true,
    scaling: record(value.scaling ?? {}),
    template: {
      revision: string(template.revision),
      serviceAccount: string(template.serviceAccount),
      timeout: string(template.timeout),
      maxInstanceRequestConcurrency: number(template.maxInstanceRequestConcurrency),
      scaling: record(template.scaling ?? {}),
      vpcAccess: record(template.vpcAccess ?? {}),
      encryptionKey: nullableString(template.encryptionKey),
      sessionAffinity: template.sessionAffinity === true,
      executionEnvironment: nullableString(template.executionEnvironment),
      gpuZonalRedundancyDisabled: template.gpuZonalRedundancyDisabled === true,
      healthCheckDisabled: template.healthCheckDisabled === true,
      volumes: array(template.volumes ?? []).map(record),
      containers,
    },
    expectedService: `projects/${projectId}/locations/${region}/services/${name}`,
  };
}

async function runSecurity(
  fetch_: FetchLike,
  projectId: string,
  accessToken: string,
  region: string,
  name: string,
): Promise<{
  iam: IamBinding[];
  invokerIamDisabled: boolean;
  latestReadyRevision: string;
  latestCreatedRevision: string;
  configuration: Record<string, unknown>;
  traffic: Record<string, unknown>[];
  trafficStatuses: Record<string, unknown>[];
  configuredImage: string;
  revisionImage: string;
}> {
  const [policy, service] = await Promise.all([
    json(
      fetch_,
      `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/services/${name}:getIamPolicy?options.requestedPolicyVersion=3`,
      accessToken,
      projectId,
    ),
    json(
      fetch_,
      `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/services/${name}`,
      accessToken,
      projectId,
    ),
  ]);
  assert.equal(
    service.name,
    `projects/${projectId}/locations/${region}/services/${name}`,
  );
  const disabled = service.invokerIamDisabled;
  assert.ok(disabled === undefined || typeof disabled === 'boolean');
  const latestReadyRevision = revisionName(
    service.latestReadyRevision, projectId, region, name,
  );
  const revision = await json(
    fetch_,
    `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/services/${name}/revisions/${latestReadyRevision}`,
    accessToken,
    projectId,
  );
  assert.equal(
    revision.name,
    `projects/${projectId}/locations/${region}/services/${name}/revisions/${latestReadyRevision}`,
  );
  const configuredContainers = array(record(service.template).containers).map(record);
  const revisionContainers = array(revision.containers).map(record);
  assert.equal(configuredContainers.length, 1);
  assert.equal(revisionContainers.length, 1);
  const configuredImage = string(configuredContainers[0].image);
  const revisionImage = string(revisionContainers[0].image);
  assert.match(revisionImage, new RegExp(
    `^${region}-docker\\.pkg\\.dev/${projectId}/gcf-artifacts/[A-Za-z0-9_.%-]+@sha256:[0-9a-f]{64}$`,
  ));
  return {
    iam: normalizedIamBindings(policy),
    invokerIamDisabled: disabled === true,
    latestReadyRevision,
    latestCreatedRevision: revisionName(
      service.latestCreatedRevision, projectId, region, name,
    ),
    configuration: normalizeRunConfiguration(service, projectId, region, name),
    traffic: sortedCanonical(array(service.traffic ?? []).map(record)),
    trafficStatuses: sortedCanonical(array(service.trafficStatuses ?? []).map(record)),
    configuredImage,
    revisionImage,
  };
}

function userEnvironmentVariables(
  value: unknown,
  target: DeploymentTarget,
  generation: Generation,
  function_: Pick<ExpectedFunction, 'name' | 'region' | 'entryPoint' | 'event'>,
): Record<string, string> {
  const environment = stringRecord(value);
  assert.equal(environment.GCLOUD_PROJECT, target.projectId);
  assert.deepEqual(record(JSON.parse(environment.FIREBASE_CONFIG)), target.firebaseConfig);
  assert.equal(
    environment.EVENTARC_CLOUD_EVENT_SOURCE,
    `projects/${target.projectId}/locations/${function_.region}/${
      generation === 'GEN_2' ? 'services' : 'functions'
    }/${function_.name}`,
  );
  const reserved = ['GCLOUD_PROJECT', 'FIREBASE_CONFIG', 'EVENTARC_CLOUD_EVENT_SOURCE'];
  if (generation === 'GEN_2') {
    assert.equal(environment.FUNCTION_TARGET, function_.entryPoint);
    assert.equal(environment.LOG_EXECUTION_ID, 'true');
    reserved.push('FUNCTION_TARGET', 'LOG_EXECUTION_ID');
    if (function_.event !== null) {
      assert.equal(environment.FUNCTION_REGION, function_.region);
      assert.equal(environment.FUNCTION_SIGNATURE_TYPE, 'cloudevent');
      reserved.push('FUNCTION_REGION', 'FUNCTION_SIGNATURE_TYPE');
    }
  }
  return Object.fromEntries(Object.entries(environment)
    .filter(([key]) => !reserved.includes(key)));
}

function normalizedFunctionUri(
  value: unknown,
  generation: Generation,
  projectId: string,
  region: string,
  name: string,
  access: FunctionAccess,
): string | null {
  if (value === undefined) {
    assert.equal(generation, 'GEN_1');
    assert.equal(access, 'event');
    return null;
  }
  const url = new URL(string(value));
  assert.equal(url.protocol, 'https:');
  assert.equal(url.search, '');
  assert.equal(url.hash, '');
  if (generation === 'GEN_2') {
    assert.equal(url.pathname, '/');
    assert.match(url.hostname, new RegExp(`^${name}-[a-z0-9]+-[a-z]+\\.a\\.run\\.app$`));
    return 'RUN_APP';
  }
  assert.equal(url.hostname, `${region}-${projectId}.cloudfunctions.net`);
  assert.equal(url.pathname, `/${name}`);
  return url.toString();
}

async function deployedFunctions(
  fetch_: FetchLike,
  target: DeploymentTarget,
  accessToken: string,
): Promise<ObservedFunction[]> {
  const values = await listApi(
    fetch_,
    `https://cloudfunctions.googleapis.com/v2/projects/${target.projectId}/locations/-/functions`,
    'functions',
    accessToken,
    target.projectId,
  );
  return Promise.all(values.map(async (value) => {
    const resource = resourceParts(string(value.name), target.projectId);
    const environment = value.environment;
    assert.ok(environment === undefined || environment === 'GEN_1' || environment === 'GEN_2');
    const generation: Generation = environment === 'GEN_2' ? 'GEN_2' : 'GEN_1';
    const build = record(value.buildConfig);
    const service = record(value.serviceConfig);
    const labels = record(value.labels ?? {});
    const eventValue = value.eventTrigger;
    const eventTrigger = eventValue === undefined ? null : record(eventValue);
    const event: FunctionEvent | null = eventTrigger === null ? null : {
      type: string(eventTrigger.eventType),
      retry: eventTrigger.retryPolicy === 'RETRY_POLICY_RETRY',
      filters: normalizeFilters(array(eventTrigger.eventFilters ?? []).map((filterValue) => {
        const filter = record(filterValue);
        return {
          attribute: string(filter.attribute),
          value: string(filter.value),
          ...(filter.operator === undefined ? {} : {operator: string(filter.operator)}),
        };
      })),
    };
    const access: FunctionAccess = event !== null ? 'event' :
      labels['deployment-callable'] === 'true' ? 'callable' : 'http';
    const secrets = array(service.secretEnvironmentVariables ?? [])
      .map((secretValue) => {
        const secret = record(secretValue);
        return {
          key: string(secret.key),
          projectId: string(secret.projectId),
          secret: string(secret.secret),
          version: string(secret.version),
        };
      }).sort((left, right) => canonical(left).localeCompare(canonical(right)));
    const function_ = target.functions.find((expected) =>
      functionKey(expected) === functionKey(resource));
    const environmentFunction = function_ ?? {
      ...resource,
      entryPoint: string(build.entryPoint),
      event,
    };
    const storageSource = generation === 'GEN_2' ?
      record(record(build.source).storageSource) : null;
    if (storageSource !== null) {
      const source = storageSource;
      const resolved = record(record(build.sourceProvenance).resolvedStorageSource);
      assert.deepEqual(source, resolved);
      assert.match(string(source.bucket), /^[a-z0-9][a-z0-9._-]+$/);
      assert.match(string(source.object), /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/);
      assert.match(string(source.generation), /^[1-9][0-9]*$/);
    }
    const [sourceFiles, functionIam_, run, buildSecurity] = await Promise.all([
      functionSourceFiles(
        fetch_, target.projectId, accessToken, resource.region, resource.name, generation,
        storageSource,
      ),
      functionIam(fetch_, target.projectId, accessToken, resource.region, resource.name),
      generation === 'GEN_1' ? Promise.resolve(null) :
        runSecurity(fetch_, target.projectId, accessToken, resource.region, resource.name),
      generation === 'GEN_1' ? Promise.resolve(null) : functionBuild(
        fetch_, target, accessToken, resource.region, build.build, storageSource!,
      ),
    ]);
    const provenance = run === null ? null : await imageProvenance(
      fetch_, target.projectId, accessToken, run.revisionImage, buildSecurity!,
    );
    return {
      ...resource,
      generation,
      entryPoint: string(build.entryPoint),
      access,
      timeoutSeconds: number(service.timeoutSeconds),
      maxInstances: service.maxInstanceCount === undefined ? null : number(service.maxInstanceCount),
      serviceAccount: string(service.serviceAccountEmail),
      secrets,
      functionIam: functionIam_,
      runIam: run?.iam ?? null,
      event,
      releaseId: labels['book-tracker-release'] === undefined ? null :
        string(labels['book-tracker-release']),
      state: string(value.state),
      allTrafficOnLatestRevision: generation === 'GEN_2' ?
        service.allTrafficOnLatestRevision === true : null,
      revision: generation === 'GEN_2' ? string(service.revision) : null,
      sourceFiles,
      runtime: string(build.runtime),
      buildEnvironmentVariables: stringRecord(build.environmentVariables),
      userEnvironmentVariables: userEnvironmentVariables(
        service.environmentVariables,
        target,
        generation,
        environmentFunction,
      ),
      ingressSettings: string(service.ingressSettings),
      availableMemory: string(service.availableMemory),
      availableCpu: nullableString(service.availableCpu),
      maxInstanceRequestConcurrency: number(service.maxInstanceRequestConcurrency),
      minInstances: nullableNumber(service.minInstanceCount),
      vpcConnector: nullableString(service.vpcConnector),
      vpcConnectorEgressSettings: nullableString(service.vpcConnectorEgressSettings),
      secretVolumes: array(service.secretVolumes ?? []).map(record),
      securityLevel: nullableString(service.securityLevel),
      binaryAuthorizationPolicy: nullableString(service.binaryAuthorizationPolicy),
      kmsKeyName: nullableString(value.kmsKeyName),
      invokerIamDisabled: run?.invokerIamDisabled ?? null,
      dockerRegistry: string(build.dockerRegistry),
      dockerRepository: nullableString(build.dockerRepository),
      automaticUpdatePolicy: record(build.automaticUpdatePolicy ?? {}),
      buildServiceAccount: nullableString(build.serviceAccount),
      workerPool: nullableString(build.workerPool),
      uri: normalizedFunctionUri(
        service.uri,
        generation,
        target.projectId,
        resource.region,
        resource.name,
        access,
      ),
      serviceResource: nullableString(service.service),
      runLatestReadyRevision: run?.latestReadyRevision ?? null,
      runLatestCreatedRevision: run?.latestCreatedRevision ?? null,
      runConfiguration: run?.configuration ?? null,
      runTraffic: run?.traffic ?? null,
      runTrafficStatuses: run?.trafficStatuses ?? null,
      configuredImage: run?.configuredImage ?? null,
      revisionImage: run?.revisionImage ?? null,
      buildId: buildSecurity?.buildId ?? null,
      buildSource: buildSecurity?.buildSource ?? null,
      imageBuildId: provenance?.imageBuildId ?? null,
      imageSource: provenance?.imageSource ?? null,
    };
  }));
}

async function deployedIndexes(
  fetch_: FetchLike,
  target: DeploymentTarget,
  accessToken: string,
): Promise<ExpectedIndex[]> {
  const values = await listApi(
    fetch_,
    `https://firestore.googleapis.com/v1/projects/${target.projectId}/databases/(default)/collectionGroups/-/indexes`,
    'indexes',
    accessToken,
    target.projectId,
  );
  return values.map((value) => {
    assert.equal(value.state, 'READY');
    const name = firestoreResourceParts(
      string(value.name), target.projectId, ['collectionGroups', 'indexes'],
    );
    return normalizeIndex({
      collectionGroup: string(name[5]),
      queryScope: string(value.queryScope),
      fields: array(value.fields).map((fieldValue) => {
        const field = record(fieldValue);
        return {fieldPath: string(field.fieldPath), order: string(field.order)};
      }),
    });
  });
}

async function deployedTtls(
  fetch_: FetchLike,
  target: DeploymentTarget,
  accessToken: string,
): Promise<ExpectedTtl[]> {
  const values = await listApi(
    fetch_,
    `https://firestore.googleapis.com/v1/projects/${target.projectId}/databases/(default)/collectionGroups/-/fields?filter=ttlConfig%3A*`,
    'fields',
    accessToken,
    target.projectId,
  );
  return values.map((value) => {
    assert.equal(record(value.ttlConfig).state, 'ACTIVE');
    const name = firestoreResourceParts(
      string(value.name), target.projectId, ['collectionGroups', 'fields'],
    );
    return {collectionGroup: string(name[5]), fieldPath: string(name[7])};
  });
}

async function deployedAncestorSecurity(
  fetch_: FetchLike,
  target: DeploymentTarget,
  accessToken: string,
): Promise<{resources: string[]; policySha256: string; policies: IamResource[]}> {
  const project = await json(
    fetch_,
    `https://cloudresourcemanager.googleapis.com/v3/projects/${target.projectId}`,
    accessToken,
    target.projectId,
  );
  assert.equal(project.projectId, target.projectId);
  assert.equal(project.name, `projects/${target.projectNumber}`);
  const resources = [`projects/${target.projectId}`];
  let parent = project.parent === undefined ? null : string(project.parent);
  while (parent !== null) {
    assert.match(parent, /^(?:folders|organizations)\/[0-9]+$/);
    resources.push(parent);
    if (parent.startsWith('organizations/')) break;
    const folder = await json(
      fetch_,
      `https://cloudresourcemanager.googleapis.com/v3/${parent}`,
      accessToken,
      target.projectId,
    );
    assert.equal(folder.name, parent);
    parent = folder.parent === undefined ? null : string(folder.parent);
  }
  const policies = await Promise.all(resources.map(async (resource) => {
    const version = resource.startsWith('projects/') ? 'v1' : 'v3';
    const policy = await json(
      fetch_,
      `https://cloudresourcemanager.googleapis.com/${version}/${resource}:getIamPolicy`,
      accessToken,
      target.projectId,
      {
        method: 'POST',
        body: JSON.stringify({options: {requestedPolicyVersion: 3}}),
      },
    );
    return {name: resource, iam: normalizedIamBindings(policy)};
  }));
  const legacyPolicies = policies.map(({name, iam}) => ({resource: name, bindings: iam}));
  return {resources, policySha256: sha256Canonical(legacyPolicies), policies};
}

function assertExactKeys(value: Record<string, unknown>, allowed: string[]): void {
  assert.deepEqual(Object.keys(value).sort(), [...allowed].sort());
}

function hostingPattern(value: Record<string, unknown>): {glob: string} | {regex: string} {
  if (value.glob !== undefined) {
    assert.equal(value.regex, undefined);
    return {glob: string(value.glob)};
  }
  assert.equal(value.glob, undefined);
  return {regex: string(value.regex)};
}

function normalizeActiveHostingConfig(
  value: Record<string, unknown>,
  versionId: string,
): {
  config: Record<string, unknown>;
  pinnedTags: Array<{serviceId: string; region: string; tag: string}>;
} {
  const allowed = ['headers', 'redirects', 'rewrites', 'cleanUrls',
    'trailingSlashBehavior', 'i18n'];
  assert.ok(Object.keys(value).every((key) => allowed.includes(key)));
  const pinnedTags: Array<{serviceId: string; region: string; tag: string}> = [];
  const headers = array(value.headers ?? []).map((headerValue) => {
    const header = record(headerValue);
    assertExactKeys(header, ['headers', Object.hasOwn(header, 'glob') ? 'glob' : 'regex']);
    const entries = record(header.headers);
    for (const [key, headerValue_] of Object.entries(entries)) string(headerValue_);
    return {...hostingPattern(header), headers: entries};
  });
  const redirects = array(value.redirects ?? []).map((redirectValue) => {
    const redirect = record(redirectValue);
    assertExactKeys(redirect, [
      'statusCode', 'location', Object.hasOwn(redirect, 'glob') ? 'glob' : 'regex',
    ]);
    return {
      ...hostingPattern(redirect),
      statusCode: number(redirect.statusCode),
      location: string(redirect.location),
    };
  });
  const rewrites = array(value.rewrites ?? []).map((rewriteValue) => {
    const rewrite = record(rewriteValue);
    const pattern = hostingPattern(rewrite);
    if (rewrite.path !== undefined) {
      assertExactKeys(rewrite, [
        'path', Object.hasOwn(rewrite, 'glob') ? 'glob' : 'regex',
      ]);
      return {...pattern, path: string(rewrite.path)};
    }
    if (rewrite.run !== undefined) {
      assertExactKeys(rewrite, [
        'run', Object.hasOwn(rewrite, 'glob') ? 'glob' : 'regex',
      ]);
      const run = record(rewrite.run);
      assert.ok(Object.keys(run).every((key) =>
        ['serviceId', 'region', 'tag'].includes(key)));
      const tag = run.tag;
      const serviceId = string(run.serviceId);
      const region = run.region === undefined ? 'us-central1' : string(run.region);
      if (tag !== undefined) pinnedTags.push({serviceId, region, tag: string(tag)});
      return {
        ...pattern,
        run: {
          serviceId,
          region,
          pinTag: tag === undefined ? false : string(tag) === `fh-${versionId}`,
        },
      };
    }
    assertExactKeys(rewrite, [
      'function',
      ...(rewrite.functionRegion === undefined ? [] : ['functionRegion']),
      Object.hasOwn(rewrite, 'glob') ? 'glob' : 'regex',
    ]);
    return {
      ...pattern,
      function: string(rewrite.function),
      functionRegion: rewrite.functionRegion === undefined ? 'us-central1' :
        string(rewrite.functionRegion),
    };
  });
  return {
    config: {
      headers,
      redirects,
      rewrites,
      ...(value.cleanUrls === undefined ? {} : {cleanUrls: boolean(value.cleanUrls)}),
      ...(value.trailingSlashBehavior === undefined ? {} : {
        trailingSlashBehavior: string(value.trailingSlashBehavior),
      }),
      ...(value.i18n === undefined ? {} : {i18n: record(value.i18n)}),
    },
    pinnedTags,
  };
}

function reviewedHostingConfig(
  firebaseJson: Record<string, unknown>,
  target: DeploymentTarget,
): Record<string, unknown> {
  const hosting = record(firebaseJson.hosting);
  assert.equal(hosting.site, target.hostingSite);
  assert.equal(hosting.public, 'public');
  const headers = array(hosting.headers ?? []).map((headerValue) => {
    const header = record(headerValue);
    const headerMap = Object.fromEntries(array(header.headers).map((entryValue) => {
      const entry = record(entryValue);
      return [string(entry.key), string(entry.value)];
    }));
    return {glob: string(header.source), headers: headerMap};
  });
  const redirects = array(hosting.redirects ?? []).map((redirectValue) => {
    const redirect = record(redirectValue);
    return {
      glob: string(redirect.source),
      statusCode: number(redirect.type),
      location: string(redirect.destination),
    };
  });
  const rewrites = array(hosting.rewrites ?? []).map((rewriteValue) => {
    const rewrite = record(rewriteValue);
    const pattern = {glob: string(rewrite.source)};
    if (rewrite.destination !== undefined) {
      return {...pattern, path: string(rewrite.destination)};
    }
    const function_ = record(rewrite.function);
    const functionId = string(function_.functionId);
    const deployedFunction = target.functions.find(({name}) => name === functionId);
    assert.notEqual(deployedFunction, undefined);
    const region = string(function_.region);
    assert.equal(region, deployedFunction!.region);
    if (deployedFunction!.generation === 'GEN_2') {
      return {
        ...pattern,
        run: {
          serviceId: functionId,
          region,
          pinTag: function_.pinTag === true,
        },
      };
    }
    assert.equal(function_.pinTag, undefined);
    return {...pattern, function: functionId, functionRegion: region};
  });
  return {
    headers,
    redirects,
    rewrites,
    ...(hosting.cleanUrls === undefined ? {} : {cleanUrls: boolean(hosting.cleanUrls)}),
    ...(hosting.trailingSlash === undefined ? {} : {
      trailingSlashBehavior: boolean(hosting.trailingSlash) ? 'ADD' : 'REMOVE',
    }),
    ...(hosting.i18n === undefined ? {} : {i18n: record(hosting.i18n)}),
  };
}

async function activeHostingVersion(
  fetch_: FetchLike,
  target: DeploymentTarget,
  accessToken: string,
): Promise<{
  files: Record<string, string>;
  config: Record<string, unknown>;
  pinnedRevisions: Record<string, string>;
  pinnedTags: Record<string, string>;
}> {
  const parent = `sites/${target.hostingSite}/channels/live`;
  const releases = await json(
    fetch_,
    `https://firebasehosting.googleapis.com/v1beta1/${parent}/releases?pageSize=1`,
    accessToken,
    target.projectId,
  );
  const values = array(releases.releases);
  assert.equal(values.length, 1);
  const release = record(values[0]);
  assert.match(string(release.name), new RegExp(`^${parent}/releases/[0-9]+$`));
  assert.equal(release.type, 'DEPLOY');
  const version = record(release.version);
  const versionName = string(version.name);
  const versionPrefix = `sites/${target.hostingSite}/versions/`;
  assert.equal(versionName.startsWith(versionPrefix), true);
  const versionId = versionName.slice(versionPrefix.length);
  assert.match(versionId, /^[A-Za-z0-9_-]+$/);
  assert.equal(version.status, 'FINALIZED');
  const versionFiles = await listApi(
    fetch_,
    `https://firebasehosting.googleapis.com/v1beta1/${versionName}/files?pageSize=1000&status=ACTIVE`,
    'files',
    accessToken,
    target.projectId,
  );
  const files = Object.fromEntries(versionFiles.map((file) => {
    assert.equal(file.status, 'ACTIVE');
    const path = string(file.path);
    assert.match(path, /^\/(?!\/).+/);
    const hash = string(file.hash);
    assert.match(hash, /^[0-9a-f]{64}$/);
    return [path.slice(1), hash];
  }));
  assert.equal(Object.keys(files).length, versionFiles.length, 'duplicate Hosting path');
  assert.equal(string(version.fileCount), String(versionFiles.length));
  const normalized = normalizeActiveHostingConfig(record(version.config), versionId);
  const pinnedRevisions = Object.fromEntries(await Promise.all(
    normalized.pinnedTags.map(async ({serviceId, region, tag}) => {
      assert.equal(tag, `fh-${versionId}`);
      const service = await json(
        fetch_,
        `https://run.googleapis.com/v2/projects/${target.projectId}/locations/${region}/services/${serviceId}`,
        accessToken,
        target.projectId,
      );
      assert.equal(
        service.name,
        `projects/${target.projectId}/locations/${region}/services/${serviceId}`,
      );
      const matches = array(service.traffic ?? []).map(record)
        .filter((traffic) => traffic.tag === tag);
      assert.equal(matches.length, 1, `Hosting tag ${tag} must resolve exactly once`);
      return [`${region}/${serviceId}`, string(matches[0].revision)] as const;
    }),
  ));
  assert.equal(Object.keys(pinnedRevisions).length, normalized.pinnedTags.length);
  const pinnedTags = Object.fromEntries(normalized.pinnedTags.map(({serviceId, region, tag}) =>
    [`${region}/${serviceId}`, tag]));
  assert.equal(Object.keys(pinnedTags).length, normalized.pinnedTags.length);
  return {files, config: normalized.config, pinnedRevisions, pinnedTags};
}

async function deployedHosting(
  fetch_: FetchLike,
  target: DeploymentTarget,
  hostingFiles: Record<string, HostingArtifact>,
  accessToken: string,
): Promise<ObservedHosting> {
  const [active, sites, channels, domains] = await Promise.all([
    activeHostingVersion(fetch_, target, accessToken),
    listApi(
      fetch_,
      `https://firebasehosting.googleapis.com/v1beta1/projects/${target.projectId}/sites?pageSize=100`,
      'sites',
      accessToken,
      target.projectId,
    ),
    listApi(
      fetch_,
      `https://firebasehosting.googleapis.com/v1beta1/sites/${target.hostingSite}/channels?pageSize=100`,
      'channels',
      accessToken,
      target.projectId,
    ),
    listApi(
      fetch_,
      `https://firebasehosting.googleapis.com/v1beta1/sites/${target.hostingSite}/domains?pageSize=100`,
      'domains',
      accessToken,
      target.projectId,
    ),
  ]);
  const normalizedSites = sites.map((site) => {
    const prefix = `projects/${target.projectId}/sites/`;
    const resourceName = string(site.name);
    assert.equal(resourceName.startsWith(prefix), true);
    return {name: resourceName.slice(prefix.length), defaultUrl: string(site.defaultUrl)};
  });
  const targetSites = normalizedSites.filter(({name}) => name === target.hostingSite);
  assert.equal(targetSites.length, 1);
  const normalizedChannels = channels.map((channel) => {
    const prefix = `sites/${target.hostingSite}/channels/`;
    const name = string(channel.name);
    assert.equal(name.startsWith(prefix), true);
    return name.slice(prefix.length);
  }).sort();
  const normalizedDomains = domains.map((domain) => {
    assert.equal(domain.site, target.hostingSite);
    assert.equal(domain.status, 'DOMAIN_ACTIVE');
    return string(domain.domainName);
  }).sort();
  const files: Record<string, Record<string, string>> = {};
  const profileReleaseIds: Record<string, string | null> = {};
  const profileProbeSha256: Record<string, string> = {};
  const sitemapReleaseIds: Record<string, string | null> = {};
  const allFiles = {...hostingFiles, ...target.generatedHostingFiles};
  for (const origin of target.hostingOrigins) {
    const originFiles: Record<string, string> = {};
    await Promise.all(Object.keys(allFiles).map(async (path) => {
      const response = await fetchWithRetry(fetch_, `${origin}/${path}`, undefined);
      originFiles[path] = sha256(new Uint8Array(await response.arrayBuffer()));
    }));
    files[origin] = originFiles;
    const profile = await fetchWithRetry(
      fetch_, `${origin}/profiles/__deployment_integrity_probe__`, undefined, [404],
    );
    profileReleaseIds[origin] = profile.headers.get(RELEASE_HEADER);
    profileProbeSha256[origin] = sha256(new Uint8Array(await profile.arrayBuffer()));
    const sitemap = await fetchWithRetry(fetch_, `${origin}/sitemap.xml`, undefined);
    sitemapReleaseIds[origin] = sitemap.headers.get(RELEASE_HEADER);
  }
  return {
    files,
    activeVersionFiles: active.files,
    activeVersionConfig: active.config,
    sites: normalizedSites.map(({name}) => name).sort(),
    defaultUrl: targetSites[0].defaultUrl,
    channels: normalizedChannels,
    customDomains: normalizedDomains,
    pinnedRevisions: active.pinnedRevisions,
    pinnedTags: active.pinnedTags,
    profileReleaseIds,
    profileProbeSha256,
    sitemapReleaseIds,
  };
}

function normalizedAuthConfig(value: Record<string, unknown>): Record<string, unknown> {
  assert.ok(Object.keys(value).every((key) => [
    'name', 'signIn', 'notification', 'quota', 'monitoring', 'multiTenant',
    'authorizedDomains', 'subtype', 'client', 'mfa', 'blockingFunctions',
    'smsRegionConfig', 'mobileLinksConfig', 'defaultHostingSite', 'recaptchaConfig',
    'emailPrivacyConfig', 'passwordPolicyConfig', 'autodeleteAnonymousUsers',
  ].includes(key)));
  const signIn = record(value.signIn ?? {});
  const client = record(value.client ?? {});
  return {
    authorizedDomains: array(value.authorizedDomains ?? []).map(string).sort(),
    signIn: Object.fromEntries(Object.entries(signIn)
      .filter(([key]) => key !== 'hashConfig')
      .sort(([left], [right]) => left.localeCompare(right))),
    signInHashConfigSha256: sha256Canonical(signIn.hashConfig ?? {}),
    notificationSha256: sha256Canonical(value.notification ?? {}),
    quota: record(value.quota ?? {}),
    mfa: record(value.mfa ?? {}),
    multiTenant: record(value.multiTenant ?? {}),
    client: {
      permissions: record(client.permissions ?? {}),
      firebaseSubdomain: nullableString(client.firebaseSubdomain),
      apiKeySha256: sha256Canonical(client.apiKey ?? null),
    },
    blockingFunctions: record(value.blockingFunctions ?? {}),
    monitoring: record(value.monitoring ?? {}),
    smsRegionConfig: record(value.smsRegionConfig ?? {}),
    mobileLinksConfig: record(value.mobileLinksConfig ?? {}),
    defaultHostingSite: nullableString(value.defaultHostingSite),
    subtype: nullableString(value.subtype),
    recaptchaConfig: record(value.recaptchaConfig ?? {}),
    emailPrivacyConfig: record(value.emailPrivacyConfig ?? {}),
    passwordPolicyConfig: record(value.passwordPolicyConfig ?? {}),
    autodeleteAnonymousUsers: value.autodeleteAnonymousUsers === undefined ? null :
      boolean(value.autodeleteAnonymousUsers),
  };
}

function normalizedAuthProviderInventory(
  inventories: Record<string, Record<string, unknown>[]>,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(inventories).sort(([left], [right]) =>
    left.localeCompare(right)).map(([name, values]) => [name, {
    names: values.map((value) => string(value.name)).sort(),
    sha256: sha256Canonical(sortedCanonical(values)),
  }]));
}

function normalizedAcl(values: unknown): Record<string, unknown>[] {
  return sortedCanonical(array(values ?? []).map((value) => {
    const acl = record(value);
    return {
      entity: string(acl.entity),
      role: string(acl.role),
      ...(acl.projectTeam === undefined ? {} : {projectTeam: record(acl.projectTeam)}),
    };
  }));
}

function storageBucketConfiguration(value: Record<string, unknown>): Record<string, unknown> {
  return {
    autoclass: record(value.autoclass ?? {}),
    billing: record(value.billing ?? {}),
    cors: sortedCanonical(array(value.cors ?? []).map(record)),
    customPlacementConfig: record(value.customPlacementConfig ?? {}),
    defaultEventBasedHold: value.defaultEventBasedHold === true,
    encryption: record(value.encryption ?? {}),
    hierarchicalNamespace: record(value.hierarchicalNamespace ?? {}),
    ipFilter: record(value.ipFilter ?? {}),
    lifecycle: record(value.lifecycle ?? {}),
    location: string(value.location),
    locationType: string(value.locationType),
    logging: record(value.logging ?? {}),
    objectRetention: record(value.objectRetention ?? {}),
    retentionPolicy: record(value.retentionPolicy ?? {}),
    rpo: nullableString(value.rpo),
    softDeletePolicy: record(value.softDeletePolicy ?? {}),
    storageClass: string(value.storageClass),
    versioning: record(value.versioning ?? {}),
    website: record(value.website ?? {}),
  };
}

async function identityTenants(
  fetch_: FetchLike,
  target: DeploymentTarget,
  accessToken: string,
): Promise<Record<string, unknown>[]> {
  const url = `https://identitytoolkit.googleapis.com/v2/projects/${target.projectId}/tenants`;
  const response = await fetchWithRetry(fetch_, url, {
    headers: authenticatedHeaders(accessToken, target.projectId),
  }, [200, 400], 'Identity Platform tenant inventory');
  const body = record(await response.json());
  if (response.status === 400) {
    const error = record(body.error);
    assert.equal(error.status, 'INVALID_ARGUMENT');
    assert.equal(error.message, 'INVALID_PROJECT_ID');
    return [];
  }
  assert.deepEqual(body.unreachable ?? [], []);
  assert.ok(body.nextPageToken === undefined || string(body.nextPageToken).trim() === '');
  return array(body.tenants ?? []).map(record);
}

async function iamAt(
  fetch_: FetchLike,
  url: string,
  target: DeploymentTarget,
  accessToken: string,
  method: 'GET' | 'POST' = 'GET',
): Promise<IamBinding[]> {
  return normalizedIamBindings(await json(
    fetch_, url, accessToken, target.projectId,
    method === 'GET' ? undefined : {
      method,
      body: JSON.stringify({options: {requestedPolicyVersion: 3}}),
    },
  ));
}

function normalizedEventarcTrigger(value: Record<string, unknown>): Record<string, unknown> {
  return {
    destination: record(value.destination),
    eventFilters: normalizeFilters(array(value.eventFilters).map((filterValue) => {
      const filter = record(filterValue);
      return {
        attribute: string(filter.attribute),
        value: string(filter.value),
        ...(filter.operator === undefined ? {} : {operator: string(filter.operator)}),
      };
    })),
    transport: record(value.transport),
    labels: record(value.labels ?? {}),
    serviceAccount: string(value.serviceAccount),
    channel: nullableString(value.channel),
    eventDataContentType: nullableString(value.eventDataContentType),
    conditions: record(value.conditions ?? {}),
  };
}

function normalizedPubsubTopic(value: Record<string, unknown>): Record<string, unknown> {
  return {
    labels: record(value.labels ?? {}),
    messageStoragePolicy: record(value.messageStoragePolicy ?? {}),
    schemaSettings: record(value.schemaSettings ?? {}),
    ingestionDataSourceSettings: record(value.ingestionDataSourceSettings ?? {}),
    kmsKeyName: nullableString(value.kmsKeyName),
    messageRetentionDuration: nullableString(value.messageRetentionDuration),
    messageTransforms: sortedCanonical(array(value.messageTransforms ?? []).map(record)),
    state: nullableString(value.state),
  };
}

function normalizedPubsubSubscription(value: Record<string, unknown>): Record<string, unknown> {
  return {
    topic: string(value.topic),
    pushConfig: record(value.pushConfig ?? {}),
    bigQueryConfig: record(value.bigQueryConfig ?? {}),
    cloudStorageConfig: record(value.cloudStorageConfig ?? {}),
    ackDeadlineSeconds: number(value.ackDeadlineSeconds),
    retainAckedMessages: value.retainAckedMessages === true,
    messageRetentionDuration: nullableString(value.messageRetentionDuration),
    labels: record(value.labels ?? {}),
    enableMessageOrdering: value.enableMessageOrdering === true,
    expirationPolicy: record(value.expirationPolicy ?? {}),
    filter: nullableString(value.filter),
    deadLetterPolicy: record(value.deadLetterPolicy ?? {}),
    retryPolicy: record(value.retryPolicy ?? {}),
    detached: value.detached === true,
    enableExactlyOnceDelivery: value.enableExactlyOnceDelivery === true,
    state: nullableString(value.state),
  };
}

async function securedResources(
  fetch_: FetchLike,
  target: DeploymentTarget,
  accessToken: string,
  values: Record<string, unknown>[],
  normalize: (value: Record<string, unknown>) => Record<string, unknown>,
  iamUrl: (name: string) => string,
): Promise<PubsubResourceSecurity[]> {
  return Promise.all(values.map(async (value) => {
    const name = string(value.name);
    return {
      name,
      iam: await iamAt(fetch_, iamUrl(name), target, accessToken),
      configuration: normalize(value),
    };
  }));
}

async function deployedSecurity(
  fetch_: FetchLike,
  target: DeploymentTarget,
  accessToken: string,
  ancestorIamPolicies: IamResource[],
): Promise<ObservedSecurity> {
  const runServicesPromise = listApi(
    fetch_,
    `https://cloudasset.googleapis.com/v1/projects/${target.projectId}:searchAllResources?assetTypes=run.googleapis.com%2FService`,
    'results', accessToken, target.projectId,
  ).then((values) => values.map((value) => {
    const prefix = '//run.googleapis.com/';
    const name = string(value.name);
    assert.equal(name.startsWith(prefix), true);
    return name.slice(prefix.length);
  }).sort());
  const eventarcValuesPromise = listApi(
    fetch_, `https://eventarc.googleapis.com/v1/projects/${target.projectId}/locations/-/triggers`,
    'triggers', accessToken, target.projectId,
  );
  const eventarcPromise = eventarcValuesPromise.then(async (values) =>
    sortedCanonical(await Promise.all(values.map(async (value) => {
      const name = string(value.name);
      return {
        name,
        iam: await iamAt(
          fetch_, `https://eventarc.googleapis.com/v1/${name}:getIamPolicy`, target, accessToken,
        ),
        configuration: normalizedEventarcTrigger(value),
      };
    }))));
  const authPromise = json(
    fetch_,
    `https://identitytoolkit.googleapis.com/admin/v2/projects/${target.projectId}/config`,
    accessToken, target.projectId,
  ).then(normalizedAuthConfig);
  const firebaseRulesReleasesPromise = listApi(
    fetch_, `https://firebaserules.googleapis.com/v1/projects/${target.projectId}/releases`,
    'releases', accessToken, target.projectId,
  ).then((releases) => releases.map((release) => {
    const prefix = `projects/${target.projectId}/releases/`;
    const name = string(release.name);
    assert.equal(name.startsWith(prefix), true);
    return name.slice(prefix.length);
  }).sort());
  const authProvidersPromise = Promise.all([
    [`https://identitytoolkit.googleapis.com/admin/v2/projects/${target.projectId}/defaultSupportedIdpConfigs`, 'defaultSupportedIdpConfigs'],
    [`https://identitytoolkit.googleapis.com/admin/v2/projects/${target.projectId}/oauthIdpConfigs`, 'oauthIdpConfigs'],
    [`https://identitytoolkit.googleapis.com/admin/v2/projects/${target.projectId}/inboundSamlConfigs`, 'inboundSamlConfigs'],
  ].map(async ([url, field]) => [field, await listApi(
    fetch_, url,
    field, accessToken, target.projectId,
  )] as const)).then(async (entries) => normalizedAuthProviderInventory({
    ...Object.fromEntries(entries),
    tenants: await identityTenants(fetch_, target, accessToken),
  }));
  const customRolesPromise = listApi(
    fetch_,
    `https://iam.googleapis.com/v1/projects/${target.projectId}/roles?showDeleted=true&view=FULL`,
    'roles', accessToken, target.projectId,
  ).then((roles) => sortedCanonical(roles.map((role) => {
    const normalized = {
      name: string(role.name),
      title: string(role.title),
      description: nullableString(role.description),
      includedPermissions: array(role.includedPermissions).map(string).sort(),
      stage: string(role.stage),
      deleted: role.deleted === true,
    };
    return normalized;
  })));
  const serviceAccountListPromise = listApi(
    fetch_, `https://iam.googleapis.com/v1/projects/${target.projectId}/serviceAccounts`,
    'accounts', accessToken, target.projectId,
  );
  const serviceAccountsPromise = serviceAccountListPromise.then(async (accounts) => {
    const names = accounts.map((account) => string(account.email)).sort();
    assert.deepEqual(names, target.security.serviceAccounts.map(({name}) => name).sort());
    return Promise.all(names.map(async (name) => {
    const base = `https://iam.googleapis.com/v1/projects/${target.projectId}/serviceAccounts/${encodeURIComponent(name)}`;
    const [iam, keys] = await Promise.all([
      iamAt(fetch_, `${base}:getIamPolicy`, target, accessToken, 'POST'),
      listApi(fetch_, `${base}/keys`, 'keys', accessToken, target.projectId),
    ]);
    const userManagedKeys = sortedCanonical(keys.filter((key) =>
      key.keyType === 'USER_MANAGED').map((key) => ({
      name: string(key.name),
      keyOrigin: string(key.keyOrigin),
      keyType: string(key.keyType),
      disabled: key.disabled === true,
      validAfterTime: string(key.validAfterTime),
      validBeforeTime: string(key.validBeforeTime),
    })));
    return {name, iam, userManagedKeys};
    }));
  });
  const secretListPromise = listApi(
    fetch_, `https://secretmanager.googleapis.com/v1/projects/${target.projectId}/secrets`,
    'secrets', accessToken, target.projectId,
  );
  const secretsPromise = secretListPromise.then(async (secrets) => {
    const names = secrets.map((secret) => string(secret.name).split('/').at(-1)!).sort();
    assert.deepEqual(names, target.security.secrets.map(({name}) => name).sort());
    return Promise.all(target.security.secrets.map(async (expected) => {
      const base = `https://secretmanager.googleapis.com/v1/projects/${target.projectId}/secrets/${expected.name}`;
      const [iam, versions] = await Promise.all([
        iamAt(fetch_, `${base}:getIamPolicy`, target, accessToken),
        listApi(fetch_, `${base}/versions`, 'versions', accessToken, target.projectId),
      ]);
      return {
        name: expected.name,
        iam,
        versions: versions.map((version) => ({
          version: string(version.name).split('/').at(-1)!,
          state: string(version.state),
        })).sort((left, right) => left.version.localeCompare(right.version)),
      };
    }));
  });
  const repositoriesPromise = Promise.all(target.security.artifactRepositories.map(
    async ({name}) => {
      const [repository, iam] = await Promise.all([
        json(
          fetch_, `https://artifactregistry.googleapis.com/v1/${name}`,
          accessToken, target.projectId,
        ),
        iamAt(
          fetch_, `https://artifactregistry.googleapis.com/v1/${name}:getIamPolicy`, target,
          accessToken,
        ),
      ]);
      assert.equal(repository.name, name);
      assert.equal(repository.format, 'DOCKER');
      return {name, iam};
    },
  ));
  const pubsubTopicsPromise = listApi(
    fetch_, `https://pubsub.googleapis.com/v1/projects/${target.projectId}/topics`,
    'topics', accessToken, target.projectId,
  ).then((values) => securedResources(
    fetch_, target, accessToken, values, normalizedPubsubTopic,
    (name) => `https://pubsub.googleapis.com/v1/${name}:getIamPolicy`,
  )).then(sortedCanonical);
  const pubsubSubscriptionsPromise = listApi(
    fetch_, `https://pubsub.googleapis.com/v1/projects/${target.projectId}/subscriptions`,
    'subscriptions', accessToken, target.projectId,
  ).then((values) => securedResources(
    fetch_, target, accessToken, values, normalizedPubsubSubscription,
    (name) => `https://pubsub.googleapis.com/v1/${name}:getIamPolicy`,
  )).then(sortedCanonical);
  const bucketsPromise = listApi(
    fetch_, `https://storage.googleapis.com/storage/v1/b?project=${target.projectId}&projection=full`,
    'items', accessToken, target.projectId,
  ).then(async (buckets) => {
    const byName = new Map(buckets.map((bucket) => [string(bucket.name), bucket]));
    const expectedNames = target.security.storageBuckets.map(({name}) => name).sort();
    assert.deepEqual([...byName.keys()].sort(), expectedNames);
    return Promise.all(expectedNames.map(async (name) => {
        const bucket = byName.get(name)!;
        const iam = await iamAt(
          fetch_, `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(name)}/iam?optionsRequestedPolicyVersion=3`, target,
          accessToken,
        );
        const configuration = record(bucket.iamConfiguration ?? {});
        const uniformBucketLevelAccess =
          record(configuration.uniformBucketLevelAccess ?? {}).enabled === true;
        const objectAcls = uniformBucketLevelAccess ? [] : await listApi(
          fetch_,
          `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(name)}/o?projection=full&versions=true`,
          'items', accessToken, target.projectId,
        ).then((objects) => sortedCanonical(objects.map((object) => ({
          name: string(object.name),
          generation: string(object.generation),
          acl: normalizedAcl(object.acl),
        }))));
        return {
          name,
          iam,
          publicAccessPrevention: nullableString(configuration.publicAccessPrevention) ?? 'inherited',
          uniformBucketLevelAccess,
          bucketAcl: uniformBucketLevelAccess ? [] : normalizedAcl(bucket.acl),
          defaultObjectAcl: uniformBucketLevelAccess ? [] : normalizedAcl(bucket.defaultObjectAcl),
          objectAclsSha256: sha256Canonical(objectAcls),
          configurationSha256: sha256Canonical(storageBucketConfiguration(bucket)),
        };
      }));
  });
  const [runServices, eventarcTriggers, authConfig, authProviders, firebaseRulesReleases,
    customRoles, serviceAccounts,
    secrets, artifactRepositories, pubsubTopics, pubsubSubscriptions, storageBuckets] =
    await Promise.all([
      runServicesPromise, eventarcPromise, authPromise, authProvidersPromise,
      firebaseRulesReleasesPromise, customRolesPromise,
      serviceAccountsPromise, secretsPromise, repositoriesPromise, pubsubTopicsPromise,
      pubsubSubscriptionsPromise, bucketsPromise,
  ]);
  return {
    authConfig,
    ancestorIamPolicies,
    customRoles,
    serviceAccounts: sortedCanonical(serviceAccounts),
    secrets: sortedCanonical(secrets),
    artifactRepositories: sortedCanonical(artifactRepositories),
    storageBuckets: sortedCanonical(storageBuckets),
    runServices,
    eventarcTriggers,
    pubsubTopics,
    pubsubSubscriptions,
    authProviders,
    firebaseRulesReleases,
  };
}

export async function readObservedDeployment(
  fetch_: FetchLike,
  expected: ExpectedDeployment,
  accessToken: string,
): Promise<ObservedDeployment> {
  const {target} = expected;
  const [rules, storageRules, indexes, ttls, functions, ancestor, hosting] = await Promise.all([
    deployedFirestoreRules(fetch_, target.projectId, accessToken),
    deployedStorageRules(fetch_, target, accessToken),
    deployedIndexes(fetch_, target, accessToken),
    deployedTtls(fetch_, target, accessToken),
    deployedFunctions(fetch_, target, accessToken),
    deployedAncestorSecurity(fetch_, target, accessToken),
    deployedHosting(fetch_, target, expected.hostingFiles, accessToken),
  ]);
  const security = await deployedSecurity(fetch_, target, accessToken, ancestor.policies);
  return {
    firestoreRulesSha256: sha256(rules),
    storageRulesSha256: sha256(storageRules),
    indexes: sortedCanonical(indexes),
    ttls: sortedCanonical(ttls),
    functions,
    ancestorResources: ancestor.resources,
    ancestorIamPolicySha256: ancestor.policySha256,
    security,
    hosting,
  };
}

function expectedRunConfiguration(
  target: DeploymentTarget,
  function_: ExpectedFunction,
  revision: string,
): Record<string, unknown> {
  const imagePackage = [target.projectId, function_.region, function_.name]
    .map((part) => part.replaceAll('-', '--')).join('__');
  const environmentNames = [
    'EVENTARC_CLOUD_EVENT_SOURCE',
    'FIREBASE_CONFIG',
    'FUNCTION_TARGET',
    'GCLOUD_PROJECT',
    'LOG_EXECUTION_ID',
    ...(function_.event === null ? [] : ['FUNCTION_REGION', 'FUNCTION_SIGNATURE_TYPE']),
  ].sort();
  return {
    ingress: 'INGRESS_TRAFFIC_ALL',
    customAudiences: [
      `https://${function_.region}-${target.projectId}.cloudfunctions.net/${function_.name}`,
    ],
    binaryAuthorization: {},
    iapEnabled: false,
    scaling: function_.maxInstances === null ? {} : {maxInstanceCount: function_.maxInstances},
    template: {
      revision,
      serviceAccount: function_.serviceAccount,
      timeout: `${function_.timeoutSeconds}s`,
      maxInstanceRequestConcurrency: 80,
      scaling: function_.maxInstances === null ? {} : {maxInstanceCount: function_.maxInstances},
      vpcAccess: {},
      encryptionKey: null,
      sessionAffinity: false,
      executionEnvironment: null,
      gpuZonalRedundancyDisabled: false,
      healthCheckDisabled: false,
      volumes: [],
      containers: [{
        name: 'worker',
        image:
          `${function_.region}-docker.pkg.dev/${target.projectId}/gcf-artifacts/${imagePackage}:version_1`,
        baseImageUri:
          `${function_.region}-docker.pkg.dev/serverless-runtimes/google-22-full/runtimes/nodejs22`,
        environmentNames,
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
    expectedService:
      `projects/${target.projectId}/locations/${function_.region}/services/${function_.name}`,
  };
}

function functionConfiguration(
  value: ExpectedFunction | ObservedFunction,
  target: DeploymentTarget,
): Record<string, unknown> {
  const observed = 'runtime' in value ? value : null;
  const gen2 = value.generation === 'GEN_2';
  return {
    name: value.name,
    generation: value.generation,
    region: value.region,
    entryPoint: value.entryPoint,
    access: value.access,
    timeoutSeconds: value.timeoutSeconds,
    maxInstances: value.maxInstances,
    serviceAccount: value.serviceAccount,
    secrets: sortedCanonical(value.secrets),
    functionIam: sortedCanonical(value.functionIam),
    runIam: value.runIam === null ? null : sortedCanonical(value.runIam),
    event: value.event === null ? null : {
      ...value.event,
      filters: normalizeFilters(value.event.filters),
    },
    runtime: observed === null ? 'nodejs22' : observed.runtime,
    buildEnvironmentVariables: observed === null ? {
      GOOGLE_NODE_RUN_SCRIPTS: '',
    } : observed.buildEnvironmentVariables,
    userEnvironmentVariables: observed === null ? {} : observed.userEnvironmentVariables,
    ingressSettings: observed === null ? 'ALLOW_ALL' : observed.ingressSettings,
    availableMemory: observed === null ? (gen2 ? '256Mi' : '256M') : observed.availableMemory,
    availableCpu: observed === null ? (gen2 ? '1' : null) : observed.availableCpu,
    maxInstanceRequestConcurrency: observed === null ? (gen2 ? 80 : 1) :
      observed.maxInstanceRequestConcurrency,
    minInstances: observed === null ? null : observed.minInstances,
    vpcConnector: observed === null ? null : observed.vpcConnector,
    vpcConnectorEgressSettings: observed === null ? null : observed.vpcConnectorEgressSettings,
    secretVolumes: observed === null ? [] : observed.secretVolumes,
    securityLevel: observed === null ?
      (gen2 || value.access === 'event' ? null : 'SECURE_ALWAYS') : observed.securityLevel,
    binaryAuthorizationPolicy: observed === null ? null : observed.binaryAuthorizationPolicy,
    kmsKeyName: observed === null ? null : observed.kmsKeyName,
    invokerIamDisabled: observed === null ? (gen2 ? false : null) :
      observed.invokerIamDisabled,
    dockerRegistry: observed === null ? 'ARTIFACT_REGISTRY' : observed.dockerRegistry,
    dockerRepository: observed === null ? (gen2 ?
      `projects/${target.projectId}/locations/${value.region}/repositories/gcf-artifacts` : null) :
      observed.dockerRepository,
    automaticUpdatePolicy: observed === null ? {} : observed.automaticUpdatePolicy,
    buildServiceAccount: observed === null ? null : observed.buildServiceAccount,
    workerPool: observed === null ? null : observed.workerPool,
    uri: observed === null ? (gen2 ? 'RUN_APP' : value.access === 'event' ? null :
      `https://${value.region}-${target.projectId}.cloudfunctions.net/${value.name}`) : observed.uri,
    serviceResource: observed === null ? (gen2 ?
      `projects/${target.projectId}/locations/${value.region}/services/${value.name}` : null) :
      observed.serviceResource,
  };
}

function expectedRunServices(target: DeploymentTarget): string[] {
  return target.functions.filter(({generation}) => generation === 'GEN_2')
    .map(({name, region}) =>
      `projects/${target.projectId}/locations/${region}/services/${name}`).sort();
}

function expectedEventarcTriggers(target: DeploymentTarget): Record<string, unknown>[] {
  return sortedCanonical(target.functions
    .filter((function_) => function_.generation === 'GEN_2' && function_.event !== null)
    .map((function_) => ({
      destination: {
        cloudFunction:
          `projects/${target.projectId}/locations/${function_.region}/functions/${function_.name}`,
      },
      eventFilters: normalizeFilters([
        ...function_.event!.filters,
        {attribute: 'type', value: function_.event!.type},
      ]),
      labels: {'goog-managed-by': 'cloudfunctions'},
      serviceAccount: function_.serviceAccount,
    })));
}

export function deploymentProblems(
  expected: ExpectedDeployment,
  observed: ObservedDeployment,
): string[] {
  const problems: string[] = [];
  if (expected.firestoreRulesSha256 !== observed.firestoreRulesSha256) {
    problems.push('Firestore rules do not match the reviewed commit');
  }
  if (expected.storageRulesSha256 !== observed.storageRulesSha256) {
    problems.push('Storage rules do not match the reviewed commit');
  }
  if (canonical(sortedCanonical(expected.indexes)) !== canonical(sortedCanonical(observed.indexes))) {
    problems.push('Firestore indexes do not match the reviewed commit');
  }
  if (canonical(sortedCanonical(expected.ttls)) !== canonical(sortedCanonical(observed.ttls))) {
    problems.push('Firestore TTL policies do not match the reviewed commit');
  }

  if (canonical(observed.ancestorResources) !== canonical(expected.target.ancestorResources) ||
      observed.ancestorIamPolicySha256 !== expected.target.ancestorIamPolicySha256) {
    problems.push('Effective ancestor IAM does not match the reviewed commit');
  }
  const expectedSecurity = expected.target.security;
  if (canonical(observed.security.ancestorIamPolicies) !==
      canonical(expectedSecurity.ancestorIamPolicies)) {
    problems.push('Ancestor IAM policies do not match the reviewed commit');
  }
  if (canonical(observed.security.customRoles) !== canonical(expectedSecurity.customRoles)) {
    problems.push('Custom IAM roles do not match the reviewed commit');
  }
  if (canonical(observed.security.serviceAccounts) !==
      canonical(expectedSecurity.serviceAccounts)) {
    problems.push('Service-account IAM or user-managed keys do not match the reviewed commit');
  }
  if (canonical(observed.security.secrets) !== canonical(expectedSecurity.secrets)) {
    problems.push('Secret Manager security does not match the reviewed commit');
  }
  if (canonical(observed.security.artifactRepositories) !==
      canonical(expectedSecurity.artifactRepositories)) {
    problems.push('Artifact Registry security does not match the reviewed commit');
  }
  if (canonical(observed.security.storageBuckets) !==
      canonical(expectedSecurity.storageBuckets)) {
    problems.push('Cloud Storage security does not match the reviewed commit');
  }
  if (canonical(observed.security.authConfig) !== canonical(expectedSecurity.authConfig)) {
    problems.push('Firebase Authentication security does not match the reviewed commit');
  }
  if (canonical(observed.security.authProviders) !== canonical(expectedSecurity.authProviders)) {
    problems.push('Firebase Authentication providers or tenants do not match the reviewed commit');
  }
  if (canonical(observed.security.firebaseRulesReleases) !==
      canonical(expectedSecurity.firebaseRulesReleases)) {
    problems.push('Firebase Rules releases do not match the reviewed commit');
  }
  if (canonical(observed.security.runServices) !== canonical(expectedRunServices(expected.target))) {
    problems.push('Cloud Run services do not match the reviewed Functions');
  }
  if (canonical(observed.security.eventarcTriggers) !==
      canonical(expectedSecurity.eventarcTriggers)) {
    problems.push('Eventarc triggers do not match the reviewed Functions');
  }
  if (canonical(observed.security.pubsubTopics) !== canonical(expectedSecurity.pubsubTopics)) {
    problems.push('Pub/Sub topics or authorization do not match the reviewed commit');
  }
  if (canonical(observed.security.pubsubSubscriptions) !==
      canonical(expectedSecurity.pubsubSubscriptions)) {
    problems.push('Pub/Sub subscriptions or delivery settings do not match the reviewed commit');
  }

  const allHostingFiles = {
    ...expected.hostingFiles,
    ...expected.target.generatedHostingFiles,
  };
  const expectedActiveFiles = Object.fromEntries(Object.entries(allHostingFiles)
    .map(([path, artifact]) => [path, artifact.hostingHash]));
  if (canonical(observed.hosting.activeVersionFiles) !== canonical(expectedActiveFiles)) {
    problems.push('Active Hosting version files do not match the reviewed commit');
  }
  if (canonical(observed.hosting.activeVersionConfig) !== canonical(expected.hostingConfig)) {
    problems.push('Active Hosting configuration does not match the reviewed commit');
  }
  if (canonical(observed.hosting.sites) !== canonical([expected.target.hostingSite])) {
    problems.push('Firebase Hosting sites do not match the reviewed target');
  }
  if (!expected.target.hostingOrigins.includes(observed.hosting.defaultUrl)) {
    problems.push('Firebase Hosting default origin is not reviewed');
  }
  if (canonical(observed.hosting.channels) !== canonical(['live'])) {
    problems.push('Public Hosting preview channels exist');
  }
  if (canonical(observed.hosting.customDomains) !==
      canonical([...expected.target.hostingCustomDomains].sort())) {
    problems.push('Firebase Hosting custom domains do not match the reviewed target');
  }

  const expectedByKey = new Map(expected.target.functions.map((value) => [functionKey(value), value]));
  const observedByKey = new Map(observed.functions.map((value) => [functionKey(value), value]));
  assert.equal(expectedByKey.size, expected.target.functions.length, 'duplicate expected function');
  assert.equal(observedByKey.size, observed.functions.length, 'duplicate deployed function in one region');
  for (const key of [...expectedByKey.keys()].sort()) {
    if (!observedByKey.has(key)) problems.push(`Missing function: ${key}`);
  }
  for (const key of [...observedByKey.keys()].sort()) {
    if (!expectedByKey.has(key)) problems.push(`Unexpected function: ${key}`);
  }
  for (const key of [...expectedByKey.keys()].sort()) {
    const expectedFunction = expectedByKey.get(key)!;
    const observedFunction = observedByKey.get(key);
    if (observedFunction === undefined) continue;
    if (observedFunction.releaseId !== expected.target.releaseId) {
      problems.push(`Function release mismatch: ${key}`);
    }
    if (observedFunction.state !== 'ACTIVE') {
      problems.push(`Function is not active: ${key}`);
    }
    if (observedFunction.generation === 'GEN_2' &&
        observedFunction.allTrafficOnLatestRevision !== true) {
      problems.push(`Function does not send all traffic to its latest revision: ${key}`);
    }
    if (canonical(functionConfiguration(expectedFunction, expected.target)) !==
        canonical(functionConfiguration(observedFunction, expected.target))) {
      problems.push(`Function configuration mismatch: ${key}`);
    }
    if (observedFunction.generation === 'GEN_2') {
      if (observedFunction.revision === null ||
          observedFunction.runLatestReadyRevision !== observedFunction.revision ||
          observedFunction.runLatestCreatedRevision !== observedFunction.revision) {
        problems.push(`Cloud Run latest revision does not match Function: ${key}`);
      } else if (canonical(observedFunction.runConfiguration) !== canonical(
        expectedRunConfiguration(expected.target, expectedFunction, observedFunction.revision),
      )) {
        problems.push(`Cloud Run configuration mismatch: ${key}`);
      }
      const imagePackage = [
        expected.target.projectId, expectedFunction.region, expectedFunction.name,
      ].map((part) => part.replaceAll('-', '--')).join('__');
      const imagePrefix =
        `${expectedFunction.region}-docker.pkg.dev/${expected.target.projectId}/gcf-artifacts/${imagePackage}`;
      const expectedImage = `${imagePrefix}:version_1`;
      if (observedFunction.configuredImage !== expectedImage ||
          observedFunction.revisionImage === null ||
          !observedFunction.revisionImage.startsWith(`${imagePrefix}@sha256:`)) {
        problems.push(`Cloud Run container image does not match the reviewed Function: ${key}`);
      }
      if (observedFunction.buildId === null ||
          observedFunction.buildId !== observedFunction.imageBuildId ||
          observedFunction.buildSource === null ||
          observedFunction.buildSource !== observedFunction.imageSource) {
        problems.push(`Cloud Run image provenance does not match the immutable Function build: ${key}`);
      }
      const pinnedTag = observed.hosting.pinnedTags[key];
      const traffic = observedFunction.runTraffic ?? [];
      const statuses = observedFunction.runTrafficStatuses ?? [];
      const trafficTags = traffic.map((entry) => entry.tag).filter((tag) => tag !== undefined);
      const statusTags = statuses.map((entry) => entry.tag).filter((tag) => tag !== undefined);
      const trafficRevisionsAreCurrent = traffic.every((entry) =>
        entry.revision === undefined || entry.revision === observedFunction.revision);
      const statusRevisionsAreCurrent = statuses.every((entry) =>
        entry.revision === observedFunction.revision ||
        (entry.revision === undefined &&
          entry.type === 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST'));
      const latestAllocations = traffic.filter((entry) =>
        entry.type === 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST' && entry.percent === 100);
      const expectedTags = pinnedTag === undefined ? [] : [pinnedTag];
      if (!trafficRevisionsAreCurrent || !statusRevisionsAreCurrent ||
          canonical([...new Set(trafficTags)].sort()) !== canonical(expectedTags) ||
          canonical([...new Set(statusTags)].sort()) !== canonical(expectedTags) ||
          latestAllocations.length !== 1) {
        problems.push(`Cloud Run traffic does not match the reviewed deployment: ${key}`);
      }
    }
    if (canonical(observedFunction.sourceFiles) !== canonical(expected.functionFiles)) {
      problems.push(`Function source does not match the reviewed commit: ${key}`);
    }
    const pinnedRevision = observed.hosting.pinnedRevisions[key];
    if (pinnedRevision !== undefined && pinnedRevision !== observedFunction.revision) {
      problems.push(`Hosting does not pin the reviewed Function revision: ${key}`);
    }
  }

  const expectedPinnedKeys = array(expected.hostingConfig.rewrites ?? [])
    .map(record)
    .filter((rewrite) => rewrite.run !== undefined && record(rewrite.run).pinTag === true)
    .map((rewrite) => {
      const run = record(rewrite.run);
      return `${string(run.region)}/${string(run.serviceId)}`;
    }).sort();
  if (canonical(Object.keys(observed.hosting.pinnedRevisions).sort()) !==
      canonical(expectedPinnedKeys)) {
    problems.push('Hosting pinned Function revisions do not match the reviewed configuration');
  }

  const expectedRawFiles = Object.fromEntries(Object.entries(allHostingFiles)
    .map(([path, artifact]) => [path, artifact.sha256]));
  for (const origin of expected.target.hostingOrigins) {
    const observedFiles = observed.hosting.files[origin];
    if (observedFiles === undefined || canonical(observedFiles) !== canonical(expectedRawFiles)) {
      problems.push(`Hosting files do not match the reviewed commit: ${origin}`);
    }
    if (observed.hosting.profileReleaseIds[origin] !== expected.target.releaseId) {
      problems.push(`Profile rewrite release mismatch: ${origin}`);
    }
    if (observed.hosting.sitemapReleaseIds[origin] !== expected.target.releaseId) {
      problems.push(`Sitemap rewrite release mismatch: ${origin}`);
    }
    if (observed.hosting.profileProbeSha256[origin] !== expected.profileProbeSha256) {
      problems.push(`Profile renderer does not match the reviewed commit: ${origin}`);
    }
  }
  return problems;
}

function gitText(runGit: GitRunner, arguments_: string[]): string {
  return runGit(arguments_).toString('utf8');
}

function gitShow(runGit: GitRunner, commit: string, path: string): Buffer {
  return runGit(['show', `${commit}:${path}`]);
}

function hostingArtifact(value: unknown): HostingArtifact {
  const artifact = record(value);
  assertExactKeys(artifact, ['sha256', 'hostingHash']);
  const result = {
    sha256: string(artifact.sha256),
    hostingHash: string(artifact.hostingHash),
  };
  assert.match(result.sha256, /^[0-9a-f]{64}$/);
  assert.match(result.hostingHash, /^[0-9a-f]{64}$/);
  return result;
}

function expectedFunction(value: unknown): ExpectedFunction {
  const function_ = record(value);
  assertExactKeys(function_, [
    'name', 'generation', 'region', 'entryPoint', 'access', 'timeoutSeconds',
    'maxInstances', 'serviceAccount', 'secrets', 'functionIam', 'runIam', 'event',
  ]);
  const generation = string(function_.generation);
  assert.ok(generation === 'GEN_1' || generation === 'GEN_2');
  const access = string(function_.access);
  assert.ok(access === 'callable' || access === 'event' || access === 'http');
  const secrets = array(function_.secrets).map((value_) => {
    const secret = record(value_);
    assertExactKeys(secret, ['key', 'projectId', 'secret', 'version']);
    return {
      key: string(secret.key),
      projectId: string(secret.projectId),
      secret: string(secret.secret),
      version: string(secret.version),
    };
  });
  const eventValue = function_.event;
  const event = eventValue === null ? null : record(eventValue);
  if (event !== null) assertExactKeys(event, ['type', 'retry', 'filters']);
  const result: ExpectedFunction = {
    name: string(function_.name),
    generation,
    region: string(function_.region),
    entryPoint: string(function_.entryPoint),
    access,
    timeoutSeconds: number(function_.timeoutSeconds),
    maxInstances: function_.maxInstances === null ? null : number(function_.maxInstances),
    serviceAccount: string(function_.serviceAccount),
    secrets: sortedCanonical(secrets),
    functionIam: normalizedIamBindings({bindings: array(function_.functionIam)}),
    runIam: function_.runIam === null ? null :
      normalizedIamBindings({bindings: array(function_.runIam)}),
    event: event === null ? null : {
      type: string(event.type),
      retry: boolean(event.retry),
      filters: normalizeFilters(array(event.filters).map((filterValue) => {
        const filter = record(filterValue);
        assert.ok(Object.keys(filter).every((key) =>
          ['attribute', 'value', 'operator'].includes(key)));
        return {
          attribute: string(filter.attribute),
          value: string(filter.value),
          ...(filter.operator === undefined ? {} : {operator: string(filter.operator)}),
        };
      })),
    },
  };
  assert.match(result.name, /^[A-Za-z][A-Za-z0-9_-]+$/);
  assert.match(result.region, /^[a-z]+-[a-z]+[0-9]$/);
  assert.ok(result.timeoutSeconds > 0);
  assert.equal(result.runIam === null, result.generation === 'GEN_1');
  assert.equal(result.event === null, result.access !== 'event');
  return result;
}

function targetIamResource(value: unknown): IamResource {
  const resource = record(value);
  assertExactKeys(resource, ['name', 'iam']);
  return {
    name: string(resource.name),
    iam: normalizedIamBindings({bindings: array(resource.iam)}),
  };
}

function securityTarget(
  value: unknown,
  functions: ExpectedFunction[],
  projectId: string,
): SecurityTarget {
  const security = record(value);
  assertExactKeys(security, [
    'gitOrigin', 'storageRulesRelease', 'authConfig', 'ancestorIamPolicies',
    'customRoles', 'serviceAccounts', 'secrets', 'artifactRepositories', 'storageBuckets',
    'eventarcTriggers', 'pubsubTopics', 'pubsubSubscriptions', 'authProviders',
    'firebaseRulesReleases',
  ]);
  const serviceAccounts = array(security.serviceAccounts).map((value_) => {
    const account = record(value_);
    assertExactKeys(account, ['name', 'iam', 'userManagedKeys']);
    return {
      ...targetIamResource({name: account.name, iam: account.iam}),
      userManagedKeys: sortedCanonical(array(account.userManagedKeys).map(record)),
    };
  });
  const requiredAccounts = [...new Set(functions.map(({serviceAccount}) => serviceAccount))].sort();
  for (const required of requiredAccounts) {
    assert.equal(serviceAccounts.some(({name}) => name === required), true);
  }
  const secrets = array(security.secrets).map((value_) => {
    const secret = record(value_);
    assertExactKeys(secret, ['name', 'iam', 'versions']);
    return {
      ...targetIamResource({name: secret.name, iam: secret.iam}),
      versions: array(secret.versions).map((versionValue) => {
        const version = record(versionValue);
        assertExactKeys(version, ['version', 'state']);
        return {version: string(version.version), state: string(version.state)};
      }).sort((left, right) => left.version.localeCompare(right.version)),
    };
  });
  const requiredSecrets = [...new Set(functions.flatMap((function_) =>
    function_.secrets.map(({secret}) => secret)))].sort();
  assert.deepEqual(secrets.map(({name}) => name).sort(), requiredSecrets);
  const repositories = array(security.artifactRepositories).map(targetIamResource);
  const requiredRepositories = [...new Set(functions
    .filter(({generation}) => generation === 'GEN_2')
    .map(({region}) =>
      `projects/${projectId}/locations/${region}/repositories/gcf-artifacts`))].sort();
  for (const required of requiredRepositories) {
    assert.equal(repositories.some(({name}) => name === required), true);
  }
  const storageBuckets = array(security.storageBuckets).map((value_) => {
    const bucket = record(value_);
    assertExactKeys(bucket, [
      'name', 'iam', 'publicAccessPrevention', 'uniformBucketLevelAccess',
      'bucketAcl', 'defaultObjectAcl', 'objectAclsSha256',
      'configurationSha256',
    ]);
    return {
      ...targetIamResource({name: bucket.name, iam: bucket.iam}),
      publicAccessPrevention: string(bucket.publicAccessPrevention),
      uniformBucketLevelAccess: boolean(bucket.uniformBucketLevelAccess),
      bucketAcl: sortedCanonical(array(bucket.bucketAcl).map(record)),
      defaultObjectAcl: sortedCanonical(array(bucket.defaultObjectAcl).map(record)),
      objectAclsSha256: string(bucket.objectAclsSha256),
      configurationSha256: string(bucket.configurationSha256),
    };
  });
  for (const bucket of storageBuckets) {
    assert.match(bucket.objectAclsSha256, /^[0-9a-f]{64}$/);
    assert.match(bucket.configurationSha256, /^[0-9a-f]{64}$/);
  }
  assert.ok(storageBuckets.length > 0);
  const customRoles = sortedCanonical(array(security.customRoles).map(record));
  for (const role of customRoles) {
    assertExactKeys(role, [
      'name', 'title', 'description', 'includedPermissions', 'stage', 'deleted',
    ]);
    array(role.includedPermissions).map(string);
  }
  const gitOrigin = string(security.gitOrigin);
  assert.match(gitOrigin, /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/);
  const storageRulesRelease = string(security.storageRulesRelease);
  assert.match(storageRulesRelease, /^[a-z0-9][a-z0-9.-]+$/);
  const targetSecuredResources = (values: unknown): PubsubResourceSecurity[] =>
    sortedCanonical(array(values).map((value_) => {
      const resource = record(value_);
      assertExactKeys(resource, ['name', 'iam', 'configuration']);
      return {
        ...targetIamResource({name: resource.name, iam: resource.iam}),
        configuration: record(resource.configuration),
      };
    }));
  const eventarcTriggers = targetSecuredResources(security.eventarcTriggers);
  const reviewedEventDestinations = eventarcTriggers.map(({configuration}) =>
    canonical(record(configuration.destination))).sort();
  const expectedEventDestinations = expectedEventarcTriggers({
    projectId,
    functions,
  } as DeploymentTarget).map(({destination}) => canonical(destination)).sort();
  assert.deepEqual(reviewedEventDestinations, expectedEventDestinations);
  return {
    gitOrigin,
    storageRulesRelease,
    authConfig: record(security.authConfig),
    ancestorIamPolicies: sortedCanonical(array(security.ancestorIamPolicies).map(targetIamResource)),
    customRoles,
    serviceAccounts: sortedCanonical(serviceAccounts),
    secrets: sortedCanonical(secrets),
    artifactRepositories: sortedCanonical(repositories),
    storageBuckets: sortedCanonical(storageBuckets),
    eventarcTriggers,
    pubsubTopics: targetSecuredResources(security.pubsubTopics),
    pubsubSubscriptions: targetSecuredResources(security.pubsubSubscriptions),
    authProviders: record(security.authProviders),
    firebaseRulesReleases: array(security.firebaseRulesReleases).map(string).sort(),
  };
}

function deploymentTarget(value: unknown): DeploymentTarget {
  const target = record(value);
  assertExactKeys(target, [
    'projectId', 'projectNumber', 'releaseId', 'hostingSite', 'hostingOrigins',
    'hostingCustomDomains', 'generatedHostingFiles', 'allowedUntrackedPrefixes',
    'ancestorResources', 'ancestorIamPolicySha256', 'security', 'firebaseConfig', 'functions',
  ]);
  const projectId = string(target.projectId);
  const hostingSite = string(target.hostingSite);
  const origins = array(target.hostingOrigins).map(string);
  const customDomains = array(target.hostingCustomDomains).map(string).sort();
  assert.ok(origins.length > 0, 'hostingOrigins must not be empty');
  assert.equal(new Set(origins).size, origins.length, 'duplicate Hosting origin');
  for (const origin of origins) {
    const url = new URL(origin);
    assert.equal(url.protocol, 'https:');
    assert.equal(url.pathname, '/');
    assert.equal(url.search, '');
    assert.equal(url.hash, '');
  }
  assert.deepEqual(
    origins.map((origin) => new URL(origin).hostname).sort(),
    [
      `${hostingSite}.web.app`,
      `${hostingSite}.firebaseapp.com`,
      ...customDomains,
    ].sort(),
  );
  const generatedHostingFiles = Object.fromEntries(
    Object.entries(record(target.generatedHostingFiles)).map(([path, artifact]) => {
      assert.match(path, /^__\/firebase\/[A-Za-z0-9._/-]+$/);
      return [path, hostingArtifact(artifact)];
    }),
  );
  assert.ok(Object.keys(generatedHostingFiles).length > 0);
  const prefixes = array(target.allowedUntrackedPrefixes).map(string);
  for (const prefix of prefixes) {
    assert.match(prefix, /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+\/$/);
    assert.equal(prefix.startsWith('functions/'), false);
    assert.equal(prefix.startsWith('public/'), false);
  }
  const functions = array(target.functions).map(expectedFunction);
  assert.ok(functions.length > 0, 'functions must not be empty');
  assert.equal(new Set(functions.map(functionKey)).size, functions.length, 'duplicate function');
  const resources = array(target.ancestorResources).map(string);
  assert.ok(resources.length > 0);
  assert.equal(resources[0], `projects/${projectId}`);
  const policyHash = string(target.ancestorIamPolicySha256);
  assert.match(policyHash, /^[0-9a-f]{64}$/);
  const firebaseConfig = stringRecord(target.firebaseConfig);
  assert.equal(firebaseConfig.projectId, projectId);
  const security = securityTarget(target.security, functions, projectId);
  const bucketNames = security.storageBuckets.map(({name}) => name);
  assert.equal(bucketNames.includes(security.storageRulesRelease), true);
  if (bucketNames.includes(firebaseConfig.storageBucket)) {
    assert.equal(firebaseConfig.storageBucket, security.storageRulesRelease);
  }
  assert.equal(hostingSite, projectId);
  assert.match(projectId, /^[a-z][a-z0-9-]{4,29}$/);
  assert.match(string(target.projectNumber), /^[0-9]+$/);
  assert.notEqual(string(target.releaseId), '');
  return {
    projectId,
    projectNumber: string(target.projectNumber),
    releaseId: string(target.releaseId),
    hostingSite,
    hostingOrigins: origins,
    hostingCustomDomains: customDomains,
    generatedHostingFiles,
    allowedUntrackedPrefixes: prefixes,
    ancestorResources: resources,
    ancestorIamPolicySha256: policyHash,
    security,
    firebaseConfig,
    functions,
  };
}

function assertReviewedFunctionsPackaging(firebaseJson: Record<string, unknown>): void {
  const functions = record(firebaseJson.functions);
  assertExactKeys(functions, ['source', 'disallowLegacyRuntimeConfig', 'ignore', 'predeploy']);
  assert.equal(functions.source, 'functions');
  assert.equal(functions.disallowLegacyRuntimeConfig, true);
  assert.deepEqual(array(functions.ignore).map(string), [
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
  ]);
  assert.deepEqual(array(functions.predeploy).map(string), [
    'npm --prefix "$RESOURCE_DIR" run lint',
    'npm --prefix "$RESOURCE_DIR" run build',
  ]);
}

export function readExpectedDeployment(
  reviewedCommit: string,
  runGit: GitRunner,
): ExpectedDeployment {
  assert.match(reviewedCommit, /^[0-9a-f]{40}$/);
  const target = deploymentTarget(JSON.parse(
    gitShow(runGit, reviewedCommit, 'deployment-target.json').toString('utf8'),
  ));
  const firebaseJson = record(JSON.parse(
    gitShow(runGit, reviewedCommit, 'firebase.json').toString('utf8'),
  ));
  assertReviewedFunctionsPackaging(firebaseJson);
  const storage = record(firebaseJson.storage);
  assertExactKeys(storage, ['rules']);
  assert.equal(storage.rules, 'storage.rules');
  const indexConfig = JSON.parse(
    gitShow(runGit, reviewedCommit, 'firestore.indexes.json').toString('utf8'),
  ) as {
    indexes: ExpectedIndex[];
    fieldOverrides: Array<ExpectedTtl & {ttl?: boolean}>;
  };
  const hostingManifest = record(JSON.parse(
    gitShow(runGit, reviewedCommit, 'hosting-artifacts.json').toString('utf8'),
  ));
  assert.equal(hostingManifest.version, 2);
  const hostingFiles = Object.fromEntries(
    Object.entries(record(hostingManifest.files)).map(([path, artifact]) => {
      assert.match(path, /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/);
      return [path, hostingArtifact(artifact)];
    }),
  );
  assert.ok(Object.keys(hostingFiles).length > 0);
  const functionManifest = record(JSON.parse(
    gitShow(runGit, reviewedCommit, 'functions-artifacts.json').toString('utf8'),
  ));
  assert.equal(functionManifest.version, 1);
  assertExactKeys(functionManifest, ['version', 'files', 'profileProbeSha256']);
  const functionFiles = Object.fromEntries(
    Object.entries(record(functionManifest.files)).map(([path, hash]) => {
      assert.match(path, /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/);
      const parsed = string(hash);
      assert.match(parsed, /^[0-9a-f]{64}$/);
      return [path, parsed];
    }),
  );
  assert.ok(Object.keys(functionFiles).length > 0);
  const profileProbeSha256 = string(functionManifest.profileProbeSha256);
  assert.match(profileProbeSha256, /^[0-9a-f]{64}$/);
  return {
    target,
    firestoreRulesSha256: sha256(gitShow(runGit, reviewedCommit, 'firestore.rules')),
    storageRulesSha256: sha256(gitShow(runGit, reviewedCommit, 'storage.rules')),
    indexes: sortedCanonical(indexConfig.indexes.map(normalizeIndex)),
    ttls: sortedCanonical(indexConfig.fieldOverrides
      .filter((field) => field.ttl === true)
      .map(({collectionGroup, fieldPath}) => ({collectionGroup, fieldPath}))),
    hostingFiles,
    functionFiles,
    profileProbeSha256,
    hostingConfig: reviewedHostingConfig(firebaseJson, target),
  };
}

export function reviewedTreeProblems(
  reviewedCommit: string,
  target: DeploymentTarget,
  runGit: GitRunner,
): string[] {
  const problems: string[] = [];
  const head = gitText(runGit, ['rev-parse', 'HEAD']).trim();
  const pushed = gitText(runGit, ['rev-parse', 'origin/master']).trim();
  const remoteLine = gitText(
    runGit,
    ['ls-remote', '--exit-code', 'origin', 'refs/heads/master'],
  ).trim();
  const remote = remoteLine.split(/\s+/)[0] ?? '';
  const origin = gitText(runGit, ['remote', 'get-url', 'origin']).trim();
  const localConfig = gitText(runGit, ['config', '--local', '--list', '-z'])
    .split('\0').filter(Boolean);
  const urlRewrites = localConfig.filter((entry) =>
    /^url\..*\.insteadof\n/i.test(entry));
  if (head !== reviewedCommit) problems.push('HEAD is not the reviewed commit');
  if (pushed !== reviewedCommit) problems.push('origin/master is not the reviewed commit');
  if (remote !== reviewedCommit) problems.push('Remote master is not the reviewed commit');
  if (origin !== target.security.gitOrigin) problems.push('Git origin is not the reviewed repository');
  if (urlRewrites.length > 0) problems.push('Repository-local Git URL rewrite can spoof origin');
  const status = gitText(
    runGit,
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
  ).split('\0').filter(Boolean);
  for (const entry of status) {
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    const allowed = code === '??' &&
      target.allowedUntrackedPrefixes.some((prefix) => path.startsWith(prefix));
    if (!allowed) problems.push(`Unreviewed working-tree change: ${entry}`);
  }
  const dotenvFiles = gitText(
    runGit,
    [
      'ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--',
      ':(glob)functions/.env*',
    ],
  ).split('\0').filter(Boolean);
  for (const path of dotenvFiles) {
    problems.push(`Ignored Functions dotenv input: ${path}`);
  }
  const secretFiles = gitText(
    runGit,
    [
      'ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--',
      ':(glob)functions/.secret.*',
    ],
  ).split('\0').filter(Boolean);
  for (const path of secretFiles) {
    problems.push(`Ignored Functions secret input: ${path}`);
  }
  return problems;
}

export function parseOptions(arguments_: string[]): Map<string, string> {
  const allowed = new Set(['account', 'commit', 'project']);
  const parsed = new Map<string, string>();
  for (const argument of arguments_) {
    assert.ok(argument.startsWith('--'), `invalid argument: ${argument}`);
    const separator = argument.indexOf('=');
    assert.ok(separator > 2, `argument requires a value: ${argument}`);
    const name = argument.slice(2, separator);
    const value = argument.slice(separator + 1);
    assert.equal(allowed.has(name), true, `unknown argument: --${name}`);
    assert.equal(parsed.has(name), false, `duplicate argument: --${name}`);
    assert.notEqual(value, '', `argument requires a value: --${name}`);
    parsed.set(name, value);
  }
  return parsed;
}

export interface CliDependencies {
  root: string;
  runGit: GitRunner;
  fetch: FetchLike;
  accessToken(account?: string): string;
  stdout(message: string): void;
  stderr(message: string): void;
}

export async function runCli(
  arguments_: string[],
  dependencies: CliDependencies,
): Promise<number> {
  const options = parseOptions(arguments_);
  const reviewedCommit = options.get('commit');
  assert.notEqual(reviewedCommit, undefined, 'missing --commit');
  assert.match(reviewedCommit!, /^[0-9a-f]{40}$/);
  const expected = readExpectedDeployment(reviewedCommit!, dependencies.runGit);
  const project = options.get('project');
  if (project !== undefined) assert.equal(project, expected.target.projectId);
  const treeProblems = reviewedTreeProblems(
    reviewedCommit!, expected.target, dependencies.runGit,
  );
  if (treeProblems.length > 0) {
    for (const problem of treeProblems) dependencies.stderr(`${problem}\n`);
    return 1;
  }
  const observed = await readObservedDeployment(
    dependencies.fetch,
    expected,
    dependencies.accessToken(options.get('account')),
  );
  const problems = deploymentProblems(expected, observed);
  if (problems.length > 0) {
    for (const problem of problems) dependencies.stderr(`${problem}\n`);
    return 1;
  }
  dependencies.stdout(`Deployment matches reviewed commit ${reviewedCommit}\n`);
  return 0;
}

export async function runProductionCli(arguments_: string[]): Promise<number> {
  const root = dirname(fileURLToPath(import.meta.url));
  const runGit: GitRunner = (gitArguments) => execFileSync(
    'git', ['-C', root, ...gitArguments], {encoding: 'buffer'},
  );
  return runCli(arguments_, {
    root,
    runGit,
    fetch: fetch as FetchLike,
    accessToken: (account) => {
      const tokenArguments = ['auth', 'print-access-token'];
      if (account !== undefined) tokenArguments.push(`--account=${account}`);
      return execFileSync('gcloud', tokenArguments, {encoding: 'utf8'}).trim();
    },
    stdout: (message) => process.stdout.write(message),
    stderr: (message) => process.stderr.write(message),
  });
}
