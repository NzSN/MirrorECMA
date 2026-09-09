# One Counter suite for source tests, CLI and implementation proxies

[suite.ts](suite.ts) is a reusable, import-safe application harness. It accepts
a Mirrors transport or binary, model configuration, trace paths, generic
cancellation/deadlines and a deferred `AsyncAdapterFactory`. It does not launch
an implementation, agent, Gate session or evaluation service itself.

The suite registers the exact compiler-owned async Counter identity, requires
`verify`/`require` negotiation and returns the ordinary `CompiledReplayReport`.
Mirrors must match the model before the factory runs. The factory creates a
generated binding over the real implementation and supplies disposal. Factories
that fail before returning a binding own cleanup of partially acquired resources.

The fixture model is [Counter.tla](../generated-counter/specs/Counter.tla), copied
from Mirrors' `specs/Counter.tla`: initialize to zero and increment by 2 or 3.
There is no upper bound on implementation state. `TraceComplete` supplies a
trace-generation target, not a maximum count. This example replays the checked-in
typed trace through the existing [async generated binding](../../test/fixtures/model-interface/counter/generated-async/CounterMirror.generated.ts).
It does not replace the model with handwritten assertions or regenerate output.
See the [compiler/provenance workflow](../generated-counter/README.md) when
updating the shared model or generated fixtures.

## Run from the MirrorECMA root

```bash
pnpm install --frozen-lockfile
export MIRROR_BIN=/absolute/path/to/Mirrors/.lake/build/bin/mirror
pnpm run check:examples
pnpm run test:mbt-counter
pnpm run example:mbt-counter
pnpm run example:mbt-counter:broken  # intentionally exits 1
pnpm run smoke:mbt-counter
```

No Gate installation, hosting service or live Apalache is needed. The smoke's
shared-server tier requires OpenSSL and loopback access for temporary test-only
mTLS certificates and a server with explicitly allowlisted interface verification.
The correct
run completes one trace and two transitions. The deliberately faulty increment
subtracts one: the first Tick reports 1 where Mirrors expects 2. Both the source
test and CLI call the same suite with the same configuration. Successful CLI
output is the JSON report; mismatch JSON goes to stderr with nonzero exit status.
The source test awaits the suite promise, so an uncaught mismatch fails its test.

The source test includes cancellation and missing-negotiation checks without a
Mirrors binary. Its real replay tests are skipped when `MIRROR_BIN` is absent;
the standalone smoke instead requires that variable and runs the complete source
test tier, correct/faulty CLI and external worker proxy. It compares complete
semantic reports/mismatch details, checks public operation projection and confirms
one factory call and one disposal. It also covers factory, adapter and cleanup
failures. A cleanup failure remains a failure even after observations match.

## Supply a local or external implementation

[local-provider.ts](local-provider.ts) creates state only inside the registered
factory and uses `bindCounterAsync`. It never reads model expectations.
An external provider implements the same `AsyncAdapterFactory` contract and can
use `bindCounterAsyncPublicPort` instead. Only stable public operation IDs, typed
inputs and actual observations cross that proxy boundary. Keep the generated
binding, authority and private trace data in the trusted evaluator.

The [smoke test](../../test/mbt-counter.smoke.ts) demonstrates this with a separate
Node worker and message proxy: `Initialize`, `Tick({Stride})`, and observation
`{Count}`. It proves transport/binding equivalence; worker threads are **not a
security sandbox**. Restricted execution is the external provider's responsibility.
An evaluation-service handler can call this same suite, but no service protocol
or service implementation is introduced by this example.

## Use an existing Mirrors server

The caller can pass a connection through `mirror` instead of a binary:

```ts
const report = await runCounterSuite({
  mirror: await connectTlsMirror(host, port, tlsOptions),
  modelConfig,
  tracePaths,
  signal,
}, implementationFactory);
```

Here `connectTlsMirror` is MirrorECMA's existing public transport API; the other
values are application configuration. Paths must refer to files available to
the Mirrors server. The runner owns and closes the supplied evaluation transport,
not the server process. Supply a fresh connection for another run. The standalone
smoke verifies local stdio plus two successive authorized mTLS connections to one server,
checking that closing each evaluation connection leaves that server running.
Plain TCP has no interface-verification grant and cannot run this required-match
suite. The smoke does not certify a production server deployment or TLS policy.

Source tests may live beside application code. For blind evaluation, the trusted
caller must select an approved suite/model/fixture revision and keep private
evaluation files outside implementer mounts. Submitted source must not replace
the harness loaded into the trusted evaluator. See the
[harness design](../../docs/mbt-harness-design.md) and
[implementation boundary](../../docs/implementation-boundary-design.md).
