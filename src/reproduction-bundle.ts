import { createHash } from "node:crypto";
import { runSuite, type SuiteRunOptions } from "./suite-runner.js";
import type { SuiteDefinition } from "./suite-definition.js";
import type { SuiteResult } from "./suite-result.js";

export const REPRODUCTION_BUNDLE_SCHEMA =
  "mirrorecma.reproduction-bundle/v1" as const;
export const REPRODUCTION_MAX_BYTES = 8_388_608;
export const REPRODUCTION_MAX_DEPTH = 32;
export const REPRODUCTION_MAX_NODES = 100_000;
export const REPRODUCTION_MAX_INLINE_BYTES = 262_144;
export const REPRODUCTION_MAX_TOTAL_INLINE_BYTES = 1_048_576;
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_REVISION = /^[a-f0-9]{40}$/;
const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const EXTERNAL_TYPES = new Set(["evidence-blob/v1"]);
const FORBIDDEN_KEYS = new Set([
  "script",
  "command",
  "module",
  "entryPoint",
  "dependency",
  "url",
  "authorization",
  "cookie",
  "password",
  "secret",
  "token",
  "privateKey",
  "accessKey",
  "secretKey",
  "connectionString",
]);
const CREDENTIAL_TEXT =
  /authorization\s*:\s*bearer|cookie\s*:|password\s*[=:]|-----BEGIN [A-Z ]*PRIVATE KEY-----|access[_-]?key|secret[_-]?key|connection[_-]?string/i;

export interface EvidenceRunRef {
  readonly schemaVersion:
    | "mirrors.evidence-envelope/v1.0"
    | "mirrors.evidence-public-summary/v1.0";
  readonly runId: string;
  readonly envelopeSha256: string;
  readonly projectionKind: "private" | "public";
}
export interface EvidenceComponentRef {
  readonly componentId: string;
  readonly repository: string;
  readonly revision: string;
  readonly dirty: boolean;
  readonly dirtyContent?: unknown;
}
export interface EvidenceArtifactRef {
  readonly artifactId: string;
  readonly mediaType: string;
  readonly role: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly visibility: "public" | "private";
  readonly requirement: "required" | "optional";
  readonly location: Readonly<Record<string, unknown>>;
}
export interface CatalogSelectionRef {
  readonly schemaVersion: "mirrors.framework-catalog/v1";
  readonly selectionKind: "sha256" | "git-revision";
  readonly selectionValue: string;
}
export interface ReproductionEvidenceLinks {
  readonly runRef: EvidenceRunRef;
  readonly componentRefs: readonly EvidenceComponentRef[];
  readonly artifactRefs: readonly EvidenceArtifactRef[];
  readonly catalogSelectionRef: CatalogSelectionRef;
}
export interface ReproductionIdentities {
  readonly suite: { readonly id: string; readonly definitionSha256: string };
  readonly model: { readonly sourceClosureSha256: string };
  readonly corpus: {
    readonly orderedOccurrencesSha256: string;
    readonly traceCount: number;
  };
  readonly generatedInterface: {
    readonly semanticDigest: string;
    readonly moduleSha256: string;
    readonly targetProfile: string;
    readonly stateComputerContractVersion: string;
  };
  readonly implementation: {
    readonly admissionId: string;
    readonly closureSha256: string;
  };
  readonly executionProfile: { readonly id: string; readonly sha256: string };
}
export type ReproductionPrimarySignature =
  | {
      readonly kind: "behavioral_mismatch";
      readonly code: "replay_mismatch";
      readonly traceIndex: number;
      readonly stateIndex: number;
      readonly action: string;
    }
  | {
      readonly kind: "timeout";
      readonly stage:
        | "registration"
        | "factory"
        | "action"
        | "receive"
        | "cleanup";
      readonly budgetMs: number;
    }
  | {
      readonly kind: "execution_error";
      readonly origin: "observer" | "implementation";
      readonly stage: "factory" | "action" | "observation";
      readonly code: string;
    }
  | {
      readonly kind: "codec_error";
      readonly stage: "input" | "observation" | "protocol";
      readonly code: string;
    }
  | {
      readonly kind: "coverage_unmet";
      readonly requirements: readonly string[];
    }
  | {
      readonly kind: "cancellation";
      readonly stage:
        | "registration"
        | "factory"
        | "action"
        | "receive"
        | "cleanup";
      readonly code: string;
    };
export type ReproductionCleanupSignature =
  | { readonly status: "succeeded" }
  | { readonly status: "failed" | "unconfirmed"; readonly code: string };
export interface ReproductionSignature {
  readonly primary: ReproductionPrimarySignature | null;
  readonly cleanup: ReproductionCleanupSignature;
}
export type ReproductionCaptureData =
  | {
      readonly role: string;
      readonly kind: "inline";
      readonly mediaType: string;
      readonly bytes: number;
      readonly sha256: string;
      readonly base64: string;
    }
  | {
      readonly role: string;
      readonly kind: "external";
      readonly type: string;
      readonly sha256: string;
      readonly resolver: string;
    };
export interface ReproductionHandling {
  readonly consentPolicyId: string;
  readonly redactionProfileId: string;
  readonly accessPolicyId: string;
  readonly retentionUntil: string;
  readonly deletionPolicyId: string;
}
export interface ReproductionBundle {
  readonly schema: typeof REPRODUCTION_BUNDLE_SCHEMA;
  readonly evidenceLinks: ReproductionEvidenceLinks;
  readonly identities: ReproductionIdentities;
  readonly signature: ReproductionSignature;
  readonly captures: readonly ReproductionCaptureData[];
  readonly handling: ReproductionHandling;
}

