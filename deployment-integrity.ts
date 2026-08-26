import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

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
  publicInvoker: boolean;
  invokers: string[];
  event: FunctionEvent | null;
}

export interface ObservedFunction extends ExpectedFunction {
  releaseId: string | null;
  state: string;
  allTrafficOnLatestRevision: boolean | null;
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
  allowedGeneratedHostingFiles: string[];
  allowedUntrackedPrefixes: string[];
  functions: ExpectedFunction[];
}

export interface ExpectedDeployment {
  target: DeploymentTarget;
  firestoreRulesSha256: string;
  indexes: ExpectedIndex[];
  ttls: ExpectedTtl[];
  hostingFiles: Record<string, string>;
  hostingConfig: Record<string, unknown>;
}

export interface ObservedHosting {
  files: Record<string, Record<string, string>>;
  activeVersionFiles: Record<string, string>;
  activeVersionConfig: Record<string, unknown>;
  profileReleaseIds: Record<string, string | null>;
  sitemapReleaseIds: Record<string, string | null>;
}

export interface ObservedDeployment {
  firestoreRulesSha256: string;
  indexes: ExpectedIndex[];
  ttls: ExpectedTtl[];
  functions: ObservedFunction[];
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
  init?: {headers?: Record<string, string>; signal?: AbortSignal},
) => Promise<FetchResponse>;

export type GitRunner = (arguments_: string[]) => Buffer;

