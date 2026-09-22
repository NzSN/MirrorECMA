import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  canonicalFrameworkJson,
  frameworkCatalogDigest,
  preflightFrameworkSelection,
  validateInstalledDistributionIdentity,
  type FrameworkJsonInput,
  type FrameworkPreflightInput,
} from "../src/framework-catalog.js";

const componentRef = {
  componentId: "mirrorecma",
  repository: "https://example.invalid/MirrorECMA.git",
  revision: "1".repeat(40),
  dirty: false,
};
const platform = {
  os: "linux",
  osRelease: "ubuntu-24.04",
  architecture: "x86_64",
  backend: "local-process",
};
const catalog = () => ({
  schemaVersion: "mirrors.framework-catalog/v1",
  catalogId: "fixture",
  visibility: "public",
  components: [
    {
      componentRef,
      product: { name: "mirrorecma", version: "2.0.0" },
      records: [
        { recordId: "package", path: "package.json", recordKind: "manifest" },
      ],
    },
  ],
  evidenceRefs: [
    {
      evidenceId: "fixture-evidence",
      runRef: {
        schemaVersion: "mirrors.evidence-public-summary/v1.0",
        runId: "fixture-run",
        envelopeSha256: "9".repeat(64),
        projectionKind: "public",
      },
    },
  ],
  capabilities: [
    {
      capabilityId: "cap.server",
      ownerComponentId: "mirrorecma",
      description: "fixture",
      declaration: {
        state: "available",
        constraints: [
          {
            constraintId: "node-runtime",
            fact: { kind: "dependencyVersion", id: "node" },
            operator: "equals",
            values: ["24.15.0"],
          },
        ],
      },
      sourceImplementation: {
        state: "present",
        locations: [{ path: "src/server.ts", symbol: "server" }],
      },
      observations: {
        sourceTested: { state: "unknown" },
        locallyAccepted: { state: "unknown" },
        installedConsumerAccepted: {
          state: "accepted",
          evidenceId: "fixture-evidence",
        },
        hostedCiAccepted: { state: "notRun" },
        published: { state: "unknown" },
      },
    },
  ],
  distributionProfiles: [
    {
      profileId: "catalog.local",
      platform,
      requiredCapabilityIds: ["cap.server"],
      optionalCapabilityIds: [],
      requiredObservationDimensions: ["installedConsumerAccepted"],
      dependencies: [
        {
          dependencyId: "node",
          version: "24.15.0",
          class: "content-addressed-runtime-tree",
        },
      ],
    },
  ],
  combinations: [
    {
      combinationId: "supported-local",
      componentIds: ["mirrorecma"],
      platform,
      capabilityIds: ["cap.server"],
      distributionProfileIds: ["catalog.local"],
      declaredState: "supported",
      evidenceIds: ["fixture-evidence"],
    },
  ],
});
const manifest = (selectionValue: string) => ({
  schemaVersion: "mirrors.reference-distribution-manifest/v1",
  distributionId: "fixture-distribution",
  catalogSelectionRef: {
    schemaVersion: "mirrors.framework-catalog/v1",
    selectionKind: "sha256",
    selectionValue,
  },
  profileId: "checked-replay-local",
  componentRefs: [componentRef],
  buildInputs: [
    {
      inputId: "profiles-lock",
      path: "distribution/reference-node/profiles.json",
      bytes: 1,
      sha256: "d".repeat(64),
    },
    {
      inputId: "component-lock",
      path: "distribution/reference-node/component-lock.json",
      bytes: 1,
      sha256: "e".repeat(64),
    },
    {
      inputId: "dependency-lock",
      path: "distribution/reference-node/dependency-lock.json",
      bytes: 1,
      sha256: "f".repeat(64),
    },
  ],
  buildProvenance: {
    snapshotIndexSha256: "3".repeat(64),
    tools: [
      {
        toolId: "lake",
        version: "5.0.0",
        bytes: 1,
        sha256: "4".repeat(64),
      },
    ],
    trees: [
      {
        inputId: "typescript-node-modules",
        algorithm: "mirrors-runtime-tree-v1",
        digest: "5".repeat(64),
        entryCount: 1,
        bytes: 1,
      },
    ],
  },
  artifacts: [
    {
      artifactId: "mirrorecma-package",
      path: "artifacts/packages/mirrorecma.tgz",
      kind: "archive",
      mediaType: "application/gzip",
      bytes: 10,
      sha256: "a".repeat(64),
      mode: "0644",
      source: { kind: "component-build", id: "mirrorecma-package" },
    },
    {
      artifactId: "mirror-server",
      path: "artifacts/bin/ModelMirrors",
      kind: "file",
      mediaType: "application/octet-stream",
      bytes: 20,
      sha256: "b".repeat(64),
      mode: "0755",
      source: { kind: "component-build", id: "mirror-server" },
      dynamicLibraries: [
        {
          soname: "libssl.so.3",
          path: "/usr/lib/x86_64-linux-gnu/libssl.so.3",
          sha256: "1".repeat(64),
        },
      ],
    },
    {
      artifactId: "node-runtime",
      path: "artifacts/runtimes/node.tar.xz",
      kind: "archive",
      mediaType: "application/x-xz",
      bytes: 30,
      sha256: "2".repeat(64),
      mode: "0644",
      source: { kind: "dependency-lock", id: "node-runtime" },
    },
  ],
  runtimeTrees: [
    {
      treeId: "node-runtime",
      sourceArtifactId: "node-runtime",
      selectionId: "node-linux-x64",
      path: "artifacts/runtimes/node",
      algorithm: "mirrors-runtime-tree-v1",
      digest: "c".repeat(64),
      entryCount: 2,
      bytes: 30,
    },
  ],
  hostRequirements: [],
  publication: "unclaimed",
});
function fixture(): { catalogRaw: string; input: FrameworkPreflightInput } {
  const selected = catalog(),
    selectionValue = frameworkCatalogDigest(selected),
    distribution = manifest(selectionValue);
  const distributionManifestRaw = JSON.stringify(distribution),
    distributionManifestSha256 = frameworkCatalogDigest(distribution);
  const cache = {
    schemaVersion: "mirrors.reference-cache-index/v1",
    profileId: "checked-replay-local",
    catalogSelectionRef: distribution.catalogSelectionRef,
    distributionManifestSha256,
    entries: distribution.artifacts.map(
      ({ artifactId, path, bytes, sha256, mode }) => ({
        artifactId,
        path,
        bytes,
        sha256,
        mode,
      }),
    ),
  };
  return {
    catalogRaw: JSON.stringify(selected),
    input: {
      selectionRef: distribution.catalogSelectionRef,
      combinationId: "supported-local",
      observed: {
        distributionManifestRaw,
        cacheIndexRaw: JSON.stringify(cache),
        componentRefs: [componentRef],
        packages: [
          {
            packageId: "mirrorecma",
            componentId: "mirrorecma",
            artifactId: "mirrorecma-package",
            version: "2.0.0",
            sha256: "a".repeat(64),
          },
        ],
        executables: [
          {
            role: "server",
            artifactId: "mirror-server",
            sha256: "b".repeat(64),
            capabilityIds: ["cap.server"],
          },
        ],
        runtimeTrees: distribution.runtimeTrees,
        platform,
        policy: {
          admission: "support-required",
          manifestProfileId: "checked-replay-local",
          catalogProfileId: "catalog.local",
          packages: [
            {
              packageId: "mirrorecma",
              componentId: "mirrorecma",
              artifactId: "mirrorecma-package",
            },
          ],
          executables: [
            {
              role: "server",
              artifactId: "mirror-server",
              requiredCapabilityIds: ["cap.server"],
            },
          ],
          runtimeTrees: [
            {
              runtimeId: "node",
              treeId: "node-runtime",
              requiredCapabilityIds: [],
            },
          ],
        },
      },
    },
  };
}
const mutateJson = (text: string, change: (value: any) => void) => {
  const value = JSON.parse(text);
  change(value);
  return JSON.stringify(value);
};

