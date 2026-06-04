# Hermetic TypeScript build + Counter Bazel module — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make MirrorECMA's build hermetic so it works as a `bazel_dep`, and create a downstream Counter Bazel module that validates the integration.

**Architecture:** MirrorECMA's `genrule` is replaced with `ts_project` from `aspect_rules_ts`, fetching TypeScript hermetically via `npm_translate_lock`. Counter is a new Bazel module at `~/Repos/Counter` that depends on `mirrorecma` via `git_override`, links MirrorECMA's compiled output into its node_modules, and runs a smoke test via `sh_test`.

**Tech Stack:** Bazel 9.1.0, aspect_rules_js 3.2.0, aspect_rules_ts 3.8.9, TypeScript 5.5, Jest 30, ts-jest 29, ModelMirros (Haskell binary)

---

### Task A1: Add aspect_rules_js and aspect_rules_ts to MirrorECMA MODULE.bazel

**Files:**
- Modify: `MODULE.bazel`

- [ ] **Step 1: Add bzlmod deps for aspect_rules_js and aspect_rules_ts**

Append to MODULE.bazel:

```python
bazel_dep(name = "aspect_rules_js", version = "3.2.0")
bazel_dep(name = "aspect_rules_ts", version = "3.8.9")

npm = use_extension("@aspect_rules_js//npm:extensions.bzl", "npm")
npm.npm_translate_lock(
    name = "npm",
    npm_package_lock = "//:package-lock.json",
)
use_repo(npm, "npm")
```

- [ ] **Step 2: Fetch and verify resolution**

```bash
bazel fetch //... 2>&1
```

Expected: extensions resolve, no errors about missing modules.

---

### Task A2: Replace genrule with ts_project in BUILD.bazel

**Files:**
- Modify: `BUILD.bazel`
- Modify: `tsconfig.json`

- [ ] **Step 1: Adjust tsconfig.json for ts_project compatibility**

aspect_rules_ts 3.x requires `moduleResolution: "bundler"` and `isolatedModules: true`. Update tsconfig.json:

```json
{
  "compilerOptions": {
    "target": "es2022",
    "module": "node16",
    "moduleResolution": "node16",
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "strict": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src"]
}
```

(If ts_project reports errors with `moduleResolution: "node16"`, switch to `"bundler"` and `"module": "esnext"`.)

- [ ] **Step 2: Add npm_link_all_packages and ts_project to BUILD.bazel**

Replace the entire `genrule` block and add the load/npm_link/ts_project block. The sh_test stays untouched at the bottom.

```python
load("@aspect_rules_js//npm:defs.bzl", "npm_link_all_packages")
load("@aspect_rules_ts//ts:defs.bzl", "ts_project")

npm_link_all_packages(name = "node_modules")

ts_project(
    name = "lib_ts",
    srcs = glob(["src/**/*.ts"]),
    tsconfig = "//:tsconfig",
    declaration = True,
    out_dir = "dist",
    root_dir = "src",
)

load("@aspect_rules_js//js:defs.bzl", "js_library")

js_library(
    name = "lib",
    srcs = [":lib_ts"],
    package_name = "mirrorecma",
    visibility = ["//visibility:public"],
)

load("@rules_shell//shell:sh_test.bzl", "sh_test")

sh_test(
    name = "smoke",
    srcs = ["scripts/smoke_bazel"],
    args = ["$(execpath @modelmirros//app:ModelMirrors)"],
    data = [
        "@modelmirros//app:ModelMirrors",
        "test/smoke.test.ts",
        "specs/Counter.tla",
        "package.json",
        "jest.config.cjs",
        "tsconfig.json",
    ],
    tags = ["local", "no-sandbox"],
    env = {"NODE_OPTIONS": "--experimental-vm-modules"},
)
```

Note: The `js_library(name = "lib")` wraps `lib_ts` with `package_name = "mirrorecma"` so downstream modules can `npm_link_package` it.

- [ ] **Step 3: Verify MirrorECMA builds**

```bash
bazel build //:lib 2>&1
```

Expected: BUILD completed successfully, outputs in `bazel-bin/dist/`.

- [ ] **Step 4: Verify smoke test still passes**

```bash
bazel test //:smoke --test_output=all 2>&1
```

Expected: PASSED (1 test).

---

### Task A3: Commit MirrorECMA changes

**Files:**
- Modify: `MODULE.bazel`, `BUILD.bazel`, `tsconfig.json` (if changed)

- [ ] **Step 1: Commit**

