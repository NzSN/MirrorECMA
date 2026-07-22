import { specFromFiles } from "../src/spec.js";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function makeSpecDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mirrorecma-spec-"));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content);
  }
  return dir;
}

const DEP = "---- MODULE Dep ----\nEXTENDS Integers\n====\n";
const MID = "---- MODULE Mid ----\nEXTENDS Integers, Dep\n====\n";
const ROOT = "---- MODULE Root ----\nEXTENDS Integers, Mid\n====\n";

describe("specFromFiles", () => {
  it("resolves a transitive dependency closure, root first", async () => {
    const dir = await makeSpecDir({ "Root.tla": ROOT, "Mid.tla": MID, "Dep.tla": DEP });
    const spec = await specFromFiles(join(dir, "Root.tla"));
    expect(spec.sources[0]).toBe(ROOT);
    expect(new Set(spec.sources)).toEqual(new Set([ROOT, MID, DEP]));
  });

  it("deduplicates diamond dependencies", async () => {
    const b = "---- MODULE B ----\nEXTENDS Dep\n====\n";
    const c = "---- MODULE C ----\nEXTENDS Dep\n====\n";
    const a = "---- MODULE A ----\nEXTENDS B, C\n====\n";
    const dir = await makeSpecDir({ "A.tla": a, "B.tla": b, "C.tla": c, "Dep.tla": DEP });
    const spec = await specFromFiles(join(dir, "A.tla"));
    expect(spec.sources[0]).toBe(a);
    expect(spec.sources.filter((s) => s === DEP)).toHaveLength(1);
    expect(spec.sources).toHaveLength(4);
  });

  it("skips builtin modules", async () => {
    const root = "---- MODULE R ----\nEXTENDS Naturals, Integers, Sequences, FiniteSets, TLC, Bags, Reals\n====\n";
    const dir = await makeSpecDir({ "R.tla": root });
    const spec = await specFromFiles(join(dir, "R.tla"));
    expect(spec.sources).toEqual([root]);
  });

  it("resolves INSTANCE clauses", async () => {
    const inst = "---- MODULE Inst ----\nEXTENDS Integers\n====\n";
    const root = "---- MODULE R ----\nEXTENDS Integers\nINSTANCE Inst WITH x <- 1\n====\n";
    const dir = await makeSpecDir({ "R.tla": root, "Inst.tla": inst });
    const spec = await specFromFiles(join(dir, "R.tla"));
    expect(spec.sources).toEqual([root, inst]);
  });

  it("throws naming the missing module and importer", async () => {
    const dir = await makeSpecDir({ "Root.tla": ROOT, "Mid.tla": MID });
    await expect(specFromFiles(join(dir, "Root.tla"))).rejects.toThrow(
      /module Dep required by .*Mid\.tla not found/
    );
  });

  it("falls back to searchDirs", async () => {
    const dir = await makeSpecDir({ "Root.tla": ROOT });
    const libDir = await mkdtemp(join(tmpdir(), "mirrorecma-lib-"));
    await mkdir(libDir, { recursive: true });
    await writeFile(join(libDir, "Mid.tla"), MID);
    await writeFile(join(libDir, "Dep.tla"), DEP);
    const spec = await specFromFiles(join(dir, "Root.tla"), [libDir]);
    expect(spec.sources[0]).toBe(ROOT);
    expect(spec.sources).toContain(MID);
    expect(spec.sources).toContain(DEP);
  });
});
