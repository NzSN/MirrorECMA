# Generated Counter quick start — implementation plan

Status: implemented and verified on 2026-09-06. All six tasks are complete;
assignments and execution evidence are recorded below.

Design: [generated Counter quick start](../specs/2026-09-06-generated-counter-quickstart-design.md).

Goal: make a generated, negotiated adapter to a real implementation the first
workflow taught by MirrorECMA. Deliver a runnable passing example, a real bug
demonstration, and commands that stay consistent with the generated artifacts.

Execute dependent checks in order. Implementation can proceed in parallel through
the agreed interfaces below. This plan requires no public client-interface
changes, wire changes, new dependencies, or compiler features.

## Subagent assignments and handoffs

| Task | Owner | Exclusive file ownership | Required handoff |
| --- | --- | --- | --- |
| T1 | Coordinator | Tutorial `specs/Counter.tla`; design and plan status | Verified model, compiler check/preflight, regeneration evidence to all workers |
| T2 | `counter_adapter` | Example `counter.ts`, `adapter.ts` | Counter classes and `createCounterRun` interface to runner |
| T3 | `counter_runner` | Example `run.ts`, `tsconfig.examples.json`, `package.json` | Built executable, scripts, and output contract to acceptance and onboarding |
| T4 | `counter_acceptance` | `test/generated-counter.smoke.ts`; Mirrors `tools/interop/run.sh`, `tools/interop/INTEROP.md` | Acceptance outcomes and exact diagnostics to onboarding/coordinator |
| T5 | `counter_onboarding` | Both READMEs; example README; MirrorECMA `AGENTS.md` | Documentation matching executable commands to coordinator |
| T6 | Coordinator | Final integration, fixes after ownership handoff, task status | Consolidated verification evidence and final review |

Workers preserve one another's changes. Requests to modify a shared build/script
file go to its owner. The coordinator integrates any cross-file correction once
the relevant worker has handed off that file.

The adapter-to-runner contract is `createCounterRun(createCounter?: () => Counter)`
returning `selection`, `assertAllActionsCovered()`, and `coverage()`. Counter and
BrokenCounter export `count: bigint`, `reset()`, and `increment(stride)`.
Construction stays inside the negotiated registry factory.

The runner-to-acceptance contract is an emitted executable at
`dist-test/examples/generated-counter/run.js` with optional `--broken` and
`--live` flags. Success prints `Counter replay passed.` or
`Counter live run passed.`, then `Action coverage: <JSON>`. Failures preserve the
client's diagnostic and return nonzero. `smoke:generated-counter` builds once
and runs `dist-test/test/generated-counter.smoke.js`.

T2/T3 can prepare their modules against these interfaces while T1 runs. T4 can
prepare the acceptance harness concurrently and executes after T1/T3. T5 can
prepare the documentation structure concurrently and finalizes commands and
diagnostics after T4. T6 starts after all handoffs.

## T1 — Establish the tutorial's model and artifact inputs

Files: create `examples/generated-counter/specs/Counter.tla`; reuse
`test/fixtures/model-interface/counter/` without creating another generated tree.

- [x] Copy `Mirrors/specs/Counter.tla` byte-for-byte into the tutorial directory.
  Keep MirrorECMA's existing root `specs/Counter.tla` intact; it currently differs.
- [x] Build the existing tools from the Mirrors root:
  `lake build mirror model_interface_gen`.
- [x] From MirrorECMA, run the following checks with an absolute `MIRRORS_ROOT`:

```bash
MODEL_INTERFACE_GEN="$MIRRORS_ROOT/.lake/build/bin/model_interface_gen"
COUNTER_MODEL="$PWD/examples/generated-counter/specs/Counter.tla"
COUNTER_FIXTURES="$PWD/test/fixtures/model-interface/counter"

"$MODEL_INTERFACE_GEN" check \
  --spec "$COUNTER_MODEL" \
  --contract "$COUNTER_FIXTURES/Counter.mirror-interface.json" \
  --evidence "$COUNTER_FIXTURES/counter.itf.json" \
  --param-var parameters \
  --lock "$COUNTER_FIXTURES/Counter.mirror-interface.lock.json" \
  --target mirrorecma-v1 \
  --out "$COUNTER_FIXTURES/generated"

"$MODEL_INTERFACE_GEN" preflight \
  --lock "$COUNTER_FIXTURES/Counter.mirror-interface.lock.json" \
  --trace "$COUNTER_FIXTURES/counter.itf.json" \
  --require-all-actions
```

- [x] Compare the tutorial model with the authoritative Mirrors model. If the
  compiler check finds drift, reconcile the current model and fixture provenance
  before proceeding; do not rewrite expected bytes merely to obtain a pass.
