import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

export interface ExpectedFunction {
  name: string;
  generation: 'GEN_1' | 'GEN_2';
  region: string;
}

export interface ExpectedDeployment {
  firestoreRulesSha256: string;
  functions: ExpectedFunction[];
  hostingVersion: string;
  deployedAfter?: string;
}

export interface ObservedFunction extends ExpectedFunction {
  state: string;
  updateTime: string;
}

export interface ObservedDeployment {
  firestoreRulesSha256: string;
  functions: ObservedFunction[];
  hostingVersion: string;
}

interface DeploymentTarget {
  projectId: string;
  hostingOrigin: string;
  region: string;
  functions: Array<Omit<ExpectedFunction, 'region'>>;
}

interface JsonResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type FetchJson = (
  url: string,
  init?: {headers?: Record<string, string>},
) => Promise<JsonResponse>;

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

function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function baseName(resourceName: string): string {
  return resourceName.slice(resourceName.lastIndexOf('/') + 1);
}

function resourceRegion(resourceName: string): string {
  const segments = resourceName.split('/');
  assert.equal(segments[2], 'locations');
  return string(segments[3]);
}

async function json(
  fetchJson: FetchJson,
  url: string,
  accessToken?: string,
  quotaProject?: string,
): Promise<Record<string, unknown>> {
  assert.equal(accessToken === undefined, quotaProject === undefined);
  const response = await fetchJson(
    url,
    accessToken === undefined ? undefined : {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'X-Goog-User-Project': quotaProject!,
      },
    },
  );
  assert.equal(response.ok, true, `${url} returned HTTP ${response.status}`);
  return record(await response.json());
}

async function listFunctions(
  fetchJson: FetchJson,
  projectId: string,
  accessToken: string,
): Promise<ObservedFunction[]> {
  const results: ObservedFunction[] = [];
  let pageToken: string | undefined;
  do {
    const query = pageToken === undefined ? '' : `?pageToken=${encodeURIComponent(pageToken)}`;
    const response = await json(
      fetchJson,
      `https://cloudfunctions.googleapis.com/v2/projects/${projectId}/locations/-/functions${query}`,
      accessToken,
      projectId,
    );
    for (const value of array(response.functions ?? [])) {
      const deployedFunction = record(value);
      const environment = deployedFunction.environment;
      assert.ok(environment === undefined || environment === 'GEN_1' || environment === 'GEN_2');
      results.push({
        name: baseName(string(deployedFunction.name)),
        generation: environment === 'GEN_2' ? 'GEN_2' : 'GEN_1',
        region: resourceRegion(string(deployedFunction.name)),
        state: string(deployedFunction.state),
        updateTime: string(deployedFunction.updateTime),
      });
    }
    pageToken = response.nextPageToken === undefined ? undefined : string(response.nextPageToken);
  } while (pageToken !== undefined);
  return results;
}

async function deployedFirestoreRules(
  fetchJson: FetchJson,
  projectId: string,
  accessToken: string,
): Promise<string> {
  const release = await json(
    fetchJson,
    `https://firebaserules.googleapis.com/v1/projects/${projectId}/releases/cloud.firestore`,
    accessToken,
    projectId,
  );
  const rulesetName = string(release.rulesetName);
  const ruleset = await json(
    fetchJson,
    `https://firebaserules.googleapis.com/v1/${rulesetName}`,
    accessToken,
    projectId,
  );
  const source = record(ruleset.source);
  const files = array(source.files).map(record);
  const matches = files.filter((file) => string(file.name).endsWith('firestore.rules'));
  assert.equal(matches.length, 1);
  return string(matches[0].content);
}

export async function readObservedDeployment(
  fetchJson: FetchJson,
  projectId: string,
  hostingOrigin: string,
  accessToken: string,
): Promise<ObservedDeployment> {
  const [rules, functions, hosting] = await Promise.all([
    deployedFirestoreRules(fetchJson, projectId, accessToken),
    listFunctions(fetchJson, projectId, accessToken),
    json(fetchJson, `${hostingOrigin}/_app/version.json`),
  ]);
  return {
    firestoreRulesSha256: sha256(rules),
    functions,
    hostingVersion: string(hosting.version),
  };
}

