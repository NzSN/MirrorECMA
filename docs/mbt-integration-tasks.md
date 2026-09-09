# MBT integration migration — implementation work packages

Status: AH8.1 migration planning draft, 2026-09-09. Runtime migration has not
started. The [MirrorGate ledger](../../MirrorGate/docs/agent-hosting-tasks.md)
is authoritative for assignment, dispatch, dependencies, and completion. All
packages below are assigned to `specification_implementer`; assignment alone
does not establish implemented behavior. This document refines AH8 rather than
creating a second independent project ledger.

The controlling contracts are the [implementation boundary](implementation-boundary-design.md),
[reusable harness design](mbt-harness-design.md), and
[Gate evaluation-service design](../../MirrorGate/docs/evaluation-service-design.md).
Mirrors requires no server, protocol, compiler, or model-semantics changes.
MirrorECMA will not gain a managed-agent author option.

## AH8.1 — Source inventory and migration decisions

The current coupled implementation is real and must be migrated deliberately:

| Existing source | Current responsibility | Target owner |
| --- | --- | --- |
| `src/sandbox.ts` | `evaluateSandboxed`, Gate SDK loading, endpoint/policy types, author callback, preparation, authorization/acquisition, public-port proxy, disclosure and cleanup | Separate trusted integration in MirrorGate |
| `src/sandbox-model.ts` | Descriptor/manifest checks, Gate port schema, public manifest export, generated public-port model adapter, authoring bundle | Separate trusted integration; reuse Gate's public sanitizer where equivalent and retain its validation evidence |
| `src/index.ts` | Root sandbox runtime/type exports | Remove Gate-specific exports only at the documented compatibility cutover |
| `package.json` | Optional `mirrorgate` peer and sandbox example scripts | External integration dependencies/scripts; core has no Gate peer at cutover |
| `test/sandbox-*.test.ts` and `test/sandbox-counter.smoke.ts` | Existing facade, manifest, output, failure, and restricted replay evidence | Move corresponding coverage to external integration before deleting originals |
| `examples/sandbox-counter/`, `tsconfig.sandbox.json` | Gate-specific example and build configuration | External integration example/build configuration |
| `experiments/blind-counter/evaluator.mjs` and author helpers | Current experiment-specific host and evaluator composition | Migrate live entry point to Gate hosting plus external evaluation; preserve historical results |

The existing generic seam is sufficient to start extraction:

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

There are concrete extraction hazards. `sandbox.ts` currently imports
`AsyncNegotiationAuthority` from `negotiation-core.ts` and
`awaitReplayOperation` from `async-replay.ts`; these are not named root exports.
The extracted package must not replace local imports with private deep imports.
Infer the authority through public `AsyncAdapterFactory` types, and implement
integration-owned bounded waits for Gate I/O using public cancellation/deadline
contracts. If an unavoidable generic API gap is found, specify and test it with
both a local implementation and a non-Gate external implementation before adding
any public API. Do not copy MirrorECMA's negotiation/replay state machine.

The authority also contains private configuration and transport access. Gate
receives only its bounded attestation fields, not the complete authority object.
The existing public-port generator includes the `mirrorgate.port/v1` schema;
this extraction does not rename the emitted schema or require a compiler change.

### Packaging and compatibility decision

Use a distinct optional ESM package sourced from
`MirrorGate/integrations/mirrorecma/`, provisionally named
`mirrorgate-mirrorecma`. The package name, exact compatible peer ranges, and
packed declarations must be recorded before AH8.2 edits shared metadata. The
name is a proposed local package identity, not an assertion of registry
availability or publication. MirrorGate's existing core SDK package stays
independent of MirrorECMA. The integration depends only on both public packages.

Migrate in stages:

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

Do not add a root forwarding shim that imports the external package: it would
reintroduce Gate coupling and can produce a package dependency cycle. If a
transition release retains old root exports, the ledger must say that complete
core decoupling is pending. No commit, version publication, or remote release is
implied by these assignments.

## Work packages and exclusive ownership

All filenames listed as new below are proposed locations within the assigned
module. The dispatcher must hand off shared files before edits. Workers preserve
unrelated existing changes and do not expand into other AH tasks.

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
AH12 is optional and does not block AH8.3 or base AH8/AH9 acceptance. Its status
remains separately pending until service-specific checks actually pass.

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

AH8.1 planning completion means the inventory, dependency/ownership decomposition
and migration proposal were reviewed. It is not completion of AH8.2–AH8.5,
AH12, or runtime decoupling. No runtime tests were run for this planning draft.