test("canonical catalog JSON matches the shared C3 vectors byte-for-byte", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL(
        "./fixtures/framework-catalog/canonicalization-vectors.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  for (const vector of fixture.vectors)
    expect(canonicalFrameworkJson(vector.value)).toBe(vector.canonical);
});
test("current sibling I2 local and Gate fixtures have exact profile component closures", async () => {
  const distributionRoot = new URL(
    "../../Mirrors/distribution/reference-node/fixtures/",
    import.meta.url,
  );
  for (const [profile, componentIds] of [
    ["checked-replay-local", ["mirrorecma", "mirrors"]],
    ["checked-replay-gate", ["mirrorecma", "mirrorgate", "mirrors"]],
  ] as const) {
    let manifestRaw: FrameworkJsonInput, cacheRaw: FrameworkJsonInput;
    try {
      [manifestRaw, cacheRaw] = await Promise.all([
        readFile(
          new URL(
            `distribution-manifest.${profile}.valid.json`,
            distributionRoot,
          ),
        ),
        readFile(
          new URL(`cache-index.${profile}.valid.json`, distributionRoot),
        ),
      ]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const result = validateInstalledDistributionIdentity(manifestRaw, cacheRaw);
    expect(result).toMatchObject({ status: "matched", profileId: profile });
    if (result.status === "matched") {
      expect(
        result.componentRefs.map((item) => item.componentId).sort(),
      ).toEqual(componentIds);
      expect(result.buildInputs.map((item) => item.inputId).sort()).toEqual([
        "component-lock",
        "dependency-lock",
        "profiles-lock",
      ]);
      expect(result.buildProvenance.snapshotIndexSha256).toMatch(
        /^[0-9a-f]{64}$/,
      );
      expect(result.buildProvenance.tools.length).toBeGreaterThan(0);
      expect(result.buildProvenance.trees.length).toBeGreaterThan(0);
      expect(
        result.runtimeTrees.every(
          (tree) => tree.sourceArtifactId && tree.selectionId,
        ),
      ).toBe(true);
    }
  }
});
test("supported exact installed combination returns an immutable selection without execution", () => {
  const { catalogRaw, input } = fixture(),
    result = preflightFrameworkSelection(catalogRaw, input);
  expect(result).toMatchObject({
    status: "matched",
    combinationId: "supported-local",
    profileIds: ["catalog.local"],
    capabilityIds: ["cap.server"],
  });
  expect(Object.isFrozen(result)).toBe(true);
  expect(
    Object.isFrozen(
      result.status === "matched" ? result.componentRefs : result.refusal,
    ),
  ).toBe(true);
});
test("candidate qualification admission is exact but remains explicitly unqualified", () => {
  const { catalogRaw, input } = fixture();
  const candidate = JSON.parse(catalogRaw);
  candidate.combinations[0].declaredState = "candidate";
  candidate.capabilities[0].observations.installedConsumerAccepted = {
    state: "unknown",
  };
  const candidateRaw = JSON.stringify(candidate),
    selectionValue = frameworkCatalogDigest(candidate),
    selectedRef = { ...input.selectionRef, selectionValue },
    manifestValue = JSON.parse(
      input.observed.distributionManifestRaw as string,
    );
  manifestValue.catalogSelectionRef = selectedRef;
  const distributionManifestRaw = JSON.stringify(manifestValue),
    cacheValue = JSON.parse(input.observed.cacheIndexRaw as string);
  cacheValue.catalogSelectionRef = selectedRef;
  cacheValue.distributionManifestSha256 = frameworkCatalogDigest(manifestValue);
  const candidateInput: FrameworkPreflightInput = {
    ...input,
    selectionRef: selectedRef,
    observed: {
      ...input.observed,
      distributionManifestRaw,
      cacheIndexRaw: JSON.stringify(cacheValue),
      policy: {
        ...input.observed.policy,
        admission: "qualification-candidate",
      },
    },
  };
  expect(
    preflightFrameworkSelection(candidateRaw, candidateInput),
  ).toMatchObject({
    status: "matched",
    admission: "qualification-candidate",
    catalogState: "candidate",
    supportQualified: false,
  });
  expect(
    preflightFrameworkSelection(candidateRaw, {
      ...candidateInput,
      observed: {
        ...candidateInput.observed,
        policy: {
          ...candidateInput.observed.policy,
          admission: "support-required",
        },
      },
    }),
  ).toMatchObject({
    status: "refused",
    refusal: { code: "combination_unsupported" },
  });
  const approval = {
    schemaVersion: "mirrors.evidence-catalog-link/v1" as const,
    qualificationClass: "release-candidate" as const,
    selectedCatalogRef: selectedRef,
    approvalCatalogRef: {
      schemaVersion: "mirrors.framework-catalog/v1" as const,
      selectionKind: "sha256" as const,
      selectionValue: "8".repeat(64),
    },
    combinationId: "supported-local",
    distributionManifestSha256: frameworkCatalogDigest(manifestValue),
    cacheIndexSha256: createHash("sha256")
      .update(candidateInput.observed.cacheIndexRaw as string)
      .digest("hex"),
    publicRunRef: {
      schemaVersion: "mirrors.evidence-public-summary/v1.0" as const,
      runId: "qualification-run",
      envelopeSha256: "7".repeat(64),
      projectionKind: "public" as const,
    },
    qualification: "accepted" as const,
    integrity: "verified" as const,
    executionProvenance: "evidence-observed" as const,
  };
  expect(
    preflightFrameworkSelection(candidateRaw, {
      ...candidateInput,
      approval,
      observed: {
        ...candidateInput.observed,
        policy: {
          ...candidateInput.observed.policy,
          admission: "support-required",
        },
      },
    }),
  ).toMatchObject({
    status: "matched",
    catalogState: "candidate",
    supportQualified: true,
    catalogSelectionRef: selectedRef,
    approvalCatalogRef: approval.approvalCatalogRef,
  });
  expect(
    preflightFrameworkSelection(candidateRaw, {
      ...candidateInput,
      approval: { ...approval, distributionManifestSha256: "0".repeat(64) },
      observed: {
        ...candidateInput.observed,
        policy: {
          ...candidateInput.observed.policy,
          admission: "support-required",
        },
      },
    }),
  ).toMatchObject({
    status: "refused",
    refusal: { code: "combination_unsupported", predicate: "approval" },
  });
});
test("Unicode scalars, UTF-8, key ordering and safe integers fail closed", () => {
  expect(canonicalFrameworkJson({ "😀": 2, "": 1 })).toBe('{"":1,"😀":2}');
  expect(canonicalFrameworkJson(Number.MAX_SAFE_INTEGER)).toBe(
    String(Number.MAX_SAFE_INTEGER),
  );
  expect(() => canonicalFrameworkJson(Number.MAX_SAFE_INTEGER + 1)).toThrow(
    /safe integer/,
  );
  expect(() => canonicalFrameworkJson("\ud800")).toThrow(
    /lone Unicode surrogate/,
  );
  const { input } = fixture();
  expect(preflightFrameworkSelection(Uint8Array.of(0xff), input)).toMatchObject(
    {
      status: "refused",
      refusal: { code: "catalog_invalid", predicate: "catalog" },
    },
  );
  expect(
    validateInstalledDistributionIdentity(
      Uint8Array.of(0xff),
      input.observed.cacheIndexRaw,
    ),
  ).toMatchObject({
    status: "refused",
    refusal: {
      code: "catalog_invalid",
      predicate: "distribution manifest",
    },
  });
});
test("unknown schema, duplicate keys and non-supported combinations fail closed", () => {
  const { catalogRaw, input } = fixture();
  expect(
    preflightFrameworkSelection(
      catalogRaw.replace(
        '"catalogId":"fixture"',
        '"catalogId":"fixture","catalogId":"again"',
      ),
      input,
    ),
  ).toMatchObject({ status: "refused", refusal: { code: "catalog_invalid" } });
  expect(
    preflightFrameworkSelection(
      catalogRaw.replace(
        "mirrors.framework-catalog/v1",
        "mirrors.framework-catalog/v2",
      ),
      input,
    ),
  ).toMatchObject({
    status: "refused",
    refusal: { code: "catalog_invalid", predicate: "$.schemaVersion" },
  });
  expect(
    preflightFrameworkSelection(
      mutateJson(catalogRaw, (value) => (value.components = {})),
      input,
    ),
  ).toMatchObject({
    status: "refused",
    refusal: { code: "catalog_invalid", predicate: "$.components" },
  });
  const candidateRaw = mutateJson(
    catalogRaw,
    (value) => (value.combinations[0].declaredState = "candidate"),
  );
  expect(
    preflightFrameworkSelection(candidateRaw, {
      ...input,
      selectionRef: {
        ...input.selectionRef,
        selectionValue: frameworkCatalogDigest(JSON.parse(candidateRaw)),
      },
    }),
  ).toMatchObject({
    status: "refused",
    refusal: {
      code: "combination_unsupported",
      predicate: "combination.declaredState",
    },
  });
});
test("catalog selection and full clean/dirty component identity are exact predicates", () => {
  const { catalogRaw, input } = fixture();
  expect(
    preflightFrameworkSelection(catalogRaw, {
      ...input,
      selectionRef: { ...input.selectionRef, selectionValue: "0".repeat(64) },
    }),
  ).toMatchObject({
    status: "refused",
    refusal: { code: "catalog_selection_mismatch" },
  });
  expect(
    preflightFrameworkSelection(catalogRaw, {
      ...input,
      observed: {
        ...input.observed,
        componentRefs: [{ ...componentRef, revision: "2".repeat(40) }],
      },
    }),
  ).toMatchObject({
    status: "refused",
    refusal: {
      code: "component_identity_mismatch",
      predicate: "componentRefs",
    },
  });
  expect(
    preflightFrameworkSelection(catalogRaw, {
      ...input,
      observed: {
        ...input.observed,
        componentRefs: [
          {
            ...componentRef,
            dirty: true,
            dirtyContent: {
              algorithm: "sha256",
              digest: "d".repeat(64),
              method: "git-diff-and-untracked-manifest-v1",
              includedPaths: [],
              excludedPaths: [],
            },
          },
        ],
      },
    }),
  ).toMatchObject({
    status: "refused",
    refusal: { code: "component_identity_mismatch" },
  });
});
test("manifest, cache and installed artifact identities stay distinct and exact", () => {
  const { catalogRaw, input } = fixture();
  const badCache = mutateJson(
    input.observed.cacheIndexRaw,
    (value) => (value.entries[0].sha256 = "0".repeat(64)),
  );
  expect(
    preflightFrameworkSelection(catalogRaw, {
      ...input,
      observed: { ...input.observed, cacheIndexRaw: badCache },
    }),
  ).toMatchObject({
    status: "refused",
    refusal: {
      code: "artifact_identity_mismatch",
      predicate: "artifact.mirrorecma-package",
    },
  });
  const badManifest = mutateJson(
    input.observed.distributionManifestRaw,
    (value) => (value.catalogSelectionRef.selectionValue = "0".repeat(64)),
  );
  expect(
    preflightFrameworkSelection(catalogRaw, {
      ...input,
      observed: { ...input.observed, distributionManifestRaw: badManifest },
    }),
  ).toMatchObject({
    status: "refused",
    refusal: { code: "distribution_identity_mismatch" },
  });
  const missingBuildInput = mutateJson(
    input.observed.distributionManifestRaw,
    (value) => value.buildInputs.pop(),
  );
  expect(
    preflightFrameworkSelection(catalogRaw, {
      ...input,
      observed: {
        ...input.observed,
        distributionManifestRaw: missingBuildInput,
      },
    }),
  ).toMatchObject({
    status: "refused",
    refusal: {
      code: "distribution_identity_mismatch",
      predicate: "buildInputs",
    },
  });
});
test.each([
  [
    "package",
    (input: FrameworkPreflightInput) => ({
      ...input,
      observed: {
        ...input.observed,
        packages: [{ ...input.observed.packages[0]!, version: "2.0.1" }],
      },
    }),
    "package_identity_mismatch",
    "package.mirrorecma",
  ],
  [
    "executable",
    (input: FrameworkPreflightInput) => ({
      ...input,
      observed: {
        ...input.observed,
        executables: [
          { ...input.observed.executables[0]!, sha256: "0".repeat(64) },
        ],
      },
    }),
    "executable_identity_mismatch",
    "executable.server",
  ],
  [
    "runtime",
    (input: FrameworkPreflightInput) => ({
      ...input,
      observed: {
        ...input.observed,
        runtimeTrees: [
          { ...input.observed.runtimeTrees[0]!, digest: "0".repeat(64) },
        ],
      },
    }),
    "runtime_identity_mismatch",
    "runtime.node",
  ],
  [
    "platform",
    (input: FrameworkPreflightInput) => ({
      ...input,
      observed: {
        ...input.observed,
        platform: { ...input.observed.platform, architecture: "aarch64" },
      },
    }),
    "platform_identity_mismatch",
    "platform",
  ],
] as const)(
  "%s identity mismatch names its failed predicate",
  (_name, change, code, predicate) => {
    const { catalogRaw, input } = fixture();
    expect(
      preflightFrameworkSelection(catalogRaw, change(input)),
    ).toMatchObject({ status: "refused", refusal: { code, predicate } });
  },
);
test("runtime support policy cannot claim an unselected capability", () => {
  const { catalogRaw, input } = fixture();
  const policy = {
    ...input.observed.policy,
    executables: [
      {
        ...input.observed.policy.executables[0]!,
        requiredCapabilityIds: ["cap.missing"],
      },
    ],
  };
  expect(
    preflightFrameworkSelection(catalogRaw, {
      ...input,
      observed: { ...input.observed, policy },
    }),
  ).toMatchObject({
    status: "refused",
    refusal: {
      code: "capability_unsupported",
      predicate: "executable.server.capabilities",
    },
  });
});
test("candidate and supported admission both enforce catalog constraints", () => {
  const { catalogRaw, input } = fixture(),
    changed = JSON.parse(catalogRaw);
  changed.distributionProfiles[0].dependencies[0].version = "23.0.0";
  const changedRaw = JSON.stringify(changed),
    selectionValue = frameworkCatalogDigest(changed),
    selectionRef = { ...input.selectionRef, selectionValue },
    manifest = JSON.parse(input.observed.distributionManifestRaw as string);
  manifest.catalogSelectionRef = selectionRef;
  const cache = JSON.parse(input.observed.cacheIndexRaw as string);
  cache.catalogSelectionRef = selectionRef;
  cache.distributionManifestSha256 = frameworkCatalogDigest(manifest);
  expect(
    preflightFrameworkSelection(changedRaw, {
      ...input,
      selectionRef,
      observed: {
        ...input.observed,
        distributionManifestRaw: JSON.stringify(manifest),
        cacheIndexRaw: JSON.stringify(cache),
      },
    }),
  ).toMatchObject({
    status: "refused",
    refusal: {
      code: "capability_unsupported",
      predicate: "capability.cap.server.constraint.node-runtime",
    },
  });
});
test("frozen I2 executable, runtime-selection and integer fields fail closed", () => {
  const { catalogRaw, input } = fixture();
  const missingLibraries = mutateJson(
    input.observed.distributionManifestRaw,
    (value) => delete value.artifacts[1].dynamicLibraries,
  );
  expect(
    preflightFrameworkSelection(catalogRaw, {
      ...input,
      observed: {
        ...input.observed,
        distributionManifestRaw: missingLibraries,
      },
    }),
  ).toMatchObject({
    status: "refused",
    refusal: {
      code: "distribution_identity_mismatch",
      predicate: "artifacts[1].dynamicLibraries",
    },
  });
  const booleanBytes = mutateJson(
    input.observed.distributionManifestRaw,
    (value) => (value.buildInputs[0].bytes = true),
  );
  expect(
    preflightFrameworkSelection(catalogRaw, {
      ...input,
      observed: {
        ...input.observed,
        distributionManifestRaw: booleanBytes,
      },
    }),
  ).toMatchObject({
    status: "refused",
    refusal: {
      code: "distribution_identity_mismatch",
      predicate: "buildInputs[0].bytes",
    },
  });
  const missingProvenance = mutateJson(
    input.observed.distributionManifestRaw,
    (value) => delete value.buildProvenance,
  );
  expect(
    preflightFrameworkSelection(catalogRaw, {
      ...input,
      observed: {
        ...input.observed,
        distributionManifestRaw: missingProvenance,
      },
    }),
  ).toMatchObject({
    status: "refused",
    refusal: {
      code: "catalog_invalid",
      predicate: "manifest",
    },
  });
  const booleanProvenanceBytes = mutateJson(
    input.observed.distributionManifestRaw,
    (value) => (value.buildProvenance.trees[0].bytes = true),
  );
  expect(
    preflightFrameworkSelection(catalogRaw, {
      ...input,
      observed: {
        ...input.observed,
        distributionManifestRaw: booleanProvenanceBytes,
      },
    }),
  ).toMatchObject({
    status: "refused",
    refusal: {
      code: "distribution_identity_mismatch",
      predicate: "buildProvenance.tree.bytes",
    },
  });
  const manifestValue = JSON.parse(input.observed.distributionManifestRaw);
  manifestValue.runtimeTrees[0].selectionId = "other-selection";
  const cacheValue = JSON.parse(input.observed.cacheIndexRaw);
  cacheValue.distributionManifestSha256 = frameworkCatalogDigest(manifestValue);
  expect(
    preflightFrameworkSelection(catalogRaw, {
      ...input,
      observed: {
        ...input.observed,
        distributionManifestRaw: JSON.stringify(manifestValue),
        cacheIndexRaw: JSON.stringify(cacheValue),
      },
    }),
  ).toMatchObject({
    status: "refused",
    refusal: { code: "runtime_identity_mismatch", predicate: "runtime.node" },
  });
});
