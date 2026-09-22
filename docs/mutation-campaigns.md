# Fixed-baseline mutation campaigns

Status: F1 contract, schema `mirrorecma.mutation-campaign/v1`.

A campaign is an immutable evaluator declaration. It fixes the correct baseline,
the complete mutant denominator, expected detectable behavior, supported paths,
reset/cleanup plan, and independent probes before execution. The schema is
[`../schemas/mutation-campaign-v1.schema.json`](../schemas/mutation-campaign-v1.schema.json).
Campaigns use the ordinary suite comparator and lifecycle; they do not define a
second replay protocol.

Version 1 is closed. Unknown schema versions and fields fail before the correct
factory runs. `evidenceLinks` contains opaque E1 `runRef`/`artifactRef` values and
the C2 `catalogSelectionRef`; this contract neither duplicates nor weakens those
contracts. Unknown additive fields require an explicit reviewed schema update.

## Protected baseline

The `protected` object fixes these independent identities:

- frozen suite definition;
- model source closure;
- generated interface semantics and executable module;
- ordered corpus occurrences;
- acceptance requirements;
- observer source closure;
- correct implementation source/package closure;
- every independent probe definition;
- every supported execution profile.

Each entry is identified by lower-case SHA-256 plus its stable role or ID. A
one-byte change to any protected input invalidates the campaign revision before
the correct implementation or a mutant is constructed. Package/product versions
do not substitute for content identity. Changing a protected input creates a new
campaign revision and leaves prior E1 evidence attached to the old revision.

`denominator` is the exact number of unique mutant IDs. Mutants are ordered,
duplicate-free, and each records an admitted implementation identity, an expected
behavioral-mismatch signature, reset-plan ID, probe IDs, and every declared
execution path. Each path is exactly one of:

- `required`: the campaign is incomplete unless this mutant runs on the path;
- `optional`: execution may be omitted, and omission is reported, not passed;
- `unsupported`: execution is forbidden and a source-backed reason is required.

Missing paths or missing denominator/scope are invalid. Absence from a runner's
matrix is never success.

## Current 17/17 baseline

All 17 mutants are required locally. Persistent transfer and Lease service require
all four mutants through Gate. WorkQueue now requires all nine through Gate. Its
local and Gate services both import the same domain-only constructors from
`examples/work-queue/validation-faults.mjs` and the same independently reading
observer/probe from `queue-fixture.mjs`. The prior 17/11 revision remains
historical and cannot be used for the revised campaign identity.

| Application / mutant | Expected zero-based mismatch | Local | Gate |
| --- | --- | --- | --- |
| WorkQueue `duplicate-accepts` | `(0,2,enqueue)` | required | required |
| WorkQueue `enqueue-drops` | `(0,1,enqueue)` | required | required |
| WorkQueue `enqueue-in-flight` | `(0,5,enqueue)` | required | required |
| WorkQueue `start-stale` | `(0,4,start)` | required | required |
| WorkQueue `fail-does-not-mark` | `(0,6,fail)` | required | required |
| WorkQueue `retry-does-not-clear` | `(0,7,retry)` | required | required |
| WorkQueue `complete-keeps-in-flight` | `(0,8,complete)` | required | required |
| WorkQueue `complete-stale` | `(0,8,complete)` | required | required |
| WorkQueue `reset-leaves-state` | `(1,0,init)` | required | required |
| Persistent transfer `premature-success` | `(0,3,commit)` | required | required |
| Persistent transfer `duplicate-retry` | `(0,7,chunk)` | required | required |
| Persistent transfer `stale-session` | `(0,13,chunk)` | required | required |
| Persistent transfer `corrupt-content` | `(0,2,chunk)` | required | required |
| Lease service `overlapping-ownership` | `(0,2,acquire)` | required | required |
| Lease service `expired-token` | `(0,5,write)` | required | required |
| Lease service `stale-release` | `(0,7,release)` | required | required |
| Lease service `invalid-renewal` | `(0,8,renew)` | required | required |

The additive `mutationCampaign` declarations in each `application.json` carry
the same complete matrix. Existing `faults` and `localFaults` remain compatibility
inputs until F2 migrates the runners; they are not a second denominator.

## Result semantics

Every attempted mutant has exactly one result and independent cleanup:

| Result | Meaning |
| --- | --- |
| `killed_by_behavioral_mismatch` | Ordinary suite replay produced the exact declared behavioral-mismatch signature. |
| `survived` | Replay and acceptance passed without that mismatch. |
| `invalid_mutant` | The declared implementation cannot be admitted or does not implement the fixed interface. |
| `infrastructure_failure` | Tool, transport, worker, persistence, or execution-path infrastructure failed. |
| `inconclusive` | Replay cannot support a kill/survival claim, including timeout, cancellation, observer/codec error, unmet evidence, or cleanup uncertainty. |

A crash, timeout, unavailable backend, observer/codec error, cancellation, or
failed cleanup is never a kill. `cleanup` records required local and/or physical
scope independently as `succeeded`, `failed`, `unconfirmed`, or
`not_applicable`. A behavioral mismatch is accepted as a kill only when every
required cleanup scope is succeeded or explicitly not applicable. Persistence
failure may fail evidence handling but cannot rewrite the underlying behavior.

The correct baseline always runs first. Any baseline failure, identity drift, or
probe-definition drift stops mutant interpretation. F2 must enforce bounded
mutant count, sequential default execution, total/per-run deadlines,
cancellation, fresh reset/factory scopes, and independent cleanup.

## Independent probes and observer limits

Campaigns identity-protect the observer and probes separately. The initial probe
roles are persisted queue JSON, transfer payload/journal consistency, and lease
ownership/token/accepted-write facts. F1 records their identities; F3 supplies
the negative-control implementations and executable probe checks. Passing replay
alone does not prove observer honesty.

## Fixtures

The accepted fixture records the full 17-mutant denominator with all 17 rows
required through both local and Gate paths. Rejected fixtures exercise duplicate IDs, unknown expected actions, missing
denominator/path scope, mutable protected inputs, and contradictory result forms.
Schema-only fixtures use fixed illustrative digests; executable validation must
recompute digests from owned bytes before any campaign run.

## Runtime campaign and fidelity controls

`decodeMutationCampaign` and `validateMutationCampaign` implement the closed F1
contract. Every mutant probe resolves to `protected.probes`; unknown expected
actions are checked against the evaluator-supplied action universe.
`runMutationCampaign` is Gate-free and uses one bounded evaluator callback for
ordinary local or Gate suite execution. It checks protected identities before
the baseline and again before every case, with a bounded, cancellable observation
callback. Runs are sequential with per-run, total, and cleanup-settlement
budgets; loss of cleanup independence stops later cases.

Execution completion and acceptance are separate. `status: complete` means all
supported rows ran. `acceptance.status: met` requires every required row to be an
exact behavioral kill. Required survivors make acceptance `unmet`; invalid,
infrastructure, probe, cleanup, timeout, cancellation, or drift outcomes make it
`incomplete`. Gate acceptance requires a unique, required, confirmed
`gate-physical` scope; local cleanup cannot substitute for physical evidence.

The application-validation runner uses the helper for the correct baseline and
all 17 local mutants while preserving the existing crash/hang/cancel controls.
Before disposal it captures bounded facts outside the observer path: persisted
queue JSON, transfer journal and payload, or lease ownership/token/write fields.
Executable observer-throw, invalid-observer, and shadow-observer controls show
that implementation/codec classification, reported-state replay, and independent
real-state facts remain separate.
