# Generated Counter quick start — design

Status: implemented and verified on 2026-09-06; see the plan for assignments
and execution evidence.

Scope: make the generated, negotiated adapter workflow the primary introduction
to MirrorECMA with the Lean Mirrors server. This changes documentation, adds a
runnable example, and verifies that example. It uses the existing compiler,
bindings, and client interfaces.

Implementation plan: [task sequence](../plans/2026-09-06-generated-counter-quickstart.md).

## Problem and intended outcome

The current [quick start](../../../README.md#quick-start) asks readers to compute
the next reported state from `action`, `params`, and `prev`. That is valid when
the callback itself is the implementation being tested. For an existing
application, it can encourage writing a second implementation inside the test
instead of exercising the application.

The new introduction teaches a different task: implement a small adapter that
invokes the real implementation and observes its actual state. A reader should
be able to run a passing example, introduce a real implementation bug, see
Mirrors reject it, and identify the adapter code to replace for their own system.

The example uses compiled verification with `policy: "require"` over local
stdio. Dynamic descriptors, remote transports, symbolic exploration, and the
low-level `StateComputer` interface remain documented through subsequent links.
Asynchronous SUT support, a new general runner interface, and a project
configuration system are separate work.

## Reader journey

1. **Meet the implementation.** Show an ordinary mutable `Counter` using
   `bigint`, with `reset()`, `increment(stride)`, and a readable `count`. It has
   no MirrorECMA imports and receives no expected model state.
2. **See the model contract.** Explain that `Initialize` maps to `init`, `Tick`
   consumes `parameters.stride`, and `Count` observes the implementation's
   `count`. Link the complete TLA+ model and companion contract.
3. **See the generated port.** Explain that Mirrors generates the typed port
   and binding from the contract and structural evidence. Checked-in generated
   files let the reader run the example immediately; regeneration is documented.
4. **Write the adapter.** Show the complete semantic mapping below.
5. **Run the known trace.** Verify the generated artifacts, then replay the
   supplied trace through negotiated stdio. This first run requires a built
   Mirrors binary but does not invoke Apalache.
6. **Observe a real failure.** Run the same adapter against an intentionally
   faulty Counter. Show the failing action and differing `count` observation.
7. **Generate new traces.** Enable Apalache and use `runClientNegotiated` with
   inline model sources. Explain how to change the model and regenerate its
   interface before adapting a different application.

The README presents the implementation, port, adapter, and first-run commands.
The example README contains the complete setup, compiler commands, live mode,
expected failure, and instructions for adapting another implementation.

## Example structure and ownership

Files are relative to the MirrorECMA root:

| File | Responsibility |
| --- | --- |
| `examples/generated-counter/counter.ts` | Real mutable Counter and an explicitly named faulty variant for the demonstration |
| `examples/generated-counter/adapter.ts` | Map Counter methods to `CounterPort`; construct compiled adapter selection |
| `examples/generated-counter/run.ts` | Select replay/live/fault demonstration, run the client, print outcome and action coverage |
| `examples/generated-counter/specs/Counter.tla` | Byte-identical tutorial copy of Mirrors' authoritative Counter model |
| `examples/generated-counter/README.md` | Full executable tutorial and regeneration instructions |
| `tsconfig.examples.json` | Compile the example and its imports into ignored `dist-test/` |
| `test/generated-counter.smoke.ts` | Standalone acceptance test of the documented executable |

Reuse the existing contract, evidence, lock, generated TypeScript, and ownership
manifest under `test/fixtures/model-interface/counter/`. They remain the single
set of those artifacts in MirrorECMA; the tutorial links them explicitly. The
example does not add another generated-output tree or modify frozen wire data.

There is a source-selection trap: MirrorECMA's root `specs/Counter.tla` currently
differs from Mirrors' `specs/Counter.tla`, whose bytes are recorded in the shared
lock's provenance. Copy the latter into the example without changing the root
client model. The tutorial's artifact check uses that copy. The interop gate
also compares it with the authoritative Mirrors source. This makes a future
update explicit rather than selecting whichever `Counter.tla` happens to exist.

The contract's logical source remains `specs/Counter.tla`. The existing compiler
normalizes the physical root path to `contract.model.source`, so the example's
physical location need not change the logical contract or generated identity.
Verify this with the existing `check` command during implementation.

## Adapter and lifecycle

The generated port is already implemented:

```ts
interface CounterPort {
  initialize(): void;
  tick(input: { readonly stride: bigint }): void;
  observe(): { readonly count: bigint };
}
```

The handwritten semantic mapping is:

```ts
const port: CounterPort = {
  initialize: () => counter.reset(),
  tick: ({ stride }) => counter.increment(stride),
  observe: () => ({ count: counter.count }),
};
```

Create `counter`, `port`, and `bindCounter(port, config)` inside the
`CompiledAdapterRegistry` factory. Registry construction and selection contain
metadata and factories only. No SUT construction or application callback occurs
before a validated `matched` response.

Use generated `CounterModelInterface` and `CounterSemanticDigest` together, with
the exported target-profile and StateComputer-contract constants. Implement the
`LocalBinding` configuration check consistently with the binding's `paramVars`
requirement. Leave transport closure and binding disposal to the negotiated
runner. Explain that Counter needs no external cleanup; a resource-owning SUT
would release its resources through the binding's `dispose` method.

Capture the generated binding in the example runner's local state so that, after
successful replay, it can call `assertAllActionsCovered()` and print `coverage()`.
This is example-local reporting through existing methods, not a new library
return type. Coverage is reported as executed actions, not state-space coverage.

The faulty variant changes implementation behavior, for example adding
`stride - 1n`. It uses the identical adapter and an honest observer. The fault
must not be simulated by fabricating an incorrect observation or wire response.

## Build, commands, and paths

Run tutorial commands from the MirrorECMA root. `MIRRORS_ROOT` identifies the
Mirrors checkout; document `../Mirrors` as the sibling-layout example. Derive
the default binary from that root and permit `MIRROR_BIN` to override it. Resolve
model and trace files to absolute paths before starting local stdio replay.
Missing tools or files produce an actionable failure, not a skipped success.

Use the existing TypeScript compiler and Node runtime. `tsconfig.examples.json`
sets `rootDir` to `.`, `outDir` to `dist-test`, disables declarations, and includes
the example, its standalone smoke harness, `src/`, and the reused generated
fixture. Map the generated file's
type-only `mirrorecma` import to `src/index.ts`. Example runtime imports use the
public barrel through `../../src/index.js`; emitted relative imports resolve to
the compiled barrel. Explain that installed consumers import from `mirrorecma`.

Package commands:

| Command | Behavior |
| --- | --- |
| `pnpm run check:examples` | Type-check the example and its generated binding |
| `pnpm run build:examples` | Compile runnable example output |
| `pnpm run example:counter` | Build and replay the supplied trace through compiled negotiation |
| `pnpm run example:counter:broken` | Build and run the faulty SUT; expected nonzero exit with `step_mismatch` |
| `pnpm run example:counter:live` | Build and generate fresh traces with Apalache before replay |

The default mode uses `runClientWithTracesNegotiated` with the tutorial model's
absolute `specPath`. Trace paths are mirror-local, which is appropriate for this
local stdio example. Live mode uses `runClientNegotiated`, the same selection,
and `specFromFiles` for inline source transfer. Keep the live profile consistent
with the existing Counter slice: `TraceComplete`, `CInit`, `paramVars:
"parameters"`, a sufficient length bound, and at least one trace.

Document complete `model_interface_gen resolve`, `generate`, `check`, and
`preflight --require-all-actions` commands. Use named shell variables for the
compiler, tutorial model, and shared fixture directory. `check` is the normal
read-only verification step; regeneration is an explicit operation on the owned
lock/output. Generation does not infer the semantic mapping to the real SUT.

## Documentation organization

The main README should introduce Mirrors as the Lean server used by this
tutorial, then present the generated workflow before listing advanced modes.
Its primary example must compile as part of the runnable example; link complete
source files instead of maintaining a second independent implementation.

Move the callback-based example into a clearly named low-level customization
section. Explain when implementing `StateComputer` directly is appropriate.
Retain the API reference and links for dynamic mode, transports, async jobs, and
exploration. Keep compiled verification and dynamic descriptor delivery distinct.

Add a short link from Mirrors' README to the client tutorial. Mirrors remains
the owner of compiler and protocol documentation; the client tutorial owns
application integration. Correct only onboarding guidance in MirrorECMA's
`AGENTS.md` that conflicts with the new primary path or current package scripts.

## Acceptance criteria

| Criterion | Evidence |
| --- | --- |
| A reader can identify the real SUT and its adapter | Separate source files; Counter has no protocol dependency |
| Documented code compiles | Example type-check and emitted executable |
| Tutorial uses the intended model and generated artifacts | Source comparison plus read-only compiler `check` |
| Supplied trace exercises initialization and transition | `preflight --require-all-actions` and runtime coverage assertion |
| First run needs no live Apalache invocation | Successful negotiated trace replay with Apalache unavailable |
| A real implementation bug is detected | Faulty Counter exits nonzero with a `tick`/`count` mismatch |
| Failure is not confused with missing infrastructure | Acceptance test requires the specific mismatch, not merely a nonzero exit |
| Runtime setup remains guarded by negotiation | Example factory discipline; existing negotiated-runner regressions remain green |
| Live model generation reaches the same implementation | Apalache-backed tutorial mode completes with action coverage |
| Existing consumers retain their behavior | No changes to public client interfaces or wire protocol |

A passing tutorial establishes agreement on the exercised observations and
traces. The explanation must identify the adapter's observation mapping and
trace selection as part of that testing claim.

## Current implementation references

- [Generated port and binding](../../../test/fixtures/model-interface/counter/generated/CounterMirror.generated.ts).
- [Existing Counter factory and real SUT smoke](../../../test/model-interface-counter.smoke.ts).
- [Negotiated client lifecycle](../../../src/negotiated.ts).
- [Compiler commands](../../../../Mirrors/tools/ModelInterfaceGen.lean).
- [Client negotiation requirements](../../../../Mirrors/Docs/client-implementation-guide.md).
- [Compiler ownership and provenance](../../../../Mirrors/Docs/model-interface-compiler-design.md).
