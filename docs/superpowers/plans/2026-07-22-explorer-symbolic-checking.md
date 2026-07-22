# Interactive Symbolic Model Checking (Explorer Paths) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port ModelMirros' explorer flows (`register_explore`, `register_explore_session`) to the TypeScript client so MirrorECMA supports interactive symbolic model checking.

**Architecture:** Design doc: `docs/superpowers/specs/2026-07-22-explorer-symbolic-checking-design.md`. `runClientExplore` reuses the existing `mainLoop`; `ExploreSession` is a new stateful command/response wrapper over the transport. Wire format mirrors ModelMirros `src/Protocol/Format/Json.hs`.

**Tech Stack:** TypeScript (ESM, `.js` import extensions), jest, tsx smoke runner, Bazel (`ts_project`, `js_test`).

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/protocol.ts` | Modify | `ApalacheSpec`, status unions, 9 client + 8 mirror message types, decode cases |
| `src/client.ts` | Modify | `specFromFile`, `runClientExplore`, `ExploreSession`/`startExploreSession` |
| `src/index.ts` | Modify | Export new API |
| `specs/HourClock.tla` | Create | Constant-free spec with `Inv`, copied from ModelMirros |
| `test/protocol.test.ts` | Modify | Encode/decode unit tests for new messages |
| `test/smoke.test.ts` | Modify | `testExplore` + `testExploreSession` smoke tests |
| `MODULE.bazel` | Modify | Bump `modelmirros` pin to `1b65121` (interactive branch) |
| `BUILD.bazel` | Modify | Add `specs/HourClock.tla` to `js_test` data |
| `README.md` | Modify | Document new APIs |

---

### Task 1: Protocol types and codecs

**Files:**
- Modify: `src/protocol.ts`

- [ ] **Step 1: Add spec and status types**

```ts
export interface ApalacheSpec {
  sources: string[];
}

export type TransitionStatus = "ENABLED" | "DISABLED" | "UNKNOWN";
export type InvariantStatus = "SATISFIED" | "VIOLATED" | "UNKNOWN";
```

- [ ] **Step 2: Add client message types and extend the union**

```ts
export interface RegisterExplore {
  proto_step: "register_explore";
  spec: ApalacheSpec;
  invariants: string[];
  exports: string[];
  maxSteps: number;
}

export interface RegisterExploreSession {
  proto_step: "register_explore_session";
  spec: ApalacheSpec;
  invariants: string[];
  exports: string[];
}

export interface ExploreAssumeTransition { proto_step: "explore_assume_transition"; transitionId: number; }
export interface ExploreNextStep         { proto_step: "explore_next_step"; }
export interface ExploreQueryState       { proto_step: "explore_query_state"; }
export interface ExploreCheckInvariant   { proto_step: "explore_check_invariant"; invariantId: number; }
export interface ExploreAssumeState      { proto_step: "explore_assume_state"; state: State; }
export interface ExploreRollback         { proto_step: "explore_rollback"; snapshotId: number; }
export interface ExploreDone             { proto_step: "explore_done"; }

export type ClientMessage =
  | Register | RegisterTraces | RegisterTraceGen | ReportState
  | RegisterExplore | RegisterExploreSession
  | ExploreAssumeTransition | ExploreNextStep | ExploreQueryState
  | ExploreCheckInvariant | ExploreAssumeState | ExploreRollback | ExploreDone;
```

- [ ] **Step 3: Add mirror message types and extend the union**

```ts
export interface ExplorerReady {
  proto_step: "explorer_ready";
  initTransitions: number;
  nextTransitions: number;
  stateInvariants: number;
}
export interface ExploreTransitionStatus { proto_step: "explore_transition_status"; status: TransitionStatus; }
export interface ExploreStepDone         { proto_step: "explore_step_done"; stepNo: number; }
export interface ExploreState            { proto_step: "explore_state"; state: State; }
export interface ExploreInvariantStatus  { proto_step: "explore_invariant_status"; status: InvariantStatus; }
export interface ExploreAssumeStatus     { proto_step: "explore_assume_status"; status: TransitionStatus; }
export interface ExploreRollbackDone     { proto_step: "explore_rollback_done"; snapshotId: number; }
export interface ExploreSessionDone      { proto_step: "explore_session_done"; }
```

Add all 8 to the `MirrorMessage` union.

- [ ] **Step 4: Decode cases**

Add the 8 `proto_step` strings to the `decodeMirrorMessage` whitelist switch and implement `walkMessage` cases. `explore_state` walks its record like `initial_state`:

```ts
case "explorer_ready":
  return {
    proto_step: "explorer_ready",
    initTransitions: obj.initTransitions as number,
    nextTransitions: obj.nextTransitions as number,
    stateInvariants: obj.stateInvariants as number,
  };
case "explore_state":
  return {
    proto_step: "explore_state",
    state: (walk(obj.state) as { tag: "record"; val: Record<string, Value> }).val,
  };
