// Dependency-closure resolution for multi-module TLA+ specs.
//
// Apalache's loadSpec treats sources[0] as the ROOT module and sources[1..]
// as dependency modules (SourceOption.StringSource(head, tail)), resolving
// EXTENDS/INSTANCE across all provided sources in one parse. specFromFiles
// builds that array from a root file by walking EXTENDS/INSTANCE clauses.
//
// Module lookup order for <Name>.tla:
//   1. the importing file's directory
//   2. explicit searchDirs (defaults to $TLA_LIBRARY_PATH, colon-separated)
// If a module name resolves to DIFFERENT files in more than one directory,
// resolution fails loudly (ambiguity) instead of silently shipping the wrong
// module to the mirror.

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

async function existingPaths(candidates: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const p of candidates) {
    try {
      await access(p);
      found.push(p);
    } catch {
      // not here; try next candidate
    }
  }
  return found;
}

function defaultSearchDirs(): string[] {
  return (process.env.TLA_LIBRARY_PATH ?? "").split(":").filter((d) => d.length > 0);
}

/**
 * Read a root .tla file and its transitive EXTENDS/INSTANCE dependency
 * closure into an ApalacheSpec, root first.
 *
 * Module names resolve to `<Name>.tla` in the importing file's directory,
 * then in `searchDirs` (default: $TLA_LIBRARY_PATH). Builtin modules are
 * skipped. Diamonds are deduplicated. A missing dependency throws naming the
 * module and importer; a name found in MORE THAN ONE directory throws an
 * ambiguity error listing the candidates.
 */
export async function specFromFiles(
  rootPath: string,
  searchDirs: string[] = defaultSearchDirs()
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
      const candidates = [
        resolvePath(dir, `${name}.tla`),
        ...searchDirs.map((d) => resolvePath(d, `${name}.tla`)),
      ];
      const found = [...new Set(await existingPaths(candidates))];
      if (found.length === 0)
        throw new Error(`module ${name} required by ${abs} not found`);
      if (found.length > 1)
        throw new Error(
          `module ${name} required by ${abs} is ambiguous: found at ${found.join(", ")}`
        );
      await visit(found[0]!, false);
    }

    if (isRoot) deps.unshift(text);
    else deps.push(text);
  }

  await visit(rootPath, true);
  return { sources: deps };
}