- [x] Record the exact resolve/generate commands for the detailed tutorial,
  using the same inputs and target as `check`. Verify regeneration in a temporary
  output directory so this task does not overwrite the shared checked-in tree.

Done: the tutorial model resolves to the existing lock/output, and the supplied
trace passes required-action preflight. All checks identify their actual inputs.

## T2 — Add the real implementation and its adapter

Depends on T1.

Files: create `examples/generated-counter/counter.ts` and `adapter.ts`.

- [x] Implement the small Counter using `bigint`, with reset, increment, and
  observable count. It imports nothing from MirrorECMA or generated code.
- [x] Add an explicitly named faulty Counter whose increment adds
  `stride - 1n`. Keep observation truthful and identical between variants.
- [x] Implement the typed port mapping shown in the design. Do not expose
  expected state, previous reported state, or raw ITF values to the Counter.
- [x] Construct the SUT and generated binding inside the compiled registry's
  factory. Capture a constructor function when selecting the correct/faulty
  implementation; selection itself must not construct either one.
- [x] Use the generated metadata/digest pair and exported profile constants.
  Set `policy: "require"`; use the existing binding's configuration requirement
  and the negotiated runner's cleanup ownership.
- [x] Expose the generated binding's coverage to the example runner through
  local state, without adding a package export or changing `LocalBinding`.

Done: the adapter is a small mapping from generated operations to actual
implementation behavior; the same adapter accepts both Counter variants.

## T3 — Make the example executable through existing interfaces

Depends on T2.

Files: create `examples/generated-counter/run.ts` and `tsconfig.examples.json`;
update `package.json` with the five commands defined in the design.

- [x] Compile from repository `rootDir: "."` into ignored `dist-test/`, including
  source, tutorial, and reused generated fixture. Resolve the generated file's
  type-only `mirrorecma` import to the public source barrel. Use emitted JavaScript
  for execution so tutorial scripts need no new loader or dependency.
- [x] Require execution from the documented MirrorECMA root and resolve input
  files absolutely. Support `MIRRORS_ROOT` with a sibling-checkout default and
  `MIRROR_BIN` as an explicit binary override. Keep machine-specific paths out
  of the implementation.
- [x] Default to supplied-trace replay with `runClientWithTracesNegotiated`.
  Set `specPath` to the tutorial model and pass the shared trace path.
- [x] Add `--broken`, selecting the faulty Counter through the same factory
  seam. Print the real mismatch and exit nonzero. Do not convert expected
  demonstration failure into process success.
- [x] Add `--live`, using `runClientNegotiated` and
  `specFromFiles(tutorialModelPath)` with the existing Counter run profile.
  Document `APALACHE_MC`; absence of the requested tool is an infrastructure
  failure rather than an empty successful run.
- [x] After success, assert every declared action was exercised and print
  the observed action counts. Preserve the original mismatch when reporting
  failure; do not replace it with a coverage failure.

Done: all example commands compile automatically; replay passes, broken replay
fails specifically on implementation state, and live mode reaches the same port.

## T4 — Verify the documented executable

Depends on T3.

Files: create `test/generated-counter.smoke.ts`; include it in
`tsconfig.examples.json` and add a standalone package script for the emitted
`dist-test/test/generated-counter.smoke.js`; update Mirrors'
`tools/interop/run.sh` and `tools/interop/INTEROP.md`.

- [x] Write a standalone acceptance harness that launches the emitted tutorial
  executable from the documented directory. Build both once before the cases.
  Keep the filename outside Jest's `*.test.ts` pattern.
- [x] Assert the correct Counter exits zero with nonempty Initialize/Tick
  coverage. Run supplied-trace replay with Apalache unavailable to prove that
  this tier needs no live generation.
- [x] Assert the faulty Counter exits nonzero and reports the actual
  `step_mismatch` for `tick` and `count`. A missing binary, missing input,
  compilation error, or unrelated exception must fail this acceptance case.
- [x] Run compiler `check`, required-action `preflight`, and source-byte
  comparison as part of the tutorial gate. A stale generated file must be
  detected without repair; exercise that check against a temporary copy.
- [x] Add the tutorial gate to the existing MirrorECMA interop leg and pass
  explicit repository/binary paths. Exercise live mode in the Apalache-enabled
  leg. Retain the current broad Counter and TLS/negative suites.
- [x] Keep new verification focused on the executable the reader runs. Reuse
  existing runner tests for negotiation/factory/disposal edge cases instead
  of duplicating those implementations in tutorial tests.

Done: acceptance exercises the published example, distinguishes a detected SUT
bug from environment failure, and checks artifact provenance and live replay.

## T5 — Rewrite onboarding around the working example

Depends on T4; use the exact commands and diagnostics that passed.

