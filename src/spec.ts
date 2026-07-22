// Dependency-closure resolution for multi-module TLA+ specs.
//
// Apalache's loadSpec treats sources[0] as the ROOT module and sources[1..]
// as dependency modules (SourceOption.StringSource(head, tail)), resolving
// EXTENDS/INSTANCE across all provided sources in one parse. specFromFiles
// builds that array from a root file by walking EXTENDS/INSTANCE clauses.

import { readFile, access } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import type { ApalacheSpec } from "./protocol.js";

// Modules provided internally by apalache/TLA+ — never resolved as files.
const BUILTINS = new Set([
  "Naturals",
  "Integers",
  "Reals",
  "Sequences",
  "FiniteSets",
  "TLC",
  "Bags",
  "Apalache",
]);

const EXTENDS_RE = /^\s*EXTENDS\s+(.+)$/m;
const INSTANCE_RE = /^\s*INSTANCE\s+(.+)$/m;

function moduleRefs(source: string, re: RegExp): string[] {
  const m = source.match(re);
  if (!m) return [];
  // "A, B, C" or "A WITH x <- y" (INSTANCE) — keep only module name tokens.
  return m[1]!
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0]!)
    .filter((name) => name.length > 0 && !BUILTINS.has(name));
}

async function firstExisting(candidates: string[]): Promise<string | null> {
  for (const p of candidates) {
    try {
      await access(p);
      return p;
    } catch {
      // try next candidate
    }
  }
  return null;
}

/**
 * Read a root .tla file and its transitive EXTENDS/INSTANCE dependency
 * closure into an ApalacheSpec, root first.
 *
 * Module names resolve to `<Name>.tla` in the importing file's directory,
 * then in `searchDirs` (in order). Builtin modules are skipped. Diamonds are
 * deduplicated; a missing dependency throws naming the module and importer.
 */
export async function specFromFiles(
  rootPath: string,
  searchDirs: string[] = []
): Promise<ApalacheSpec> {
  const visited = new Set<string>();
  const deps: string[] = [];

  async function visit(path: string, isRoot: boolean): Promise<void> {
    const abs = resolvePath(path);
    if (visited.has(abs)) return;
    visited.add(abs);

    const text = await readFile(abs, "utf8");
    const dir = dirname(abs);
    const refs = [...moduleRefs(text, EXTENDS_RE), ...moduleRefs(text, INSTANCE_RE)];

    for (const name of refs) {
      const found = await firstExisting([
        resolvePath(dir, `${name}.tla`),
        ...searchDirs.map((d) => resolvePath(d, `${name}.tla`)),
      ]);
      if (!found)
        throw new Error(`module ${name} required by ${abs} not found`);
      await visit(found, false);
    }

    if (isRoot) deps.unshift(text);
    else deps.push(text);
  }

  await visit(rootPath, true);
  return { sources: deps };
}
