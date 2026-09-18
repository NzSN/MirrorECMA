# Landing Shared Sandbox Orchestration in MirrorECMA

The 2.0 source cutover moves the Gate-specific facade and TypeScript acceptance
consumer to `MirrorGate/integrations/mirrorecma/`; see [migration-v2.md](migration-v2.md).
The earlier placement, commands and dated results below are historical. The
current 42-row driver retains its scenarios and evidence schema while importing
installed public packages. [Final destination validation](https://github.com/NzSN/MirrorGate/blob/main/docs/managed-workflow-validation.md)
passed, including actual managed hosting; package publication remains separate.

Status: **historical pre-2.0 landing design**. The body below preserves the
original ownership, file layout and planning language. Use the
[migration guide](migration-v2.md) and current Gate integration for implemented APIs.
Baseline: MirrorECMA `89fbd14`, MirrorGate `a377341`, Mirrors `acc3d9d`.
The baseline below records the pre-implementation audit. Current local, hosted,
and release evidence is tracked separately in
[the acceptance ledger](shared-orchestration-acceptance.md); this design alone
is not a support claim.
This document implements
[client guide §13](https://github.com/NzSN/Mirrors/blob/main/Docs/client-implementation-guide.md#13-shared-sandbox-orchestration-profile)
through the proposed
[MirrorGate control v1 contract](https://github.com/NzSN/MirrorGate/blob/main/docs/orchestration-control-v1.md).
Behavioral explanations use
[PFPL-style semantic notation](https://github.com/NzSN/Mirrors/blob/main/Docs/semantic-notation.md).

The accepted [implementation boundary](implementation-boundary-design.md)
supersedes this document's placement of Gate-specific orchestration inside
MirrorECMA. The sections below record the existing experimental landing and its
historical contracts/evidence; they do not define the revised target core API.
MirrorECMA 2 now retains implementation-neutral MBT. The coordinator talks
directly to Gate; Gate-aware composition resides in `mirrorgate-mirrorecma`.
Extraction, consumer migration, managed hosting and the optional loopback service
are implemented and validated. The remaining sections record the earlier landing.

## 1. Result to deliver

A trusted TypeScript caller invokes one `evaluateSandboxed` entry point with
a submission, compiled model, replay request, and trusted policy. The facade
starts a compatible local MirrorGate process or attaches to a configured one,
prepares the submission through Gate, negotiates with Mirrors, creates a native
port proxy to an admitted worker, runs replay, and awaits Gate cleanup.

MirrorGate implements the shared workflow. MirrorECMA implements its native
interface and trusted model driver. The implementation must not embed a Node
evaluator as a prerequisite for C++ or other client languages.

The first advertised profile supports:

- Linux `linux-bubblewrap-v1`, with owned-stdio and attached-Unix control;
- prebuilt artifacts and source/build preparation, with optional restricted
  authoring before submission;
- `node-v1` and `rust-v1` execution workers, independently selected from the
  TypeScript facade language;
- compiled model-interface `verify` with `policy = require`;
- both `register` and `register_traces` through the existing Mirrors transport;
- one worker per evaluation session, reset by initializers across traces;
- explicit cancellation, bounded teardown, and a fixed disclosure policy.

Dynamic-descriptor sandbox evaluation, remote Gate control, resume/reconnect,
Windows/macOS isolation, and aggregate cgroup quotas are outside this first
profile. Existing ordinary client modes remain available with their current
behavior. Unsupported requested capabilities fail before preparation or launch.

## 2. Historical starting point and landing prerequisites

The existing
[negotiated runner](https://github.com/NzSN/MirrorECMA/blob/89fbd14d6da84c8b755a08abcaf65b6f4ec67192/src/negotiated.ts#L492)
already performs exact selection, strict first-reply validation, binding
construction after acceptance, and cleanup. Its replay computer is synchronous:
[StateComputer](https://github.com/NzSN/MirrorECMA/blob/89fbd14d6da84c8b755a08abcaf65b6f4ec67192/src/protocol.ts#L20)
returns `State`, and the
[loop](https://github.com/NzSN/MirrorECMA/blob/89fbd14d6da84c8b755a08abcaf65b6f4ec67192/src/replay.ts#L54)
does not await a computer result.

The current MirrorGate evaluator example requires async/report exports and
generated artifacts absent from this MirrorECMA revision. The section-13 audit
observed 37 existing negotiation-runner tests passing, followed by integration
startup failure at the missing generated async Counter module. This is a
baseline result, not evidence for the proposed facade.

Landing therefore requires three coordinated changes: a shared Gate control
implementation, additive async/report support and generated async bindings,
and the native facade over those two interfaces. Repairing the example import
alone cannot implement §13.

## 3. Ownership and dependency graph

| Module owner | Owns |
| --- | --- |
| MirrorGate | Control schemas and fixtures, preparation state transitions, immutable artifact leases, backend admission, managed worker transport, cancellation and forced cleanup |
| Mirrors | Existing model protocol/comparison and a new deterministic async TypeScript emission profile |
| MirrorECMA | Strict required negotiation, native async generated binding, projection/encoding, replay, structured reports, and the TypeScript facade |
| Trusted evaluator/caller | Private models, approved public implementation brief/manifest, and result disclosure |
| Planned MirrorGate agent host | Fresh implementer launch/configuration, injected approved context, restricted tools, model credential handling, and lifecycle cleanup |
| Worker shim and submitted adapter | Worker-v1 protocol and actual SUT operations inside the restricted environment |

```text
TypeScript caller
  ⟶ MirrorECMA evaluateSandboxed
      ⟶ Gate control v1 ⟶ shared preparation / admission / resource ownership
      ⟶ trusted replay driver ⟷ Mirrors model protocol
      ⟶ generated async binding ⟶ native public-port proxy
                                      ⟷ managed worker-v1 transport
```

Control, model messages, and worker frames use separate transports and codecs.
The native proxy never forwards a `StateComputer` call, raw initial state,
previous state, private trace coordinate, specification, or credential.

MirrorECMA uses Gate's public SDK entry points, proposed as
`mirrorgate/control` and `mirrorgate/worker`. It never imports
`conformance/helpers.mjs` or a private MirrorGate file by a sibling path.
The Gate package is currently private; creating and testing those distribution
artifacts is a prerequisite, not an assumed existing dependency.

## 4. Native evaluation interface

The following are proposed semantic interface types. Concrete TypeScript
declarations must preserve them without exposing control-SDK implementation
types in the existing root declarations:

```text
GateEndpoint ≜ Sum[
  owned:Prod[launcher:TrustedGateLauncher, policyFile:TrustedPolicyFile],
  attached:Prod[socketPath:TrustedSocketPath, expectedOwner:HostUid]]

ReplayRequest ≜ Sum[
  generate:Prod[target:MirrorTarget, config:ApalacheConfig,
                traceConfig:TraceGenerationConfig, spec:Option[ApalacheSpec]],
  traces:Prod[target:MirrorTarget, config:ApalacheConfig,
              tracePaths:Seq[PrivateTracePath]]]

EvaluationPlan ≜ Prod[
  gate:GateEndpoint, policyId:PolicyId, submission:Submission,
  runtime:WorkerRuntime, model:SandboxCompiledModel,
  replay:ReplayRequest, deadlines:EvaluationDeadlines,
  author:Option[AuthoringSession → Comp[1]],
  disclosure:TrustedDisclosurePolicy]

Γ ⊢ plan : EvaluationPlan
────────────────────────────────────────────────────────────
Γ ⊢ evaluateSandboxed(plan, options) ÷ PublicEvaluationResult
```

`Submission` is the Gate-owned source/prebuilt sum in the control contract.
`TrustedGateLauncher` selects an installed executable and fixed launch
arguments; it performs no download. `MirrorTarget` is the existing Mirrors
binary/transport choice, not a Gate endpoint. The worker runtime is independent
of the generated-binding target profile.

The native entry returns a promise, accepts an `AbortSignal`, and optionally
accepts a trusted diagnostic sink. It returns only after session cleanup is
confirmed or its bounded failure is recorded. An already-aborted signal causes
zero preparation, Gate session, and execution-worker allocation.

`EvaluationDeadlines` has positive integral `registrationMs`, `stepMs`, and
`receiveMs` fields. They are client wait budgets, separate from Gate's session,
execution, and cleanup limits. Default registration/receive budgets are
60 seconds and the default step budget is 10 seconds; a trusted caller may
adjust them within its policy. Expiry aborts the flow rather than retrying it.

The first facade uses one control connection per evaluation. Attaching several
evaluations to one daemon shares the Gate implementation while keeping their
connection ownership separate. It serializes the approved public manifest into
the contract's `manifestJson` field and records Gate's frozen manifest hash;
that hash is not substituted for the model-interface digest.

The optional `author` callback runs in the trusted host and receives only a
restricted tool-session interface. It does not receive a raw Gate client,
session constructor, policy file, worker endpoint, or private replay data.
The host must configure its agent's other tools and context consistently.
Gate independently seals authoring when preparation begins, including late
requests from an author callback that has already returned.

A managed-agent variant of this `author` callback is no longer planned.
The coordinator supplies public authoring inputs directly to Gate. The external
integration retains Gate ownership and supplies only a generic implementation
binding to MirrorECMA. See the [migration contract](implementation-boundary-design.md#versioned-coupling-removal)
and [execution restrictions](implementation-boundary-design.md#information-and-execution-restrictions).

Each restricted `exec` result includes `exitCode`, Gate's actual
`stdoutBytes`/`stderrBytes` receipts, UTF-8 `stdout`/`stderr`, and independent
truncation flags. MirrorECMA subscribes to the public Gate event stream before
dispatch, accepts only `authoring.output` for the returned operation ID, and
retains at most `SANDBOX_AUTHORING_OUTPUT_BYTES` (65,535) raw bytes per stream.
It removes the listener when the command settles or authoring is sealed. A
nonempty receipt without a complete correlated event stream fails closed; a
legacy test double without `onEvent` remains usable only for zero-output
commands. Only one authoring command may be in flight in an evaluation.

Its public authoring bundle contains the sanitized manifest, the worker
adapter interface, and approved public declarations/examples. It does not
contain the full generated model-facing binding or normalized private
contract: those can include wire labels, projections, and source identity.
Any public declaration file is prepared from the approved public contract
before evaluation, not generated from a received runtime descriptor.

`SandboxCompiledModel` contains verified generated metadata, the complete
normalized contract, an exact local adapter key, and a reviewed generated
binding constructor. It contains no real SUT constructor. For this facade,
the only port implementation supplied to that constructor is the managed
worker proxy. The submitted SUT/adapter entry is selected by Gate's approved
runtime/build plan inside the frozen artifact, not by received model metadata.

## 5. Async replay is additive

Keep `src/protocol.ts` and the existing `StateComputer` contract unchanged.
Add a separate async interface, whose raw model arguments remain trusted:

```text
ReplayInput ≜ Prod[action:Str, payload:State, previous:State]
ReplayContext ≜ Prod[signal:AbortSignal, deadline:MonotonicInstant]
AsyncStateComputer ≜ ReplayInput × ReplayContext → Comp[State]

AsyncLocalBinding ≜ Prod[
  semanticDigest:SemanticDigest, computer:AsyncStateComputer,
  assertCompatibleConfig:EffectiveConfig → Comp[1],
  coverage:Option[1 → Comp[Coverage]], dispose:1 → Comp[1]]
```

Its TypeScript interpretation returns `Promise<State>`. The synchronous type
is not widened to `State | Promise<State>`, and a cast is not an adapter.

Introduce `AsyncCompiledAdapterRegistry` alongside the existing registry.
Both reuse one private, pure exact-key selection implementation. Existing
`CompiledAdapterRegistry` callers retain their types and behavior. The exact
key remains `{semanticDigest, adapterId, targetProfile,
stateComputerContractVersion}`.

The new profile identities are:

| Axis | Proposed value |
| --- | --- |
| Generated target profile | `mirrorecma-async-v1` |
| Computer contract | `mirrors.async-state-computer/v1` |
| Descriptor/contract schemas and semantic digest | Existing identities, unchanged by choosing async emission |
| Worker runtime | Independently `node-v1` or `rust-v1` |

Export `MIRRORECMA_ASYNC_TARGET_PROFILE` and
`ASYNC_STATE_COMPUTER_CONTRACT_VERSION` for these two new client identities.
Keep the existing synchronous constants unchanged.

New report entry points are `runClientNegotiatedWithReport` and
`runClientWithTracesNegotiatedWithReport`. Their compiled selection accepts
the appropriate synchronous or async registry through an explicit execution
variant. The sandbox facade selects only the async variant and forces
`verify/require`; it exposes no fallback factory or `prefer` option.

The new selection discriminator is `execution: "sync" | "async"`. Each
alternative contains the existing metadata/key/policy fields and its matching
registry type. An execution/profile/contract mismatch fails before a factory
is invoked. Existing runner selections do not acquire this new required field.

Refactor registration/first-reply validation into a private module shared by
old and new runners. It returns the validated reply, the same connection and
iterator, and a session-local authorization witness. It never reads a queued
`initial_state` into application dispatch before validating that first reply.
Do not reconnect or register again when the facade acquires its worker.

Use one replay transition implementation with separate execution adapters:

```text
StepResult ≜ Sum[ready:State, pending:PromiseState]

synchronous driver ⟶ ready(state) ⟶ immediate encode/send
async driver       ⟶ pending(p) ⟶ await/check cancellation ⟶ encode/send
```

The synchronous path introduces no new await between calling `compute` and
encoding its returned state. Legacy wrappers preserve existing outbound
bytes, return values, error formatting, and cleanup behavior. New wrappers
construct structured reports from the same accepted messages. A compatibility
suite must check these properties before the shared loop replaces the old one.

Include a synchronous computer that schedules a microtask to mutate its
returned state: encoding must still occur before that microtask, as it does
today. This catches an accidental always-async normalization of the old path.

For async execution, permit one callback at a time. Validate all inputs before
invocation, await one action and one observation, encode once, then update
coverage. Hold the reentrancy guard across every await. An error or abort
poisons the binding; attach rejection handlers to late promises but never
observe, report, or continue after cancellation. `Promise.race` alone is not
termination of the SUT: Gate supplies the physical stop deadline.

## 6. Deterministic generated async bindings

Add `mirrorecma-async-v1` to `model_interface_gen` target dispatch in Mirrors.
Use a separate async emitter over shared type/name/codec lowering. The old
`mirrorecma-v1` generated tree must remain byte-identical for an unchanged lock.
Do not introduce an arbitrary target-language AST or hand-edit generated files.

The semantic async port is:

```text
PortAsync(M) ≜ Prod[
  a : InM(a) × PortContext → Comp[1]    for each initializer or transition a,
  observe : PortContext → Comp[ObsM]]

PortContext ≜ Prod[signal:AbortSignal, deadline:MonotonicInstant]
```

Native no-input methods take only `context`; other methods take `input,
context`. Observation takes `context`. These are local capabilities: the
proxy encodes only the frozen worker-v1 request fields. An AbortSignal, its
reason, deadlines, model coordinates, and replay context are never serialized
into an extra worker context object.

The emitter keeps the existing projection, type, observation, poisoning, and
coverage rules. Awaiting changes the native effect interpretation, not model
identity or the comparison schema. Record the new target profile in the
generated ownership manifest and local registry key, not the semantic digest.

Generate Counter async artifacts under
`test/fixtures/model-interface/counter/generated-async/` and check them using
the real compiler. Build the proxy mechanically from the verified sanitized
manifest: stable IDs identify port operations, while native field-name
lowering and ITF conversion remain in trusted generated/client code.

Reuse the existing reviewed public-manifest exporter and native-value
conversion as the starting point for public Gate SDK functions. Export only
verified source identity plus approved port IDs/types. Preflight the complete
manifest and target representation before preparation: `opaqueItf`, non-string
map keys, excessive depth/bytes, or any unsupported path/type fail locally.
No runtime source generation or descriptor-named executable loading is added.

## 7. Evaluation command and authority handoff

```text
preflight ← validatePlanAndModel(plan);
withGate(plan.gate, preflight.requiredCapabilities; gate.
  withGateSession(gate, preflight.controlPlan; σ, session.
    _ ← runOptionalAuthor(plan.author, restrictedTools(session));
    prepared ← session.prepare();
    withRequiredReplay(plan.replay, plan.model.metadata; replay, k.
      authority ← session.authorize(prepared, attest(k));
      withManagedWorker(session, authority; worker.
        withAsyncBinding(plan.model, nativePort(worker); binding.
          _ ← checkBindingIdentityAndConfig(binding, plan.model, plan.replay);
          runReplay(replay, binding.computer)))))
```

`k : Matched(σ,ι)` is introduced only by strict required negotiation for this
evaluation's connection and interface. `attest(k)` uses the prepared revision
and one-use Gate challenge; it includes the verified identity/registry axes
but no raw Mirrors reply, config, trace, expected state, or credentials.
Only the private runner-to-facade continuation can form this attestation.

The binding factory begins after that witness exists. It asks Gate to reserve
a worker, attaches to its private managed transport, and validates worker
`hello/create` before constructing the generated async binding. Gate checks
its own recorded admission and authorization again before physical launch.
Native pre-main code is therefore also behind successful required negotiation.

MirrorECMA cannot make Gate independently prove the model exchange without
changing the trust design. The attestation is from the trusted replay driver;
Gate enforces its correlation, ownership, and lifecycle. Do not replace that
assumption with an invented claim that a digest authenticates the caller.

The native facade stores handles, pending operations, and closed flags. It does
not reproduce Gate's stage-transition table, decide how to freeze/build an
artifact, or issue a raw subprocess fallback. Server rejection is authoritative.

## 8. Worker proxy and one cleanup authority

Use the proposed managed mode of Gate's `WorkerClient`. It retains framing,
correlation, value checks, and worker lifecycle validation, while its transport
termination delegates to the owning Gate session. It never receives the
supervisor's command line or owns a process handle.

The full binding factory has a cleanup scope before requesting a worker.
Partial attach, handshake, proxy construction, generated-binding construction,
and compatibility-check failures all release the partially acquired worker
through that same session. Returning the binding transfers the scope's release
obligation into its disposer; an outer session close is an idempotent backstop.

On an ordinary terminal path, the binding stops accepting callbacks, requests
Gate release, and attempts one worker `dispose` only when the shared cleanup
mode permits it. On timeout/cancellation with a possibly running callback,
it requests cancellation and lets Gate enforce termination. It does not race
an observer/disposer against the interrupted action.

The facade awaits Gate's cleanup result before settling. It closes owned
Mirrors/control/worker connections and then an owned Gate process. An attached
daemon remains running. If Gate is unreachable, report cleanup unconfirmed;
do not guess completion or create a second client-side process-kill loop.

Cancellation also interrupts a pending model registration/receive by closing
that evaluation's Mirrors transport. A transport that owns a Mirrors child
must await its bounded close/termination result; an attached Mirrors daemon
is never terminated. This is the existing model-transport owner's obligation,
separate from Gate's exclusive ownership of execution workers. Failure to
confirm owned model-process cleanup is retained as a cleanup failure. Test
silent registration and delayed model replies as well as pending worker calls.

```text
finish(fail(primary), cleanupFail(secondary)) = fail(primary)
finish(ok(report), cleanupFail(secondary))    = fail(cleanupFailure(secondary))
```

Both outcomes retain bounded trusted diagnostics. A cleanup failure cannot
replace an earlier model mismatch, negotiation error, application failure, or
cancellation. A model pass with incomplete cleanup is not a successful overall
sandbox evaluation.

## 9. Reports and disclosure

Compiled execution report runners produce a trusted `CompiledReplayReport`: completion status,
accepted trace/step counters, stable action coverage, and bounded diagnostic
references. `ReplayMismatchError` stores the parsed expected/actual/hints plus
private trace/action coordinates; other failures retain their own family.
Legacy wrappers continue to produce the existing public error behavior.

The sandbox facade's default public result is restricted:

```text
CleanupStatus ≜ Sum[confirmed:1, failed:1, unconfirmed:1]
PublicEvaluationResult ≜ Sum[
  passed:Prod[runId:OpaqueRunId, cleanup:Singleton[confirmed]],
  mismatch:Prod[runId:OpaqueRunId, cleanup:CleanupStatus],
  failed:Prod[runId:OpaqueRunId, family:PublicFailureFamily, cleanup:CleanupStatus],
  cancelled:Prod[runId:OpaqueRunId, cleanup:CleanupStatus],
  timedOut:Prod[runId:OpaqueRunId, cleanup:CleanupStatus]]
```

The cleanup tag exposes operational completion without replacing the primary
model outcome. `confirmed` also covers a preflight failure with no resources
allocated. A model pass with failed/unconfirmed cleanup uses the `failed`
alternative, never `passed`.

No private paths, expected/actual states, hints, trace coordinates, model
revision, or raw worker errors are included. A trusted policy can release
additional fields explicitly; an agent request cannot select that policy.
Detailed reports go to an evaluator-owned bounded sink outside all public
mounts. Sink errors are retained as diagnostics and never cause a mutation to
be retried.

Keep failures for control compatibility, capability/backend admission,
preparation/build, model negotiation, worker protocol/transport, application,
timeout/cancellation, model mismatch, and cleanup distinct. A missing Gate
executable or SDK fails before preparation. Neither failure permits the facade
to call the SUT in the evaluator process.

Invalid local model/configuration/registry selections have a separate
`configuration` family. The trusted evaluator's disclosure policy determines
the public view; it is not a second implementation of Gate's sandbox policy.

In current callback integrations, the external agent host must expose only
approved authoring tools and results, mediate every other access-capable tool,
and exclude private context. The planned Gate host takes over that implementation.
In the revised target, the coordinator injects the brief directly through Gate's
hosting interface; that responsibility is outside MirrorECMA. Type checks and sandbox
access tests do not prove honest observations or eliminate inference from
permitted inputs and verdicts.

## 10. Files, packaging, and compatibility

The following paths are planned ownership assignments:

| Repository / module | Responsibility |
| --- | --- |
| MirrorECMA `src/async-replay.ts` | Async computer/context types and execution adapter |
| MirrorECMA `src/replay-core.ts` | One replay transition implementation with synchronous-ready and async-pending paths |
| MirrorECMA `src/replay-report.ts` | Structured report and error mapping; bounded trusted diagnostics |
| MirrorECMA `src/negotiation-core.ts` | Existing strict first-reply authorization extracted without behavior changes |
| MirrorECMA `src/adapter-registry.ts` | Shared pure key/selection logic; synchronous and async public wrappers |
| MirrorECMA `src/sandbox.ts` | `evaluateSandboxed`, Gate SDK loading, policy/disclosure composition |
| MirrorECMA `src/sandbox-model.ts` | Verified generated model and native public-port construction |
| MirrorECMA `src/index.ts` | Additive exports; preserve existing entry points |
| MirrorECMA `tsconfig.sandbox.json`, `examples/sandbox-counter/`, `test/sandbox-*.test.ts` and `test/sandbox-counter.smoke.ts` | Explicit async-artifact compilation, facade tests, and a standalone real-backend Counter gate |
| Mirrors `Shell/ModelInterface/Emit/TypeScriptAsync.lean` and shared lowering | Deterministic async target, preserving existing targets |
| Mirrors `Shell/ModelInterface/Compiler.lean`, `tools/ModelInterfaceGen.lean` | Target dispatch and CLI/golden checks |
| MirrorGate control modules / public SDKs | The shared protocol and lifecycle implementation specified in its contract |
| MirrorCPP native facade and Gate C++ SDK | Second client-language acceptance path, with no MirrorECMA runtime dependency |

Expose new async/report/sandbox types outside `src/protocol.ts`. The core
client keeps its existing runtime dependencies. Gate's SDK is an optional
peer, dynamically loaded only when sandbox evaluation is requested. Public
MirrorECMA declarations must not force ordinary consumers to resolve optional
Gate SDK types. Test root imports and existing deep imports without Gate
installed; do not introduce a restrictive exports map as an incidental change.

Release the Gate SDK/control executable compatibility pair before enabling a
released facade. Development gates consume packed SDK artifacts at explicit
revisions, rather than undeclared sibling imports. Record the exact Node,
Python, Rust, compiler, backend, and runtime-tree versions used by acceptance;
do not infer them from an SDK package version.

The first profile replaces the current Counter integration's private helper
imports and undeclared async dependencies. The queue example is a later,
explicit fixture task; its absent artifacts must not be hidden by a skip in a
test advertised as passing. Counter alone can establish the first profile's
real correct/faulty-SUT path when the full matrix below is satisfied.

Update that integration to use `AsyncCompiledAdapterRegistry`,
`execution: "async"`, and the public managed SDK. Its compile step must include
`generated-async` through the new sandbox configuration; merely adding an
unreferenced source file to the old
`tsconfig.examples.json` tree does not produce the module it imports. Add
`check:sandbox` and `smoke:sandbox` package commands with explicit prepared
Mirrors/Gate paths. Required sandbox CI treats missing dependencies or an
unavailable backend as failures, while ordinary client checks remain independent.

## 11. Landing sequence and exit gates

Each step is a focused, independently reviewable change. Every step preserves
the existing gates; enabling a support claim is the final step.

| Step | Owner / change | Required exit evidence |
| --- | --- | --- |
| L1 | MirrorGate: freeze control v1 schemas, states, errors, bounds, ownership and transcript fixtures | Strict decoders agree; illegal phases, duplicate IDs, foreign handles, limit edges and cleanup joins have fixed expected outcomes |
| L2 | MirrorGate: shared controller, preparation, broker and managed Node SDK | Actual backend tests for authoring/build/execution; no unrestricted fallback; cancellation/EOF/partial construction bounded |
| L3 | MirrorECMA: shared negotiation/replay core, additive async registry and report runners | Existing 37 runner cases and full legacy suites remain green; no changed golden bytes/errors; async order, reentrancy, late completion and failure precedence tests |
| L4 | Mirrors: deterministic async TypeScript target and Counter artifacts | `resolve/generate/check/preflight`, async generated-module compilation, recording-port order, old-target byte identity, and real negotiated correct/faulty Counter replay |
| L5 | MirrorECMA: native facade over the public Gate SDK surface | SO1–SO11 acceptance with owned and attached processes, both supported worker runtimes, private canaries and zero launch on failed negotiation |
| L6 | MirrorCPP/Gate: native C++ facade and shared acceptance driver | Equivalent public operations, observations and model outcomes through both facades; C++ + Rust worker run without a Node evaluator or MirrorECMA installed |
| L7 | All: compatibility manifest, documentation and distribution | Full required-backend/control/client matrix at pinned revisions; separately record local, hosted-CI and release evidence before advertising support |

L2 and L3/L4 may be implemented independently after L1. L5 depends on L2–L4;
the cross-language claim depends on L6, not merely a green TypeScript demo.
Fixes to existing worker protocol behavior must preserve its frozen fixtures
or use a separately reviewed version change.

## 12. Acceptance matrix mapped to §13

| Obligation | Required test |
| --- | --- |
| SO1 | Both facades drive the same Gate controller; no SDK contains a duplicate preparation/cleanup transition implementation |
| SO2 | One-call owned startup; attached sessions close without stopping the daemon; startup failure cleans partial owned resources |
| SO3 | Inject a control-shaped frame on worker transport and a worker frame on control transport; neither gains the other channel's authority |
| SO4 | Private canaries in model/config/expected state/replay context are absent from worker traffic and public artifacts; only declared projections cross |
| SO5 | Missing, malformed, unauthorized, wrong-digest, contradictory and old-server replies produce zero binding-factory calls, zero authorization attestations and zero execution-worker launches, including native pre-main markers |
| SO6 | Mutating source or build output after freeze cannot change active evaluation; artifact, manifest and semantic identities remain distinct |
| SO7 | Version/backend/build/negotiation/protocol/application/mismatch/cancel errors remain distinguishable; no fallback or mutation retry |
| SO8 | Success, mismatch, pending action cancellation, EOF, client death, timeout and partial factory failure converge on one Gate release; cleanup failure preserves the primary cause and is never reported as confirmed closure |
| SO9 | Forged or stale handles, same-UID other connections, token replay and concurrent sessions cannot access or clean each other's resources |
| SO10 | Every exposed authoring tool/build hook is tested against private filesystem/control/environment canaries; agent-visible results obey the fixed disclosure policy |
| SO11 | Shared framing/version/correlation/capability fixtures; unavailable aggregate quotas and platforms are reported explicitly |
| SO12 | TypeScript and C++ facades evaluate the same correct and genuinely faulty SUT through the same Gate implementation, with actual backend evidence |

Mandatory advertised combinations are TypeScript and C++ facades × Node and
Rust workers × owned and attached local control × Linux/Bubblewrap. Run a
deliberately faulty Counter in each combination and require a real Mirrors
mismatch. Use deterministic schedules for cancellation-race comparisons.

Existing commands remain gates: MirrorECMA build/type/example/Jest checks,
Mirrors `lake test` and `tools/interop/run.sh`, and MirrorGate's
`scripts/test.sh` with required sandbox enforcement. Add a shared
`conformance/control-v1/run` gate that selects native facade drivers and emits
machine-readable evidence for the dimensions above. A mock controller is
useful for client unit tests but cannot satisfy the backend or cross-language
acceptance rows.

## 13. Definition of landed

Section 13 is landed in MirrorECMA when the native entry point is present,
its Gate and generated-binding dependencies are reproducible and obtainable,
SO1–SO11 pass on each advertised combination, and SO12 has the independent
second-facade evidence. The public documentation must link those results and
identify the exact supported profile. Until then, describe intermediate work
as experimental or prerequisite support, rather than claiming §13 compliance.
