import { createHash } from "node:crypto";

type JsonObject = Record<string, unknown>;
export type FrameworkJsonInput = string | Uint8Array;
const MAX_BYTES = 4 * 1024 * 1024,
  MAX_DEPTH = 32,
  MAX_NODES = 65_536;
const SHA256 = /^[0-9a-f]{64}$/,
  REVISION = /^[0-9a-f]{40}$/;
const observationDimensions = [
  "sourceTested",
  "locallyAccepted",
  "installedConsumerAccepted",
  "hostedCiAccepted",
  "published",
] as const;

export type CatalogSelectionRef = Readonly<{
  schemaVersion: "mirrors.framework-catalog/v1";
  selectionKind: "sha256";
  selectionValue: string;
}>;
export type ComponentRef = Readonly<{
  componentId: string;
  repository: string;
  revision: string;
  dirty: boolean;
  dirtyContent?: Readonly<{
    algorithm: "sha256";
    digest: string;
    method: "git-diff-and-untracked-manifest-v1" | "filesystem-tree-v1";
    includedPaths: readonly string[];
    excludedPaths: readonly Readonly<{
      path: string;
      reasonCode: "pre-existing-unrelated" | "evidence-output" | "build-output";
    }>[];
  }>;
}>;
export type PlatformIdentity = Readonly<{
  os: string;
  osRelease: string;
  architecture: string;
  backend?: string;
}>;
export type ArtifactIdentity = Readonly<{
  artifactId: string;
  path: string;
  bytes: number;
  sha256: string;
  mode: "0644" | "0755";
}>;
export type RuntimeTreeIdentity = Readonly<{
  treeId: string;
  sourceArtifactId: string;
  selectionId: string;
  path: string;
  algorithm: "mirrors-runtime-tree-v1";
  digest: string;
  entryCount: number;
  bytes: number;
}>;
export type BuildInputIdentity = Readonly<{
  inputId: "profiles-lock" | "component-lock" | "dependency-lock";
  path: string;
  bytes: number;
  sha256: string;
}>;
export type BuildProvenance = Readonly<{
  snapshotIndexSha256: string;
  tools: readonly Readonly<{
    toolId: string;
    version: string;
    bytes: number;
    sha256: string;
  }>[];
  trees: readonly Readonly<{
    inputId: string;
    algorithm: "mirrors-runtime-tree-v1";
    digest: string;
    entryCount: number;
    bytes: number;
  }>[];
}>;
export type PackageObservation = Readonly<{
  packageId: string;
  componentId: string;
  artifactId: string;
  version: string;
  sha256: string;
}>;
export type ExecutableObservation = Readonly<{
  role: string;
  artifactId: string;
  sha256: string;
  capabilityIds: readonly string[];
}>;

export interface RuntimeSupportPolicy {
  /**
   * support-required admits only an already supported catalog combination.
   * qualification-candidate admits exact candidate inputs for I4 measurement,
   * but the result remains explicitly unqualified.
   */
  readonly admission: "support-required" | "qualification-candidate";
  readonly manifestProfileId: string;
  readonly catalogProfileId: string;
  readonly packages: readonly Readonly<{
    packageId: string;
    componentId: string;
    artifactId: string;
  }>[];
  readonly executables: readonly Readonly<{
    role: string;
    artifactId: string;
    requiredCapabilityIds: readonly string[];
  }>[];
  readonly runtimeTrees: readonly Readonly<{
    runtimeId: string;
    treeId: string;
    requiredCapabilityIds: readonly string[];
  }>[];
}
export interface InstalledFrameworkObservation {
  readonly distributionManifestRaw: FrameworkJsonInput;
  readonly cacheIndexRaw: FrameworkJsonInput;
  readonly componentRefs: readonly ComponentRef[];
  readonly packages: readonly PackageObservation[];
  readonly executables: readonly ExecutableObservation[];
  readonly runtimeTrees: readonly RuntimeTreeIdentity[];
  readonly platform: PlatformIdentity;
  readonly policy: RuntimeSupportPolicy;
}
export interface FrameworkPreflightInput {
  /**
   * Immutable catalog A selected before build/execution. A later approval
   * catalog B may cite A plus retained evidence, but never replaces this value
   * or forces rebuilding the A-bound distribution.
   */
  readonly selectionRef: CatalogSelectionRef;
  readonly combinationId: string;
  readonly observed: InstalledFrameworkObservation;
  /** Trusted E4 decision over later catalog B; never substitutes for A. */
  readonly approval?: FrameworkApprovalDecision;
}
export interface FrameworkApprovalDecision {
  readonly schemaVersion: "mirrors.evidence-catalog-link/v1";
  readonly qualificationClass: "local-candidate" | "release-candidate";
  readonly selectedCatalogRef: CatalogSelectionRef;
  readonly approvalCatalogRef: CatalogSelectionRef;
  readonly combinationId: string;
  readonly distributionManifestSha256: string;
  readonly cacheIndexSha256: string;
  readonly publicRunRef: Readonly<{
    schemaVersion: "mirrors.evidence-public-summary/v1.0";
    runId: string;
    envelopeSha256: string;
    projectionKind: "public";
  }>;
  readonly qualification: "accepted";
  readonly integrity: "verified";
  readonly executionProvenance: "evidence-observed";
}
export type FrameworkRefusalCode =
  | "catalog_invalid"
  | "catalog_selection_mismatch"
  | "combination_unsupported"
  | "component_identity_mismatch"
  | "distribution_identity_mismatch"
  | "artifact_identity_mismatch"
  | "package_identity_mismatch"
  | "executable_identity_mismatch"
  | "runtime_identity_mismatch"
  | "platform_identity_mismatch"
  | "capability_unsupported";
export type FrameworkPreflightResult =
  | Readonly<{
      status: "matched";
      admission: "support-required" | "qualification-candidate";
      catalogState: "candidate" | "supported";
      supportQualified: boolean;
      approvalCatalogRef?: CatalogSelectionRef;
      approvalPublicRunRef?: FrameworkApprovalDecision["publicRunRef"];
      catalogSelectionRef: CatalogSelectionRef;
      combinationId: string;
      componentRefs: readonly ComponentRef[];
      profileIds: readonly string[];
      platform: PlatformIdentity;
      capabilityIds: readonly string[];
      distributionManifestSha256: string;
      buildInputs: readonly BuildInputIdentity[];
      buildProvenance: BuildProvenance;
      packages: readonly PackageObservation[];
      executables: readonly ExecutableObservation[];
      runtimeTrees: readonly RuntimeTreeIdentity[];
    }>
  | Readonly<{
      status: "refused";
      refusal: Readonly<{
        code: FrameworkRefusalCode;
        predicate: string;
        detail: string;
      }>;
    }>;

export class FrameworkCatalogError extends Error {
  constructor(
    readonly code: FrameworkRefusalCode,
    readonly predicate: string,
    message: string,
  ) {
    super(message);
    this.name = "FrameworkCatalogError";
  }
}
const refuse = (
  code: FrameworkRefusalCode,
  predicate: string,
  detail: string,
): never => {
  throw new FrameworkCatalogError(code, predicate, detail);
};

function scalarString(value: string, path: string): string {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff))
        return refuse(
          "catalog_invalid",
          path,
          "lone Unicode surrogate is forbidden",
        );
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff)
      return refuse(
        "catalog_invalid",
        path,
        "lone Unicode surrogate is forbidden",
      );
  }
  return value;
}