const MAX_API_PAGES = 100;
const FETCH_TIMEOUT_MS = 10_000;
const RELEASE_HEADER = 'x-book-tracker-release';

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
  init: {headers?: Record<string, string>} | undefined,
  acceptedStatuses: number[] = [200],
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
    assert.fail(`${url} returned HTTP ${response.status}`);
  }
  assert.fail(`request attempts exhausted for ${url}`);
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
): Promise<Record<string, unknown>> {
  const response = await fetchWithRetry(fetch_, url, {
    headers: authenticatedHeaders(accessToken, projectId),
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
  const matches = files.filter((file) => string(file.name).split('/').at(-1) === 'firestore.rules');
  assert.equal(matches.length, 1);
  return string(matches[0].content);
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

function invokerBindings(policy: Record<string, unknown>): string[] {
  const invokers: string[] = [];
  for (const value of array(policy.bindings ?? [])) {
    const binding = record(value);
    const role = string(binding.role);
    const members = array(binding.members ?? []).map(string);
    if (role !== 'roles/cloudfunctions.invoker' && role !== 'roles/run.invoker') continue;
    assert.equal(binding.condition, undefined, 'conditional invoker is unsupported');
    for (const member of members) invokers.push(`${role}:${member}`);
  }
  return invokers.sort();
}

async function deployedInvokers(
  fetch_: FetchLike,
  projectId: string,
  accessToken: string,
  generation: Generation,
  region: string,
  name: string,
): Promise<string[]> {
  const functionPolicy = await json(
    fetch_,
    `https://cloudfunctions.googleapis.com/v2/projects/${projectId}/locations/${region}/functions/${name}:getIamPolicy`,
    accessToken,
    projectId,
  );
  if (generation === 'GEN_1') return invokerBindings(functionPolicy);
  const runPolicy = await json(
    fetch_,
    `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/services/${name}:getIamPolicy`,
    accessToken,
    projectId,
  );
  return [...invokerBindings(functionPolicy), ...invokerBindings(runPolicy)].sort();
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
    const invokers = await deployedInvokers(
      fetch_, target.projectId, accessToken, generation, resource.region, resource.name,
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
      publicInvoker: invokers.some((invoker) => invoker.endsWith(':allUsers')),
      invokers,
      event,
      releaseId: labels['book-tracker-release'] === undefined ? null :
        string(labels['book-tracker-release']),
      state: string(value.state),
      allTrafficOnLatestRevision: generation === 'GEN_2' ?
        boolean(service.allTrafficOnLatestRevision) : null,
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
): Record<string, unknown> {
  const allowed = ['headers', 'redirects', 'rewrites', 'cleanUrls',
    'trailingSlashBehavior', 'i18n'];
  assert.ok(Object.keys(value).every((key) => allowed.includes(key)));
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
      return {
        ...pattern,
        run: {
          serviceId: string(run.serviceId),
          region: run.region === undefined ? 'us-central1' : string(run.region),
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
    headers,
    redirects,
    rewrites,
    ...(value.cleanUrls === undefined ? {} : {cleanUrls: boolean(value.cleanUrls)}),
    ...(value.trailingSlashBehavior === undefined ? {} : {
      trailingSlashBehavior: string(value.trailingSlashBehavior),
    }),
    ...(value.i18n === undefined ? {} : {i18n: record(value.i18n)}),
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
): Promise<{files: Record<string, string>; config: Record<string, unknown>}> {
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
  return {
    files,
    config: normalizeActiveHostingConfig(record(version.config), versionId),
  };
}

async function deployedHosting(
  fetch_: FetchLike,
  target: DeploymentTarget,
  hostingFiles: Record<string, string>,
  accessToken: string,
): Promise<ObservedHosting> {
  const active = await activeHostingVersion(fetch_, target, accessToken);
  const files: Record<string, Record<string, string>> = {};
  const profileReleaseIds: Record<string, string | null> = {};
  const sitemapReleaseIds: Record<string, string | null> = {};
  for (const origin of target.hostingOrigins) {
    const originFiles: Record<string, string> = {};
    await Promise.all(Object.keys(hostingFiles).map(async (path) => {
      const response = await fetchWithRetry(fetch_, `${origin}/${path}`, undefined);
      originFiles[path] = sha256(new Uint8Array(await response.arrayBuffer()));
    }));
    files[origin] = originFiles;
    const profile = await fetchWithRetry(
      fetch_, `${origin}/profiles/__deployment_integrity_probe__`, undefined, [404],
    );
    profileReleaseIds[origin] = profile.headers.get(RELEASE_HEADER);
    const sitemap = await fetchWithRetry(fetch_, `${origin}/sitemap.xml`, undefined);
    sitemapReleaseIds[origin] = sitemap.headers.get(RELEASE_HEADER);
  }
  return {
    files,
    activeVersionFiles: active.files,
    activeVersionConfig: active.config,
    profileReleaseIds,
    sitemapReleaseIds,
  };
}

export async function readObservedDeployment(
  fetch_: FetchLike,
  expected: ExpectedDeployment,
  accessToken: string,
): Promise<ObservedDeployment> {
  const {target} = expected;
  const [rules, indexes, ttls, functions, hosting] = await Promise.all([
    deployedFirestoreRules(fetch_, target.projectId, accessToken),
    deployedIndexes(fetch_, target, accessToken),
    deployedTtls(fetch_, target, accessToken),
    deployedFunctions(fetch_, target, accessToken),
    deployedHosting(fetch_, target, expected.hostingFiles, accessToken),
  ]);
  return {
    firestoreRulesSha256: sha256(rules),
    indexes: sortedCanonical(indexes),
    ttls: sortedCanonical(ttls),
    functions,
    hosting,
  };
}

function functionConfiguration(value: ExpectedFunction): ExpectedFunction {
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
    publicInvoker: value.publicInvoker,
    invokers: [...value.invokers].sort(),
    event: value.event === null ? null : {
      ...value.event,
      filters: normalizeFilters(value.event.filters),
    },
  };
}

export function deploymentProblems(
  expected: ExpectedDeployment,
  observed: ObservedDeployment,
): string[] {
  const problems: string[] = [];
  if (expected.firestoreRulesSha256 !== observed.firestoreRulesSha256) {
    problems.push('Firestore rules do not match the reviewed commit');
  }
  if (canonical(sortedCanonical(expected.indexes)) !== canonical(sortedCanonical(observed.indexes))) {
    problems.push('Firestore indexes do not match the reviewed commit');
  }
  if (canonical(sortedCanonical(expected.ttls)) !== canonical(sortedCanonical(observed.ttls))) {
    problems.push('Firestore TTL policies do not match the reviewed commit');
  }

  const expectedHostingPaths = [
    ...Object.keys(expected.hostingFiles),
    ...expected.target.allowedGeneratedHostingFiles,
  ].sort();
  if (canonical(Object.keys(observed.hosting.activeVersionFiles).sort()) !==
      canonical(expectedHostingPaths)) {
    problems.push('Active Hosting version has unexpected or missing files');
  }
  if (canonical(observed.hosting.activeVersionConfig) !== canonical(expected.hostingConfig)) {
    problems.push('Active Hosting configuration does not match the reviewed commit');
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
    if (canonical(functionConfiguration(expectedFunction)) !==
        canonical(functionConfiguration(observedFunction))) {
      problems.push(`Function configuration mismatch: ${key}`);
    }
  }

  for (const origin of expected.target.hostingOrigins) {
    const observedFiles = observed.hosting.files[origin];
    if (observedFiles === undefined || canonical(observedFiles) !== canonical(expected.hostingFiles)) {
      problems.push(`Hosting files do not match the reviewed commit: ${origin}`);
    }
    if (observed.hosting.profileReleaseIds[origin] !== expected.target.releaseId) {
      problems.push(`Profile rewrite release mismatch: ${origin}`);
    }
    if (observed.hosting.sitemapReleaseIds[origin] !== expected.target.releaseId) {
      problems.push(`Sitemap rewrite release mismatch: ${origin}`);
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

export function readExpectedDeployment(
  reviewedCommit: string,
  runGit: GitRunner,
): ExpectedDeployment {
  assert.match(reviewedCommit, /^[0-9a-f]{40}$/);
  const target = JSON.parse(
    gitShow(runGit, reviewedCommit, 'deployment-target.json').toString('utf8'),
  ) as DeploymentTarget;
  const firebaseJson = record(JSON.parse(
    gitShow(runGit, reviewedCommit, 'firebase.json').toString('utf8'),
  ));
  const indexConfig = JSON.parse(
    gitShow(runGit, reviewedCommit, 'firestore.indexes.json').toString('utf8'),
  ) as {
    indexes: ExpectedIndex[];
    fieldOverrides: Array<ExpectedTtl & {ttl?: boolean}>;
  };
  const hostingManifest = record(JSON.parse(
    gitShow(runGit, reviewedCommit, 'hosting-artifacts.json').toString('utf8'),
  ));
  assert.equal(hostingManifest.version, 1);
  const hostingFiles = Object.fromEntries(
    Object.entries(record(hostingManifest.files)).map(([path, hash]) => {
      assert.match(path, /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/);
      assert.match(string(hash), /^[0-9a-f]{64}$/);
      return [path, string(hash)];
    }),
  );
  assert.ok(Object.keys(hostingFiles).length > 0);
  return {
    target,
    firestoreRulesSha256: sha256(gitShow(runGit, reviewedCommit, 'firestore.rules')),
    indexes: sortedCanonical(indexConfig.indexes.map(normalizeIndex)),
    ttls: sortedCanonical(indexConfig.fieldOverrides
      .filter((field) => field.ttl === true)
      .map(({collectionGroup, fieldPath}) => ({collectionGroup, fieldPath}))),
    hostingFiles,
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
  if (head !== reviewedCommit) problems.push('HEAD is not the reviewed commit');
  if (pushed !== reviewedCommit) problems.push('origin/master is not the reviewed commit');
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
