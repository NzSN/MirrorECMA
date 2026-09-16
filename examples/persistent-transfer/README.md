# Persistent transfer reference application

`service.mjs` implements a two-byte resumable transfer over an actual payload
file and session journal. The observer rereads those files. Restart replaces
the service object and reopens the files; no expected-state cache is used.

The [public contract](PUBLIC-CONTRACT.md) defines initialization, begin, chunk
retry, pause/resume, explicit restart, commit and cancellation. The model's
witness uses two session generations, byte values 11 and 22, offsets 0 and 1,
and 15 transitions. It exercises early commit rejection, retry idempotence,
restart before/after commit, cancellation and old-token rejection.

Four implementation variants corrupt payload content, accept commit early,
append duplicate retries, or accept stale session tokens. The same observer
and compiler-generated binding must reject each at its first designated mismatch.

Reuse audit: `MirrorExamples/specs` and its history contained Counter and RBT;
`dump-ledger/specs/DumpLedgerTransfer.tla` at `c6e1176159d55ff51ec706d72b64cfaea0f04aa0`
models application-specific bundle import/export, quarantine, grants and
tombstones, with abstract bytes. It is not the two-byte resumable-upload contract.
The new standalone model is an additional example, not a substitute for or
validation claim about DumpLedger's larger model/application.

Run `node examples/application-validation/run.mjs persistent-transfer` from the
MirrorECMA root after the [shared build steps](../application-validation/README.md).
Use `--live` to generate fresh deterministic model evidence and `--receipt NEW_FILE`
to preserve private results. Filesystem durability during an interrupted write,
concurrent writers and arbitrary payload sizes are outside this example.
