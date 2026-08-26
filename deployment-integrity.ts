import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
} from 'node:fs';
import {dirname, posix, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gunzipSync, inflateRawSync} from 'node:zlib';

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

interface RuntimeFile {
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'hardlink' | 'character' | 'block' | 'fifo';
  mode: number;
  uid: number;
  gid: number;
  deviceMajor?: number;
  deviceMinor?: number;
  sha256?: string;
  linkName?: string;
}

interface RuntimeAttestation {
  deploymentCommit: string;
  imageDigest: string;
  executionConfig: Record<string, unknown>;
  files: RuntimeFile[];
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

interface ArtifactRepositorySecurity extends IamResource {
  configuration: Record<string, unknown>;
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
  runInventoryCheckpoint: string | null;
  authConfig: Record<string, unknown>;
  ancestorIamPolicies: IamResource[];
  customRoles: Record<string, unknown>[];
  serviceAccounts: ServiceAccountSecurity[];
  secrets: SecretSecurity[];
  artifactRepositories: ArtifactRepositorySecurity[];
  storageBuckets: StorageBucketSecurity[];
  eventarcTriggers: EventarcTriggerSecurity[];
  pubsubTopics: PubsubResourceSecurity[];
  pubsubSubscriptions: PubsubResourceSecurity[];
  authProviders: Record<string, unknown>;
  firebaseRulesReleases: string[];
}

interface ObservedSecurity extends Omit<
  SecurityTarget,
  'gitOrigin' | 'storageRulesRelease' | 'runInventoryCheckpoint'
> {
  runServices: string[];
  runJobs: string[];
  runWorkerPools: string[];
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
  runtimeAttestation: RuntimeAttestation | null;
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
  buildImageDigest: string | null;
  imageBuildId: string | null;
  imageSource: string | null;
  imageSourceFiles: Record<string, string> | null;
  imageRuntimeAttestation: Omit<RuntimeAttestation, 'deploymentCommit'> | null;
  firebaseFunctionsHash: string | null;
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
const MAX_FUNCTION_SOURCE_TAR_BYTES = 75 * 1024 * 1024;
const MAX_IMAGE_LAYER_BYTES = 100 * 1024 * 1024;
const MAX_IMAGE_LAYER_EXPANDED_BYTES = 500 * 1024 * 1024;
const RUN_INVENTORY_QUIESCENCE_MS = 10 * 60 * 1000;
const MAX_RUN_INVENTORY_CHECKPOINT_AGE_MS = 60 * 60 * 1000;

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
  return value === undefined || value === null ? null : string(value);
}

function nullableNumber(value: unknown): number | null {
  return value === undefined || value === null ? null : number(value);
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

const CRC32_TABLE = Uint32Array.from({length: 256}, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) === 0 ? crc >>> 1 : 0xedb88320 ^ (crc >>> 1);
  }
  return crc >>> 0;
});

function crc32(content: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of content) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zipEntries(content: Uint8Array): Array<{path: string; body: Uint8Array}> {
  const view = new DataView(content.buffer, content.byteOffset, content.byteLength);
  const minimum = Math.max(0, content.byteLength - 65_557);
  const alignedEnds: number[] = [];
  for (let offset = content.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50 &&
        offset + 22 + view.getUint16(offset + 20, true) === content.byteLength) {
      alignedEnds.push(offset);
    }
  }
  assert.equal(alignedEnds.length, 1,
    'Function source archive must have one EOF-aligned ZIP end record');
  const end = alignedEnds[0];
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
  const entries: Array<{path: string; body: Uint8Array}> = [];
  const dataRanges: Array<readonly [number, number]> = [];
  let expandedBytes = 0;
  let offset = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    assert.ok(offset + 46 <= end, 'truncated ZIP central entry');
    assert.equal(view.getUint32(offset, true), 0x02014b50, 'invalid ZIP central entry');
    const versionMadeBy = view.getUint16(offset + 4, true);
    const creatorSystem = versionMadeBy >>> 8;
    const versionNeeded = view.getUint16(offset + 6, true);
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const checksum = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const originalSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    assert.equal(view.getUint16(offset + 34, true), 0, 'multi-disk ZIP is unsupported');
    const localOffset = view.getUint32(offset + 42, true);
    const externalAttributes = view.getUint32(offset + 38, true);
    assert.equal(versionNeeded <= 20, true, 'unsupported ZIP extraction version');
    assert.equal(creatorSystem === 0 || creatorSystem === 3, true,
      'unsupported ZIP creator system');
    assert.notEqual(compressedSize, 0xffffffff, 'ZIP64 is unsupported');
    assert.notEqual(originalSize, 0xffffffff, 'ZIP64 is unsupported');
    assert.notEqual(localOffset, 0xffffffff, 'ZIP64 is unsupported');
    assert.equal(flags & ~0x800, 0, 'unsupported ZIP entry flags');
    assert.equal(method === 0 || method === 8, true, 'unsupported ZIP compression method');
    assert.equal(extraLength, 0, 'ZIP central extra fields are unsupported');
    assert.equal(commentLength, 0, 'ZIP entry comments are unsupported');
    assert.equal(view.getUint16(offset + 36, true), 0,
      'ZIP internal attributes are unsupported');
    if (creatorSystem === 3) {
      const fileType = (externalAttributes >>> 16) & 0o170000;
      assert.equal(fileType === 0 || fileType === 0o100000, true,
        'ZIP entry is not a regular file');
    } else {
      assert.equal((externalAttributes & 0x10) === 0, true,
        'ZIP entry is a directory');
    }
    const nameBytes = content.subarray(offset + 46, offset + 46 + nameLength);
    const encoding = (flags & 0x800) === 0 ? 'latin1' : 'utf-8';
    const path = new TextDecoder(encoding, {fatal: true}).decode(nameBytes);
    assert.match(path, /^(?!\/)(?!-)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0\r\n]+$/);
    assert.equal(path.endsWith('/'), false, 'Function source archive contains a directory entry');
    assert.ok(localOffset + 30 <= directoryOffset, 'ZIP local entry overlaps its directory');
    assert.equal(view.getUint32(localOffset, true), 0x04034b50, 'invalid ZIP local entry');
    assert.equal(view.getUint16(localOffset + 6, true), flags, 'ZIP flags disagree');
    assert.equal(view.getUint16(localOffset + 8, true), method, 'ZIP methods disagree');
    assert.equal(view.getUint32(localOffset + 14, true), checksum, 'ZIP checksums disagree');
    assert.equal(view.getUint32(localOffset + 18, true), compressedSize,
      'ZIP compressed sizes disagree');
    assert.equal(view.getUint32(localOffset + 22, true), originalSize,
      'ZIP original sizes disagree');
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    assert.equal(localExtraLength, 0, 'ZIP local extra fields are unsupported');
    const localName = content.subarray(localOffset + 30, localOffset + 30 + localNameLength);
    assert.deepEqual(localName, nameBytes, 'ZIP local and central paths disagree');
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    assert.ok(dataEnd <= directoryOffset, 'ZIP entry overlaps its directory');
    for (const [start, previousEnd] of dataRanges) {
      assert.equal(dataEnd <= start || localOffset >= previousEnd, true, 'ZIP entries overlap');
    }
    dataRanges.push([localOffset, dataEnd]);
    expandedBytes += originalSize;
    assert.ok(expandedBytes <= MAX_FUNCTION_SOURCE_BYTES,
      'Function source archive expands too large');
    const compressed = content.subarray(dataStart, dataEnd);
    const body = method === 0 ? compressed : new Uint8Array(inflateRawSync(compressed, {
      maxOutputLength: originalSize,
    }));
    assert.equal(body.byteLength, originalSize, 'ZIP entry size mismatch');
    assert.equal(crc32(body), checksum, 'ZIP entry checksum mismatch');
    entries.push({path, body});
    offset += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(offset, end);
  assert.equal(new Set(entries.map(({path}) => path)).size, entries.length,
    'Function source archive has duplicate paths');
  return entries.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

function sourceArchiveFiles(content: Uint8Array): Record<string, string> {
  assert.ok(content.byteLength <= MAX_FUNCTION_ARCHIVE_BYTES, 'Function source archive is too large');
  const entries = zipEntries(content).map(({path, body}) => [path, sha256(body)] as const);
  assert.ok(entries.length > 0, 'Function source archive is empty');
  return Object.fromEntries(entries);
}

interface TarEntry {
  path: string;
  type: number;
  mode: number;
  uid: number;
  gid: number;
  deviceMajor: number;
  deviceMinor: number;
  body: Uint8Array;
  linkName: string;
}

function tarString(content: Uint8Array): string {
  const end = content.indexOf(0);
  return new TextDecoder('utf-8', {fatal: true}).decode(
    end === -1 ? content : content.subarray(0, end),
  );
}

function tarOctal(content: Uint8Array): number {
  const value = tarString(content).trim();
  assert.match(value, /^[0-7]+$/);
  return Number.parseInt(value, 8);
}

function tarOptionalOctal(content: Uint8Array): number {
  const value = tarString(content).trim();
  if (value === '') return 0;
  assert.match(value, /^[0-7]+$/);
  return Number.parseInt(value, 8);
}

function tarEntries(content: Uint8Array): TarEntry[] {
  assert.ok(content.byteLength <= MAX_IMAGE_LAYER_EXPANDED_BYTES, 'tar archive expands too large');
  const entries: TarEntry[] = [];
  for (let offset = 0; offset < content.byteLength;) {
    assert.ok(offset + 512 <= content.byteLength, 'truncated tar header');
    const header = content.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) {
      assert.equal(content.subarray(offset).every((value) => value === 0), true);
      return entries;
    }
    const expectedChecksum = tarOctal(header.subarray(148, 156));
    const actualChecksum = header.reduce((sum, value, index) =>
      sum + (index >= 148 && index < 156 ? 32 : value), 0);
    assert.equal(actualChecksum, expectedChecksum, 'invalid tar checksum');
    const name = tarString(header.subarray(0, 100));
    const prefix = tarString(header.subarray(345, 500));
    const path = prefix === '' ? name : `${prefix}/${name}`;
    assert.match(path, /^(?!.*(?:^|\/)\.\.(?:\/|$))[^\0\r\n]+$/);
    const size = tarOctal(header.subarray(124, 136));
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    assert.ok(bodyEnd <= content.byteLength, 'truncated tar body');
    entries.push({
      path,
      type: header[156],
      mode: tarOctal(header.subarray(100, 108)),
      uid: tarOctal(header.subarray(108, 116)),
      gid: tarOctal(header.subarray(116, 124)),
      deviceMajor: tarOptionalOctal(header.subarray(329, 337)),
      deviceMinor: tarOptionalOctal(header.subarray(337, 345)),
      body: content.subarray(bodyStart, bodyEnd),
      linkName: tarString(header.subarray(157, 257)),
    });
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  assert.fail('tar archive has no zero terminator');
}

function runtimePath(value: string): string {
  const path = `/${value.replace(/^\.\//, '').replace(/^\//, '').replace(/\/$/, '')}`;
  assert.match(path, /^\/(?!.*(?:^|\/)\.\.(?:\/|$))[^\0\r\n]+$/);
  assert.equal(posix.normalize(path), path, 'noncanonical runtime path: ' + value);
  return path;
}

function assertNoSymlinkPathAliases(files: RuntimeFile[]): void {
  for (const symlink of files.filter(({type}) => type === 'symlink')) {
    assert.equal(files.some(({path}) => path.startsWith(symlink.path + '/')), false,
      'runtime path traverses a symlinked directory: ' + symlink.path);
  }
}

function assertNoEffectiveSymlinkAncestor(
  files: Map<string, {file: RuntimeFile; body?: Uint8Array}>,
  path: string,
): void {
  for (const {file} of files.values()) {
    if (file.type === 'symlink' && path.startsWith(file.path + '/')) {
      assert.fail('runtime layer path traverses an effective symlink: ' + path);
    }
  }
}

