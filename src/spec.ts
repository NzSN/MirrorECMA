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

import { readFile, access, realpath } from "node:fs/promises";
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

/** Tokenize the small part of TLA+ needed for dependency discovery. Strings,
 * line comments, and nested block comments are skipped, while identifiers and
 * commas are retained. This recognizes continued EXTENDS clauses and INSTANCE
 * expressions in forms such as `LOCAL INSTANCE M` and `Op == INSTANCE M`. */
function dependencyTokens(source: string): string[] {
  const out: string[] = [];
  let i = 0;
  let blockDepth = 0;
  while (i < source.length) {
    if (blockDepth > 0) {
      if (source.startsWith("(*", i)) { blockDepth++; i += 2; continue; }
      if (source.startsWith("*)", i)) { blockDepth--; i += 2; continue; }
      i++;
      continue;
    }
    if (source.startsWith("\\*", i)) {
      i = source.indexOf("\n", i + 2);
      if (i < 0) break;
      continue;
    }
    if (source.startsWith("(*", i)) { blockDepth = 1; i += 2; continue; }
    if (source[i] === '"') {
      i++;
      while (i < source.length) {
        if (source[i] === "\\") { i += 2; continue; }
        if (source[i] === '"') { i++; break; }
        i++;
      }
      continue;
    }
    if (source[i] === ",") { out.push(","); i++; continue; }
    if (/[A-Za-z_]/.test(source[i]!)) {
      const start = i++;
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i]!)) i++;
      out.push(source.slice(start, i));
      continue;
    }
    i++;
  }
  return out;
}

function moduleRefs(source: string): string[] {
  const tokens = dependencyTokens(source);
  const refs: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "EXTENDS") {
      let j = i + 1;
      if (tokens[j] === undefined || tokens[j] === ",") continue;
      refs.push(tokens[j]!);
      j++;
      while (tokens[j] === "," && tokens[j + 1] !== undefined && tokens[j + 1] !== ",") {
        refs.push(tokens[j + 1]!);
        j += 2;
      }
      i = j - 1;
    } else if (tokens[i] === "INSTANCE" && tokens[i + 1] !== undefined) {
      refs.push(tokens[++i]!);
    }
  }
  return refs.filter((name) => !BUILTINS.has(name));
}

async function existingPaths(candidates: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const p of candidates) {
    try {
      await access(p);
      found.push(await realpath(p));
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
    const abs = await realpath(resolvePath(path));
    if (visited.has(abs)) return;
    visited.add(abs);

    const text = await readFile(abs, "utf8");
    const dir = dirname(abs);
    const refs = moduleRefs(text);

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
