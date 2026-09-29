import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Driver-level tests for scripts/reduce-reproduction-prefix.mjs. These run
 *  the installed-entry script as a subprocess; they require `pnpm run build`
 *  so dist carries reproduceProjectCorpusPrefixWithCatalog. No project is ever
 *  loaded: every case stops before candidate evaluation, which proves lazy
 *  project loading and honest refusal/eligibility behavior. */
const script = resolve("scripts/reduce-reproduction-prefix.mjs");
const bundleRaw = readFileSync(
  resolve("test/fixtures/reproduction/accepted/behavioral-mismatch.json"),
  "utf8",
);
const bundle = JSON.parse(bundleRaw);

interface CliResult { status: number; stdout: string; stderr: string }
function runCli(args: string[]): CliResult {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      encoding: "utf8",
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? 1,
      stdout: failure.stdout?.toString() ?? "",
      stderr: failure.stderr?.toString() ?? "",
    };
  }
}

let root: string;
let outRoot: string;
let paths: Record<string, string>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "prefix-driver-test-"));
  outRoot = join(root, "out");
  mkdirSync(outRoot, { mode: 0o700 });
  const selectionRef = bundle.evidenceLinks.catalogSelectionRef;
  const framework = {
    catalogRaw: "{}",
    selectionRef,
    observed: {},
    installation: {
      schema: "mirrorecma.installed-framework-binding/v1",
      executables: [],
      packages: [],
      runtimeTrees: [],
    },
  };
  const trace = { vars: ["queue"], states: [{ a: 1 }, { a: 2 }, { a: 3 }] };
  const stability = {
    schema: "mirrorecma.reproduction-stability/v1",
    runId: "run-unstable",
    bundleSha256: "0".repeat(64),
    policy: { attempts: 3, perAttemptBudgetMs: 1000, cleanupBudgetMs: 1000 },
    resettable: true,
    classification: "unstable",
    attempts: [],
    independence: "confirmed",
  };
  paths = {
    bundle: join(root, "bundle.json"),
    stability: join(root, "stability.json"),
    trace: join(root, "trace.json"),
    framework: join(root, "framework-input.json"),
    envelope: join(root, "envelope.json"),
    project: join(root, "no-such-project.json"),
  };
  writeFileSync(paths.bundle, bundleRaw);
  writeFileSync(paths.stability, JSON.stringify(stability));
  writeFileSync(paths.trace, JSON.stringify(trace));
  writeFileSync(paths.framework, JSON.stringify(framework));
  writeFileSync(paths.envelope, "{}");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function baseArgs(): string[] {
  return [
    "--project", paths.project,
    "--bundle", paths.bundle,
    "--stability", paths.stability,
    "--original-trace", paths.trace,
    "--framework-input", paths.framework,
    "--combination", "candidate.local-node-checked",
    "--evidence-envelope", paths.envelope,
    "--output-root", outRoot,
  ];
}

test("unstable cases write a not_eligible result without loading the project", () => {
  const result = runCli(baseArgs());
  expect(result.status).toBe(0);
  const written = JSON.parse(
    readFileSync(join(outRoot, "prefix-reduction-result.json"), "utf8"),
  );
  expect(written).toMatchObject({
    schema: "mirrorecma.reproduction-prefix-reduction/v1",
    claim: "not_reduced",
    stopReason: "not_eligible",
    bestPrefixLength: null,
    minimalityComplete: false,
    candidates: [],
  });
  expect(written.originalBundleSha256).toMatch(/^[a-f0-9]{64}$/);
  const summary = JSON.parse(result.stdout);
  expect(summary.stopReason).toBe("not_eligible");
});

test("missing required flags refuse at usage before any file read", () => {
  const result = runCli(baseArgs().slice(0, 6));
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Usage:");
});

test("a zero candidate limit is rejected before any project load", () => {
  const result = runCli([...baseArgs(), "--candidate-limit", "0"]);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("candidate-limit");
});

test("a trace without states is rejected before any project load", () => {
  writeFileSync(paths.trace, JSON.stringify({ vars: [] }));
  const result = runCli(baseArgs());
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("no states");
});

test("a framework selection that disagrees with the bundle is rejected", () => {
  const framework = JSON.parse(readFileSync(paths.framework, "utf8"));
  framework.selectionRef = {
    ...framework.selectionRef,
    selectionValue: "f".repeat(64),
  };
  writeFileSync(paths.framework, JSON.stringify(framework));
  const result = runCli(baseArgs());
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("selection");
});