function runtimeFilesystem(layers: TarEntry[][]): {
  files: RuntimeFile[];
  bodies: Map<string, Uint8Array>;
} {
  const files = new Map<string, {file: RuntimeFile; body?: Uint8Array}>();
  const remove = (path: string): void => {
    for (const existing of [...files.keys()]) {
      if (existing === path || existing.startsWith(`${path}/`)) files.delete(existing);
    }
  };
  for (const layer of layers) {
    for (const entry of layer) {
      const path = runtimePath(entry.path);
      assertNoEffectiveSymlinkAncestor(files, path);
      const name = path.split('/').at(-1)!;
      if (name === '.wh..wh..opq') {
        const directory = path.slice(0, -'/.wh..wh..opq'.length) || '/';
        for (const existing of [...files.keys()]) {
          if (existing.startsWith(`${directory === '/' ? '' : directory}/`)) files.delete(existing);
        }
      } else if (name.startsWith('.wh.')) {
        const directory = path.slice(0, -(name.length + 1));
        remove(`${directory}/${name.slice('.wh.'.length)}`);
      }
    }
    for (const entry of layer) {
      const path = runtimePath(entry.path);
      assertNoEffectiveSymlinkAncestor(files, path);
      const name = path.split('/').at(-1)!;
      if (name === '.wh..wh..opq' || name.startsWith('.wh.')) continue;
      const shared = {path, mode: entry.mode, uid: entry.uid, gid: entry.gid};
      let file: RuntimeFile;
      let body: Uint8Array | undefined;
      if (entry.type === 0 || entry.type === 48) {
        file = {...shared, type: 'file', sha256: sha256(entry.body)};
        body = entry.body;
      } else if (entry.type === 49) {
        assert.match(entry.linkName, /^[^\0\r\n]+$/);
        const linkName = runtimePath(entry.linkName);
        const target = files.get(linkName);
        assert.ok(target?.body !== undefined, 'hardlink target is not a file: ' + linkName);
        file = {
          ...shared,
          type: 'hardlink',
          linkName,
          sha256: sha256(target.body),
        };
        body = target.body;
      } else if (entry.type === 50) {
        assert.match(entry.linkName, /^[^\0\r\n]+$/);
        file = {...shared, type: 'symlink', linkName: entry.linkName};
      } else if (entry.type === 51 || entry.type === 52) {
        file = {
          ...shared,
          type: entry.type === 51 ? 'character' : 'block',
          deviceMajor: entry.deviceMajor,
          deviceMinor: entry.deviceMinor,
        };
      } else if (entry.type === 53) {
        file = {...shared, type: 'directory'};
      } else if (entry.type === 54) {
        file = {...shared, type: 'fifo'};
      } else {
        assert.fail(`unsupported runtime tar entry type ${entry.type}: ${path}`);
      }
      const previous = files.get(path)?.file;
      if (file.type !== 'directory' || (previous !== undefined && previous.type !== 'directory')) {
        remove(path);
      }
      files.set(path, {file, ...(body === undefined ? {} : {body})});
    }
  }
  const sorted = [...files.values()].map(({file}) => file).sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  assertNoSymlinkPathAliases(sorted);
  const bodies = new Map([...files.entries()].flatMap(([path, value]) =>
    value.body === undefined ? [] : [[path, value.body] as const]));
  return {files: sorted, bodies};
}

function imageExecutionConfig(value: unknown): Record<string, unknown> {
  const config = record(value);
  assert.ok(Object.keys(config).every((key) => [
    'Hostname', 'Domainname', 'User', 'AttachStdin', 'AttachStdout', 'AttachStderr',
    'ExposedPorts', 'Tty', 'OpenStdin', 'StdinOnce', 'Env', 'Cmd', 'Healthcheck',
    'ArgsEscaped', 'Image', 'Volumes', 'WorkingDir', 'Entrypoint', 'NetworkDisabled',
    'MacAddress', 'OnBuild', 'Labels', 'StopSignal', 'StopTimeout', 'Shell',
  ].includes(key)), 'OCI image configuration contains an unknown execution field');
  array(config.Entrypoint ?? []).map(string);
  array(config.Cmd ?? []).map(string);
  array(config.Env ?? []).map(string);
  array(config.OnBuild ?? []).map(string);
  array(config.Shell ?? []).map(string);
  nullableString(config.User);
  nullableString(config.WorkingDir);
  nullableString(config.StopSignal);
  record(config.ExposedPorts ?? {});
  record(config.Healthcheck ?? {});
  record(config.Labels ?? {});
  record(config.Volumes ?? {});
  return config;
}

