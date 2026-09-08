# Sandboxed generated Counter

This example drives a submitted Counter adapter through the experimental
MirrorGate control-v1 facade. The trusted process keeps the model contract,
trace path, expected states, and replay configuration outside the worker. The
generated `bindCounterAsyncPublicPort` adapter projects only stable public port
IDs and native values onto the managed worker connection.

Build it with:

```bash
pnpm run check:sandbox
pnpm run build:sandbox
```

Run the emitted example with an explicit prepared policy and submission:

```bash
MIRRORGATE_BIN=/opt/mirrorgate/bin/mirrorgate \
MIRRORGATE_POLICY_FILE=/etc/mirrorgate/control-policy.json \
MIRRORGATE_POLICY_ID=counter \
MIRRORGATE_INPUT_ROOT_ID=submission \
MIRRORGATE_SUBMISSION_PATH=counter-node \
MIRRORGATE_WORKER_RUNTIME=node-v1 \
MIRROR_BIN=/opt/mirrors/bin/mirror \
MIRROR_SPEC_PATH=/private/models/Counter.tla \
MIRROR_INVARIANT=TraceComplete \
MIRROR_CONST_INIT=CInit \
MIRROR_TRACE_PATH=/private/traces/counter.itf.json \
node dist-sandbox/examples/sandbox-counter/run.js
```

The paths and catalog IDs must exist in the operator policy. The facade performs
no download and has no raw-process fallback. The `mirrorgate` package is an
optional peer for ordinary MirrorECMA consumers and becomes required only when
`evaluateSandboxed` is called.

This remains an experimental profile until the evidence ledger linked from the
repository README records the full required backend and cross-language matrix.