// explore_transition_status / explore_invariant_status / explore_assume_status: { proto_step, status: obj.status }
// explore_step_done: { proto_step, stepNo }; explore_rollback_done: { proto_step, snapshotId }
// explore_session_done: { proto_step }
```

---

### Task 2: Client API

**Files:**
- Modify: `src/client.ts`

- [ ] **Step 1: `specFromFile`**

```ts
import { readFile } from "node:fs/promises";

export async function specFromFile(path: string): Promise<ApalacheSpec> {
  return { sources: [await readFile(path, "utf8")] };
}
```

- [ ] **Step 2: `runClientExplore`**

Sends `register_explore`, then the existing `mainLoop` unchanged (`register_explore` replies `spec_validated` before `initial_state`, so the loop applies verbatim).

`invariants` = names of state-invariant operators in the spec, checked after every step. `exports` = operator names declared for later `OPERATOR`-kind RPC queries; the mirror's session only supports state queries today, so pass `[]` (see design doc).

```ts
export async function runClientExplore(
  binPath: string,
  spec: ApalacheSpec,
  invariants: string[],
  exports: string[],
  maxSteps: number,
  compute: StateComputer
): Promise<void> {
  const t = spawnMirror(binPath);
  t.send(encodeClientMessage({
    proto_step: "register_explore",
    spec, invariants, exports, maxSteps,
  }));
  await mainLoop(t, compute);
}
```

- [ ] **Step 3: `ExploreSession`**

```ts
export class ExploreSession {
  private constructor(
    private t: Transport,
    private it: AsyncIterator<string>,
    public readonly ready: { initTransitions: number; nextTransitions: number; stateInvariants: number },
  ) {}

  static async open(
    binPath: string, spec: ApalacheSpec, invariants: string[], exports: string[],
  ): Promise<ExploreSession> {
    const t = spawnMirror(binPath);
    const it = t[Symbol.asyncIterator]();
    t.send(encodeClientMessage({ proto_step: "register_explore_session", spec, invariants, exports }));
    const msg = await recv(it);
    if (msg.proto_step === "register_error") { await t.close(); throw new Error(`register failed: ${msg.error}`); }
    if (msg.proto_step === "protocol_error") { await t.close(); throw new Error(msg.error); }
    if (msg.proto_step !== "explorer_ready") { await t.close(); throw new Error(`expected explorer_ready, got ${msg.proto_step}`); }
    return new ExploreSession(t, it, {
      initTransitions: msg.initTransitions,
      nextTransitions: msg.nextTransitions,
      stateInvariants: msg.stateInvariants,
    });
  }

  async assumeTransition(transitionId: number): Promise<TransitionStatus> {
    const msg = await this.cmd({ proto_step: "explore_assume_transition", transitionId });
    if (msg.proto_step !== "explore_transition_status") throw new Error(`unexpected reply: ${msg.proto_step}`);
    return msg.status;
  }
  // nextStep(): Promise<number>           — explore_next_step → explore_step_done.stepNo
  // queryState(): Promise<State>          — explore_query_state → explore_state.state
  // checkInvariant(iid): Promise<InvariantStatus> — explore_check_invariant → explore_invariant_status.status
  // assumeState(eqs): Promise<TransitionStatus>   — see Step 4 for encoding
  // rollback(snap): Promise<number>       — explore_rollback → explore_rollback_done.snapshotId

  async done(): Promise<void> {
    const msg = await this.cmd({ proto_step: "explore_done" });
    if (msg.proto_step !== "explore_session_done") throw new Error(`unexpected reply: ${msg.proto_step}`);
    await this.t.close();
  }

  private async cmd(m: ClientMessage): Promise<MirrorMessage> {
    this.t.send(encodeClientMessage(m));
    const msg = await recv(this.it);
    // Session survives command errors: throw but keep the transport open.
    if (msg.proto_step === "protocol_error") throw new Error(msg.error);
    return msg;
  }
}

