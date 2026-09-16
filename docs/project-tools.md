# Project tools

The evaluator owns the model, reviewed interface contract, corpus, acceptance
requirements and toolchain selection. `mirrorecma/project` reads this declarative
configuration without importing an application adapter. MirrorECMA remains
independent of Gate; Gate consumes its own approved environment and submission
references through `mirrorgate-mirrorecma`.

| Command | Work performed |
| --- | --- |
| `mirrorecma init DIRECTORY` | Create three inert setup files with exclusive creation; preserve existing files. No model, sealed contract, corpus or observer is invented. |
| `mirrorecma doctor --project FILE` | Read configuration, pinned installed identities, bundle hashes and corpus preflight. No adapter import, tool execution, build hook, download or policy change. |
| `mirrorecma generate --project FILE` | Resolve an already reviewed v1 contract, emit its suite bundle and check it. Compiler proposals are not automatically approved. |
| `mirrorecma check --project FILE` | Run compiler freshness/preflight checks and verify the owned bundle and corpus. Never repair or regenerate files. |
| `mirrorecma replay --project FILE` | Check the prepared artifacts, load the trusted generated model, negotiate, then import and construct the implementation. Join its registered disposer. |

Compile the generated TypeScript companion and install dependencies during
explicit application preparation. Replay performs no package installation,
compilation, corpus generation or source-checkout search. The CLI currently
requires a pinned compiler for freshness checks and a pinned local server for
local replay; direct `loadProject` plus `runSuite` callers can use the generic
runner's independent preflight without requiring compiler installation.

The project file is closed-schema JSON. Relative local paths resolve against the
project file, not the working directory. The following is the same schema emitted
by `init`; replace the visible model, contract, trace and module selections:

```json
{
  "schema": "mirrorecma.project/v1",
  "suiteId": "example/v1",
  "model": {
    "source": "model/Example.tla",
    "contract": "model/Example.mirror-interface.json",
    "evidence": "traces/witness.itf.json",
    "lock": ".mirrors/Example.mirror-interface.lock.json",
    "target": "mirrorecma-async-v1",
    "generatedDirectory": ".mirrors/evaluator",
    "module": ".mirrors/evaluator/Example.suite.js",
    "export": "ExampleModel"
  },
  "implementation": { "module": "./adapter.mjs", "export": "createAdapter" },
  "replay": {
    "kind": "corpus",
    "config": {
      "specPath": "model/Example.tla",
      "initPredicate": "Init",
      "nextPredicate": "Next",
      "invariant": "Safety",
      "lengthBound": 20,
      "paramVars": "parameters"
    },
    "traces": ["traces/witness.itf.json"]
  },
  "acceptance": { "requiredActions": [], "requiredPairs": [] },
  "execution": {
    "mirror": { "kind": "local" },
    "timeouts": {
      "registrationMs": 60000,
      "actionMs": 10000,
      "receiveMs": 60000,
      "cleanupMs": 10000
    }
  },
  "toolchainLock": "mirror.toolchain.json"
}
```

Pin tools installed by the operator. Paths in the toolchain lock resolve against
that lock; paths in an explicitly selected installed registry resolve against
the registry. `--compiler FILE` and `--server FILE` select explicit paths but
retain the selected lock's identity and capability constraints. An incompatible
override fails; it never falls through to the lock, registry, `PATH` or sibling
repositories. `--tool-registry FILE` selects a registry using the same schema.

The hashes below are syntactic placeholders: replace them with actual SHA-256
values during preparation. Package pins are optional and read installed package
manifests without importing packages or running lifecycle scripts.

```json
{
  "schema": "mirrorecma.toolchain/v1",
  "tools": {
    "compiler": {
      "path": "tools/model_interface_gen",
      "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
      "version": "model-interface-gen/1",
      "capabilities": ["bundle-v1", "check-bundle-v1", "preflight-v1"]
    },
    "server": {
      "path": "tools/mirror",
      "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
      "version": "operator-reviewed-server",
      "capabilities": ["model-interface-v1", "checked-replay-v1"]
    }
  },
  "packages": {
    "mirrorecma": {
      "packageJson": "node_modules/mirrorecma/package.json",
      "packageJsonSha256": "0000000000000000000000000000000000000000000000000000000000000000",
      "version": "2.0.0"
    }
  }
}
```

Optional executable roles `apalache`, `java` and `gateRuntime` are distinct from
the compiler and model server. Optional package roles `mirrorgate` and
`mirrorgate-mirrorecma` are distinct from `mirrorecma`. Every declared package pin
must match the installed manifest's name, version and bytes. Such a pin identifies
package metadata; it does not authenticate the package's executable payload or
transitive dependencies. Operator installation controls still own that trust.
Checked local replay needs no Apalache/JDK. Ordinary loading checks only requested
executable roles; doctor also reports optional pinned tools that are unavailable.

Doctor distinguishes executable identity from capability metadata. It checks
executable SHA-256 and execute permission, but version/capability labels remain
operator assertions in the lock. It reports capability probing, Gate namespace
admission and hosted-agent audit freshness as `not_checked`. Select the Gate
backend probe separately to exercise isolation and cleanup. A green static hash
check is not a live backend or server compatibility claim.

For remote replay, select `execution.mirror.kind` as `tcp` or `tls` with explicit
host, port, approved `serverIdentity` and capability labels. TLS also names local
CA/certificate/key paths and optional certificate pin. Each trace becomes
`{path, sha256, serverPath}`: the local bytes are preflighted, while `serverPath`
is transmitted unchanged. The configured `specPath` remains server-visible;
`replay.modelSource` defaults to the project's local `model.source` for provenance
verification. Nothing uploads files, infers server filesystem layout, or invents
a local server binary identity. Model negotiation still occurs at run time.

`model.moduleSha256` can pin the explicitly prepared executable model module.
Replay checks this before importing it and records its observed hash separately
from the semantic interface, source and corpus identities. This is trusted
evaluator code; the optional entry-module pin does not attest its entire import
closure. The submitted implementation is imported only inside the matched
factory. `adapter.dispose` is registered once for validation failures and normal
cleanup; neither the loader nor doctor imports it.

CLI exit codes are 0 for success, 1 for model mismatch with successful cleanup,
and 2 for other non-success. Structured command failures distinguish
configuration/tool selection from generation, checks and replay; timeout and
cancellation retain their own outcomes. Compiler subprocesses are bounded by
time and output limits and joined after interruption. Existing low-level runner
and command exit semantics remain unchanged.

Run `pnpm run check:installed-suite` for the installed local acceptance gate. It
prepares once, relocates the application, hides source checkouts, disables
networking and exercises the public project/CLI APIs repeatedly. Gate's separate
`npm run test:suite` covers installed restricted worker execution.