/** Duplicate-aware bounded JSON parse. Inputs remain inert data. */
function strictJson(input: FrameworkJsonInput, label: string): unknown {
  let raw: string;
  try {
    raw =
      typeof input === "string"
        ? scalarString(input, label)
        : new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    return refuse("catalog_invalid", label, "invalid UTF-8 input");
  }
  if (Buffer.byteLength(raw) > MAX_BYTES)
    refuse("catalog_invalid", label, `${label} exceeds 4 MiB`);
  let i = 0,
    nodes = 0;
  const ws = () => {
    while (/[\x20\x09\x0a\x0d]/.test(raw[i] ?? "")) i++;
  };
  const stringToken = (): string => {
    if (raw[i] !== '"')
      refuse("catalog_invalid", label, "expected JSON string");
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
        const value = scalarString(
          JSON.parse(raw.slice(start, i)) as string,
          label,
        );
        if (Buffer.byteLength(value) > 65_536)
          refuse("catalog_invalid", label, "string exceeds 65536 bytes");
        return value;
      }
      if (c < " ")
        refuse("catalog_invalid", label, "control character in string");
    }
    return refuse("catalog_invalid", label, "unterminated string");
  };
  const value = (depth: number): void => {
    if (depth > MAX_DEPTH || ++nodes > MAX_NODES)
      refuse("catalog_invalid", label, "JSON structure exceeds limits");
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
        if (keys.has(key))
          refuse("catalog_invalid", label, `duplicate key ${key}`);
        keys.add(key);
        if (++count > 4096)
          refuse("catalog_invalid", label, "object exceeds member limit");
        ws();
        if (raw[i++] !== ":") refuse("catalog_invalid", label, "missing colon");
        value(depth + 1);
        ws();
        if (raw[i] === "}") {
          i++;
          return;
        }
        if (raw[i++] !== ",") refuse("catalog_invalid", label, "missing comma");
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
          refuse("catalog_invalid", label, "array exceeds element limit");
        value(depth + 1);
        ws();
        if (raw[i] === "]") {
          i++;
          return;
        }
        if (raw[i++] !== ",") refuse("catalog_invalid", label, "missing comma");
        ws();
      }
    } else if (c === '"') stringToken();
    else {
      const match =
        /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(
          raw.slice(i),
        );
      if (match === null)
        return refuse("catalog_invalid", label, "invalid JSON value");
      i += match[0].length;
    }
  };
  value(0);
  ws();
  if (i !== raw.length)
    refuse("catalog_invalid", label, "trailing JSON content");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return refuse("catalog_invalid", label, "invalid JSON");
  }
  const stack = [parsed];
  let checked = 0;
  while (stack.length) {
    const item = stack.pop();
    if (++checked > MAX_NODES)
      refuse("catalog_invalid", label, "JSON node limit exceeded");
    if (typeof item === "number" && !Number.isSafeInteger(item))
      refuse("catalog_invalid", label, "numbers must be safe integers");
    if (item && typeof item === "object")
      stack.push(
        ...(Array.isArray(item) ? item : Object.values(item as JsonObject)),
      );
  }
  return parsed;
}
const jsonInputBytes = (input: FrameworkJsonInput): Uint8Array =>
  typeof input === "string" ? Buffer.from(input, "utf8") : input;
const object = (
  value: unknown,
  path: string,
  keys: readonly string[],
  required: readonly string[] = keys,
): JsonObject => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    refuse("catalog_invalid", path, "object expected");
  const result = value as JsonObject;
  if (
    Object.keys(result).some((key) => !keys.includes(key)) ||
    required.some((key) => !Object.hasOwn(result, key))
  )
    refuse("catalog_invalid", path, "missing or unknown field");
  return result;
};
const text = (value: unknown, path: string): string => {
  if (
    typeof value !== "string" ||
    !value ||
    Buffer.byteLength(value) > 65_536 ||
    value.includes("\0")
  )
    return refuse("catalog_invalid", path, "nonempty bounded string expected");
  return scalarString(value, path);
};
const id = (value: unknown, path: string): string => {
  const result = text(value, path);
  if (Buffer.byteLength(result) > 256)
    return refuse("catalog_invalid", path, "identifier exceeds 256 bytes");
  return result;
};
const array = (value: unknown, path: string, max = 4096): unknown[] => {
  if (!Array.isArray(value) || value.length > max)
    return refuse("catalog_invalid", path, "bounded array expected");
  return value;
};
const strings = (value: unknown, path: string, max = 256): string[] => {
  const result = array(value, path, max).map((item, index) =>
    id(item, `${path}[${index}]`),
  );
  if (new Set(result).size !== result.length)
    refuse("catalog_invalid", path, "duplicate identity");
  return result;
};
const integer = (
  value: unknown,
  path: string,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number => {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  )
    return refuse(
      "distribution_identity_mismatch",
      path,
      "bounded integer expected",
    );
  return value as number;
};
const digest = (value: unknown, path: string): string => {
  const result = text(value, path);
  if (!SHA256.test(result))
    return refuse("catalog_invalid", path, "lowercase SHA-256 expected");
  return result;
};
const pathValue = (value: unknown, path: string): string => {
  const result = text(value, path),
    parts = result.split("/");
  if (
    result.startsWith("/") ||
    /^[A-Za-z]:/.test(result) ||
    result.includes("\\") ||
    result.includes("//") ||
    /[\x00-\x1f\x7f]/.test(result) ||
    parts.some((part) => !part || part === "." || part === "..")
  )
    return refuse("catalog_invalid", path, "normalized logical path expected");
  return result;
};
function immutable<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(immutable)) as T;
  if (value && typeof value === "object")
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value as JsonObject).map(([key, item]) => [
          key,
          immutable(item),
        ]),
      ),
    ) as T;
  return value;
}

function canonicalString(value: string): string {
  scalarString(value, "canonical string");
  let result = '"';
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code === 0x22) result += '\\"';
    else if (code === 0x5c) result += "\\\\";
    else if (code < 0x20) result += `\\u${code.toString(16).padStart(4, "0")}`;
    else result += character;
  }
  return result + '"';
}
/** Exact mirrors-framework-canonical-json/v1 renderer. */
export function canonicalFrameworkJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return canonicalString(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value))
      return refuse("catalog_invalid", "canonical", "safe integer expected");
    return Object.is(value, -0) ? "0" : String(value);
  }
  if (Array.isArray(value))
    return `[${value.map(canonicalFrameworkJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value as JsonObject)
      .sort((left, right) =>
        Buffer.compare(Buffer.from(left), Buffer.from(right)),
      )
      .map(
        (key) =>
          `${canonicalString(key)}:${canonicalFrameworkJson((value as JsonObject)[key])}`,
      )
      .join(",")}}`;
  return refuse(
    "catalog_invalid",
    "canonical",
    `unsupported value type ${typeof value}`,
  );
}
export const frameworkCatalogDigest = (value: unknown): string =>
  createHash("sha256").update(canonicalFrameworkJson(value)).digest("hex");

