# Design: Interactive Symbolic Model Checking (Explorer Paths)

**Date:** 2026-07-22
**Status:** approved

## Context

ModelMirros gained two explorer-based flows on its `interactive` branch (HEAD `1b65121`):

1. **`register_explore`** — mirror-driven symbolic exploration. Instead of replaying a precomputed concrete trace, the mirror starts a live apalache explorer server and computes each successor state symbolically (via `Apalache.Rpc.Client` over JSON-RPC). The client receives the same `initial_state` / `next_step` / `step_ok` message stream as the `register` flow and is conformance-checked against the symbolic states.
2. **`register_explore_session`** — client-driven interactive symbolic checking. The mirror opens an explorer session, replies `explorer_ready`, then strictly alternates: each client explorer command (`assumeTransition`, `nextStep`, `queryState`, `checkInvariant`, `assumeState`, `rollback`) is proxied to the apalache server and its result returned. `explore_done` ends the session. A failed command yields `protocol_error` but the session **survives** — the mirror's session loop continues.

MirrorECMA implements only the three trace flows (`register`, `register_traces`, `register_trace_gen`). This change ports both explorer flows to the TypeScript client.

## Wire format (from ModelMirros `src/Protocol/Format/Json.hs`)

- `spec` field: `{"sources": ["<tla source text>"]}` — plain text; base64 encoding happens mirror-side (`newExplorer`).
- Client messages: `register_explore` (spec, invariants, exports, maxSteps), `register_explore_session` (spec, invariants, exports), `explore_assume_transition` (transitionId), `explore_next_step`, `explore_query_state`, `explore_check_invariant` (invariantId), `explore_assume_state` (state), `explore_rollback` (snapshotId), `explore_done`.
- Mirror replies: `explorer_ready` (initTransitions, nextTransitions, stateInvariants), `explore_transition_status` (status: ENABLED|DISABLED|UNKNOWN), `explore_step_done` (stepNo), `explore_state` (state), `explore_invariant_status` (status: SATISFIED|VIOLATED|UNKNOWN), `explore_assume_status` (status), `explore_rollback_done` (snapshotId), `explore_session_done`.

## Approach

### `runClientExplore` (mirror-driven)

Sends `register_explore`, then reuses the existing `mainLoop` **unchanged** — after `spec_validated`, the message flow is identical to `register` (initial_state → report_state → step_ok → next_step → … → all_steps_done). The only difference is where the mirror gets its states (symbolic exploration vs. trace files), which is invisible to the client.

Two behavioral differences from the trace flows matter for the `StateComputer`:

1. **`next_step.parameters` carries the full expected state**, not paramVars-extracted action parameters. The explore flow sends `NextStep action expected` where `expected` is the complete symbolic state (ModelMirros `src/Protocol/Mirror.hs`, `exploreLoop`). A conforming computer may therefore simply echo `msg.parameters` (and `msg.state` for `initial_state`). An independently computing implementation is still valuable — it makes the conformance check non-vacuous — but it must reproduce the state **exactly**.
2. **`action_taken` is part of the checked state.** HourClock has 6 state vars (`hr`, `latest_hr`, `ticked`, `action_taken`, `nondet_picks`, `step_count`), and the mirror derives the action name from the `action_taken` field of the symbolic state (`stateAction` in `Mirror.hs`). A computer that omits `action_taken` (or any other var) fails with `step_mismatch`. The `paramVars` omit-from-report rule does **not** apply here — that mechanism is specific to the trace flows.

### `ExploreSession` (client-driven)

A small stateful wrapper around the transport:

- `startExploreSession(binPath, spec, invariants, exports)` sends `register_explore_session` and waits for `explorer_ready` (throws on `register_error`/`protocol_error`); exposes `.ready = {initTransitions, nextTransitions, stateInvariants}`.
- One async method per command, each sending one message and awaiting its typed reply: `assumeTransition(tid)`, `nextStep()`, `queryState()`, `checkInvariant(iid)`, `assumeState(eqs)`, `rollback(snap)`, `done()`.
- A `protocol_error` reply throws, but the transport stays open — callers may keep issuing commands (mirrors the Haskell semantics).
- `done()` waits for `explore_session_done`, then closes the transport.

### `invariants` and `exports`

Both register messages take two operator-name lists:

