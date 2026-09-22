import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { frameworkCatalogDigest } from "../src/framework-catalog.js";
import { catalogIdentityFromUtf8 } from "../examples/application-validation/suite.mjs";

const wrapper = resolve(
  "examples/application-validation/installed-project-replay.mjs",
);

test("installed catalog bytes are parsed before canonical identity is computed", () => {
  const document = { schemaVersion: "fixture/v1", nested: { b: 2, a: 1 } };
  const raw = Buffer.from(
    '{"nested":{"a":1,"b":2},"schemaVersion":"fixture/v1"}\n',
    "utf8",
  );
  const identity = catalogIdentityFromUtf8(raw);
  expect(identity.document).toEqual(document);
  expect(identity.digest).toBe(frameworkCatalogDigest(document));
  expect(identity.digest).not.toBe(frameworkCatalogDigest(raw));
});

test.each([
  ["correct", "replay-correct.json", 0, "passed"],
  ["faulty", "replay-faulty.json", 1, "mismatch"],
] as const)("relocated installed %s wrapper writes its fixed result", async (
  mode,
  resultName,
  cliExit,
  outcome,
) => {
  const temporary = await mkdtemp(join(tmpdir(), "mirrorecma-wrapper-"));
  try {
    const runtime = join(temporary, "relocated/runtime");
    const wrapperDirectory = join(
      runtime,
      "applications/examples/application-validation",
    );
    const cli = join(runtime, "packages/mirrorecma/dist/cli.mjs");
    const projectDirectory = join(runtime, "applications/reference-project");
    const output = join(temporary, "output");
    await Promise.all([
      mkdir(wrapperDirectory, { recursive: true }),
      mkdir(dirname(cli), { recursive: true }),
      mkdir(projectDirectory, { recursive: true }),
      mkdir(output, { mode: 0o700 }),
    ]);
    await copyFile(wrapper, join(wrapperDirectory, "installed-project-replay.mjs"));
    await writeFile(join(runtime, "framework-input.json"), "{}\n");
    await writeFile(join(runtime, "installed-registry.json"), JSON.stringify({
      schemaVersion: "mirrors.installed-registry/v1",
      frameworkInput: "framework-input.json",
      mirrorecmaCli: "packages/mirrorecma/dist/cli.mjs",
      combinationId: "candidate.local-node-checked",
    }));
    await writeFile(join(projectDirectory, `mirror.${mode}.project.json`), "{}\n");
    const result = {
      schema: "mirrorecma.suite-result/v1",
      suiteId: "installed-work-queue/v1",
      outcome,
      conformance: outcome === "passed" ? "matched" : "mismatch",
      acceptance: { status: outcome === "passed" ? "met" : "incomplete" },
      cleanup: {
        scope: "local",
        status: "succeeded",
        quiescence: "confirmed",
        bindingStatus: "succeeded",
      },
      identities: { interfaceDigest: "fixture" },
      evidence: {},
      ...(outcome === "mismatch" ? { failure: {
        stage: "replay", kind: "mismatch", code: "model_mismatch",
        message: "fixture", traceIndex: 0, stateIndex: 1,
      } } : {}),
    };
    await writeFile(
      cli,
      `import {writeFileSync} from 'node:fs'; const i=process.argv.indexOf('--result-file'); writeFileSync(process.argv[i+1],${JSON.stringify(`${JSON.stringify(result)}\n`)},{flag:'wx',mode:0o600}); process.exitCode=${cliExit};\n`,
    );
    const command = spawnSync(process.execPath, [
      join(wrapperDirectory, "installed-project-replay.mjs"),
      mode,
      output,
    ], { encoding: "utf8" });
    expect({ status: command.status, stderr: command.stderr }).toEqual({
      status: 0,
      stderr: "",
    });
    expect(JSON.parse(await readFile(join(output, resultName), "utf8"))).toEqual(result);
    expect((await readFile(join(output, resultName))).length).toBeGreaterThan(0);
  } finally {
    await chmod(temporary, 0o700).catch(() => {});
    await rm(temporary, { recursive: true, force: true });
  }
});