function selection(value: unknown, path: string): CatalogSelectionRef {
  const item = object(value, path, [
    "schemaVersion",
    "selectionKind",
    "selectionValue",
  ]);
  if (
    item.schemaVersion !== "mirrors.framework-catalog/v1" ||
    item.selectionKind !== "sha256"
  )
    refuse("catalog_invalid", path, "unsupported catalog selection");
  return immutable({
    schemaVersion: item.schemaVersion,
    selectionKind: item.selectionKind,
    selectionValue: digest(item.selectionValue, `${path}.selectionValue`),
  } as CatalogSelectionRef);
}
function componentRef(value: unknown, path: string): ComponentRef {
  const item = object(
    value,
    path,
    ["componentId", "repository", "revision", "dirty", "dirtyContent"],
    ["componentId", "repository", "revision", "dirty"],
  );
  const revision = text(item.revision, `${path}.revision`);
  if (!REVISION.test(revision))
    refuse(
      "catalog_invalid",
      `${path}.revision`,
      "full lowercase Git revision expected",
    );
  if (typeof item.dirty !== "boolean")
    refuse("catalog_invalid", `${path}.dirty`, "Boolean expected");
  const isDirty = item.dirty as boolean;
  let dirtyContent: ComponentRef["dirtyContent"];
  if (isDirty) {
    const dirty = object(item.dirtyContent, `${path}.dirtyContent`, [
      "algorithm",
      "digest",
      "method",
      "includedPaths",
      "excludedPaths",
    ]);
    if (
      dirty.algorithm !== "sha256" ||
      !(
        [
          "git-diff-and-untracked-manifest-v1",
          "filesystem-tree-v1",
        ] as unknown[]
      ).includes(dirty.method)
    )
      refuse(
        "catalog_invalid",
        `${path}.dirtyContent`,
        "unsupported dirty identity",
      );
    const included = strings(
      dirty.includedPaths,
      `${path}.dirtyContent.includedPaths`,
      4096,
    ).map((entry, index) =>
      pathValue(entry, `${path}.dirtyContent.includedPaths[${index}]`),
    );
    const excluded = array(
      dirty.excludedPaths,
      `${path}.dirtyContent.excludedPaths`,
      4096,
    ).map((entry, index) => {
      const record = object(
        entry,
        `${path}.dirtyContent.excludedPaths[${index}]`,
        ["path", "reasonCode"],
      );
      if (
        !(
          [
            "pre-existing-unrelated",
            "evidence-output",
            "build-output",
          ] as unknown[]
        ).includes(record.reasonCode)
      )
        refuse(
          "catalog_invalid",
          `${path}.dirtyContent.excludedPaths[${index}].reasonCode`,
          `unsupported exclusion reason`,
        );
      return {
        path: pathValue(
          record.path,
          `${path}.dirtyContent.excludedPaths[${index}].path`,
        ),
        reasonCode: record.reasonCode as
          | "pre-existing-unrelated"
          | "evidence-output"
          | "build-output",
      };
    });
    dirtyContent = immutable({
      algorithm: "sha256" as const,
      digest: digest(dirty.digest, `${path}.dirtyContent.digest`),
      method: dirty.method as
        | "git-diff-and-untracked-manifest-v1"
        | "filesystem-tree-v1",
      includedPaths: included,
      excludedPaths: excluded,
    });
  } else if (item.dirtyContent !== undefined)
    refuse(
      "catalog_invalid",
      `${path}.dirtyContent`,
      "clean component cannot carry dirty identity",
    );
  return immutable({
    componentId: id(item.componentId, `${path}.componentId`),
    repository: text(item.repository, `${path}.repository`),
    revision,
    dirty: isDirty,
    ...(dirtyContent ? { dirtyContent } : {}),
  });
}
function platform(value: unknown, path: string): PlatformIdentity {
  const item = object(
    value,
    path,
    ["os", "osRelease", "architecture", "backend"],
    ["os", "osRelease", "architecture"],
  );
  return immutable({
    os: id(item.os, `${path}.os`),
    osRelease: id(item.osRelease, `${path}.osRelease`),
    architecture: id(item.architecture, `${path}.architecture`),
    ...(item.backend === undefined
      ? {}
      : { backend: id(item.backend, `${path}.backend`) }),
  });
}

