#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  checkProject,
  doctorProject,
  generateProject,
  initProject,
  replayProject,
  reproduceProjectWithCatalog,
  suiteExitCode,
  projectFailure,
  ProjectError,
  type ProjectStage,
  type ProjectCommandOptions,
  type InstalledFrameworkBinding,
} from "./project.js";
import {
  decodeReproductionBundle,
  parseBoundedJsonValue,
  type ReproductionEvidenceLinks,
} from "./reproduction-bundle.js";
import type {
  CatalogSelectionRef as FrameworkCatalogSelectionRef,
  FrameworkApprovalDecision,
  InstalledFrameworkObservation,
} from "./framework-catalog.js";

const usage =
  "Usage: mirrorecma init [DIRECTORY] | doctor|generate|check [--project FILE] [--framework-input FILE --combination ID] [--compiler FILE] [--server FILE] [--tool-registry FILE] | replay [--project FILE] [--framework-input FILE --combination ID] [--server FILE] [--tool-registry FILE] [--result-file NEW_FILE] | reproduce --project FILE --bundle FILE --framework-input FILE --combination ID --evidence-envelope FILE --output-root DIRECTORY [--artifact-store DIRECTORY] [--server FILE] [--tool-registry FILE]";
let stage: ProjectStage = "configuration";
async function readBoundedRegular(path: string, limit: number): Promise<Buffer> {
  const absolute = resolve(path);
  const handle = await open(
    absolute,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(limit))
      throw new ProjectError(
        "configuration_invalid",
        `${absolute} must be a regular non-symlink file at most ${limit} bytes`,
      );
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(65_536, limit + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > limit)
        throw new ProjectError(
          "configuration_invalid",
          `${absolute} exceeds ${limit} bytes`,
        );
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      BigInt(total) !== after.size
    )
      throw new ProjectError(
        "configuration_unavailable",
        `${absolute} changed while reading`,
      );
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}
async function readStrictJson(path: string, limit = 8_388_608): Promise<unknown> {
  try {
    return parseBoundedJsonValue(await readBoundedRegular(path, limit));
  } catch (cause) {
    if (cause instanceof ProjectError) throw cause;
    throw new ProjectError(
      "configuration_invalid",
      `cannot read strict bounded JSON: ${resolve(path)}`,
      { cause },
    );
  }
}
async function qualificationOutputRoot(path: string): Promise<string> {
  const absolute = resolve(path);
  const info = await lstat(absolute);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700)
    throw new ProjectError(
      "configuration_invalid",
      "qualification output root must be a pre-existing non-symlink mode-0700 directory",
    );
  if (typeof process.getuid === "function" && info.uid !== process.getuid())
    throw new ProjectError(
      "configuration_invalid",
      "qualification output root must belong to the current user",
    );
  return absolute;
}
async function writeExclusiveJson(path: string, value: unknown): Promise<void> {
  const handle = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}
