# MBT integration migration — implementation work packages

Status: the external integration, reusable Counter suite and MirrorECMA 2.0.0
cutover are integrated into the destination checkouts and locally validated.
Hash-verified integration, destination CI with live Apalache, the Gate gates and
installed-consumer acceptance passed. The central cross-client gate also reported `INTEROP MATRIX GREEN`. See [Gate workflow validation](https://github.com/NzSN/MirrorGate/blob/main/docs/managed-workflow-validation.md) for authoritative evidence and
[migration-v2.md](migration-v2.md) for the removal/evidence map. Publication is
separate. The [MirrorGate ledger](https://github.com/NzSN/MirrorGate/blob/main/docs/agent-hosting-tasks.md)
remains authoritative for assignment and final completion. This document retains
the original AH8 planning sequence and acceptance requirements.

The controlling contracts are the [implementation boundary](implementation-boundary-design.md),
[reusable harness design](mbt-harness-design.md), and
[Gate evaluation-service design](https://github.com/NzSN/MirrorGate/blob/main/docs/evaluation-service-design.md).
Mirrors requires no server, protocol, compiler, or model-semantics changes.
MirrorECMA will not gain a managed-agent author option.

## AH8.1 — Source inventory and migration decisions

The pre-2.0 coupled implementation inventory is retained for migration accounting:

| Pre-2.0 source | Former responsibility | Migration owner |
| --- | --- | --- |
| `src/sandbox.ts` | `evaluateSandboxed`, Gate SDK loading, endpoint/policy types, author callback, preparation, authorization/acquisition, public-port proxy, disclosure and cleanup | Separate trusted integration in MirrorGate |
| `src/sandbox-model.ts` | Descriptor/manifest checks, Gate port schema, public manifest export, generated public-port model adapter, authoring bundle | Separate trusted integration; reuse Gate's public sanitizer where equivalent and retain its validation evidence |
| `src/index.ts` | Root sandbox runtime/type exports | Remove Gate-specific exports only at the documented compatibility cutover |
| `package.json` | Optional `mirrorgate` peer and sandbox example scripts | External integration dependencies/scripts; core has no Gate peer at cutover |
| `test/sandbox-*.test.ts` and `test/sandbox-counter.smoke.ts` | Existing facade, manifest, output, failure, and restricted replay evidence | Move corresponding coverage to external integration before deleting originals |
| `examples/sandbox-counter/`, `tsconfig.sandbox.json` | Gate-specific example and build configuration | External integration example/build configuration |
| `experiments/blind-counter/evaluator.mjs` and author helpers | Current experiment-specific host and evaluator composition | Migrate live entry point to Gate hosting plus external evaluation; preserve historical results |

The implemented integration reuses the existing generic seam:

- `AsyncCompiledAdapterRegistry` registers an exact key with
  `AsyncAdapterFactory(config, authority)`, returning `AsyncLocalBinding`.
- `runClientWithTracesNegotiatedWithReport` and
  `runClientNegotiatedWithReport` already defer this factory until a strict
  compiled async match. Retain `execution: "async"`, `request: "verify"`, and
  `policy: "require"` for the Gate path.
- The generated async Counter artifact already provides
  `bindCounterAsyncPublicPort` and its structural `AsyncPublicPort`. Use these
  compiler-owned declarations; never hand-edit or regenerate different semantics
  to accommodate an extraction.
- The generated binding interprets model inputs in the trusted evaluator. Only
  public operation IDs/arguments and actual observations cross the worker proxy.
- A prepared artifact is eligible input to the external factory. An already
  launched evaluation worker is not: that would bypass deferred admission.

The following extraction hazard is historical: the former core `sandbox.ts`
imported `AsyncNegotiationAuthority` from `negotiation-core.ts` and
`awaitReplayOperation` from `async-replay.ts`, neither a named root export.
The extracted package resolves authority through public `AsyncAdapterFactory`
types and owns its bounded Gate I/O waits. It does not deep-import MirrorECMA
internals or copy its negotiation/replay state machine. Any future generic API
gap still requires implementation-neutral specification and local/external
consumer tests before adding a public API.

The authority also contains private configuration and transport access. Gate
receives only its bounded attestation fields, not the complete authority object.
The existing public-port generator includes the `mirrorgate.port/v1` schema;
this extraction does not rename the emitted schema or require a compiler change.

### Packaging and compatibility decision

The locally implemented optional ESM package is `mirrorgate-mirrorecma@0.1.0`,
sourced from `MirrorGate/integrations/mirrorecma/`. It accepts the public
`mirrorgate@0.1.0` SDK and MirrorECMA `^1.0.0 || ^2.0.0`. Its packed JavaScript
and declarations are validated locally; the package remains private and is not
a registry/publication claim. Gate's core SDK remains independent of MirrorECMA.

The original staged migration sequence is retained below as rationale. The
2.0.0 cutover has removed the transitional core exports and optional Gate peer:

1. Add and validate the external package against packed public dependencies.
   Retain existing experimental exports while consumers migrate. This intermediate
   state is still coupled and must be labeled accordingly.
2. Offer the old `evaluateSandboxed` shape from an explicit external
   `mirrorgate-mirrorecma/legacy` entry point for callers needing an import-path
   migration first. Keep it outside the recommended coordinator-to-Gate flow.
   Preserve callback behavior and public result/cleanup semantics there; never
   silently replace an author callback with agent hosting.
3. Migrate all in-tree consumers, scripts, docs and declared downstream fixtures.
   Freeze a migration table mapping existing functions/types to external exports.
   Retain the previous package version as the pin for unmigrated callers.
4. Remove root sandbox exports, source integration modules, and the Gate peer
   only in an explicitly identified breaking release/cutover. Record that version
   decision before removal; do not silently remove current imports in a compatible
   release. Source completion and publishing a release are separate actions.

The original transition retained root exports and therefore remained coupled.
The integrated 2.0 cutover removes them without a forwarding shim, which would
reintroduce Gate coupling or a package dependency cycle. Version publication
or a remote release is not implied by the implementation assignments.

## Work packages and exclusive ownership

The table preserves the original assignment boundaries and planned filenames.
For implemented locations, use the [migration map](migration-v2.md): Gate owns
`src/{sandbox,sandbox-model,provider,workflow,receipt}.ts`, `/legacy`, the moved
suites and installed-package matrix driver; MirrorECMA owns
`examples/mbt-counter/` and the core package-boundary checks. Further edits still
require an ownership handoff and must preserve unrelated changes.

| ID | Responsibility and owned files | Dependencies / handoff |
| --- | --- | --- |
| AH8.2 | Extract integration: new MirrorGate `integrations/mirrorecma/package.json`, `tsconfig.json`, `src/{index,model,provider,lifecycle,legacy}.ts`, `test/{model,provider,lifecycle,legacy,package-consumer}.test.*`, and integration README. Read current MirrorECMA sandbox modules; preserve originals until cutover. | Reviewed AH8.1 package/migration decision and AH1 owner/admission contract; managed-host consumption waits for AH5/AH6. AH6/AH11 explicitly release any shared Gate package metadata before edits. |
| AH8.3 | Reusable Gate-free Counter suite: new MirrorECMA `examples/mbt-counter/{suite,local-provider,run}.ts`, `test/mbt-counter.test.ts`, `test/mbt-counter.smoke.ts`; scoped `tsconfig.examples.json`, `package.json` scripts, and tutorial documentation. | AH8.1 semantic seam; can proceed independently of AH5/AH11/AH12. Reuse existing generated async Counter fixture. Hand package metadata to AH8.5 after this package completes. |
| AH8.4 | Coordinator-to-Gate experiment and external harness composition: new integration `examples/counter/` provider/runner; MirrorECMA `experiments/blind-counter/{evaluator.mjs,evaluator.test.mjs,README.md,evaluator-config.example.json,operator-config.example.json}` and scoped `make-policy.mjs` migration. | AH8.2/AH8.3 and integrated AH5/AH6/AH11 hosted flow. Hosting tool/evaluator share the AH1-approved owner connection. AH3 owns runtime helper promotion; no concurrent edits to author-host files. |
| AH8.5 | Compatibility cutover and semantic regressions: MirrorECMA `src/{sandbox,sandbox-model,index}.ts`, scoped generic comment corrections in `src/adapter-registry.ts`, `package.json`, `pnpm-lock.yaml`, `package.bazel.json`, `tsconfig.sandbox.json`, moved sandbox tests/examples, new `test/package-boundary.test.*`, and scoped CI/docs migration. | AH8.2/AH8.3/AH8.4 validated, export/version cutover recorded, explicit source/package ownership handoff. AH9 owns final independent cross-repository acceptance. |

AH8.2 and AH8.3 can use existing non-hosted prepared submissions to prove the
factory seam while hosting work proceeds. They cannot claim managed hosting
acceptance. AH8.5 must inventory additional references with `rg` before moving
files and include every affected consumer; discovered ownership conflicts go to
the coordinator, not an unassigned broad refactor.

### AH8.2 acceptance — external deferred factory and cleanup

Implement a provider scope that retains the existing owning Gate connection and
prepared artifact. It supplies a public async factory to the shared harness; it
does not allocate an evaluation worker during scope creation. In the matched
factory, validate current cancellation/deadline, construct Gate's bounded
attestation, authorize/acquire/connect, and create the trusted generated binding
over the implementation proxy.

Provider/factory ownership must cover all paths:

- Before factory invocation, the provider owns preparation and session cleanup.
  Model mismatch, invalid registration, transport failure and early cancellation
  still close its resources, with zero evaluation-worker launches.
- A factory that throws cleans partial reservations/connections. A returned
  binding transfers normal per-binding disposal to MirrorECMA; make release
  idempotent and invalidate any captured proxy after closure.
- Cancellation while a factory resolves cannot leave a late worker alive. Await
  bounded cleanup independently of the already-aborted replay signal.
- Final provider cleanup joins Gate's session outcome and then releases the
  owner connection. An agent-visible reference does not permit another client
  connection to adopt the session. Owner disconnection is failure, not reconnect.
- Retain MBT outcome and cleanup outcome separately. A passing model result with
  failed/unconfirmed cleanup is not a fully successful external evaluation.
- Keep private diagnostics, model states/configuration and trace coordinates out
  of author context, worker context, and public result projections.

Preserve existing manifest cross-checks, byte/structural limits, source/artifact
identity checks, output truncation, diagnostic-failure bounds, cancellation,
cleanup reporting, and correct/faulty replay evidence in the moved tests.

### AH8.3 acceptance — one suite, source tests and CLI

The suite exports an application function accepting model transport/configuration,
trace selection, generic cancellation/deadlines and a deferred implementation
factory. It constructs the exact compiled async selection and invokes ordinary
MirrorECMA. No Gate endpoint, policy, profile, author prompt, artifact lease or
service request appears in the suite contract. Its import has no execution side
effects; wrappers own invocation and process exit behavior.

Use one approved Counter suite and configuration for a normal test-runner entry
point and a CLI. A correct local implementation passes; a deliberately faulty
implementation fails both with equivalent semantic mismatch details. Test the
same suite with an external public-port implementation using the existing
generated binder; distinguish proxy behavior evidence from actual sandbox
isolation. Run real generated-binding/Mirrors replay in the smoke tier rather
than replacing it with handwritten state comparison.

The CLI maps mismatch to nonzero status; the source-test wrapper fails its test.
Cancellation and disposal retain generic MirrorECMA behavior. Support a supplied
connection to the existing Mirrors server; closing that evaluation transport
must not stop the shared server. Neither Gate installation nor optional service
startup is required for local tests or CLI use.

### AH8.4 acceptance — hosted implementation consumed by the same suite

The coordinator calls Gate's SDK or supplied hosting tool directly. After approved
brief delivery, authoring, submission and restricted preparation, the trusted
integration supplies the prepared provider to AH8.3's unchanged suite. Use one
Gate owner connection under the reviewed AH1 embedding contract. Do not reconnect
using a serialized handle or launch a second owner for evaluation.

Check correct/faulty implementation behavior with actual restricted build and
execution, match failure with zero evaluation-worker launches, source/artifact
correlation, and cleanup after pre-factory failure. Use synthetic private canaries
in authoring/build/adapter initialization checks. The implementer must not replace
the approved suite revision or observe private traces. Historical
`experiments/blind-counter/results/2026-09-08/` evidence remains historical and
unchanged; it does not certify the new host or migrated flow.

### AH8.5 acceptance — complete boundary and consumer verification

From a packed MirrorECMA-only installation with neither Gate package nor tool
present, compile declarations and run local generated MBT, mismatch, cancellation
and report tests. Inspect root/transitive declarations, imports and package
metadata: no Gate dependency, session/build/hosting types or Gate frame decoder
may remain in the target core. Generic factory types and generated public-port
contracts remain supported. A remaining legacy root export means full decoupling
is incomplete, regardless of passing ordinary imports.

From isolated packed dependencies, compile/run the external integration and
legacy import migration. Check both ESM JavaScript and TypeScript consumers.
Gate-only SDK consumers must still work without MirrorECMA. Run moved failure
suites and real proxy tests; do not delete coverage merely because paths changed.
Documentation must distinguish transitional exports from final core behavior.

## AH12 handoff — optional evaluation access

AH8.3 hands AH12 the same reusable suite entry point, frozen suite identity and
configuration rules, factory seam, and semantic-result fixtures. AH8.2 supplies
provider lifetime and cleanup rules. AH12 wraps that suite; it does not clone the
MBT logic or add RPC/service semantics to MirrorECMA.

AH12 must first specify versioned start/query/cancel correlation, caller-scoped
references, suite/implementation authorization, duplicate/lost-start recovery,
retention and cleanup status. Requests carry approved references, not JavaScript
functions, arbitrary host paths, model text or raw Gate handles. Compare service
outcomes with source-test/CLI outcomes for the same fixed inputs, and test private
suite replacement, disclosure, disconnect/cancel races and bounded output.
AH12 is optional and does not block AH8.3 or base AH8/AH9 acceptance. Its
loopback service/proxy and installed same-suite acceptance have passed in Gate.
Service deployment/publication remains separate from this local validation.

## Validation and completion evidence

At implementation time, record exact commands, revisions, exit codes and skips:

- MirrorECMA: `pnpm run build`, `pnpm run check`, `pnpm test`,
  `pnpm run check:examples`, new shared-suite smoke, and
  `MIRRORS_ROOT=<checkout> pnpm run ci` using its pinned toolchain requirements.
- External integration: packed-package JS/declaration consumer checks, moved
  facade/model/failure tests, source-test/CLI/proxy semantic equivalence, and the
  real Linux/Bubblewrap Counter gate.
- Gate: relevant new hosting/owner-handoff gates and required build/test scripts;
  AH9/AH10 own final integrated evidence and compatibility updates.
- Check compiler-owned artifacts using the existing matching compiler workflow
  when generated artifacts are touched; this task does not request emitter edits.
- Run cross-client gates when affected public facades require them and report
  unavailable isolation/model-service checks as unverified, never as passes.
- Both edited repositories: `git diff --check`, destination diff/status review,
  and working relative documentation links.

The original AH8.1 planning review did not establish runtime completion. The
subsequent integrated implementation has core-only packed consumers, moved
integration suites, reusable Counter replay and managed-workflow evidence.
Destination live CI and Gate/integration/42-row matrix gates passed. Full
cross-client interop also passed; the authoritative validation/task ledgers
record the final result. No published release or hosted-CI result is implied.