interface Catalog {
  schemaVersion: string;
  catalogId: string;
  visibility: string;
  components: readonly Readonly<{
    componentRef: ComponentRef;
    product: Readonly<{ name: string; version: string }>;
  }>[];
  capabilities: readonly Readonly<{
    capabilityId: string;
    ownerComponentId: string;
    declarationState: string;
    constraints: readonly Readonly<{
      constraintId: string;
      factKind: string;
      factId: string;
      operator: string;
      values: readonly string[];
    }>[];
    observations: Readonly<
      Record<string, Readonly<{ state: string; evidenceId?: string }>>
    >;
  }>[];
  distributionProfiles: readonly Readonly<{
    profileId: string;
    platform: PlatformIdentity;
    requiredCapabilityIds: readonly string[];
    optionalCapabilityIds: readonly string[];
    requiredObservationDimensions: readonly string[];
    dependencies: readonly Readonly<{
      dependencyId: string;
      version?: string;
      className: string;
    }>[];
  }>[];
  combinations: readonly Readonly<{
    combinationId: string;
    componentIds: readonly string[];
    platform: PlatformIdentity;
    capabilityIds: readonly string[];
    distributionProfileIds: readonly string[];
    declaredState: string;
  }>[];
  raw: unknown;
}
function parseCatalog(raw: FrameworkJsonInput): Catalog {
  const parsed = strictJson(raw, "catalog"),
    root = object(
      parsed,
      "$",
      [
        "schemaVersion",
        "catalogId",
        "visibility",
        "components",
        "evidenceRefs",
        "capabilities",
        "distributionProfiles",
        "combinations",
        "extensions",
      ],
      [
        "schemaVersion",
        "catalogId",
        "visibility",
        "components",
        "evidenceRefs",
        "capabilities",
        "distributionProfiles",
        "combinations",
      ],
    );
  if (root.schemaVersion !== "mirrors.framework-catalog/v1")
    refuse("catalog_invalid", "$.schemaVersion", "unsupported catalog schema");
  if (!(["public", "private"] as unknown[]).includes(root.visibility))
    refuse("catalog_invalid", "$.visibility", "unsupported visibility");
  const components = array(root.components, "$.components", 64).map(
    (entry, index) => {
      const item = object(entry, `$.components[${index}]`, [
          "componentRef",
          "product",
          "records",
        ]),
        product = object(item.product, `$.components[${index}].product`, [
          "name",
          "version",
        ]);
      array(item.records, `$.components[${index}].records`, 256).forEach(
        (record, index2) => {
          const r = object(
            record,
            `$.components[${index}].records[${index2}]`,
            ["recordId", "path", "recordKind"],
          );
          id(r.recordId, "recordId");
          pathValue(r.path, "path");
          id(r.recordKind, "recordKind");
        },
      );
      return immutable({
        componentRef: componentRef(
          item.componentRef,
          `$.components[${index}].componentRef`,
        ),
        product: {
          name: text(product.name, "product.name"),
          version: text(product.version, "product.version"),
        },
      });
    },
  );
  const evidenceIds = new Set<string>();
  array(root.evidenceRefs, "$.evidenceRefs", 4096).forEach((entry, index) => {
    const item = object(entry, `$.evidenceRefs[${index}]`, [
        "evidenceId",
        "runRef",
      ]),
      evidenceId = id(item.evidenceId, "evidenceId");
    if (evidenceIds.has(evidenceId))
      refuse("catalog_invalid", "$.evidenceRefs", "duplicate evidenceId");
    evidenceIds.add(evidenceId);
    const ref = object(item.runRef, "runRef", [
      "schemaVersion",
      "runId",
      "envelopeSha256",
      "projectionKind",
    ]);
    text(ref.schemaVersion, "runRef.schemaVersion");
    id(ref.runId, "runRef.runId");
    digest(ref.envelopeSha256, "runRef.envelopeSha256");
    if (!(["public", "private"] as unknown[]).includes(ref.projectionKind))
      refuse(
        "catalog_invalid",
        "runRef.projectionKind",
        "unsupported projection",
      );
  });
  const capabilities = array(root.capabilities, "$.capabilities", 4096).map(
    (entry, index) => {
      const item = object(entry, `$.capabilities[${index}]`, [
          "capabilityId",
          "ownerComponentId",
          "description",
          "declaration",
          "sourceImplementation",
          "observations",
        ]),
        declaration = object(item.declaration, "declaration", [
          "state",
          "constraints",
        ]);
      const constraints = array(
        declaration.constraints,
        "constraints",
        256,
      ).map((constraint, index2) => {
        const c = object(constraint, `constraint[${index2}]`, [
            "constraintId",
            "fact",
            "operator",
            "values",
          ]),
          fact = object(c.fact, "fact", ["kind", "id"]);
        const operator = id(c.operator, "operator");
        if (!["equals", "oneOf", "atLeastSemver"].includes(operator))
          refuse(
            "catalog_invalid",
            "constraint.operator",
            "unsupported constraint operator",
          );
        return immutable({
          constraintId: id(c.constraintId, "constraintId"),
          factKind: id(fact.kind, "fact.kind"),
          factId: id(fact.id, "fact.id"),
          operator,
          values: strings(c.values, "values"),
        });
      });
      const source = object(item.sourceImplementation, "sourceImplementation", [
        "state",
        "locations",
      ]);
      id(source.state, "source.state");
      array(source.locations, "locations", 256).forEach((location, index2) => {
        const l = object(
          location,
          `location[${index2}]`,
          ["path", "symbol"],
          ["path"],
        );
        pathValue(l.path, "location.path");
        if (l.symbol !== undefined) text(l.symbol, "location.symbol");
      });
      const observations = object(
        item.observations,
        "observations",
        observationDimensions,
      );
      const decoded: Record<string, { state: string; evidenceId?: string }> =
        {};
      for (const dimension of observationDimensions) {
        const observed = object(
          observations[dimension],
          `observations.${dimension}`,
          ["state", "evidenceId"],
          ["state"],
        );
        const state = id(observed.state, `${dimension}.state`);
        if (
          ![
            "accepted",
            "rejected",
            "unavailable",
            "notRun",
            "unknown",
          ].includes(state)
        )
          refuse(
            "catalog_invalid",
            `observations.${dimension}.state`,
            "unsupported observation state",
          );
        const referencedEvidence =
          observed.evidenceId === undefined
            ? undefined
            : id(observed.evidenceId, `${dimension}.evidenceId`);
        if (
          (["accepted", "rejected"].includes(state) &&
            referencedEvidence === undefined) ||
          (["notRun", "unknown"].includes(state) &&
            referencedEvidence !== undefined) ||
          (referencedEvidence !== undefined &&
            !evidenceIds.has(referencedEvidence))
        )
          refuse(
            "catalog_invalid",
            `observations.${dimension}.evidenceId`,
            "observation evidence reference is invalid",
          );
        decoded[dimension] = {
          state,
          ...(referencedEvidence === undefined
            ? {}
            : { evidenceId: referencedEvidence }),
        };
      }
      const declarationState = id(declaration.state, "declaration.state");
      if (
        !["available", "experimental", "unavailable"].includes(declarationState)
      )
        refuse(
          "catalog_invalid",
          "declaration.state",
          "unsupported declaration state",
        );
      return immutable({
        capabilityId: id(item.capabilityId, "capabilityId"),
        ownerComponentId: id(item.ownerComponentId, "ownerComponentId"),
        declarationState,
        constraints,
        observations: decoded,
      });
    },
  );
  const distributionProfiles = array(
    root.distributionProfiles,
    "$.distributionProfiles",
    256,
  ).map((entry, index) => {
    const item = object(entry, `$.distributionProfiles[${index}]`, [
      "profileId",
      "platform",
      "requiredCapabilityIds",
      "optionalCapabilityIds",
      "requiredObservationDimensions",
      "dependencies",
    ]);
    const dependencies = array(item.dependencies, "dependencies", 256).map(
      (dependency) => {
        const d = object(
          dependency,
          "dependency",
          ["dependencyId", "version", "class"],
          ["dependencyId", "class"],
        );
        return immutable({
          dependencyId: id(d.dependencyId, "dependencyId"),
          className: id(d.class, "dependency.class"),
          ...(d.version === undefined
            ? {}
            : { version: text(d.version, "dependency.version") }),
        });
      },
    );
    return immutable({
      profileId: id(item.profileId, "profileId"),
      platform: platform(item.platform, "profile.platform"),
      requiredCapabilityIds: strings(
        item.requiredCapabilityIds,
        "requiredCapabilityIds",
      ),
      optionalCapabilityIds: strings(
        item.optionalCapabilityIds,
        "optionalCapabilityIds",
      ),
      requiredObservationDimensions: strings(
        item.requiredObservationDimensions,
        "requiredObservationDimensions",
      ),
      dependencies,
    });
  });
  const combinations = array(root.combinations, "$.combinations", 1024).map(
    (entry) => {
      const item = object(entry, "combination", [
        "combinationId",
        "componentIds",
        "platform",
        "capabilityIds",
        "distributionProfileIds",
        "declaredState",
        "evidenceIds",
      ]);
      strings(item.evidenceIds, "evidenceIds", 4096).forEach((evidenceId) => {
        if (!evidenceIds.has(evidenceId))
          refuse(
            "catalog_invalid",
            "combination.evidenceIds",
            `missing evidence ${evidenceId}`,
          );
      });
      const declaredState = id(item.declaredState, "declaredState");
      if (!["candidate", "supported", "unsupported"].includes(declaredState))
        refuse(
          "catalog_invalid",
          "combination.declaredState",
          "unsupported combination state",
        );
      return immutable({
        combinationId: id(item.combinationId, "combinationId"),
        componentIds: strings(item.componentIds, "componentIds"),
        platform: platform(item.platform, "combination.platform"),
        capabilityIds: strings(item.capabilityIds, "capabilityIds"),
        distributionProfileIds: strings(
          item.distributionProfileIds,
          "distributionProfileIds",
        ),
        declaredState,
      });
    },
  );
  const unique = (items: readonly string[], path: string) => {
    if (new Set(items).size !== items.length)
      refuse("catalog_invalid", path, "duplicate identity");
  };
  unique(
    components.map((item) => item.componentRef.componentId),
    "components",
  );
  unique(
    capabilities.map((item) => item.capabilityId),
    "capabilities",
  );
  unique(
    distributionProfiles.map((item) => item.profileId),
    "profiles",
  );
  unique(
    combinations.map((item) => item.combinationId),
    "combinations",
  );
  const componentIds = new Set(
      components.map((item) => item.componentRef.componentId),
    ),
    capabilityIds = new Set(capabilities.map((item) => item.capabilityId)),
    profileIds = new Set(distributionProfiles.map((item) => item.profileId));
  for (const capability of capabilities)
    if (!componentIds.has(capability.ownerComponentId))
      refuse(
        "catalog_invalid",
        "capability.ownerComponentId",
        "missing component",
      );
  for (const combination of combinations) {
    for (const item of combination.componentIds)
      if (!componentIds.has(item))
        refuse(
          "catalog_invalid",
          "combination.componentIds",
          "missing component",
        );
    for (const item of combination.capabilityIds)
      if (!capabilityIds.has(item))
        refuse(
          "catalog_invalid",
          "combination.capabilityIds",
          "missing capability",
        );
    for (const item of combination.distributionProfileIds)
      if (!profileIds.has(item))
        refuse(
          "catalog_invalid",
          "combination.distributionProfileIds",
          "missing profile",
        );
  }
  return immutable({
    schemaVersion: root.schemaVersion as string,
    catalogId: id(root.catalogId, "catalogId"),
    visibility: root.visibility as string,
    components,
    capabilities,
    distributionProfiles,
    combinations,
    raw: parsed,
  });
}