function sourceTarGzipFiles(content: Uint8Array): Record<string, string> {
  assert.ok(content.byteLength <= MAX_FUNCTION_ARCHIVE_BYTES, 'Function source tar is too large');
  const entries: Array<readonly [string, string]> = [];
  let expandedBytes = 0;
  for (const entry of tarEntries(gunzipSync(content, {
    maxOutputLength: MAX_FUNCTION_SOURCE_TAR_BYTES,
  }))) {
    const path = entry.path.replace(/^\.\//, '');
    if (entry.type === 53) continue;
    assert.ok(entry.type === 0 || entry.type === 48, `unsupported source tar entry: ${path}`);
    assert.notEqual(path, '');
    assert.match(path, /^(?!\/)(?!-)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0\r\n]+$/);
    expandedBytes += entry.body.byteLength;
    assert.ok(expandedBytes <= MAX_FUNCTION_SOURCE_BYTES,
      'Function source tar expands too large');
    entries.push([path, sha256(entry.body)]);
  }
  assert.equal(new Set(entries.map(([path]) => path)).size, entries.length,
    'Function source tar has duplicate paths');
  assert.ok(entries.length > 0, 'Function source tar is empty');
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
  versionId: string | null,
): Promise<Record<string, string>> {
  if (generation === 'GEN_2') {
    assert.equal(versionId, null);
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
  assert.ok(versionId !== null);
  assert.match(versionId, /^[1-9][0-9]*$/);
  const generated = await json(
    fetch_,
    `https://cloudfunctions.googleapis.com/v1/projects/${projectId}/locations/${region}/functions/${name}:generateDownloadUrl`,
    accessToken,
    projectId,
    {method: 'POST', body: JSON.stringify({versionId})},
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

function environmentList(value: unknown): Record<string, string> {
  const entries = array(value ?? []).map(string).map((entry) => {
    const separator = entry.indexOf('=');
    assert.ok(separator > 0, `invalid build environment entry: ${entry}`);
    return [entry.slice(0, separator), entry.slice(separator + 1)] as const;
  });
  assert.equal(new Set(entries.map(([name]) => name)).size, entries.length,
    'duplicate build environment variable');
  return Object.fromEntries(entries);
}

async function assertCloudBuildAudit(
  fetch_: FetchLike,
  target: DeploymentTarget,
  accessToken: string,
  buildId: string,
  startTime: string,
  finishTime: string,
): Promise<void> {
  const entries: Record<string, unknown>[] = [];
  const auditWindowStart = new Date(Date.parse(startTime) - 10 * 60 * 1000).toISOString();
  const auditWindowEnd = new Date(Date.parse(finishTime) + 10 * 60 * 1000).toISOString();
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_API_PAGES; page += 1) {
    const body = {
      resourceNames: [`projects/${target.projectId}`],
      filter: [
        'resource.type="build"',
        `resource.labels.build_id="${buildId}"`,
        `logName="projects/${target.projectId}/logs/cloudaudit.googleapis.com%2Factivity"`,
        'protoPayload.methodName="google.devtools.cloudbuild.v1.CloudBuild.CreateBuild"',
        `timestamp>="${auditWindowStart}"`,
        `timestamp<="${auditWindowEnd}"`,
      ].join(' AND '),
      orderBy: 'timestamp asc',
      ...(pageToken === undefined ? {} : {pageToken}),
    };
    const response = await json(
      fetch_, 'https://logging.googleapis.com/v2/entries:list', accessToken, target.projectId,
      {method: 'POST', body: JSON.stringify(body)},
    );
    entries.push(...array(response.entries ?? []).map(record));
    const next = response.nextPageToken;
    if (next === undefined || string(next).trim() === '') break;
    assert.ok(page + 1 < MAX_API_PAGES,
      'Cloud Build image log exceeded the maximum number of pages');
    pageToken = string(next);
  }
  const auditEntries = entries.filter((entry) => entry.logName ===
    `projects/${target.projectId}/logs/cloudaudit.googleapis.com%2Factivity`);
  assert.equal(auditEntries.length, 2,
    'Cloud Build must have exactly one administrative creation lifecycle');
  const [firstEntry, lastEntry] = auditEntries;
  const operationId = string(record(firstEntry.operation).id);
  assert.equal(operationId.startsWith(`operations/build/${target.projectId}/`), true);
  assert.ok(operationId.length > `operations/build/${target.projectId}/`.length);
  assert.deepEqual(record(firstEntry.operation), {
    first: true,
    id: operationId,
    producer: 'cloudbuild.googleapis.com',
  });
  assert.deepEqual(record(lastEntry.operation), {
    id: operationId,
    last: true,
    producer: 'cloudbuild.googleapis.com',
  });
  assert.equal(Date.parse(string(firstEntry.timestamp)) <= Date.parse(startTime), true);
  assert.equal(Date.parse(string(firstEntry.timestamp)) >= Date.parse(auditWindowStart), true);
  assert.equal(Date.parse(string(lastEntry.timestamp)) >= Date.parse(finishTime), true);
  assert.equal(Date.parse(string(lastEntry.timestamp)) <= Date.parse(auditWindowEnd), true);
  for (const auditEntry of auditEntries) {
    assert.equal(auditEntry.severity, 'NOTICE');
    const auditResource = record(auditEntry.resource);
    assert.equal(auditResource.type, 'build');
    assert.deepEqual(stringRecord(record(auditResource.labels)), {
      build_id: buildId,
      build_trigger_id: '',
      project_id: target.projectId,
    });
    const audit = record(auditEntry.protoPayload);
    assert.equal(audit.serviceName, 'cloudbuild.googleapis.com');
    assert.equal(audit.methodName, 'google.devtools.cloudbuild.v1.CloudBuild.CreateBuild');
    assert.equal(audit.resourceName, `projects/${target.projectId}/builds`);
    assert.deepEqual(record(audit.status), {});
    assert.equal(
      record(audit.authenticationInfo).principalEmail,
      `service-${target.projectNumber}@gcf-admin-robot.iam.gserviceaccount.com`,
    );
    assert.equal(array(audit.authorizationInfo).map(record).some((authorization) =>
      authorization.permission === 'cloudbuild.builds.create' &&
      authorization.granted === true), true);
  }
}

async function cloudBuildOutputDigest(
  fetch_: FetchLike,
  target: DeploymentTarget,
  accessToken: string,
  buildId: string,
  startTime: string,
  finishTime: string,
): Promise<string> {
  const entries: Record<string, unknown>[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_API_PAGES; page += 1) {
    const body = {
      resourceNames: [`projects/${target.projectId}`],
      filter: [
        'resource.type="build"',
        `resource.labels.build_id="${buildId}"`,
        `logName="projects/${target.projectId}/logs/cloudbuild"`,
        'labels.build_step="Step #2 - \\"build\\""',
        'textPayload:"*** Images (sha256:"',
        `timestamp>="${startTime}"`,
        `timestamp<="${finishTime}"`,
      ].join(' AND '),
      orderBy: 'timestamp asc',
      ...(pageToken === undefined ? {} : {pageToken}),
    };
    const response = await json(
      fetch_, 'https://logging.googleapis.com/v2/entries:list', accessToken, target.projectId,
      {method: 'POST', body: JSON.stringify(body)},
    );
    entries.push(...array(response.entries ?? []).map(record));
    const next = response.nextPageToken;
    if (next === undefined || string(next).trim() === '') break;
    assert.ok(page + 1 < MAX_API_PAGES,
      'Cloud Build output digest exceeded the maximum number of pages');
    pageToken = string(next);
  }
  const outputEntries = entries.filter((entry) =>
    entry.logName === `projects/${target.projectId}/logs/cloudbuild`);
  assert.equal(outputEntries.length, 1,
    'capture requires exactly one retained Cloud Build output-image digest');
  const entry = outputEntries[0];
  assert.ok(Object.keys(entry).every((key) => [
    'insertId', 'labels', 'logName', 'receiveTimestamp', 'resource', 'severity',
    'textPayload', 'timestamp',
  ].includes(key)));
  assert.match(string(entry.insertId), new RegExp(`^${buildId}-[1-9][0-9]*$`));
  assert.equal(entry.logName, `projects/${target.projectId}/logs/cloudbuild`);
  assert.equal(entry.severity, 'INFO');
  assert.equal(Date.parse(string(entry.timestamp)) >= Date.parse(startTime), true);
  assert.equal(Date.parse(string(entry.timestamp)) <= Date.parse(finishTime), true);
  assert.deepEqual(stringRecord(entry.labels), {build_step: 'Step #2 - "build"'});
  const resource = record(entry.resource);
  assert.equal(resource.type, 'build');
  assert.deepEqual(stringRecord(record(resource.labels)), {
    build_id: buildId,
    build_trigger_id: '',
    project_id: target.projectId,
  });
  const match = string(entry.textPayload).match(
    /^Step #2 - "build": \*\*\* Images \((sha256:[0-9a-f]{64})\):$/,
  );
  assert.ok(match !== null);
  return match[1];
}

function assertManagedFunctionBuild(
  build: Record<string, unknown>,
  target: DeploymentTarget,
  region: string,
  buildId: string,
  storageSource: Record<string, unknown>,
  function_: Pick<ExpectedFunction, 'name' | 'entryPoint' | 'event'>,
): void {
  assert.equal(build.serviceAccount, undefined);
  assert.equal(build.workerPool, undefined);
  assert.deepEqual(build.secrets ?? [], []);
  assert.deepEqual(build.availableSecrets ?? {}, {});
  assert.deepEqual(build.images ?? [], []);
  assert.deepEqual(build.artifacts ?? {}, {});
  assert.deepEqual(build.sourceProvenance ?? {}, {});
  const steps = array(build.steps).map(record);
  assert.deepEqual(steps.map((step) => step.id), ['fetch', 'pre-buildpack', 'build']);
  for (const step of steps) {
    assert.ok(Object.keys(step).every((key) => [
      'args', 'entrypoint', 'env', 'id', 'name', 'pullTiming', 'status', 'timing',
    ].includes(key)));
    assert.equal(step.status, 'SUCCESS');
  }
  const [fetchStep, preBuildStep, buildStep] = steps;
  assert.match(string(fetchStep.name), new RegExp(
    `^${region}-docker\\.pkg\\.dev/serverless-runtimes/utilities/gcs-fetcher:[A-Za-z0-9_.-]+$`,
  ));
  assert.deepEqual(array(fetchStep.args).map(string), [
    '--type=ZipArchive',
    `--location=gs://${string(storageSource.bucket)}/${string(storageSource.object)}`,
    '--dest_dir=/workspace',
    '--timeout_gcs=false',
  ]);
  assert.equal(fetchStep.entrypoint, undefined);
  assert.deepEqual(fetchStep.env ?? [], []);

  const packageName = [target.projectId, region, function_.name]
    .map((part) => part.replaceAll('-', '--')).join('__');
  const imageBase = `${region}-docker.pkg.dev/${target.projectId}/gcf-artifacts/${packageName}`;
  const builderPattern = new RegExp(
    `^${region}-docker\\.pkg\\.dev/serverless-runtimes/google-22-full/builder/nodejs:[A-Za-z0-9_.-]+$`,
  );
  assert.match(string(preBuildStep.name), builderPattern);
  assert.equal(buildStep.name, preBuildStep.name);
  assert.equal(preBuildStep.entrypoint, '/bin/shim');
  assert.equal(buildStep.entrypoint, '/cnb/lifecycle/creator');
  const preBuildArguments = array(preBuildStep.args).map(string);
  const environmentNamesPrefix = '--env_var_names=';
  assert.equal(preBuildArguments[5].startsWith(environmentNamesPrefix), true);
  const environmentNames = preBuildArguments[5].slice(environmentNamesPrefix.length).split(',');
  assert.equal(new Set(environmentNames).size, environmentNames.length);
  assert.deepEqual(environmentNames.filter((name) =>
    name !== 'X_GOOGLE_FASTER_LANGUAGE_TARBALL_INSTALLATION'), [
    'BUILDER_OUTPUT', 'GOOGLE_RUNTIME', 'GOOGLE_LABEL_BUILDER_VERSION',
    'GOOGLE_LABEL_BUILDER_IMAGE', 'GOOGLE_LABEL_RUN_IMAGE', 'GOOGLE_LABEL_SOURCE',
    'GOOGLE_USE_SERVERLESS_RUNTIMES_TARBALLS', 'GOOGLE_RUNTIME_IMAGE_REGION',
    'GOOGLE_RUNTIME_VERSION', 'X_GOOGLE_SKIP_RUNTIME_LAUNCH', 'GOOGLE_BUILD_ENV',
    'GOOGLE_BUILD_UNIVERSE', 'GOOGLE_TPC_TARBALL_PROJECT', 'GOOGLE_TPC_HOSTNAME',
    'GOOGLE_FUNCTION_TARGET', 'GOOGLE_FUNCTION_SIGNATURE_TYPE', 'X_GOOGLE_TARGET_PLATFORM',
    'GOOGLE_LABEL_BUILD_ID', 'GOOGLE_LABEL_BASE_IMAGE', 'GOOGLE_LABEL_FUNCTION_TARGET',
    'X_GOOGLE_SET_NODE_HEAP_SIZE', 'GOOGLE_NODE_RUN_SCRIPTS',
  ]);
  assert.deepEqual(preBuildArguments, [
    '--phase=pre',
    `--app_image_unique=${imageBase}:version_1`,
    `--app_image_stable=${imageBase}:latest`,
    `--cache_image_unique=${imageBase}/cache:${buildId}`,
    `--cache_image_stable=${imageBase}/cache:latest`,
    preBuildArguments[5],
    '--experimental_skip_retag_cache',
  ]);
  const preEnvironment = environmentList(preBuildStep.env);
  assert.equal(preEnvironment.GOOGLE_RUNTIME, 'nodejs22');
  assert.equal(preEnvironment.GOOGLE_LABEL_SOURCE,
    `gs://${string(storageSource.bucket)}/${string(storageSource.object)}#${
      string(storageSource.generation)}`);
  assert.equal(preEnvironment.GOOGLE_LABEL_BUILD_ID, buildId);
  assert.equal(preEnvironment.GOOGLE_FUNCTION_TARGET, function_.entryPoint);
  assert.equal(preEnvironment.GOOGLE_FUNCTION_SIGNATURE_TYPE,
    function_.event === null ? 'http' : 'event');
  assert.equal(preEnvironment.X_GOOGLE_TARGET_PLATFORM, 'gcf');
  assert.match(string(preEnvironment.GOOGLE_LABEL_BUILDER_IMAGE), builderPattern);
  assert.match(string(preEnvironment.GOOGLE_LABEL_RUN_IMAGE), new RegExp(
    `^${region}-docker\\.pkg\\.dev/serverless-runtimes/google-22-full/scratch/nodejs22:[A-Za-z0-9_.-]+$`,
  ));
  assert.match(string(preEnvironment.GOOGLE_LABEL_BASE_IMAGE), new RegExp(
    `^${region}-docker\\.pkg\\.dev/serverless-runtimes/google-22-full/runtimes/nodejs22$`,
  ));
  assert.deepEqual(array(buildStep.args).map(string), [
    `--tag=${imageBase}:latest`,
    `${imageBase}:version_1`,
  ]);
  assert.deepEqual(environmentList(buildStep.env), {
    CNB_RUN_IMAGE: preEnvironment.GOOGLE_LABEL_RUN_IMAGE,
  });
  const options = record(build.options);
  assert.ok(Object.keys(options).every((key) => [
    'env', 'logStreamingOption', 'logging', 'pool', 'volumes',
  ].includes(key)));
  assert.deepEqual(record(options.pool ?? {}), {});
  assert.deepEqual(array(options.volumes).map(record), [
    {name: 'layers', path: '/layers'},
    {name: 'platform', path: '/platform'},
  ]);
  assert.equal(options.logStreamingOption, 'STREAM_OFF');
  assert.equal(options.logging, 'CLOUD_LOGGING_ONLY');
  const optionEnvironment = environmentList(options.env);
  assert.equal(optionEnvironment.CNB_CACHE_IMAGE, `${imageBase}/cache:latest`);
  assert.equal(optionEnvironment.CNB_PREVIOUS_IMAGE, `${imageBase}:latest`);
  assert.deepEqual(Object.keys(optionEnvironment).sort(), [
    'CNB_ANALYZED_PATH', 'CNB_APP_DIR', 'CNB_BUILDPACKS_DIR', 'CNB_CACHE_IMAGE',
    'CNB_GROUP_ID', 'CNB_GROUP_PATH', 'CNB_LAYERS_DIR', 'CNB_NO_COLOR',
    'CNB_PLATFORM_API', 'CNB_PLATFORM_DIR', 'CNB_PLAN_PATH', 'CNB_PREVIOUS_IMAGE',
    'CNB_USER_ID',
  ].sort());
  const substitutions = stringRecord(build.substitutions);
  for (const [name, value] of Object.entries(substitutions)) {
    assert.match(name, /^_[A-Z][A-Z0-9_]*$/);
    assert.equal(preEnvironment[name.slice(1)], value);
  }
  assert.equal(substitutions._GOOGLE_LABEL_BUILD_ID, undefined);
  assert.deepEqual(array(build.tags).map(string).sort(), [
    'bt-LIFECYCLE',
    'p-gcf',
    `r-nodejs22`,
    `service_${function_.name}`,
    't-function',
    string(array(build.tags).map(string).find((tag) => /^b-[A-Za-z0-9_.-]+$/.test(tag))),
    string(array(build.tags).map(string).find((tag) => /^v-nodejs22_[A-Za-z0-9_.-]+$/.test(tag))),
  ].sort());
  assert.equal(build.timeout, '1800s');
  assert.equal(build.queueTtl, '360s');
}

async function functionBuild(
  fetch_: FetchLike,
  target: DeploymentTarget,
  accessToken: string,
  region: string,
  buildName: unknown,
  storageSource: Record<string, unknown>,
  function_: Pick<ExpectedFunction, 'name' | 'entryPoint' | 'event' | 'runtimeAttestation'>,
): Promise<{
  buildId: string;
  buildSource: string;
  buildImageDigest: string | null;
  startTime: string;
  finishTime: string;
}> {
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
  assertManagedFunctionBuild(build, target, region, buildId, storageSource, function_);
  const buildSource = `gs://${string(storageSource.bucket)}/${string(storageSource.object)}#${
    string(storageSource.generation)}`;
  await assertCloudBuildAudit(
    fetch_, target, accessToken, buildId, startTime, finishTime,
  );
  const buildImageDigest = function_.runtimeAttestation === null ?
    await cloudBuildOutputDigest(
      fetch_, target, accessToken, buildId, startTime, finishTime,
    ) : null;
  return {buildId, buildSource, buildImageDigest, startTime, finishTime};
}

async function imageProvenance(
  fetch_: FetchLike,
  projectId: string,
  accessToken: string,
  image: string,
  buildWindow: {startTime: string; finishTime: string},
): Promise<{
  imageBuildId: string;
  imageSource: string;
  imageSourceFiles: Record<string, string>;
  imageRuntimeAttestation: Omit<RuntimeAttestation, 'deploymentCommit'>;
}> {
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
  const [manifestResponse, metadata] = await Promise.all([
    fetchWithRetry(
      fetch_, `${base}/manifests/${digest}`,
      {headers: authenticatedHeaders(accessToken, projectId)},
      [200], 'immutable Function image manifest download',
    ),
    json(fetch_, `https://artifactregistry.googleapis.com/v1/${metadataName}`,
      accessToken, projectId),
  ]);
  const manifestBytes = new Uint8Array(await manifestResponse.arrayBuffer());
  assert.equal(`sha256:${sha256(manifestBytes)}`, digest,
    'Function image manifest does not match its digest');
  const manifest = record(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(manifestBytes)));
  assert.equal(metadata.uri, image);
  assert.deepEqual(array(metadata.tags).map(string).sort(), ['latest', 'version_1']);
  const uploadTime = Date.parse(string(metadata.uploadTime));
  const updateTime = Date.parse(string(metadata.updateTime));
  assert.equal(uploadTime >= Date.parse(buildWindow.startTime), true);
  assert.equal(uploadTime <= Date.parse(buildWindow.finishTime), true);
  assert.equal(updateTime >= uploadTime, true);
  assert.equal(updateTime <= Date.parse(buildWindow.finishTime), true);
  assertExactKeys(manifest, ['schemaVersion', 'mediaType', 'config', 'layers']);
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(
    manifest.mediaType,
    'application/vnd.docker.distribution.manifest.v2+json',
  );
  const config = record(manifest.config);
  assertExactKeys(config, ['mediaType', 'size', 'digest']);
  assert.equal(config.mediaType, 'application/vnd.docker.container.image.v1+json');
  const configDigest = string(config.digest);
  assert.match(configDigest, /^sha256:[0-9a-f]{64}$/);
  const configResponse = await fetchWithRetry(
    fetch_, `${base}/blobs/${configDigest}`,
    {headers: authenticatedHeaders(accessToken, projectId)},
    [200], 'immutable Function image configuration download',
  );
  const configBytes = new Uint8Array(await configResponse.arrayBuffer());
  assert.equal(configBytes.byteLength, number(config.size));
  assert.equal(`sha256:${sha256(configBytes)}`, configDigest,
    'Function image configuration does not match its digest');
  const imageConfig = record(JSON.parse(
    new TextDecoder('utf-8', {fatal: true}).decode(configBytes),
  ));
  assert.ok(Object.keys(imageConfig).every((key) => [
    'architecture', 'config', 'created', 'history', 'os', 'rootfs',
  ].includes(key)), 'OCI image metadata contains an unknown field');
  assert.equal(imageConfig.architecture, 'amd64');
  assert.equal(imageConfig.os, 'linux');
  array(imageConfig.history).map(record);
  const rootfs = record(imageConfig.rootfs);
  assert.equal(rootfs.type, 'layers');
  const diffIds = array(rootfs.diff_ids).map(string);
  assert.equal(diffIds.length, array(manifest.layers).length);
  const labels = stringRecord(record(imageConfig.config).Labels);
  const runtimeLayers: TarEntry[][] = [];
  for (const [index, layerValue] of array(manifest.layers).entries()) {
    const layer = record(layerValue);
    assertExactKeys(layer, ['mediaType', 'size', 'digest']);
    assert.equal(layer.mediaType, 'application/vnd.docker.image.rootfs.diff.tar.gzip');
    const layerDigest = string(layer.digest);
    assert.match(layerDigest, /^sha256:[0-9a-f]{64}$/);
    const layerSize = number(layer.size);
    assert.ok(layerSize <= MAX_IMAGE_LAYER_BYTES, 'Function image layer is too large');
    const layerResponse = await fetchWithRetry(
      fetch_, `${base}/blobs/${layerDigest}`,
      {headers: authenticatedHeaders(accessToken, projectId)},
      [200], 'immutable Function image layer download',
    );
    const layerBytes = new Uint8Array(await layerResponse.arrayBuffer());
    assert.equal(layerBytes.byteLength, layerSize);
    assert.equal(`sha256:${sha256(layerBytes)}`, layerDigest,
      'Function image layer does not match its digest');
    const expandedLayer = gunzipSync(layerBytes, {
      maxOutputLength: MAX_IMAGE_LAYER_EXPANDED_BYTES,
    });
    assert.equal(`sha256:${sha256(expandedLayer)}`, diffIds[index],
      'Function image layer does not match its rootfs diff ID');
    const entries = tarEntries(expandedLayer);
    runtimeLayers.push(entries);
  }
  const runtime = runtimeFilesystem(runtimeLayers);
  const sourceTar = runtime.bodies.get(
    '/layers/google.utils.archive-source/src/source-code.tar.gz',
  );
  assert.ok(sourceTar !== undefined, 'Function image has no archived build input');
  return {
    imageBuildId: string(labels['google.build-id']),
    imageSource: string(labels['google.source']),
    imageSourceFiles: sourceTarGzipFiles(sourceTar),
    imageRuntimeAttestation: {
      imageDigest: digest,
      executionConfig: imageExecutionConfig(imageConfig.config),
      files: runtime.files,
    },
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

function normalizedRunEnvironment(value: unknown): Record<string, unknown>[] {
  const environment = array(value ?? []).map((entryValue) => {
    const entry = record(entryValue);
    assert.ok(Object.keys(entry).every((key) => ['name', 'value', 'valueSource'].includes(key)),
      'Cloud Run environment entry contains an unknown field');
    const name = string(entry.name);
    assert.match(name, /^[A-Za-z_][A-Za-z0-9_]*$/);
    assert.notEqual(entry.value === undefined, entry.valueSource === undefined,
      `Cloud Run environment ${name} must have exactly one value source`);
    return {
      name,
      ...(entry.value === undefined ? {valueSource: record(entry.valueSource)} : {
        value: string(entry.value),
      }),
    };
  }).sort((left, right) => string(left.name).localeCompare(string(right.name)));
  assert.equal(new Set(environment.map(({name}) => name)).size, environment.length,
    'duplicate Cloud Run environment variable');
  return environment;
}

function normalizedRunContainer(value: Record<string, unknown>): Record<string, unknown> {
  assert.ok(Object.keys(value).every((key) => [
    'name', 'image', 'command', 'args', 'env', 'resources', 'ports', 'volumeMounts',
    'workingDir', 'livenessProbe', 'startupProbe', 'dependsOn', 'baseImageUri',
    'buildInfo',
  ].includes(key)), 'Cloud Run container response contains an unknown execution field');
  return {
    name: string(value.name),
    image: string(value.image),
    command: array(value.command ?? []).map(string),
    args: array(value.args ?? []).map(string),
    environment: normalizedRunEnvironment(value.env),
    resources: record(value.resources),
    ports: array(value.ports ?? []).map(record),
    volumeMounts: array(value.volumeMounts ?? []).map(record),
    workingDir: nullableString(value.workingDir),
    livenessProbe: record(value.livenessProbe ?? {}),
    startupProbe: record(value.startupProbe ?? {}),
    dependsOn: array(value.dependsOn ?? []).map(string),
    baseImageUri: string(value.baseImageUri),
    ...(value.buildInfo === undefined ? {} : {buildInfo: record(value.buildInfo)}),
  };
}

function normalizedRunTemplate(value: Record<string, unknown>): Record<string, unknown> {
  assert.ok(Object.keys(value).every((key) => [
    'revision', 'labels', 'annotations', 'client', 'containers', 'volumes',
    'scaling', 'vpcAccess', 'serviceAccount', 'maxInstanceRequestConcurrency',
    'timeout', 'executionEnvironment', 'encryptionKey', 'serviceMesh',
    'encryptionKeyRevocationAction', 'encryptionKeyShutdownDuration',
    'sessionAffinity', 'gpuZonalRedundancyDisabled', 'nodeSelector',
    'healthCheckDisabled', 'baseImageUri',
  ].includes(key)), 'Cloud Run revision template contains an unknown execution field');
  return {
    revision: string(value.revision),
    labels: record(value.labels ?? {}),
    annotations: record(value.annotations ?? {}),
    client: nullableString(value.client),
    baseImageUri: nullableString(value.baseImageUri),
    serviceAccount: string(value.serviceAccount),
    timeout: string(value.timeout),
    maxInstanceRequestConcurrency: number(value.maxInstanceRequestConcurrency),
    scaling: record(value.scaling ?? {}),
    vpcAccess: record(value.vpcAccess ?? {}),
    encryptionKey: nullableString(value.encryptionKey),
    serviceMesh: record(value.serviceMesh ?? {}),
    encryptionKeyRevocationAction: nullableString(value.encryptionKeyRevocationAction),
    encryptionKeyShutdownDuration: nullableString(value.encryptionKeyShutdownDuration),
    sessionAffinity: value.sessionAffinity === true,
    executionEnvironment: nullableString(value.executionEnvironment),
    gpuZonalRedundancyDisabled: value.gpuZonalRedundancyDisabled === true,
    nodeSelector: record(value.nodeSelector ?? {}),
    healthCheckDisabled: value.healthCheckDisabled === true,
    volumes: array(value.volumes ?? []).map(record),
    containers: array(value.containers).map((container) =>
      normalizedRunContainer(record(container))),
  };
}

function normalizeRunConfiguration(
  value: Record<string, unknown>,
  projectId: string,
  projectNumber: string,
  region: string,
  name: string,
): Record<string, unknown> {
  const template = normalizedRunTemplate(record(value.template));
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
      command: array(container.command).map(string),
      args: array(container.args).map(string),
      environment: array(container.environment).map(record),
      resources: record(container.resources),
      ports: array(container.ports ?? []).map(record),
      workingDir: nullableString(container.workingDir),
      livenessProbe: record(container.livenessProbe),
      startupProbe: record(container.startupProbe),
      volumeMounts: array(container.volumeMounts ?? []).map(record),
      dependsOn: array(container.dependsOn ?? []).map(string),
    };
  });
  const uri = string(value.uri);
  assert.match(uri, new RegExp(
    `^https://${name}-[a-z0-9]{10}-[a-z]{2}\\.a\\.run\\.app$`,
  ));
  assert.deepEqual(array(value.urls).map(string).sort(), [
    `https://${region}-${projectId}.cloudfunctions.net/${name}`,
    `https://${name}-${projectNumber}.${region}.run.app`,
    uri,
  ].sort());
  const buildConfig = record(value.buildConfig);
  assertExactKeys(buildConfig, [
    'name', 'sourceLocation', 'functionTarget', 'imageUri', 'baseImage',
    'enableAutomaticUpdates', 'environmentVariables',
  ]);
  return {
    labels: record(value.labels ?? {}),
    annotations: record(value.annotations ?? {}),
    launchStage: nullableString(value.launchStage),
    client: nullableString(value.client),
    clientVersion: nullableString(value.clientVersion),
    urls: ['cloudfunctions', 'numeric-run', 'stable-run'],
    sshEnabled: value.sshEnabled === true,
    buildConfig: {
      name: string(buildConfig.name),
      sourceLocation: string(buildConfig.sourceLocation),
      functionTarget: string(buildConfig.functionTarget),
      imageUri: string(buildConfig.imageUri),
      baseImage: string(buildConfig.baseImage),
      enableAutomaticUpdates: boolean(buildConfig.enableAutomaticUpdates),
      environmentVariables: stringRecord(buildConfig.environmentVariables),
    },
    ingress: string(value.ingress),
    customAudiences: array(value.customAudiences ?? []).map(string).sort(),
    binaryAuthorization: record(value.binaryAuthorization ?? {}),
    iapEnabled: value.iapEnabled === true,
    scaling: record(value.scaling ?? {}),
    template: {
      revision: string(template.revision),
      labels: record(template.labels ?? {}),
      annotations: record(template.annotations ?? {}),
      client: nullableString(template.client),
      baseImageUri: nullableString(template.baseImageUri),
      serviceAccount: string(template.serviceAccount),
      timeout: string(template.timeout),
      maxInstanceRequestConcurrency: number(template.maxInstanceRequestConcurrency),
      scaling: record(template.scaling ?? {}),
      vpcAccess: record(template.vpcAccess ?? {}),
      encryptionKey: nullableString(template.encryptionKey),
      serviceMesh: record(template.serviceMesh ?? {}),
      encryptionKeyRevocationAction: nullableString(template.encryptionKeyRevocationAction),
      encryptionKeyShutdownDuration: nullableString(template.encryptionKeyShutdownDuration),
      sessionAffinity: template.sessionAffinity === true,
      executionEnvironment: nullableString(template.executionEnvironment),
      gpuZonalRedundancyDisabled: template.gpuZonalRedundancyDisabled === true,
      nodeSelector: record(template.nodeSelector ?? {}),
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
  projectNumber: string,
  accessToken: string,
  region: string,
  name: string,
  entryPoint: string,
  storageSource: Record<string, unknown>,
  functionHash: string,
  event: FunctionEvent | null,
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
  assert.ok(Object.keys(service).every((key) => [
    'name', 'description', 'uid', 'generation', 'labels', 'annotations', 'createTime',
    'updateTime', 'deleteTime', 'expireTime', 'creator', 'lastModifier', 'client',
    'clientVersion', 'ingress', 'launchStage', 'binaryAuthorization', 'template',
    'traffic', 'scaling', 'invokerIamDisabled', 'defaultUri', 'customAudiences',
    'observedGeneration', 'terminalCondition', 'conditions', 'latestReadyRevision',
    'latestCreatedRevision', 'trafficStatuses', 'uri', 'reconciling', 'etag',
    'iapEnabled', 'threatDetectionEnabled', 'urls', 'sshEnabled', 'buildConfig',
  ].includes(key)), 'Cloud Run service response contains an unknown field');
  assert.equal(
    service.name,
    `projects/${projectId}/locations/${region}/services/${name}`,
  );
  const serviceLabels = {
    'firebase-functions-hash': functionHash,
    'goog-cloudfunctions-runtime': 'nodejs22',
    'goog-drz-cloudfunctions-id': name,
    'goog-drz-cloudfunctions-location': region,
    'goog-managed-by': 'cloudfunctions',
  };
  const templateLabels = {
    'firebase-functions-hash': functionHash,
    'goog-drz-cloudfunctions-id': name,
    'goog-drz-cloudfunctions-location': region,
  };
  const triggerType = event?.type ?? 'HTTP_TRIGGER';
  assert.deepEqual(record(service.labels), serviceLabels);
  assert.deepEqual(record(service.annotations), {
    'cloudfunctions.googleapis.com/function-id': name,
  });
  assert.equal(service.launchStage, 'GA');
  assert.deepEqual(record(record(service.template).labels), templateLabels);
  assert.deepEqual(record(record(service.template).annotations), {
    'cloudfunctions.googleapis.com/trigger-type': triggerType,
  });
  assert.equal(record(service.template).client, 'cli-firebase');
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
  assert.ok(Object.keys(revision).every((key) => [
    'name', 'uid', 'generation', 'labels', 'annotations', 'createTime', 'updateTime',
    'deleteTime', 'expireTime', 'launchStage', 'service', 'scaling', 'vpcAccess',
    'maxInstanceRequestConcurrency', 'timeout', 'serviceAccount', 'containers',
    'volumes', 'executionEnvironment', 'encryptionKey', 'reconciling', 'conditions',
    'observedGeneration', 'logUri', 'satisfiesPzs', 'sessionAffinity',
    'encryptionKeyRevocationAction', 'encryptionKeyShutdownDuration', 'nodeSelector',
    'gpuZonalRedundancyDisabled', 'creator', 'etag', 'baseImageUri', 'buildInfo',
    'healthCheckDisabled', 'serviceMesh', 'client',
  ].includes(key)), 'Cloud Run revision response contains an unknown field');
  assert.equal(
    revision.name,
    `projects/${projectId}/locations/${region}/services/${name}/revisions/${latestReadyRevision}`,
  );
  assert.equal(revision.service, name);
  assert.deepEqual(record(revision.labels), serviceLabels);
  assert.deepEqual(record(revision.annotations), {
    'cloudfunctions.googleapis.com/trigger-type': triggerType,
  });
  assert.equal(revision.launchStage, 'GA');
  assert.equal(revision.client, 'cli-firebase');
  const serviceTemplate = normalizedRunTemplate(record(service.template));
  const revisionTemplate = normalizedRunTemplate({
    revision: latestReadyRevision,
    containers: revision.containers,
    volumes: revision.volumes,
    scaling: revision.scaling,
    vpcAccess: revision.vpcAccess,
    serviceAccount: revision.serviceAccount,
    maxInstanceRequestConcurrency: revision.maxInstanceRequestConcurrency,
    timeout: revision.timeout,
    executionEnvironment: revision.executionEnvironment,
    encryptionKey: revision.encryptionKey,
    serviceMesh: revision.serviceMesh,
    encryptionKeyRevocationAction: revision.encryptionKeyRevocationAction,
    encryptionKeyShutdownDuration: revision.encryptionKeyShutdownDuration,
    sessionAffinity: revision.sessionAffinity,
    gpuZonalRedundancyDisabled: revision.gpuZonalRedundancyDisabled,
    nodeSelector: revision.nodeSelector,
    healthCheckDisabled: revision.healthCheckDisabled,
    baseImageUri: revision.baseImageUri,
    labels: templateLabels,
    annotations: revision.annotations,
    client: revision.client,
  });
  const configuredContainers = array(record(service.template).containers).map(record);
  const revisionContainers = array(revision.containers).map(record);
  assert.equal(configuredContainers.length, 1);
  assert.equal(revisionContainers.length, 1);
  const configuredImage = string(configuredContainers[0].image);
  const revisionImage = string(revisionContainers[0].image);
  assert.match(revisionImage, new RegExp(
    `^${region}-docker\\.pkg\\.dev/${projectId}/gcf-artifacts/[A-Za-z0-9_.%-]+@sha256:[0-9a-f]{64}$`,
  ));
  const buildInfo = record(revisionContainers[0].buildInfo);
  assertExactKeys(buildInfo, ['functionTarget', 'sourceLocation']);
  assert.deepEqual(buildInfo, {
    functionTarget: entryPoint,
    sourceLocation: `gs://${string(storageSource.bucket)}/${string(storageSource.object)}#${
      string(storageSource.generation)}`,
  });
  const comparableTemplate = (template: Record<string, unknown>): Record<string, unknown> => ({
    ...Object.fromEntries(Object.entries(template)
      .filter(([key]) => key !== 'revision' && key !== 'labels')),
    containers: array(template.containers).map((containerValue) => {
      const container = record(containerValue);
      return Object.fromEntries(Object.entries(container)
        .filter(([key]) => key !== 'image' && key !== 'buildInfo'));
    }),
  });
  assert.deepEqual(comparableTemplate(revisionTemplate), comparableTemplate(serviceTemplate),
    'Cloud Run immutable revision execution settings differ from the service template');
  return {
    iam: normalizedIamBindings(policy),
    invokerIamDisabled: disabled === true,
    latestReadyRevision,
    latestCreatedRevision: revisionName(
      service.latestCreatedRevision, projectId, region, name,
    ),
    configuration: normalizeRunConfiguration(
      service, projectId, projectNumber, region, name,
    ),
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
    const firebaseFunctionsHash = generation === 'GEN_2' ?
      string(labels['firebase-functions-hash']) : null;
    if (firebaseFunctionsHash !== null) {
      assert.match(firebaseFunctionsHash, /^[0-9a-f]{40}$/);
    }
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
      runtimeAttestation: null,
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
        storageSource, generation === 'GEN_1' ? string(service.revision) : null,
      ),
      functionIam(fetch_, target.projectId, accessToken, resource.region, resource.name),
      generation === 'GEN_1' ? Promise.resolve(null) :
        runSecurity(
          fetch_, target.projectId, target.projectNumber, accessToken,
          resource.region, resource.name,
          environmentFunction.entryPoint, storageSource!, firebaseFunctionsHash!, event,
        ),
      generation === 'GEN_1' ? Promise.resolve(null) : functionBuild(
        fetch_, target, accessToken, resource.region, build.build, storageSource!,
        environmentFunction,
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
      runtimeAttestation: function_?.runtimeAttestation ?? null,
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
      buildImageDigest: buildSecurity?.buildImageDigest ?? null,
      imageBuildId: provenance?.imageBuildId ?? null,
      imageSource: provenance?.imageSource ?? null,
      imageSourceFiles: provenance?.imageSourceFiles ?? null,
      imageRuntimeAttestation: provenance?.imageRuntimeAttestation ?? null,
      firebaseFunctionsHash,
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
  assert.ok(Object.keys(value).every((key) => [
    'kind', 'selfLink', 'id', 'name', 'projectNumber', 'metageneration', 'location',
    'locationType', 'storageClass', 'etag', 'timeCreated', 'updated', 'owner',
    'labels', 'website', 'versioning', 'cors', 'lifecycle', 'autoclass', 'billing',
    'retentionPolicy', 'iamConfiguration', 'encryption', 'logging',
    'defaultEventBasedHold', 'rpo', 'satisfiesPZS', 'satisfiesPZI',
    'customPlacementConfig', 'softDeletePolicy', 'hierarchicalNamespace',
    'objectRetention', 'ipFilter',
  ].includes(key)), 'Cloud Storage bucket response contains an unknown field');
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
  subtype: unknown,
): Promise<Record<string, unknown>[]> {
  if (subtype === 'FIREBASE_AUTH') return [];
  assert.equal(subtype, 'IDENTITY_PLATFORM');
  return listApi(
    fetch_, `https://identitytoolkit.googleapis.com/v2/projects/${target.projectId}/tenants`,
    'tenants', accessToken, target.projectId,
  );
}

async function iamAt(
  fetch_: FetchLike,
  url: string,
  target: DeploymentTarget,
  accessToken: string,
  method: 'GET' | 'POST' = 'GET',
): Promise<IamBinding[]> {
  const versionedUrl = method === 'GET' && !url.includes('optionsRequestedPolicyVersion=3') ?
    `${url}${url.includes('?') ? '&' : '?'}options.requestedPolicyVersion=3` : url;
  return normalizedIamBindings(await json(
    fetch_, versionedUrl, accessToken, target.projectId,
    method === 'GET' ? undefined : {
      method,
      body: JSON.stringify({options: {requestedPolicyVersion: 3}}),
    },
  ));
}

function normalizedEventarcTrigger(value: Record<string, unknown>): Record<string, unknown> {
  assert.ok(Object.keys(value).every((key) => [
    'name', 'uid', 'createTime', 'updateTime', 'eventFilters', 'serviceAccount',
    'destination', 'transport', 'labels', 'channel', 'eventDataContentType',
    'conditions', 'reconciling', 'etag',
  ].includes(key)), 'Eventarc trigger response contains an unknown field');
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
  assert.ok(Object.keys(value).every((key) => [
    'name', 'labels', 'messageStoragePolicy', 'kmsKeyName', 'schemaSettings',
    'satisfiesPzs', 'messageRetentionDuration', 'state', 'ingestionDataSourceSettings',
    'messageTransforms',
  ].includes(key)), 'Pub/Sub topic response contains an unknown field');
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
  assert.ok(Object.keys(value).every((key) => [
    'name', 'topic', 'pushConfig', 'bigQueryConfig', 'cloudStorageConfig',
    'ackDeadlineSeconds', 'retainAckedMessages', 'messageRetentionDuration', 'labels',
    'enableMessageOrdering', 'expirationPolicy', 'filter', 'deadLetterPolicy',
    'retryPolicy', 'detached', 'enableExactlyOnceDelivery', 'topicMessageRetentionDuration',
    'state',
  ].includes(key)), 'Pub/Sub subscription response contains an unknown field');
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

function normalizedArtifactRepository(value: Record<string, unknown>): Record<string, unknown> {
  assert.ok(Object.keys(value).every((key) => [
    'name', 'format', 'description', 'labels', 'mode', 'cleanupPolicies',
    'cleanupPolicyDryRun', 'kmsKeyName', 'dockerConfig', 'mavenConfig',
    'virtualRepositoryConfig', 'remoteRepositoryConfig', 'vulnerabilityScanningConfig',
    'createTime', 'updateTime', 'sizeBytes', 'satisfiesPzs', 'satisfiesPzi', 'registryUri',
  ].includes(key)));
  const scanning = record(value.vulnerabilityScanningConfig ?? {});
  assert.ok(Object.keys(scanning).every((key) => [
    'lastEnableTime', 'enablementState', 'enablementStateReason',
  ].includes(key)));
  return {
    format: string(value.format),
    description: nullableString(value.description),
    labels: record(value.labels ?? {}),
    mode: string(value.mode),
    cleanupPolicies: record(value.cleanupPolicies ?? {}),
    cleanupPolicyDryRun: value.cleanupPolicyDryRun === true,
    kmsKeyName: nullableString(value.kmsKeyName),
    dockerConfig: record(value.dockerConfig ?? {}),
    mavenConfig: record(value.mavenConfig ?? {}),
    virtualRepositoryConfig: record(value.virtualRepositoryConfig ?? {}),
    remoteRepositoryConfig: record(value.remoteRepositoryConfig ?? {}),
    vulnerabilityScanningConfig: {
      enablementState: nullableString(scanning.enablementState),
    },
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

async function runServiceInventory(
  fetch_: FetchLike,
  target: DeploymentTarget,
  accessToken: string,
): Promise<string[]> {
  const wildcardUrl =
    `https://run.googleapis.com/v2/projects/${target.projectId}/locations/-/services`;
  const services: Record<string, unknown>[] = [];
  const unreachable = new Set<string>();
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_API_PAGES; page += 1) {
    const url = pageToken === undefined ? wildcardUrl :
      `${wildcardUrl}?pageToken=${encodeURIComponent(pageToken)}`;
    const body = await json(fetch_, url, accessToken, target.projectId);
    services.push(...array(body.services ?? []).map(record));
    for (const region of array(body.unreachable ?? []).map(string)) {
      assert.match(region, /^[a-z]+(?:-[a-z0-9]+)+[0-9]$/);
      unreachable.add(region);
    }
    const next = body.nextPageToken;
    if (next === undefined || string(next).trim() === '') break;
    assert.ok(page + 1 < MAX_API_PAGES, 'Cloud Run inventory exceeded the maximum pages');
    pageToken = string(next);
  }
  for (const region of [...unreachable].sort()) {
    const url =
      `https://run.googleapis.com/v2/projects/${target.projectId}/locations/${region}/services`;
    const response = await fetchWithRetry(
      fetch_, url, {headers: authenticatedHeaders(accessToken, target.projectId)},
      [200, 403], `Cloud Run inventory for initially unreachable region ${region}`,
    );
    const body = record(await response.json());
    if (response.status === 403) {
      const error = record(body.error);
      assert.equal(error.status, 'PERMISSION_DENIED');
      const details = array(error.details).map(record);
      assert.equal(details.some((detail) =>
        detail['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo' &&
        detail.reason === 'LOCATION_POLICY_VIOLATED' &&
        record(detail.metadata).location === region), true,
      `Cloud Run region ${region} is unreadable without a location-policy proof`);
      continue;
    }
    assert.deepEqual(body.unreachable ?? [], []);
    assert.ok(body.nextPageToken === undefined || string(body.nextPageToken).trim() === '',
      `Cloud Run regional inventory unexpectedly paginated for ${region}`);
    services.push(...array(body.services ?? []).map(record));
  }
  const directlyVisible = services.map((service) => string(service.name)).sort();
  assert.equal(new Set(directlyVisible).size, directlyVisible.length,
    'duplicate Cloud Run direct inventory entry');
  const assetServices = await listApi(
    fetch_,
    `https://cloudasset.googleapis.com/v1/projects/${target.projectId}:searchAllResources?` +
      'assetTypes=run.googleapis.com%2FService&pageSize=500',
    'results', accessToken, target.projectId,
  );
  const assetNames = assetServices.map((asset) => {
    const prefix = '//run.googleapis.com/';
    const name = string(asset.name);
    assert.equal(name.startsWith(prefix), true);
    return name.slice(prefix.length);
  }).sort();
  assert.equal(new Set(assetNames).size, assetNames.length,
    'duplicate Cloud Asset Run inventory entry');
  for (const name of directlyVisible) {
    assert.equal(assetNames.includes(name), true,
      `Cloud Asset has not converged on directly visible Run service ${name}`);
  }
  return assetNames;
}

export async function assertNoProjectMutations(
  fetch_: FetchLike,
  target: DeploymentTarget,
  accessToken: string,
  cutoff: string,
): Promise<void> {
  const checkpoint = target.security.runInventoryCheckpoint;
  if (checkpoint === null) return;
  assert.match(cutoff,
    /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z$/);
  assert.equal(Date.parse(cutoff) >= Date.parse(checkpoint), true,
    'Cloud Run inventory cutoff precedes its checkpoint');
  let auditPageToken: string | undefined;
  const mutations: Record<string, unknown>[] = [];
  for (let page = 0; page < MAX_API_PAGES; page += 1) {
    const body = {
      resourceNames: [`projects/${target.projectId}`],
      filter: [
        `logName="projects/${target.projectId}/logs/cloudaudit.googleapis.com%2Factivity"`,
        `timestamp>="${checkpoint}"`,
        `timestamp<="${cutoff}"`,
      ].join(' AND '),
      orderBy: 'timestamp asc',
      ...(auditPageToken === undefined ? {} : {pageToken: auditPageToken}),
    };
    const response = await json(
      fetch_, 'https://logging.googleapis.com/v2/entries:list', accessToken, target.projectId,
      {method: 'POST', body: JSON.stringify(body)},
    );
    mutations.push(...array(response.entries ?? []).map(record).filter((entry) =>
      entry.logName ===
        `projects/${target.projectId}/logs/cloudaudit.googleapis.com%2Factivity` &&
      Date.parse(string(entry.timestamp)) >= Date.parse(checkpoint) &&
      Date.parse(string(entry.timestamp)) <= Date.parse(cutoff)));
    const next = response.nextPageToken;
    if (next === undefined || string(next).trim() === '') break;
    assert.ok(page + 1 < MAX_API_PAGES,
      'project mutation audit exceeded the maximum number of pages');
    auditPageToken = string(next);
  }
  assert.deepEqual(mutations, [],
    'the project changed between the reviewed checkpoint and inventory cutoff');
}

async function emptyRunResourceInventory(
  fetch_: FetchLike,
  target: DeploymentTarget,
  accessToken: string,
  regions: string[],
  collection: 'jobs' | 'workerPools',
  assetType: 'run.googleapis.com/Job' | 'run.googleapis.com/WorkerPool',
): Promise<string[]> {
  const directlyVisible: string[] = [];
  for (const region of regions) {
    const baseUrl = 'https://run.googleapis.com/v2/projects/' + target.projectId +
      '/locations/' + region + '/' + collection + '?pageSize=1000';
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_API_PAGES; page += 1) {
      const url = pageToken === undefined ? baseUrl :
        baseUrl + '&pageToken=' + encodeURIComponent(pageToken);
      const response = await fetchWithRetry(
        fetch_, url, {headers: authenticatedHeaders(accessToken, target.projectId)},
        [200, 403], 'Cloud Run ' + collection + ' inventory for region ' + region,
      );
      const body = record(await response.json());
      if (response.status === 403) {
        const error = record(body.error);
        assert.equal(error.status, 'PERMISSION_DENIED');
        const details = array(error.details).map(record);
        assert.equal(details.some((detail) =>
          detail['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo' &&
          detail.reason === 'LOCATION_POLICY_VIOLATED' &&
          record(detail.metadata).location === region), true,
        'Cloud Run ' + collection + ' region is unreadable without location-policy proof');
        break;
      }
      assert.deepEqual(body.unreachable ?? [], []);
      directlyVisible.push(...array(body[collection] ?? []).map((value) =>
        string(record(value).name)));
      const next = body.nextPageToken;
      if (next === undefined || string(next).trim() === '') break;
      assert.ok(page + 1 < MAX_API_PAGES,
        'Cloud Run ' + collection + ' inventory exceeded the maximum pages');
      pageToken = string(next);
    }
  }
  directlyVisible.sort();
  assert.equal(new Set(directlyVisible).size, directlyVisible.length,
    'duplicate direct Cloud Run ' + collection + ' inventory entry');
  const assets = await listApi(
    fetch_,
    'https://cloudasset.googleapis.com/v1/projects/' + target.projectId +
      ':searchAllResources?assetTypes=' + encodeURIComponent(assetType) + '&pageSize=500',
    'results', accessToken, target.projectId,
  );
  const prefix = '//run.googleapis.com/';
  const assetNames = assets.map((asset) => {
    const name = string(asset.name);
    assert.equal(name.startsWith(prefix), true);
    return name.slice(prefix.length);
  }).sort();
  assert.equal(new Set(assetNames).size, assetNames.length,
    'duplicate Cloud Asset Run ' + collection + ' inventory entry');
  for (const name of directlyVisible) {
    assert.equal(assetNames.includes(name), true,
      'Cloud Asset has not converged on directly visible Run resource ' + name);
  }
  return assetNames;
}

async function deployedSecurity(
  fetch_: FetchLike,
  target: DeploymentTarget,
  accessToken: string,
  ancestorIamPolicies: IamResource[],
): Promise<ObservedSecurity> {
  const runLocations = (await listApi(
    fetch_, 'https://run.googleapis.com/v1/projects/' + target.projectId +
      '/locations?pageSize=100',
    'locations', accessToken, target.projectId,
  )).map((location) => string(location.locationId)).sort();
  assert.equal(runLocations.length > 0, true, 'Cloud Run location inventory is empty');
  assert.equal(new Set(runLocations).size, runLocations.length,
    'duplicate Cloud Run location inventory entry');
  for (const region of runLocations) {
    assert.match(region, /^[a-z]+(?:-[a-z0-9]+)+[0-9]$/);
  }
  const runServicesPromise = runServiceInventory(fetch_, target, accessToken);
  const runJobsPromise = emptyRunResourceInventory(
    fetch_, target, accessToken, runLocations, 'jobs', 'run.googleapis.com/Job',
  );
  const runWorkerPoolsPromise = emptyRunResourceInventory(
    fetch_, target, accessToken, runLocations, 'workerPools', 'run.googleapis.com/WorkerPool',
  );
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
  const authProvidersPromise = authPromise.then(async (authConfig) => Promise.all([
    [`https://identitytoolkit.googleapis.com/admin/v2/projects/${target.projectId}/defaultSupportedIdpConfigs`, 'defaultSupportedIdpConfigs'],
    [`https://identitytoolkit.googleapis.com/admin/v2/projects/${target.projectId}/oauthIdpConfigs`, 'oauthIdpConfigs'],
    [`https://identitytoolkit.googleapis.com/admin/v2/projects/${target.projectId}/inboundSamlConfigs`, 'inboundSamlConfigs'],
  ].map(async ([url, field]) => [field, await listApi(
    fetch_, url,
    field, accessToken, target.projectId,
  )] as const)).then(async (entries) => normalizedAuthProviderInventory({
    ...Object.fromEntries(entries),
    tenants: await identityTenants(fetch_, target, accessToken, authConfig.subtype),
  })));
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
  const repositoryListPromise = listApi(
    fetch_,
    `https://artifactregistry.googleapis.com/v1/projects/${target.projectId}/locations/-/repositories`,
    'repositories', accessToken, target.projectId,
  );
  const repositoriesPromise = repositoryListPromise.then(async (repositories) => {
    const names = repositories.map((repository) => string(repository.name)).sort();
    assert.deepEqual(names,
      target.security.artifactRepositories.map(({name}) => name).sort());
    return Promise.all(names.map(async (name) => {
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
      return {name, iam, configuration: normalizedArtifactRepository(repository)};
    }));
  });
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
  const [runServices, runJobs, runWorkerPools,
    eventarcTriggers, authConfig, authProviders, firebaseRulesReleases,
    customRoles, serviceAccounts,
    secrets, artifactRepositories, pubsubTopics, pubsubSubscriptions, storageBuckets] =
    await Promise.all([
      runServicesPromise, runJobsPromise, runWorkerPoolsPromise,
      eventarcPromise, authPromise, authProvidersPromise,
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
    runJobs,
    runWorkerPools,
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
  functionHash: string,
  buildId: string,
  buildSource: string,
): Record<string, unknown> {
  const imagePackage = [target.projectId, function_.region, function_.name]
    .map((part) => part.replaceAll('-', '--')).join('__');
  const imageUri =
    `${function_.region}-docker.pkg.dev/${target.projectId}/gcf-artifacts/${imagePackage}:version_1`;
  assert.deepEqual(function_.secrets, [],
    'Gen 2 Cloud Run secret environment normalization must be explicitly reviewed');
  const environment = Object.entries({
    EVENTARC_CLOUD_EVENT_SOURCE:
      `projects/${target.projectId}/locations/${function_.region}/services/${function_.name}`,
    FIREBASE_CONFIG: JSON.stringify(target.firebaseConfig),
    FUNCTION_TARGET: function_.entryPoint,
    GCLOUD_PROJECT: target.projectId,
    LOG_EXECUTION_ID: 'true',
    ...(function_.event === null ? {} : {
      FUNCTION_REGION: function_.region,
      FUNCTION_SIGNATURE_TYPE: 'cloudevent',
    }),
  }).map(([name, value]) => ({name, value})).sort((left, right) =>
    left.name.localeCompare(right.name));
  return {
    labels: {
      'firebase-functions-hash': functionHash,
      'goog-cloudfunctions-runtime': 'nodejs22',
      'goog-drz-cloudfunctions-id': function_.name,
      'goog-drz-cloudfunctions-location': function_.region,
      'goog-managed-by': 'cloudfunctions',
    },
    annotations: {'cloudfunctions.googleapis.com/function-id': function_.name},
    launchStage: 'GA',
    client: 'cli-firebase',
    clientVersion: null,
    urls: ['cloudfunctions', 'numeric-run', 'stable-run'],
    sshEnabled: false,
    buildConfig: {
      name: `projects/${target.projectNumber}/locations/${function_.region}/builds/${buildId}`,
      sourceLocation: buildSource,
      functionTarget: function_.entryPoint,
      imageUri,
      baseImage:
        `${function_.region}-docker.pkg.dev/serverless-runtimes/google-22-full/runtimes/nodejs22`,
      enableAutomaticUpdates: true,
      environmentVariables: {GOOGLE_NODE_RUN_SCRIPTS: ''},
    },
    ingress: 'INGRESS_TRAFFIC_ALL',
    customAudiences: [
      `https://${function_.region}-${target.projectId}.cloudfunctions.net/${function_.name}`,
    ],
    binaryAuthorization: {},
    iapEnabled: false,
    scaling: function_.maxInstances === null ? {} : {maxInstanceCount: function_.maxInstances},
    template: {
      revision,
      labels: {
        'firebase-functions-hash': functionHash,
        'goog-drz-cloudfunctions-id': function_.name,
        'goog-drz-cloudfunctions-location': function_.region,
      },
      annotations: {
        'cloudfunctions.googleapis.com/trigger-type': function_.event?.type ?? 'HTTP_TRIGGER',
      },
      client: 'cli-firebase',
      baseImageUri: null,
      serviceAccount: function_.serviceAccount,
      timeout: `${function_.timeoutSeconds}s`,
      maxInstanceRequestConcurrency: 80,
      scaling: function_.maxInstances === null ? {} : {maxInstanceCount: function_.maxInstances},
      vpcAccess: {},
      encryptionKey: null,
      serviceMesh: {},
      encryptionKeyRevocationAction: null,
      encryptionKeyShutdownDuration: null,
      sessionAffinity: false,
      executionEnvironment: null,
      gpuZonalRedundancyDisabled: false,
      nodeSelector: {},
      healthCheckDisabled: false,
      volumes: [],
      containers: [{
        name: 'worker',
        image: imageUri,
        baseImageUri:
          `${function_.region}-docker.pkg.dev/serverless-runtimes/google-22-full/runtimes/nodejs22`,
        command: [],
        args: [],
        environment,
        resources: {
          limits: {cpu: '1', memory: '256Mi'},
          cpuIdle: true,
          startupCpuBoost: true,
        },
        ports: [{name: 'http1', containerPort: 8080}],
        workingDir: null,
        livenessProbe: {},
        startupProbe: {
          timeoutSeconds: 240,
          periodSeconds: 240,
          failureThreshold: 1,
          tcpSocket: {port: 8080},
        },
        volumeMounts: [],
        dependsOn: [],
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
  if (observed.security.runJobs.length > 0) {
    problems.push('Unreviewed Cloud Run jobs exist');
  }
  if (observed.security.runWorkerPools.length > 0) {
    problems.push('Unreviewed Cloud Run worker pools exist');
  }
  if (expectedSecurity.runInventoryCheckpoint === null) {
    problems.push('Cloud Run inventory checkpoint is pending');
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
        expectedRunConfiguration(
          expected.target,
          expectedFunction,
          observedFunction.revision,
          observedFunction.firebaseFunctionsHash!,
          observedFunction.buildId!,
          observedFunction.buildSource!,
        ),
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
          observedFunction.buildSource !== observedFunction.imageSource ||
          (expectedFunction.runtimeAttestation === null &&
            (observedFunction.buildImageDigest === null ||
              observedFunction.revisionImage === null ||
              observedFunction.buildImageDigest !==
                observedFunction.revisionImage.split('@').at(-1)))) {
        problems.push(`Cloud Run image provenance does not match the immutable Function build: ${key}`);
      }
      if (observedFunction.imageSourceFiles === null ||
          canonical(observedFunction.imageSourceFiles) !== canonical(expected.functionFiles)) {
        problems.push(`Cloud Run image source does not match the reviewed commit: ${key}`);
      }
      const runtimeAttestation = expectedFunction.runtimeAttestation;
      if (runtimeAttestation === null) {
        problems.push(`Cloud Run runtime image attestation is pending: ${key}`);
      } else {
        const {deploymentCommit: _deploymentCommit, ...reviewedRuntime} = runtimeAttestation;
        if (observedFunction.imageRuntimeAttestation === null ||
            canonical(observedFunction.imageRuntimeAttestation) !== canonical(reviewedRuntime)) {
          problems.push(`Cloud Run executable image does not match the reviewed attestation: ${key}`);
        }
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

function runtimeFile(value: unknown): RuntimeFile {
  const file = record(value);
  const type = string(file.type);
  assert.ok([
    'file', 'directory', 'symlink', 'hardlink', 'character', 'block', 'fifo',
  ].includes(type));
  const common = ['path', 'type', 'mode', 'uid', 'gid'];
  const extra = type === 'file' ? ['sha256'] :
    type === 'hardlink' ? ['linkName', 'sha256'] :
      type === 'symlink' ? ['linkName'] :
      type === 'character' || type === 'block' ? ['deviceMajor', 'deviceMinor'] : [];
  assertExactKeys(file, [...common, ...extra]);
  const result = {
    path: string(file.path),
    type: type as RuntimeFile['type'],
    mode: number(file.mode),
    uid: number(file.uid),
    gid: number(file.gid),
    ...(file.sha256 === undefined ? {} : {sha256: string(file.sha256)}),
    ...(file.linkName === undefined ? {} : {linkName: string(file.linkName)}),
    ...(file.deviceMajor === undefined ? {} : {deviceMajor: number(file.deviceMajor)}),
    ...(file.deviceMinor === undefined ? {} : {deviceMinor: number(file.deviceMinor)}),
  };
  assert.match(result.path, /^\/(?!.*(?:^|\/)\.\.(?:\/|$))[^\0\r\n]*$/);
  assert.notEqual(result.path, '/');
  assert.equal(posix.normalize(result.path), result.path);
  if (result.type === 'hardlink') assert.equal(runtimePath(result.linkName!), result.linkName);
  assert.ok(Number.isSafeInteger(result.mode) && result.mode >= 0);
  assert.ok(Number.isSafeInteger(result.uid) && result.uid >= 0);
  assert.ok(Number.isSafeInteger(result.gid) && result.gid >= 0);
  if (result.sha256 !== undefined) assert.match(result.sha256, /^[0-9a-f]{64}$/);
  return result;
}

function runtimeAttestation(value: unknown): RuntimeAttestation | null {
  if (value === null) return null;
  const attestation = record(value);
  assertExactKeys(attestation, [
    'deploymentCommit', 'imageDigest', 'executionConfig', 'files',
  ]);
  const files = array(attestation.files).map(runtimeFile);
  assert.deepEqual(files.map(({path}) => path), files.map(({path}) => path).sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0),
    'runtime attestation paths must be sorted');
  assert.equal(new Set(files.map(({path}) => path)).size, files.length,
    'runtime attestation paths must be unique');
  assertNoSymlinkPathAliases(files);
  const result = {
    deploymentCommit: string(attestation.deploymentCommit),
    imageDigest: string(attestation.imageDigest),
    executionConfig: record(attestation.executionConfig),
    files,
  };
  assert.match(result.deploymentCommit, /^[0-9a-f]{40}$/);
  assert.match(result.imageDigest, /^sha256:[0-9a-f]{64}$/);
  return result;
}

function expectedFunction(value: unknown): ExpectedFunction {
  const function_ = record(value);
  assertExactKeys(function_, [
    'name', 'generation', 'region', 'entryPoint', 'access', 'timeoutSeconds',
    'maxInstances', 'serviceAccount', 'secrets', 'functionIam', 'runIam', 'event',
    'runtimeAttestation',
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
    runtimeAttestation: runtimeAttestation(function_.runtimeAttestation),
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
  if (result.generation === 'GEN_1') assert.equal(result.runtimeAttestation, null);
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
    'gitOrigin', 'storageRulesRelease', 'runInventoryCheckpoint',
    'authConfig', 'ancestorIamPolicies',
    'customRoles', 'serviceAccounts', 'secrets', 'artifactRepositories', 'storageBuckets',
    'eventarcTriggers', 'pubsubTopics', 'pubsubSubscriptions', 'authProviders',
    'firebaseRulesReleases',
  ]);
  const serviceAccounts = array(security.serviceAccounts).map((value_) => {
    const account = record(value_);
    assertExactKeys(account, ['name', 'iam', 'userManagedKeys']);
    const userManagedKeys = sortedCanonical(array(account.userManagedKeys).map(record));
    assert.deepEqual(userManagedKeys, [],
      'user-managed service-account keys are forbidden in reviewed production state');
    return {
      ...targetIamResource({name: account.name, iam: account.iam}),
      userManagedKeys,
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
  const repositories = array(security.artifactRepositories).map((value_) => {
    const repository = record(value_);
    assertExactKeys(repository, ['name', 'iam', 'configuration']);
    return {
      ...targetIamResource({name: repository.name, iam: repository.iam}),
      configuration: record(repository.configuration),
    };
  });
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
  const runInventoryCheckpoint = nullableString(security.runInventoryCheckpoint);
  if (runInventoryCheckpoint !== null) {
    assert.match(runInventoryCheckpoint,
      /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z$/);
    assert.equal(Number.isNaN(Date.parse(runInventoryCheckpoint)), false);
  }
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
  const reviewedEventConfiguration = sortedCanonical(eventarcTriggers.map(({configuration}) => ({
    destination: record(configuration.destination),
    eventFilters: array(configuration.eventFilters).map(record),
    labels: record(configuration.labels),
    serviceAccount: string(configuration.serviceAccount),
  })));
  const expectedEventConfiguration = expectedEventarcTriggers({
    projectId,
    functions,
  } as DeploymentTarget);
  assert.deepEqual(reviewedEventConfiguration, expectedEventConfiguration);
  return {
    gitOrigin,
    storageRulesRelease,
    runInventoryCheckpoint,
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
  if (firebaseConfig.storageBucket !== security.storageRulesRelease) {
    assert.equal(firebaseConfig.storageBucket, `${projectId}.firebasestorage.app`);
    assert.equal(security.storageRulesRelease, `${projectId}.appspot.com`);
    assert.equal(bucketNames.includes(firebaseConfig.storageBucket), false,
      'configured Firebase Storage alias must not expose a second bucket');
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
  graftFileExists = false,
  excludeFileHasPatterns = false,
  attributesFileHasPatterns = false,
  directTrackedProblems: string[] = [],
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
  const configParts = gitText(runGit, ['config', '--list', '--show-origin', '-z'])
    .split('\0').filter(Boolean);
  assert.equal(configParts.length % 2, 0, 'invalid Git config origin output');
  const urlRewrites = configParts.filter((entry, index) => index % 2 === 1 &&
    /^url\..*\.(?:insteadof|pushinsteadof)\n/i.test(entry));
  const unsafeConfiguration = configParts.filter((entry, index) => {
    if (index % 2 === 0) return false;
    const separator = entry.indexOf('\n');
    const name = (separator === -1 ? entry : entry.slice(0, separator)).toLowerCase();
    const value = separator === -1 ? '' : entry.slice(separator + 1).toLowerCase();
    const origin = configParts[index - 1];
    if (name === 'core.fsmonitor' && value === 'false' && origin === 'command line:') {
      return false;
    }
    return name.startsWith('http.') || name === 'core.gitproxy' ||
      name === 'core.excludesfile' || name === 'core.attributesfile' ||
      name === 'core.fsmonitor' || name === 'core.worktree' ||
      name.startsWith('filter.') ||
      /^remote\.[^.]+\.proxy(?:authmethod)?$/.test(name);
  });
  const replacements = gitText(runGit, ['replace', '-l'])
    .split(/\r?\n/).filter(Boolean);
  if (head !== reviewedCommit) problems.push('HEAD is not the reviewed commit');
  if (pushed !== reviewedCommit) problems.push('origin/master is not the reviewed commit');
  if (remote !== reviewedCommit) problems.push('Remote master is not the reviewed commit');
  if (origin !== target.security.gitOrigin) problems.push('Git origin is not the reviewed repository');
  if (urlRewrites.length > 0) problems.push('Git URL rewrite can spoof origin');
  if (unsafeConfiguration.length > 0) {
    problems.push('Git transport or exclude configuration can spoof reviewed state');
  }
  if (replacements.length > 0) problems.push('Git replacement refs can spoof reviewed objects');
  if (graftFileExists) problems.push('Git graft file can spoof reviewed ancestry');
  if (excludeFileHasPatterns) problems.push('Git info exclude can hide unreviewed files');
  if (attributesFileHasPatterns) problems.push('Git info attributes can transform reviewed files');
  problems.push(...directTrackedProblems);
  const gen2Functions = target.functions.filter(({generation}) => generation === 'GEN_2');
  const attestations = gen2Functions.flatMap(({runtimeAttestation}) =>
    runtimeAttestation === null ? [] : [runtimeAttestation]);
  if (attestations.length > 0) {
    if (attestations.length !== gen2Functions.length) {
      problems.push('Cloud Run runtime attestations are only partially recorded');
    } else {
      const deploymentCommits = [...new Set(attestations.map(({deploymentCommit}) =>
        deploymentCommit))];
      const rawCommit = gitText(runGit, ['cat-file', 'commit', reviewedCommit]);
      const parents = rawCommit.split(/\r?\n/).filter((line) => line.startsWith('parent '));
      assert.equal(parents.length, 1, 'runtime attestation commit must have one raw parent');
      const parent = parents[0].slice('parent '.length);
      assert.match(parent, /^[0-9a-f]{40}$/);
      const changed = gitText(runGit, [
        'diff-tree', '--no-commit-id', '--name-only', '-r', parent, reviewedCommit,
      ]).split(/\r?\n/).filter(Boolean).sort();
      const parentTarget = deploymentTarget(JSON.parse(
        gitShow(runGit, parent, 'deployment-target.json').toString('utf8'),
      ));
      const withoutAttestations = (value: DeploymentTarget): unknown => ({
        ...value,
        security: {...value.security, runInventoryCheckpoint: null},
        functions: value.functions.map((function_) => ({
          ...function_,
          runtimeAttestation: null,
        })),
      });
      if (canonical(deploymentCommits) !== canonical([parent]) ||
          canonical(changed) !== canonical(['deployment-target.json'])) {
        problems.push('Runtime attestation commit is not a target-only child of the deployment');
      }
      if (parentTarget.security.runInventoryCheckpoint !== null ||
          parentTarget.functions.some(({generation, runtimeAttestation}) =>
            generation === 'GEN_2' && runtimeAttestation !== null) ||
          canonical(withoutAttestations(parentTarget)) !==
            canonical(withoutAttestations(target))) {
        problems.push('Runtime attestation commit changes non-attestation deployment targets');
      }
    }
  }
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

interface GitTreeEntry {
  mode: string;
  hash: string;
  path: string;
}

function gitTreeEntries(output: string, source: 'index' | 'tree'): GitTreeEntry[] {
  return output.split('\0').filter(Boolean).map((entry) => {
    const tab = entry.indexOf('\t');
    assert.ok(tab > 0, `invalid Git ${source} entry`);
    const metadata = entry.slice(0, tab).split(' ');
    const path = entry.slice(tab + 1);
    assert.match(path, /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0\r\n]+$/);
    if (source === 'index') {
      assert.equal(metadata.length, 3, 'invalid Git index metadata');
      assert.equal(metadata[2], '0', 'unmerged Git index entry');
      return {mode: metadata[0], hash: metadata[1], path};
    }
    assert.equal(metadata.length, 3, 'invalid Git tree metadata');
    assert.equal(metadata[1], 'blob', 'Git submodules are unsupported deployment inputs');
    return {mode: metadata[0], hash: metadata[2], path};
  }).sort((left, right) => left.path.localeCompare(right.path));
}

export function directTrackedTreeProblems(
  root: string,
  reviewedCommit: string,
  runGit: GitRunner,
): string[] {
  const problems: string[] = [];
  const flags = gitText(runGit, ['ls-files', '-v', '-z'])
    .split('\0').filter(Boolean);
  for (const entry of flags) {
    assert.match(entry, /^. /, 'invalid Git index flag entry');
    if (entry[0] !== 'H') {
      problems.push(`Git special index flag can hide a tracked change: ${entry.slice(2)}`);
    }
  }
  const index = gitTreeEntries(
    gitText(runGit, ['ls-files', '--stage', '-z']), 'index',
  );
  const tree = gitTreeEntries(
    gitText(runGit, ['ls-tree', '-r', '--full-tree', '-z', reviewedCommit]), 'tree',
  );
  if (canonical(index) !== canonical(tree)) {
    problems.push('Git index does not exactly match the reviewed tree');
  }
  const objectFormat = gitText(runGit, ['rev-parse', '--show-object-format']).trim();
  assert.ok(objectFormat === 'sha1' || objectFormat === 'sha256',
    'unsupported Git object format');
  for (const entry of index) {
    const absolute = resolve(root, entry.path);
    const metadata = lstatSync(absolute);
    let body: Buffer;
    if (entry.mode === '100644' || entry.mode === '100755') {
      assert.equal(metadata.isFile(), true, 'tracked path is not a regular file: ' + entry.path);
      const executable = (metadata.mode & 0o111) !== 0;
      if (executable !== (entry.mode === '100755')) {
        problems.push(`Tracked file mode differs from the reviewed tree: ${entry.path}`);
      }
      body = readFileSync(absolute);
    } else if (entry.mode === '120000') {
      assert.equal(metadata.isSymbolicLink(), true,
        'tracked path is not a symbolic link: ' + entry.path);
      body = Buffer.from(readlinkSync(absolute));
    } else {
      assert.fail(`unsupported tracked Git mode ${entry.mode}: ${entry.path}`);
    }
    const hash = createHash(objectFormat)
      .update(`blob ${body.byteLength}\0`)
      .update(body)
      .digest('hex');
    if (hash !== entry.hash) {
      problems.push(`Tracked file bytes differ from the reviewed tree: ${entry.path}`);
    }
  }
  return problems;
}

export function parseOptions(arguments_: string[]): Map<string, string> {
  const allowed = new Set(['account', 'checkpoint', 'commit', 'mode', 'project']);
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
  graftFileExists?(): boolean;
  excludeFileHasPatterns?(): boolean;
  attributesFileHasPatterns?(): boolean;
  directTrackedProblems?(reviewedCommit: string): string[];
  settleRunAudit(): Promise<void>;
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
  const mode = options.get('mode') ?? 'verify';
  assert.ok(mode === 'verify' || mode === 'capture', 'invalid --mode');
  const checkpoint = options.get('checkpoint');
  if (mode === 'capture') {
    assert.notEqual(checkpoint, undefined, 'capture requires --checkpoint');
    assert.match(checkpoint!,
      /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z$/);
    const checkpointAge = Date.now() - Date.parse(checkpoint!);
    assert.ok(checkpointAge >= RUN_INVENTORY_QUIESCENCE_MS,
      'capture checkpoint has not been quiescent for ten minutes');
    assert.ok(checkpointAge <= MAX_RUN_INVENTORY_CHECKPOINT_AGE_MS,
      'capture checkpoint is too old');
  } else {
    assert.equal(checkpoint, undefined, '--checkpoint is only valid in capture mode');
  }
  const project = options.get('project');
  if (project !== undefined) assert.equal(project, expected.target.projectId);
  const treeProblems = reviewedTreeProblems(
    reviewedCommit!, expected.target, dependencies.runGit,
    dependencies.graftFileExists?.() ?? false,
    dependencies.excludeFileHasPatterns?.() ?? false,
    dependencies.attributesFileHasPatterns?.() ?? false,
    dependencies.directTrackedProblems?.(reviewedCommit!) ?? [],
  );
  if (treeProblems.length > 0) {
    for (const problem of treeProblems) dependencies.stderr(`${problem}\n`);
    return 1;
  }
  const liveExpected = structuredClone(expected);
  const auditStart = mode === 'capture' ? checkpoint! : new Date().toISOString();
  liveExpected.target.security.runInventoryCheckpoint = auditStart;
  const accessToken = dependencies.accessToken(options.get('account'));
  const firstObserved = await readObservedDeployment(
    dependencies.fetch,
    liveExpected,
    accessToken,
  );
  await dependencies.settleRunAudit();
  const observed = await readObservedDeployment(
    dependencies.fetch,
    liveExpected,
    accessToken,
  );
  const observationsChanged = canonical(firstObserved) !== canonical(observed);
  const auditCutoff = new Date().toISOString();
  await dependencies.settleRunAudit();
  await assertNoProjectMutations(
    dependencies.fetch, liveExpected.target, accessToken, auditCutoff,
  );
  const problems = deploymentProblems(liveExpected, observed);
  if (observationsChanged) problems.unshift('Deployment changed during settled consistency reads');
  if (mode === 'capture') {
    assert.equal(expected.target.security.runInventoryCheckpoint, null,
      'capture requires a pending Run inventory checkpoint');
    const gen2 = expected.target.functions.filter(({generation}) => generation === 'GEN_2');
    assert.equal(gen2.every(({runtimeAttestation}) => runtimeAttestation === null), true,
      'capture requires pending Gen 2 runtime attestations');
    const allowed = new Set([
      ...gen2.map((function_) =>
        'Cloud Run runtime image attestation is pending: ' + functionKey(function_)),
    ]);
    const blocking = problems.filter((problem) => !allowed.has(problem));
    if (blocking.length > 0) {
      for (const problem of blocking) dependencies.stderr(problem + '\n');
      return 1;
    }
    const observedByKey = new Map(observed.functions.map((function_) =>
      [functionKey(function_), function_]));
    const functions = gen2.map((function_) => {
      const key = functionKey(function_);
      const runtimeAttestation = observedByKey.get(key)?.imageRuntimeAttestation;
      assert.notEqual(runtimeAttestation, null, 'missing runtime attestation: ' + key);
      assert.notEqual(runtimeAttestation, undefined, 'missing runtime attestation: ' + key);
      return {
        name: function_.name,
        region: function_.region,
        runtimeAttestation: {
          deploymentCommit: reviewedCommit!,
          ...runtimeAttestation!,
        },
      };
    });
    dependencies.stdout(JSON.stringify({
      security: {runInventoryCheckpoint: checkpoint},
      functions,
    }, null, 2) + '\n');
    return 0;
  }
  if (problems.length > 0) {
    for (const problem of problems) dependencies.stderr(`${problem}\n`);
    return 1;
  }
  dependencies.stdout(`Deployment matches reviewed commit ${reviewedCommit}\n`);
  return 0;
}

export async function runProductionCli(arguments_: string[]): Promise<number> {
  const root = dirname(fileURLToPath(import.meta.url));
  const baseGitEnvironment = {
    PATH: process.env.PATH,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.fsmonitor',
    GIT_CONFIG_VALUE_0: 'false',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_GRAFT_FILE: '/dev/null',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  const unboundGit: GitRunner = (gitArguments) => execFileSync(
    'git', ['-C', root, ...gitArguments], {
      encoding: 'buffer',
      env: baseGitEnvironment,
    },
  );
  assert.equal(realpathSync(gitText(unboundGit, ['rev-parse', '--show-toplevel']).trim()),
    realpathSync(root), 'deployment verifier is not bound to its repository worktree');
  const gitDirectory = realpathSync(
    gitText(unboundGit, ['rev-parse', '--absolute-git-dir']).trim(),
  );
  const dotGit = resolve(root, '.git');
  assert.equal(lstatSync(dotGit).isDirectory(), true,
    'linked Git worktrees are unsupported for deployment verification');
  assert.equal(gitDirectory, realpathSync(dotGit),
    'deployment verifier is not bound to its repository Git directory');
  const gitEnvironment = {
    ...baseGitEnvironment,
    GIT_DIR: gitDirectory,
    GIT_WORK_TREE: realpathSync(root),
  };
  const runGit: GitRunner = (gitArguments) => execFileSync(
    'git', ['-C', root, ...gitArguments], {
      encoding: 'buffer',
      env: gitEnvironment,
    },
  );
  const gitPath = (name: string): string => resolve(
    root, gitText(runGit, ['rev-parse', '--git-path', name]).trim(),
  );
  const excludeFile = gitPath('info/exclude');
  const attributesFile = gitPath('info/attributes');
  const hasActiveLines = (path: string): boolean =>
    existsSync(path) && readFileSync(path, 'utf8')
      .split(/\r?\n/).some((line) => line.trim() !== '' && !line.trim().startsWith('#'));
  return runCli(arguments_, {
    root,
    runGit,
    fetch: fetch as FetchLike,
    graftFileExists: () => existsSync(gitPath('info/grafts')),
    excludeFileHasPatterns: () => hasActiveLines(excludeFile),
    attributesFileHasPatterns: () => hasActiveLines(attributesFile),
    directTrackedProblems: (reviewedCommit) =>
      directTrackedTreeProblems(root, reviewedCommit, runGit),
    settleRunAudit: () => delay(RUN_INVENTORY_QUIESCENCE_MS),
    accessToken: (account) => {
      const tokenArguments = ['auth', 'print-access-token'];
      if (account !== undefined) tokenArguments.push(`--account=${account}`);
      return execFileSync('gcloud', tokenArguments, {encoding: 'utf8'}).trim();
    },
    stdout: (message) => process.stdout.write(message),
    stderr: (message) => process.stderr.write(message),
  });
}