```bash
git add MODULE.bazel BUILD.bazel tsconfig.json
git commit -m "build: replace genrule with hermetic ts_project via aspect_rules_ts"
```

- [ ] **Step 2: Record the commit hash for Counter's git_override**

```bash
git rev-parse HEAD
```

Save this hash — it will be used in Counter's MODULE.bazel.

---

### Task B1: Create Counter module scaffolding

**Files:**
- Create: `~/Repos/Counter/`
- Create: `~/Repos/Counter/.bazelversion`
- Create: `~/Repos/Counter/.bazelrc`

- [ ] **Step 1: Create directory**

```bash
mkdir -p ~/Repos/Counter
cd ~/Repos/Counter
```

- [ ] **Step 2: Write .bazelversion**

```
9.1.0
```

- [ ] **Step 3: Write .bazelrc**

```
build --enable_runfiles
test --test_output=errors
```

---

### Task B2: Write Counter MODULE.bazel

**Files:**
- Create: `~/Repos/Counter/MODULE.bazel`

- [ ] **Step 1: Write MODULE.bazel**

Replace `<MIRRORECMA_COMMIT>` with the hash from Task A3 Step 2.

```python
module(
    name = "counter",
    version = "0.1.0",
)

bazel_dep(name = "mirrorecma", version = "1.0.0")
git_override(
    module_name = "mirrorecma",
    remote = "https://github.com/NzSN/MirrorECMA",
    commit = "<MIRRORECMA_COMMIT>",
)

bazel_dep(name = "modelmirros", version = "0.1.0.0")
git_override(
    module_name = "modelmirros",
    remote = "https://github.com/NzSN/ModelMirrors",
    commit = "8f351ddb87910dded892efa2e005563961d3b54f",
)

bazel_dep(name = "rules_shell", version = "0.6.1")
bazel_dep(name = "aspect_rules_js", version = "3.2.0")
bazel_dep(name = "aspect_rules_ts", version = "3.8.9")

npm = use_extension("@aspect_rules_js//npm:extensions.bzl", "npm")
npm.npm_translate_lock(
    name = "npm",
    npm_package_lock = "//:package-lock.json",
)
use_repo(npm, "npm")

# Transitive overrides inherited from mirrorecma (bzlmod requires root module to repeat)
git_override(
    module_name = "rules_haskell",
    remote = "https://github.com/NzSN/rules_haskell",
    commit = "932d7545df965cc9f62a181a948df73fa08fdaf8",
)

git_override(
    module_name = "rules_sh",
    remote = "https://github.com/tweag/rules_sh",
    commit = "c28667efc2fd9c95ceada90ce2b27d928fa36971",
)

bazel_dep(name = "rules_haskell", version = "1.0")
bazel_dep(name = "platforms", version = "1.0.0")

stack_snapshot = use_extension(
    "@rules_haskell//extensions:stack_snapshot.bzl",
    "stack_snapshot",
)
stack_snapshot.snapshot(local_snapshot = "@modelmirros//:stackage_snapshot.yaml")
use_repo(stack_snapshot, "stackage", "stackage-exe")
```

---

### Task B3: Write package.json, tsconfig.json, jest.config.cjs

**Files:**
- Create: `~/Repos/Counter/package.json`
- Create: `~/Repos/Counter/tsconfig.json`
- Create: `~/Repos/Counter/jest.config.cjs`

- [ ] **Step 1: Write package.json**

```json
{
  "name": "counter",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "devDependencies": {
    "@types/jest": "^30.0.0",
    "@types/node": "^22.19.19",
    "jest": "^30.4.2",
    "ts-jest": "^29.4.11",
    "ts-node": "^10.9.2",
    "typescript": "^5.5"
  }
}
```

- [ ] **Step 2: Run npm install to generate package-lock.json**

```bash
npm install 2>&1
```

- [ ] **Step 3: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "es2022",
    "module": "node16",
    "moduleResolution": "node16",
    "rootDir": "src",
    "declaration": true,
    "strict": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "dist"
  },
  "include": ["src"]
}
```

- [ ] **Step 4: Write jest.config.cjs**

```js
/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "node",
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  testMatch: ["<rootDir>/test/**/*.test.ts"],
};
```

---

### Task B4: Write Counter and CounterComputer classes

**Files:**
- Create: `~/Repos/Counter/src/counter.ts`

- [ ] **Step 1: Write src/counter.ts**

```typescript
import type { State, StateComputer } from "mirrorecma";
import { asInt, getParam } from "mirrorecma";

export class Counter {
  count: bigint;

  constructor() {
    this.count = 0n;
  }