interface DistributionManifest {
  catalogSelectionRef: CatalogSelectionRef;
  profileId: string;
  componentRefs: readonly ComponentRef[];
  buildInputs: readonly BuildInputIdentity[];
  buildProvenance: BuildProvenance;
  artifacts: readonly Readonly<{
    artifactId: string;
    path: string;
    kind: string;
    mediaType: string;
    bytes: number;
    sha256: string;
    mode: "0644" | "0755";
    dynamicLibraries?: readonly Readonly<{
      soname: string;
      path: string;
      sha256: string;
    }>[];
  }>[];
  runtimeTrees: readonly RuntimeTreeIdentity[];
  hostRequirements: readonly unknown[];
  raw: unknown;
}
function parseManifest(raw: FrameworkJsonInput): DistributionManifest {
  const parsed = strictJson(raw, "distribution manifest"),
    root = object(parsed, "manifest", [
      "schemaVersion",
      "distributionId",
      "catalogSelectionRef",
      "profileId",
      "componentRefs",
      "buildInputs",
      "buildProvenance",
      "artifacts",
      "runtimeTrees",
      "hostRequirements",
      "publication",
    ]);
  if (
    root.schemaVersion !== "mirrors.reference-distribution-manifest/v1" ||
    root.publication !== "unclaimed"
  )
    refuse(
      "distribution_identity_mismatch",
      "manifest.schemaVersion",
      "unsupported distribution manifest",
    );
  id(root.distributionId, "distributionId");
  const buildInputs = array(root.buildInputs, "buildInputs", 3).map(
    (entry, index) => {
      const item = object(entry, `buildInputs[${index}]`, [
        "inputId",
        "path",
        "bytes",
        "sha256",
      ]);
      if (
        !["profiles-lock", "component-lock", "dependency-lock"].includes(
          item.inputId as string,
        )
      )
        refuse(
          "distribution_identity_mismatch",
          `buildInputs[${index}].inputId`,
          "unsupported build input",
        );
      return immutable({
        inputId: item.inputId as BuildInputIdentity["inputId"],
        path: pathValue(item.path, `buildInputs[${index}].path`),
        bytes: integer(item.bytes, `buildInputs[${index}].bytes`, 1, MAX_BYTES),
        sha256: digest(item.sha256, `buildInputs[${index}].sha256`),
      });
    },
  );
  const buildInputIds = buildInputs.map((item) => item.inputId);
  if (
    buildInputs.length !== 3 ||
    new Set(buildInputIds).size !== 3 ||
    !["profiles-lock", "component-lock", "dependency-lock"].every((item) =>
      buildInputIds.includes(item as BuildInputIdentity["inputId"]),
    )
  )
    refuse(
      "distribution_identity_mismatch",
      "buildInputs",
      "exact I2 lock input set required",
    );
  const provenance = object(root.buildProvenance, "buildProvenance", [
    "snapshotIndexSha256",
    "tools",
    "trees",
  ]);
  const buildProvenance: BuildProvenance = immutable({
    snapshotIndexSha256: digest(
      provenance.snapshotIndexSha256,
      "buildProvenance.snapshotIndexSha256",
    ),
    tools: array(provenance.tools, "buildProvenance.tools", 64).map(
      (entry, index) => {
        const tool = object(entry, `buildProvenance.tools[${index}]`, [
          "toolId",
          "version",
          "bytes",
          "sha256",
        ]);
        return immutable({
          toolId: id(tool.toolId, "buildProvenance.toolId"),
          version: text(tool.version, "buildProvenance.tool.version"),
          bytes: integer(tool.bytes, "buildProvenance.tool.bytes", 0),
          sha256: digest(tool.sha256, "buildProvenance.tool.sha256"),
        });
      },
    ),
    trees: array(provenance.trees, "buildProvenance.trees", 64).map(
      (entry, index) => {
        const tree = object(entry, `buildProvenance.trees[${index}]`, [
          "inputId",
          "algorithm",
          "digest",
          "entryCount",
          "bytes",
        ]);
        if (tree.algorithm !== "mirrors-runtime-tree-v1")
          refuse(
            "distribution_identity_mismatch",
            `buildProvenance.trees[${index}].algorithm`,
            "unsupported build provenance tree algorithm",
          );
        return immutable({
          inputId: id(tree.inputId, "buildProvenance.tree.inputId"),
          algorithm: "mirrors-runtime-tree-v1" as const,
          digest: digest(tree.digest, "buildProvenance.tree.digest"),
          entryCount: integer(
            tree.entryCount,
            "buildProvenance.tree.entryCount",
            0,
            100_000,
          ),
          bytes: integer(
            tree.bytes,
            "buildProvenance.tree.bytes",
            0,
            2_147_483_648,
          ),
        });
      },
    ),
  });
  const artifacts = array(root.artifacts, "artifacts", 1024).map(
    (entry, index) => {
      const artifactFields = [
        "artifactId",
        "path",
        "kind",
        "mediaType",
        "bytes",
        "sha256",
        "mode",
        "source",
      ];
      const item = object(
        entry,
        `artifacts[${index}]`,
        [...artifactFields, "dynamicLibraries"],
        artifactFields,
      );
      if (
        !(["file", "archive"] as unknown[]).includes(item.kind) ||
        !(["0644", "0755"] as unknown[]).includes(item.mode)
      )
        refuse(
          "distribution_identity_mismatch",
          `artifacts[${index}]`,
          `unsupported artifact shape`,
        );
      const source = object(item.source, "artifact.source", ["kind", "id"]);
      if (
        !(["component-build", "dependency-lock"] as unknown[]).includes(
          source.kind,
        )
      )
        refuse(
          "distribution_identity_mismatch",
          "artifact.source.kind",
          "unsupported source",
        );
      id(source.id, "source.id");
      const dynamicLibraries =
        item.dynamicLibraries === undefined
          ? undefined
          : array(
              item.dynamicLibraries,
              `artifacts[${index}].dynamicLibraries`,
              64,
            ).map((library, libraryIndex) => {
              const dynamic = object(
                library,
                `artifacts[${index}].dynamicLibraries[${libraryIndex}]`,
                ["soname", "path", "sha256"],
              );
              const hostPath = text(
                dynamic.path,
                `artifacts[${index}].dynamicLibraries[${libraryIndex}].path`,
              );
              if (!hostPath.startsWith("/"))
                refuse(
                  "distribution_identity_mismatch",
                  `artifacts[${index}].dynamicLibraries[${libraryIndex}].path`,
                  "dynamic library path must be absolute",
                );
              return immutable({
                soname: text(dynamic.soname, "dynamicLibrary.soname"),
                path: hostPath,
                sha256: digest(dynamic.sha256, "dynamicLibrary.sha256"),
              });
            });
      if (item.mode === "0755" && !dynamicLibraries?.length)
        refuse(
          "distribution_identity_mismatch",
          `artifacts[${index}].dynamicLibraries`,
          "executable artifact requires dynamic library identities",
        );
      return immutable({
        artifactId: id(item.artifactId, "artifactId"),
        path: pathValue(item.path, "artifact.path"),
        kind: item.kind as string,
        mediaType: text(item.mediaType, "artifact.mediaType"),
        bytes: integer(item.bytes, "artifact.bytes", 0, 536_870_912),
        sha256: digest(item.sha256, "artifact.sha256"),
        mode: item.mode as "0644" | "0755",
        ...(dynamicLibraries === undefined ? {} : { dynamicLibraries }),
      });
    },
  );
  const runtimeTrees = array(root.runtimeTrees, "runtimeTrees", 64).map(
    (entry, index) => {
      const item = object(entry, `runtimeTrees[${index}]`, [
        "treeId",
        "sourceArtifactId",
        "selectionId",
        "path",
        "algorithm",
        "digest",
        "entryCount",
        "bytes",
      ]);
      if (item.algorithm !== "mirrors-runtime-tree-v1")
        refuse(
          "runtime_identity_mismatch",
          `runtimeTrees[${index}].algorithm`,
          `unsupported runtime identity`,
        );
      return immutable({
        treeId: id(item.treeId, "treeId"),
        sourceArtifactId: id(item.sourceArtifactId, "sourceArtifactId"),
        selectionId: id(item.selectionId, "selectionId"),
        path: pathValue(item.path, "runtime.path"),
        algorithm: "mirrors-runtime-tree-v1" as const,
        digest: digest(item.digest, "runtime.digest"),
        entryCount: integer(item.entryCount, "entryCount", 1, 100_000),
        bytes: integer(item.bytes, "runtime.bytes", 1, 2_147_483_648),
      });
    },
  );
  array(root.hostRequirements, "hostRequirements", 64).forEach(
    (entry, index) => {
      const item = object(
        entry,
        `hostRequirements[${index}]`,
        ["id", "minimumVersion", "observedVersion", "requirement"],
        ["id"],
      );
      id(item.id, "host.id");
      if (
        item.minimumVersion === undefined &&
        item.observedVersion === undefined &&
        item.requirement === undefined
      )
        refuse(
          "distribution_identity_mismatch",
          `hostRequirements[${index}]`,
          "host requirement predicate is empty",
        );
      if (item.minimumVersion !== undefined)
        text(item.minimumVersion, "host.minimumVersion");
      if (item.observedVersion !== undefined)
        text(item.observedVersion, "host.observedVersion");
      if (item.requirement !== undefined)
        text(item.requirement, "host.requirement");
    },
  );
  return immutable({
    catalogSelectionRef: selection(
      root.catalogSelectionRef,
      "manifest.catalogSelectionRef",
    ),
    profileId: id(root.profileId, "manifest.profileId"),
    componentRefs: array(root.componentRefs, "componentRefs", 64).map(
      (entry, index) => componentRef(entry, `componentRefs[${index}]`),
    ),
    buildInputs,
    buildProvenance,
    artifacts,
    runtimeTrees,
    hostRequirements: root.hostRequirements as unknown[],
    raw: parsed,
  });
}
function parseCache(raw: FrameworkJsonInput): Readonly<{
  profileId: string;
  catalogSelectionRef: CatalogSelectionRef;
  distributionManifestSha256: string;
  entries: readonly ArtifactIdentity[];
}> {
  const parsed = strictJson(raw, "cache index"),
    root = object(parsed, "cache", [
      "schemaVersion",
      "profileId",
      "catalogSelectionRef",
      "distributionManifestSha256",
      "entries",
    ]);
  if (root.schemaVersion !== "mirrors.reference-cache-index/v1")
    refuse(
      "distribution_identity_mismatch",
      "cache.schemaVersion",
      "unsupported cache index",
    );
  const entries = array(root.entries, "cache.entries", 2048).map(
    (entry, index) => {
      const item = object(entry, `entries[${index}]`, [
        "artifactId",
        "path",
        "bytes",
        "sha256",
        "mode",
      ]);
      if (!(["0644", "0755"] as unknown[]).includes(item.mode))
        refuse(
          "artifact_identity_mismatch",
          `entries[${index}].mode`,
          `unsupported mode`,
        );
      return immutable({
        artifactId: id(item.artifactId, "artifactId"),
        path: pathValue(item.path, "entry.path"),
        bytes: integer(item.bytes, "entry.bytes", 0, 536_870_912),
        sha256: digest(item.sha256, "entry.sha256"),
        mode: item.mode as "0644" | "0755",
      });
    },
  );
  return immutable({
    profileId: id(root.profileId, "cache.profileId"),
    catalogSelectionRef: selection(
      root.catalogSelectionRef,
      "cache.catalogSelectionRef",
    ),
    distributionManifestSha256: digest(
      root.distributionManifestSha256,
      "cache.distributionManifestSha256",
    ),
    entries,
  });
}
const same = (left: unknown, right: unknown) =>
  canonicalFrameworkJson(left) === canonicalFrameworkJson(right);