export function startExploreSession(
  binPath: string, spec: ApalacheSpec, invariants: string[], exports: string[],
): Promise<ExploreSession> {
  return ExploreSession.open(binPath, spec, invariants, exports);
}
```

- [ ] **Step 4: `assumeState` encoding (bigint double-wrap trap)**

`state` must go through `encodeState()`, not `encodeClientMessage` — same pattern as `report_state` in `mainLoop`:

```ts
async assumeState(eqs: State): Promise<TransitionStatus> {
  this.t.send(JSON.stringify({ proto_step: "explore_assume_state", state: encodeState(eqs) }));
  const msg = await recv(this.it);
  if (msg.proto_step === "protocol_error") throw new Error(msg.error);
  if (msg.proto_step !== "explore_assume_status") throw new Error(`unexpected reply: ${msg.proto_step}`);
  return msg.status;
}
```

---

### Task 3: Public exports

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Re-export new API**

Add `runClientExplore`, `startExploreSession`, `ExploreSession`, `specFromFile` from `./client.js`; `ApalacheSpec`, `TransitionStatus`, `InvariantStatus`, and the new message interfaces from `./protocol.js`. Keep `.js` extensions (ESM).

---

### Task 4: Test spec

**Files:**
- Create: `specs/HourClock.tla`

- [ ] **Step 1: Copy verbatim from ModelMirros**

`cp ../ModelMirros/test/specs/HourClock.tla specs/HourClock.tla` — constant-free, has state invariant `Inv`, `TraceComplete` bounded at 13 ticks. Do not modify; it is proven against the explorer server in ModelMirros e2e tests.

---

### Task 5: Unit tests

**Files:**
- Modify: `test/protocol.test.ts`

- [ ] **Step 1: Encode tests**

New `describe("explore messages (encode)")`: `register_explore` (spec sources, invariants, maxSteps present), `register_explore_session`, and each of the 7 commands — assert parsed JSON has the exact `proto_step` tag and fields (`transitionId`, `invariantId`, `snapshotId`).

- [ ] **Step 2: Decode tests**

New `describe("decodeMirrorMessage (explorer)")`: all 8 replies. `explore_state` must decode `{"hr": {"#bigint": "7"}}` to `{ tag: "int", val: 7n }`. `explorer_ready` decodes the three counts.

---

### Task 6: Smoke tests

**Files:**
- Modify: `test/smoke.test.ts`

- [ ] **Step 1: `HourClockComputer`**

Two valid options — the explore flow differs from the trace flows here:

- **Echo (simplest):** in the explore flow, `next_step.parameters` carries the **full expected symbolic state** (not paramVars-extracted params), and `initial_state.state` likewise. A computer that returns `msg.state` / `msg.parameters` verbatim always conforms. This is weaker as a test (cannot detect client-side divergence) but trivially correct.
- **Faithful (stronger):** independently compute each tick. Must report **all 6 HourClock state vars**: `hr` (12 wraps to 1), `latest_hr` (previous `hr`), `ticked: true`, `action_taken` (`"init"`/`"tick"` — the mirror derives the action name from this field and conformance-checks it; omitting it yields `step_mismatch`), `nondet_picks` (unchanged), `step_count` (+1). The trace-flow `paramVars` omit-from-report rule does not apply.

Use the faithful implementation (mirrors ModelMirros `hourClockClient`), keeping `action_taken`.

- [ ] **Step 2: `testExplore()`**

```ts
const spec = await specFromFile(hourClockSpecPath); // RUNFILES-aware, like tracePath in testRegisterTraces
await runClientExplore(BIN, spec, ["Inv"], [], 4, computer.compute.bind(computer));
```

- [ ] **Step 3: `testExploreSession()`**

Open session with `["Inv"]`; assert `ready` = 1 init, ≥1 next, 1 invariant. Script (assert each reply):
`assumeTransition(0)` → `"ENABLED"`; `nextStep()` → `1`; `queryState()` → has `hr`; `checkInvariant(0)` → `"SATISFIED"`; `assumeState({hr: <queried>})` → `"ENABLED"`; `rollback(0)` → `0`; `done()` → resolves.

- [ ] **Step 4: Wire into `main()`**

Append `await testExplore(); await testExploreSession();` after the existing three tests.

---

### Task 7: Bazel wiring

**Files:**
- Modify: `MODULE.bazel`, `BUILD.bazel`

- [ ] **Step 1: Bump the modelmirros pin**

```python
git_override(
    module_name = "modelmirrors",
    remote = "https://github.com/NzSN/ModelMirrors",
    # Explorer feature (interactive branch). A pinned hash does NOT follow the
    # branch: this silently goes stale as `interactive` advances. Repoint when
    # picking up newer explorer changes, ideally at main once merged.
    commit = "1b6512150bebf155c1dbb6f1f9ae9bc49998be85",
)
```

**Resolved during implementation:** `1b65121` spawned the apalache explorer
server with inherited stdout (`Explorer.hs` `createProcess` default), so server
log lines corrupted the JSON-lines stdio protocol (`FAIL: Unexpected token '#'`
in `register_explore`). Fixed in ModelMirros as `2cabc40`
(`std_out = UseHandle stderr`) and the pin bumped to it — the final pin is:

```python
commit = "2cabc401f0eb7c05131beb3a2e16afd7ec32e247",
```

- [ ] **Step 2: Add HourClock.tla to smoke test data**

In `js_test(name = "smoke", ...)` `data`, add `"specs/HourClock.tla"` alongside `"specs/Counter.tla"`.

---

### Task 8: Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document the explorer APIs**

Short section after the trace-flow docs: `runClientExplore` (mirror-driven symbolic checking, same `StateComputer` contract as `runClient`) and `startExploreSession` (client-driven; example command sequence; note that a `protocol_error` rejects the command but keeps the session open). Mention `specFromFile` and that `invariants` are state-invariant operator names from the spec.

---

### Task 9: Verification

- [ ] `pnpm run check`
- [ ] `pnpm test`
- [ ] Build ModelMirros locally (`cabal build exe:ModelMirrors` in `../ModelMirros`), then `MIRROR_BIN=<binary> npx tsx test/smoke.test.ts` — all 5 smoke tests pass
- [ ] `bazel test //:smoke`