- **`invariants`** — names of state-invariant operators in the spec (e.g. `["Inv"]`). The mirror checks them after every successful step in the explore flow, and `checkInvariant` references them by index in the session flow (`invariantId: 0` = first entry).
- **`exports`** — names of spec operators declared at `loadSpec` time so they can later be evaluated on demand via the JSON-RPC `query` method with kind `OPERATOR` (ModelMirros `exploreQueryOperator`). The mirror's session `query` command currently only supports *state* queries, so exports are unused by the client today — pass `[]`. A non-empty list only becomes meaningful if the mirror grows an operator-query command.

### Encoding gotcha

`explore_assume_state.state` must be serialized with `encodeState()` — the same double-wrap trap as `report_state` (AGENTS.md #48): `encodeClientMessage`'s bigint replacer would re-wrap the already-tagged values.

### Test spec

`specs/Counter.tla` cannot be used: it has `CONSTANTS STRIDES`, and the explorer `loadSpec` passes no `constInit`. Copy `specs/HourClock.tla` verbatim from `ModelMirros/test/specs/HourClock.tla` — constant-free, has state invariant `Inv`, and already proven against the explorer server in ModelMirros e2e tests, so smoke failures can only come from the new TS code.

### Bazel pin

`MODULE.bazel` pins `modelmirros` at `1636dcfd`, which predates the explorer feature (zero `register_explore` occurrences). Bump to `1b6512150bebf155c1dbb6f1f9ae9bc49998be85` — the current `interactive` branch HEAD, reachable on the remote, and `git_override` fetches by hash, so no ModelMirros-side git operation is needed. Add a comment noting the pin tracks the `interactive` branch **and will silently go stale as that branch advances** — a pinned hash does not follow branch movement; it should be repointed (ideally at `main`, once ModelMirros merges) when picking up newer explorer changes.

**Mirror bug found during verification:** the mirror spawned the apalache explorer server with inherited stdout (`Explorer.hs`, `createProcess` default), so over the *stdio* transport the server's log lines interleaved with JSON-lines protocol messages and broke the client (the in-process Haskell e2e tests never saw this — `MockTransport` shares no stdout). Fixed in ModelMirros `2cabc40` (`std_out = UseHandle stderr` in `startApalacheServer`); the pin points at that commit.

## Changes

### 1. `src/protocol.ts`

- `interface ApalacheSpec { sources: string[] }`
- `type TransitionStatus = "ENABLED" | "DISABLED" | "UNKNOWN"`, `type InvariantStatus = "SATISFIED" | "VIOLATED" | "UNKNOWN"`
- `ClientMessage` += `RegisterExplore`, `RegisterExploreSession`, and the 7 explore command interfaces
- `MirrorMessage` += the 8 explorer reply interfaces
- `decodeMirrorMessage` whitelist + `walkMessage` cases for all 8; `explore_state` walks its `state` record the same way `initial_state` does

### 2. `src/client.ts`

- `specFromFile(path): Promise<ApalacheSpec>` — `fs.readFile` → `{sources: [text]}`
- `runClientExplore(binPath, spec, invariants, exports, maxSteps, compute)` — sends `register_explore`, then existing `mainLoop`
- `startExploreSession(...)` + `ExploreSession` class as described above

### 3. `src/index.ts`

Export `runClientExplore`, `startExploreSession`, `ExploreSession`, `specFromFile`, and the new message/status types.

### 4. `specs/HourClock.tla`

Verbatim copy from ModelMirros.

### 5. `test/protocol.test.ts`

Jest units: encode both register messages + all 7 commands; decode all 8 replies (including `explore_state` with `#bigint` fields).

### 6. `test/smoke.test.ts`

- `testExplore()` — `runClientExplore` with an `HourClockComputer` reporting **all 6 state vars including `action_taken`** (or simply echoing `msg.parameters` — see design note above), `invariants: ["Inv"]`, `maxSteps: 4`; must resolve.
- `testExploreSession()` — open session; assert ready counts (1 init, ≥1 next, 1 inv); script: assumeTransition 0 → ENABLED, nextStep → 1, queryState has `hr`, checkInvariant 0 → SATISFIED, assumeState `{hr}` → ENABLED, rollback 0 → snapshot 0, done. RUNFILES-aware spec path like the existing tests.

### 7. `MODULE.bazel` / `BUILD.bazel`

- Bump `git_override` commit `1636dcfd…` → `1b65121…` with branch-tracking comment.
- Add `specs/HourClock.tla` to `js_test` `data`.

### 8. `README.md`

Document `runClientExplore` and `ExploreSession` with a short example.

## Verification

1. `pnpm run check` — type-check
2. `pnpm test` — jest units
3. `MIRROR_BIN=<locally built ModelMirros binary> npx tsx test/smoke.test.ts`
4. `bazel test //:smoke`