  tick(stride: bigint): void {
    this.count += stride;
  }

  toState(): State {
    return {
      count: { tag: "int", val: this.count },
    };
  }
}

export class CounterComputer {
  private counter = new Counter();

  compute(action: string, params: State, prevState: State): State {
    if (action === "Init" || !prevState.count) {
      this.counter = new Counter();
      return this.counter.toState();
    }

    const rec = getParam(params, "parameters");
    const stride = rec ? asInt(rec.stride!) ?? 0n : 0n;

    this.counter.tick(stride);
    return this.counter.toState();
  }
}
```

---

### Task B5: Copy Counter.tla and create the test

**Files:**
- Create: `~/Repos/Counter/specs/Counter.tla`
- Create: `~/Repos/Counter/test/counter.test.ts`

- [ ] **Step 1: Copy Counter.tla from MirrorECMA**

```bash
mkdir -p ~/Repos/Counter/specs
cp ~/Repos/MirrorECMA/specs/Counter.tla ~/Repos/Counter/specs/Counter.tla
```

- [ ] **Step 2: Write test/counter.test.ts**

```bash
mkdir -p ~/Repos/Counter/test
```

Write `test/counter.test.ts`:

```typescript
import { runClient, type TraceGenerationConfig } from "mirrorecma";
import { CounterComputer } from "../src/counter.js";

const BIN = process.env.MIRROR_BIN ?? "";
const SPEC = "./specs/Counter.tla";

const runSmoke = BIN ? test : test.skip;

const config: TraceGenerationConfig = {
  invariant: "TraceComplete",
  lengthBound: 6,
  numTraces: 1,
  cinit: "CInit",
  paramVars: "parameters",
};

describe("Counter", () => {
  runSmoke("end-to-end against Counter.tla", async () => {
    const start = Date.now();
    const computer = new CounterComputer();
    await runClient(BIN, SPEC, config, computer.compute.bind(computer));
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(60000);
    console.log(`OK (${elapsed}ms)`);
  }, 120000);
});
```

---

### Task B6: Write BUILD.bazel with sh_test and script

**Files:**
- Create: `~/Repos/Counter/BUILD.bazel`
- Create: `~/Repos/Counter/scripts/check`

- [ ] **Step 1: Write BUILD.bazel**

```python
load("@aspect_rules_js//npm:defs.bzl", "npm_link_all_packages", "npm_link_package")

npm_link_all_packages(name = "node_modules")

npm_link_package(
    name = "node_modules/mirrorecma",
    src = "@mirrorecma//:lib",
)

load("@rules_shell//shell:sh_test.bzl", "sh_test")

sh_test(
    name = "check",
    srcs = ["scripts/check"],
    args = ["$(execpath @modelmirros//app:ModelMirrors)"],
    data = [
        "@modelmirros//app:ModelMirrors",
        "@mirrorecma//:lib",
        "test/counter.test.ts",
        "src/counter.ts",
        "specs/Counter.tla",
        "package.json",
        "jest.config.cjs",
        "tsconfig.json",
    ],
    tags = ["local", "no-sandbox"],
    env = {"NODE_OPTIONS": "--experimental-vm-modules"},
)
```

- [ ] **Step 2: Write scripts/check**

```bash
mkdir -p ~/Repos/Counter/scripts
```

```bash
#!/usr/bin/env bash
set -euo pipefail
[ -n "${1:-}" ] || { echo "Usage: $0 <binary-path>" >&2; exit 1; }
export PATH="/home/nzsn/.local/bin/apalache/bin:$PATH"
PKG_JSON="${TEST_SRCDIR:-$PWD}/_main/package.json"
WS="$(dirname "$(realpath "$PKG_JSON")")"
cd "$WS"
MIRROR_BIN="$(realpath "$1")" npx jest test/counter.test.ts
```

Make executable:

```bash
chmod +x ~/Repos/Counter/scripts/check
```

---

### Task B7: Build and test

- [ ] **Step 1: Fetch dependencies**

```bash
cd ~/Repos/Counter && bazel fetch //... 2>&1
```

Expected: no errors (may take a while on first run downloading npm packages).

- [ ] **Step 2: Run the check test**

```bash
cd ~/Repos/Counter && bazel test //:check --test_output=all 2>&1
```

Expected: `PASSED` — Counter smoke test passes against ModelMirros.

- [ ] **Step 3: Commit Counter module**

```bash
cd ~/Repos/Counter
git init
git add -A
git commit -m "feat: Counter module checking MirrorECMA via Bazel bzlmod"
```