const mapBy = <T>(
  items: readonly T[],
  key: (item: T) => string,
  path: string,
): Map<string, T> => {
  const result = new Map<string, T>();
  for (const item of items) {
    const id = key(item);
    if (result.has(id))
      refuse("distribution_identity_mismatch", path, `duplicate ${id}`);
    result.set(id, item);
  }
  return result;
};
const semver = (
  value: string,
): readonly [number, number, number] | undefined => {
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(
    value,
  );
  if (!match) return undefined;
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger)
    ? (parts as unknown as readonly [number, number, number])
    : undefined;
};
const semverAtLeast = (actual: string, minimum: string): boolean => {
  const left = semver(actual),
    right = semver(minimum);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index++) {
    if (left[index]! > right[index]!) return true;
    if (left[index]! < right[index]!) return false;
  }
  return true;
};

interface ValidatedDistribution {
  readonly manifest: DistributionManifest;
  readonly manifestDigest: string;
  readonly artifacts: ReadonlyMap<
    string,
    DistributionManifest["artifacts"][number]
  >;
}
function validatedDistribution(
  distributionManifestRaw: FrameworkJsonInput,
  cacheIndexRaw: FrameworkJsonInput,
): ValidatedDistribution {
  const manifest = parseManifest(distributionManifestRaw),
    cache = parseCache(cacheIndexRaw),
    manifestDigest = frameworkCatalogDigest(manifest.raw);
  if (
    !same(cache.catalogSelectionRef, manifest.catalogSelectionRef) ||
    cache.distributionManifestSha256 !== manifestDigest ||
    cache.profileId !== manifest.profileId
  )
    refuse(
      "distribution_identity_mismatch",
      "distribution.selection",
      "distribution/cache selection or manifest identity differs",
    );
  const artifacts = mapBy(
      manifest.artifacts,
      (item) => item.artifactId,
      "manifest.artifacts",
    ),
    cacheEntries = mapBy(
      cache.entries,
      (item) => item.artifactId,
      "cache.entries",
    );
  if (artifacts.size !== cacheEntries.size)
    refuse(
      "artifact_identity_mismatch",
      "cache.entries",
      "artifact set differs from manifest",
    );
  for (const [artifactId, artifact] of artifacts) {
    const observed = cacheEntries.get(artifactId);
    if (
      !observed ||
      !same(
        {
          artifactId: artifact.artifactId,
          path: artifact.path,
          bytes: artifact.bytes,
          sha256: artifact.sha256,
          mode: artifact.mode,
        },
        observed,
      )
    )
      refuse(
        "artifact_identity_mismatch",
        `artifact.${artifactId}`,
        "installed artifact identity differs",
      );
  }
  return { manifest, manifestDigest, artifacts };
}

