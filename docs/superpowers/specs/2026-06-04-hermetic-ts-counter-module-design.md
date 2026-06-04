# Hermetic TypeScript build + Counter Bazel module

## Goal

Make MirrorECMA consumable as a `bazel_dep` by another Bazel module, and create
a downstream Counter module that validates the integration end-to-end.

## Motivation

MirrorECMA's `//:lib` target is a `genrule` tagged `local`/`no-sandbox` that
calls `tsc` from `node_modules/.bin/tsc`. When MirrorECMA is fetched as a
transitive bzlmod dependency, `node_modules` does not exist in the fetched
repo's workspace, so the genrule fails. The build must be hermetic.

## Design

### MirrorECMA: replace genrule with `aspect_rules_ts`

Add `aspect_rules_js` and `aspect_rules_ts` to `MODULE.bazel`. Use
`npm_translate_lock` to fetch npm dependencies (typescript, jest, ts-jest, etc.)
into a Bazel-managed `node_modules`. Replace the `genrule` with a `ts_project`
that compiles `src/` to `dist/` hermetically.

**MODULE.bazel deltas:**

```python
bazel_dep(name = "aspect_rules_js", version = "2.0")
bazel_dep(name = "aspect_rules_ts", version = "3.0")

npm = use_extension("@aspect_rules_js//npm:extensions.bzl", "npm")
npm.npm_translate_lock(
    name = "npm",
    npm_package_lock = "//:package-lock.json",
)
use_repo(npm, "npm")
```

**BUILD.bazel deltas:**

```python
load("@aspect_rules_ts//ts:defs.bzl", "ts_project")
load("@aspect_rules_js//npm:defs.bzl", "npm_link_all_packages")

npm_link_all_packages(name = "node_modules")

ts_project(
    name = "lib",
    srcs = glob(["src/**/*.ts"]),
    tsconfig = "tsconfig.json",
    declaration = True,
    out_dir = "dist",
    root_dir = "src",
)
```

Outputs land in `bazel-bin/dist/` (index.js, index.d.ts, protocol.js, etc.).
A `filegroup` or `js_library` can wrap them for external consumption if needed.

**tsconfig.json** may need `isolatedModules: true` and `module: "esnext"` /
`moduleResolution: "bundler"` for `ts_project` compatibility (exact settings
depend on `aspect_rules_ts` version requirements).

**Smoke test** stays as `sh_test`. The `data` attribute includes npm-fetched
jest via `@npm//jest-cli` (or keeps the script-based approach using the
workspace's `node_modules/.bin/jest` via `npm_link_all_packages`).

### Counter module (`~/Repos/Counter`)

A new Bazel module that depends on MirrorECMA and runs a smoke test against a
TLA+ Counter spec using MirrorECMA's `runClient`.

**File tree:**

```
Counter/
  MODULE.bazel
  BUILD.bazel
  package.json
  package-lock.json
  tsconfig.json
  jest.config.cjs
  src/
    counter.ts          # Counter + CounterComputer classes
  test/
    counter.test.ts     # smoke test using @mirrorecma
  specs/
    Counter.tla
```

**MODULE.bazel:**

```python
module(name = "counter", version = "0.1.0")

bazel_dep(name = "mirrorecma", version = "1.0.0")
git_override(
    module_name = "mirrorecma",
    remote = "https://github.com/NzSN/MirrorECMA",
    commit = "<latest>",
)

bazel_dep(name = "aspect_rules_js", version = "2.0")
bazel_dep(name = "aspect_rules_ts", version = "3.0")
bazel_dep(name = "rules_shell", version = "0.6.1")

# Repeat transitive overrides from mirrorecma (modelmirros, rules_haskell, rules_sh)
```

**BUILD.bazel:** `ts_project` for `src/counter.ts`, `sh_test` for the smoke
test that spawns ModelMirros and runs jest.

**src/counter.ts:** Exports `Counter` class (count, actionTaken, tick, toState)
and `CounterComputer` class (implements StateComputer, bridges State↔Counter).

**test/counter.test.ts:** Imports `runClient` from `@mirrorecma` (resolved via
Bazel's `ts_project` deps), imports `CounterComputer` from `../src/counter.js`,
runs the smoke test.

### Dependency graph

```
Counter ──bazel_dep──▶ mirrorecma ──bazel_dep──▶ modelmirros
    │                      │                          │
    │                      │                          └── rules_haskell, rules_sh
    │                      │
    │                      └── aspect_rules_ts, aspect_rules_js
    │
    └── aspect_rules_ts, aspect_rules_js, rules_shell
```

## Risks

- **tsconfig compatibility**: `aspect_rules_ts` may require `moduleResolution:
  "bundler"` or `"node"` instead of `"node16"`. The tsconfig will be adjusted.
- **npm_translate_lock** on first fetch downloads all packages; may be slow on
  first build.
- **Counter's transitive overrides**: must duplicate `modelmirros`,
  `rules_haskell`, `rules_sh` git_overrides since non-root overrides don't
  propagate transitively in bzlmod.