export function deploymentProblems(
  expected: ExpectedDeployment,
  observed: ObservedDeployment,
): string[] {
  const problems: string[] = [];
  if (expected.firestoreRulesSha256 !== observed.firestoreRulesSha256) {
    problems.push('Firestore rules do not match the reviewed local rules');
  }

  const expectedByName = new Map(expected.functions.map((value) => [value.name, value]));
  const observedByName = new Map(observed.functions.map((value) => [value.name, value]));
  assert.equal(expectedByName.size, expected.functions.length, 'duplicate expected function name');
  assert.equal(observedByName.size, observed.functions.length, 'duplicate deployed function name');

  for (const name of [...expectedByName.keys()].sort()) {
    if (!observedByName.has(name)) problems.push(`Missing function: ${name}`);
  }
  for (const name of [...observedByName.keys()].sort()) {
    if (!expectedByName.has(name)) problems.push(`Unexpected function: ${name}`);
  }
  for (const name of [...expectedByName.keys()].sort()) {
    const expectedFunction = expectedByName.get(name)!;
    const observedFunction = observedByName.get(name);
    if (observedFunction !== undefined &&
        expectedFunction.generation !== observedFunction.generation) {
      problems.push(
        `Function generation mismatch: ${name} expected ${expectedFunction.generation}, ` +
        `observed ${observedFunction.generation}`,
      );
    }
  }
  for (const name of [...expectedByName.keys()].sort()) {
    const expectedFunction = expectedByName.get(name)!;
    const observedFunction = observedByName.get(name);
    if (observedFunction !== undefined && expectedFunction.region !== observedFunction.region) {
      problems.push(
        `Function region mismatch: ${name} expected ${expectedFunction.region}, ` +
        `observed ${observedFunction.region}`,
      );
    }
  }
  for (const name of [...expectedByName.keys()].sort()) {
    const observedFunction = observedByName.get(name);
    if (observedFunction !== undefined && observedFunction.state !== 'ACTIVE') {
      problems.push(`Function is not active: ${name} observed ${observedFunction.state}`);
    }
  }
  if (expected.deployedAfter !== undefined) {
    const boundary = Date.parse(expected.deployedAfter);
    assert.equal(Number.isNaN(boundary), false, 'invalid deployment boundary');
    for (const name of [...expectedByName.keys()].sort()) {
      const observedFunction = observedByName.get(name);
      if (observedFunction === undefined) continue;
      const updateTime = Date.parse(observedFunction.updateTime);
      assert.equal(Number.isNaN(updateTime), false, `invalid update time for ${name}`);
      if (updateTime < boundary) {
        problems.push(`Function predates this release: ${name}`);
      }
    }
  }
  if (expected.hostingVersion !== observed.hostingVersion) {
    problems.push('Hosting version does not match the reviewed local build');
  }
  return problems;
}

export function readExpectedDeployment(
  root: string,
  deployedAfter?: string,
): ExpectedDeployment & Pick<DeploymentTarget, 'projectId' | 'hostingOrigin'> {
  const target = JSON.parse(
    readFileSync(resolve(root, 'deployment-target.json'), 'utf8'),
  ) as DeploymentTarget;
  const version = JSON.parse(
    readFileSync(resolve(root, 'public/_app/version.json'), 'utf8'),
  ) as {version: string};
  return {
    projectId: target.projectId,
    hostingOrigin: target.hostingOrigin,
    firestoreRulesSha256: sha256(readFileSync(resolve(root, 'firestore.rules'), 'utf8')),
    functions: target.functions.map((value) => ({...value, region: target.region})),
    hostingVersion: version.version,
    deployedAfter,
  };
}

export function parseOptions(arguments_: string[]): Map<string, string> {
  const allowed = new Set(['account', 'deployed-after', 'project']);
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

async function main(): Promise<void> {
  const root = dirname(fileURLToPath(import.meta.url));
  const options = parseOptions(process.argv.slice(2));
  const deployedAfter = options.get('deployed-after');
  assert.notEqual(deployedAfter, undefined, 'missing --deployed-after');
  const expected = readExpectedDeployment(root, deployedAfter);
  const projectArgument = options.get('project');
  if (projectArgument !== undefined) assert.equal(projectArgument, expected.projectId);
  const account = options.get('account');
  const tokenArguments = ['auth', 'print-access-token'];
  if (account !== undefined) tokenArguments.push(`--account=${account}`);
  const accessToken = execFileSync('gcloud', tokenArguments, {encoding: 'utf8'}).trim();
  const observed = await readObservedDeployment(
    fetch as FetchJson,
    expected.projectId,
    expected.hostingOrigin,
    accessToken,
  );
  const problems = deploymentProblems(expected, observed);
  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`${problem}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`Deployment matches ${expected.projectId}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