export type InstalledDistributionValidationResult =
  | Readonly<{
      status: "matched";
      catalogSelectionRef: CatalogSelectionRef;
      profileId: string;
      distributionManifestSha256: string;
      componentRefs: readonly ComponentRef[];
      buildInputs: readonly BuildInputIdentity[];
      buildProvenance: BuildProvenance;
      artifacts: readonly ArtifactIdentity[];
      runtimeTrees: readonly RuntimeTreeIdentity[];
    }>
  | Readonly<{
      status: "refused";
      refusal: Readonly<{
        code: FrameworkRefusalCode;
        predicate: string;
        detail: string;
      }>;
    }>;

/** Validate frozen I2 manifest/cache bytes without resolving or executing paths. */
export function validateInstalledDistributionIdentity(
  distributionManifestRaw: FrameworkJsonInput,
  cacheIndexRaw: FrameworkJsonInput,
): InstalledDistributionValidationResult {
  try {
    const { manifest, manifestDigest } = validatedDistribution(
      distributionManifestRaw,
      cacheIndexRaw,
    );
    return immutable({
      status: "matched",
      catalogSelectionRef: manifest.catalogSelectionRef,
      profileId: manifest.profileId,
      distributionManifestSha256: manifestDigest,
      componentRefs: manifest.componentRefs,
      buildInputs: manifest.buildInputs,
      buildProvenance: manifest.buildProvenance,
      artifacts: manifest.artifacts.map(
        ({ artifactId, path, bytes, sha256, mode }) => ({
          artifactId,
          path,
          bytes,
          sha256,
          mode,
        }),
      ),
      runtimeTrees: manifest.runtimeTrees,
    });
  } catch (error) {
    if (error instanceof FrameworkCatalogError)
      return immutable({
        status: "refused",
        refusal: {
          code: error.code,
          predicate: error.predicate,
          detail: error.message,
        },
      });
    return immutable({
      status: "refused",
      refusal: {
        code: "distribution_identity_mismatch",
        predicate: "internal",
        detail: "installed distribution identity is malformed",
      },
    });
  }
}