interface DecodedFrameworkInput {
  catalogRaw: string;
  selectionRef: FrameworkCatalogSelectionRef;
  observed: InstalledFrameworkObservation;
  installation: InstalledFrameworkBinding;
  approval?: FrameworkApprovalDecision;
}
function frameworkInput(value: unknown): DecodedFrameworkInput {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProjectError("configuration_invalid", "framework input must be an object");
  const input = value as Record<string, unknown>;
  if (
    !["catalogRaw,installation,observed,selectionRef", "approval,catalogRaw,installation,observed,selectionRef"].includes(
      Object.keys(input).sort().join(","),
    ) ||
    typeof input.catalogRaw !== "string"
  )
    throw new ProjectError(
      "configuration_invalid",
      "framework input requires catalogRaw, selectionRef, observed, installation, and optional approval",
    );
  const installation=input.installation as Record<string,unknown>;
  if(!installation||typeof installation!=="object"||Array.isArray(installation)||installation.schema!=="mirrorecma.installed-framework-binding/v1"||!Array.isArray(installation.executables)||!Array.isArray(installation.packages)||!Array.isArray(installation.runtimeTrees))
    throw new ProjectError("configuration_invalid","framework installation binding is invalid");
  return input as unknown as DecodedFrameworkInput;
}
function resolveInstallation(
  value:InstalledFrameworkBinding,
  base:string,
):InstalledFrameworkBinding {
  return {
    ...value,
    executables:value.executables.map(item=>({...item,path:resolve(base,item.path)})),
    packages:value.packages.map(item=>({...item,root:resolve(base,item.root),manifest:{...item.manifest,path:resolve(base,item.manifest.path)}})),
    runtimeTrees:value.runtimeTrees.map(item=>({...item,root:resolve(base,item.root)})),
  };
}
async function main(args: string[]): Promise<number> {
  const command = args.shift();
  if (command === "--help" || command === "-h") {
    console.log(usage);
    return 0;
  }
  if (command === "init") {
    if (args.length > 1 || args[0]?.startsWith("--"))
      throw new ProjectError("usage", usage);
    console.log(JSON.stringify({ created: await initProject(args[0] ?? ".") }));
    return 0;
  }
  if (
    !command ||
    !["doctor", "generate", "check", "replay", "reproduce"].includes(command)
  )
    throw new ProjectError("usage", usage);
  const flags: Record<string, string> = Object.create(null);
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i]!;
    if (
      ![
        "--project",
        "--compiler",
        "--server",
        "--tool-registry",
        "--bundle",
        "--framework-input",
        "--combination",
        "--evidence-envelope",
        "--artifact-store",
        "--output-root",
        "--result-file",
      ].includes(k) ||
      Object.hasOwn(flags, k) ||
      !args[i + 1] ||
      args[i + 1]!.startsWith("--")
    )
      throw new ProjectError("usage", usage);
    flags[k] = args[i + 1]!;
  }
  const file = flags["--project"] ?? "mirror.project.json";
  const controller = new AbortController();
  const stop = () => controller.abort("CLI interrupted");
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let options: ProjectCommandOptions = {
    signal: controller.signal,
    installedRegistry: flags["--tool-registry"],
    tools: {
      ...(flags["--compiler"] ? { compiler: flags["--compiler"] } : {}),
      ...(flags["--server"] ? { server: flags["--server"] } : {}),
    },
  };
  try {
    if (
      (flags["--framework-input"] === undefined) !==
      (flags["--combination"] === undefined)
    )
      throw new ProjectError(
        "usage",
        "--framework-input and --combination must be supplied together",
      );
    let selectedFramework:DecodedFrameworkInput|undefined;
    if(flags["--framework-input"]){
      const frameworkPath=resolve(flags["--framework-input"]!);
      const decoded=frameworkInput(await readStrictJson(frameworkPath,8_388_608));
      selectedFramework={...decoded,installation:resolveInstallation(decoded.installation,dirname(frameworkPath))};
    }
    if (selectedFramework)
      options = {
        ...options,
        framework: {
          ...selectedFramework,
          combinationId: flags["--combination"]!,
        },
      };
    if (command === "doctor") {
      const checks = await doctorProject(file, options);
      console.log(JSON.stringify({ checks }, null, 2));
      return checks.some((c) => c.status === "failed") ? 2 : 0;
    }
    if (command === "generate") {
      stage = "generation";
      await generateProject(file, options);
      console.log(JSON.stringify({ status: "generated" }));
      return 0;
    }
    if (command === "check") {
      stage = "check";
      await checkProject(file, options);
      console.log(JSON.stringify({ status: "checked" }));
      return 0;
    }
    if (command === "reproduce") {
      stage = "reproduction";
      for (const key of [
        "--bundle",
        "--framework-input",
        "--combination",
        "--evidence-envelope",
        "--output-root",
      ])
        if (!flags[key]) throw new ProjectError("usage", usage);
      const outputRoot = await qualificationOutputRoot(flags["--output-root"]!);
      const bundle = decodeReproductionBundle(
        await readBoundedRegular(flags["--bundle"]!, 8_388_608),
      );
      if (bundle.evidenceLinks.catalogSelectionRef.selectionKind !== "sha256")
        throw new ProjectError(
          "catalog_selection_mismatch",
          "installed reproduction requires a canonical catalog SHA-256 selection",
        );
      if (!selectedFramework)
        throw new ProjectError(
          "configuration_invalid",
          "reproduce requires an explicit framework selection",
        );
      if (
        selectedFramework.selectionRef.selectionValue !==
          bundle.evidenceLinks.catalogSelectionRef.selectionValue ||
        selectedFramework.selectionRef.selectionKind !==
          bundle.evidenceLinks.catalogSelectionRef.selectionKind
      )
        throw new ProjectError(
          "catalog_selection_mismatch",
          "framework input selection does not match reproduction bundle",
        );
      const envelopeRaw = await readBoundedRegular(
        flags["--evidence-envelope"]!,
        8_388_608,
      );
      const envelopeSha256 = createHash("sha256")
        .update(envelopeRaw)
        .digest("hex");
      const envelope = parseBoundedJsonValue(envelopeRaw) as Record<
        string,
        unknown
      >;
      const validateEvidenceLinks = (links: ReproductionEvidenceLinks) => {
        if (
          envelopeSha256 !== links.runRef.envelopeSha256 ||
          envelope.schemaVersion !== links.runRef.schemaVersion ||
          envelope.runId !== links.runRef.runId ||
          envelope.projectionKind !== links.runRef.projectionKind
        )
          throw new ProjectError(
            "evidence_identity_mismatch",
            "evidence envelope does not match runRef",
          );
        const artifacts = Array.isArray(envelope.artifacts)
          ? (envelope.artifacts as Record<string, unknown>[])
          : [];
        for (const reference of links.artifactRefs) {
          const found = artifacts.find(
            (item) => item.artifactId === reference.artifactId,
          );
          if (
            !found ||
            found.sha256 !== reference.sha256 ||
            found.bytes !== reference.bytes ||
            found.role !== reference.role
          )
            throw new ProjectError(
              "evidence_identity_mismatch",
              `evidence artifact mismatch: ${reference.artifactId}`,
            );
        }
      };
      const store = flags["--artifact-store"]
        ? resolve(flags["--artifact-store"]!)
        : undefined;
      const result = await reproduceProjectWithCatalog(file, bundle, {
        ...options,
        combinationId: flags["--combination"]!,
        catalogSelection: bundle.evidenceLinks
          .catalogSelectionRef as FrameworkCatalogSelectionRef,
        catalogRaw: selectedFramework.catalogRaw,
        frameworkObserved: selectedFramework.observed,
        frameworkApproval: selectedFramework.approval,
        installation: selectedFramework.installation,
        validateEvidenceLinks,
        admittedResolvers: new Set(store ? ["evidence-envelope/v1"] : []),
        resolveExternal: async (reference) => {
          if (!store || reference.resolver !== "evidence-envelope/v1")
            throw new ProjectError(
              "resolver_not_admitted",
              "CLI supports only evidence-envelope/v1",
            );
          const path = join(store, reference.sha256);
          try {
            return await readBoundedRegular(path, 8_388_608);
          } catch (cause) {
            throw new ProjectError(
              "external_reference_unavailable",
              "artifact-store entry invalid",
              { cause },
            );
          }
        },
      });
      if (result.suiteResult === undefined)
        throw new ProjectError(
          "reproduction_result_invalid",
          "reproduction replay did not retain its suite cleanup result",
        );
      await writeExclusiveJson(join(outputRoot, "reproduction-result.json"), result);
      await writeExclusiveJson(join(outputRoot, "reproduction-cleanup.json"), {
        schema: "mirrorecma.reproduction-cleanup/v1",
        reproductionStatus: result.status,
        suiteId: result.suiteResult.suiteId,
        outcome: result.suiteResult.outcome,
        cleanup: result.suiteResult.cleanup,
      });
      console.log(JSON.stringify(result, null, 2));
      return result.status === "reproduced" ? 0 : 1;
    }
    stage = "replay";
    const result = await replayProject(file, options);
    if (flags["--result-file"])
      await writeExclusiveJson(resolve(flags["--result-file"]!), result);
    console.log(JSON.stringify(result, null, 2));
    return suiteExitCode(result);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(JSON.stringify(projectFailure(error, stage)));
    process.exitCode = 2;
  },
);
