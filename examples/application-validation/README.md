# Application validation program

Three small real implementations exercise model-based testing through Mirrors,
including deliberate faults in their SUTs, separate failure controls, and
restricted Gate execution. The applications retain one observation path for
correct and faulty implementations. Compiler outputs and ITF witnesses are
generated, not hand-written expected states.

| Application | Correct replay | Local behavioral mutants | Actual observations |
| --- | --- | --- | --- |
| [WorkQueue](../work-queue/README.md) | 2 traces, 30 transitions | 9 | persisted queue JSON |
| [Persistent transfer](../persistent-transfer/README.md) | 2 traces, 30 transitions | 4 | payload bytes and session journal |
| [Lease service](../lease-service/README.md) | 2 traces, 20 transitions | 4 | live ownership, fencing token, controlled clock and accepted-write count |

Replaying a witness twice checks initialization across traces; it does not add
distinct schedules. A fresh tier asks Apalache to regenerate the deterministic
`WitnessNext` path and replays all mutants again. It checks generation and replay
integration, not additional exploration diversity. `Next` retains the broader
bounded action choices. The two new models also have `Safety` predicates,
separately checked over `Next` through length 5 in the recorded run.

## Prerequisites and build

Use the repository's locked dependencies and Node 24.15.0. Build a compatible
Mirrors `mirror` and `model_interface_gen`; provide explicit paths if the
checkouts are not siblings. Commands below run from the MirrorECMA root:

```bash
export MIRROR_BIN=/absolute/Mirrors/.lake/build/bin/mirror
export MODEL_INTERFACE_GEN=/absolute/Mirrors/.lake/build/bin/model_interface_gen
export APALACHE_MC=/absolute/apalache/bin/apalache-mc
node examples/application-validation/generate-bundles.mjs
node node_modules/typescript/bin/tsc -p tsconfig.json
node node_modules/typescript/bin/tsc -p tsconfig.examples.json
node node_modules/typescript/bin/tsc -p tsconfig.application-validation.json
```

The explicit bundle command publishes checked compiler-owned artifacts from the
reviewed locks; it never seals a proposal or generates traces. The dedicated
generated-code build writes only ignored `dist-validation/`.
MirrorECMA core remains Gate-free. The checked local replay tier needs no running
Apalache process; the fresh tier uses pinned Apalache 0.61.0.

## Local acceptance and receipts

Use new receipt paths; commands create files exclusively with mode `0600`.
Parent directories must already exist. Keep receipts private when using private
models because they contain expected states and mismatch diagnostics.

```bash
node examples/application-validation/run.mjs work-queue --receipt /tmp/queue-new.json
node examples/application-validation/run.mjs persistent-transfer --receipt /tmp/transfer-new.json
node examples/application-validation/run.mjs lease-service --receipt /tmp/lease-new.json

# Fresh model-checker output, then the same complete fault/control matrices:
node examples/application-validation/run.mjs persistent-transfer --live --receipt /tmp/transfer-live-new.json
node examples/application-validation/run.mjs lease-service --live --receipt /tmp/lease-live-new.json
node examples/application-validation/run.mjs work-queue --live --receipt /tmp/queue-live-new.json
```

Each designated fault must produce the pinned first **model mismatch**. A
surviving mutant, action failure, startup error or cleanup failure fails the
acceptance command. Separate controls inject an application exception, a stalled
operation, and caller cancellation. These must classify as failure, timeout and
cancellation rather than behavioral defect detection. Local cleanup uses a
temporary-directory census after disposal; it is not a Gate isolation claim.

Each application now has one [`suite.ts`](../work-queue/suite.ts) declaration
using its static generated `SuiteModel`. The declaration is identical for local
`runSuite` and Gate `evaluateSuite`. Local adapters expose native operations and
one real observation; the compiler bridge converts sets/maps recursively.
Factories import and allocate the SUT only after model admission and transfer
one explicit disposer. Applications do not reconstruct descriptors, choose
registry identity tuples, count attempted operations as matches, or convert
collections themselves.

The v2 aggregate receipts retain the normalized `SuiteResult` and independent
application resource census. Action/pair counters are exact decimal strings
committed only after `step_ok`; failed runs preserve the matched prefix. Queue's
compiled first-mismatch trace coordinate is zero-based, so the old progress
report's traces 1/2 are represented as 0/1. State indices and action labels are
unchanged. The nine original queue fault implementations and the historical
`runQueueAcceptance` helper remain available for comparison; the default CLI
uses the generated suite. The obsolete two-application registry/codec harness was removed after the
installed local and Gate consumer gates passed. Historical receipt summaries
and the original source baseline remain available for comparison.

Regenerate the two new applications' checked artifacts deliberately with
`node examples/application-validation/regenerate.mjs APPLICATION`. Generation
requires Apalache exit 12 at the intentional `TraceComplete` violation, records
model/contract/trace/compiler hashes, publishes both original target and suite
bundle, then runs compiler `check`, `check-bundle` and all-action `preflight`. This helper requires a separate `--output` for WorkQueue so it
cannot overwrite that example's established artifact workflow.

## Real Gate execution and restricted authors

See Gate's [application runner](../../../MirrorGate/integrations/mirrorecma/scripts/application-program-gate.md)
for the exact sibling-checkout command, pinned runtime and admitted operator
profile requirements. Its source tier prepares exact approved files using `node-esm/v1`, without
application build scripts, imports or dependency installation. It checks model
and canary paths are inaccessible during execution, runs the identical declared
suite, and checks physical cleanup independently. General custom-build isolation
remains covered by the backend gates. There are 7 queue cases and
8 cases for each other application: correct, selected behavioral mutants,
actual worker exit, non-cooperative hang and cancellation. Queue's Gate subset
contains duplicate admission, dropped enqueue and stuck retry; its local matrix
contains all nine mutants.

`--host-profile` instead starts a fresh actual managed implementer with an empty
source directory and only the application's `PUBLIC-CONTRACT.md`, compiler-emitted
public kit declarations/manifest, and public tool/environment brief. No model, trace, generated evaluator binding or expected
state is supplied. The submitted source hash must equal preparation's source
hash. Gate remains responsible for physical cleanup. A synthetic host or a
development subagent is not counted as this acceptance.

## Evidence and limits

The [suite migration summary](results/2026-09-16-suite-migration.json) records the
new 29-case local and 23-case Gate matrices and fresh-witness checks. Independent
onboarding measurements and a new restricted managed author were not exercised.
The historical [recorded summary](results/2026-09-16.json) contains observed outcomes,
content identities, durations and source-line counts. The framework
[execution record](../../../Mirrors/Docs/application-validation-program.md)
records commands, test results, delegation limitations and evidence provenance.
Setup and diagnosis time were not independently measured. Relocated-source
reproduction reused the installed dependency tree and tools; it is not a clean
network installation or independent third-party onboarding study.

Passing these small bounded applications establishes tested conformance, not
general application correctness or truthful observation for arbitrary adapters.
The transfer restart drops the service object and reloads completed writes;
it does not kill a process mid-write or prove fsync/power-loss consistency.
Lease calls are serialized explicit client operations; they do not explore
thread races or establish linearizability under arbitrary concurrent execution.