export function preflightFrameworkSelection(
  catalogRaw: FrameworkJsonInput,
  input: FrameworkPreflightInput,
): FrameworkPreflightResult {
  try {
    const catalog = parseCatalog(catalogRaw),
      catalogDigest = frameworkCatalogDigest(catalog.raw);
    if (
      input.selectionRef.schemaVersion !== "mirrors.framework-catalog/v1" ||
      input.selectionRef.selectionKind !== "sha256" ||
      input.selectionRef.selectionValue !== catalogDigest
    )
      refuse(
        "catalog_selection_mismatch",
        "catalogSelectionRef",
        "selected catalog digest does not match bytes",
      );
    const found = catalog.combinations.find(
      (item) => item.combinationId === input.combinationId,
    );
    if (found === undefined)
      return refuse(
        "combination_unsupported",
        "combination.declaredState",
        "combination is absent or not supported",
      );
    const combination = found;
    const admission = input.observed.policy.admission;
    if (
      admission !== "support-required" &&
      admission !== "qualification-candidate"
    )
      refuse(
        "combination_unsupported",
        "policy.admission",
        "unsupported admission policy",
      );
    if (
      combination.declaredState === "unsupported" ||
      (admission === "support-required" &&
        combination.declaredState !== "supported" &&
        input.approval === undefined)
    )
      refuse(
        "combination_unsupported",
        "combination.declaredState",
        "combination is absent or not supported",
      );
    const {
      manifest,
      manifestDigest,
      artifacts: expectedArtifacts,
    } = validatedDistribution(
      input.observed.distributionManifestRaw,
      input.observed.cacheIndexRaw,
    );
    let approvedCandidate = false;
    if (input.approval !== undefined) {
      const approval = input.approval;
      const runRef = approval.publicRunRef;
      const valid =
        approval.schemaVersion === "mirrors.evidence-catalog-link/v1" &&
        ["local-candidate", "release-candidate"].includes(
          approval.qualificationClass,
        ) &&
        same(approval.selectedCatalogRef, input.selectionRef) &&
        approval.approvalCatalogRef.schemaVersion ===
          "mirrors.framework-catalog/v1" &&
        approval.approvalCatalogRef.selectionKind === "sha256" &&
        SHA256.test(approval.approvalCatalogRef.selectionValue) &&
        approval.approvalCatalogRef.selectionValue !==
          input.selectionRef.selectionValue &&
        approval.combinationId === combination.combinationId &&
        approval.distributionManifestSha256 === manifestDigest &&
        approval.cacheIndexSha256 ===
          createHash("sha256")
            .update(jsonInputBytes(input.observed.cacheIndexRaw))
            .digest("hex") &&
        approval.qualification === "accepted" &&
        approval.integrity === "verified" &&
        approval.executionProvenance === "evidence-observed" &&
        runRef.schemaVersion === "mirrors.evidence-public-summary/v1.0" &&
        runRef.projectionKind === "public" &&
        typeof runRef.runId === "string" &&
        !!runRef.runId &&
        SHA256.test(runRef.envelopeSha256);
      if (!valid)
        refuse(
          "combination_unsupported",
          "approval",
          "trusted approval B does not bind catalog A, combination, and distribution manifest",
        );
      approvedCandidate = combination.declaredState === "candidate";
    }
    if (
      admission === "support-required" &&
      combination.declaredState !== "supported" &&
      !approvedCandidate
    )
      refuse(
        "combination_unsupported",
        "approval",
        "candidate catalog A requires a trusted E4 approval B",
      );
    if (
      !same(manifest.catalogSelectionRef, input.selectionRef) ||
      manifest.profileId !== input.observed.policy.manifestProfileId
    )
      refuse(
        "distribution_identity_mismatch",
        "distribution.selection",
        "distribution/cache selection or manifest identity differs",
      );
    const components = new Map(
        catalog.components.map(
          (item) => [item.componentRef.componentId, item] as const,
        ),
      ),
      expectedComponents = combination.componentIds.map(
        (componentId) =>
          components.get(componentId)?.componentRef ??
          refuse(
            "catalog_invalid",
            "combination.componentIds",
            `missing component ${componentId}`,
          ),
      );
    if (
      !same(manifest.componentRefs, expectedComponents) ||
      !same(input.observed.componentRefs, expectedComponents)
    )
      refuse(
        "component_identity_mismatch",
        "componentRefs",
        "installed component identities differ from combination",
      );
    const profiles = new Map(
        catalog.distributionProfiles.map(
          (item) => [item.profileId, item] as const,
        ),
      ),
      profileFound = profiles.get(input.observed.policy.catalogProfileId);
    if (profileFound === undefined)
      return refuse(
        "platform_identity_mismatch",
        "platform",
        "installed platform/profile differs from combination",
      );
    const profile = profileFound;
    if (
      !combination.distributionProfileIds.includes(profile.profileId) ||
      !same(profile.platform, input.observed.platform)
    )
      refuse(
        "platform_identity_mismatch",
        "platform",
        "installed platform/profile differs from combination",
      );
    if (
      !combination.distributionProfileIds.includes(
        input.observed.policy.catalogProfileId,
      )
    )
      refuse(
        "distribution_identity_mismatch",
        "profileId",
        "support policy selects a different catalog profile",
      );
    const selectedCapabilities = new Set(combination.capabilityIds),
      capabilities = new Map(
        catalog.capabilities.map((item) => [item.capabilityId, item] as const),
      );
    const requireCaps = (values: readonly string[], predicate: string) => {
      for (const capabilityId of values)
        if (
          !selectedCapabilities.has(capabilityId) ||
          capabilities.get(capabilityId)?.declarationState === "unavailable"
        )
          refuse(
            "capability_unsupported",
            predicate,
            `unsupported capability ${capabilityId}`,
          );
    };
    requireCaps(profile.requiredCapabilityIds, "profile.requiredCapabilityIds");
    const componentVersions = new Map(
        catalog.components.map(
          (item) =>
            [item.componentRef.componentId, item.product.version] as const,
        ),
      ),
      dependencyVersions = new Map(
        profile.dependencies.map(
          (item) => [item.dependencyId, item.version] as const,
        ),
      );
    for (const capabilityId of profile.requiredCapabilityIds) {
      const capability = capabilities.get(capabilityId)!;
      for (const constraint of capability.constraints) {
        let actual: string | undefined;
        if (constraint.factKind === "platformField")
          actual =
            constraint.factId === "os"
              ? combination.platform.os
              : constraint.factId === "osRelease"
                ? combination.platform.osRelease
                : constraint.factId === "architecture"
                  ? combination.platform.architecture
                  : constraint.factId === "backend"
                    ? combination.platform.backend
                    : undefined;
        else if (constraint.factKind === "componentVersion")
          actual = componentVersions.get(constraint.factId);
        else if (constraint.factKind === "dependencyVersion")
          actual = dependencyVersions.get(constraint.factId);
        else if (constraint.factKind === "capabilitySelected")
          actual = selectedCapabilities.has(constraint.factId)
            ? "true"
            : "false";
        const satisfied =
          actual !== undefined &&
          (constraint.operator === "equals"
            ? constraint.values.length === 1 && constraint.values[0] === actual
            : constraint.operator === "oneOf"
              ? constraint.values.includes(actual)
              : constraint.operator === "atLeastSemver"
                ? constraint.values.length === 1 &&
                  semverAtLeast(actual, constraint.values[0]!)
                : false);
        if (!satisfied)
          refuse(
            "capability_unsupported",
            `capability.${capabilityId}.constraint.${constraint.constraintId}`,
            "catalog capability constraint is not satisfied",
          );
      }
      if (admission === "support-required" && !approvedCandidate) {
        for (const dimension of profile.requiredObservationDimensions) {
          const observation = capability.observations[dimension];
          if (
            observation?.state !== "accepted" ||
            observation.evidenceId === undefined
          )
            refuse(
              "capability_unsupported",
              `capability.${capabilityId}.observations.${dimension}`,
              "required capability observation is not accepted",
            );
        }
      }
    }
    const packages = mapBy(
      input.observed.packages,
      (item) => item.packageId,
      "installed.packages",
    );
    for (const requirement of input.observed.policy.packages) {
      const installed = packages.get(requirement.packageId),
        artifact = expectedArtifacts.get(requirement.artifactId),
        component = components.get(requirement.componentId);
      if (
        !installed ||
        !artifact ||
        !component ||
        installed.componentId !== requirement.componentId ||
        installed.artifactId !== requirement.artifactId ||
        installed.version !== component.product.version ||
        installed.sha256 !== artifact.sha256
      )
        refuse(
          "package_identity_mismatch",
          `package.${requirement.packageId}`,
          "installed package identity differs",
        );
    }
    if (packages.size !== input.observed.policy.packages.length)
      refuse(
        "package_identity_mismatch",
        "packages",
        "unexpected installed package identity",
      );
    const executables = mapBy(
      input.observed.executables,
      (item) => item.role,
      "installed.executables",
    );
    for (const requirement of input.observed.policy.executables) {
      const installed = executables.get(requirement.role),
        artifact = expectedArtifacts.get(requirement.artifactId);
      requireCaps(
        requirement.requiredCapabilityIds,
        `executable.${requirement.role}.capabilities`,
      );
      if (
        !installed ||
        !artifact ||
        installed.artifactId !== requirement.artifactId ||
        installed.sha256 !== artifact.sha256 ||
        !same(installed.capabilityIds, requirement.requiredCapabilityIds)
      )
        refuse(
          "executable_identity_mismatch",
          `executable.${requirement.role}`,
          "installed executable identity differs",
        );
    }
    if (executables.size !== input.observed.policy.executables.length)
      refuse(
        "executable_identity_mismatch",
        "executables",
        "unexpected installed executable identity",
      );
    const expectedTrees = mapBy(
        manifest.runtimeTrees,
        (item) => item.treeId,
        "manifest.runtimeTrees",
      ),
      installedTrees = mapBy(
        input.observed.runtimeTrees,
        (item) => item.treeId,
        "installed.runtimeTrees",
      );
    for (const tree of expectedTrees.values())
      if (!expectedArtifacts.has(tree.sourceArtifactId))
        refuse(
          "runtime_identity_mismatch",
          `runtime.${tree.treeId}.sourceArtifactId`,
          "runtime tree source artifact is absent",
        );
    for (const requirement of input.observed.policy.runtimeTrees) {
      const expected = expectedTrees.get(requirement.treeId),
        installed = installedTrees.get(requirement.treeId);
      requireCaps(
        requirement.requiredCapabilityIds,
        `runtime.${requirement.runtimeId}.capabilities`,
      );
      if (!expected || !installed || !same(expected, installed))
        refuse(
          "runtime_identity_mismatch",
          `runtime.${requirement.runtimeId}`,
          "installed runtime tree differs",
        );
    }
    if (installedTrees.size !== input.observed.policy.runtimeTrees.length)
      refuse(
        "runtime_identity_mismatch",
        "runtimeTrees",
        "unexpected installed runtime tree",
      );
    return immutable({
      status: "matched",
      admission,
      catalogState: combination.declaredState as "candidate" | "supported",
      supportQualified:
        admission === "support-required" &&
        (combination.declaredState === "supported" || approvedCandidate),
      ...(input.approval === undefined
        ? {}
        : {
            approvalCatalogRef: input.approval.approvalCatalogRef,
            approvalPublicRunRef: input.approval.publicRunRef,
          }),
      catalogSelectionRef: input.selectionRef,
      combinationId: combination.combinationId,
      componentRefs: expectedComponents,
      profileIds: combination.distributionProfileIds,
      platform: combination.platform,
      capabilityIds: combination.capabilityIds,
      distributionManifestSha256: manifestDigest,
      buildInputs: manifest.buildInputs,
      buildProvenance: manifest.buildProvenance,
      packages: input.observed.packages,
      executables: input.observed.executables,
      runtimeTrees: input.observed.runtimeTrees,
    });
  } catch (error) {
    if (error instanceof FrameworkCatalogError)
      return immutable({
        status: "refused",
        refusal: {
          code: error.code,
          predicate: error.predicate,
          detail: error.message,
        },
      });
    return immutable({
      status: "refused",
      refusal: {
        code: "catalog_invalid",
        predicate: "internal",
        detail: "framework preflight rejected malformed input",
      },
    });
  }
}
