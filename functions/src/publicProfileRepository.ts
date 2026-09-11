import {env} from "node:process";
import {credentials} from "@grpc/grpc-js";
import {performance} from "node:perf_hooks";
import {Timestamp, v1} from "@google-cloud/firestore";
import {logger} from "firebase-functions";

export const PROFILE_RPC_DEADLINE_MS = 3000;

type Integer = number | string | {toString(): string};
interface WireValue {
  nullValue?: unknown;
  bytesValue?: Uint8Array | string | null;
  referenceValue?: string | null;
  booleanValue?: boolean | null;
  integerValue?: Integer | null;
  doubleValue?: number | null;
  timestampValue?: {seconds?: Integer | null; nanos?: number | null} | null;
  stringValue?: string | null;
  arrayValue?: {values?: WireValue[] | null} | null;
  mapValue?: {fields?: Record<string, WireValue> | null} | null;
}

export interface ProfileReadClient {
  initialize(): Promise<unknown>;
  close?(): Promise<void>;
  getProjectId(): Promise<string>;
  getDocument(
    _request: {name: string},
    _options: {timeout: number; retry: null},
  ): Promise<readonly [{fields?: Record<string, WireValue> | null}, ...unknown[]]>;
}

export interface ProfileReadDiagnostic {
  operation: "profile" | "discovery";
  durationMs: number;
  phase: "initialization" | "lookup" | "decode";
  outcome: "success" | "missing" | "invalid" | "error";
  errorCode?: number;
}

class InvalidPublicProfileValue extends Error {}

function fieldsFromWire(fields: Record<string, WireValue>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, valueFromWire(value)]));
}

function valueFromWire(value: WireValue): unknown {
  if (Object.hasOwn(value, "nullValue")) return null;
  if (Object.hasOwn(value, "booleanValue") && value.booleanValue != null) return value.booleanValue;
  if (Object.hasOwn(value, "integerValue") && value.integerValue != null) return Number(value.integerValue.toString());
  if (Object.hasOwn(value, "doubleValue") && value.doubleValue != null) return value.doubleValue;
  if (Object.hasOwn(value, "stringValue") && value.stringValue != null) return value.stringValue;
  if (Object.hasOwn(value, "timestampValue") && value.timestampValue != null) {
    return new Timestamp(Number(value.timestampValue.seconds?.toString() ?? 0), value.timestampValue.nanos ?? 0);
  }
  if (Object.hasOwn(value, "arrayValue") && value.arrayValue != null) return (value.arrayValue.values ?? []).map(valueFromWire);
  if (Object.hasOwn(value, "mapValue") && value.mapValue != null) return fieldsFromWire(value.mapValue.fields ?? {});
  // Public profile schemas contain no bytes, references or geographic points.
  // Reject unsupported data instead of silently changing the decoder's input.
  throw new InvalidPublicProfileValue("Unsupported public profile Firestore value.");
}

interface ReaderOptions {
  timeoutMs?: number;
  onDiagnostic?: (_event: ProfileReadDiagnostic) => void;
}

export function createPublicProfileReader(
  client: ProfileReadClient,
  options: ReaderOptions = {},
) {
  const emit = options.onDiagnostic ?? ((event: ProfileReadDiagnostic) => logger.info("public_profile_read", event));
  const diagnostic = (event: ProfileReadDiagnostic): void => {
    try {
      emit(event);
    } catch {
      // A best-effort diagnostic must not change data or replace an RPC error.
    }
  };
  async function read(operation: "profile" | "discovery", collection: string, username: string, signal?: AbortSignal) {
    const startedAt = performance.now();
    let phase: ProfileReadDiagnostic["phase"] = "initialization";
    try {
      signal?.throwIfAborted();
      const projectId = await client.getProjectId();
      signal?.throwIfAborted();
      await client.initialize();
      signal?.throwIfAborted();
      phase = "lookup";
      const [document] = await client.getDocument({
        name: `projects/${projectId}/databases/(default)/documents/${collection}/${username}`,
      }, {timeout: options.timeoutMs ?? PROFILE_RPC_DEADLINE_MS, retry: null});
      signal?.throwIfAborted();
      phase = "decode";
      const result = fieldsFromWire(document.fields ?? {});
      diagnostic({operation, phase, durationMs: Math.round(performance.now() - startedAt), outcome: "success"});
      return result;
    } catch (error) {
      if (error instanceof InvalidPublicProfileValue) {
        diagnostic({operation, phase, durationMs: Math.round(performance.now() - startedAt), outcome: "invalid"});
        return null;
      }
      const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "number" ? error.code : undefined;
      diagnostic({operation, phase, durationMs: Math.round(performance.now() - startedAt), outcome: phase === "lookup" && code === 5 ? "missing" : "error", ...(code === undefined ? {} : {errorCode: code})});
      if (phase === "lookup" && code === 5) return null;
      throw error;
    }
  }
  return {
    getProfile: (username: string, signal?: AbortSignal) => read("profile", "profiles", username, signal),
    getDiscovery: (username: string, signal?: AbortSignal) => read("discovery", "profileDiscovery", username, signal),
  };
}

// Rejected project discovery and v1 initialization promises are retained by
// the SDK. Discard that
// settled client so a later cache-permitted attempt can initialize afresh.
// An application abort alone never discards a still-initializing client.
export function createLazyPublicProfileReader(
  createClient: () => ProfileReadClient,
  options: ReaderOptions = {},
) {
  let reader: ReturnType<typeof createPublicProfileReader> | undefined;
  function currentReader() {
    if (reader !== undefined) return reader;
    const client = createClient();
    const initializationFailed = (error: unknown): never => {
      if (reader === generation) {
        reader = undefined;
        // close() also rejects when the SDK's initialization promise rejected.
        client.close?.().catch(() => undefined);
      }
      throw error;
    };
    const generation = createPublicProfileReader({
      getProjectId: () => client.getProjectId().catch(initializationFailed),
      initialize: () => client.initialize().catch(initializationFailed),
      getDocument: (request, callOptions) => client.getDocument(request, callOptions),
    }, options);
    reader = generation;
    return generation;
  }
  return {
    getProfile: (username: string, signal?: AbortSignal) => currentReader().getProfile(username, signal),
    getDiscovery: (username: string, signal?: AbortSignal) => currentReader().getDiscovery(username, signal),
  };
}

export function createPublicProfileClient() {
  const emulatorHost = env.FIRESTORE_EMULATOR_HOST;
  if (!emulatorHost) return new v1.FirestoreClient();
  // Unlike the Admin Firestore client, generated v1 clients do not inspect
  // FIRESTORE_EMULATOR_HOST. Explicitly route emulator work without credentials.
  const endpoint = /^(\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.-]+):([0-9]+)$/.exec(emulatorHost);
  if (endpoint === null || Number(endpoint[2]) < 1 || Number(endpoint[2]) > 65535) {
    throw new Error("FIRESTORE_EMULATOR_HOST must specify a host and valid port.");
  }
  return new v1.FirestoreClient({
    apiEndpoint: endpoint[1].replace(/^\[|\]$/g, ""),
    port: Number(endpoint[2]),
    sslCreds: credentials.createInsecure(),
  });
}

export const publicProfileReader = createLazyPublicProfileReader(createPublicProfileClient);