export class ReproductionBundleError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ReproductionBundleError";
    this.code = code;
  }
}
export class ReproductionRefusalError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ReproductionRefusalError";
    this.code = code;
  }
}
type UnknownRecord = Record<string, unknown>;
function fail(code: string, message: string): never {
  throw new ReproductionBundleError(code, message);
}
function own(value: UnknownRecord, key: string): unknown {
  const d = Object.getOwnPropertyDescriptor(value, key);
  if (!d || !("value" in d))
    fail("bundle_non_data_property", `${key} must be a data property`);
  return d.value;
}
function record(value: unknown, where: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail("bundle_schema_invalid", `${where} must be an object`);
  return value as UnknownRecord;
}
function exact(
  value: UnknownRecord,
  keys: readonly string[],
  where: string,
): void {
  const actual = Object.getOwnPropertyNames(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...keys].sort()))
    fail("bundle_schema_invalid", `${where} has unknown or missing fields`);
}
function text(
  value: unknown,
  where: string,
  pattern?: RegExp,
  maxBytes = 65_536,
): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value) > maxBytes ||
    (pattern && !pattern.test(value))
  )
    fail("bundle_schema_invalid", `${where} is invalid`);
  return value;
}
function integer(
  value: unknown,
  where: string,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  )
    fail("bundle_schema_invalid", `${where} is invalid`);
  return value as number;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (k) => `${JSON.stringify(k)}:${canonical((value as UnknownRecord)[k])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
function cloneFreeze<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(cloneFreeze)) as T;
  if (value && typeof value === "object") {
    const output = Object.create(null) as UnknownRecord;
    for (const key of Object.getOwnPropertyNames(value)) {
      const d = Object.getOwnPropertyDescriptor(value, key)!;
      if (!("value" in d))
        fail("bundle_non_data_property", "accessors are forbidden");
      output[key] = cloneFreeze(d.value);
    }
    return Object.freeze(output) as T;
  }
  return value;
}

/** Parse once with a bounded recursive-descent scanner so duplicate keys and depth fail before JSON.parse. */
function preflightJson(raw: string): void {
  if (Buffer.byteLength(raw) > REPRODUCTION_MAX_BYTES)
    fail("bundle_too_large", "bundle exceeds byte limit");
  let i = 0,
    nodes = 0;
  const ws = () => {
    while (/[\x20\x09\x0a\x0d]/.test(raw[i] ?? "")) i++;
  };
  const stringToken = (maxBytes = 65_536): string => {
    if (raw[i] !== '"') fail("bundle_json_invalid", "expected JSON string");
    const start = i++;
    let escaped = false;
    for (; i < raw.length; i++) {
      const c = raw[i]!;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (c === "\\") {
        escaped = true;
        continue;
      }
      if (c === '"') {
        i++;
        const slice = raw.slice(start, i);
        const value = JSON.parse(slice) as string;
        if (Buffer.byteLength(value) > maxBytes)
          fail("bundle_string_too_large", "string exceeds limit");
        return value;
      }
      if (c < " ") fail("bundle_json_invalid", "control character in string");
    }
    fail("bundle_json_invalid", "unterminated string");
  };
  const value = (depth: number, maxStringBytes = 65_536): void => {
    if (depth > REPRODUCTION_MAX_DEPTH || ++nodes > REPRODUCTION_MAX_NODES)
      fail("bundle_structure_limit", "bundle structure exceeds limit");
    ws();
    const c = raw[i];
    if (c === "{") {
      i++;
      ws();
      const keys = new Set<string>();
      let count = 0;
      if (raw[i] === "}") {
        i++;
        return;
      }
      while (true) {
        const key = stringToken();
        if (keys.has(key)) fail("bundle_duplicate_key", `duplicate key ${key}`);
        keys.add(key);
        if (++count > 256)
          fail("bundle_structure_limit", "object exceeds member limit");
        ws();
        if (raw[i++] !== ":") fail("bundle_json_invalid", "missing colon");
        value(depth + 1, key === "base64" ? 349_528 : 65_536);
        ws();
        if (raw[i] === "}") {
          i++;
          return;
        }
        if (raw[i++] !== ",") fail("bundle_json_invalid", "missing comma");
        ws();
      }
    } else if (c === "[") {
      i++;
      ws();
      let count = 0;
      if (raw[i] === "]") {
        i++;
        return;
      }
      while (true) {
        if (++count > 4096)
          fail("bundle_structure_limit", "array exceeds element limit");
        value(depth + 1);
        ws();
        if (raw[i] === "]") {
          i++;
          return;
        }
        if (raw[i++] !== ",") fail("bundle_json_invalid", "missing comma");
        ws();
      }
    } else if (c === '"') {
      stringToken(maxStringBytes);
    } else {
      const match =
        /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(
          raw.slice(i),
        );
      if (!match) fail("bundle_json_invalid", "invalid JSON value");
      i += match[0].length;
    }
  };
  value(0);
  ws();
  if (i !== raw.length) fail("bundle_json_invalid", "trailing JSON content");
}
function boundedGraph(value: unknown): void {
  let nodes = 0;
  const visiting = new WeakSet<object>();
  const visit = (
    item: unknown,
    depth: number,
    maxStringBytes = 65_536,
  ): void => {
    if (depth > REPRODUCTION_MAX_DEPTH || ++nodes > REPRODUCTION_MAX_NODES)
      fail("bundle_structure_limit", "structure exceeds limit");
    if (typeof item === "string") {
      text(item, "string", undefined, maxStringBytes);
      return;
    }
    if (item === null || typeof item === "number" || typeof item === "boolean")
      return;
    if (typeof item !== "object") fail("bundle_non_json", "non-JSON value");
    if (visiting.has(item)) fail("bundle_cycle", "cyclic value");
    const proto = Object.getPrototypeOf(item);
    if (
      proto !== null &&
      proto !== Object.prototype &&
      proto !== Array.prototype
    )
      fail("bundle_non_plain", "non-plain object");
    visiting.add(item);
    if (Array.isArray(item)) {
      if (item.length > 4096)
        fail("bundle_structure_limit", "array exceeds limit");
      for (const child of item) visit(child, depth + 1);
    } else {
      const keys = Object.getOwnPropertyNames(item);
      if (keys.length > 256)
        fail("bundle_structure_limit", "object exceeds limit");
      for (const key of keys) {
        const d = Object.getOwnPropertyDescriptor(item, key)!;
        if (!("value" in d))
          fail("bundle_non_data_property", "accessors are forbidden");
        if (FORBIDDEN_KEYS.has(key))
          fail("bundle_ambient_authority", `forbidden field ${key}`);
        visit(d.value, depth + 1, key === "base64" ? 349_528 : 65_536);
      }
    }
    visiting.delete(item);
  };
  visit(value, 0);
}

function validateRunRef(value: unknown): void {
  const r = record(value, "runRef");
  exact(
    r,
    ["schemaVersion", "runId", "envelopeSha256", "projectionKind"],
    "runRef",
  );
  const version = own(r, "schemaVersion"),
    projection = own(r, "projectionKind");
  if (
    !(
      (version === "mirrors.evidence-envelope/v1.0" &&
        projection === "private") ||
      (version === "mirrors.evidence-public-summary/v1.0" &&
        projection === "public")
    )
  )
    fail("evidence_ref_invalid", "runRef projection mismatch");
  text(own(r, "runId"), "runId", OPAQUE_ID);
  text(own(r, "envelopeSha256"), "envelopeSha256", SHA256);
}
function validateComponentRef(value: unknown): void {
  const r = record(value, "componentRef"),
    dirty = own(r, "dirty");
  exact(
    r,
    dirty === true
      ? ["componentId", "repository", "revision", "dirty", "dirtyContent"]
      : ["componentId", "repository", "revision", "dirty"],
    "componentRef",
  );
  text(own(r, "componentId"), "componentId", OPAQUE_ID);
  text(own(r, "repository"), "repository");
  text(own(r, "revision"), "revision", GIT_REVISION);
  if (typeof dirty !== "boolean")
    fail("evidence_ref_invalid", "component dirty flag invalid");
}
function validateArtifactRef(value: unknown): void {
  const r = record(value, "artifactRef");
  exact(
    r,
    [
      "artifactId",
      "mediaType",
      "role",
      "bytes",
      "sha256",
      "visibility",
      "requirement",
      "location",
    ],
    "artifactRef",
  );
  text(own(r, "artifactId"), "artifactId", OPAQUE_ID);
  text(own(r, "mediaType"), "mediaType");
  if (
    ![
      "command-log",
      "cleanup-receipt",
      "producer-result",
      "diagnostic",
      "reproduction-input",
      "recovery-receipt",
    ].includes(String(own(r, "role")))
  )
    fail("evidence_ref_invalid", "artifact role invalid");
  integer(own(r, "bytes"), "artifact bytes", 0, 67_108_864);
  text(own(r, "sha256"), "artifact sha256", SHA256);
  if (
    !["public", "private"].includes(String(own(r, "visibility"))) ||
    !["required", "optional"].includes(String(own(r, "requirement")))
  )
    fail("evidence_ref_invalid", "artifact policy invalid");
  const location = record(own(r, "location"), "artifact location");
  if (own(location, "kind") === "bundle") {
    exact(location, ["kind", "path"], "bundle location");
    const path = text(own(location, "path"), "logical path");
    if (
      path.startsWith("/") ||
      path.includes("\\") ||
      path.split("/").some((p) => p === "." || p === ".." || !p)
    )
      fail("evidence_ref_invalid", "logical path invalid");
  } else if (own(location, "kind") === "external") {
    exact(location, ["kind", "immutableUri"], "external location");
    if (
      !/^(?:https:\/\/|urn:)[^\s]+$/.test(
        text(own(location, "immutableUri"), "immutableUri"),
      )
    )
      fail("evidence_ref_invalid", "immutable URI invalid");
  } else fail("evidence_ref_invalid", "artifact location invalid");
}
function validateCatalogRef(value: unknown): void {
  const r = record(value, "catalogSelectionRef");
  exact(
    r,
    ["schemaVersion", "selectionKind", "selectionValue"],
    "catalogSelectionRef",
  );
  if (own(r, "schemaVersion") !== "mirrors.framework-catalog/v1")
    fail("catalog_ref_invalid", "catalog schema mismatch");
  const kind = own(r, "selectionKind"),
    selected = text(own(r, "selectionValue"), "selectionValue");
  if (
    (kind === "sha256" && !SHA256.test(selected)) ||
    (kind === "git-revision" && !GIT_REVISION.test(selected)) ||
    (kind !== "sha256" && kind !== "git-revision")
  )
    fail("catalog_ref_invalid", "catalog selection invalid");
}
export function validateEvidenceRunReference(value: unknown): EvidenceRunRef {
  validateRunRef(value);
  return cloneFreeze(value) as EvidenceRunRef;
}
export function validateEvidenceArtifactReferences(
  value: unknown,
): readonly EvidenceArtifactRef[] {
  if (!Array.isArray(value) || value.length > 128)
    fail("evidence_ref_invalid", "artifact references invalid");
  value.forEach(validateArtifactRef);
  const artifactIds = value.map((item) =>
    String((item as UnknownRecord).artifactId),
  );
  if (new Set(artifactIds).size !== artifactIds.length)
    fail("evidence_ref_invalid", "duplicate artifact identity");
  return cloneFreeze(value) as readonly EvidenceArtifactRef[];
}
export function validateCatalogSelectionReference(
  value: unknown,
): CatalogSelectionRef {
  validateCatalogRef(value);
  return cloneFreeze(value) as CatalogSelectionRef;
}
function validateIdentities(value: unknown): void {
  const ids = record(value, "identities");
  exact(
    ids,
    [
      "suite",
      "model",
      "corpus",
      "generatedInterface",
      "implementation",
      "executionProfile",
    ],
    "identities",
  );
  const suite = record(own(ids, "suite"), "suite");
  exact(suite, ["id", "definitionSha256"], "suite");
  text(own(suite, "id"), "suite id", STABLE_ID);
  text(own(suite, "definitionSha256"), "suite digest", SHA256);
  const model = record(own(ids, "model"), "model");
  exact(model, ["sourceClosureSha256"], "model");
  text(own(model, "sourceClosureSha256"), "model digest", SHA256);
  const corpus = record(own(ids, "corpus"), "corpus");
  exact(corpus, ["orderedOccurrencesSha256", "traceCount"], "corpus");
  text(own(corpus, "orderedOccurrencesSha256"), "corpus digest", SHA256);
  integer(own(corpus, "traceCount"), "trace count", 1, 4096);
  const generated = record(
    own(ids, "generatedInterface"),
    "generatedInterface",
  );
  exact(
    generated,
    [
      "semanticDigest",
      "moduleSha256",
      "targetProfile",
      "stateComputerContractVersion",
    ],
    "generatedInterface",
  );
  text(own(generated, "semanticDigest"), "semanticDigest", SHA256);
  text(own(generated, "moduleSha256"), "moduleSha256", SHA256);
  text(own(generated, "targetProfile"), "targetProfile", STABLE_ID);
  text(
    own(generated, "stateComputerContractVersion"),
    "computer contract",
    STABLE_ID,
  );
  const implementation = record(own(ids, "implementation"), "implementation");
  exact(implementation, ["admissionId", "closureSha256"], "implementation");
  text(own(implementation, "admissionId"), "admissionId", STABLE_ID);
  text(own(implementation, "closureSha256"), "implementation digest", SHA256);
  const profile = record(own(ids, "executionProfile"), "executionProfile");
  exact(profile, ["id", "sha256"], "executionProfile");
  text(own(profile, "id"), "profile id", STABLE_ID);
  text(own(profile, "sha256"), "profile digest", SHA256);
}
function validateSignature(value: unknown): void {
  const s = record(value, "signature");
  exact(s, ["primary", "cleanup"], "signature");
  const cleanup = record(own(s, "cleanup"), "cleanup"),
    status = own(cleanup, "status");
  if (status === "succeeded") exact(cleanup, ["status"], "cleanup");
  else if (status === "failed" || status === "unconfirmed") {
    exact(cleanup, ["status", "code"], "cleanup");
    text(own(cleanup, "code"), "cleanup code", STABLE_ID);
  } else fail("signature_invalid", "cleanup status invalid");
  const p = own(s, "primary");
  if (p === null) {
    if (status === "succeeded")
      fail("signature_invalid", "cleanup-only signature cannot succeed");
    return;
  }
  const primary = record(p, "primary"),
    kind = own(primary, "kind");
  if (kind === "behavioral_mismatch") {
    exact(
      primary,
      ["kind", "code", "traceIndex", "stateIndex", "action"],
      "mismatch",
    );
    if (own(primary, "code") !== "replay_mismatch")
      fail("signature_invalid", "mismatch code invalid");
    integer(own(primary, "traceIndex"), "traceIndex");
    integer(own(primary, "stateIndex"), "stateIndex");
    text(own(primary, "action"), "action", STABLE_ID);
  } else if (kind === "timeout") {
    exact(primary, ["kind", "stage", "budgetMs"], "timeout");
    if (
      !["registration", "factory", "action", "receive", "cleanup"].includes(
        String(own(primary, "stage")),
      )
    )
      fail("signature_invalid", "timeout stage invalid");
    integer(own(primary, "budgetMs"), "budgetMs", 1, 0x7fffffff);
  } else if (kind === "execution_error") {
    exact(primary, ["kind", "origin", "stage", "code"], "execution error");
    if (
      !["observer", "implementation"].includes(
        String(own(primary, "origin")),
      ) ||
      !["factory", "action", "observation"].includes(
        String(own(primary, "stage")),
      )
    )
      fail("signature_invalid", "execution error invalid");
    text(own(primary, "code"), "code", STABLE_ID);
  } else if (kind === "codec_error") {
    exact(primary, ["kind", "stage", "code"], "codec error");
    if (
      !["input", "observation", "protocol"].includes(
        String(own(primary, "stage")),
      )
    )
      fail("signature_invalid", "codec stage invalid");
    text(own(primary, "code"), "code", STABLE_ID);
  } else if (kind === "coverage_unmet") {
    exact(primary, ["kind", "requirements"], "coverage");
    const requirements = own(primary, "requirements");
    if (
      !Array.isArray(requirements) ||
      !requirements.length ||
      requirements.length > 128
    )
      fail("signature_invalid", "requirements invalid");
    const values = requirements.map((v, i) =>
      text(v, `requirement ${i}`, STABLE_ID),
    );
    if (
      new Set(values).size !== values.length ||
      JSON.stringify(values) !== JSON.stringify([...values].sort())
    )
      fail("signature_invalid", "requirements not sorted and unique");
  } else if (kind === "cancellation") {
    exact(primary, ["kind", "stage", "code"], "cancellation");
    if (
      !["registration", "factory", "action", "receive", "cleanup"].includes(
        String(own(primary, "stage")),
      )
    )
      fail("signature_invalid", "cancellation stage invalid");
    text(own(primary, "code"), "code", STABLE_ID);
  } else fail("signature_invalid", "unknown primary signature");
}
function validateCapture(value: unknown): "inline" | "external" {
  const c = record(value, "capture");
  text(own(c, "role"), "capture role", STABLE_ID);
  if (own(c, "kind") === "inline") {
    exact(
      c,
      ["role", "kind", "mediaType", "bytes", "sha256", "base64"],
      "inline capture",
    );
    const media = text(own(c, "mediaType"), "mediaType"),
      bytes = integer(
        own(c, "bytes"),
        "bytes",
        0,
        REPRODUCTION_MAX_INLINE_BYTES,
      ),
      expected = text(own(c, "sha256"), "sha256", SHA256),
      encoded = text(own(c, "base64"), "base64", undefined, 349_528);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
      fail("capture_invalid", "base64 invalid");
    const decoded = Buffer.from(encoded, "base64");
    if (
      decoded.length !== bytes ||
      decoded.toString("base64") !== encoded ||
      createHash("sha256").update(decoded).digest("hex") !== expected
    )
      fail("capture_digest_mismatch", "inline capture identity mismatch");
    if (
      media === "text/plain" &&
      CREDENTIAL_TEXT.test(decoded.toString("utf8"))
    )
      fail("capture_credentials_forbidden", "credential content rejected");
    return "inline";
  }
  if (own(c, "kind") === "external") {
    exact(
      c,
      ["role", "kind", "type", "sha256", "resolver"],
      "external capture",
    );
    if (!EXTERNAL_TYPES.has(text(own(c, "type"), "external type", STABLE_ID)))
      fail("external_type_unsupported", "external type unsupported");
    text(own(c, "sha256"), "external digest", SHA256);
    text(own(c, "resolver"), "resolver", STABLE_ID);
    return "external";
  }
  fail("capture_invalid", "unknown capture kind");
}
function validateHandling(value: unknown): void {
  const h = record(value, "handling");
  exact(
    h,
    [
      "consentPolicyId",
      "redactionProfileId",
      "accessPolicyId",
      "retentionUntil",
      "deletionPolicyId",
    ],
    "handling",
  );
  for (const key of [
    "consentPolicyId",
    "redactionProfileId",
    "accessPolicyId",
    "deletionPolicyId",
  ])
    text(own(h, key), key, STABLE_ID);
  const until = text(own(h, "retentionUntil"), "retentionUntil");
  if (!Number.isFinite(Date.parse(until)))
    fail("bundle_schema_invalid", "retentionUntil invalid");
}

export function validateReproductionBundle(value: unknown): ReproductionBundle {
  boundedGraph(value);
  const b = record(value, "bundle");
  exact(
    b,
    [
      "schema",
      "evidenceLinks",
      "identities",
      "signature",
      "captures",
      "handling",
    ],
    "bundle",
  );
  if (own(b, "schema") !== REPRODUCTION_BUNDLE_SCHEMA)
    fail("bundle_schema_unsupported", "unsupported reproduction schema");
  const links = record(own(b, "evidenceLinks"), "evidenceLinks");
  exact(
    links,
    ["runRef", "componentRefs", "artifactRefs", "catalogSelectionRef"],
    "evidenceLinks",
  );
  validateRunRef(own(links, "runRef"));
  const components = own(links, "componentRefs");
  if (
    !Array.isArray(components) ||
    !components.length ||
    components.length > 64
  )
    fail("evidence_ref_invalid", "component references invalid");
  components.forEach(validateComponentRef);
  const componentIds = components.map((value) =>
    String((value as UnknownRecord).componentId),
  );
  if (new Set(componentIds).size !== componentIds.length)
    fail("evidence_ref_invalid", "duplicate component identity");
  const artifacts = own(links, "artifactRefs");
  validateEvidenceArtifactReferences(artifacts);
  validateCatalogRef(own(links, "catalogSelectionRef"));
  validateIdentities(own(b, "identities"));
  validateSignature(own(b, "signature"));
  const captures = own(b, "captures");
  if (!Array.isArray(captures) || !captures.length || captures.length > 128)
    fail("capture_invalid", "capture count invalid");
  let inlineBytes = 0,
    externals = 0;
  for (const item of captures) {
    if (validateCapture(item) === "inline")
      inlineBytes += Number((item as UnknownRecord).bytes);
    else externals++;
  }
  if (inlineBytes > REPRODUCTION_MAX_TOTAL_INLINE_BYTES || externals > 64)
    fail("capture_limit", "capture aggregate limit exceeded");
  validateHandling(own(b, "handling"));
  return cloneFreeze(b) as unknown as ReproductionBundle;
}
export function parseBoundedJsonValue(raw: string | Uint8Array): unknown {
  let textValue: string;
  if (typeof raw === "string") textValue = raw;
  else
    try {
      textValue = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      fail("bundle_utf8_invalid", "bundle is not valid UTF-8");
    }
  preflightJson(textValue);
  try {
    return JSON.parse(textValue);
  } catch {
    fail("bundle_json_invalid", "invalid JSON");
  }
}
export function decodeReproductionBundle(
  raw: string | Uint8Array,
): ReproductionBundle {
  return validateReproductionBundle(parseBoundedJsonValue(raw));
}
export function encodeReproductionBundle(bundle: ReproductionBundle): string {
  return `${canonical(validateReproductionBundle(bundle))}\n`;
}
export function reproductionBundleSha256(bundle: ReproductionBundle): string {
  return createHash("sha256")
    .update(encodeReproductionBundle(bundle))
    .digest("hex");
}

export interface SuiteNormalizationContext {
  readonly timeoutBudgetMs?: number;
  readonly executionErrorOrigin?: "observer" | "implementation";
  readonly executionErrorStage?: "factory" | "action" | "observation";
  readonly codecStage?: "input" | "observation" | "protocol";
  readonly unmetRequirements?: readonly string[];
}
function safeAction(error: unknown): string | undefined {
  try {
    if (!error || typeof error !== "object") return;
    const d = Object.getOwnPropertyDescriptor(error, "action");
    return d && "value" in d && typeof d.value === "string"
      ? d.value
      : undefined;
  } catch {
    return;
  }
}
function cleanupOf(result: SuiteResult): ReproductionCleanupSignature {
  return result.cleanup.status === "succeeded"
    ? { status: "succeeded" }
    : {
        status: result.cleanup.status,
        code:
          result.failure?.kind === "cleanup"
            ? result.failure.code
            : result.cleanup.status === "failed"
              ? "cleanup_failed"
              : "cleanup_unconfirmed",
      };
}
function normalizedStage(
  stage: string,
): "registration" | "factory" | "action" | "receive" | "cleanup" {
  return stage === "factory"
    ? "factory"
    : stage === "cleanup"
      ? "cleanup"
      : stage === "configuration" || stage === "negotiation"
        ? "registration"
        : "action";
}
export function signatureFromSuiteResult(
  result: SuiteResult,
  context: SuiteNormalizationContext = {},
): ReproductionSignature | null {
  const cleanup = cleanupOf(result),
    failure = result.failure;
  if (!failure) {
    if (result.outcome === "passed") return null;
    throw new ReproductionBundleError(
      "suite_result_unsupported",
      "suite result lacks normalized failure",
    );
  }
  let primary: ReproductionPrimarySignature | null;
  if (failure.kind === "mismatch") {
    const action = safeAction(result.trustedError);
    if (
      failure.traceIndex === undefined ||
      failure.stateIndex === undefined ||
      !action
    )
      throw new ReproductionBundleError(
        "suite_result_incomplete",
        "mismatch coordinates/action unavailable",
      );
    primary = {
      kind: "behavioral_mismatch",
      code: "replay_mismatch",
      traceIndex: failure.traceIndex,
      stateIndex: failure.stateIndex,
      action,
    };
  } else if (failure.kind === "timeout") {
    if (context.timeoutBudgetMs === undefined)
      throw new ReproductionBundleError(
        "normalization_context_missing",
        "timeout budget required",
      );
    primary = {
      kind: "timeout",
      stage: normalizedStage(failure.stage),
      budgetMs: context.timeoutBudgetMs,
    };
  } else if (failure.kind === "cancellation")
    primary = {
      kind: "cancellation",
      stage: normalizedStage(failure.stage),
      code: failure.code,
    };
  else if (failure.kind === "codec")
    primary = {
      kind: "codec_error",
      stage: context.codecStage ?? "observation",
      code: failure.code,
    };
  else if (failure.kind === "acceptance" && failure.code === "coverage_unmet") {
    const requirements = [...(context.unmetRequirements ?? [])].sort();
    if (!requirements.length)
      throw new ReproductionBundleError(
        "normalization_context_missing",
        "unmet requirements required",
      );
    primary = { kind: "coverage_unmet", requirements };
  } else if (failure.kind === "cleanup") primary = null;
  else
    primary = {
      kind: "execution_error",
      origin: context.executionErrorOrigin ?? "implementation",
      stage:
        context.executionErrorStage ??
        (failure.stage === "factory" ? "factory" : "action"),
      code: failure.code,
    };
  return cloneFreeze({ primary, cleanup });
}
export function signaturesEqual(
  left: ReproductionSignature,
  right: ReproductionSignature,
): boolean {
  return canonical(left) === canonical(right);
}

export function replayResultMatchesBundle(
  bundle: ReproductionBundle,
  replay: ReproductionReplayResult,
): boolean {
  return (
    signaturesEqual(bundle.signature, replay.expected) &&
    replay.status === "reproduced" &&
    replay.observed !== null &&
    signaturesEqual(bundle.signature, replay.observed)
  );
}

export interface CaptureReproductionOptions {
  readonly evidenceLinks: ReproductionEvidenceLinks;
  readonly identities: ReproductionIdentities;
  readonly captures: readonly ReproductionCaptureData[];
  readonly handling: ReproductionHandling;
  readonly normalization?: SuiteNormalizationContext;
  readonly persist?: (bytes: Uint8Array) => void | Promise<void>;
}
export interface ReproductionCapture {
  readonly schema: "mirrorecma.reproduction-capture/v1";
  readonly bundle: ReproductionBundle;
  readonly persistence: {
    readonly status: "not_requested" | "written" | "failed";
    readonly code?: string;
  };
  readonly suiteResult?: SuiteResult;
}
export async function captureReproduction(
  result: SuiteResult,
  options: CaptureReproductionOptions,
): Promise<ReproductionCapture> {
  const signature = signatureFromSuiteResult(result, options.normalization);
  if (signature === null)
    throw new ReproductionBundleError(
      "capture_requires_failure",
      "passing result cannot form failure bundle",
    );
  const bundle = validateReproductionBundle({
    schema: REPRODUCTION_BUNDLE_SCHEMA,
    evidenceLinks: options.evidenceLinks,
    identities: options.identities,
    signature,
    captures: options.captures,
    handling: options.handling,
  });
  let persistence: ReproductionCapture["persistence"] = {
    status: "not_requested",
  };
  if (options.persist) {
    try {
      await options.persist(Buffer.from(encodeReproductionBundle(bundle)));
      persistence = { status: "written" };
    } catch {
      persistence = {
        status: "failed",
        code: "reproduction_persistence_failed",
      };
    }
  }
  const capture: ReproductionCapture = {
    schema: "mirrorecma.reproduction-capture/v1",
    bundle,
    persistence,
  };
  Object.defineProperty(capture, "suiteResult", {
    value: result,
    enumerable: false,
  });
  return Object.freeze(capture);
}

export interface ExternalResolutionLimits {
  readonly perReferenceBytes: number;
  readonly aggregateBytes: number;
  readonly resolutionMs: number;
}
export interface ReproductionPreflightOptions {
  readonly expectedIdentities: ReproductionIdentities;
  readonly expectedCatalogSelection: CatalogSelectionRef;
  readonly validateEvidenceLinks: (
    links: ReproductionEvidenceLinks,
  ) => void | Promise<void>;
  readonly admittedResolvers: ReadonlySet<string>;
  readonly resolveExternal: (
    reference: Extract<ReproductionCaptureData, { kind: "external" }>,
    signal: AbortSignal,
  ) => Uint8Array | string | Promise<Uint8Array | string>;
  readonly externalLimits?: Partial<ExternalResolutionLimits>;
  readonly validationMs?: number;
  readonly validateCompatibility?: () => void | Promise<void>;
  readonly signal?: AbortSignal;
}
const DEFAULT_EXTERNAL_LIMITS: ExternalResolutionLimits = Object.freeze({
  perReferenceBytes: 8_388_608,
  aggregateBytes: 67_108_864,
  resolutionMs: 10_000,
});
async function boundedValidation<T>(
  operation: (signal: AbortSignal) => T | Promise<T>,
  options: ReproductionPreflightOptions,
  budgetMs: number,
): Promise<T> {
  if (options.signal?.aborted)
    throw new ReproductionRefusalError(
      "preflight_cancelled",
      "reproduction preflight cancelled",
    );
  const controller = new AbortController();
  const forward = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", forward, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  const pending = Promise.resolve().then(() => {
    if (controller.signal.aborted)
      throw new ReproductionRefusalError(
        "preflight_cancelled",
        "reproduction preflight cancelled",
      );
    return operation(controller.signal);
  });
  void pending.catch(() => {});
  const boundary = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort("preflight validation timeout");
      reject(
        new ReproductionRefusalError(
          "preflight_validation_timeout",
          "reproduction validation callback timed out",
        ),
      );
    }, budgetMs);
    abort = () => {
      controller.abort(options.signal?.reason);
      reject(
        new ReproductionRefusalError(
          "preflight_cancelled",
          "reproduction preflight cancelled",
        ),
      );
    };
    options.signal?.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([pending, boundary]);
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", forward);
    options.signal?.removeEventListener("abort", abort);
  }
}
async function resolveBounded(
  reference: Extract<ReproductionCaptureData, { kind: "external" }>,
  options: ReproductionPreflightOptions,
  limits: ExternalResolutionLimits,
): Promise<Uint8Array> {
  if (options.signal?.aborted)
    throw new ReproductionRefusalError(
      "preflight_cancelled",
      "reproduction preflight cancelled",
    );
  const controller = new AbortController(),
    forward = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", forward, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined,
    abort = () => {};
  const pending = Promise.resolve().then(() => {
    if (controller.signal.aborted)
      throw new ReproductionRefusalError(
        "preflight_cancelled",
        "reproduction preflight cancelled",
      );
    return options.resolveExternal(reference, controller.signal);
  });
  void pending.catch(() => {});
  const boundary = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort("resolver timeout");
      reject(
        new ReproductionRefusalError(
          "external_reference_timeout",
          "external reference resolution timed out",
        ),
      );
    }, limits.resolutionMs);
    abort = () => {
      controller.abort(options.signal?.reason);
      reject(
        new ReproductionRefusalError(
          "preflight_cancelled",
          "reproduction preflight cancelled",
        ),
      );
    };
    options.signal?.addEventListener("abort", abort, { once: true });
  });
  try {
    const resolved = await Promise.race([pending, boundary]);
    return typeof resolved === "string" ? Buffer.from(resolved) : resolved;
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", forward);
    options.signal?.removeEventListener("abort", abort);
  }
}
export async function preflightReproduction(
  bundleOrRaw: ReproductionBundle | string | Uint8Array,
  options: ReproductionPreflightOptions,
): Promise<ReproductionBundle> {
  let bundle: ReproductionBundle;
  try {
    bundle =
      typeof bundleOrRaw === "string" || bundleOrRaw instanceof Uint8Array
        ? decodeReproductionBundle(bundleOrRaw)
        : validateReproductionBundle(bundleOrRaw);
  } catch (error) {
    throw error instanceof ReproductionBundleError
      ? new ReproductionRefusalError(error.code, error.message)
      : error;
  }
  if (options.signal?.aborted)
    throw new ReproductionRefusalError(
      "preflight_cancelled",
      "reproduction preflight cancelled",
    );
  if (canonical(bundle.identities) !== canonical(options.expectedIdentities))
    throw new ReproductionRefusalError(
      "identity_mismatch",
      "reproduction identities do not match evaluator authority",
    );
  if (
    canonical(bundle.evidenceLinks.catalogSelectionRef) !==
    canonical(options.expectedCatalogSelection)
  )
    throw new ReproductionRefusalError(
      "catalog_mismatch",
      "catalog selection does not match evaluator authority",
    );
  const validationMs = options.validationMs ?? 10_000;
  if (
    !Number.isSafeInteger(validationMs) ||
    validationMs < 1 ||
    validationMs > 0x7fffffff
  )
    throw new ReproductionRefusalError(
      "preflight_limits_invalid",
      "preflight validation deadline invalid",
    );
  try {
    await boundedValidation(
      () => options.validateEvidenceLinks(bundle.evidenceLinks),
      options,
      validationMs,
    );
    if (options.signal?.aborted)
      throw new ReproductionRefusalError(
        "preflight_cancelled",
        "reproduction preflight cancelled",
      );
    if (options.validateCompatibility)
      await boundedValidation(
        () => options.validateCompatibility!(),
        options,
        validationMs,
      );
  } catch (error) {
    if (error instanceof ReproductionRefusalError) throw error;
    throw new ReproductionRefusalError(
      "compatibility_refused",
      "evidence or compatibility authority refused bundle",
    );
  }
  const limits = { ...DEFAULT_EXTERNAL_LIMITS, ...options.externalLimits };
  if (
    !Number.isSafeInteger(limits.perReferenceBytes) ||
    limits.perReferenceBytes < 1 ||
    limits.perReferenceBytes > 67_108_864 ||
    !Number.isSafeInteger(limits.aggregateBytes) ||
    limits.aggregateBytes < 1 ||
    limits.aggregateBytes > 67_108_864 ||
    !Number.isSafeInteger(limits.resolutionMs) ||
    limits.resolutionMs < 1 ||
    limits.resolutionMs > 0x7fffffff
  )
    throw new ReproductionRefusalError(
      "external_limits_invalid",
      "external resolution limits invalid",
    );
  let total = 0;
  for (const capture of bundle.captures) {
    if (capture.kind !== "external") continue;
    if (options.signal?.aborted)
      throw new ReproductionRefusalError(
        "preflight_cancelled",
        "reproduction preflight cancelled",
      );
    if (!options.admittedResolvers.has(capture.resolver))
      throw new ReproductionRefusalError(
        "resolver_not_admitted",
        "external resolver is not admitted",
      );
    let bytes: Uint8Array;
    try {
      bytes = await resolveBounded(capture, options, limits);
    } catch (error) {
      if (error instanceof ReproductionRefusalError) throw error;
      throw new ReproductionRefusalError(
        "external_reference_unavailable",
        "external reference could not be resolved",
      );
    }
    total += bytes.byteLength;
    if (
      bytes.byteLength > limits.perReferenceBytes ||
      total > limits.aggregateBytes
    )
      throw new ReproductionRefusalError(
        "external_reference_too_large",
        "external reference exceeds byte limits",
      );
    if (createHash("sha256").update(bytes).digest("hex") !== capture.sha256)
      throw new ReproductionRefusalError(
        "external_digest_mismatch",
        "external reference digest mismatch",
      );
  }
  return bundle;
}
export interface ReproductionReplayOptions
  extends ReproductionPreflightOptions {
  readonly normalization?: SuiteNormalizationContext;
  readonly evaluate: (signal?: AbortSignal) => Promise<SuiteResult>;
  readonly signal?: AbortSignal;
}
export interface ReproductionReplayResult {
  readonly schema: "mirrorecma.reproduction-replay/v1";
  readonly status: "reproduced" | "not_reproduced";
  readonly expected: ReproductionSignature;
  readonly observed: ReproductionSignature | null;
  readonly suiteResult?: SuiteResult;
}
export async function replayReproduction(
  bundleOrRaw: ReproductionBundle | string | Uint8Array,
  options: ReproductionReplayOptions,
): Promise<ReproductionReplayResult> {
  const bundle = await preflightReproduction(bundleOrRaw, options);
  if (options.signal?.aborted)
    throw new ReproductionRefusalError(
      "replay_cancelled",
      "replay cancelled before acquisition",
    );
  const result = await options.evaluate(options.signal);
  const observed = signatureFromSuiteResult(result, options.normalization);
  const replay: ReproductionReplayResult = {
    schema: "mirrorecma.reproduction-replay/v1",
    status:
      observed !== null && signaturesEqual(bundle.signature, observed)
        ? "reproduced"
        : "not_reproduced",
    expected: bundle.signature,
    observed,
  };
  Object.defineProperty(replay, "suiteResult", {
    value: result,
    enumerable: false,
  });
  return Object.freeze(replay);
}
export interface LocalReproductionReplayOptions<Port>
  extends ReproductionPreflightOptions {
  readonly suite: SuiteDefinition<Port>;
  readonly run: SuiteRunOptions<Port>;
  readonly normalization?: SuiteNormalizationContext;
  readonly signal?: AbortSignal;
}
export function replayReproductionLocal<Port>(
  bundle: ReproductionBundle | string | Uint8Array,
  options: LocalReproductionReplayOptions<Port>,
): Promise<ReproductionReplayResult> {
  return replayReproduction(bundle, {
    ...options,
    signal: options.signal,
    evaluate: (signal) => runSuite(options.suite, { ...options.run, signal }),
  });
}

export interface ReproductionPublicSummary {
  readonly schema: "mirrorecma.reproduction-public-summary/v1";
  readonly runRef: EvidenceRunRef;
  readonly status:
    | "mismatch"
    | "timed_out"
    | "failed"
    | "cancelled"
    | "cleanup_failed";
  readonly cleanup: "succeeded" | "failed" | "unconfirmed";
  readonly approvedCounts?: Readonly<Record<string, string>>;
  readonly approvedImplementationHashes?: readonly string[];
}
export function projectReproductionPublicSummary(
  bundle: ReproductionBundle,
  approved?: {
    readonly counts?: Readonly<Record<string, string>>;
    readonly implementationHashes?: readonly string[];
  },
): ReproductionPublicSummary {
  let counts: Readonly<Record<string, string>> | undefined;
  if (approved?.counts) {
    const entries = Object.entries(approved.counts);
    if (
      entries.length > 256 ||
      entries.some(
        ([key, value]) =>
          !STABLE_ID.test(key) || !/^(0|[1-9][0-9]*)$/.test(value),
      )
    )
      throw new ReproductionBundleError(
        "public_projection_invalid",
        "approved counts invalid",
      );
    counts = Object.freeze(Object.fromEntries(entries));
  }
  let hashes: readonly string[] | undefined;
  if (approved?.implementationHashes) {
    if (
      approved.implementationHashes.length > 64 ||
      new Set(approved.implementationHashes).size !==
        approved.implementationHashes.length ||
      approved.implementationHashes.some((value) => !SHA256.test(value))
    )
      throw new ReproductionBundleError(
        "public_projection_invalid",
        "approved hashes invalid",
      );
    hashes = Object.freeze([...approved.implementationHashes]);
  }
  const primary = bundle.signature.primary,
    status =
      primary?.kind === "behavioral_mismatch"
        ? "mismatch"
        : primary?.kind === "timeout"
          ? "timed_out"
          : primary?.kind === "cancellation"
            ? "cancelled"
            : primary === null
              ? "cleanup_failed"
              : "failed";
  const summary: ReproductionPublicSummary = cloneFreeze({
    schema: "mirrorecma.reproduction-public-summary/v1" as const,
    runRef: bundle.evidenceLinks.runRef,
    status,
    cleanup: bundle.signature.cleanup.status,
    ...(counts ? { approvedCounts: counts } : {}),
    ...(hashes ? { approvedImplementationHashes: hashes } : {}),
  });
  if (JSON.stringify(summary).includes("MIRRORS_PRIVATE_CANARY_"))
    throw new ReproductionBundleError(
      "public_projection_private_data",
      "private canary reached public summary",
    );
  return summary;
}
