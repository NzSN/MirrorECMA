# Controlled-clock lease reference application

`service.mjs` models a resource shared by two explicit clients with fencing
epochs and a manually advanced clock. The observer snapshots the live service
fields. The [public contract](PUBLIC-CONTRACT.md) defines acquire, renew, release,
write, clock advancement and initialization, including rejected operations.

The witness has 10 transitions: acquire, denied competing acquisition, valid
renewal, expiry, denied expired write, ownership transfer, stale release,
invalid renewal, valid write and release. It uses client IDs 1/2, epochs 1/2
and a three-unit lease. Four variants permit overlapping ownership, accept an
expired token, accept stale release, or renew without ownership.

No suitable lease model was found in the existing MirrorExamples specs/history.
The new bounded model keeps a general `Next` relation separately from its
deterministic witness. Its `Safety` predicate checks singleton ownership; replay
also checks all other declared observations. Expired owners remain recorded;
every protected operation checks the controlled clock as well as the epoch.

Run `node examples/application-validation/run.mjs lease-service` from the
MirrorECMA root after the [shared build steps](../application-validation/README.md).
Use `--live` and `--receipt NEW_FILE` as described there. These schedules exercise
logical competing clients through serialized operations, not simultaneous
threads, distributed clocks or arbitrary-interleaving linearizability.

The application [`suite.ts`](suite.ts) imports the compiler's trusted model handle
and declares replay/coverage once for local `runSuite` and Gate `evaluateSuite`.
The native adapter stays in `service.mjs`; it performs real operations and reads
real state. Generated bindings own representation conversion, while suite
results retain acknowledged evidence and independent cleanup outcomes.
