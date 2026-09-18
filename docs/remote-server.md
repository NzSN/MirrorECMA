# Connecting to a remote Mirrors server

For server installation, certificates, Windows service operation and the standalone
validation CLI, read the [Mirrors remote server guide](../../Mirrors/Docs/remote-server-guide.md).
For application integration across the framework, start with the
[application guide](../../Mirrors/Docs/application-integration-guide.md).

## Application suites

Keep `defineSuite` and your deferred implementation factory unchanged when moving
the model server to another machine. `runSuite` accepts a `mirror` transport or
transport factory, including `connectTlsMirror`; prefer a fresh transport factory
for repeat runs. Follow [application suites](application-suites.md) for the full
suite definition and [project tools](project-tools.md) for installed CLI use.

Project configuration uses `execution.mirror.kind: "tls"`, explicit endpoint and
server identity/capabilities, and local TLS credential paths. The local reviewed
model and traces are preflighted, but the server needs its own prepared files:
`replay.config.specPath` is server-visible, and each trace's `serverPath` is sent
unchanged. No project command automatically uploads private model/corpus files.
TLS authentication and model-interface admission are separate: configure the
server's client-certificate fingerprint allowlist for negotiated suite replay.

## Concurrent server jobs

Use `Connection` when the operation is model validation or trace generation rather
than application replay. This example submits two jobs before awaiting either;
request/reply exchanges are serialized per connection while backend jobs overlap.

```ts
import { Connection, connectTlsMirror, specFromFiles } from "mirrorecma";

const spec = await specFromFiles("./Main.tla", ["./modules"]);
const connection = await Connection.open(await connectTlsMirror("mirror.example.com", 8999, {
  caPath: "./pki/ca.crt",
  certPath: "./pki/client.crt",
  keyPath: "./pki/client.key",
}));
try {
  const config = {
    specPath: "Main.tla", initPredicate: "Init", nextPredicate: "Next",
    invariant: "Safe", lengthBound: 3, paramVars: "",
  };
  const jobs = [
    await connection.submitValidateAsync(config, 3, { spec }),
    await connection.submitValidateAsync(config, 5, { spec }),
  ];
  for (const job of jobs) {
    for (;;) {
      const reply = await job.await(30);
      if (reply.done) {
        console.log(reply.result); // inspect outcome: valid, invalid, or error
        break;
      }
      if (reply.status.phase === "cancelled") throw new Error("Job cancelled");
    }
  }
} finally {
  await connection.close();
}
```

`specFromFiles` recursively resolves `EXTENDS`/`INSTANCE` into inline sources,
with the root first. Its search-directory and standard-module rules belong to
[the resolver](../src/spec.ts); they are not the same API as the Mirrors CLI's
`--dep FILE`. The encoded JSONL message is limited to 65,535 bytes. Omitting
`spec` uses server-side `specPath`; it never sends the local file automatically.

`JobHandle.cancel()` requests cancellation; completion still requires physical
backend cleanup. Keep the submitting connection alive until jobs are finished.
Other connections can query/await a live job, but closing its owner cancels and
evicts it. Handles are not durable across reconnects. A full server reports
`JobQueueFullError`; allow cleanup to finish before retrying. Stdio does not
support async jobs. See [Connection](../src/connection.ts) for typed outcomes,
unknown-job errors, trace generation and cancellation.

## What async and cleanup mean here

Async SUT actions (`mirrorecma-async-v1`) and server jobs are separate contracts.
An application suite can await its own operations without submitting server jobs.
Gate worker cancellation is another ownership layer. Read
[replay cancellation](replay-and-async.md) for implementation disposal and
[Gate remote integration](../../MirrorGate/docs/remote-mirrors.md) for isolation.

The server's [Lean safety proofs](../../Mirrors/Docs/async-resource-lean-proofs.md)
and [concurrent mTLS E2E](../../Mirrors/Docs/async-server-resource-e2e.md) describe
resource-accounting guarantees and measured cleanup. These do not prove that an
application adapter, Node heap, JVM, or Gate worker has no memory leaks.
