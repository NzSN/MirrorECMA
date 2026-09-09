import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import * as client from "../src/index.js";

test("the 2.0 root exposes generic MBT without Gate hosting/evaluation exports", () => {
  expect(typeof client.runClientWithTracesNegotiatedWithReport).toBe("function");
  expect(typeof client.AsyncCompiledAdapterRegistry).toBe("function");
  for (const name of Object.keys(client)) {
    expect(name).not.toMatch(/sandbox|mirrorgate|TrustedGate/i);
  }
  const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
  expect(pkg.version).toBe("2.0.0");
  for (const category of ["dependencies", "peerDependencies", "optionalDependencies", "peerDependenciesMeta"]) {
    expect(Object.keys(pkg[category] ?? {})).not.toEqual(expect.arrayContaining(["mirrorgate", "mirrorgate-mirrorecma"]));
  }
  expect(JSON.parse(readFileSync(resolve("package.bazel.json"), "utf8")).version).toBe(pkg.version);
  expect(readFileSync(resolve("MODULE.bazel"), "utf8")).toMatch(/name = "mirrorecma",\s*version = "2\.0\.0"/);
});

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? sourceFiles(join(directory, entry.name)) : [join(directory, entry.name)]);
}

test("the generic implementation/declaration graph contains no Gate integration", () => {
  for (const file of sourceFiles(resolve("src"))) {
    expect(relative(resolve("src"), file)).not.toMatch(/sandbox|mirrorgate/i);
    if (!file.endsWith(".ts")) continue;
    const source = readFileSync(file, "utf8");
    expect(source).not.toMatch(/(?:from\s*|import\s*\(|require\s*\()["'](?:mirrorgate|mirrorgate-mirrorecma)(?:["'/])/);
    expect(source).not.toMatch(/SandboxGateEndpoint|SandboxSubmission|SandboxEvaluationPlan|TrustedGateLauncher/);
  }
});