Files: update MirrorECMA `README.md`; create
`examples/generated-counter/README.md`; update relevant MirrorECMA `AGENTS.md`
guidance and add a cross-link from Mirrors `README.md`.

- [x] Put the generated workflow before the low-level quick start and mode
  inventory. Explain model, real implementation, adapter, and comparison using
  the concrete Counter example.
- [x] Show the real implementation and short port mapping, linking complete
  compiled source. Identify generated code and handwritten code explicitly.
- [x] Provide setup from the MirrorECMA root: pnpm dependencies, Mirrors build,
  artifact verification, successful replay, and the deliberate nonzero failure.
- [x] Document full compiler resolve/generate/check/preflight commands in the
  example README. Explain that checked-in evidence bootstraps this example,
  while adapting a new model requires its own contract and structural evidence.
- [x] Explain `paramVars` once, at configuration: parameters are model stimuli;
  `count` is the implementation observation. The generated binding handles wire
  encoding, including arbitrary-precision integers.
- [x] Follow with live Apalache generation and bounded trace coverage. Say
  what a pass establishes, without claiming proof of the application's behavior.
- [x] Move the original callback example under low-level customization and
  preserve the existing API and advanced-mode references.
- [x] Correct only guidance touched by onboarding, including stale command
  descriptions in `AGENTS.md`; avoid unrelated configuration cleanup.

Done: a reader can follow the documented commands without copying code from
test instrumentation or inferring a machine-specific path.

## T6 — Final acceptance and handoff

Depends on T5.

- [x] Run `pnpm run check`, `pnpm run check:model-interface`, and the new
  example check/build commands.
- [x] Run the focused existing negotiated runner, descriptor, and dynamic
  suites. Use `--runInBand --no-watchman` in a restricted environment.
- [x] Run the tutorial acceptance harness against a freshly built Mirrors
  binary, including artifact checks and both correct/faulty implementations.
- [x] Run live mode with an explicit Apalache executable and the existing
  model-interface Counter smoke. Request the environment permissions needed
  for its loopback/mTLS tests if sandbox restrictions prevent execution.
- [x] Review README snippets against the compiled example, check relative
  links, and run `git diff --check` in both repositories.
- [x] Report exact commands, outcomes, and any infrastructure-blocked tiers.
  Keep implementation pending until its required acceptance checks pass.

Deliverable: a focused change to examples, onboarding, and their execution
gates. The user can see which code drives their application, run it, break it,
and reproduce the resulting mismatch.


## Execution evidence — 2026-09-06

All assigned workers completed their owned files; the coordinator reviewed and
integrated the handoffs. No public client or wire interfaces changed.

| Check | Result |
| --- | --- |
| `lake build mirror model_interface_gen` | Passed; pre-existing Lean lint/deprecation warnings |
| Authoritative model comparison | Tutorial source matches Mirrors Counter bytes |
| Compiler `check` and `preflight --require-all-actions` | Clean; 3 states, 1 trace, Initialize 1 / Tick 2, no unseen actions |
| Temporary `resolve` + `generate` | Lock, generated TypeScript, and ownership manifest reproduce shared fixture bytes exactly |
| `pnpm run check`, `check:model-interface`, `check:examples` | Passed |
| Focused runner/dynamic/descriptor Jest suites | 3 suites, 90 tests passed with `--runInBand --no-watchman` |
| `pnpm run example:counter` | Exit 0; Initialize 1 / Tick 2 |
| `pnpm run example:counter:broken` | Exit 1; actual tick/count mismatch, expected 2 / got 1 |
| `pnpm run smoke:generated-counter --live` | Source, artifacts, stale-output no-repair, offline positive/negative, and live generation passed |
| Exact new tutorial block in `Mirrors/tools/interop/run.sh` | Passed after compilation into `.golden-build/ecma-generated-counter`; alternate output/root handling verified |
| Existing `test/model-interface-counter.smoke.ts` | Passed compiled/dynamic stdio, real Apalache generation, authorized mTLS, and authorization negatives |
| README examples and documentation | Eight new TS excerpts match compiled source; corrected low-level snippet type-checks; local links and shell snippets checked |
| Final review | No actionable issues; shell syntax and whitespace checks pass |

Live checks used `APALACHE_MC=/home/nzsn/.local/bin/apalache-mc` in this
checkout; documentation keeps this path configurable. Observed live action
coverage was Initialize 2 / Tick 8; generated traces may vary.

Sandbox-only attempts exposed two environment restrictions: loopback listening
returned `EPERM` in the existing mTLS smoke, and captured Node-child stdout was
absent in the new harness (also reproduced independently). Reruns with the
necessary permissions passed; these were not accepted as assertion failures or
silently skipped successes.

The complete C++/Rust/Haskell interop matrix was not rerun. The changed tutorial
block and existing MirrorECMA negotiated Counter smoke were executed directly.
