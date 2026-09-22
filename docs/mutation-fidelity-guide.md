# Mutation fidelity and reproduction guidance

This guide applies `mirrorecma.mutation-campaign/v1` and private reproduction
bundles to application suites. It describes required evidence; it does not turn
checkout results into release, hosted-CI, publication, or platform support.

## Author checklist

1. Name the complete mutant denominator. Record each domain fault, admitted
   implementation, exact expected mismatch, and every execution path as
   `required`, `optional`, or `unsupported` with a source-backed reason.
2. Freeze the suite, model closure, generated interface module, ordered corpus,
   acceptance, observer closure, correct implementation, probe executable
   closure, runtime profile, and C2 catalog A selection. Changed bytes create a
   new campaign revision.
3. Give every baseline, mutant, stability attempt and reducer candidate a fresh
   implementation/reset scope with independent cleanup.
4. Use one actual-SUT observer for correct and faulty variants. Add a bounded
   independent probe that reads real application facts without model expected
   states.
5. Run the correct baseline first and recheck protected identities before every
   case. Stop on drift, cancellation, budget expiry, or lost cleanup independence.
6. Count only the exact declared mismatch as a kill. Crash, timeout,
   observer/codec error, invalid mutant, unavailable backend, persistence error,
   or cleanup failure is not a kill.
7. Require confirmed cooperative cleanup locally. Gate additionally requires a
   unique, required, confirmed `gate-physical` receipt with no resources left.
8. Capture a private R bundle only when an E1 command and catalog A were selected
   before execution. Never manufacture a run reference after the fact.
9. Reduce only stable resettable cases. Validate domain input candidates against
   the pinned model/interface before SUT construction. Never claim a global
   minimum.

## Campaign declaration template

```json
{
  "schema": "mirrorecma.mutation-campaign/v1",
  "id": "application.fixed-baseline/v1",
  "revision": 1,
  "evidenceLinks": {
    "catalogSelectionRef": {
      "schemaVersion": "mirrors.framework-catalog/v1",
      "selectionKind": "sha256",
      "selectionValue": "64-lowercase-hex"
    }
  },
  "denominator": 1,
  "protected": {
    "suite": {"id": "suite/v1", "sha256": "..."},
    "model": {"id": "model/v1", "sha256": "..."},
    "generatedInterface": {"id": "interface/v1", "sha256": "..."},
    "corpus": {"id": "corpus/v1", "sha256": "..."},
    "acceptance": {"id": "acceptance/v1", "sha256": "..."},
    "observer": {"id": "observer/v1", "sha256": "..."},
    "correctImplementation": {"id": "implementation/correct", "sha256": "..."},
    "probes": [{"id": "application-facts/v1", "sha256": "..."}],
    "executionProfiles": [{"id": "local-suite/v1", "sha256": "..."}]
  },
  "mutants": [{
    "id": "named-fault",
    "implementation": {"id": "implementation/named-fault", "sha256": "..."},
    "expected": {
      "kind": "behavioral_mismatch",
      "code": "replay_mismatch",
      "traceIndex": 0,
      "stateIndex": 1,
      "action": "wire-action"
    },
    "resetPlanId": "application.fresh-factory/v1",
    "probeIds": ["application-facts/v1"],
    "paths": {
      "local": {"support": "required"},
      "gate": {"support": "unsupported", "reason": "source-backed reason"}
    }
  }]
}
```

Replace placeholders with observed bytes. Retain the campaign result, trusted
per-case receipt, probe result and cleanup evidence. Execution `status: complete`
and `acceptance.status: met` are separate requirements.

## Current application accounting

| Application | Local denominator | Gate declaration | Probe | Current evidence state |
| --- | ---: | --- | --- | --- |
| WorkQueue | 9 required | 3 required; 6 explicitly unsupported because the frozen Gate source contains only those constructors | persisted queue JSON checked against every reported observation | Current local 9/9 passed with cleanup/probes, but lacks a pre-run E1 selection; earlier summaries remain in [`results/2026-09-16-suite-migration.json`](../examples/application-validation/results/2026-09-16-suite-migration.json). |
| Persistent transfer | 4 required | 4 required | payload bytes and session journal checked against every reported observation | Current local 4/4 passed with cleanup/probes but is not a finalized E1 run; earlier summary is linked above. |
| Lease service | 4 required | 4 required | ownership, epoch, expiry, time, acceptance and writes checked against every reported observation | Current local 4/4 passed. A real Gate run covered correct, 4/4 mutants, crash, hang and cancellation with fixed-fixture fidelity and physical cleanup, but command registration/catalog A did not precede it; it is historical-unqualified and cannot supply R-bundle run references. |

Local negative controls account for observer exception (implementation failure),
invalid observation (codec failure), and a shadow observer. The shadow can make
reported-state replay pass, while the independent probe detects disagreement and
makes campaign acceptance incomplete. The fixed Gate Lease fixture enforces the
same observer/probe agreement inside frozen submitted bytes; this applies only to
that protected closure and is not universal observer honesty.

## Claim boundaries

- Killed mutants strengthen confidence only in the fixed campaign. Survivors
  expose a detection gap.
- Sandbox isolation and physical cleanup do not prove observer honesty.
- Finite traces do not prove exhaustive conformance or general correctness.
- A shortest reproducing prefix in a fixed deterministic trace is not a global
  minimum. Input search remains strategy- and budget-dependent.
- Local results do not establish Gate, installed-consumer, hosted-CI or published
  support. Each state needs its own C2/E1 evidence.
- Model, observer, corpus, acceptance, probe, runtime, catalog, implementation or
  tool changes invalidate results for the new selection. Preserve old evidence
  under its old revision; never relabel it.

The next qualifying F4 run must start through a registered E2 command with
catalog A, retain Gate receipts and reproduction bundles as typed E1 artifacts,
finalize the envelope/index, and only then use catalog B/E4 approval. Until then,
durable F4 qualification and R-bundle persistence remain incomplete.
