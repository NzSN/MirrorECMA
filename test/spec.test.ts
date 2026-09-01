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

  it("resolves continued EXTENDS and INSTANCE expressions anywhere", async () => {
    const a = "---- MODULE A ----\n====\n";
    const b = "---- MODULE B ----\n====\n";
    const c = "---- MODULE C ----\n====\n";
    const d = "---- MODULE D ----\n====\n";
    const root = [
      "---- MODULE R ----",
      "EXTENDS",
      "  A,",
      "  B",
      "Op == INSTANCE C WITH x <- 1",
      "LOCAL INSTANCE D",
      "====",
      "",
    ].join("\n");
    const dir = await makeSpecDir({ "R.tla": root, "A.tla": a, "B.tla": b, "C.tla": c, "D.tla": d });
    const spec = await specFromFiles(join(dir, "R.tla"));
    expect(spec.sources[0]).toBe(root);
    expect(new Set(spec.sources)).toEqual(new Set([root, a, b, c, d]));
  });

  it("ignores keywords in strings and nested comments", async () => {
    const root = [
      "---- MODULE R ----",
      "Text == \"EXTENDS Fake1 INSTANCE Fake2\"",
      "(* outer",
      "   EXTENDS Fake3",
      "   (* INSTANCE Fake4 *)",
      "*)",
      "\\* INSTANCE Fake5",
      "EXTENDS Integers",
      "====",
      "",
    ].join("\n");
    const dir = await makeSpecDir({ "R.tla": root });
    expect((await specFromFiles(join(dir, "R.tla"))).sources).toEqual([root]);
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

  it("uses TLA_LIBRARY_PATH when searchDirs is omitted", async () => {
    const dir = await makeSpecDir({ "Root.tla": ROOT });
    const libDir = await mkdtemp(join(tmpdir(), "mirrorecma-lib-"));
    await writeFile(join(libDir, "Mid.tla"), MID);
    await writeFile(join(libDir, "Dep.tla"), DEP);
    const prev = process.env.TLA_LIBRARY_PATH;
    process.env.TLA_LIBRARY_PATH = libDir;
    try {
      const spec = await specFromFiles(join(dir, "Root.tla"));
      expect(spec.sources[0]).toBe(ROOT);
      expect(spec.sources).toContain(MID);
      expect(spec.sources).toContain(DEP);
    } finally {
      if (prev === undefined) delete process.env.TLA_LIBRARY_PATH;
      else process.env.TLA_LIBRARY_PATH = prev;
    }
  });

  it("throws on ambiguous module found in multiple directories", async () => {
    const dir = await makeSpecDir({ "Root.tla": ROOT, "Mid.tla": MID, "Dep.tla": DEP });
    const libDir = await mkdtemp(join(tmpdir(), "mirrorecma-lib-"));
    await writeFile(join(libDir, "Mid.tla"), MID);
    await expect(specFromFiles(join(dir, "Root.tla"), [libDir])).rejects.toThrow(
      /module Mid required by .*Root\.tla is ambiguous: found at .*,/
    );
  });
});
