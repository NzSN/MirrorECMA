# Replay reports, asynchronous operations, and scoped bindings

Status: implemented; focused runtime and compatibility checks pass.

## Public API and compatibility

Keep `protocol.ts`, its synchronous `StateComputer`, and wire messages unchanged.
Add `ReplayComputer` and `AsyncStateComputer` in `replay-control.ts`; the fourth
argument is `ReplayContext { signal, traceIndex, stateIndex }`. Await the complete
operation and observation before sending exactly one ITF-encoded `report_state`.
Existing three-argument synchronous callbacks remain assignable. Existing
`Promise<void>` runners retain their return contract. Add `*WithReport` variants
for ordinary and negotiated trace-generation/replay runners.

`ReplayOptions` accepts an optional cancellation signal, positive finite
`actionTimeoutMs`, and positive finite `receiveTimeoutMs`. Action timeout covers
the entire computer call, including observation. Receive timeout covers each
incoming line, including registration. A terminal race aborts the context signal;
late settlement cannot resume replay or send another state. JavaScript cannot
undo side effects from callbacks that ignore cancellation. Factories and disposal
are awaited rather than abandoned, so resource ownership is retained. These
options apply after transport readiness; transport constructors retain their own
connection/handshake behavior. Synchronous code cannot be interrupted, but an
elapsed-deadline check rejects its late result before any state is sent.

Compiled selection supports an explicit additive local contract
`mirrors.async-state-computer/v1`; generated synchronous adapters continue to use
`mirrors.state-computer/v1`. This is a local execution contract, not a wire change.

## Reports and diagnostics

`ReplayReport` is a deeply frozen, JSON-safe snapshot with schema
`mirrorecma.replay-report/v1`, status, optional interface digest, run duration,
aggregate action and adjacent-action counts, and progress counts. No successful
event history is retained. Duration begins after transport readiness and includes
registration and binding creation, ending before cleanup. Adjacent pairs include
initialization but never cross
trace boundaries. Action counts mean completed computations whose report was sent.
Aggregate coverage retains at most 256 distinct action names and 1024 distinct
adjacent pairs. `coverage` records these limits, dropped action/pair event counts,
and a `truncated` flag. Retained entries continue counting after the cap. Thus
large legacy action vocabularies produce explicitly partial aggregate coverage;
total reported/matched state, completed step, and trace counts remain complete.
`statesReported` includes initialization; `statesMatched` counts acknowledged
reports. `stepsCompleted` counts matched transitions, excluding initialization.
`tracesStarted` counts `initial_state` messages; a trace completes only when a
subsequent initialization or `all_steps_done` confirms its end. Final success and
trace boundaries acknowledge a pending report even when no separate `step_ok` is
sent. Duplicate acknowledgments must not double-count.

`ReplayMismatchError` carries the action, immutable native `State` snapshots for
parameters and expected/actual values, ordered hints, a 1-based trace index, and a
0-based state index. `toJSON()` and report failure details use the existing ITF
encoder, preserving arbitrary-precision integers. Human parameters are rendered
as JSON instead of object coercion. Other thrown objects retain their identity;
`replayReportFromError(error)` retrieves their attached snapshot.
Diagnostic extraction tolerates null-prototype objects, throwing accessors and
revoked proxies without replacing the primary rejection or bypassing cleanup.

## Dynamic resource ownership

Keep legacy pre-created dynamic registry selection compatible. Its resources are
caller-owned until the binder exists. Add a factory selection that carries inert
contract/digest data and creates a fresh registry scope only after a valid reply.
The scope selects synchronous or asynchronous binding and supplies disposal.
After a scope is returned, the runner disposes it once even if binding validation
or construction fails. Negotiated replay closes the transport and disposes the
binding on every terminal path, preserving an earlier error over cleanup errors.
Ownership includes a supplied transport's readiness promise: readiness failure
closes the transport once before registration or construction can occur.

## Acceptance

Use scripted transports to verify multiple traces, implicit final acknowledgment,
bigint/hint serialization, immutable mismatch inputs, async ordering, rejection,
timeouts, cancellation before negotiation and during execution, late completion,
factory gating, and cleanup ownership. Run existing negotiated and dynamic suites
to preserve current selection and wire behavior. Real generated Counter smoke
remains the integration check for server acknowledgment behavior.
